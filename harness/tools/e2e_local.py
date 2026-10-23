"""Сквозной прогон CLI замерщика без железа: настоящий брокер MQTT (amqtt),
поддельный Z2M (paho) и поддельный HA (aiohttp WebSocket) в одном процессе.
lamp отвечает на обеих сторонах; plug: у нас Z2M пишет ошибку в bridge/logging,
у Tuya HA показывает «вкл», а устройство молчит.

Запуск (amqtt - только для этой проверки, в отдельном venv):
    python3.12 -m venv .work/pv && .work/pv/bin/pip install amqtt paho-mqtt aiohttp pyyaml
    .work/pv/bin/python -I tools/e2e_local.py
"""
import asyncio, json, os, sys, threading, time
from pathlib import Path

import paho.mqtt.client as mqtt
from aiohttp import WSMsgType, web
from amqtt.broker import Broker

HARNESS = Path(__file__).resolve().parents[1]
HERE = Path(__file__).resolve().parent
ENT = {"switch.lamp": ("devlamp", "1"), "switch.plug": ("devplug", "1"), "sensor.temp": ("devtemp", "1")}


def fake_z2m(stop):
    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="fake-z2m")
    state = {}

    def on_connect(cl, *_):
        cl.subscribe("zigbee2mqtt/+/set")
        info = {"config": {"device_options": {"optimistic": False},
                           "devices": {f"0x0{i}": {"friendly_name": n} for i, n in enumerate(["lamp", "plug", "temp"])}}}
        cl.publish("zigbee2mqtt/bridge/info", json.dumps(info), retain=True)

    def on_message(cl, _u, msg):
        fn = msg.topic.split("/")[1]
        if fn == "plug":
            err = {"level": "error", "message": f"Publish 'set' 'state' to 'plug' failed: 'Error: Delivery failed {time.time()}'"}
            cl.publish("zigbee2mqtt/bridge/logging", json.dumps(err))
            return
        cmd = json.loads(msg.payload)

        def answer():
            state.setdefault(fn, {}).update(cmd)
            cl.publish(f"zigbee2mqtt/{fn}", json.dumps(state[fn]))
        threading.Timer(0.05, answer).start()

    c.on_connect, c.on_message = on_connect, on_message
    c.connect("127.0.0.1", 18830)
    c.loop_start()
    i = 0
    while not stop.is_set():
        i += 1
        c.publish("zigbee2mqtt/temp", json.dumps({"temperature": 20 + i / 10}))
        stop.wait(1.0)
    c.loop_stop()


def fake_ha():
    states = {"switch.lamp": "off", "switch.plug": "off", "sensor.temp": "21.0"}
    subs, sockets = {}, []

    async def send_event(ev_type, data):
        for ws in list(sockets):
            if ev_type in subs and not ws.closed:
                await ws.send_json({"id": subs[ev_type], "type": "event", "event": {"event_type": ev_type, "data": data}})

    async def set_state(eid, new):
        old, states[eid] = states[eid], new
        await send_event("state_changed", {"entity_id": eid, "old_state": {"state": old}, "new_state": {"state": new}})

    async def handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({"type": "auth_required"})
        auth = await ws.receive_json()
        await ws.send_json({"type": "auth_ok" if auth.get("access_token") == "e2e" else "auth_invalid"})
        sockets.append(ws)
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            req = msg.json()
            t, rid = req["type"], req["id"]
            if t == "subscribe_events":
                subs[req["event_type"]] = rid
                await ws.send_json({"id": rid, "type": "result", "success": True, "result": None})
            elif t == "config/entity_registry/get":
                dev, dp = ENT[req["entity_id"]]
                await ws.send_json({"id": rid, "type": "result", "success": True, "result": {"unique_id": f"local_{dev}_{dp}"}})
            elif t == "get_states":
                await ws.send_json({"id": rid, "type": "result", "success": True,
                                    "result": [{"entity_id": e, "state": s} for e, s in states.items()]})
            elif t == "call_service":
                eid = req["target"]["entity_id"]
                on = req["service"] == "turn_on"
                await ws.send_json({"id": rid, "type": "result", "success": True, "result": {}})
                await set_state(eid, "on" if on else "off")          # оптимистичный показ
                if eid == "switch.lamp":
                    async def push():
                        await asyncio.sleep(0.08)
                        await send_event("bms_integration_device_dp_triggered", {"device_id": "devlamp", "dp": "1", "value": on})
                    asyncio.create_task(push())
        return ws

    async def sensor_loop(app):
        async def loop():
            i = 0
            while True:
                i += 1
                await send_event("bms_integration_device_dp_triggered", {"device_id": "devtemp", "dp": "1", "value": 210 + i})
                await asyncio.sleep(1.0)
        app["sensor"] = asyncio.create_task(loop())
    app = web.Application()
    app.router.add_get("/api/websocket", handler)
    app.on_startup.append(sensor_loop)
    return app


async def zamer(*args, stdin=b""):
    env = {**os.environ, "HA_TOKEN": "e2e"}
    p = await asyncio.create_subprocess_exec(
        str(HARNESS / ".venv/bin/python"), "-m", "zamer", "-c", str(HERE / "e2e.yaml"), *args,
        cwd=str(HARNESS), env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    out, _ = await p.communicate(stdin)
    print(f"$ python -m zamer {' '.join(args)}   -> код {p.returncode}")
    print(out.decode())


async def main():
    (HARNESS / ".work" / "e2e.sqlite").unlink(missing_ok=True)
    broker = Broker({"listeners": {"default": {"type": "tcp", "bind": "127.0.0.1:18830"}},
                     "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}}})
    await broker.start()
    runner = web.AppRunner(fake_ha())
    await runner.setup()
    await web.TCPSite(runner, "127.0.0.1", 18123).start()
    stop = threading.Event()
    th = threading.Thread(target=fake_z2m, args=(stop,), daemon=True)
    th.start()
    await asyncio.sleep(1)
    try:
        await zamer("check")
        await zamer("run", "1", "--duration", "20s")
        await zamer("run", "2", "--outage", "2s", "--limit", "10s", "--probe", "2s", stdin=b"\n\n")
        await zamer("report")
    finally:
        stop.set()
        th.join(3)
        await runner.cleanup()
        await broker.shutdown()


asyncio.run(main())
