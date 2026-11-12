import test from "node:test";
import assert from "node:assert/strict";
import { desiredSettings, planResync } from "../lib/generator/resync.js";

const inv = (autoId, regs) => ({ autoId, regs });

test("desiredSettings: Run now vs normal", () => {
  assert.deepEqual(desiredSettings({ force_on: true, force_max_run_min: 30 }, true), { "2156": 1, "2136": 30, "212A": 100, "2129": 95 });
  assert.deepEqual(desiredSettings({ applied_ags: 0, saved_max_run_min: 0, applied_start_pct: 15, applied_stop_pct: 35 }, true), { "2156": 0, "2136": 0, "2129": 15, "212A": 35 });
  assert.deepEqual(desiredSettings({ applied_ags: 0 }, false), { "2156": 0 });
});

test("planResync: during a run, every inverter that differs is rewritten (stop before start, AGS last)", () => {
  const cfg = { force_on: true, force_max_run_min: 5 };
  const p = planResync({ cfg, socMode: true, inverters: [
    inv("m", { "2156": "1", "2136": "5", "2129": "95", "212A": "100" }),
    inv("a", { "2156": "0", "2136": "0", "2129": "95", "212A": "35" }),
    inv("b", { "2156": "1", "2136": "5", "2129": "95", "212A": "100" }),
  ] });
  assert.deepEqual(p.writes.map(w => [w.autoId, w.code, w.value]), [["a", "2136", 5], ["a", "212A", 100], ["a", "2156", 1]]);
  assert.equal(p.allMatch, false);
});

test("planResync: outside a run, a portal change on the master is adopted and copied, not fought", () => {
  const cfg = { applied_ags: 0, applied_start_pct: 15, applied_stop_pct: 35 };
  const regs = { "2156": "2", "2129": "15", "212A": "35" };
  const p = planResync({ cfg, socMode: true, inverters: [inv("m", regs), inv("a", { "2156": "0", "2129": "15", "212A": "35" })] });
  assert.deepEqual(p.adopt, { "2156": 2 });
  assert.deepEqual(p.writes.map(w => [w.autoId, w.code, w.value]), [["a", "2156", 2]]);
  // Right after an app write, the master is rewritten instead.
  const q = planResync({ cfg, socMode: true, recentAppWrite: true, inverters: [inv("m", regs)] });
  assert.deepEqual(q.writes.map(w => [w.code, w.value]), [["2156", 0]]);
});

test("planResync: lowering start/stop writes start first; all matching = allMatch", () => {
  const cfg = { applied_ags: 0, applied_start_pct: 15, applied_stop_pct: 35 };
  const p = planResync({ cfg, socMode: true, recentAppWrite: true, inverters: [inv("m", { "2156": "0", "2129": "95", "212A": "100" })] });
  assert.deepEqual(p.writes.map(w => w.code), ["2129", "212A"]);
  const ok = planResync({ cfg, socMode: true, inverters: [inv("m", { "2156": "0", "2129": "15", "212A": "35" })] });
  assert.equal(ok.allMatch, true);
});

import { planControl, restingAgs } from "../lib/generator/control.js";
test("AGS On is never a resting value: saved, restored, enforced or adopted as Auto instead", () => {
  assert.equal(restingAgs(1), 0); assert.equal(restingAgs(2), 2); assert.equal(restingAgs(null), null);
  // A start while the inverter was left On saves Auto as the value to go back to.
  assert.equal(planControl("start", { runMin: 5, current2136: "0", current2156: "1" }).saveAgs, 0);
  // An end with saved On goes back to Auto.
  assert.equal(planControl("end", { saved: 0, savedAgs: 1 }).ags, 0);
  // Outside a run: applied On is enforced as Auto, and a master reading On is rewritten, never adopted.
  const p = planResync({ cfg: { applied_ags: 1 }, inverters: [inv("m", { "2156": "1" }), inv("a", { "2156": "1" })] });
  assert.deepEqual(p.adopt, {});
  assert.deepEqual(p.writes.map(w => [w.autoId, w.code, w.value]), [["m", "2156", 0], ["a", "2156", 0]]);
});
