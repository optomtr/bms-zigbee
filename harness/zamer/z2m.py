"""Наша сторона: Zigbee2MQTT через MQTT.

Подтверждение = публикация состояния устройства с новым значением. Это верно
ТОЛЬКО при optimistic: false у устройства в Z2M. По умолчанию Z2M оптимистичен:
lib/extension/publish.ts:251-266 публикует state сразу, как только convertSet
вернулся, а для Tuya (zhc src/lib/tuya.ts:621, disableDefaultResponse: true)
convertSet возвращается, едва координатор принял кадр к отправке (herdsman
emberAdapter.ts:1961-1980 - ответа не ждём, повтор APS снят). Поэтому перед
замером проверяем настройки Z2M (optimistic_problems) и без них не работаем.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Callable

from .common import NO_LINK, CommandResult, Pending, Side

# Ошибки из lib/extension/publish.ts, после которых состояния не будет.
FAIL_PATTERNS = (
    "Publish 'set' '{key}' to '{fn}' failed",    # publish.ts:283
    "Entity '{fn}' is unknown",                   # publish.ts:102
    "Cannot publish to unsupported device '{fn}'",  # publish.ts:110
    "No converter available for '{key}' on '{fn}'",  # publish.ts:208
)


def optimistic_problems(bridge_config: dict | None, friendly_names: list[str]) -> list[str]:
    """Какие устройства Z2M публикует не по ответу устройства - замер по ним соврёт.

    Действующие опции устройства = device_options поверх которых devices[ieee]
    (lib/model/device.ts:30-33). optimistic по умолчанию true
    (lib/util/settings.schema.json:908-912).
    """
    if not bridge_config:
        return ["нет zigbee2mqtt/bridge/info - Z2M не запущен или другой base_topic"]
    base = bridge_config.get("device_options") or {}
    by_name = {}
    for ieee, opts in (bridge_config.get("devices") or {}).items():
        by_name[(opts or {}).get("friendly_name", ieee)] = opts or {}
    problems = []
    for fn in friendly_names:
        if fn not in by_name:
            problems.append(f"{fn}: нет среди устройств Z2M")
            continue
        opts = {**base, **by_name[fn]}
        if opts.get("optimistic", True) is not False:
            problems.append(
                f"{fn}: optimistic не выключен - Z2M покажет новое состояние, не дождавшись устройства "
                "(впишите device_options: {optimistic: false} в configuration.yaml Z2M)"
            )
        for key in ("debounce", "throttle"):
            if opts.get(key):
                problems.append(f"{fn}: {key}={opts[key]} придерживает публикации - задержка выйдет завышенной")
    return problems


class Z2MSide(Side):
    name = "ours"

    def __init__(self, cfg, transport) -> None:
        super().__init__()
        self.base = cfg.mqtt.base_topic
        self.timeout = cfg.command_timeout_s
        self.transport = transport
        self.by_fn = {}
        self.pending: dict[str, tuple[object, Pending]] = {}
        self.bridge_config: dict | None = None
        self._bridge_seen: asyncio.Event | None = None

    def device_value(self, pair, on: bool):
        return pair.ours_values[pair.index(on)]

    async def start(self, pairs) -> None:
        self.by_fn = {p.ours: p for p in pairs}
        self._bridge_seen = asyncio.Event()
        await self.transport.connect(self.handle_message)

    async def close(self) -> None:
        await self.transport.close()

    async def check_setup(self, wait_s: float = 5.0) -> list[str]:
        # bridge/info Z2M держит в брокере (retain), он приходит сразу после подписки.
        try:
            await asyncio.wait_for(self._bridge_seen.wait(), wait_s)
        except asyncio.TimeoutError:
            pass
        return optimistic_problems(self.bridge_config, list(self.by_fn))

    def handle_message(self, topic: str, payload: bytes, retained: bool = False) -> None:
        now = asyncio.get_running_loop().time()
        wall = time.time()
        if topic == f"{self.base}/bridge/info":
            data = _json(payload)
            if isinstance(data, dict):
                self.bridge_config = data.get("config")
                if self._bridge_seen:
                    self._bridge_seen.set()
            return
        if topic == f"{self.base}/bridge/logging":
            self._on_logging(payload)
            return
        if retained:
            # Сохранённое брокером - старое состояние, не ответ на нашу команду.
            return
        if not topic.startswith(self.base + "/"):
            return
        rest = topic[len(self.base) + 1:]
        if rest.endswith("/availability") and rest[: -len("/availability")] in self.by_fn:
            pair = self.by_fn[rest[: -len("/availability")]]
            data = _json(payload)
            state = data.get("state") if isinstance(data, dict) else payload.decode(errors="replace")
            self._availability(pair.name, wall, state == "online")
            return
        pair = self.by_fn.get(rest)
        if pair is None:
            return
        data = _json(payload)
        if not isinstance(data, dict):
            return
        # Z2M публикует на <fn> только то, что пришло от устройства (receive.ts:134-188),
        # пока optimistic выключен - значит, каждое сообщение и есть отчёт.
        self._report(pair.name, wall)
        if pair.type == "actuator" and pair.ours_key in data:
            value = data[pair.ours_key]
            entry = self.pending.get(pair.ours)
            if entry and value == entry[1].expected:
                entry[1].confirm(now)
            self.last_value[pair.name] = value

    def _on_logging(self, payload: bytes) -> None:
        data = _json(payload)
        if not isinstance(data, dict) or data.get("level") != "error":
            return
        message = str(data.get("message", ""))
        for fn, (pair, pend) in list(self.pending.items()):
            for pattern in FAIL_PATTERNS:
                if pattern.format(fn=fn, key=pair.ours_key) in message:
                    pend.fail(message)
                    break

    async def turn(self, pair, on: bool) -> CommandResult:
        loop = asyncio.get_running_loop()
        fn = pair.ours
        pend = Pending(self.device_value(pair, on), loop.time())
        if pair.name not in self.last_value:
            pend.note = "состояние до команды неизвестно"
        self.pending[fn] = (pair, pend)
        try:
            try:
                self.transport.publish(f"{self.base}/{fn}/set", json.dumps({pair.ours_key: pend.expected}))
            except Exception as ex:  # noqa: BLE001 - любая ошибка отправки = нет связи со стендом
                return CommandResult(NO_LINK, detail=f"MQTT: {ex}")
            return await pend.wait(self.timeout)
        finally:
            if self.pending.get(fn, (None, None))[1] is pend:
                del self.pending[fn]


def _json(payload: bytes):
    try:
        return json.loads(payload)
    except (ValueError, TypeError):
        return None


class PahoTransport:
    """MQTT через paho: сетевой цикл в своём потоке, сообщения - в цикл asyncio."""

    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self._client = None

    async def connect(self, handler: Callable[[str, bytes, bool], None]) -> None:
        import paho.mqtt.client as mqtt

        loop = asyncio.get_running_loop()
        connected = asyncio.Event()
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"bms-zamer-{os.getpid()}")
        if self.cfg.username:
            client.username_pw_set(self.cfg.username, self.cfg.password)

        def on_connect(c, _userdata, _flags, reason_code, _props):
            if reason_code.is_failure:
                print(f"MQTT: брокер отказал: {reason_code}", flush=True)
                return
            # Подписка заново при каждом переподключении: сессия чистая.
            c.subscribe(f"{self.cfg.base_topic}/#")
            loop.call_soon_threadsafe(connected.set)

        def on_message(_c, _userdata, msg):
            loop.call_soon_threadsafe(handler, msg.topic, msg.payload, bool(msg.retain))

        client.on_connect = on_connect
        client.on_message = on_message
        client.reconnect_delay_set(1, 30)
        client.connect_async(self.cfg.host, self.cfg.port, keepalive=30)
        client.loop_start()
        self._client = client
        try:
            await asyncio.wait_for(connected.wait(), 15)
        except asyncio.TimeoutError as ex:
            client.loop_stop()
            self._client = None
            raise ConnectionError(f"MQTT {self.cfg.host}:{self.cfg.port} не ответил за 15 с") from ex

    def publish(self, topic: str, payload: str) -> None:
        import paho.mqtt.client as mqtt

        # qos 0: без связи paho сразу вернёт ошибку, а не придержит команду
        # до переподключения - иначе задержка «доставки» была бы враньём.
        info = self._client.publish(topic, payload, qos=0)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            raise ConnectionError(mqtt.error_string(info.rc))

    async def close(self) -> None:
        if self._client is not None:
            self._client.disconnect()
            self._client.loop_stop()
            self._client = None
