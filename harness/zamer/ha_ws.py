"""Home Assistant WebSocket API: вход по токену, подписки, вызов служб, переподключение."""
from __future__ import annotations

import asyncio
from typing import Callable

import aiohttp


class HAWebSocket:
    def __init__(self, url: str, token: str, reconnect: bool = True) -> None:
        self.url = url
        self.token = token
        self.reconnect = reconnect
        self.on_event: Callable[[dict], None] | None = None
        self._session: aiohttp.ClientSession | None = None
        self._ws = None
        self._reader: asyncio.Task | None = None
        self._reconnector: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._subscriptions: list[str] = []
        self._next_id = 0
        self._closing = False

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._ws.closed

    async def connect(self, on_event: Callable[[dict], None]) -> None:
        self.on_event = on_event
        await self._open()

    async def _open(self) -> None:
        if self._session is None:
            self._session = aiohttp.ClientSession()
        ws = await self._session.ws_connect(self.url, heartbeat=30, max_msg_size=0)
        hello = await ws.receive_json(timeout=10)
        if hello.get("type") != "auth_required":
            await ws.close()
            raise ConnectionError(f"HA: неожиданное приветствие {hello}")
        await ws.send_json({"type": "auth", "access_token": self.token})
        reply = await ws.receive_json(timeout=10)
        if reply.get("type") != "auth_ok":
            await ws.close()
            raise ConnectionError(f"HA не принял токен: {reply.get('message', reply)}")
        self._ws = ws
        self._reader = asyncio.create_task(self._read(ws))
        # После переподключения подписки надо оформить заново - сервер их забыл.
        for event_type in self._subscriptions:
            await self._subscribe_raw(event_type)

    async def _read(self, ws) -> None:
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                data = msg.json()
                for item in data if isinstance(data, list) else [data]:
                    self._dispatch(item)
        finally:
            if self._ws is ws:
                self._ws = None
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(ConnectionError("связь с HA оборвалась"))
            self._pending.clear()
            if not self._closing and self.reconnect:
                self._reconnector = asyncio.create_task(self._reconnect_loop())

    async def _reconnect_loop(self) -> None:
        delay = 1.0
        while not self._closing:
            await asyncio.sleep(delay)
            try:
                await self._open()
                print("HA: связь восстановлена", flush=True)
                return
            except (OSError, aiohttp.ClientError, ConnectionError, asyncio.TimeoutError) as ex:
                print(f"HA: нет связи ({ex}), повтор через {delay:.0f} с", flush=True)
                delay = min(delay * 2, 30.0)

    def _dispatch(self, item: dict) -> None:
        if item.get("type") == "result":
            fut = self._pending.pop(item.get("id"), None)
            if fut is not None and not fut.done():
                fut.set_result(item)
        elif item.get("type") == "event" and self.on_event is not None:
            self.on_event(item.get("event") or {})

    async def request(self, payload: dict, timeout: float = 15.0) -> dict:
        if not self.connected:
            raise ConnectionError("нет связи с HA")
        self._next_id += 1
        msg_id = self._next_id
        fut = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        try:
            await self._ws.send_json({**payload, "id": msg_id})
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as ex:
            raise ConnectionError(f"HA не ответил на {payload.get('type')} за {timeout:.0f} с") from ex
        finally:
            self._pending.pop(msg_id, None)

    async def subscribe(self, event_type: str) -> None:
        self._subscriptions.append(event_type)
        await self._subscribe_raw(event_type)

    async def _subscribe_raw(self, event_type: str) -> None:
        # Подписка строго по имени события, не на всё сразу: BMS Integration
        # шлёт свои события, только если есть слушатель именно этого типа
        # (coordinator.py:1514 - проверка hass.bus.async_listeners()).
        res = await self.request({"type": "subscribe_events", "event_type": event_type})
        if not res.get("success"):
            raise ConnectionError(f"HA не дал подписку на {event_type}: {res.get('error')} (нужен токен администратора)")

    async def call_service(self, domain: str, service: str, entity_id: str) -> tuple[bool, str]:
        res = await self.request(
            {"type": "call_service", "domain": domain, "service": service, "target": {"entity_id": entity_id}}
        )
        if res.get("success"):
            return True, ""
        err = res.get("error") or {}
        return False, str(err.get("message") or err)

    async def close(self) -> None:
        self._closing = True
        for task in (self._reconnector, self._reader):
            if task is not None and not task.done():
                task.cancel()
        if self._ws is not None:
            await self._ws.close()
        if self._session is not None:
            await self._session.close()
