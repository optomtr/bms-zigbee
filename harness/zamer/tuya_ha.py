"""Сторона Tuya: хаб Tuya через Home Assistant и BMS Integration.

ЛОВУШКА. Состояние сущности в HA подтверждением НЕ является:
- entity.py:546 -> coordinator.py:1010-1034 (apply_optimistic_status) кладёт
  ожидаемое значение и в self._status, и в кэш протокола, и сразу рассылает
  его сущностям - HA показывает новое состояние до любого ответа;
- событие bms_integration_status_update тоже не годится: оно сравнивает
  self._status с кэшем (coordinator.py:1529-1540), а там уже лежит наше
  ожидаемое значение - подтверждение устройства проходит молча.

Чем пользуемся:
- dp_event (работает на текущей main): bms_integration_device_dp_triggered
  (coordinator.py:1525-1528) стреляет из status_updated, то есть по реальной
  посылке со шлюза, а оптимистичный путь его не вызывает. Недостатки: только
  для посылок с ровно одной точкой данных, и он же стреляет на ответ опроса
  кэша хаба (verify через 5+6 с после таймаута шлюза, coordinator.py:938-955;
  dispatched_dps ставится для ЛЮБОЙ расшифрованной посылки,
  pytuya/__init__.py:1288-1289). Отсюда окно сомнения (config.py).
- push_event: событие bms_integration_push на каждый push со шлюза - его даёт
  правка из README (patches/bms_integration_push_event.diff).
"""
from __future__ import annotations

import asyncio
import re
import time
from collections import defaultdict

from .common import NO_LINK, SUSPECT, TIMEOUT, CommandResult, Pending, Side

EVENT_DP = "bms_integration_device_dp_triggered"
EVENT_STATUS = "bms_integration_status_update"
EVENT_PUSH = "bms_integration_push"

# unique_id сущности BMS Integration: local_<id устройства>_<dp> (entity.py:320).
UNIQUE_ID_RE = re.compile(r"^local_(?P<device>.+)_(?P<dp>\d+)$")

# Одна посылка в режиме dp_event даёт до двух событий (dp_triggered и
# status_update) подряд из одного вызова (coordinator.py:1525-1540) - считаем
# их одним отчётом. Окно короткое: отдельные посылки датчика так часто не идут.
REPORT_DEDUP_S = 0.05


def parse_unique_id(unique_id: str | None) -> tuple[str, str] | None:
    m = UNIQUE_ID_RE.match(unique_id or "")
    return (m["device"], m["dp"]) if m else None


class TuyaHASide(Side):
    name = "tuya"

    def __init__(self, cfg, transport) -> None:
        super().__init__()
        self.mode = cfg.ha.confirm
        self.timeout = cfg.command_timeout_s
        self.transport = transport
        self.by_entity = {}
        self.by_device: dict[str, list] = defaultdict(list)
        self.pending: dict[str, Pending] = {}
        self.ha_state: dict[str, str] = {}
        self.suspect_until: dict[str, float] = {}
        # Окно сомнения после таймаута и после «недоступно» (см. config.py).
        self.suspect_window_s = cfg.ha.suspect_window_s
        self._last_report: dict[str, float] = {}
        self._calls: set[asyncio.Task] = set()

    def device_value(self, pair, on: bool):
        return pair.tuya_values[pair.index(on)]

    def hold_s(self, pair) -> float:
        loop = asyncio.get_running_loop()
        return max(0.0, self.suspect_until.get(pair.name, 0.0) - loop.time())

    async def start(self, pairs) -> None:
        await self.transport.connect(self.handle_event)
        for pair in pairs:
            if not pair.tuya_device_id or (pair.type == "actuator" and not pair.tuya_dp):
                await self._resolve(pair)
            self.by_entity[pair.tuya_entity] = pair
            self.by_device[pair.tuya_device_id].append(pair)
        events = ["state_changed"] + ([EVENT_DP, EVENT_STATUS] if self.mode == "dp_event" else [EVENT_PUSH])
        for event_type in events:
            await self.transport.subscribe(event_type)
        res = await self.transport.request({"type": "get_states"})
        for st in res.get("result") or []:
            pair = self.by_entity.get(st.get("entity_id"))
            if pair is None:
                continue
            self.ha_state[pair.tuya_entity] = st.get("state")
            # До первого push не знаем, что сообщало устройство; показ HA -
            # лучшее, что есть, чтобы первая команда меняла состояние.
            if pair.type == "actuator" and st.get("state") in pair.ha_states:
                on = pair.ha_states.index(st.get("state")) == 0
                self.last_value.setdefault(pair.name, self.device_value(pair, on))

    async def _resolve(self, pair) -> None:
        res = await self.transport.request({"type": "config/entity_registry/get", "entity_id": pair.tuya_entity})
        entry = res.get("result") or {}
        parsed = parse_unique_id(entry.get("unique_id"))
        if not res.get("success") or parsed is None:
            raise ValueError(
                f"{pair.name}: не нашёл устройство Tuya для {pair.tuya_entity} "
                f"(unique_id={entry.get('unique_id')!r}); укажите tuya.device_id и tuya.dp в конфиге"
            )
        pair.tuya_device_id = pair.tuya_device_id or parsed[0]
        pair.tuya_dp = pair.tuya_dp or parsed[1]

    async def close(self) -> None:
        await self.transport.close()

    def handle_event(self, event: dict) -> None:
        now = asyncio.get_running_loop().time()
        wall = time.time()
        event_type = event.get("event_type")
        data = event.get("data") or {}
        if event_type == "state_changed":
            self._on_state(data, now, wall)
        elif event_type == EVENT_PUSH and self.mode == "push_event":
            self._on_push(data.get("device_id"), data.get("dps") or {}, now, wall)
        elif event_type == EVENT_DP and self.mode == "dp_event":
            self._on_push(data.get("device_id"), {str(data.get("dp")): data.get("value")}, now, wall)
        elif event_type == EVENT_STATUS and self.mode == "dp_event":
            # Только как отчёт: подтверждать по нему нельзя (см. шапку модуля).
            for pair in self.by_device.get(data.get("device_id"), []):
                self._count_report(pair, wall)

    def _count_report(self, pair, wall: float) -> None:
        last = self._last_report.get(pair.name)
        if last is None or wall - last >= REPORT_DEDUP_S:
            self._last_report[pair.name] = wall
            self._report(pair.name, wall)

    def _on_push(self, device_id, dps: dict, now: float, wall: float) -> None:
        for pair in self.by_device.get(device_id, []):
            self._count_report(pair, wall)
            if pair.type != "actuator" or pair.tuya_dp not in dps:
                continue
            value = dps[pair.tuya_dp]
            self.last_value[pair.name] = value
            pend = self.pending.get(pair.name)
            if pend is None or value != pend.expected:
                continue
            if now < self.suspect_until.get(pair.name, 0.0):
                pend.confirm(now, SUSPECT, "могло прийти из кэша хаба: рядом таймаут или переподключение")
            else:
                pend.confirm(now)

    def _on_state(self, data: dict, now: float, wall: float) -> None:
        pair = self.by_entity.get(data.get("entity_id"))
        if pair is None:
            return
        new = (data.get("new_state") or {}).get("state")
        old = (data.get("old_state") or {}).get("state")
        self.ha_state[pair.tuya_entity] = new
        if new == "unavailable" and old != "unavailable":
            self._availability(pair.name, wall, False)
        elif old == "unavailable" and new not in (None, "unavailable"):
            self._availability(pair.name, wall, True)
            # После переподключения интеграция опрашивает хаб (coordinator.py:585),
            # и dp_triggered может прийти с кэшем хаба.
            self.suspect_until[pair.name] = now + self.suspect_window_s
        pend = self.pending.get(pair.name)
        if pend is None:
            return
        if new == "unavailable":
            pend.fail("сущность стала недоступна")
        elif pend.ha_expected is not None and new == pend.ha_expected and pend.optimistic_ms is None:
            # Показ сменился - это оптимистичная запись интеграции, НЕ ответ
            # устройства. Запоминаем только для справки.
            pend.optimistic_ms = (now - pend.t0) * 1000
        elif pend.optimistic_ms is not None and new == pend.ha_before and new != pend.ha_expected:
            # restore_optimistic_status (entity.py:527): отказ, обрыв, закрытая
            # сессия - интеграция сама признала, что команда не прошла.
            pend.fail("интеграция откатила показ: команда не дошла")

    async def turn(self, pair, on: bool) -> CommandResult:
        loop = asyncio.get_running_loop()
        pend = Pending(self.device_value(pair, on), loop.time())
        pend.ha_before = self.ha_state.get(pair.tuya_entity)
        pend.ha_expected = pair.ha_states[pair.index(on)]
        self.pending[pair.name] = pend
        domain = pair.tuya_entity.split(".", 1)[0]
        call = asyncio.create_task(self._call(pend, domain, pair.ha_services[pair.index(on)], pair.tuya_entity))
        # Ссылку держим, чтобы задачу не съел сборщик мусора, если ответ HA
        # придёт уже после нашего таймаута.
        self._calls.add(call)
        call.add_done_callback(self._calls.discard)
        try:
            result = await pend.wait(self.timeout)
        finally:
            if self.pending.get(pair.name) is pend:
                del self.pending[pair.name]
        if result.status == TIMEOUT:
            self.suspect_until[pair.name] = loop.time() + self.suspect_window_s
        return result

    async def _call(self, pend: Pending, domain: str, service: str, entity_id: str) -> None:
        try:
            ok, err = await self.transport.call_service(domain, service, entity_id)
        except ConnectionError as ex:
            pend.resolve(CommandResult(NO_LINK, detail=f"HA: {ex}"))
            return
        # Успех вызова ничего не доказывает: при оптимистичном пути служба
        # возвращается сразу (entity.py:546-550), без оптимизма - по «принято»
        # от шлюза (entity.py:534-535), а это ещё не «устройство выполнило»
        # (entity.py:590-591).
        if not ok:
            pend.fail(f"HA отказал: {err}")
