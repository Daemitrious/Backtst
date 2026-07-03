"""Optional Python core for heavy CSV backtests.

This file is included for production-oriented extension. The browser UI remains the main launcher.
Input CSV columns: timestamp,open,high,low,close,volume
"""
from __future__ import annotations
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable, List, Dict, Any
import csv

MINUTE_MS = 60_000
H4_MS = 240 * MINUTE_MS

@dataclass
class Candle:
    t: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


def parse_time(value: str) -> int:
    value = str(value).strip()
    if value.isdigit():
        n = int(value)
        return n * 1000 if n < 10_000_000_000 else n
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def read_csv(path: str) -> List[Candle]:
    out: List[Candle] = []
    with open(path, "r", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            c = Candle(
                t=parse_time(row["timestamp"]),
                open=float(row["open"]),
                high=float(row["high"]),
                low=float(row["low"]),
                close=float(row["close"]),
                volume=float(row.get("volume") or 0),
            )
            c.high = max(c.high, c.open, c.close)
            c.low = min(c.low, c.open, c.close)
            out.append(c)
    return sorted(out, key=lambda x: x.t)


def aggregate_4h(candles: Iterable[Candle]) -> List[Dict[str, Any]]:
    bars: List[Dict[str, Any]] = []
    cur = None
    for c in candles:
        start = (c.t // H4_MS) * H4_MS
        if cur is None or cur["t"] != start:
            if cur is not None:
                bars.append(cur)
            cur = dict(t=start, open=c.open, high=c.high, low=c.low, close=c.close, volume=c.volume, count1m=1)
        else:
            cur["high"] = max(cur["high"], c.high)
            cur["low"] = min(cur["low"], c.low)
            cur["close"] = c.close
            cur["volume"] += c.volume
            cur["count1m"] += 1
    if cur is not None:
        bars.append(cur)
    return bars


def smoke_test() -> None:
    candles = [Candle(t=i * MINUTE_MS, open=100, high=101, low=99, close=100 + (i % 3 - 1) * 0.1) for i in range(480)]
    bars = aggregate_4h(candles)
    assert len(bars) == 2, f"expected 2 4H bars, got {len(bars)}"
    print("OK: aggregate_4h")

if __name__ == "__main__":
    smoke_test()
