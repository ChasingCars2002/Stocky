// returns.js — framework-agnostic returns math (ESM, no DOM).
//
// Conventions (locked spec):
//  - DCA annualized return = money-weighted XIRR. Lump sum = CAGR.
//  - Day count = Actual/365 for all annualization.
//  - basis 'total' -> field `a` (adjusted close, dividends reinvested).
//    basis 'price' -> field `p` (split-adjusted close, no dividends).
//  - Fractional shares assumed throughout.

const MS_PER_DAY = 86400000;
const DAYS_PER_YEAR = 365; // Actual/365

// ---------------------------------------------------------------------------
// Dates & series
// ---------------------------------------------------------------------------

// Parse a "YYYY-MM-DD" string to a UTC Date at midnight.
export function toUTCDate(s) {
  if (s instanceof Date) return s;
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

// rows: [{ d:"YYYY-MM-DD", a:Number, p:Number }, ...]
// basis: 'total' (a) | 'price' (p)
// -> [{ t: Date(UTC), v: Number }] sorted ascending by date.
export function buildSeries(rows, basis) {
  const field = basis === "price" ? "p" : "a";
  return rows
    .map((r) => ({ t: toUTCDate(r.d), v: Number(r[field]) }))
    .filter((x) => Number.isFinite(x.v))
    .sort((a, b) => a.t - b.t);
}

// Binary search: first index in `series` whose date is >= `date`.
// Returns -1 if every date is before `date`.
export function firstIndexOnOrAfter(series, date) {
  const target = date instanceof Date ? date.getTime() : toUTCDate(date).getTime();
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t.getTime() >= target) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

// Last index whose date is <= `date`. Returns -1 if all dates are after.
function lastIndexOnOrBefore(series, date) {
  const target = date instanceof Date ? date.getTime() : toUTCDate(date).getTime();
  let lo = 0;
  let hi = series.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t.getTime() <= target) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

// ---------------------------------------------------------------------------
// XIRR / NPV / CAGR
// ---------------------------------------------------------------------------

// cashflows: [{ amount: Number, date: Date }, ...]
// Net present value at annual `rate`, discounting from t0 (first flow's date)
// with Actual/365 day count.
export function npv(rate, cashflows, t0) {
  const base = t0 instanceof Date ? t0.getTime() : cashflows[0].date.getTime();
  let sum = 0;
  for (const cf of cashflows) {
    const years = (cf.date.getTime() - base) / (MS_PER_DAY * DAYS_PER_YEAR);
    sum += cf.amount / Math.pow(1 + rate, years);
  }
  return sum;
}

// Derivative of npv with respect to rate (for Newton's method).
function dnpv(rate, cashflows, t0) {
  const base = t0 instanceof Date ? t0.getTime() : cashflows[0].date.getTime();
  let sum = 0;
  for (const cf of cashflows) {
    const years = (cf.date.getTime() - base) / (MS_PER_DAY * DAYS_PER_YEAR);
    if (years === 0) continue;
    sum += (-years * cf.amount) / Math.pow(1 + rate, years + 1);
  }
  return sum;
}

// Money-weighted internal rate of return (annual). Requires a sign change in
// the cashflow amounts. Newton's method with a bracketed bisection fallback.
export function xirr(cashflows) {
  if (!cashflows || cashflows.length < 2) return NaN;
  let hasPos = false;
  let hasNeg = false;
  for (const cf of cashflows) {
    if (cf.amount > 0) hasPos = true;
    if (cf.amount < 0) hasNeg = true;
  }
  if (!hasPos || !hasNeg) return NaN; // no sign change -> no IRR

  const t0 = cashflows[0].date;

  // Newton's method.
  let rate = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(rate, cashflows, t0);
    const df = dnpv(rate, cashflows, t0);
    if (!Number.isFinite(f) || !Number.isFinite(df) || df === 0) break;
    const next = rate - f / df;
    if (!Number.isFinite(next) || next <= -1) break; // leave the valid domain
    if (Math.abs(next - rate) < 1e-9) return next;
    rate = next;
  }

  // Bisection fallback over a wide bracket. rate > -1 keeps (1+rate) positive.
  let lo = -0.9999;
  let hi = 100;
  let flo = npv(lo, cashflows, t0);
  let fhi = npv(hi, cashflows, t0);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = npv(mid, cashflows, t0);
    if (Math.abs(fmid) < 1e-7 || (hi - lo) / 2 < 1e-9) return mid;
    if (flo * fmid < 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

// Compound annual growth rate over [startDate, endDate], Actual/365.
export function cagr(startValue, endValue, startDate, endDate) {
  const years =
    (endDate.getTime() - startDate.getTime()) / (MS_PER_DAY * DAYS_PER_YEAR);
  if (years <= 0 || startValue <= 0) return NaN;
  return Math.pow(endValue / startValue, 1 / years) - 1;
}

// ---------------------------------------------------------------------------
// Buy schedule
// ---------------------------------------------------------------------------

// Monthly buy indices into `series`. Buys land on the 1st, rolled forward to
// the next trading day. The first buy month is derived from the *user's*
// startDate (mid-month start -> following month), then advanced to the first
// data month if it falls before the data begins.
export function monthlyBuyIndices(series, startDate) {
  if (!series.length) return [];
  const start = toUTCDate(startDate);

  // First buy month from the user's start date (NOT a data-clamped date).
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  if (start.getUTCDate() > 1) m += 1; // mid-month start -> following month

  // Advance to the first data month if earlier than the data begins.
  const firstData = series[0].t;
  const dataY = firstData.getUTCFullYear();
  const dataM = firstData.getUTCMonth();
  if (y < dataY || (y === dataY && m < dataM)) {
    y = dataY;
    m = dataM;
  }

  const last = series[series.length - 1].t.getTime();
  const indices = [];
  // Walk month by month until we pass the end of the data.
  // (Normalize y/m so Date.UTC handles month overflow.)
  let cursor = new Date(Date.UTC(y, m, 1));
  while (cursor.getTime() <= last) {
    const idx = firstIndexOnOrAfter(series, cursor);
    if (idx === -1) break;
    if (indices.length === 0 || indices[indices.length - 1] !== idx) {
      indices.push(idx); // dedup consecutive identical indices
    }
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return indices;
}

// ---------------------------------------------------------------------------
// Compute: lump sum & DCA
// ---------------------------------------------------------------------------

export function computeLumpSum(series, amount, startDate) {
  const idx = firstIndexOnOrAfter(series, startDate);
  if (idx === -1) return null;
  const buy = series[idx];
  const end = series[series.length - 1];
  const shares = amount / buy.v;
  const value = shares * end.v;
  const totalReturn = value / amount - 1;
  const annualized = cagr(amount, value, buy.t, end.t);
  return {
    mode: "lump",
    invested: amount,
    value,
    shares,
    buyCount: 1,
    totalReturn,
    annualized, // CAGR
    annualizedMethod: "cagr",
    startUsed: buy.t,
    endDate: end.t,
    buyIndices: [idx],
  };
}

export function computeDCA(series, amount, startDate) {
  const buyIndices = monthlyBuyIndices(series, startDate);
  if (!buyIndices.length) return null;
  const end = series[series.length - 1];

  let shares = 0;
  const cashflows = [];
  for (const i of buyIndices) {
    const px = series[i];
    shares += amount / px.v;
    cashflows.push({ amount: -amount, date: px.t });
  }
  const invested = amount * buyIndices.length;
  const value = shares * end.v;
  const totalReturn = value / invested - 1;

  // Terminal cashflow = liquidate the whole position today.
  cashflows.push({ amount: value, date: end.t });
  const annualized = xirr(cashflows);

  return {
    mode: "dca",
    invested,
    value,
    shares,
    buyCount: buyIndices.length,
    totalReturn,
    annualized, // money-weighted XIRR
    annualizedMethod: "xirr",
    startUsed: series[buyIndices[0]].t,
    endDate: end.t,
    buyIndices,
    cashflows,
  };
}

export function compute(series, mode, amount, startDate) {
  return mode === "dca"
    ? computeDCA(series, amount, startDate)
    : computeLumpSum(series, amount, startDate);
}

// ---------------------------------------------------------------------------
// Chart helpers
// ---------------------------------------------------------------------------

// Portfolio value of a buy schedule as of an arbitrary date.
// buyIndices index into `series`; each buy spends `amount`. Price as-of `date`
// is the last close on/before that date.
export function valueOnDate(series, buyIndices, amount, date) {
  const target = toUTCDate(date).getTime();
  const priceIdx = lastIndexOnOrBefore(series, date);
  if (priceIdx === -1) return { value: 0, invested: 0 };
  const price = series[priceIdx].v;
  let shares = 0;
  let buys = 0;
  for (const i of buyIndices) {
    if (series[i].t.getTime() <= target) {
      shares += amount / series[i].v;
      buys += 1;
    } else {
      break; // buyIndices are ascending
    }
  }
  return { value: shares * price, invested: amount * buys };
}

// Monthly-sampled chart series for the chosen plan.
// -> [{ t: Date, value: Number, invested: Number }]
export function buildChartSeries(series, result, amount) {
  if (!result || !result.buyIndices.length) return [];
  const buyIndices = result.buyIndices;
  const startT = series[buyIndices[0]].t;
  const end = series[series.length - 1].t;

  const samples = [];
  let cursor = new Date(
    Date.UTC(startT.getUTCFullYear(), startT.getUTCMonth(), startT.getUTCDate())
  );
  while (cursor.getTime() < end.getTime()) {
    const { value, invested } = valueOnDate(series, buyIndices, amount, cursor);
    samples.push({ t: new Date(cursor.getTime()), value, invested });
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1)
    );
  }
  // Always include the final point.
  const last = valueOnDate(series, buyIndices, amount, end);
  samples.push({ t: new Date(end.getTime()), value: last.value, invested: last.invested });
  return samples;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtMoney(n, opts = {}) {
  if (!Number.isFinite(n)) return "—";
  const { decimals = 0 } = opts;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(n, decimals = 1) {
  if (!Number.isFinite(n)) return "—";
  return (n * 100).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }) + "%";
}
