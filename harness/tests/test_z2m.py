"""Наша сторона: подтверждение / отказ / таймаут по Z2M и проверка оптимизма."""
import asyncio
import time

from fakes import BASE, FakeMqtt, FakeZ2M, actuator, make_cfg, sensor
from zamer.common import CONFIRMED, FAILED, NO_LINK, TIMEOUT
from zamer.z2m import Z2MSide, reporting_problems


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
        assert mqtt.published[0][0] == f"{BASE}/lamp/set"
        sent = __import__("json").loads(mqtt.published[0][1])
        assert sent["state"] == "ON" and len(sent["__bms_command_id"]) == 32
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


def test_optimistic_state_never_confirms_even_if_device_option_is_false(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")], optimistic=True)
        z2m.behavior["lamp"] = "silent"
        z2m.bridge_info(["lamp"], device_options={"optimistic": False})
        assert await side.check_setup(wait_s=0.1) == []
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == TIMEOUT
        assert side.counters["state_publications_ignored"] == 1
    asyncio.run(go())


def test_check_passes_with_optimistic_off(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.bridge_info(["lamp"], device_options={"optimistic": False})
        assert await side.check_setup(wait_s=0.1) == []
    asyncio.run(go())


def test_reporting_problems_rules():
    cap = {"schema": 1, "device_reports": True, "command_correlation": True}
    assert reporting_problems(None, cap, ["a"])
    assert reporting_problems({"devices": {}}, None, ["a"])
    cfg = {"advanced": {"bms_device_reports": True}, "devices": {"0x1": {"friendly_name": "a", "optimistic": True}}}
    assert reporting_problems(cfg, cap, ["a"]) == []
    assert reporting_problems(cfg, cap, ["b"]) == ["b: нет среди устройств Z2M"]


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


def test_group_ui_state_and_cached_payload_cannot_confirm(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.behavior["lamp"] = "silent"
        z2m.publish_state("lamp", {"state": "ON"})
        task = asyncio.create_task(side.turn(cfg.pair("lamp"), True))
        await asyncio.sleep(0)
        mqtt.deliver(f"{BASE}/lamp", {"state": "ON"})  # groupOptimistic
        z2m.publish_state("lamp", {"power": 15})        # ordinary state includes cached ON
        assert (await task).status == TIMEOUT
    asyncio.run(go())


def test_stale_duplicate_and_wrong_endpoint_report_are_not_confirmation(tmp_path, monkeypatch):
    async def go():
        device = actuator("relay");device["ours"]["endpoint"] = 2;device["ours_key"] = "state_l2"
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [device])
        z2m.capabilities();z2m.behavior["relay"] = "silent"
        task = asyncio.create_task(side.turn(cfg.pair("relay"), True));await asyncio.sleep(0)
        report = {"schema":1,"source":"device","session_id":"test-session","sequence":1,"received_at":time.time()*1000,
                  "friendly_name":"relay","endpoint":1,"cluster":"genOnOff","type":"attributeReport","raw":{"onOff":1},"payload":{"state_l2":"ON"}}
        mqtt.deliver(f"{BASE}/bridge/bms/device_report", report)
        report.update(endpoint=2,sequence=2,received_at=(time.time()-1)*1000)
        mqtt.deliver(f"{BASE}/bridge/bms/device_report", report)
        report.update(received_at=time.time()*1000)
        mqtt.deliver(f"{BASE}/bridge/bms/device_report", report) # sequence replay
        assert (await task).status == TIMEOUT
        assert side.counters["invalid_reports"] == 1
    asyncio.run(go())


def test_fresh_report_has_source_detail_and_counters(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        r = await side.turn(cfg.pair("lamp"), True)
        assert r.status == CONFIRMED and "device_report test-session/" in r.detail
        assert side.counters["mqtt_commands"] == side.counters["confirmed_reports"] == 1
        mqtt.deliver(f"{BASE}/bridge/bms/tx_event", {"schema":1,"kind":"group_frame"})
        assert side.counters["group_frame"] == 1
    asyncio.run(go())


def test_converter_cached_state_requires_raw_evidence(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.capabilities();z2m.behavior["lamp"] = "silent"
        task = asyncio.create_task(side.turn(cfg.pair("lamp"), True));await asyncio.sleep(0)
        mqtt.deliver(f"{BASE}/bridge/bms/device_report", {"schema":1,"source":"device","session_id":"test-session","sequence":1,
            "received_at":time.time()*1000,"friendly_name":"lamp","endpoint":1,"cluster":"haElectricalMeasurement","type":"attributeReport",
            "raw":{"activePower":12},"payload":{"state":"ON","power":12}})
        assert (await task).status == TIMEOUT
        assert side.counters["unverified_payloads"] == 1
    asyncio.run(go())


def test_tuya_confirmation_requires_the_configured_datapoint(tmp_path, monkeypatch):
    async def go():
        dev=actuator("tuya");dev["ours"].update(report_dp=7,report_values=[1,0])
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [dev])
        z2m.capabilities();z2m.behavior["tuya"]="silent"
        task=asyncio.create_task(side.turn(cfg.pair("tuya"),True));await asyncio.sleep(0)
        report={"schema":1,"source":"device","session_id":"test-session","sequence":1,"received_at":time.time()*1000,
                "friendly_name":"tuya","endpoint":1,"cluster":"manuSpecificTuya","type":"commandDataReport",
                "raw":{"dpValues":[{"dp":8,"datatype":1,"data":{"type":"Buffer","data":[1]}}]},"payload":{"state":"ON"}}
        mqtt.deliver(f"{BASE}/bridge/bms/device_report",report)
        assert not task.done()
        report["raw"]["dpValues"][0]["dp"]=7;report["sequence"]=2
        mqtt.deliver(f"{BASE}/bridge/bms/device_report",report)
        assert (await task).status==CONFIRMED
    asyncio.run(go())


def test_source_barrier_ignores_clock_skew_and_precommand_report(tmp_path, monkeypatch):
    async def go():
        cfg, mqtt, z2m, side = await _side(tmp_path, monkeypatch, [actuator("lamp")])
        z2m.behavior["lamp"] = "silent"
        task = asyncio.create_task(side.turn(cfg.pair("lamp"), True))
        await asyncio.sleep(0)
        import json
        command_id = json.loads(mqtt.published[-1][1])["__bms_command_id"]
        mqtt.deliver(f"{BASE}/bridge/bms/tx_event", {"schema": 1, "kind": "mqtt_intent", "command_id": command_id, "received_at": 10000})
        report = {"schema": 1, "source": "device", "session_id": "test-session", "sequence": 1,
                  "received_at": 9999, "friendly_name": "lamp", "endpoint": 1,
                  "cluster": "genOnOff", "type": "attributeReport", "raw": {"onOff": 1}, "payload": {"state": "ON"}}
        mqtt.deliver(f"{BASE}/bridge/bms/device_report", report)
        assert not task.done()
        report.update(sequence=2, received_at=10001)
        mqtt.deliver(f"{BASE}/bridge/bms/device_report", report)
        assert (await task).status == CONFIRMED
    asyncio.run(go())
