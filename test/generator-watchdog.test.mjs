import test from "node:test";
import assert from "node:assert/strict";
import { planWatchdog } from "../lib/generator/watchdog.js";

const T0 = Date.parse("2026-11-12T18:00:00Z");
const at = (min) => new Date(T0 + min * 60000).toISOString();
const ev = (action, min) => ({ action, created_at: at(min) });
const acts = (r) => r.actions.map(a => a.action);
const OFF = { w: 0, v: 0 }, IDLE = { w: 0, v: 121 }, CHG = { w: 5000, v: 120 };

test("start: voltage = started, power = charging; alerts when neither, or voltage without charging", () => {
  const cfg = { force_on: true, force_until: at(60), force_max_run_min: 60 };
  assert.deepEqual(acts(planWatchdog({ cfg, reading: IDLE, now: at(2), events: [] })), ["start_confirmed"]);
  assert.deepEqual(acts(planWatchdog({ cfg, reading: CHG, now: at(4), events: [ev("start_confirmed", 2)] })), ["charge_confirmed"]);
  assert.deepEqual(acts(planWatchdog({ cfg, reading: OFF, now: at(11), events: [] })), ["start_not_confirmed"]);
  assert.deepEqual(acts(planWatchdog({ cfg, reading: IDLE, now: at(10), events: [ev("start_confirmed", 2)] })), []);
  const nc = planWatchdog({ cfg, reading: IDLE, now: at(15), events: [ev("start_confirmed", 2)] });
  assert.deepEqual(acts(nc), ["charge_not_confirmed"]); assert.equal(nc.actions[0].alert, true);
});

test("end: charging stops, generator cools down with voltage, then confirmed off; no forcing during the cool-down", () => {
  const e = [ev("cron_force_end", 0)];
  assert.deepEqual(acts(planWatchdog({ reading: IDLE, now: at(2), events: e })), ["charge_stop_confirmed"]);
  const cool = planWatchdog({ reading: IDLE, now: at(10), events: [ev("charge_stop_confirmed", 2), ...e] });
  assert.equal(cool.forceOff, false); assert.deepEqual(acts(cool), []);
  assert.deepEqual(acts(planWatchdog({ reading: OFF, now: at(12), events: [ev("charge_stop_confirmed", 2), ...e] })), ["stop_confirmed"]);
});

test("end: still charging at 5 min -> forced Off; voltage still there at 15 min -> forced Off; held until off", () => {
  const e = [ev("cron_force_end", 0)];
  assert.equal(planWatchdog({ reading: CHG, now: at(4), events: e }).forceOff, false);
  const f = planWatchdog({ reading: CHG, now: at(5), events: e });
  assert.equal(f.forceOff, true); assert.equal(f.actions[0].reason, "charging");
  const v = planWatchdog({ reading: IDLE, now: at(15), events: [ev("charge_stop_confirmed", 3), ...e] });
  assert.equal(v.forceOff, true); assert.equal(v.actions[0].reason, "voltage");
  const held = planWatchdog({ reading: IDLE, now: at(17), events: [ev("watchdog_stop_sent", 15), ev("charge_stop_confirmed", 3), ...e] });
  assert.equal(held.forceOff, true); assert.deepEqual(acts(held), []);
  assert.equal(planWatchdog({ reading: IDLE, now: at(20), events: [ev("watchdog_stop_sent", 15), ...e] }).actions.find(a => a.action === "watchdog_stop_sent").attempt, 2);
  const done = planWatchdog({ reading: OFF, now: at(21), events: [ev("watchdog_stop_sent", 15), ...e] });
  assert.ok(acts(done).includes("stop_confirmed")); assert.equal(done.forceOff, false);
});

test("end: Return to automatic is left alone; nothing after an hour or after a new start", () => {
  assert.equal(planWatchdog({ reading: CHG, now: at(10), events: [ev("control_auto", 0)] }).forceOff, false);
  assert.deepEqual(acts(planWatchdog({ reading: CHG, now: at(61), events: [ev("control_end", 0)] })), []);
  assert.equal(planWatchdog({ reading: CHG, now: at(10), events: [ev("control_start", 2), ev("control_end", 0)] }).forceOff, false);
});
