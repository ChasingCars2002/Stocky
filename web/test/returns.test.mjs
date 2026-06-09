// returns.test.mjs — known-answer tests for the returns engine.
// Run: node test/returns.test.mjs

import {
  toUTCDate,
  buildSeries,
  firstIndexOnOrAfter,
  npv,
  xirr,
  cagr,
  monthlyBuyIndices,
  computeLumpSum,
  computeDCA,
} from "../src/returns.js";

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error("  ✗ FAIL:", msg);
  }
}

function near(a, b, eps, msg) {
  ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `${msg} (got ${a}, want ≈${b})`);
}

// Helper: build a flat/linear "d,a,p" rows array from dates and prices.
function rows(pairs) {
  return pairs.map(([d, v]) => ({ d, a: v, p: v }));
}

// Generate business-day dates between two YYYY-MM-DD (inclusive).
function businessDays(startStr, endStr) {
  const out = [];
  let d = toUTCDate(startStr);
  const end = toUTCDate(endStr);
  while (d.getTime() <= end.getTime()) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

// --- Case 1: Lump sum, price 100 -> 200 over ~1 year -----------------------
console.log("Case 1: lump sum doubling");
{
  const r = rows([
    ["2022-06-09", 100],
    ["2023-06-09", 200],
  ]);
  const s = buildSeries(r, "total");
  const res = computeLumpSum(s, 1000, toUTCDate("2022-06-09"));
  near(res.value, 2000, 1e-6, "value == 2000");
  near(res.totalReturn, 1.0, 1e-6, "totalReturn == 1.0");
  near(res.shares, 10, 1e-9, "shares == 10");
  near(res.annualized, 1.0, 0.02, "CAGR ≈ 1.0 over ~1y");
}

// --- Case 2: XIRR two-flow -------------------------------------------------
console.log("Case 2: XIRR two-flow");
{
  const cf = [
    { amount: -1000, date: toUTCDate("2022-01-01") },
    { amount: 2000, date: new Date(toUTCDate("2022-01-01").getTime() + 365 * 86400000) },
  ];
  const rate = xirr(cf);
  near(rate, 1.0, 1e-4, "xirr == 1.0");
  near(npv(rate, cf, cf[0].date), 0, 1e-4, "npv at solved rate ≈ 0");
}

// --- Case 3: DCA flat price ------------------------------------------------
console.log("Case 3: DCA flat price");
{
  // 13 monthly points, all at price 100, on the 1st of each month.
  const pairs = [];
  for (let i = 0; i < 13; i++) {
    const dt = new Date(Date.UTC(2022, i, 1));
    pairs.push([dt.toISOString().slice(0, 10), 100]);
  }
  const s = buildSeries(rows(pairs), "total");
  const res = computeDCA(s, 50, toUTCDate("2022-01-01"));
  ok(res.buyCount === 13, `13 buys (got ${res.buyCount})`);
  near(res.invested, 650, 1e-9, "invested == 650");
  near(res.value, res.invested, 1e-6, "value == invested");
  near(res.totalReturn, 0, 1e-9, "totalReturn == 0");
  near(res.annualized, 0, 1e-4, "XIRR ≈ 0");
}

// --- Case 4: DCA rising ----------------------------------------------------
console.log("Case 4: DCA rising");
{
  const pairs = [];
  for (let i = 0; i < 24; i++) {
    const dt = new Date(Date.UTC(2021, i, 1));
    pairs.push([dt.toISOString().slice(0, 10), 100 + i * 5]); // monotonically rising
  }
  const s = buildSeries(rows(pairs), "total");
  const res = computeDCA(s, 100, toUTCDate("2021-01-01"));
  ok(res.value > res.invested, "value > invested on a rising series");
  ok(res.annualized > 0, "XIRR > 0");
  near(npv(res.annualized, res.cashflows, res.cashflows[0].date), 0, 1e-3, "npv(reportedXirr) ≈ 0");
}

// --- Case 5: Buy schedule across Jan–Mar 2023 ------------------------------
console.log("Case 5: buy schedule (weekend roll-forward)");
{
  const ds = businessDays("2023-01-01", "2023-03-31");
  const s = buildSeries(rows(ds.map((d) => [d, 100])), "total");
  const idxs = monthlyBuyIndices(s, toUTCDate("2023-01-01"));
  ok(idxs.length === 3, `3 buys total (got ${idxs.length})`);
  // Jan 1 2023 is a Sunday -> first buy rolls to 2023-01-02.
  ok(s[idxs[0]].t.toISOString().slice(0, 10) === "2023-01-02", "first buy 2023-01-02");
  // Feb 1 2023 is a Wednesday -> 2023-02-01.
  ok(s[idxs[1]].t.toISOString().slice(0, 10) === "2023-02-01", "second buy 2023-02-01");
  // Mar 1 2023 is a Wednesday -> 2023-03-01.
  ok(s[idxs[2]].t.toISOString().slice(0, 10) === "2023-03-01", "third buy 2023-03-01");
}

// --- Case 6: Mid-month start -----------------------------------------------
console.log("Case 6: mid-month start");
{
  const ds = businessDays("2023-01-01", "2023-03-31");
  const s = buildSeries(rows(ds.map((d) => [d, 100])), "total");
  const idxs = monthlyBuyIndices(s, toUTCDate("2023-01-15"));
  ok(s[idxs[0]].t.toISOString().slice(0, 10) === "2023-02-01", "first buy 2023-02-01 (mid-month -> next month)");
}

// --- Extra: sanity on helpers ----------------------------------------------
console.log("Extra: helper sanity");
{
  const s = buildSeries(rows([["2020-01-01", 1], ["2020-02-01", 2], ["2020-03-01", 3]]), "total");
  ok(firstIndexOnOrAfter(s, toUTCDate("2020-01-15")) === 1, "firstIndexOnOrAfter mid -> 1");
  ok(firstIndexOnOrAfter(s, toUTCDate("2020-02-01")) === 1, "firstIndexOnOrAfter exact -> 1");
  ok(firstIndexOnOrAfter(s, toUTCDate("2020-04-01")) === -1, "firstIndexOnOrAfter past end -> -1");
  near(cagr(100, 200, toUTCDate("2022-01-01"), toUTCDate("2023-01-01")), 1.0, 0.01, "cagr doubling ≈ 1.0");
}

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
