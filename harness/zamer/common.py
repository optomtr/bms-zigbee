"""Общее для обеих сторон: итог команды, ожидание подтверждения, интерфейс стороны."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

# Итоги команды. В процент доставки идут только CONFIRMED / FAILED / TIMEOUT:
# NO_LINK - это поломка самого стенда (нет связи с брокером или HA), а не
# устройства; SUSPECT - «подтверждение», которое могло прийти из кэша хаба.
CONFIRMED = "confirmed"
FAILED = "failed"
TIMEOUT = "timeout"
NO_LINK = "no_link"
SUSPECT = "suspect"
COUNTED = (CONFIRMED, FAILED, TIMEOUT)


@dataclass
class CommandResult:
    status: str
    latency_ms: float | None = None
    detail: str = ""
    # Когда интерфейс (HA) показал новое состояние - только для справки,
    # подтверждением это не считается никогда.
    optimistic_ms: float | None = None


class Pending:
    """Одна команда в ожидании подтверждения от устройства."""

    def __init__(self, expected: Any, t0: float):
        self.expected = expected
        self.t0 = t0
        self.future: asyncio.Future = asyncio.get_running_loop().create_future()
        self.optimistic_ms: float | None = None
        self.note = ""
        # Для стороны Tuya: что показывал HA до команды и что покажет после.
        self.ha_before: str | None = None
        self.ha_expected: str | None = None

    def resolve(self, result: CommandResult) -> None:
        # Первый итог окончательный: поздний отказ не отменяет подтверждения.
        if not self.future.done():
            if result.optimistic_ms is None:
                result.optimistic_ms = self.optimistic_ms
            self.future.set_result(result)

    def confirm(self, now: float, status: str = CONFIRMED, detail: str = "") -> None:
        self.resolve(CommandResult(status, latency_ms=(now - self.t0) * 1000, detail=detail or self.note))

    def fail(self, detail: str) -> None:
        self.resolve(CommandResult(FAILED, detail=detail))

    async def wait(self, timeout: float) -> CommandResult:
        try:
            return await asyncio.wait_for(asyncio.shield(self.future), timeout)
        except asyncio.TimeoutError:
            return CommandResult(TIMEOUT, detail=self.note, optimistic_ms=self.optimistic_ms)


def fmt_duration(seconds: float) -> str:
    """Длительность для человека: 45 с, 12.5 мин, 24.0 ч."""
    if seconds < 120:
        return f"{seconds:.0f} с"
    if seconds < 7200:
        return f"{seconds / 60:.1f} мин"
    return f"{seconds / 3600:.1f} ч"


ReportCallback = Callable[[str, str, float], None]          # сторона, устройство, время
AvailabilityCallback = Callable[[str, str, float, bool], None]


class Side:
    """Общий интерфейс стороны стенда: хаб Tuya через HA или наш Z2M через MQTT."""

    name = "?"

    def __init__(self) -> None:
        self.on_report: ReportCallback | None = None
        self.on_availability: AvailabilityCallback | None = None
        # Последнее значение, которое сообщило само устройство (не интерфейс).
        self.last_value: dict[str, Any] = {}

    async def start(self, pairs) -> None:
        raise NotImplementedError

    async def close(self) -> None:
        raise NotImplementedError

    async def turn(self, pair, on: bool) -> CommandResult:
        raise NotImplementedError

    def device_value(self, pair, on: bool):
        raise NotImplementedError

    def hold_s(self, pair) -> float:
        """Сколько ещё ждать, пока подтверждению от устройства снова можно верить."""
        return 0.0

    def next_on(self, pair) -> bool:
        """Всегда командуем противоположное тому, что устройство сообщило последним.

        Иначе «подтверждением» станет любое постороннее сообщение, в котором
        случайно лежит то же значение (Z2M кладёт в каждую публикацию весь
        закэшированный state).
        """
        return self.last_value.get(pair.name) != self.device_value(pair, True)

    def _report(self, device: str, ts: float) -> None:
        if self.on_report:
            self.on_report(self.name, device, ts)

    def _availability(self, device: str, ts: float, online: bool) -> None:
        if self.on_availability:
            self.on_availability(self.name, device, ts, online)
