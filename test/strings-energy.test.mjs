// Run with: node --test
// Per-string energy math, underperformer flags, label validation, CSV parse and the collect path (mocked).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMpptDay, etodayFromRows, flagUnderperformers, summarizeEnergy, validateLabel, rowsToStore, dateRange, nightlyDue, wallMinutes,
} from "../lib/strings/energy.js";
import { parseDayExcelCsv } from "../lib/midniteServer.js";
import { collectDay, runPool, canAccessSite } from "../lib/strings/server.js";

const row = (hhmm, w1 = 0, w2 = 0, w3 = 0, extra = {}) => ({ ts: `2026-11-10 ${hhmm}:00`, mppt1W: w1, mppt2W: w2, mppt3W: w3, mppt1V: w1 ? 400 : 0, mppt2V: w2 ? 380 : 0, mppt3V: 0, ...extra });

test("computeMpptDay: trapezoid over real timestamps", () => {
  // 1000 W flat for an hour at 5-min steps = 1 kWh. MPPT2 ramps 0 -> 1200 W over 60 min = 0.6 kWh.
  const rows = [];
  for (let m = 0; m <= 60; m += 5) rows.push(row(`${10 + Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`, 1000, m * 20));
  const [a, b, c] = computeMpptDay(rows);
  assert.equal(a.kwh, 1);
  assert.equal(b.kwh, 0.6);
  assert.equal(a.peak_w, 1000);
  assert.equal(b.peak_w, 1200);
  assert.equal(a.peak_v, 400);
  assert.equal(a.samples, 13);
  assert.equal(b.samples, 12); // the 0 W sample is not producing
  assert.equal(c.kwh, 0);
  assert.equal(c.active, false);
});

test("computeMpptDay: gaps over 15 min are not bridged; unsorted input is sorted; negatives clamp", () => {
  const rows = [row("12:00", 1000), row("10:00", 1000), row("10:10", 1000), row("12:10", -50)];
  const [a] = computeMpptDay(rows);
  // 10:00-10:10 = 1000 W x 10 min = 166.67 Wh; 10:10-12:00 gap skipped; 12:00-12:10 = (1000+0)/2 x 10 min = 83.33 Wh.
  assert.equal(a.kwh, 0.25);
  // A 15-minute gap IS bridged.
  const [b] = computeMpptDay([row("10:00", 600), row("10:15", 600)]);
  assert.equal(b.kwh, 0.15);
});

test("etodayFromRows: max of the cumulative column, null when absent", () => {
  assert.equal(etodayFromRows([{ eToday: 1.2 }, { eToday: 8.4 }, { eToday: 8.1 }]), 8.4);
  assert.equal(etodayFromRows([{}, { eToday: "x" }]), null);
});

test("rowsToStore: active MPPTs, plus a dead string that was active before", () => {
  const comp = computeMpptDay([row("10:00", 500), row("10:05", 500)]);
  const keep = rowsToStore("SN1", "2026-11-10", comp, { siteKey: "SN1", etoday: 3 });
  assert.deepEqual(keep.map((r) => r.mppt), [1]);
  assert.equal(keep[0].inverter_etoday, 3);
  const keep2 = rowsToStore("SN1", "2026-11-10", comp, { everActive: new Set(["SN1:2"]) });
  assert.deepEqual(keep2.map((r) => [r.mppt, r.kwh]), [[1, 0.042], [2, 0]]);
});

test("flagUnderperformers: kWh/kW basis when all sized, raw kWh otherwise", () => {
  const rows = [];
  for (let d = 1; d <= 9; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    rows.push({ sn: "A", mppt: 1, day, kwh: 20 }, { sn: "A", mppt: 2, day, kwh: 10 }, { sn: "B", mppt: 1, day, kwh: d >= 3 ? 12 : 30 });
  }
  // Raw: A1=140, A2=70, B1=84 over the last 7 days (3..9). Median 84; A2 is 16.7% below.
  const raw = flagUnderperformers(rows);
  assert.equal(raw.basis, "kwh");
  assert.deepEqual(raw.window, { from: "2026-11-03", to: "2026-11-09", days: 7 });
  const by = Object.fromEntries(raw.strings.map((s) => [`${s.sn}:${s.mppt}`, s]));
  assert.equal(by["A:2"].flagged, true);
  assert.equal(Math.round(by["A:2"].pctBelow * 1000), 167);
  assert.equal(by["B:1"].flagged, false);
  // Sized: A1 8 kW, A2 4 kW, B1 6 kW -> 17.5, 17.5, 14 kWh/kW. B1 is 20% below 17.5.
  const sized = flagUnderperformers(rows, { sizes: { "A:1": 8, "A:2": 4, "B:1": 6 } });
  assert.equal(sized.basis, "kwh_per_kw");
  const s2 = Object.fromEntries(sized.strings.map((s) => [`${s.sn}:${s.mppt}`, s]));
  assert.equal(s2["B:1"].flagged, true);
  assert.equal(s2["A:2"].flagged, false);
  // One string: nothing to compare.
  assert.equal(flagUnderperformers([{ sn: "A", mppt: 1, day: "2026-11-01", kwh: 5 }]).strings[0].flagged, false);
});

test("summarizeEnergy: totals, share, per day/month, E-Today counted once per inverter-day", () => {
  const rows = [
    { sn: "A", mppt: 1, day: "2026-10-31", kwh: 6, inverter_etoday: 10, peak_w: 3000 },
    { sn: "A", mppt: 2, day: "2026-10-31", kwh: 4, inverter_etoday: 10, peak_w: 2000 },
    { sn: "A", mppt: 1, day: "2026-11-01", kwh: 5, inverter_etoday: 12 },
    { sn: "A", mppt: 2, day: "2026-11-01", kwh: 5, inverter_etoday: 12 },
  ];
  const s = summarizeEnergy(rows, { sizes: { "A:1": 5 } });
  assert.equal(s.total, 20);
  const a1 = s.strings.find((x) => x.mppt === 1);
  assert.equal(a1.kwh, 11);
  assert.equal(a1.kwh_per_kw, 2.2);
  assert.equal(a1.share, 0.55);
  assert.equal(a1.peak_w, 3000);
  assert.deepEqual(s.byDay.map((d) => [d.day, d.total, d.etoday, d["A:1"]]), [["2026-10-31", 10, 10, 6], ["2026-11-01", 10, 12, 5]]);
  assert.deepEqual(s.byMonth.map((m) => [m.month, m.total, m.etoday]), [["2026-10", 10, 10], ["2026-11", 10, 12]]);
  // 20 vs 22: 9.1% low, under the 10% note threshold.
  assert.equal(s.crossCheck.mismatch, false);
  assert.equal(Math.round(s.crossCheck.diffPct * 1000), -91);
  assert.equal(summarizeEnergy([{ ...rows[0], inverter_etoday: 20 }]).crossCheck.mismatch, true);
});

test("validateLabel: trim, 40 chars, empty clears, size range", () => {
  assert.deepEqual(validateLabel({ label: "  South roof  ", kw_dc: "6.4" }), { label: "South roof", kw_dc: 6.4 });
  assert.deepEqual(validateLabel({ label: "", kw_dc: "" }), { label: null, kw_dc: null });
  assert.ok(validateLabel({ label: "x".repeat(41) }).error);
  assert.ok(validateLabel({ label: "a", kw_dc: 0 }).error);
  assert.ok(validateLabel({ label: "a", kw_dc: 100.5 }).error);
  assert.deepEqual(validateLabel({ label: "a", kw_dc: 100 }), { label: "a", kw_dc: 100 });
});

test("dateRange and nightlyDue (site-local 1-5 AM, local yesterday)", () => {
  assert.deepEqual(dateRange("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  // 06:15 UTC = 01:15 EST on Nov 12.
  assert.deepEqual(nightlyDue(new Date("2026-11-12T06:15:00Z")), { due: true, hour: 1, yesterday: "2026-11-11" });
  assert.equal(nightlyDue(new Date("2026-11-12T12:15:00Z")).due, false);
  assert.equal(nightlyDue(new Date("2026-11-12T06:15:00Z"), "America/Los_Angeles").due, false); // 22:15 PST
  assert.equal(wallMinutes("bad"), null);
});

test("parseDayExcelCsv: preamble, header by name, V/A/W cells, E-Today", () => {
  const csv = [
    '"Account","Dotsikas"', '"Model","MN15"', '"SN","SN1"', '',
    '"Time","MPPT1","MPPT2","MPPT3","PV","Temperature","E-Today"',
    '"2026-11-10 10:00:00","412.5V/7.20A/2970W","380V/0.00A/0W","0V/0A/0W","2.97KW","41℃","3.10kWh"',
    '"2026-11-10 10:05:00","413V/7.30A/3015W","381V/1.00A/381W","0V/0A/0W","3.40KW","41℃","3.35kWh"',
  ].join("\r\n");
  const { rows, header } = parseDayExcelCsv(csv);
  assert.equal(header[0], "Time");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, "2026-11-10 10:00:00");
  assert.equal(rows[0].mppt1V, 412.5);
  assert.equal(rows[0].mppt1A, 7.2);
  assert.equal(rows[1].mppt2W, 381);
  assert.equal(rows[1].pvW, 3396);
  assert.equal(rows[1].eToday, 3.35);
});

test("collectDay: fetch -> compute -> upsert (mocked)", async () => {
  const upserts = [];
  const sb = { from: () => ({ upsert: async (rows, opts) => { upserts.push({ rows, opts }); return { error: null }; } }) };
  const fetchDayExcel = async (memberId, sn, day) => {
    assert.deepEqual([memberId, sn, day], ["Site", "SN1", "2026-11-10"]);
    return { rows: [row("10:00", 1200, 0, 0, { eToday: 0.1 }), row("10:05", 1200, 0, 0, { eToday: 0.2 })] };
  };
  const r = await collectDay({ sb, memberId: "Site", sn: "SN1", day: "2026-11-10", siteKey: "SN1" }, { fetchDayExcel });
  assert.equal(r.stored, 1);
  assert.equal(upserts[0].opts.onConflict, "sn,day,mppt");
  assert.equal(upserts[0].rows[0].kwh, 0.1);
  assert.equal(upserts[0].rows[0].inverter_etoday, 0.2);
  const d = await collectDay({ sb, memberId: "Site", sn: "SN1", day: "2026-11-10", dry: true }, { fetchDayExcel });
  assert.equal(d.stored, 0);
  assert.equal(upserts.length, 1);
});

test("runPool: deadline leaves jobs for the retry", async () => {
  const jobs = [1, 2, 3].map((n) => ({ n, run: async () => n * 2 }));
  const ok = await runPool(jobs, { concurrency: 2 });
  assert.equal(ok.results.length, 3);
  const late = await runPool(jobs, { deadline: Date.now() - 1 });
  assert.equal(late.skipped.length, 3);
});

// Minimal Supabase stub: from(table) -> chainable filters, resolved with rows from `tables`.
function stubSb(tables) {
  return {
    from(t) {
      const filters = [];
      const q = {
        select() { return q; }, order() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        maybeSingle: async () => ({ data: (tables[t] || []).filter((r) => filters.every((f) => f(r)))[0] || null }),
        then(res) { return Promise.resolve({ data: (tables[t] || []).filter((r) => filters.every((f) => f(r))) }).then(res); },
      };
      return q;
    },
  };
}

test("canAccessSite: owner, share recipient (name must match), admin, refused", async () => {
  const site = { MemberID: "Wise Naples", GoodsID: [{ GoodsID: "A" }, { GoodsID: "B" }] };
  const find = async (acct, key) => (acct.holds === key ? { auth: { a: 1 }, site } : null);
  const tables = {
    midnite_accounts: [{ id: "own", user_id: "u1", holds: "A,B" }, { id: "oa", user_id: "owner", holds: "A,B" }],
    site_shares: [{ shared_with_user_id: "u2", status: "active", owner_account_id: "oa", site_name: "Wise Naples" },
      { shared_with_user_id: "u3", status: "active", owner_account_id: "oa", site_name: "Other" }],
  };
  const sb = stubSb(tables);
  assert.equal((await canAccessSite(sb, { id: "u1" }, "user", "A,B", {}, { findSiteInAccount: find })).role, "owner");
  assert.equal((await canAccessSite(sb, { id: "u2" }, "user", "A,B", {}, { findSiteInAccount: find })).role, "shared");
  await assert.rejects(canAccessSite(sb, { id: "u3" }, "user", "A,B", {}, { findSiteInAccount: find }), /access/);
  const adm = await canAccessSite(sb, { id: "u9" }, "admin", "A,B", { accountId: "oa" }, { findSiteInAccount: find });
  assert.equal(adm.role, "admin");
  assert.ok(adm.site);
});
