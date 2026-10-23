"""Проверка правки pytuya: push от шлюза доходит до слушателя сырым, ответ на команду - нет.

Запуск: .work/pv/bin/python -I tools/check_push_patch.py <папка core с pytuya> (нужен cryptography)
"""
import json
import sys

sys.path.insert(0, sys.argv[1])
import pytuya  # noqa: E402
from pytuya.const import CMDType, TuyaMessage  # noqa: E402


class Sub:
    def __init__(self):
        self.pushes, self.statuses = [], []

    def push_received(self, dps, t):
        self.pushes.append((dps, t))

    def status_updated(self, status):
        self.statuses.append(dict(status))

    def disconnected(self, exc=""):
        pass

    def subdevice_state_updated(self, state):
        pass


class Gateway(Sub):
    def __init__(self):
        super().__init__()
        self.sub_devices = {"cid1": Sub()}


import asyncio  # noqa: E402


async def main():
    gw = Gateway()
    proto = pytuya.TuyaProtocol("gw1", "0123456789abcdef", 3.3, False, gw)
    proto._decode_payload = lambda payload: json.loads(payload)
    # «Оптимистичная» запись: в кэше уже лежит ожидаемое значение (coordinator.py:1028).
    proto.dps_cache["cid1"] = {"1": True, "9": 5}

    push = {"t": 1761170000, "cid": "cid1", "dps": {"1": True}}
    proto.dispatcher.callback_status_update(TuyaMessage(0, CMDType.STATUS, 0, json.dumps(push).encode(), 0))
    ack = TuyaMessage(7, CMDType.CONTROL_NEW, 0, b"", 0)
    proto.dispatcher.callback_status_update(ack, ack=True)

    sub = gw.sub_devices["cid1"]
    print("push_received:", sub.pushes)
    print("status_updated:", sub.statuses)
    print("шлюзу:", gw.pushes, gw.statuses)


asyncio.run(main())
