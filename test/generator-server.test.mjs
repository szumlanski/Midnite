// Run with: node --test
// History aggregation, the control planner, the register allow-list and writeShadow (mocked: no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRuns } from "../lib/generator/history.js";
import { planControl } from "../lib/generator/control.js";
import { validateGenWrites, GEN_WRITABLE, GEN_READ_CODES, genWiring } from "../lib/generator/registers.js";
import { writeShadow, readShadow } from "../lib/midniteServer.js";

test("summarizeRuns: totals, daily split across midnight, monthly, open runs", () => {
  const now = new Date("2026-11-11T17:00:00Z"); // 12:00 EST
  const runs = [
    // Nov 10 23:00 EST -> Nov 11 01:00 EST (crosses midnight): 1h each day.
    { id: 1, started_at: "2026-11-11T04:00:00Z", ended_at: "2026-11-11T06:00:00Z", source: "auto" },
    // Open run started 30 min ago.
    { id: 2, started_at: "2026-11-11T16:30:00Z", ended_at: null, source: "force" },
    // Old run, two months back.
    { id: 3, started_at: "2026-09-15T12:00:00Z", ended_at: "2026-09-15T12:30:00Z", source: "schedule" },
  ];
  const h = summarizeRuns(runs, { tz: "America/New_York", now, days: 3, months: 3 });
  assert.equal(h.totals.all.sec, 7200 + 1800 + 1800);
  assert.equal(h.totals.all.runs, 3);
  assert.equal(h.totals.day.sec, 7200 + 1800);
  assert.equal(h.totals.week.runs, 2);
  assert.deepEqual(h.daily.map(d => d.date), ["2026-11-09", "2026-11-10", "2026-11-11"]);
  assert.equal(h.daily[1].sec, 3600);
  assert.equal(h.daily[1].runs, 1);
  assert.equal(h.daily[2].sec, 3600 + 1800);
  assert.equal(h.daily[2].runs, 1);
  assert.equal(h.daily[2].bySource.force, 1800);
  assert.deepEqual(h.monthly.map(m => [m.month, m.sec, m.runs]), [["2026-09", 1800, 1], ["2026-10", 0, 0], ["2026-11", 9000, 2]]);
  assert.equal(h.runs[0].id, 2);
  assert.equal(h.runs[0].open, true);
  assert.equal(h.runs[0].duration_sec, 1800);
});

test("summarizeRuns: a 25-hour fall-back day is split at the real midnight", () => {
  const h = summarizeRuns([{ started_at: "2026-11-01T04:00:00Z", ended_at: "2026-11-02T05:00:00Z", source: "auto" }],
    { tz: "America/New_York", now: new Date("2026-11-02T12:00:00Z"), days: 2, months: 1 });
  assert.deepEqual(h.daily.map(d => [d.date, d.sec]), [["2026-11-01", 25 * 3600], ["2026-11-02", 0]]);
});

test("planControl start: saves the inverter's 2136 once, caps, then AGS On", () => {
  const now = new Date("2026-11-11T15:00:00Z");
  const p = planControl("start", { runMin: 90, targetPct: 80, current2136: "0", saved: null, now });
  assert.deepEqual(p.steps.map(s => [s.code, s.value]), [["2136", 90], ["2156", 1]]);
  assert.equal(p.saveMaxRun, 0);
  assert.equal(p.force.force_until, "2026-11-11T16:30:00.000Z");
  assert.equal(p.force.force_target_pct, 80);
  // Second Run now while forced: keep the original saved value, not the previous cap.
  assert.equal(planControl("start", { runMin: 30, current2136: "90", saved: 0 }).saveMaxRun, 0);
  assert.match(planControl("start", { runMin: 0 }).error, /runMin/);
  assert.match(planControl("start", { runMin: 10, targetPct: 101 }).error, /targetPct/);
  assert.match(planControl("bogus", {}).error, /op/);
});

test("planControl stop/auto: AGS first, then restore 2136", () => {
  assert.deepEqual(planControl("stop", { saved: 0 }).steps.map(s => [s.code, s.value]), [["2156", 2], ["2136", 0]]);
  assert.deepEqual(planControl("auto", { saved: 240 }).steps.map(s => [s.code, s.value]), [["2156", 0], ["2136", 240]]);
  const noSaved = planControl("stop", { saved: null });
  assert.deepEqual(noSaved.steps.map(s => s.code), ["2156"]);
  assert.equal(noSaved.clearSaved, false);
  assert.equal(planControl("stop", { saved: 0 }).force.force_on, false);
});

test("validateGenWrites: allow-list and ranges", () => {
  assert.deepEqual(validateGenWrites({ "2156": 1, "2136": "30" }), { ModbusArr: { "2156": "1", "2136": "30" }, bad: [] });
  assert.equal(validateGenWrites({ "2122": 1 }).bad.length, 1);       // Gen Port: never writable
  assert.equal(validateGenWrites({ "2156": 3 }).bad.length, 1);       // out of range
  assert.equal(validateGenWrites({ "2156": "" }).bad.length, 1);
  assert.equal(validateGenWrites({ "toString": 1 }).bad.length, 1);
  assert.equal(validateGenWrites({ "2154": 23 * 256 + 59 }).bad.length, 0);
  assert.equal(validateGenWrites({ "2154": 24 * 256 }).bad.length, 1);
  assert.ok(!("2122" in GEN_WRITABLE) && !("219B" in GEN_WRITABLE));
});

// A fake Midnite API: records calls, applies writes after `applyAfterPolls` result polls.
function fakeApi({ initial = {}, applyAfterPolls = 1, failWrite = false, neverApply = false } = {}) {
  const regs = { ...initial };
  const calls = [];
  let pending = null, polls = 0;
  const post = async (path, body) => {
    calls.push({ path, body });
    if (path.endsWith("readDeviceShadow_RA_New_AutoID")) {
      const codes = JSON.parse(body.ModbusArr);
      return { status: true, data: { data: Object.fromEntries(codes.filter(c => c in regs).map(c => [c, regs[c]])) } };
    }
    if (path.endsWith("setDeviceShadow_WA_New_AutoID")) {
      if (failWrite) throw new Error("Midnite 500: boom");
      pending = JSON.parse(body.ModbusArr); polls = 0;
      return { status: true, RequestId: "req-1" };
    }
    if (path.endsWith("getDeviceShadowResult")) {
      polls++;
      if (!neverApply && polls >= applyAfterPolls && pending) { Object.assign(regs, pending); const r = { status: true, result: JSON.stringify(pending) }; pending = null; return { data: { "req-1": r } }; }
      return { data: { "req-1": { status: false } } };
    }
    throw new Error("unexpected path " + path);
  };
  return { post, calls, regs };
}
const auth = { token: "t" };
const noSleep = async () => {};

test("writeShadow: read before, write, poll, read back, verified", async () => {
  const api = fakeApi({ initial: { "2156": "0", "2136": "0" }, applyAfterPolls: 2 });
  const r = await writeShadow(auth, { autoId: 51400, writes: { "2156": 1 } }, { post: api.post, sleep: noSleep });
  assert.equal(r.verified, true);
  assert.equal(r.before["2156"], "0");
  assert.equal(r.after["2156"], "1");
  assert.deepEqual(api.calls.map(c => c.path.split("/").pop()), [
    "readDeviceShadow_RA_New_AutoID", "setDeviceShadow_WA_New_AutoID", "getDeviceShadowResult", "getDeviceShadowResult", "readDeviceShadow_RA_New_AutoID",
  ]);
  const w = api.calls[1].body;
  assert.equal(w.AutoId, "51400");
  assert.deepEqual(JSON.parse(w.ModbusArr), { "2156": "1" });
  assert.ok(w.sign);
  assert.deepEqual(JSON.parse(api.calls[2].body.RequestId), ["req-1"]);
});

test("writeShadow: refuses codes outside the allow-list before any call", async () => {
  const api = fakeApi();
  await assert.rejects(writeShadow(auth, { autoId: 1, writes: { "2122": 0 } }, { post: api.post, sleep: noSleep }), (e) => e.code === 400 && /not an allowed/.test(e.message));
  await assert.rejects(writeShadow(auth, { autoId: 1, writes: { "2156": 1, "2124": 1 } }, { post: api.post, sleep: noSleep }), /2124/);
  await assert.rejects(writeShadow(auth, { autoId: 1, writes: {} }, { post: api.post, sleep: noSleep }), /no writes/);
  await assert.rejects(writeShadow(auth, { writes: { "2156": 1 } }, { post: api.post, sleep: noSleep }), /autoId/);
  assert.equal(api.calls.length, 0);
});

test("writeShadow: gives up after 10 polls and reports not verified", async () => {
  const api = fakeApi({ initial: { "2156": "0" }, neverApply: true });
  const r = await writeShadow(auth, { autoId: 1, writes: { "2156": 2 } }, { post: api.post, sleep: noSleep });
  assert.equal(r.verified, false);
  assert.equal(r.result, null);
  assert.equal(api.calls.filter(c => c.path.endsWith("getDeviceShadowResult")).length, 10);
  assert.match(r.err, /no confirmation from the inverter.*2156=0/);
});

test("writeShadow: a failed write call returns err, no polling", async () => {
  const api = fakeApi({ initial: { "2156": "0" }, failWrite: true });
  const r = await writeShadow(auth, { autoId: 1, writes: { "2156": 2 } }, { post: api.post, sleep: noSleep });
  assert.equal(r.verified, false);
  assert.match(r.err, /write failed/);
  assert.equal(api.calls.length, 2);
});

test("readShadow sends Force:1 and returns the code map", async () => {
  const api = fakeApi({ initial: { "2136": "0" } });
  assert.deepEqual(await readShadow(auth, 51400, ["2136", "2156"], { post: api.post }), { "2136": "0" });
  assert.equal(api.calls[0].body.Force, 1);
});

test("genWiring: 213F location and 2100 off-grid, both read-only", () => {
  assert.deepEqual(genWiring({ "213F": "1", "2100": "3" }), { genLocation: "grid", offGrid: true });
  assert.deepEqual(genWiring({ "213F": 0, "2100": 0 }), { genLocation: "gen_port", offGrid: false });
  assert.deepEqual(genWiring({}), { genLocation: null, offGrid: null });
  assert.ok(GEN_READ_CODES.includes("213F") && GEN_READ_CODES.includes("2100"));
  assert.equal(validateGenWrites({ "213F": 1 }).bad.length, 1);
  assert.equal(validateGenWrites({ "2100": 3 }).bad.length, 1);
});

test("planControl end: AGS back to its pre-run value, then restore 2136", () => {
  const start = planControl("start", { runMin: 60, current2136: "0", current2156: "2", saved: null, savedAgs: null });
  assert.equal(start.saveAgs, 2);
  // A second Run now during a run keeps the ORIGINAL pre-run AGS, not "On".
  assert.equal(planControl("start", { runMin: 30, current2136: "60", current2156: "1", saved: 0, savedAgs: 2 }).saveAgs, 2);
  assert.deepEqual(planControl("end", { saved: 0, savedAgs: 2 }).steps.map(s => [s.code, s.value]), [["2156", 2], ["2136", 0]]);
  assert.deepEqual(planControl("end", { saved: 0, savedAgs: 0 }).steps.map(s => [s.code, s.value]), [["2156", 0], ["2136", 0]]);
  // Nothing saved (no run in progress): fall back to Auto.
  assert.deepEqual(planControl("end", {}).steps.map(s => [s.code, s.value]), [["2156", 0]]);
  assert.equal(planControl("end", { saved: 0, savedAgs: 1 }).clearSaved, true);
});

test("planControl: SOC mode Run now sets 95/100 and the end puts the normal start/stop SOC back", () => {
  const p = planControl("start", { runMin: 60, current2136: "0", current2156: "0", socMode: true, current2129: "15", current212A: "35" });
  assert.deepEqual(p.steps.map(s => s.writes || { [s.code]: s.value }), [{ "2136": 60 }, { "2129": 95, "212A": 100 }, { "2156": 1 }]);
  assert.deepEqual(p.seedThresholds, { start: 15, stop: 35 });
  const e = planControl("end", { saved: 0, savedAgs: 0, socMode: true, normalStart: 15, normalStop: 35 });
  assert.deepEqual(e.steps.map(s => s.writes || { [s.code]: s.value }), [{ "2156": 0 }, { "2136": 0 }, { "2129": 15, "212A": 35 }]);
  // Voltage mode: SOC registers untouched.
  assert.equal(planControl("start", { runMin: 60, current2136: "0", current2156: "0", socMode: false }).steps.length, 2);
  // No run in progress (nothing saved): auto doesn't touch thresholds.
  assert.equal(planControl("auto", { socMode: true, normalStart: 15, normalStop: 35 }).steps.length, 1);
});
