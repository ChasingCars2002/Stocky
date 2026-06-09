#!/usr/bin/env python3
"""Provider-agnostic price fetch -> data/prices.parquet + web/public/data/prices.json.

Providers (decision #6) return rows with: date, close (raw), adjClose (provider
total-return adjusted), splitFactor (split ratio on the ex-date, else 1.0). A
shared post-step derives `splitAdjClose` (decision #3) so the logic is identical
across providers.

Modes (decision #5):
  refresh (default) - re-pull full history, overwrite. Self-healing: a new split
                      retroactively rewrites the entire adjusted series.
  append            - recent-window upsert by (ticker, date); a ticker is
                      escalated to full refresh if a split appears in the window.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TICKERS_JSON = os.path.join(ROOT, "tickers.json")
PARQUET = os.path.join(ROOT, "data", "prices.parquet")
OUT_JSON = os.path.join(ROOT, "web", "public", "data", "prices.json")

COLUMNS = ["ticker", "date", "close", "adjClose", "splitFactor", "splitAdjClose"]
APPEND_WINDOW_DAYS = 14


# ---------------------------------------------------------------------------
# Providers — each returns a DataFrame with: date, close, adjClose, splitFactor
# ---------------------------------------------------------------------------

def fetch_yfinance(ticker, start):
    import yfinance as yf

    h = yf.Ticker(ticker).history(start=start, auto_adjust=False, actions=True)
    if h is None or h.empty:
        return pd.DataFrame(columns=["date", "close", "adjClose", "splitFactor"])
    h = h.copy()
    h.index = h.index.tz_localize(None).normalize()
    splits = h["Stock Splits"].replace(0, 1.0) if "Stock Splits" in h else 1.0
    df = pd.DataFrame(
        {
            "date": h.index,
            "close": h["Close"].astype(float).values,
            "adjClose": h["Adj Close"].astype(float).values,
            "splitFactor": (splits.astype(float).values if hasattr(splits, "values") else 1.0),
        }
    )
    return df.reset_index(drop=True)


def fetch_tiingo(ticker, start):
    import requests

    key = os.environ["TIINGO_API_KEY"]
    url = f"https://api.tiingo.com/tiingo/daily/{ticker}/prices"
    params = {
        "startDate": start,
        "columns": "date,close,adjClose,splitFactor",
        "token": key,
    }
    r = requests.get(url, params=params, headers={"Content-Type": "application/json"}, timeout=30)
    r.raise_for_status()
    rows = r.json()
    if not rows:
        return pd.DataFrame(columns=["date", "close", "adjClose", "splitFactor"])
    df = pd.DataFrame(rows)
    df["date"] = pd.to_datetime(df["date"]).dt.tz_localize(None).dt.normalize()
    df["close"] = df["close"].astype(float)
    df["adjClose"] = df["adjClose"].astype(float)
    df["splitFactor"] = df.get("splitFactor", 1.0).astype(float).fillna(1.0)
    return df[["date", "close", "adjClose", "splitFactor"]].reset_index(drop=True)


PROVIDERS = {"yfinance": fetch_yfinance, "tiingo": fetch_tiingo}


def choose_provider(explicit):
    if explicit:
        return explicit
    return "tiingo" if os.environ.get("TIINGO_API_KEY") else "yfinance"


# ---------------------------------------------------------------------------
# Shared post-step: derive splitAdjClose (decision #3)
# ---------------------------------------------------------------------------

def add_split_adjusted(df):
    """For each date t, divide raw close by the product of split factors whose
    ex-date is STRICTLY AFTER t. The ex-date close is already post-split, so it
    is not divided by its own factor.

    Implementation: sort ascending, then the divisor for row i is the product of
    splitFactor[i+1 .. n-1]. That's a reverse cumulative product shifted by one.
    """
    df = df.sort_values("date").reset_index(drop=True)
    sf = df["splitFactor"].fillna(1.0).to_numpy(dtype=float)
    n = len(sf)
    # reverse cumulative product of factors strictly after each index
    divisor = np.ones(n)
    running = 1.0
    for i in range(n - 1, -1, -1):
        divisor[i] = running  # product of factors at indices > i
        running *= sf[i]
    df["splitAdjClose"] = df["close"].to_numpy(dtype=float) / divisor
    return df


def fetch_ticker(provider_name, ticker, start):
    df = PROVIDERS[provider_name](ticker, start)
    if df.empty:
        return None
    df = add_split_adjusted(df)
    df.insert(0, "ticker", ticker)
    return df[COLUMNS]


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------

def run_refresh(provider_name, tickers, start):
    frames = []
    for t in tickers:
        print(f"  [{provider_name}] full refresh {t} from {start} …", flush=True)
        df = fetch_ticker(provider_name, t, start)
        if df is None:
            print(f"    ! no data for {t}")
            continue
        frames.append(df)
    if not frames:
        raise SystemExit("No data fetched for any ticker.")
    return pd.concat(frames, ignore_index=True)


def run_append(provider_name, tickers, start):
    if not os.path.exists(PARQUET):
        print("  no existing parquet; falling back to full refresh")
        return run_refresh(provider_name, tickers, start)

    existing = pd.read_parquet(PARQUET)
    existing["date"] = pd.to_datetime(existing["date"]).dt.normalize()
    window_start = (datetime.now(timezone.utc) - timedelta(days=APPEND_WINDOW_DAYS)).strftime("%Y-%m-%d")

    out_frames = []
    for t in tickers:
        recent = fetch_ticker(provider_name, t, window_start)
        cur = existing[existing["ticker"] == t]
        if recent is None:
            out_frames.append(cur)
            continue
        # Escalate to full refresh if a split appeared in the window.
        if (recent["splitFactor"].fillna(1.0) != 1.0).any():
            print(f"  split detected in window for {t} -> full refresh", flush=True)
            full = fetch_ticker(provider_name, t, start)
            out_frames.append(full if full is not None else cur)
            continue
        # Upsert by (ticker, date): drop overlapping dates from cur, append recent.
        keep = cur[~cur["date"].isin(recent["date"])]
        merged = pd.concat([keep, recent], ignore_index=True).sort_values("date")
        out_frames.append(merged)

    # Carry over any tickers in the parquet not in the requested set untouched.
    others = existing[~existing["ticker"].isin(tickers)]
    if not others.empty:
        out_frames.append(others)
    return pd.concat(out_frames, ignore_index=True)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_outputs(df, provider_name, tickers, benchmark):
    df = df.sort_values(["ticker", "date"]).reset_index(drop=True)
    os.makedirs(os.path.dirname(PARQUET), exist_ok=True)
    df.to_parquet(PARQUET, index=False)

    data = {}
    for t in tickers:
        sub = df[df["ticker"] == t].sort_values("date")
        data[t] = [
            {
                "d": d.strftime("%Y-%m-%d"),
                "a": round(float(a), 4),
                "p": round(float(p), 4),
            }
            for d, a, p in zip(sub["date"], sub["adjClose"], sub["splitAdjClose"])
        ]

    out = {
        "_meta": {
            "synthetic": False,
            "provider": provider_name,
            "benchmark": benchmark,
            "tickers": tickers,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "data": data,
    }
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    return data


def main():
    cfg = json.load(open(TICKERS_JSON))
    tickers = cfg["tickers"]
    benchmark = cfg["benchmark"]
    years = int(cfg.get("startYears", 20))
    start = (datetime.now(timezone.utc) - timedelta(days=365 * years + 5)).strftime("%Y-%m-%d")

    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["refresh", "append"], default="refresh")
    ap.add_argument("--provider", choices=list(PROVIDERS), default=None)
    args = ap.parse_args()

    provider_name = choose_provider(args.provider)
    print(f"Provider: {provider_name}  mode: {args.mode}  tickers: {tickers}")

    if args.mode == "append":
        df = run_append(provider_name, tickers, start)
    else:
        df = run_refresh(provider_name, tickers, start)

    data = write_outputs(df, provider_name, tickers, benchmark)

    print(f"\nWrote {PARQUET} and {OUT_JSON}")
    for t in tickers:
        rows = data[t]
        if rows:
            print(f"  {t}: {len(rows)} rows  {rows[0]['d']} → {rows[-1]['d']}  "
                  f"last a={rows[-1]['a']} p={rows[-1]['p']}")


if __name__ == "__main__":
    main()
