"""Наша сторона: подтверждение / отказ / таймаут по Z2M и проверка оптимизма."""
import asyncio
import time

from fakes import BASE, FakeMqtt, FakeZ2M, actuator, make_cfg, sensor
from zamer.common import CONFIRMED, FAILED, NO_LINK, TIMEOUT
from zamer.z2m import Z2MSide, optimistic_problems


async def _side(tmp_path, monkeypatch, devices, optimistic=False):
    cfg = make_cfg(tmp_path, devices, monkeypatch)
    mqtt = FakeMqtt()
    z2m = FakeZ2M(mqtt, optimistic=optimistic)
    side = Z2MSide(cfg, mqtt)
    await side.start(cfg.pairs)
    return cfg, mqtt, z2m, side


def test_confirm_by_device_state(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        r = await side.turn(cfg.pair("lamp"), True)
        assert mqtt.published == [(f"{BASE}/lamp/set", '{"state": "ON"}')]
        assert r.status == CONFIRMED
        assert 15 <= r.latency_ms < 150
        assert side.last_value["lamp"] == "ON"
        assert side.next_on(cfg.pair("lamp")) is False  # следующая команда - выключить
    asyncio.run(go())


def test_failure_from_bridge_logging_comes_before_timeout(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.behavior["lamp"] = "fail"
        t0 = time.monotonic()
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == FAILED
        assert "Delivery failed" in r.detail
        assert time.monotonic() - t0 < 0.1  # не ждали таймаут 0.15 с
    asyncio.run(go())


def test_silence_is_timeout(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.behavior["lamp"] = "silent"
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == TIMEOUT
    asyncio.run(go())


def test_unrelated_report_with_old_state_does_not_confirm(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("plug")])
        z2m.publish_state("plug", {"state": "OFF"})  # устройство сообщило: выключено
        z2m.behavior["plug"] = "unrelated"
        r = await side.turn(cfg.pair("plug"), side.next_on(cfg.pair("plug")))
        assert r.status == TIMEOUT  # отчёт о мощности с кэшем OFF - не подтверждение ON
    asyncio.run(go())


def test_retained_state_is_ignored(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.behavior["lamp"] = "silent"
        task = asyncio.create_task(side.turn(cfg.pair("lamp"), True))
        await asyncio.sleep(0.01)
        mqtt.deliver(f"{BASE}/lamp", {"state": "ON"}, retained=True)  # старое из брокера
        assert (await task).status == TIMEOUT
    asyncio.run(go())


def test_failure_of_similar_name_is_not_ours(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp"), actuator("lamp2")])
        z2m.behavior["lamp"] = "silent"
        task = asyncio.create_task(side.turn(cfg.pair("lamp"), True))
        await asyncio.sleep(0.01)
        mqtt.deliver(f"{BASE}/bridge/logging", {"level": "error", "message": "Publish 'set' 'state' to 'lamp2' failed: 'x'"})
        assert (await task).status == TIMEOUT
    asyncio.run(go())


def test_no_link_when_broker_is_down(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        mqtt.down = True
        assert (await side.turn(cfg.pair("lamp"), True)).status == NO_LINK
    asyncio.run(go())


def test_optimistic_z2m_would_lie_and_check_refuses(tmp_path, monkeypatch):
    """Z2M по умолчанию оптимистичен: «подтверждение» приходит раньше устройства.
    Замерщик не должен работать с такими настройками."""
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")], optimistic=True)
        z2m.behavior["lamp"] = "silent"          # устройство не ответило вовсе
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == CONFIRMED             # вот она, ложь оптимизма
        z2m.bridge_info(["lamp"])                # optimistic не задан = true
        problems = await side.check_setup(wait_s=0.1)
        assert problems and "optimistic" in problems[0]
    asyncio.run(go())


def test_check_passes_with_optimistic_off(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.bridge_info(["lamp"], device_options={"optimistic": False})
        assert await side.check_setup(wait_s=0.1) == []
    asyncio.run(go())


def test_optimistic_problems_rules():
    names = ["a", "b"]
    assert optimistic_problems(None, names)[0].startswith("нет zigbee2mqtt/bridge/info")
    cfg = {"device_options": {"optimistic": False},
           "devices": {"0x1": {"friendly_name": "a"}, "0x2": {"friendly_name": "b", "optimistic": True}}}
    problems = optimistic_problems(cfg, names)
    assert len(problems) == 1 and problems[0].startswith("b:")  # своя настройка важнее общей
    cfg = {"devices": {"0x1": {"friendly_name": "a", "optimistic": False, "debounce": 1}}}
    problems = optimistic_problems(cfg, names)
    assert any("debounce" in p for p in problems)
    assert any(p.startswith("b: нет среди") for p in problems)


def test_sensor_messages_are_reports_and_availability(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [sensor("temp", 60)])
        reports, avail = [], []
        side.on_report = lambda s, d, ts: reports.append((s, d))
        side.on_availability = lambda s, d, ts, online: avail.append((d, online))
        z2m.publish_state("temp", {"temperature": 21.5})
        z2m.publish_state("temp", {"temperature": 21.5})  # тот же отчёт ещё раз - тоже отчёт
        mqtt.deliver(f"{BASE}/temp/availability", {"state": "offline"})
        mqtt.deliver(f"{BASE}/temp/availability", {"state": "online"})
        assert reports == [("ours", "temp"), ("ours", "temp")]
        assert avail == [("temp", False), ("temp", True)]
    asyncio.run(go())
