"""Запуск: python -m zamer {check|run N|report|scenarios} [-c config.yaml]."""
from __future__ import annotations

import argparse
import asyncio
import re
import sys
from pathlib import Path

from . import config as config_mod
from .ha_ws import HAWebSocket
from .operator import ConsoleOperator
from .report import write
from .scenarios import SCENARIOS, Bench
from .store import Store
from .tuya_ha import TuyaHASide
from .z2m import PahoTransport, Z2MSide

UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_duration(text: str) -> float:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*", text)
    if not m:
        raise argparse.ArgumentTypeError(f"не понял длительность {text!r}: примеры 90s, 30m, 24h, 7d")
    return float(m[1]) * UNITS[m[2] or "s"]


async def open_sides(cfg):
    ours = Z2MSide(cfg, PahoTransport(cfg.mqtt))
    tuya = TuyaHASide(cfg, HAWebSocket(cfg.ha.url, cfg.ha.token))
    await ours.start(cfg.pairs)
    await tuya.start(cfg.pairs)
    problems = await ours.check_setup()
    return [tuya, ours], problems


async def close_sides(sides) -> None:
    for side in sides:
        await side.close()


async def cmd_check(cfg) -> int:
    sides, problems = await open_sides(cfg)
    tuya, ours = sides
    try:
        await asyncio.sleep(3)  # дать прийти сообщениям устройств
        print(f"Режим подтверждения Tuya: {cfg.ha.confirm}")
        for p in cfg.pairs:
            print(
                f"- {p.name} ({p.type}): Tuya {p.tuya_entity} -> устройство {p.tuya_device_id}, dp {p.tuya_dp}, "
                f"HA показывает {tuya.ha_state.get(p.tuya_entity)!r}; Z2M {p.ours} -> {ours.last_value.get(p.name)!r}"
            )
        if problems:
            print("\nНАСТРОЙКИ Z2M НЕ ГОДЯТСЯ ДЛЯ ЗАМЕРА:")
            for line in problems:
                print("  - " + line)
            return 2
        print("\nНастройки годятся.")
        return 0
    finally:
        await close_sides(sides)


async def cmd_run(cfg, number: int, kwargs: dict, devices: list[str] | None) -> int:
    fn, _ = SCENARIOS[number]
    try:
        pairs = cfg.pairs if not devices else [cfg.pair(d) for d in devices]
    except KeyError as ex:
        print(f"В конфиге нет пары {ex}")
        return 2
    sides, problems = await open_sides(cfg)
    try:
        if problems:
            print("Замер не начат - настройки Z2M не годятся:")
            for line in problems:
                print("  - " + line)
            return 2
        store = Store(cfg.db_path)
        try:
            await fn(Bench(cfg, sides, store, ConsoleOperator(), pairs), **kwargs)
        finally:
            store.close()
        print(f"\nДанные в {cfg.db_path}. Таблица: python -m zamer report")
        return 0
    finally:
        await close_sides(sides)


def cmd_report(cfg, out: Path) -> int:
    store = Store(cfg.db_path)
    try:
        intervals = {p.name: p.report_interval_s for p in cfg.sensors}
        md_path, csv_path, md = write(store, intervals, out)
    finally:
        store.close()
    print(md)
    print(f"Сохранено: {md_path}, {csv_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m zamer", description="Замерщик стенда: хаб Tuya против Z2M")
    ap.add_argument("-c", "--config", default="config.yaml", help="путь к конфигу (по умолчанию config.yaml)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("scenarios", help="список сценариев")
    sub.add_parser("check", help="подключиться к обеим сторонам и проверить настройки")
    run = sub.add_parser("run", help="прогнать сценарий")
    run.add_argument("number", type=int, choices=sorted(SCENARIOS))
    run.add_argument("--duration", type=parse_duration, help="длительность (сценарии 1, 3, 4, 7)")
    run.add_argument("--outage", type=parse_duration, help="сколько держать свет выключенным (сценарий 2)")
    run.add_argument("--limit", type=parse_duration, help="сколько ждать возврата (сценарии 2, 5, 6)")
    run.add_argument("--probe", type=parse_duration, help="как часто пробовать команду (2, 6, 7)")
    run.add_argument("--lost-after", type=parse_duration, help="молчит дольше - потеряно (сценарий 7)")
    run.add_argument("--devices", help="только эти пары, через запятую")
    rep = sub.add_parser("report", help="таблица Markdown + CSV по базе")
    rep.add_argument("--out", type=Path, help="папка для report.md и report.csv (по умолчанию рядом с базой)")
    args = ap.parse_args(argv)

    if args.cmd == "scenarios":
        for n, (_, text) in SCENARIOS.items():
            print(f"{n}. {text}")
        return 0
    try:
        cfg = config_mod.load(args.config)
    except (OSError, config_mod.ConfigError) as ex:
        print(f"Конфиг {args.config}: {ex}", file=sys.stderr)
        return 2
    if args.cmd == "report":
        return cmd_report(cfg, args.out or cfg.db_path.parent)
    try:
        if args.cmd == "check":
            return asyncio.run(cmd_check(cfg))
        names = {"duration": "duration_s", "outage": "outage_s", "limit": "limit_s", "probe": "probe_s",
                 "lost_after": "lost_after_s"}
        kwargs = {dst: getattr(args, src) for src, dst in names.items() if getattr(args, src) is not None}
        devices = [d.strip() for d in args.devices.split(",")] if args.devices else None
        return asyncio.run(cmd_run(cfg, args.number, kwargs, devices))
    except KeyboardInterrupt:
        print("\nПрервано. Сделанное сохранено в базе.")
        return 130
    except (OSError, ConnectionError, ValueError) as ex:
        # Нет связи с брокером / HA, неверный токен, сущность не найдена -
        # понятной строкой, без трассировки.
        print(f"Ошибка: {ex}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
