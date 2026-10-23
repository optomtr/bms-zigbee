"""Сценарии целиком на поддельных бэкендах + отчёт по базе."""
import asyncio
import csv

from fakes import FakeHA, FakeMqtt, FakeZ2M, ScriptedOperator, actuator, make_cfg, sensor
from zamer import report
from zamer.scenarios import Bench, s1_normal, s2_power, s3_repeater, s7_week, s8_new_model
from zamer.store import Store
from zamer.tuya_ha import TuyaHASide
from zamer.z2m import Z2MSide

ENTITIES = {
    "switch.lamp": ("devlamp01", "1", "off"),
    "switch.plug": ("devplug02", "1", "off"),
    "sensor.temp": ("devtemp03", "1", "21.0"),
}


async def _bench(tmp_path, monkeypatch, devices, operator=None, extra=None):
    cfg = make_cfg(tmp_path, devices, monkeypatch)
    mqtt, ha = FakeMqtt(), FakeHA({**ENTITIES, **(extra or {})})
    z2m = FakeZ2M(mqtt)
    tuya, ours = TuyaHASide(cfg, ha), Z2MSide(cfg, mqtt)
    await ours.start(cfg.pairs)
    await tuya.start(cfg.pairs)
    tuya.suspect_window_s = 0.2      # окно сомнения под масштаб теста
    store = Store(cfg.db_path)
    bench = Bench(cfg, [tuya, ours], store, operator or ScriptedOperator())
    return cfg, ha, z2m, store, bench


async def _sensor_feed(ha, z2m, period, stop):
    i = 0
    while not stop.is_set():
        i += 1
        z2m.publish_state("temp", {"temperature": 20 + i / 10})
        ha.device_push("sensor.temp", {"1": 200 + i})
        await asyncio.sleep(period)


def test_scenario1_and_report(tmp_path, monkeypatch):
    async def go():
        cfg, ha, z2m, store, bench = await _bench(
            tmp_path, monkeypatch, [actuator("lamp"), actuator("plug"), sensor("temp", 0.1)])
        ha.behavior["switch.plug"] = "silent"       # HA показывает «вкл», устройство молчит
        stop = asyncio.Event()
        feed = asyncio.create_task(_sensor_feed(ha, z2m, 0.1, stop))
        await s1_normal(bench, duration_s=1.2)
        stop.set()
        await feed
        return cfg, store

    cfg, store = asyncio.run(go())
    rows = store.db.execute("SELECT side, device, status FROM commands").fetchall()
    by = {}
    for r in rows:
        by.setdefault((r["side"], r["device"]), []).append(r["status"])
    assert set(by[("tuya", "plug")]) == {"timeout"}
    assert set(by[("tuya", "lamp")]) == {"confirmed"}
    assert set(by[("ours", "plug")]) == {"confirmed"}
    assert len(by[("ours", "lamp")]) >= 3

    table, notes = report.build(store, {"temp": 0.1})
    cells = {row[0]: row[1:] for row in table}
    tuya_deliv, ours_deliv = cells["Доставка команд, %"]
    assert tuya_deliv.startswith("50.0")
    assert ours_deliv.startswith("100.0")
    assert all(c != report.NO_DATA for c in cells["Задержка подтверждения, медиана, мс"])
    for cell in cells["Отчёты датчиков, %"]:
        assert float(cell.split()[0]) >= 80, cell
    assert cells["Возврат после отключения света, мин"] == [report.NO_DATA, report.NO_DATA]
    assert any("оптимистичная" in n for n in notes)
    assert any("dp_event" in n for n in notes)

    md_path, csv_path, md = report.write(store, {"temp": 0.1}, tmp_path / "out")
    assert "| Доставка команд, % | 50.0" in md
    with csv_path.open(encoding="utf-8-sig") as f:
        lines = list(csv.reader(f))
    assert lines[0] == ["Замер", "Хаб Tuya", "Наша сторона (Z2M)"] and len(lines) == 7


def test_scenario2_power_return(tmp_path, monkeypatch):
    async def go():
        state = {}

        def on_enter(text):
            loop = asyncio.get_running_loop()
            if "Выключите" in text:                 # свет погас: оба набора молчат
                ha.behavior["switch.lamp"] = "silent"
                z2m.behavior["lamp"] = "silent"
            elif "Включите" in text:                # свет дали: вернутся через 0,3 с
                def back():
                    ha.behavior["switch.lamp"] = "confirm"
                    z2m.behavior["lamp"] = "confirm"
                    state["feed"] = asyncio.create_task(_sensor_feed(ha, z2m, 0.1, stop))
                loop.call_later(0.3, back)

        stop = asyncio.Event()
        cfg, ha, z2m, store, bench = await _bench(
            tmp_path, monkeypatch, [actuator("lamp"), sensor("temp", 0.1)], ScriptedOperator(on_enter=on_enter))
        await s2_power(bench, outage_s=0.05, limit_s=3.0, probe_s=0.2)
        stop.set()
        await state["feed"]
        return store

    store = asyncio.run(go())
    backs = {(r["side"], r["device"]): r["back_after_s"] for r in store.db.execute("SELECT * FROM recoveries")}
    assert len(backs) == 4
    for key, back in backs.items():
        assert back is not None and 0.25 <= back < 1.5, (key, back)
    table, _ = report.build(store, {"temp": 0.1})
    power = {row[0]: row[1:] for row in table}["Возврат после отключения света, мин"]
    assert power == ["0.0 (2 из 2)", "0.0 (2 из 2)"]


def test_scenario3_far_devices(tmp_path, monkeypatch):
    async def go():
        def on_enter(text):
            if "Выдерните" in text:              # у нас дальний пропал, через 0,5 с сеть перестроилась
                z2m.behavior["far"] = "silent"
                asyncio.get_running_loop().call_later(0.5, z2m.behavior.update, {"far": "confirm"})

        cfg, ha, z2m, store, bench = await _bench(
            tmp_path, monkeypatch, [actuator("lamp"), actuator("far", far=True)], ScriptedOperator(on_enter=on_enter),
            extra={"switch.far": ("devfar04", "1", "off")})
        await s3_repeater(bench, duration_s=1.5)
        return store

    store = asyncio.run(go())
    devices = {r["device"] for r in store.db.execute("SELECT device FROM commands")}
    assert devices == {"far"}                                   # только дальние
    backs = {r["side"]: r["back_after_s"] for r in store.db.execute("SELECT * FROM recoveries")}
    assert backs["tuya"] < 0.3                                  # у Tuya дошло сразу
    assert 0.4 <= backs["ours"] < 1.2                           # у нас - когда сеть перестроилась


def test_scenario7_lost_and_scenario8(tmp_path, monkeypatch):
    async def go():
        cfg, ha, z2m, store, bench = await _bench(
            tmp_path, monkeypatch, [actuator("lamp"), actuator("plug"), sensor("temp", 0.1)],
            ScriptedOperator(answers=["TS0601 _TZE284_test", "нет", "только батарея", "да", ""]))
        ha.behavior["switch.plug"] = "silent"
        await s7_week(bench, duration_s=0.8, probe_s=0.2, lost_after_s=0.5)
        await s8_new_model(bench)
        return store

    store = asyncio.run(go())
    table, _ = report.build(store, {"temp": 0.1})
    cells = {row[0]: row[1:] for row in table}
    # Tuya: plug молчит, датчик без отчётов; у нас тоже нет отчётов датчика.
    assert cells["Потеряно устройств за 7 суток"] == ["2 из 3", "1 из 3"]
    assert cells["Новая модель видна без ручного описания"] == ["нет (TS0601 _TZE284_test)", "да (TS0601 _TZE284_test)"]
    lost = {(r["side"], r["device"]): r["value"] for r in store.db.execute("SELECT * FROM observations WHERE key='lost'")}
    assert lost[("tuya", "plug")] == "1" and lost[("ours", "plug")] == "0"
