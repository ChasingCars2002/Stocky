import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  buildSeries,
  compute,
  buildChartSeries,
  fmtMoney,
  fmtPct,
  toUTCDate,
} from "./returns.js";
import Chart from "./Chart.jsx";

const DATA_URL = "data/prices.json";

// ---- count-up hook (respects prefers-reduced-motion) ----------------------
function useCountUp(target, deps) {
  const [val, setVal] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !Number.isFinite(target)) {
      setVal(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    const dur = 650;
    const start = performance.now();
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setVal(from + (target - from) * e);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return val;
}

function isoDaysAgoYears(years) {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export default function App() {
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState(null);

  const [ticker, setTicker] = useState(null);
  const [mode, setMode] = useState("lump"); // 'lump' | 'dca'
  const [amount, setAmount] = useState(1000);
  const [startDate, setStartDate] = useState(isoDaysAgoYears(15));
  const [basis, setBasis] = useState("total"); // 'total' | 'price'

  useEffect(() => {
    fetch(DATA_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((p) => {
        setPayload(p);
        const first = p._meta.tickers[0];
        setTicker(first);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const meta = payload?._meta;
  const rows = ticker && payload ? payload.data[ticker] : null;

  // Data date bounds for the selected ticker.
  const bounds = useMemo(() => {
    if (!rows || !rows.length) return null;
    return { min: rows[0].d, max: rows[rows.length - 1].d };
  }, [rows]);

  // Clamp start date into bounds for the computation (but keep the user's input).
  const effStart = useMemo(() => {
    if (!bounds) return startDate;
    let s = startDate;
    if (s < bounds.min) s = bounds.min;
    if (s > bounds.max) s = bounds.max;
    return s;
  }, [startDate, bounds]);

  const series = useMemo(() => (rows ? buildSeries(rows, basis) : null), [rows, basis]);
  const result = useMemo(
    () => (series ? compute(series, mode, amount, toUTCDate(effStart)) : null),
    [series, mode, amount, effStart]
  );

  // Benchmark plan (same inputs, benchmark ticker). Hidden when ticker === benchmark.
  const benchmarkTicker = meta?.benchmark;
  const showBenchmark = benchmarkTicker && ticker !== benchmarkTicker;
  const benchSeries = useMemo(() => {
    if (!showBenchmark || !payload) return null;
    return buildSeries(payload.data[benchmarkTicker], basis);
  }, [showBenchmark, payload, benchmarkTicker, basis]);
  const benchResult = useMemo(
    () => (benchSeries ? compute(benchSeries, mode, amount, toUTCDate(effStart)) : null),
    [benchSeries, mode, amount, effStart]
  );

  const chartPortfolio = useMemo(
    () => (series && result ? buildChartSeries(series, result, amount) : null),
    [series, result, amount]
  );
  const chartBenchmark = useMemo(
    () => (benchSeries && benchResult ? buildChartSeries(benchSeries, benchResult, amount) : null),
    [benchSeries, benchResult, amount]
  );

  const animatedValue = useCountUp(result?.value ?? 0, [
    result?.value,
    ticker,
    mode,
    basis,
  ]);

  if (error) {
    return (
      <div className="app">
        <p className="error">Couldn't load price data: {error}</p>
      </div>
    );
  }
  if (!payload || !ticker) {
    return (
      <div className="app">
        <p className="loading">Loading prices…</p>
      </div>
    );
  }

  const applyPreset = (preset) => {
    if (preset === "lump15") {
      setMode("lump");
      setAmount(1000);
      setStartDate(isoDaysAgoYears(15));
    } else {
      setMode("dca");
      setAmount(50);
      setStartDate(isoDaysAgoYears(15));
    }
  };

  const heldYears = result
    ? ((result.endDate - result.startUsed) / (365 * 86400000)).toFixed(1)
    : null;

  return (
    <div className="app">
      <header className="masthead">
        <div className="brand">
          <span className="brand-mark">▮▮▯</span>
          <span className="brand-name">Stocky</span>
          {meta.synthetic && <span className="badge-synthetic">SAMPLE DATA</span>}
        </div>
        <p className="tagline">What if I'd invested?</p>
      </header>

      <section className="controls" aria-label="Plan controls">
        <div className="control">
          <label htmlFor="ticker">Ticker</label>
          <select id="ticker" value={ticker} onChange={(e) => setTicker(e.target.value)}>
            {meta.tickers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="control">
          <span className="control-label">Plan</span>
          <div className="segmented" role="group" aria-label="Investment plan">
            <button
              className={mode === "lump" ? "seg active" : "seg"}
              aria-pressed={mode === "lump"}
              onClick={() => setMode("lump")}
            >
              One-time
            </button>
            <button
              className={mode === "dca" ? "seg active" : "seg"}
              aria-pressed={mode === "dca"}
              onClick={() => setMode("dca")}
            >
              Monthly
            </button>
          </div>
        </div>

        <div className="control">
          <label htmlFor="amount">{mode === "dca" ? "Per month" : "Amount"}</label>
          <div className="money-input">
            <span>$</span>
            <input
              id="amount"
              type="number"
              min="1"
              step="1"
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
            />
          </div>
        </div>

        <div className="control">
          <label htmlFor="start">Start date</label>
          <input
            id="start"
            type="date"
            value={startDate}
            min={bounds?.min}
            max={bounds?.max}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>

        <div className="control">
          <span className="control-label">Basis</span>
          <div className="segmented" role="group" aria-label="Price basis">
            <button
              className={basis === "total" ? "seg active" : "seg"}
              aria-pressed={basis === "total"}
              onClick={() => setBasis("total")}
            >
              Total return
            </button>
            <button
              className={basis === "price" ? "seg active" : "seg"}
              aria-pressed={basis === "price"}
              onClick={() => setBasis("price")}
            >
              Price only
            </button>
          </div>
        </div>
      </section>

      <div className="presets">
        <span className="presets-label">Try:</span>
        <button className="preset" onClick={() => applyPreset("lump15")}>
          $1,000 · 15 years ago
        </button>
        <button className="preset" onClick={() => applyPreset("dca15")}>
          $50/mo · 15 years ago
        </button>
      </div>

      {result ? (
        <>
          <section className="hero">
            <p className="hero-eyebrow">
              {mode === "dca" ? "Monthly into" : "One-time into"} {ticker} would be worth
            </p>
            <p className="hero-value">{fmtMoney(animatedValue)}</p>
            <p className="hero-sub">
              {fmtPct(result.totalReturn)} total ·{" "}
              {basis === "total" ? "dividends reinvested" : "price only"}
            </p>
          </section>

          <section className="metrics">
            <div className="metric">
              <span className="metric-label">Invested</span>
              <span className="metric-value">{fmtMoney(result.invested)}</span>
              {mode === "dca" && (
                <span className="metric-note">{result.buyCount} monthly buys</span>
              )}
            </div>
            <div className="metric">
              <span className="metric-label">
                Annualized
                <Info>
                  {mode === "dca"
                    ? "Money-weighted XIRR — the single annual rate that makes the timed contributions equal today's value. Comparable to a lump-sum CAGR."
                    : "Compound annual growth rate (CAGR) over the holding period."}
                </Info>
              </span>
              <span className="metric-value">{fmtPct(result.annualized)}</span>
              <span className="metric-note">
                {mode === "dca" ? "XIRR" : "CAGR"}
              </span>
            </div>
            <div className="metric">
              <span className="metric-label">Held since</span>
              <span className="metric-value">{result.startUsed.toISOString().slice(0, 10)}</span>
              <span className="metric-note">{heldYears} years</span>
            </div>
          </section>

          <section className="chart-section">
            <Chart
              portfolio={chartPortfolio}
              benchmark={showBenchmark ? chartBenchmark : null}
              benchmarkLabel={benchmarkTicker}
            />
          </section>

          {showBenchmark && benchResult && (
            <section className="benchmark">
              <h2 className="benchmark-title">
                Same plan into {benchmarkTicker}
              </h2>
              <div className="benchmark-grid">
                <div className="metric">
                  <span className="metric-label">{benchmarkTicker} value</span>
                  <span className="metric-value">{fmtMoney(benchResult.value)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">{benchmarkTicker} annualized</span>
                  <span className="metric-value">{fmtPct(benchResult.annualized)}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Difference</span>
                  <span
                    className={
                      result.value >= benchResult.value
                        ? "metric-value pos"
                        : "metric-value neg"
                    }
                  >
                    {result.value >= benchResult.value ? "+" : ""}
                    {fmtMoney(result.value - benchResult.value)}
                  </span>
                  <span className="metric-note">
                    {ticker} vs {benchmarkTicker}
                  </span>
                </div>
              </div>
            </section>
          )}
        </>
      ) : (
        <p className="loading">No data for this selection.</p>
      )}

      <footer className="foot">
        <span>
          {meta.synthetic ? "Synthetic sample data" : `Data via ${meta.provider}`} ·{" "}
          {bounds ? `${bounds.min} → ${bounds.max}` : ""}
        </span>
        <span>
          Returns: lump-sum CAGR, DCA money-weighted XIRR, Actual/365.
        </span>
      </footer>
    </div>
  );
}

function Info({ children }) {
  return (
    <span className="info" tabIndex={0} role="note" aria-label={String(children)}>
      <span className="info-mark">i</span>
      <span className="info-pop">{children}</span>
    </span>
  );
}
