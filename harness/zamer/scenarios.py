"""Восемь сценариев стенда. Обе стороны всегда получают одно и то же одновременно."""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager

from .common import CONFIRMED, SUSPECT, CommandResult, Side, fmt_duration
from .report import SIDES, run_summary


class Bench:
    def __init__(self, cfg, sides: list[Side], store, operator, pairs=None) -> None:
        self.cfg = cfg
        self.sides = sides
        self.store = store
        self.op = operator
        self.pairs = list(pairs if pairs is not None else cfg.pairs)
        self.run_id: int | None = None
        self.last_ok: dict[tuple[str, str], float] = {}
        self.last_report: dict[tuple[str, str], float] = {}
        self._report_waiters: dict[tuple[str, str], asyncio.Future] = {}
        for side in sides:
            side.on_report = self._on_report
            side.on_availability = self._on_availability

    @property
    def actuators(self):
        return [p for p in self.pairs if p.type == "actuator"]

    @property
    def sensors(self):
        return [p for p in self.pairs if p.type == "sensor"]

    # --- приём событий сторон -------------------------------------------------

    def _on_report(self, side: str, device: str, wall: float) -> None:
        now = asyncio.get_running_loop().time()
        self.last_report[(side, device)] = now
        if self.cfg.pair(device).type != "sensor":
            return
        if self.run_id is not None:
            self.store.add_report(self.run_id, side, device, wall)
        fut = self._report_waiters.pop((side, device), None)
        if fut is not None and not fut.done():
            fut.set_result(now)

    def _on_availability(self, side: str, device: str, wall: float, online: bool) -> None:
        if self.run_id is not None:
            self.store.add_availability(self.run_id, side, device, wall, online)

    # --- кирпичики ---------------------------------------------------------------

    @asynccontextmanager
    async def run(self, scenario: int, conditions: str = ""):
        self.run_id = self.store.start_run(scenario, conditions, self.cfg.ha.confirm)
        note = ""
        baseline = {s.name: dict(getattr(s, "counters", {})) for s in self.sides}
        try:
            yield self.run_id
        except BaseException:
            note = "прервано"
            raise
        finally:
            for side in self.sides:
                counts = getattr(side, "counters", {})
                delta = {k: v - baseline.get(side.name, {}).get(k, 0) for k, v in counts.items()}
                if delta:
                    self.store.add_observation(self.run_id, side.name, "*", "diagnostic_counters", json.dumps(delta, sort_keys=True),
                                               "API/MQTT counts, не количество радиокадров")
            self.store.finish_run(self.run_id, note)
            self.op.say(f"\nИтог прогона №{self.run_id} (сценарий {scenario}){' - ' + note if note else ''}:")
            for line in run_summary(self.store, self.run_id):
                self.op.say("  " + line)
            self.run_id = None

    async def command(self, side: Side, pair) -> tuple[CommandResult, float]:
        loop = asyncio.get_running_loop()
        on = side.next_on(pair)
        sent_wall, sent = time.time(), loop.time()
        result = await side.turn(pair, on)
        if self.run_id is not None:
            self.store.add_command(self.run_id, side.name, pair.name, "on" if on else "off", sent_wall, result)
        if result.status == CONFIRMED:
            self.last_ok[(side.name, pair.name)] = sent + result.latency_ms / 1000
        return result, sent

    async def warmup(self, pairs) -> None:
        """Одна команда каждому без записи: узнать, в каком состоянии устройство.

        Чередуем значения от последнего сообщённого устройством, и пока оно
        неизвестно, первая команда может совпасть с текущим состоянием.
        """
        if pairs:
            self.op.say("Прогрев: по одной команде каждому исполнительному устройству (в счёт не идёт)...")
            await asyncio.gather(*(side.turn(p, side.next_on(p)) for side in self.sides for p in pairs))

    async def load(self, pairs, duration_s: float, interval_s: float) -> None:
        """Команда каждому устройству раз в interval_s на обеих сторонах сразу.

        Устройства разнесены по интервалу равномерно, чтобы не слать пачкой:
        в живом доме команды не приходят все в одну миллисекунду.
        """
        loop = asyncio.get_running_loop()
        end = loop.time() + duration_s

        async def drive(side: Side, pair, offset: float) -> None:
            await asyncio.sleep(offset)
            nxt = loop.time()
            while loop.time() < end:
                await self.command(side, pair)
                nxt += interval_s
                await asyncio.sleep(max(0.0, nxt - loop.time()))

        n = max(1, len(pairs))
        await asyncio.gather(
            *(drive(side, p, i * interval_s / n) for side in self.sides for i, p in enumerate(pairs)),
            self._ticker(duration_s),
        )

    async def _ticker(self, duration_s: float) -> None:
        step = max(60.0, duration_s / 24)
        if duration_s <= step:
            return
        passed = 0.0
        while passed + step < duration_s:
            await asyncio.sleep(step)
            passed += step
            self.op.say(f"  ... прошло {fmt_duration(passed)} из {fmt_duration(duration_s)}")

    async def countdown(self, seconds: float, what: str) -> None:
        step = 60.0 if seconds > 120 else max(1.0, seconds / 4)
        left = seconds
        while left > 0:
            self.op.say(f"  {what}: осталось {fmt_duration(left)}")
            await asyncio.sleep(min(step, left))
            left -= step

    async def recover(self, pairs, limit_s: float, probe_s: float) -> dict[tuple[str, str], float | None]:
        """Через сколько секунд от этой минуты каждое устройство подало признак жизни.

        Исполнительное - подтверждённая команда (пробуем раз в probe_s),
        датчик - первый отчёт. Признак «в сети» не берём: Z2M и интеграция
        считают его по-разному, а ответ на команду - одинаково.
        """
        loop = asyncio.get_running_loop()
        start = loop.time()
        deadline = start + limit_s

        async def actuator(side: Side, pair):
            while loop.time() < deadline:
                result, sent = await self.command(side, pair)
                if result.status == CONFIRMED:
                    return sent + result.latency_ms / 1000 - start
                if result.status == SUSPECT:
                    # Ответ мог прийти из кэша хаба - переспросим, как только
                    # окно сомнения закроется, а не через целый интервал проб.
                    wait = side.hold_s(pair) + 0.1
                else:
                    wait = sent + probe_s - loop.time()
                await asyncio.sleep(max(0.0, min(wait, deadline - loop.time())))
            return None

        async def sensor(side: Side, pair):
            fut = loop.create_future()
            self._report_waiters[(side.name, pair.name)] = fut
            try:
                return await asyncio.wait_for(fut, max(0.0, deadline - loop.time())) - start
            except asyncio.TimeoutError:
                return None
            finally:
                self._report_waiters.pop((side.name, pair.name), None)

        jobs = [(side, p) for side in self.sides for p in pairs]
        backs = await asyncio.gather(*((actuator if p.type == "actuator" else sensor)(side, p) for side, p in jobs))
        result = {}
        for (side, pair), back in zip(jobs, backs):
            result[(side.name, pair.name)] = back
            self.store.add_recovery(self.run_id, side.name, pair.name, back, limit_s)
        for side_name, title in SIDES:
            mine = [b for (s, _), b in result.items() if s == side_name]
            if mine and all(b is not None for b in mine):
                self.op.say(f"  {title}: заработали все {len(mine)} через {fmt_duration(max(mine))}")
            elif mine:
                self.op.say(f"  {title}: вернулось {sum(b is not None for b in mine)} из {len(mine)} за {fmt_duration(limit_s)}")
        return result


# --- сценарии -------------------------------------------------------------------


async def s1_normal(bench: Bench, duration_s: float = 24 * 3600, **_) -> None:
    await bench.warmup(bench.actuators)
    bench.op.say(f"Сценарий 1 «обычная работа»: {fmt_duration(duration_s)}, команда каждому раз в {bench.cfg.command_interval_s:.0f} с.")
    async with bench.run(1):
        await bench.load(bench.actuators, duration_s, bench.cfg.command_interval_s)


async def s2_power(bench: Bench, outage_s: float = 300, limit_s: float = 1800, probe_s: float = 15, **_) -> None:
    async with bench.run(2):
        await bench.op.wait_enter(
            "Сценарий 2 «отключение света». Выключите сетевой фильтр, от которого питаются устройства ОБОИХ "
            "наборов. Компьютер стенда, брокер MQTT и Home Assistant должны остаться под питанием."
        )
        await bench.countdown(outage_s, "свет выключен")
        await bench.op.wait_enter("Включите фильтр обратно. Отсчёт времени возврата пойдёт с этого Enter.")
        await bench.recover(bench.pairs, limit_s, probe_s)


async def s3_repeater(bench: Bench, duration_s: float = 900, **_) -> None:
    far = [p for p in bench.actuators if p.far]
    if not far:
        raise ValueError("в конфиге нет дальних исполнительных устройств (far: true)")
    await bench.warmup(far)
    async with bench.run(3) as run_id:
        await bench.op.wait_enter(
            "Сценарий 3 «убрали повторитель». Выдерните из розетки повторитель, через который идут дальние "
            "устройства, на ОБОИХ наборах. Отсчёт пойдёт с этого Enter."
        )
        t0 = time.time()
        await bench.load(far, duration_s, bench.cfg.command_interval_s)
        # «Через сколько» - первая подтверждённая команда после выдёргивания.
        for side in bench.sides:
            for pair in far:
                row = bench.store.db.execute(
                    "SELECT sent_at, latency_ms FROM commands WHERE run_id=? AND side=? AND device=? "
                    "AND status='confirmed' ORDER BY sent_at LIMIT 1",
                    (run_id, side.name, pair.name),
                ).fetchone()
                back = None if row is None else row["sent_at"] + row["latency_ms"] / 1000 - t0
                bench.store.add_recovery(run_id, side.name, pair.name, back, duration_s)
        await bench.op.wait_enter("Верните повторитель в розетку.")


async def s4_wifi(bench: Bench, duration_s: float = 1800, **_) -> None:
    conditions = await bench.op.ask("Сценарий 4 «шум Wi-Fi». Опишите условия (что включено, где стоит, каналы):")
    await bench.warmup(bench.actuators)
    async with bench.run(4, conditions):
        await bench.load(bench.actuators, duration_s, bench.cfg.command_interval_s)


async def s5_moved(bench: Bench, limit_s: float = 7200, **_) -> None:
    sensors = bench.sensors
    if not sensors:
        raise ValueError("в выборке нет датчиков")
    async with bench.run(5):
        await bench.op.wait_enter(
            "Сценарий 5 «подключили рядом, унесли». Датчики обоих наборов подключены рядом с координатором и "
            "хабом. Отнесите их на постоянное дальнее место. Отсчёт пойдёт с этого Enter."
        )
        await bench.recover(sensors, limit_s, probe_s=limit_s)


async def s6_restart(bench: Bench, limit_s: float = 3600, probe_s: float = 15, **_) -> None:
    async with bench.run(6):
        await bench.op.wait_enter(
            "Сценарий 6 «перезапуск». Перезапустите одновременно координатор SLZB-06M вместе с Z2M и хаб Tuya "
            "(питание хаба выдернуть на 10 с). Отсчёт пойдёт с этого Enter."
        )
        await bench.recover(bench.pairs, limit_s, probe_s)


async def s7_week(bench: Bench, duration_s: float = 7 * 86400, probe_s: float = 1800, lost_after_s: float = 7200, **_) -> None:
    loop = asyncio.get_running_loop()
    await bench.warmup(bench.actuators)
    bench.op.say(f"Сценарий 7 «неделя без вмешательства»: {fmt_duration(duration_s)}, проба раз в {fmt_duration(probe_s)}.")
    async with bench.run(7) as run_id:
        start = loop.time()
        await bench.load(bench.actuators, duration_s, probe_s)
        now = loop.time()
        for side in bench.sides:
            for pair in bench.pairs:
                if pair.type == "actuator":
                    last, window = bench.last_ok.get((side.name, pair.name)), lost_after_s
                else:
                    last, window = bench.last_report.get((side.name, pair.name)), max(lost_after_s, 3 * pair.report_interval_s)
                lost = last is None or last < start or now - last > window
                note = "ни разу за прогон" if last is None or last < start else f"последний ответ {fmt_duration(now - last)} назад"
                bench.store.add_observation(run_id, side.name, pair.name, "lost", "1" if lost else "0", note)


async def s8_new_model(bench: Bench, **_) -> None:
    async with bench.run(8) as run_id:
        model = await bench.op.ask("Сценарий 8 «новая модель». Модель нового устройства (как в Z2M / на коробке):")
        for side, title in SIDES:
            ans = await bench.op.ask(
                f"{title}: данные новой модели видны без ручного описания? (д/н)"
                + ("\n    Подсказка: в Z2M «Поддерживается» и без внешнего конвертера = да." if side == "ours" else "")
            )
            visible = "да" if ans.lower().startswith(("д", "y")) else "нет"
            note = await bench.op.ask(f"{title}: что видно, чего не хватает (можно пусто):")
            bench.store.add_observation(run_id, side, model or "?", "new_model_visible", visible, note)


SCENARIOS = {
    1: (s1_normal, "обычная работа: команды раз в 10 с + отчёты датчиков (сутки)"),
    2: (s2_power, "отключение света на 5 мин -> время возврата каждого устройства"),
    3: (s3_repeater, "убрали повторитель -> доходят ли команды до дальних и через сколько"),
    4: (s4_wifi, "шум Wi-Fi: как 1, коротко, с отметкой условий"),
    5: (s5_moved, "подключили рядом, унесли -> вернулся ли датчик и через сколько"),
    6: (s6_restart, "перезапуск координатора/Z2M и хаба -> пока заработают все"),
    7: (s7_week, "неделя без вмешательства -> сколько устройств пропало"),
    8: (s8_new_model, "новая модель -> видны ли данные (наблюдение оператора)"),
}
