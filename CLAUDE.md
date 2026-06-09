# Stocky — Stock Returns Calculator (project context)

A daily-updated static site that answers "what if I'd invested" for a set of
tickers: a one-time lump sum and a monthly (dollar-cost-averaging) plan, with a
benchmark comparison.

## Objective

Pull end-of-day prices once a day, commit them to the repo, and serve a static
React app that computes returns entirely in the browser. No database, no
request-time API calls. The committed data file is the deploy trigger.

## Stack & constraints

- Ingest: Python 3.12 (`yfinance` default; `Tiingo` if a key is present).
- Frontend: Vite + React (plain JS, no TS), hand-rolled SVG chart, no chart lib.
- Automation: GitHub Actions (scheduled + manual), commit-back of data.
- Hosting: Vercel, static build of the `web/` folder.
- Storage: `data/prices.parquet` (canonical) + `web/public/data/prices.json`
  (what the app fetches). No DB.

## Design decisions (locked — do not re-derive)

1. **DCA annualized return is money-weighted XIRR**, not `final/invested − 1`
   annualized. Contributions land at different times, so XIRR is the only annual
   rate comparable to a lump-sum CAGR. Lump sum uses CAGR. This is the single
   most important correctness point.
2. Basis = adjusted close (dividends reinvested) → field `a`, labeled "Total
   return". A "Price only" toggle uses split-adjusted close (no dividends) →
   field `p`. Fractional shares assumed throughout.
3. `splitAdjClose` derivation: for each date `t`, divide the raw close by the
   product of split factors whose ex-date is **strictly after** `t`. The ex-date
   close is already post-split, so it is not divided by its own factor. (A 4:1
   split must yield a continuous split-adjusted series across the split date.)
4. Monthly buys land on the 1st, rolled forward to the next trading day when the
   1st is a weekend/holiday (binary-search the first index on/after the 1st). A
   mid-month start date begins the following month. The month must be derived
   from the user's start date, not a data-clamped date.
5. Ingest default = full refresh (re-pull full history, overwrite). It's
   self-healing: a new split retroactively rewrites the entire adjusted series,
   and a full pull always reflects it. `--append` mode does a recent-window
   upsert by `(ticker, date)` and escalates a ticker to full refresh if a split
   appears in the window.
6. Provider abstraction: each provider returns rows with `date`, `close` (raw),
   `adjClose` (provider total-return adjusted), `splitFactor` (split ratio on
   the ex-date, else `1.0`). A shared post-step derives `splitAdjClose` so the
   logic is identical across providers.
7. prices.json schema:
   ```json
   {
     "_meta": { "synthetic": false, "provider": "yfinance", "benchmark": "SPY",
                "tickers": ["AAPL","MSFT","SPY"], "generatedAt": "2026-..." },
     "data": { "AAPL": [ { "d": "2010-01-04", "a": 1.23, "p": 1.10 }, ... ] }
   }
   ```
   `d`=YYYY-MM-DD, `a`=adjusted close (total), `p`=split-adjusted close (price).
8. Day count = Actual/365 for all annualization (matches spreadsheet XIRR).
9. Design direction: dark "quant-notebook" theme; Space Grotesk (display) + IBM
   Plex Mono (numbers); the hero is the big mono money figure with a count-up;
   chart = area for portfolio value, dashed line for amount invested, thin line
   for benchmark. Respect `prefers-reduced-motion`, support mobile, keep visible
   keyboard focus.

## Gotchas

- `monthlyBuyIndices`: derive the first buy month from the user's `startDate`
  (`if day > 1 → next month`), NOT from `max(startDate, series[0])`. Then if that
  month is before the first data month, advance it to the first data month.
  Dedup consecutive identical indices.
- A new split retroactively rewrites the whole adjusted series → full refresh is
  the safe default; append must detect splits.
- yfinance is a scraper (rate limits, occasional bad corporate-action data);
  Tiingo's free tier is cleaner. Use `auto_adjust=False` to keep raw + adjusted.
- GitHub cron is UTC and best-effort; the job must be idempotent.
- Don't use browser storage APIs (localStorage/sessionStorage); keep all state
  in React.
