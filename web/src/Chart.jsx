import React, { useEffect, useRef, useState, useMemo } from "react";
import { fmtMoney } from "./returns.js";

// Hand-rolled responsive SVG chart. No charting dependency.
//  - area  = portfolio value (gradient fill)
//  - dashed line = amount invested
//  - thin line = benchmark portfolio value (optional)
export default function Chart({ portfolio, benchmark, benchmarkLabel }) {
  const wrapRef = useRef(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState(null); // index into portfolio
  const height = 320;
  const pad = { top: 16, right: 16, bottom: 28, left: 56 };

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(280, e.contentRect.width));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  const geom = useMemo(() => {
    if (!portfolio || portfolio.length < 2) return null;
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;

    const t0 = portfolio[0].t.getTime();
    const t1 = portfolio[portfolio.length - 1].t.getTime();
    const span = Math.max(1, t1 - t0);

    let maxV = 0;
    for (const d of portfolio) maxV = Math.max(maxV, d.value, d.invested);
    if (benchmark) for (const d of benchmark) maxV = Math.max(maxV, d.value);
    maxV = niceCeil(maxV * 1.08);

    const x = (t) => pad.left + ((t - t0) / span) * innerW;
    const y = (v) => pad.top + innerH - (v / maxV) * innerH;

    const linePath = (arr, key) =>
      arr
        .map((d, i) => `${i === 0 ? "M" : "L"}${x(d.t.getTime()).toFixed(2)},${y(d[key]).toFixed(2)}`)
        .join(" ");

    const valueLine = linePath(portfolio, "value");
    const areaPath =
      valueLine +
      ` L${x(t1).toFixed(2)},${y(0).toFixed(2)} L${x(t0).toFixed(2)},${y(0).toFixed(2)} Z`;
    const investedLine = linePath(portfolio, "invested");
    const benchLine = benchmark ? linePath(benchmark, "value") : null;

    // y grid (5 lines) and x year ticks.
    const yTicks = [];
    for (let i = 0; i <= 4; i++) {
      const v = (maxV / 4) * i;
      yTicks.push({ v, y: y(v) });
    }
    const xTicks = [];
    const y0 = portfolio[0].t.getUTCFullYear();
    const y1 = portfolio[portfolio.length - 1].t.getUTCFullYear();
    const yearStep = Math.max(1, Math.ceil((y1 - y0) / 8));
    for (let yr = y0; yr <= y1; yr += yearStep) {
      const t = Date.UTC(yr, 0, 1);
      if (t < t0 || t > t1) continue;
      xTicks.push({ yr, x: x(t) });
    }

    return { innerW, innerH, t0, t1, span, maxV, x, y, valueLine, areaPath, investedLine, benchLine, yTicks, xTicks };
  }, [portfolio, benchmark, width]);

  if (!geom) return <div ref={wrapRef} className="chart-wrap" />;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const frac = Math.min(1, Math.max(0, (px - pad.left) / geom.innerW));
    const tAt = geom.t0 + frac * geom.span;
    // nearest sample
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < portfolio.length; i++) {
      const d = Math.abs(portfolio[i].t.getTime() - tAt);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    setHover(best);
  };

  const hp = hover != null ? portfolio[hover] : null;
  const hb = hover != null && benchmark ? benchmark[Math.min(hover, benchmark.length - 1)] : null;
  const hx = hp ? geom.x(hp.t.getTime()) : 0;

  return (
    <div ref={wrapRef} className="chart-wrap">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Portfolio value over time versus amount invested"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* y grid + labels */}
        {geom.yTicks.map((t, i) => (
          <g key={i}>
            <line x1={pad.left} x2={width - pad.right} y1={t.y} y2={t.y} className="grid" />
            <text x={pad.left - 8} y={t.y + 4} className="axis-label" textAnchor="end">
              {fmtMoney(t.v, { decimals: 0 })}
            </text>
          </g>
        ))}

        {/* x year ticks */}
        {geom.xTicks.map((t, i) => (
          <text key={i} x={t.x} y={height - 8} className="axis-label" textAnchor="middle">
            {t.yr}
          </text>
        ))}

        {/* area = portfolio value */}
        <path d={geom.areaPath} fill="url(#areaFill)" stroke="none" />
        <path d={geom.valueLine} className="line-value" fill="none" />

        {/* benchmark thin line */}
        {geom.benchLine && <path d={geom.benchLine} className="line-bench" fill="none" />}

        {/* invested dashed line */}
        <path d={geom.investedLine} className="line-invested" fill="none" />

        {/* hover guide */}
        {hp && (
          <g>
            <line x1={hx} x2={hx} y1={pad.top} y2={height - pad.bottom} className="hover-guide" />
            <circle cx={hx} cy={geom.y(hp.value)} r="4" className="hover-dot" />
          </g>
        )}
      </svg>

      <div className="chart-legend">
        <span><i className="sw sw-value" /> Portfolio value</span>
        <span><i className="sw sw-invested" /> Amount invested</span>
        {benchmark && <span><i className="sw sw-bench" /> {benchmarkLabel}</span>}
      </div>

      {hp && (
        <div className="chart-readout">
          <span className="ro-date">{hp.t.toISOString().slice(0, 10)}</span>
          <span className="ro-row"><b>Value</b> {fmtMoney(hp.value)}</span>
          <span className="ro-row"><b>Invested</b> {fmtMoney(hp.invested)}</span>
          {hb && <span className="ro-row"><b>{benchmarkLabel}</b> {fmtMoney(hb.value)}</span>}
        </div>
      )}
    </div>
  );
}

function niceCeil(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}
