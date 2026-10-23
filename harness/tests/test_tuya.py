"""Сторона Tuya: оптимистичный показ HA - НЕ подтверждение; подтверждает только посылка шлюза."""
import asyncio

import pytest

from fakes import FakeHA, actuator, make_cfg, sensor
from zamer.common import CONFIRMED, FAILED, NO_LINK, SUSPECT, TIMEOUT
from zamer.tuya_ha import EVENT_DP, EVENT_PUSH, EVENT_STATUS, TuyaHASide, parse_unique_id

ENTITIES = {
    "switch.lamp": ("devlamp01", "1", "off"),
    "switch.plug": ("devplug02", "1", "off"),
    "sensor.temp": ("devtemp03", "1", "21.0"),
}


async def _side(tmp_path, monkeypatch, devices, confirm="dp_event", patched=False):
    cfg = make_cfg(tmp_path, devices, monkeypatch, confirm=confirm)
    ha = FakeHA(ENTITIES, patched=patched)
    side = TuyaHASide(cfg, ha)
    await side.start(cfg.pairs)
    return cfg, ha, side


def test_optimistic_state_is_not_confirmation(tmp_path, monkeypatch):
    """Главная ловушка: HA сразу показывает «вкл», устройство молчит -> таймаут."""
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        ha.behavior["switch.lamp"] = "silent"
        r = await side.turn(cfg.pair("lamp"), True)
        assert ha.states["switch.lamp"] == "on"   # интерфейс врёт
        assert r.status == TIMEOUT
        assert r.optimistic_ms is not None and r.optimistic_ms < 50
    asyncio.run(go())


def test_device_push_confirms(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == CONFIRMED
        assert 15 <= r.latency_ms < 150            # время посылки, а не показа
        assert r.optimistic_ms < r.latency_ms
        assert ha.calls == [("switch", "turn_on", "switch.lamp")]
        assert side.next_on(cfg.pair("lamp")) is False
    asyncio.run(go())


def test_rollback_is_failure(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        ha.behavior["switch.lamp"] = "rollback"
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == FAILED and "откатила" in r.detail
    asyncio.run(go())


def test_service_error_is_failure(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        ha.behavior["switch.lamp"] = "error"
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == FAILED and "not connected" in r.detail
    asyncio.run(go())


def test_wrong_value_from_device_is_not_confirmation(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        ha.behavior["switch.lamp"] = "wrong_value"
        assert (await side.turn(cfg.pair("lamp"), True)).status == TIMEOUT
    asyncio.run(go())


def test_status_update_with_expected_value_is_not_confirmation(tmp_path, monkeypatch):
    """Посылка из двух точек: dp_triggered молчит, status_update несёт ожидаемое
    значение - но оно лежало в кэше ещё до ответа. В dp_event это таймаут."""
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        seen = []
        orig = side.handle_event
        side.handle_event = lambda e: (seen.append(e["event_type"]), orig(e))
        ha.on_event = side.handle_event
        ha.behavior["switch.lamp"] = "multi_dp"
        r = await side.turn(cfg.pair("lamp"), True)
        assert EVENT_STATUS in seen and EVENT_DP not in seen
        assert r.status == TIMEOUT
    asyncio.run(go())


def test_push_event_mode_sees_multi_dp(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")], confirm="push_event", patched=True)
        ha.behavior["switch.lamp"] = "multi_dp"
        assert (await side.turn(cfg.pair("lamp"), True)).status == CONFIRMED
        assert set(ha.subscribed) == {"state_changed", EVENT_PUSH}
    asyncio.run(go())


def test_push_mode_without_patch_never_confirms(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")], confirm="push_event", patched=False)
        assert (await side.turn(cfg.pair("lamp"), True)).status == TIMEOUT
    asyncio.run(go())


def test_answer_after_timeout_is_suspect(tmp_path, monkeypatch):
    """После таймаута интеграция опрашивает кэш хаба, где уже наша запись -
    одноточечный ответ даёт dp_triggered. Такое «подтверждение» не в счёт."""
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        ha.behavior["switch.lamp"] = "silent"
        assert (await side.turn(cfg.pair("lamp"), True)).status == TIMEOUT
        ha.behavior["switch.lamp"] = "cache_echo"
        r = await side.turn(cfg.pair("lamp"), False)
        assert r.status == SUSPECT
        side.suspect_until.clear()               # окно прошло
        ha.behavior["switch.lamp"] = "confirm"
        assert (await side.turn(cfg.pair("lamp"), True)).status == CONFIRMED
    asyncio.run(go())


def test_unavailable_fails_and_return_is_suspect(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        avail = []
        side.on_availability = lambda s, d, ts, online: avail.append(online)
        ha.behavior["switch.lamp"] = "silent"
        task = asyncio.create_task(side.turn(cfg.pair("lamp"), True))
        await asyncio.sleep(0.01)
        ha.set_state("switch.lamp", "unavailable")
        assert (await task).status == FAILED
        ha.set_state("switch.lamp", "off")
        assert avail == [False, True]
        assert side.suspect_until["lamp"] > asyncio.get_running_loop().time()
    asyncio.run(go())


def test_no_link_to_ha(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])

        async def broken(*_):
            raise ConnectionError("связь с HA оборвалась")
        ha.call_service = broken
        assert (await side.turn(cfg.pair("lamp"), True)).status == NO_LINK
    asyncio.run(go())


def test_subscribes_to_exact_event_types(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        # Не "*": интеграция проверяет слушателя именно своего события.
        assert set(ha.subscribed) == {"state_changed", EVENT_DP, EVENT_STATUS}
        pair = cfg.pair("lamp")
        assert (pair.tuya_device_id, pair.tuya_dp) == ("devlamp01", "1")  # из реестра HA
    asyncio.run(go())


def test_sensor_one_push_is_one_report(tmp_path, monkeypatch):
    async def go():
        cfg, ha, side = await _side(tmp_path, monkeypatch, [sensor("temp", 60)])
        reports = []
        side.on_report = lambda s, d, ts: reports.append(d)
        ha.device_push("sensor.temp", {"1": 22.5})   # даёт dp_triggered И status_update
        assert reports == ["temp"]
    asyncio.run(go())


@pytest.mark.parametrize("uid, expected", [
    ("local_bf1234abcd_1", ("bf1234abcd", "1")),
    ("local_a3e1_b2_20", ("a3e1_b2", "20")),
    ("local_bf1234_1_calibrate", None),
    ("cloud_lock_bf12", None),
    (None, None),
])
def test_parse_unique_id(uid, expected):
    assert parse_unique_id(uid) == expected
