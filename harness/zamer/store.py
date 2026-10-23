"""Одна база SQLite на все сценарии: прогоны, команды, отчёты, возвраты, наблюдения."""
from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from .common import CommandResult

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(
    id INTEGER PRIMARY KEY,
    scenario INTEGER NOT NULL,
    started_at REAL NOT NULL,
    finished_at REAL,
    conditions TEXT NOT NULL DEFAULT '',
    tuya_mode TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS commands(
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    side TEXT NOT NULL,
    device TEXT NOT NULL,
    value TEXT NOT NULL,
    sent_at REAL NOT NULL,
    status TEXT NOT NULL,
    latency_ms REAL,
    optimistic_ms REAL,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS reports(
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    side TEXT NOT NULL,
    device TEXT NOT NULL,
    ts REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS availability(
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    side TEXT NOT NULL,
    device TEXT NOT NULL,
    ts REAL NOT NULL,
    online INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recoveries(
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    side TEXT NOT NULL,
    device TEXT NOT NULL,
    back_after_s REAL,          -- NULL: не вернулось за limit_s
    limit_s REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS observations(
    id INTEGER PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES runs(id),
    side TEXT NOT NULL,
    device TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS commands_run ON commands(run_id, side);
CREATE INDEX IF NOT EXISTS reports_run ON reports(run_id, side, device);
"""


class Store:
    def __init__(self, path: str | Path) -> None:
        path = Path(path)
        if str(path) != ":memory:":
            path.parent.mkdir(parents=True, exist_ok=True)
        # autocommit: прогон на сутки и неделю не должен терять данные при обрыве.
        self.db = sqlite3.connect(str(path), isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def close(self) -> None:
        self.db.close()

    def start_run(self, scenario: int, conditions: str = "", tuya_mode: str = "", started_at: float | None = None) -> int:
        cur = self.db.execute(
            "INSERT INTO runs(scenario, started_at, conditions, tuya_mode) VALUES (?,?,?,?)",
            (scenario, started_at or time.time(), conditions, tuya_mode),
        )
        return int(cur.lastrowid)

    def finish_run(self, run_id: int, note: str = "", finished_at: float | None = None) -> None:
        self.db.execute(
            "UPDATE runs SET finished_at=?, note=? WHERE id=?", (finished_at or time.time(), note, run_id)
        )

    def add_command(self, run_id: int, side: str, device: str, value: str, sent_at: float, r: CommandResult) -> None:
        self.db.execute(
            "INSERT INTO commands(run_id, side, device, value, sent_at, status, latency_ms, optimistic_ms, detail)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            (run_id, side, device, value, sent_at, r.status, r.latency_ms, r.optimistic_ms, r.detail),
        )

    def add_report(self, run_id: int, side: str, device: str, ts: float) -> None:
        self.db.execute("INSERT INTO reports(run_id, side, device, ts) VALUES (?,?,?,?)", (run_id, side, device, ts))

    def add_availability(self, run_id: int, side: str, device: str, ts: float, online: bool) -> None:
        self.db.execute(
            "INSERT INTO availability(run_id, side, device, ts, online) VALUES (?,?,?,?,?)",
            (run_id, side, device, ts, int(online)),
        )

    def add_recovery(self, run_id: int, side: str, device: str, back_after_s: float | None, limit_s: float) -> None:
        self.db.execute(
            "INSERT INTO recoveries(run_id, side, device, back_after_s, limit_s) VALUES (?,?,?,?,?)",
            (run_id, side, device, back_after_s, limit_s),
        )

    def add_observation(self, run_id: int, side: str, device: str, key: str, value: str, note: str = "") -> None:
        self.db.execute(
            "INSERT INTO observations(run_id, side, device, key, value, note) VALUES (?,?,?,?,?,?)",
            (run_id, side, device, key, value, note),
        )

    def latest_run(self, scenario: int) -> sqlite3.Row | None:
        # Берём последний ЗАВЕРШЁННЫЙ прогон: прерванный тоже завершён, но с пометкой.
        return self.db.execute(
            "SELECT * FROM runs WHERE scenario=? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1", (scenario,)
        ).fetchone()
