"""Расчёт замеров. Чистые функции - их и проверяют тесты."""
from __future__ import annotations

import math
import statistics
from typing import Iterable

from .common import CONFIRMED, COUNTED


def delivery(statuses: Iterable[str]) -> tuple[float | None, int]:
    """Доля подтверждённых команд, % и число команд в счёте.

    В счёт идут подтверждено / отказ / таймаут. «Нет связи со стендом» и
    «под подозрением» (ответ мог прийти из кэша хаба) не идут ни в числитель,
    ни в знаменатель - они не говорят ничего об устройстве.
    """
    counted = [s for s in statuses if s in COUNTED]
    if not counted:
        return None, 0
    ok = sum(1 for s in counted if s == CONFIRMED)
    return 100.0 * ok / len(counted), len(counted)


def median(values: Iterable[float | None]) -> float | None:
    vals = [v for v in values if v is not None]
    return statistics.median(vals) if vals else None


# Разброс времени отчёта, который пропуском не считаем: промежуток до 1,75
# интервала - ещё не пропуск, ровно 2 интервала - один пропуск, 3 - два.
JITTER = 0.75


def sensor_reports(times: Iterable[float], start: float, end: float, interval: float) -> tuple[int, int]:
    """Сколько отчётов пришло из ожидаемых за окно: (пришло, ожидалось).

    Ожидается round(длительность / интервал). Пропуски ищем по промежуткам
    (от начала окна до первого отчёта, между соседними, от последнего до
    конца): длиннее 1,75 интервала - пропал один, дальше по одному на каждый
    целый интервал. Так разброс времени не считается потерей. И не больше,
    чем отчётов реально пришло: иначе датчик, шлющий вдвое реже, но ровно,
    выглядел бы безупречным. Лишние отчёты (по изменению) процент не раздувают.
    """
    expected = math.floor((end - start) / interval + 0.5)
    if expected < 1:
        return 0, 0
    ts = sorted(t for t in times if start <= t <= end)
    points = [start] + ts + [end]
    missed = sum(max(0, math.floor((b - a) / interval - JITTER)) for a, b in zip(points, points[1:]))
    return max(0, min(expected - missed, len(ts))), expected


def recovery(backs: list[float | None]) -> tuple[float | None, int, int]:
    """(время, когда вернулись все вернувшиеся, с; вернулось; всего)."""
    returned = [b for b in backs if b is not None]
    return (max(returned) if returned else None), len(returned), len(backs)
