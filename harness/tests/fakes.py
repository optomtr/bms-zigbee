"""Поддельные бэкенды: Z2M за брокером MQTT и HA с BMS Integration (ветка main).

Подделки повторяют ровно то поведение, на котором держится замер, со ссылками
на исходники, а не «идеальный мир».
"""
from __future__ import annotations

import asyncio
import json

from zamer import config as config_mod
from zamer.tuya_ha import EVENT_DP, EVENT_PUSH, EVENT_STATUS

BASE = "zigbee2mqtt"


def make_cfg(tmp_path, devices, monkeypatch, confirm="dp_event", interval=0.3, timeout=0.15):
    monkeypatch.setenv("HA_TOKEN_TEST", "test-token")
    data = {
        "db": str(tmp_path / "zamer.sqlite"),
        "mqtt": {"host": "localhost", "base_topic": BASE},
        "ha": {"url": "ws://localhost:8123/api/websocket", "token_env": "HA_TOKEN_TEST", "confirm": confirm},
        "timing": {"command_interval_s": interval, "command_timeout_s": timeout},
        "devices": devices,
    }
    return config_mod.parse(data, tmp_path)


def actuator(name, far=False, kind="switch"):
    return {"name": name, "type": "actuator", "kind": kind, "far": far,
            "tuya": {"entity_id": f"switch.{name}"}, "ours": {"friendly_name": name}}


def sensor(name, interval):
    return {"name": name, "type": "sensor", "report_interval_s": interval,
            "tuya": {"entity_id": f"sensor.{name}"}, "ours": {"friendly_name": name}}


class FakeMqtt:
    """Брокер в памяти: что публикует замерщик, видит поддельный Z2M, и наоборот."""

    def __init__(self) -> None:
        self.handler = None
        self.published: list[tuple[str, str]] = []
        self.listeners = []
        self.down = False

    async def connect(self, handler) -> None:
        self.handler = handler

    def publish(self, topic: str, payload: str) -> None:
        if self.down:
            raise ConnectionError("нет связи с брокером")
        self.published.append((topic, payload))
        for listener in self.listeners:
            listener(topic, payload)

    def deliver(self, topic: str, payload, retained: bool = False) -> None:
        if not isinstance(payload, (bytes, str)):
            payload = json.dumps(payload)
        if isinstance(payload, str):
            payload = payload.encode()
        self.handler(topic, payload, retained)

    async def close(self) -> None:
        pass


class FakeZ2M:
    """Z2M 2.14.2. При optimistic=False публикует state только по ответу «устройства»
    (receive.ts); при optimistic=True - ещё и сразу после отправки, как
    publish.ts:251-266 с настройкой по умолчанию."""

    def __init__(self, mqtt: FakeMqtt, optimistic: bool = False, delay: float = 0.02) -> None:
        self.mqtt = mqtt
        self.optimistic = optimistic
        self.delay = delay
        self.behavior: dict[str, str] = {}  # confirm | fail | silent | unrelated
        self.state: dict[str, dict] = {}
        mqtt.listeners.append(self._on_publish)

    def bridge_info(self, names, optimistic=None, device_options=None, extra=None) -> None:
        devices = {}
        for i, name in enumerate(names):
            opts = {"friendly_name": name}
            if optimistic is not None:
                opts["optimistic"] = optimistic
            opts.update((extra or {}).get(name, {}))
            devices[f"0x{i:016x}"] = opts
        self.mqtt.deliver(f"{BASE}/bridge/info", {"config": {"devices": devices, "device_options": device_options or {}}},
                          retained=True)

    def _on_publish(self, topic: str, payload: str) -> None:
        if not topic.endswith("/set"):
            return
        fn = topic[len(BASE) + 1: -len("/set")]
        cmd = json.loads(payload)
        loop = asyncio.get_running_loop()
        behavior = self.behavior.get(fn, "confirm")
        if self.optimistic:
            loop.call_soon(self.publish_state, fn, cmd)
        if behavior == "confirm":
            loop.call_later(self.delay, self.publish_state, fn, cmd)
        elif behavior == "fail":
            msg = {"level": "error", "namespace": "z2m",
                   "message": f"Publish 'set' 'state' to '{fn}' failed: 'Error: ZCL command failed (Delivery failed)'"}
            loop.call_later(self.delay, self.mqtt.deliver, f"{BASE}/bridge/logging", msg)
        elif behavior == "unrelated":
            # Посторонний отчёт (мощность): Z2M кладёт в него весь кэш, включая СТАРЫЙ state.
            loop.call_later(self.delay, self.publish_state, fn, {"power": 12.5})

    def publish_state(self, fn: str, update: dict) -> None:
        st = self.state.setdefault(fn, {})
        st.update(update)
        self.mqtt.deliver(f"{BASE}/{fn}", dict(st))


class FakeHA:
    """HA с BMS Integration (main):
    - служба возвращается сразу, показ меняется сразу (оптимистично, entity.py:546,
      coordinator.py:1010-1034: ожидаемое значение и в _status, и в кэш);
    - свои события интеграция шлёт, только если подписаны именно на них (coordinator.py:1514);
    - посылка со шлюза: dp_triggered при одной точке, status_update при отличии
      _status от кэша (coordinator.py:1509-1540); bms_integration_push - только с правкой.
    """

    def __init__(self, entities: dict, patched: bool = False, delay: float = 0.02) -> None:
        # entities: entity_id -> (device_id, dp, начальный показ)
        self.devices = {eid: (dev, dp) for eid, (dev, dp, _) in entities.items()}
        self.states = {eid: st for eid, (_, _, st) in entities.items()}
        self.status = {eid: {dp: st == "on", "9": 5} for eid, (_, dp, st) in entities.items()}
        self.patched = patched
        self.delay = delay
        self.behavior: dict[str, str] = {}
        self.subscribed: list[str] = []
        self.on_event = None
        self.calls: list[tuple[str, str, str]] = []

    async def connect(self, on_event) -> None:
        self.on_event = on_event

    async def request(self, payload: dict) -> dict:
        kind = payload["type"]
        if kind == "config/entity_registry/get":
            eid = payload["entity_id"]
            if eid not in self.devices:
                return {"success": False, "error": {"code": "not_found"}}
            dev, dp = self.devices[eid]
            return {"success": True, "result": {"entity_id": eid, "platform": "bms_integration",
                                                "unique_id": f"local_{dev}_{dp}"}}
        if kind == "get_states":
            return {"success": True, "result": [{"entity_id": e, "state": s} for e, s in self.states.items()]}
        raise AssertionError(f"неожиданный запрос {kind}")

    async def subscribe(self, event_type: str) -> None:
        self.subscribed.append(event_type)

    async def close(self) -> None:
        pass

    def fire(self, event_type: str, data: dict) -> None:
        # Как coordinator.py:1514: нет слушателя этого типа - события нет.
        if event_type in self.subscribed:
            self.on_event({"event_type": event_type, "data": data})

    def set_state(self, eid: str, new: str) -> None:
        old = self.states.get(eid)
        self.states[eid] = new
        self.fire("state_changed", {"entity_id": eid, "old_state": {"state": old}, "new_state": {"state": new}})

    def device_push(self, eid: str, dps: dict) -> None:
        dev, _ = self.devices[eid]
        old = dict(self.status[eid])
        self.status[eid].update(dps)
        if self.patched:
            self.fire(EVENT_PUSH, {"device_id": dev, "cid": "cid-" + dev, "dps": dict(dps), "t": 1})
        if len(dps) == 1:
            dp, value = next(iter(dps.items()))
            self.fire(EVENT_DP, {"device_id": dev, "dp": dp, "value": value})
        if old != self.status[eid]:
            self.fire(EVENT_STATUS, {"device_id": dev, "old_status": old, "new_status": dict(self.status[eid])})

    async def call_service(self, domain: str, service: str, entity_id: str):
        self.calls.append((domain, service, entity_id))
        behavior = self.behavior.get(entity_id, "confirm")
        if behavior == "error":
            return False, f"Device {entity_id} is not connected"
        on = service in ("turn_on", "open_cover")
        _, dp = self.devices[entity_id]
        before = self.states[entity_id]
        self.status[entity_id][dp] = on               # оптимистично, ещё до шлюза
        self.set_state(entity_id, "on" if on else "off")
        loop = asyncio.get_running_loop()
        if behavior == "confirm":
            loop.call_later(self.delay, self.device_push, entity_id, {dp: on})
        elif behavior == "multi_dp":
            loop.call_later(self.delay, self.device_push, entity_id, {dp: on, "9": 0})
        elif behavior == "wrong_value":
            loop.call_later(self.delay, self.device_push, entity_id, {dp: not on})
        elif behavior == "rollback":
            loop.call_later(self.delay, self.set_state, entity_id, before)
        elif behavior == "cache_echo":
            # Ответ на опрос кэша хаба после таймаута шлюза (coordinator.py:938-955):
            # в кэше уже лежит наша запись, и dp_triggered стреляет с ней.
            loop.call_later(self.delay, self.device_push, entity_id, {dp: on})
        # silent: показ остался «вкл», а устройство молчит - та самая ловушка.
        return True, ""


class ScriptedOperator:
    def __init__(self, answers=None, on_enter=None) -> None:
        self.answers = list(answers or [])
        self.on_enter = on_enter or (lambda text: None)
        self.said: list[str] = []
        self.prompts: list[str] = []

    def say(self, text: str) -> None:
        self.said.append(text)

    async def wait_enter(self, text: str) -> None:
        self.prompts.append(text)
        self.on_enter(text)

    async def ask(self, text: str) -> str:
        self.prompts.append(text)
        return self.answers.pop(0)
