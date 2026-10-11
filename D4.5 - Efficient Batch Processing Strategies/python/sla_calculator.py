"""D4.5 - How often must you submit batches to guarantee an SLA?

A document that arrives just after a submission waits a full window for the next one, then
the batch may take the full 24h. So the worst case is   window + 24h (+ safety buffer),
and the longest window that still meets the SLA is

    max_window = SLA - 24h max batch processing - safety buffer

30h SLA, 2h buffer -> submit every 4h (the exam's example).

Run:  python sla_calculator.py      (pure arithmetic + a simulation; no model calls)
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

BATCH_MAX_HOURS = 24.0


def max_submission_window(sla_hours: float, buffer_hours: float = 2.0, batch_max_hours: float = BATCH_MAX_HOURS) -> float:
    return max(0.0, sla_hours - batch_max_hours - buffer_hours)


def simulate_worst_latency(window_hours: float, batch_max_hours: float = BATCH_MAX_HOURS, days: int = 3) -> float:
    """Documents arrive every 15 minutes; each waits for the next submission, then takes the max 24h."""
    worst = 0.0
    for step in range(days * 24 * 4):
        arrival = step * 0.25 + 0.01  # just AFTER a cutoff is the worst moment to arrive
        submitted = math.ceil(arrival / window_hours) * window_hours
        worst = max(worst, submitted + batch_max_hours - arrival)
    return worst


def main() -> None:
    lab.banner("D4.5  Batch submission frequency from an SLA")

    lab.section("1. Max submission window per SLA (24h max processing, 2h buffer)")
    print(f"  {'SLA':>5}  {'window':>7}  {'submissions/day':>16}  worst-case latency")
    table = {}
    for sla in (24, 26, 30, 36, 48, 72):
        window = max_submission_window(sla)
        table[sla] = window
        if window <= 0:
            print(f"  {sla:>4}h  {'-':>7}  {'-':>16}  not achievable with batches -> use the synchronous API")
            continue
        per_day = math.ceil(24 / window)
        print(f"  {sla:>4}h  {window:>6.0f}h  {per_day:>16}  {window + BATCH_MAX_HOURS:.0f}h + {2:.0f}h buffer = {sla}h")

    lab.section("2. Simulated arrivals: does the 4h window really hold a 30h SLA?")
    four_hourly = simulate_worst_latency(table[30])
    daily = simulate_worst_latency(24)
    print(f"  submit every {table[30]:.0f}h : worst observed latency {four_hourly:.2f}h (SLA 30h, buffer 2h)")
    print(f"  submit once a day: worst observed latency {daily:.2f}h  <- misses the SLA")

    lab.check(table[30] == 4, "30h SLA - 24h max batch - 2h buffer = 4h submission windows")
    lab.check(table[26] == 0 and table[24] == 0, "an SLA at or under 24h + buffer cannot be guaranteed with batches")
    lab.check(four_hourly <= 30 - 2, "worst case with 4h windows stays inside SLA minus the buffer")
    lab.check(daily > 30, "a daily batch looks cheaper to run but breaks the 30h guarantee")


if __name__ == "__main__":
    main()
