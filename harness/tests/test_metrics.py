"""Расчёт замеров."""
import pytest

from zamer import metrics
from zamer.common import CONFIRMED, FAILED, NO_LINK, SUSPECT, TIMEOUT


def test_delivery_counts_only_device_outcomes():
    statuses = [CONFIRMED] * 8 + [FAILED, TIMEOUT] + [NO_LINK, SUSPECT, SUSPECT]
    pct, n = metrics.delivery(statuses)
    assert n == 10
    assert pct == pytest.approx(80.0)


def test_delivery_empty():
    assert metrics.delivery([NO_LINK]) == (None, 0)


def test_median():
    assert metrics.median([300, None, 100, 200]) == 200
    assert metrics.median([None]) is None


def _series(start, end, step, offset):
    t, out = start + offset, []
    while t <= end:
        out.append(t)
        t += step
    return out


def test_sensor_reports_perfect():
    assert metrics.sensor_reports(_series(0, 100, 10, 5), 0, 100, 10) == (10, 10)


def test_sensor_reports_one_missing():
    ts = [t for t in _series(0, 100, 10, 5) if t != 45]
    assert metrics.sensor_reports(ts, 0, 100, 10) == (9, 10)


def test_sensor_reports_three_missing_in_a_row():
    ts = [t for t in _series(0, 100, 10, 5) if t not in (35, 45, 55)]
    assert metrics.sensor_reports(ts, 0, 100, 10) == (7, 10)


def test_sensor_reports_none():
    assert metrics.sensor_reports([], 0, 100, 10) == (0, 10)


def test_sensor_reports_only_first():
    assert metrics.sensor_reports([5], 0, 100, 10) == (1, 10)


def test_sensor_reports_extra_reports_do_not_inflate():
    ts = sorted(_series(0, 100, 10, 5) + [6, 7, 8, 51, 52])
    assert metrics.sensor_reports(ts, 0, 100, 10) == (10, 10)


def test_sensor_reports_jitter_is_not_loss():
    ts = [5 + 10 * i + (3 if i % 2 else -3) for i in range(10)]  # ±30 % от интервала
    assert metrics.sensor_reports(ts, 0, 100, 10) == (10, 10)


def test_sensor_reports_regular_but_too_rare():
    ts = _series(0, 100, 17, 5)                  # ровно, но раз в 1,7 интервала
    assert metrics.sensor_reports(ts, 0, 100, 10) == (6, 10)


def test_sensor_reports_outside_window_ignored():
    assert metrics.sensor_reports([-5, 105], 0, 100, 10) == (0, 10)


def test_recovery():
    assert metrics.recovery([60.0, 240.0, None]) == (240.0, 2, 3)
    assert metrics.recovery([None]) == (None, 0, 1)
