"""Настоящий клиент HAWebSocket против поддельного сервера HA (протокол WebSocket API)."""
import asyncio

import pytest
from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestServer

from zamer.ha_ws import HAWebSocket

TOKEN = "good-token"


def _app(state):
    async def ws_handler(request):
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        state["sockets"].append(ws)
        await ws.send_json({"type": "auth_required", "ha_version": "2026.10.0"})
        auth = await ws.receive_json()
        if auth.get("access_token") != TOKEN:
            await ws.send_json({"type": "auth_invalid", "message": "Invalid access token or password"})
            await ws.close()
            return ws
        await ws.send_json({"type": "auth_ok", "ha_version": "2026.10.0"})
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            req = msg.json()
            state["requests"].append(req)
            if req["type"] == "subscribe_events":
                await ws.send_json({"id": req["id"], "type": "result", "success": True, "result": None})
                await ws.send_json({"id": req["id"], "type": "event", "event": {
                    "event_type": req["event_type"], "data": {"device_id": "dev1", "dp": "1", "value": True}}})
            elif req["type"] == "call_service":
                if req["target"]["entity_id"] == "switch.broken":
                    await ws.send_json({"id": req["id"], "type": "result", "success": False,
                                        "error": {"code": "home_assistant_error", "message": "Device X is not connected"}})
                else:
                    await ws.send_json({"id": req["id"], "type": "result", "success": True, "result": {}})
        return ws

    app = web.Application()
    app.router.add_get("/api/websocket", ws_handler)
    return app


def test_auth_subscribe_call_and_reconnect():
    async def go():
        state = {"sockets": [], "requests": []}
        server = TestServer(_app(state))
        await server.start_server()
        url = str(server.make_url("/api/websocket")).replace("http", "ws", 1)
        events = []
        client = HAWebSocket(url, TOKEN)
        try:
            await client.connect(events.append)
            await client.subscribe("bms_integration_device_dp_triggered")
            await asyncio.sleep(0.05)
            assert events and events[0]["event_type"] == "bms_integration_device_dp_triggered"
            assert await client.call_service("switch", "turn_on", "switch.lamp") == (True, "")
            ok, err = await client.call_service("switch", "turn_on", "switch.broken")
            assert not ok and "not connected" in err
            call = [r for r in state["requests"] if r["type"] == "call_service"][0]
            assert call["domain"] == "switch" and call["service"] == "turn_on"

            # Сервер оборвал связь: клиент переподключается и сам заново подписывается.
            await state["sockets"][0].close()
            for _ in range(50):
                await asyncio.sleep(0.1)
                if len(state["sockets"]) >= 2 and client.connected:
                    break
            subs = [r for r in state["requests"] if r["type"] == "subscribe_events"]
            assert len(subs) == 2
        finally:
            await client.close()
            await server.close()
    asyncio.run(go())


def test_bad_token():
    async def go():
        state = {"sockets": [], "requests": []}
        server = TestServer(_app(state))
        await server.start_server()
        url = str(server.make_url("/api/websocket")).replace("http", "ws", 1)
        client = HAWebSocket(url, "wrong", reconnect=False)
        try:
            with pytest.raises(ConnectionError, match="токен"):
                await client.connect(lambda e: None)
        finally:
            await client.close()
            await server.close()
    asyncio.run(go())
