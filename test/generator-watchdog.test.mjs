import test from "node:test";
import assert from "node:assert/strict";
import { planWatchdog } from "../lib/generator/watchdog.js";

const T0 = Date.parse("2026-11-12T18:00:00Z");
const at = (min) => new Date(T0 + min * 60000).toISOString();
const ev = (action, min) => ({ action, created_at: at(min) });

test("start: confirmed when running; not confirmed after 10 min of no generator", () => {
  const cfg = { force_on: true, force_until: at(30), force_max_run_min: 30 };
  assert.deepEqual(planWatchdog({ cfg, running: true, now: at(3), events: [] }).actions.map(a => a.action), ["start_confirmed"]);
  assert.deepEqual(planWatchdog({ cfg, running: false, now: at(5), events: [] }).actions, []);
  const late = planWatchdog({ cfg, running: false, now: at(11), events: [] });
  assert.equal(late.actions[0].action, "start_not_confirmed");
  assert.equal(late.actions[0].alert, true);
  assert.deepEqual(planWatchdog({ cfg, running: false, now: at(12), events: [ev("start_not_confirmed", 11)] }).actions, []);
});

test("stop: confirmed 5 min after the end when off; forced Off when still running, re-alerted every 5 min", () => {
  const events = [ev("cron_force_end", 0)];
  assert.deepEqual(planWatchdog({ running: false, now: at(2), events }).actions, []);
  assert.deepEqual(planWatchdog({ running: false, now: at(5), events }).actions.map(a => a.action), ["stop_confirmed"]);
  assert.equal(planWatchdog({ running: true, now: at(3), events }).forceOff, false);
  const w = planWatchdog({ running: true, now: at(5), events });
  assert.equal(w.forceOff, true);
  assert.equal(w.actions[0].action, "watchdog_stop_sent");
  const w2 = planWatchdog({ running: true, now: at(7), events: [ev("watchdog_stop_sent", 5), ...events] });
  assert.equal(w2.forceOff, true); assert.deepEqual(w2.actions, []);
  assert.equal(planWatchdog({ running: true, now: at(10), events: [ev("watchdog_stop_sent", 5), ...events] }).actions[0].attempt, 2);
  // Once seen off after the forced Off: confirmed, Off released.
  const off = planWatchdog({ running: false, now: at(8), events: [ev("watchdog_stop_sent", 5), ...events] });
  assert.equal(off.actions[0].action, "stop_confirmed"); assert.equal(off.forceOff, false);
});

test("stop: Return to automatic is left to the inverter; nothing after an hour or after a new start", () => {
  assert.equal(planWatchdog({ running: true, now: at(10), events: [ev("control_auto", 0)] }).forceOff, false);
  assert.deepEqual(planWatchdog({ running: true, now: at(61), events: [ev("control_end", 0)] }).actions, []);
  assert.equal(planWatchdog({ running: true, now: at(10), events: [ev("control_start", 2), ev("control_end", 0)] }).forceOff, false);
});
