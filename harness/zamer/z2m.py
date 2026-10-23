"""BMS: подтверждение только по отдельному входящему device_report.

Обычный MQTT state может быть оптимистичным или содержать кэш даже при
optimistic:false у устройства. Поэтому он никогда не подтверждает команду.
"""
from __future__ import annotations

import asyncio
from collections import Counter
import math
import json
import os
import time
import uuid
from typing import Callable

from .common import NO_LINK, CommandResult, Pending, Side

# Ошибки из lib/extension/publish.ts, после которых состояния не будет.
FAIL_PATTERNS = (
    "Publish 'set' '{key}' to '{fn}' failed",    # publish.ts:283
    "Entity '{fn}' is unknown",                   # publish.ts:102
    "Cannot publish to unsupported device '{fn}'",  # publish.ts:110
    "No converter available for '{key}' on '{fn}'",  # publish.ts:208
)


def reporting_problems(bridge_config: dict | None, capabilities: dict | None, friendly_names: list[str]) -> list[str]:
    """Без явного источника подтверждения стенд не должен подменять результат состоянием UI."""
    if not bridge_config:
        return ["нет zigbee2mqtt/bridge/info"]
    problems = []
    if bridge_config.get("advanced", {}).get("bms_device_reports") is not True:
        problems.append("нужно advanced.bms_device_reports: true и перезапуск BMS Zigbee")
    if not capabilities or capabilities.get("schema") != 1 or capabilities.get("device_reports") is not True or capabilities.get("command_correlation") is not True:
        problems.append("нет совместимого bridge/bms/capabilities: нужен BMS с device_report v1")
    names = {(opts or {}).get("friendly_name", ieee) for ieee, opts in (bridge_config.get("devices") or {}).items()}
    problems.extend(f"{fn}: нет среди устройств Z2M" for fn in friendly_names if fn not in names)
    return problems


class Z2MSide(Side):
    name = "ours"

    def __init__(self, cfg, transport) -> None:
        super().__init__()
        self.base = cfg.mqtt.base_topic
        self.timeout = cfg.command_timeout_s
        self.transport = transport
        self.by_fn = {}
        self.capabilities = None
        self.last_sequence = 0
        self.counters = Counter()
        self._cap_seen = None
        self.pending: dict[str, tuple[object, Pending]] = {}
        self.bridge_config: dict | None = None
        self._bridge_seen: asyncio.Event | None = None

    def device_value(self, pair, on: bool):
        return pair.ours_values[pair.index(on)]

    async def start(self, pairs) -> None:
        self.by_fn = {}
        for pair in pairs:
            self.by_fn.setdefault(pair.ours, []).append(pair)
        self._cap_seen = asyncio.Event()
        self._bridge_seen = asyncio.Event()
        await self.transport.connect(self.handle_message)

    async def close(self) -> None:
        await self.transport.close()

    async def check_setup(self, wait_s: float = 5.0) -> list[str]:
        # bridge/info Z2M держит в брокере (retain), он приходит сразу после подписки.
        try:
            await asyncio.wait_for(asyncio.gather(self._bridge_seen.wait(), self._cap_seen.wait()), wait_s)
        except asyncio.TimeoutError:
            pass
        return reporting_problems(self.bridge_config, self.capabilities, list(self.by_fn))

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
        if topic == f"{self.base}/bridge/bms/capabilities":
            data = _json(payload)
            if isinstance(data, dict) and data.get("schema") == 1 and isinstance(data.get("session_id"), str):
                if not self.capabilities or self.capabilities.get("session_id") != data["session_id"]:
                    self.last_sequence = 0
                self.capabilities = data
                self._cap_seen.set()
            return
        if topic == f"{self.base}/bridge/logging":
            self._on_logging(payload)
            return
        if retained:
            self.counters["retained_ignored"] += 1
            return
        if topic == f"{self.base}/bridge/bms/tx_event":
            data = _json(payload)
            if isinstance(data, dict) and data.get("schema") == 1:
                # Это вызовы API отправки; число реальных радиоповторов требует сниффера/NCP.
                kind = data.get("kind")
                if kind in ("mqtt_intent", "group_frame", "unicast_frame"):
                    self.counters[kind] += 1
                if kind == "mqtt_intent":
                    stamp = data.get("received_at")
                    if type(stamp) in (int, float) and math.isfinite(stamp):
                        for _pair, pend in self.pending.values():
                            if data.get("command_id") == pend.command_id:
                                pend.source_received_at = stamp
                                pend.report_session = (self.capabilities or {}).get("session_id")
            return
        if topic == f"{self.base}/bridge/bms/device_report":
            self._device_report(_json(payload), now, wall)
            return
        if not topic.startswith(self.base + "/"):
            return
        rest = topic[len(self.base) + 1:]
        if rest.endswith("/availability") and rest[: -len("/availability")] in self.by_fn:
            pairs = self.by_fn[rest[: -len("/availability")]]
            data = _json(payload)
            state = data.get("state") if isinstance(data, dict) else payload.decode(errors="replace")
            for pair in pairs:
                self._availability(pair.name, wall, state == "online")
        elif rest in self.by_fn:
            self.counters["state_publications_ignored"] += 1

    def _device_report(self, data, now: float, wall: float) -> None:
        self.counters["report_envelopes"] += 1
        if not isinstance(data, dict) or data.get("schema") != 1 or data.get("source") != "device":
            self.counters["invalid_reports"] += 1
            return
        seq, received = data.get("sequence"), data.get("received_at")
        if (not self.capabilities or data.get("session_id") != self.capabilities.get("session_id")
                or not isinstance(seq, int) or isinstance(seq, bool) or seq <= self.last_sequence
                or not isinstance(received, (int, float)) or isinstance(received, bool) or not math.isfinite(received)
                or not isinstance(data.get("payload"), dict) or not isinstance(data.get("raw"), dict)):
            self.counters["invalid_reports"] += 1
            return
        self.last_sequence = seq
        for pair in self.by_fn.get(data.get("friendly_name"), []):
            if pair.ours_endpoint is not None and data.get("endpoint") != pair.ours_endpoint:
                continue
            update = data["payload"]
            self._report(pair.name, wall)
            self.counters["device_reports"] += 1
            if pair.type != "actuator" or pair.ours_key not in update:
                continue
            value = update[pair.ours_key]
            # Поле converter может быть производным от meta.state. Подтверждение
            # требует сопоставленного сырого атрибута/DP в этом же входящем кадре.
            if not self._raw_matches(pair, data, value):
                self.counters["unverified_payloads"] += 1
                continue
            entry = self.pending.get(pair.name)
            if entry and value == entry[1].expected:
                pend = entry[1]
                # Времена кадра и MQTT-намерения сняты одним процессом Z2M.
                # Равная миллисекунда неоднозначна: консервативно не подтверждаем.
                if (pend.source_received_at is None or received <= pend.source_received_at
                        or pend.report_session != data.get("session_id")):
                    self.counters["stale_reports"] += 1
                    continue
                if not entry[1].future.done():
                    self.counters["confirmed_reports"] += 1
                entry[1].confirm(now, detail=f"command_id={pend.command_id}; device_report {data['session_id']}/{seq}; {data.get('cluster')}/{data.get('endpoint')}")
            self.last_value[pair.name] = value

    @staticmethod
    def _raw_matches(pair, report, value) -> bool:
        if value not in pair.ours_values:
            return False
        index = pair.ours_values.index(value)
        raw, kind, cluster = report["raw"], report.get("type"), report.get("cluster")
        if pair.ours_report_dp is not None:
            if cluster != "manuSpecificTuya" or kind not in ("commandDataReport", "commandDataResponse", "commandActiveStatusReport", "commandActiveStatusReportAlt"):
                return False
            points = raw.get("dpValues")
            if not isinstance(points, list):
                return False
            for dp in points:
                if not isinstance(dp, dict) or dp.get("dp") != pair.ours_report_dp:
                    continue
                buf = dp.get("data", {})
                values = buf.get("data") if isinstance(buf, dict) else buf
                if not isinstance(values, list) or not values or not all(type(v) is int and 0 <= v <= 255 for v in values):
                    return False
                datatype = dp.get("datatype")
                if datatype in (1, 2, 4, 5) and len(values) <= 4:
                    actual = int.from_bytes(bytes(values), "big")
                elif datatype == 3:
                    try:
                        actual = bytes(values).decode("utf-8")
                    except UnicodeDecodeError:
                        return False
                elif datatype == 0:
                    actual = bytes(values).hex()
                else:
                    return False
                return actual == pair.ours_report_values[index]
            return False
        if kind not in ("attributeReport", "readResponse"):
            return False
        if pair.ours_report_field is not None:
            return cluster == pair.ours_report_cluster and pair.ours_report_field in raw and raw[pair.ours_report_field] == pair.ours_report_values[index]
        # Дефолт только для стандартного on/off. Другим моделям нужны явные raw
        # соответствия; лучше честный timeout, чем подтверждение из чужого поля.
        return (cluster == "genOnOff" and pair.ours_values == ["ON", "OFF"]
                and type(raw.get("onOff")) in (int, bool) and raw["onOff"] in (0, 1)
                and raw["onOff"] == [1, 0][index])

    def _on_logging(self, payload: bytes) -> None:
        data = _json(payload)
        if not isinstance(data, dict) or data.get("level") != "error":
            return
        message = str(data.get("message", ""))
        for _name, (pair, pend) in list(self.pending.items()):
            fn = pair.ours
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
        if pair.name in self.pending:
            return CommandResult(NO_LINK, detail="стенд уже ждёт команду этому каналу")
        pend.command_id = uuid.uuid4().hex
        pend.source_received_at = None
        pend.report_session = None
        self.pending[pair.name] = (pair, pend)
        try:
            try:
                self.counters["mqtt_commands"] += 1
                self.transport.publish(f"{self.base}/{fn}/set", json.dumps({pair.ours_key: pend.expected, "__bms_command_id": pend.command_id}))
            except Exception as ex:  # noqa: BLE001 - любая ошибка отправки = нет связи со стендом
                return CommandResult(NO_LINK, detail=f"MQTT: {ex}")
            return await pend.wait(self.timeout)
        finally:
            if self.pending.get(pair.name, (None, None))[1] is pend:
                del self.pending[pair.name]


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
