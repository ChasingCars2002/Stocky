# Stocky — Stock Returns Calculator

A daily-updated static site that answers *"what if I'd invested?"* for a set of
tickers: a one-time **lump sum** and a **monthly (dollar-cost-averaging)** plan,
with a benchmark comparison. Prices are pulled once a day, committed to the repo,
and all returns are computed in the browser. No database, no request-time API
calls — the committed data file is the deploy trigger.

## Quick start (sample data)

```bash
# 1. Generate synthetic sample prices (clearly labeled "SAMPLE DATA" in the UI)
pip install -r ingest/requirements.txt
python ingest/gen_sample.py

# 2. Run the app
cd web
npm install
npm run dev      # http://localhost:5173
```

Run the math tests:

```bash
cd web && npm test          # node test/returns.test.mjs
```

## Real data

```bash
python ingest/fetch.py                 # full refresh (default)
python ingest/fetch.py --mode append   # recent-window upsert
python ingest/fetch.py --provider tiingo
```

Writes `data/prices.parquet` (canonical) and `web/public/data/prices.json`
(what the app fetches).

**Provider** — yfinance by default (no key needed). If `TIINGO_API_KEY` is set,
Tiingo is used instead (cleaner free tier for unattended runs). Override with
`--provider {yfinance,tiingo}`.

### Refresh vs. append

- **`refresh`** (default) re-pulls full history and overwrites. It's
  self-healing: a new stock split retroactively rewrites the entire adjusted
  series, and a full pull always reflects it.
- **`append`** does a recent-window upsert keyed by `(ticker, date)`, and
  escalates a ticker to a full refresh if a split appears in the window.

## Daily GitHub Action

`.github/workflows/update-prices.yml` runs on a weekday cron (22:30 UTC, after
the US close) and via manual **workflow_dispatch** (with a `refresh`/`append`
choice). It installs deps, runs the fetch, and commits the two data files **only
if they changed** — so missed runs and holidays are harmless.

Optional: add `TIINGO_API_KEY` under **Settings → Secrets and variables →
Actions**. Without it the job falls back to yfinance.

## Deploy on Vercel

Create a Vercel project pointing at this repo with **Root Directory = `web`**.
Vercel auto-detects Vite (build `npm run build`, output `dist`). No environment
variables are needed on Vercel — the Tiingo key lives only in GitHub Actions.
Because `web/public/data/prices.json` is committed, every data commit triggers a
redeploy.

## Returns conventions (so the numbers are trusted)

- **Lump sum** annualized return = **CAGR**.
- **DCA** annualized return = **money-weighted XIRR** — the single annual rate
  that makes the timed contributions equal today's value, and the only figure
  comparable to a lump-sum CAGR. (`final/invested − 1` annualized would be wrong
  because contributions land at different times.)
- **Basis** — *Total return* uses adjusted close (dividends reinvested, field
  `a`); *Price only* uses split-adjusted close (no dividends, field `p`).
- **Split adjustment** — for each date `t`, the raw close is divided by the
  product of split factors whose ex-date is strictly after `t`, giving a series
  that stays continuous across splits.
- **Monthly buys** land on the 1st, rolled forward to the next trading day. A
  mid-month start begins the following month.
- **Day count** = Actual/365 for all annualization (matches spreadsheet XIRR).
- Fractional shares are assumed throughout.

## Layout

```
tickers.json                       # { tickers, benchmark, startYears }
data/prices.parquet                # canonical (written by the Action)
ingest/fetch.py                    # provider-agnostic fetch -> parquet + JSON
ingest/gen_sample.py               # synthetic sample data
web/                               # Vite + React app (root dir for Vercel)
  public/data/prices.json          # what the app fetches
  src/returns.js                   # the returns math (framework-agnostic)
  test/returns.test.mjs            # known-answer tests
.github/workflows/update-prices.yml
```
