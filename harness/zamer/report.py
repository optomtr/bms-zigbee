"""Отчёт: одна таблица (Markdown и CSV), обе стороны рядом по шести замерам."""
from __future__ import annotations

import csv
import time
from pathlib import Path

from . import metrics
from .common import NO_LINK, SUSPECT, fmt_duration
from .store import Store

SIDES = (("tuya", "Хаб Tuya"), ("ours", "Наша сторона (Z2M)"))
ROWS = (
    ("delivery", "Доставка команд, %"),
    ("latency", "Задержка подтверждения, медиана, мс"),
    ("sensors", "Отчёты датчиков, %"),
    ("power", "Возврат после отключения света, мин"),
    ("lost", "Потеряно устройств за 7 суток"),
    ("new_model", "Новая модель видна без ручного описания"),
)
NO_DATA = "нет данных"


def _when(ts: float | None) -> str:
    return time.strftime("%d.%m.%Y %H:%M", time.localtime(ts)) if ts else "?"


def _commands(store: Store, run_id: int, side: str):
    return store.db.execute("SELECT * FROM commands WHERE run_id=? AND side=?", (run_id, side)).fetchall()


def delivery_cells(store: Store, run_id: int, side: str) -> tuple[str, str]:
    rows = _commands(store, run_id, side)
    pct, n = metrics.delivery(r["status"] for r in rows)
    med = metrics.median(r["latency_ms"] for r in rows if r["status"] == "confirmed")
    return (
        NO_DATA if pct is None else f"{pct:.1f} (n={n})",
        NO_DATA if med is None else f"{med:.0f}",
    )


def sensor_cell(store: Store, run, side: str, intervals: dict[str, float]) -> str:
    got_total = exp_total = 0
    for device, interval in intervals.items():
        times = [
            r["ts"]
            for r in store.db.execute(
                "SELECT ts FROM reports WHERE run_id=? AND side=? AND device=?", (run["id"], side, device)
            )
        ]
        got, expected = metrics.sensor_reports(times, run["started_at"], run["finished_at"], interval)
        got_total += got
        exp_total += expected
    if not exp_total:
        return NO_DATA
    return f"{100.0 * got_total / exp_total:.1f} ({got_total} из {exp_total})"


def recovery_cell(store: Store, run_id: int, side: str) -> str:
    rows = store.db.execute(
        "SELECT back_after_s, limit_s FROM recoveries WHERE run_id=? AND side=?", (run_id, side)
    ).fetchall()
    if not rows:
        return NO_DATA
    worst, returned, total = metrics.recovery([r["back_after_s"] for r in rows])
    if returned < total:
        return f"не все за {fmt_duration(max(r['limit_s'] for r in rows))}: вернулось {returned} из {total}"
    return f"{worst / 60:.1f} ({returned} из {total})"


def lost_cell(store: Store, run_id: int, side: str) -> str:
    rows = store.db.execute(
        "SELECT value FROM observations WHERE run_id=? AND side=? AND key='lost'", (run_id, side)
    ).fetchall()
    if not rows:
        return NO_DATA
    return f"{sum(1 for r in rows if r['value'] == '1')} из {len(rows)}"


def new_model_cell(store: Store, run_id: int, side: str) -> str:
    rows = store.db.execute(
        "SELECT device, value FROM observations WHERE run_id=? AND side=? AND key='new_model_visible' ORDER BY id",
        (run_id, side),
    ).fetchall()
    if not rows:
        return NO_DATA
    return "; ".join(f"{r['value']} ({r['device']})" for r in rows)


def build(store: Store, intervals: dict[str, float]) -> tuple[list[list[str]], list[str]]:
    """Строки таблицы [замер, tuya, ours] и примечания под ней."""
    cells = {key: {side: NO_DATA for side, _ in SIDES} for key, _ in ROWS}
    notes: list[str] = []
    run1 = store.latest_run(1)
    if run1:
        for side, _ in SIDES:
            cells["delivery"][side], cells["latency"][side] = delivery_cells(store, run1["id"], side)
            cells["sensors"][side] = sensor_cell(store, run1, side, intervals)
        notes.append(
            f"Сценарий 1: прогон №{run1['id']}, {_when(run1['started_at'])} – {_when(run1['finished_at'])}, "
            f"режим подтверждения Tuya: {run1['tuya_mode']}" + (f", {run1['note']}" if run1["note"] else "")
        )
        excluded = []
        for side, title in SIDES:
            rows = _commands(store, run1["id"], side)
            sus = sum(1 for r in rows if r["status"] == SUSPECT)
            nol = sum(1 for r in rows if r["status"] == NO_LINK)
            if sus or nol:
                excluded.append(f"{title}: под подозрением (кэш хаба) {sus}, нет связи со стендом {nol}")
            opt = metrics.median(r["optimistic_ms"] for r in rows)
            if side == "tuya" and opt is not None:
                notes.append(
                    f"Показ в HA менялся через {opt:.0f} мс (медиана) после команды - это оптимистичная "
                    "запись интеграции, а не ответ устройства; в задержку не входит."
                )
        if excluded:
            notes.append("Не в счёте доставки: " + "; ".join(excluded) + ".")
        if run1["tuya_mode"] == "dp_event":
            notes.append(
                "Режим dp_event: посылки шлюза с несколькими точками данных не видны, поэтому доставка и "
                "отчёты датчиков Tuya - нижняя оценка. Точнее - режим push_event (правка интеграции, см. README)."
            )
    for scenario, key, fn in ((2, "power", recovery_cell), (7, "lost", lost_cell), (8, "new_model", new_model_cell)):
        run = store.latest_run(scenario)
        if run:
            for side, _ in SIDES:
                cells[key][side] = fn(store, run["id"], side)
            notes.append(f"Сценарий {scenario}: прогон №{run['id']}, {_when(run['started_at'])}")
    table = [[title] + [cells[key][side] for side, _ in SIDES] for key, title in ROWS]
    return table, notes


def to_markdown(table: list[list[str]], notes: list[str]) -> str:
    header = ["Замер"] + [title for _, title in SIDES]
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join(row) + " |" for row in table]
    if notes:
        lines.append("")
        lines += [f"- {n}" for n in notes]
    return "\n".join(lines) + "\n"


def write(store: Store, intervals: dict[str, float], out_dir: Path) -> tuple[Path, Path, str]:
    table, notes = build(store, intervals)
    out_dir.mkdir(parents=True, exist_ok=True)
    md = to_markdown(table, notes)
    md_path = out_dir / "report.md"
    md_path.write_text(md, encoding="utf-8")
    csv_path = out_dir / "report.csv"
    # utf-8-sig: Excel иначе показывает кириллицу кракозябрами.
    with csv_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Замер"] + [title for _, title in SIDES])
        w.writerows(table)
    return md_path, csv_path, md


def run_summary(store: Store, run_id: int) -> list[str]:
    """Короткий итог прогона для консоли - чтобы оператор видел результат сразу."""
    lines = []
    for side, title in SIDES:
        rows = _commands(store, run_id, side)
        if rows:
            deliv, lat = delivery_cells(store, run_id, side)
            lines.append(f"{title}: доставка {deliv} %, медиана {lat} мс")
            by_dev: dict[str, list] = {}
            for r in rows:
                by_dev.setdefault(r["device"], []).append(r)
            for dev, items in sorted(by_dev.items()):
                pct, n = metrics.delivery(r["status"] for r in items)
                lines.append(f"  {dev}: доставка {'-' if pct is None else f'{pct:.0f}'} % (n={n})")
        for r in store.db.execute(
            "SELECT device, back_after_s FROM recoveries WHERE run_id=? AND side=? ORDER BY device", (run_id, side)
        ):
            back = "не вернулось" if r["back_after_s"] is None else f"через {fmt_duration(r['back_after_s'])}"
            lines.append(f"{title}: {r['device']} - {back}")
        for r in store.db.execute(
            "SELECT device, key, value, note FROM observations WHERE run_id=? AND side=? ORDER BY id", (run_id, side)
        ):
            lines.append(f"{title}: {r['device']} {r['key']}={r['value']} {r['note']}".rstrip())
    return lines
