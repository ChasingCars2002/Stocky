#!/usr/bin/env python3
"""Generate clearly-labeled synthetic sample prices.json so the UI renders
before any real fetch.

~20 years of business days for the configured tickers via seeded GBM. The
total-return path (`a`) is generated first, then divided by a small reinvested-
dividend factor exp(divYield * yearsElapsed) to derive the price-only series
(`p`), guaranteeing a > p for dividend-paying names.
"""
import json
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TICKERS_JSON = os.path.join(ROOT, "tickers.json")
OUT_JSON = os.path.join(ROOT, "web", "public", "data", "prices.json")

# Per-ticker GBM params + dividend yield. Seeds keep output deterministic.
PARAMS = {
    "AAPL": dict(start=8.0, mu=0.22, sigma=0.30, div=0.006, seed=1),
    "MSFT": dict(start=20.0, mu=0.16, sigma=0.26, div=0.012, seed=2),
    "SPY": dict(start=90.0, mu=0.09, sigma=0.18, div=0.018, seed=3),
}
DEFAULT = dict(start=50.0, mu=0.10, sigma=0.25, div=0.015, seed=42)


def gbm_path(dates, p):
    n = len(dates)
    rng = np.random.default_rng(p["seed"])
    dt = 1.0 / 252.0
    drift = (p["mu"] - 0.5 * p["sigma"] ** 2) * dt
    shocks = p["sigma"] * np.sqrt(dt) * rng.standard_normal(n)
    log_path = np.cumsum(np.concatenate([[0.0], drift + shocks[1:]]))
    total = p["start"] * np.exp(log_path)  # total-return (adjusted close)

    years_elapsed = (dates - dates[0]).days.values / 365.0
    div_factor = np.exp(p["div"] * years_elapsed)
    price = total / div_factor  # price-only: strip reinvested dividends
    return total, price


def main():
    cfg = json.load(open(TICKERS_JSON))
    tickers = cfg["tickers"]
    benchmark = cfg["benchmark"]
    years = int(cfg.get("startYears", 20))

    end = pd.Timestamp(datetime.now(timezone.utc).date())
    start = end - pd.DateOffset(years=years)
    dates = pd.bdate_range(start=start, end=end)

    data = {}
    for t in tickers:
        p = PARAMS.get(t, {**DEFAULT, "seed": abs(hash(t)) % 100000})
        total, price = gbm_path(dates, p)
        rows = [
            {"d": d.strftime("%Y-%m-%d"), "a": round(float(a), 4), "p": round(float(pr), 4)}
            for d, a, pr in zip(dates, total, price)
        ]
        data[t] = rows

    out = {
        "_meta": {
            "synthetic": True,
            "provider": "synthetic",
            "benchmark": benchmark,
            "tickers": tickers,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "data": data,
    }

    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w") as f:
        json.dump(out, f, separators=(",", ":"))

    first = tickers[0]
    print(f"Wrote {OUT_JSON}")
    print(f"  tickers: {tickers}  rows/ticker: {len(dates)}")
    print(f"  {first}[-1]: a={data[first][-1]['a']}  p={data[first][-1]['p']}")


if __name__ == "__main__":
    main()
