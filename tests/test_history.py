"""Hourly hit-rate buckets: per-hour rate, empty hours carry the prior value."""
from proxyhub.server import HourlyHitRate


class _Cache:
    hits = 0
    misses = 0


def test_hourly_buckets_and_carry_forward():
    c = _Cache()
    h = HourlyHitRate(c, hours=24)
    base = 10 * 3600                      # start of hour 10

    h.tick(base)                          # open hour 10 at (0,0)
    c.hits, c.misses = 3, 1               # hour 10: 75% over 4 reqs
    h.tick(base + 3600 + 1)               # roll into hour 11 -> close hour 10
    # hour 11: NO requests
    h.tick(base + 2 * 3600 + 1)           # roll into hour 12 -> close hour 11 (carry)
    c.hits, c.misses = 4, 10              # hour 12: +1 hit +9 miss = 10%
    series = h.series(base + 3 * 3600 + 1)  # advance to hour 13, current bucket

    rates = [p["rate"] for p in series]
    reqs = [p["reqs"] for p in series]
    # hour10=75, hour11=carry 75 (0 reqs), hour12=10, current hour13=carry 10
    assert rates == [75.0, 75.0, 10.0, 10.0]
    assert reqs[1] == 0                   # empty hour recorded as zero-traffic
    assert series[-1].get("current") is True


def test_hourly_window_capped():
    c = _Cache()
    h = HourlyHitRate(c, hours=24)
    for i in range(40):                   # 40 hours of activity
        h.tick(i * 3600)
        c.hits += 1
    series = h.series(40 * 3600)
    assert len(series) <= 25              # 24 completed + current


def test_hourly_empty_before_traffic():
    c = _Cache()
    h = HourlyHitRate(c, hours=24)
    series = h.series(5 * 3600)           # no traffic ever
    assert series[-1]["rate"] is None     # nothing to show yet
