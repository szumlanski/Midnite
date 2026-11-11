// Run with: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG, siteKeyOf, windowCoversMinute, activeSetpoint, overlappingPairs, evaluateGen,
  minToClock, minToInput, inputToMin, fmtDuration, fmtDays, localParts, zonedTimeToUtc, computeNextRun, validateWindow,
} from "../lib/generator/core.js";

const SUN = 0, FRI = 5, SAT = 6;
const w = (o) => ({ enabled: true, priority: 100, days_mask: 127, max_run_min: 0, ...o });

test("siteKeyOf sorts, dedupes and accepts GoodsID objects", () => {
  assert.equal(siteKeyOf(["b", "a", { GoodsID: "c" }, "a", ""]), "a,b,c");
});

test("windowCoversMinute: same-day window is [start, end)", () => {
  const win = w({ start_min: 360, end_min: 600 });
  assert.equal(windowCoversMinute(win, 359), false);
  assert.equal(windowCoversMinute(win, 360), true);
  assert.equal(windowCoversMinute(win, 599), true);
  assert.equal(windowCoversMinute(win, 600), false);
});

test("windowCoversMinute: midnight wrap, after-midnight part belongs to the start day", () => {
  const fri = w({ start_min: 22 * 60, end_min: 6 * 60, days_mask: 1 << FRI });
  assert.equal(windowCoversMinute(fri, 23 * 60, FRI), true);   // Fri 23:00
  assert.equal(windowCoversMinute(fri, 3 * 60, SAT), true);    // Sat 03:00 (Fri's window)
  assert.equal(windowCoversMinute(fri, 3 * 60, FRI), false);   // Fri 03:00 belongs to Thu
  assert.equal(windowCoversMinute(fri, 6 * 60, SAT), false);   // end is exclusive
  assert.equal(windowCoversMinute(fri, 12 * 60, FRI), false);
  const any = w({ start_min: 1380, end_min: 60 });
  assert.equal(windowCoversMinute(any, 0), true);
  assert.equal(windowCoversMinute(any, 1400), true);
  assert.equal(windowCoversMinute(any, 120), false);
});

test("windowCoversMinute: start == end covers the whole day", () => {
  const all = w({ start_min: 0, end_min: 0, days_mask: 1 << SUN });
  assert.equal(windowCoversMinute(all, 1439, SUN), true);
  assert.equal(windowCoversMinute(all, 0, SAT), false);
});

test("activeSetpoint: lowest priority wins on overlap, defaults otherwise", () => {
  const wins = [
    w({ id: "night", start_min: 1200, end_min: 360, start_pct: 30, stop_pct: 90, priority: 20 }),
    w({ id: "evening", start_min: 1080, end_min: 1320, start_pct: 40, stop_pct: 70, priority: 10 }),
  ];
  assert.equal(activeSetpoint(wins, 1250, SUN).window.id, "evening");
  assert.equal(activeSetpoint(wins, 1330, SUN).window.id, "night");
  const d = activeSetpoint(wins, 720, SUN, { default_start_pct: 15, default_stop_pct: 60 });
  assert.equal(d.source, "default");
  assert.equal(d.start_pct, 15);
  // Equal priority: earlier in the list wins.
  const tie = [w({ id: "a", start_min: 0, end_min: 0, start_pct: 1, stop_pct: 2 }), w({ id: "b", start_min: 0, end_min: 0, start_pct: 3, stop_pct: 4 })];
  assert.equal(activeSetpoint(tie, 5, SUN).window.id, "a");
  // Disabled windows are ignored.
  assert.equal(activeSetpoint([w({ id: "x", enabled: false, start_min: 0, end_min: 0, start_pct: 1, stop_pct: 2 })], 5, SUN).source, "default");
});

test("overlappingPairs reports overlap and the winner, respects day masks", () => {
  const a = w({ id: "a", start_min: 1200, end_min: 360, start_pct: 30, stop_pct: 90, priority: 20 });
  const b = w({ id: "b", start_min: 1080, end_min: 1320, start_pct: 40, stop_pct: 70, priority: 10 });
  const c = w({ id: "c", start_min: 600, end_min: 700, start_pct: 40, stop_pct: 70 });
  const pairs = overlappingPairs([a, b, c]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].winner.id, "b");
  const mon = w({ id: "m", start_min: 600, end_min: 700, days_mask: 2, start_pct: 1, stop_pct: 2 });
  const tue = w({ id: "t", start_min: 600, end_min: 700, days_mask: 4, start_pct: 1, stop_pct: 2 });
  assert.equal(overlappingPairs([mon, tue]).length, 0);
});

test("evaluateGen: hysteresis holds between start and stop", () => {
  const config = { ...DEFAULT_CONFIG, enabled: true, default_start_pct: 20, default_stop_pct: 80 };
  const base = { config, windows: [], minute: 600, dow: SUN, now: new Date("2026-11-11T15:00:00Z") };
  assert.equal(evaluateGen({ ...base, soc: 19, running: false }).run, true);
  assert.equal(evaluateGen({ ...base, soc: 20, running: false }).reason, "start_pct");
  assert.deepEqual([evaluateGen({ ...base, soc: 50, running: false }).run, evaluateGen({ ...base, soc: 50, running: false }).reason], [false, "hold_stopped"]);
  assert.deepEqual([evaluateGen({ ...base, soc: 50, running: true }).run, evaluateGen({ ...base, soc: 50, running: true }).reason], [true, "hold_running"]);
  assert.equal(evaluateGen({ ...base, soc: 80, running: true }).reason, "stop_pct");
});

test("evaluateGen: max run time ends a run", () => {
  const config = { ...DEFAULT_CONFIG, enabled: true, default_max_run_min: 60 };
  const now = new Date("2026-11-11T15:00:00Z");
  const r = evaluateGen({ config, soc: 40, running: true, runStartedAt: new Date(now - 61 * 60000), now, minute: 600, dow: 3 });
  assert.equal(r.reason, "max_run");
  assert.equal(r.run, false);
});

test("evaluateGen: force deadline and target", () => {
  const now = new Date("2026-11-11T15:00:00Z");
  const cfg = { ...DEFAULT_CONFIG, force_on: true, force_until: new Date(now.getTime() + 60000).toISOString() };
  // Force outranks a disabled master switch.
  assert.equal(evaluateGen({ config: cfg, soc: 95, now }).reason, "force");
  assert.equal(evaluateGen({ config: cfg, soc: 50, now: new Date(now.getTime() + 60000) }).reason, "force_deadline");
  assert.equal(evaluateGen({ config: cfg, soc: 50, now: new Date(now.getTime() + 60000) }).forceExpired, true);
  assert.equal(evaluateGen({ config: { ...cfg, force_target_pct: 60 }, soc: 60, now }).reason, "force_target");
  assert.equal(evaluateGen({ config: { ...cfg, force_target_pct: 60 }, soc: null, now }).reason, "force");
});

test("evaluateGen: disabled and comms lost", () => {
  assert.equal(evaluateGen({ config: { enabled: false }, soc: 5 }).run, null);
  assert.equal(evaluateGen({ config: { enabled: true, comms_lost_action: "stop" }, soc: null, running: true }).run, false);
  assert.equal(evaluateGen({ config: { enabled: true, comms_lost_action: "hold" }, soc: null, running: true }).run, true);
});

test("evaluateGen uses the window setpoint over defaults", () => {
  const config = { ...DEFAULT_CONFIG, enabled: true, default_start_pct: 20 };
  const windows = [w({ start_min: 1200, end_min: 360, start_pct: 50, stop_pct: 90 })];
  assert.equal(evaluateGen({ config, windows, soc: 45, running: false, minute: 1300, dow: SUN }).run, true);
  assert.equal(evaluateGen({ config, windows, soc: 45, running: false, minute: 720, dow: SUN }).run, false);
});

test("formatters", () => {
  assert.equal(minToClock(0), "12:00 AM");
  assert.equal(minToClock(365), "6:05 AM");
  assert.equal(minToClock(780), "1:00 PM");
  assert.equal(minToInput(365), "06:05");
  assert.equal(inputToMin("06:05"), 365);
  assert.equal(inputToMin("24:00"), null);
  assert.equal(inputToMin("nope"), null);
  assert.equal(fmtDuration(45), "45s");
  assert.equal(fmtDuration(720), "12m");
  assert.equal(fmtDuration(3900), "1h 05m");
  assert.equal(fmtDuration(97200), "1d 3h");
  assert.equal(fmtDays(127), "Every day");
  assert.equal(fmtDays(0b0111110), "Weekdays");
  assert.equal(fmtDays(0b0101010), "Mon, Wed, Fri");
});

test("validateWindow", () => {
  assert.equal(validateWindow({ start_min: 0, end_min: 60, start_pct: 20, stop_pct: 80 }), null);
  assert.match(validateWindow({ start_min: 0, end_min: 60, start_pct: 80, stop_pct: 20 }), /above/);
  assert.match(validateWindow({ start_min: 0, end_min: 2000, start_pct: 20, stop_pct: 80 }), /0-1439/);
  assert.match(validateWindow({ start_min: 0, end_min: 60, start_pct: 20, stop_pct: 80, days_mask: 0 }), /day/);
});

test("localParts and zonedTimeToUtc in New York", () => {
  const p = localParts(new Date("2026-07-04T16:30:00Z"), "America/New_York");
  assert.deepEqual([p.ymd, p.hour, p.minute, p.dow], ["2026-07-04", 12, 30, SAT]);
  assert.equal(zonedTimeToUtc(2026, 7, 4, 12, 30).toISOString(), "2026-07-04T16:30:00.000Z"); // EDT
  assert.equal(zonedTimeToUtc(2026, 1, 15, 8, 0).toISOString(), "2026-01-15T13:00:00.000Z");  // EST
  // Spring-forward gap (Mar 8 2026, 02:00 -> 03:00): 02:30 lands at 03:30 EDT.
  assert.equal(zonedTimeToUtc(2026, 3, 8, 2, 30).toISOString(), "2026-03-08T07:30:00.000Z");
  // Fall-back repeat (Nov 1 2026, 01:00-02:00 twice): picks the first (EDT) 01:30.
  assert.equal(zonedTimeToUtc(2026, 11, 1, 1, 30).toISOString(), "2026-11-01T05:30:00.000Z");
  // Just after fall-back.
  assert.equal(zonedTimeToUtc(2026, 11, 1, 3, 0).toISOString(), "2026-11-01T08:00:00.000Z");
});

test("computeNextRun: weekly exercise across the fall-back DST change", () => {
  const sched = { days_mask: 1 << SUN, time_local: "08:00" };
  // Sat Oct 31 2026 noon EDT -> Sun Nov 1 08:00 EST (13:00Z, not 12:00Z).
  assert.equal(computeNextRun(sched, "America/New_York", new Date("2026-10-31T16:00:00Z")).toISOString(), "2026-11-01T13:00:00.000Z");
  // The Sunday before is still EDT.
  assert.equal(computeNextRun(sched, "America/New_York", new Date("2026-10-24T16:00:00Z")).toISOString(), "2026-10-25T12:00:00.000Z");
  // Right after a run: next is a week later.
  assert.equal(computeNextRun(sched, "America/New_York", new Date("2026-11-01T13:00:00Z")).toISOString(), "2026-11-08T13:00:00.000Z");
});

test("computeNextRun: spring-forward and edge cases", () => {
  const sched = { days_mask: 1 << SUN, time_local: "08:00" };
  assert.equal(computeNextRun(sched, "America/New_York", new Date("2026-03-07T17:00:00Z")).toISOString(), "2026-03-08T12:00:00.000Z");
  // Later today still counts; earlier today rolls to the next selected day.
  const daily = { days_mask: 127, time_local: "18:00" };
  assert.equal(computeNextRun(daily, "America/New_York", new Date("2026-11-11T15:00:00Z")).toISOString(), "2026-11-11T23:00:00.000Z");
  assert.equal(computeNextRun(daily, "America/New_York", new Date("2026-11-11T23:30:00Z")).toISOString(), "2026-11-12T23:00:00.000Z");
  assert.equal(computeNextRun({ days_mask: 0, time_local: "08:00" }), null);
  assert.equal(computeNextRun({ days_mask: 1, time_local: "8am" }), null);
});
