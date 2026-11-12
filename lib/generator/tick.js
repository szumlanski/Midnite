// ─────────────────────────────────────────────────────────────────────────────
// Generator tick: PURE decision logic for the every-minute cron (pages/api/generator/tick.js).
// No API, no DB. planTick(input) returns the list of actions the cron should carry out, in order.
//
// Rules (see CLAUDE.md "Generator cron"):
//   Running: generator on the GRID terminals (213F = 1) and the site is Off-Grid (2100 = 3) ->
//            grid V > 50 or |grid W| > 200. Otherwise gen W > 200 or gen V > 50.
//            No usable live reading -> unknown (runs and observed state are left alone).
//   Runs:    running and no open run -> open one (source schedule if a schedule fired in the last
//            10 min, else force if a forced run is on, else auto) + a 'start' alert.
//            Not running for two ticks in a row with an open run -> close it at the first not-running
//            time + a 'stop' alert. Running with an open run -> keep peak W/V/Hz.
//   Writes (at most 2 writeShadow calls per site per tick, one control op at most):
//     1. Forced run past its deadline or target % -> op 'end' (2156 back to saved_ags + restore 2136).
//     2. Else a due schedule -> op 'start' (runMin = duration_min, targetPct = target_pct), skipped
//        (and marked) when a forced run is already on, or it is more than MISSED_MIN late.
//     3. Else, master switch + automatic on, no forced run: the active window's start/stop % differ
//        from applied_* -> one write of 2129 + 212A (the inverter's native AGS enforces them).
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_CONFIG, evaluateGen, activeSetpoint, localParts } from "./core.js";

export const RUN_W = 200;          // W above which the generator counts as running
export const RUN_V = 50;           // V above which the generator counts as running
export const SCHEDULE_SOURCE_MIN = 10; // a run opening this soon after a schedule fired is 'schedule'
export const MISSED_MIN = 15;      // a schedule this late (server down) is skipped, not run late
export const MAX_WRITES = 2;       // writeShadow calls per site per tick

const n = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

// true | false | null (unknown). live = { ok, genW, genV, gridW, gridV }, wiring = { genLocation, offGrid }.
export function detectRunning(live, wiring = {}) {
  if (!live || live.ok === false) return null;
  if (wiring?.genLocation === "grid") {
    // On a grid-tied site the grid terminals carry the utility too, so grid power can't mean "generator".
    if (wiring.offGrid !== true) return null;
    const v = n(live.gridV), w = n(live.gridW);
    if (v == null && w == null) return null;
    return (v != null && v > RUN_V) || (w != null && Math.abs(w) > RUN_W);
  }
  const w = n(live.genW), v = n(live.genV);
  if (w == null && v == null) return null;
  return (w != null && w > RUN_W) || (v != null && v > RUN_V);
}

// Peak readings for gen_runs (from the side the generator is wired to).
export function runReading(live, wiring = {}) {
  const grid = wiring?.genLocation === "grid";
  return {
    w: n(grid ? Math.abs(n(live?.gridW) ?? 0) : live?.genW),
    v: n(grid ? live?.gridV : live?.genV),
    hz: n(grid ? live?.gridHz : live?.genHz),
  };
}

const msOf = (t) => (t == null ? null : new Date(t).getTime());

// Which schedules are due now, and what to do with each. Pure.
function dueSchedules(schedules, now) {
  const t = now.getTime();
  return (schedules || [])
    .filter(s => s && s.enabled !== false)
    .map(s => {
      if (s.kind === "exercise") {
        const at = msOf(s.next_run_at);
        return at != null && at <= t ? { s, at } : null;
      }
      if (s.fired) return null;
      const at = msOf(s.starts_at ?? s.next_run_at);
      return at != null && at <= t ? { s, at } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
}

// input:
//   config     gen_config row          windows   gen_windows rows      schedules gen_schedules rows
//   live       { ok, soc, genW, genV, genHz, gridW, gridV, gridHz }
//   wiring     { genLocation:'grid'|'gen_port'|null, offGrid:bool|null, capacityMode:0|1|null }
//   openRun    the open gen_runs row (ended_at null) or null
//   now        Date                    tz        site timezone
//   canWrite   { control: bool, thresholds: bool }  (false = not enough time left in this tick, or no master)
//   computeNext(schedule, from) -> Date|null   (computeNextRun bound to the site tz; injected for tests)
// Returns { running, source, decision, setpoint, actions: [...] }.
export function planTick(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(input?.config || {}) };
  const now = input?.now ? new Date(input.now) : new Date();
  const tz = input?.tz || "America/New_York";
  const live = input?.live || { ok: false };
  const wiring = input?.wiring || {};
  const canWrite = { control: true, thresholds: true, ...(input?.canWrite || {}) };
  const actions = [];
  const soc = live.ok !== false && n(live.soc) != null && n(live.soc) > 0 ? n(live.soc) : null;
  const running = detectRunning(live, wiring);
  const reading = runReading(live, wiring);
  const openRun = input?.openRun || null;

  // ── Runs (observed) ───────────────────────────────────────────────────────
  let source = null;
  if (running === true && !openRun) {
    const recentSchedule = (input?.schedules || []).some(s => {
      const at = msOf(s.last_run_at);
      return at != null && now.getTime() - at >= 0 && now.getTime() - at <= SCHEDULE_SOURCE_MIN * 60000;
    });
    source = recentSchedule ? "schedule" : cfg.force_on ? "force" : "auto";
    actions.push({ type: "run_open", source, soc, peak: reading, cap_min: cfg.force_on ? n(cfg.force_max_run_min) : null, target_pct: cfg.force_on ? n(cfg.force_target_pct) : null });
    actions.push({ type: "notify", event: "start", source, socPct: soc });
  } else if (running === true && openRun) {
    const peak = {};
    if (reading.w != null && reading.w > (n(openRun.peak_w) ?? -Infinity)) peak.peak_w = reading.w;
    if (reading.v != null && reading.v > (n(openRun.peak_v) ?? -Infinity)) peak.peak_v = reading.v;
    if (reading.hz != null && reading.hz > (n(openRun.peak_hz) ?? -Infinity)) peak.peak_hz = reading.hz;
    if (Object.keys(peak).length) actions.push({ type: "run_update", id: openRun.id, ...peak });
  } else if (running === false && openRun) {
    // Debounce: close only on the second not-running tick in a row, at the first not-running time.
    if (cfg.observed_running === false && cfg.observed_at) {
      const endedAt = new Date(Math.max(msOf(cfg.observed_at), msOf(openRun.started_at)));
      const duration_sec = Math.max(0, Math.round((endedAt.getTime() - msOf(openRun.started_at)) / 1000));
      actions.push({ type: "run_close", id: openRun.id, ended_at: endedAt.toISOString(), duration_sec, soc_end: soc });
      actions.push({ type: "notify", event: "stop", source: openRun.source || null, socPct: soc, durationSec: duration_sec });
    }
  }
  if (running != null) actions.push({ type: "observe", running, at: now.toISOString() });

  // ── Writes ────────────────────────────────────────────────────────────────
  let writesLeft = MAX_WRITES;
  let controlDone = false;
  const lp = localParts(now, tz);
  const decision = evaluateGen({ config: cfg, windows: input?.windows || [], soc, running: !!running, now, minute: lp.minuteOfDay, dow: lp.dow });

  // 1. A forced run that is past its deadline or reached its target %.
  const forceEnding = cfg.force_on && decision.forceExpired;
  if (forceEnding) {
    const writes = cfg.saved_max_run_min != null ? 2 : 1; // 2156, then 2136 when saved
    if (canWrite.control) {
      actions.push({ type: "control", op: "end", reason: decision.reason, writes });
      writesLeft -= writes; controlDone = true;
    } else actions.push({ type: "defer", what: "force_end", reason: "no write time or no master this tick" });
  }

  // 2. Due schedules (earliest first). One start per tick; the rest are handled on later ticks.
  for (const { s, at } of dueSchedules(input?.schedules, now)) {
    const next = s.kind === "exercise" && input?.computeNext ? input.computeNext(s, new Date(now.getTime() + 60000)) : null;
    const mark = (skipped) => ({ type: "schedule_mark", id: s.id, kind: s.kind, fired: s.kind === "oneoff", next_run_at: s.kind === "exercise" ? (next ? next.toISOString() : null) : null, last_run_at: skipped ? null : now.toISOString(), skipped });
    const lateMin = (now.getTime() - at) / 60000;
    if (lateMin > MISSED_MIN) { actions.push(mark("missed")); continue; }
    // Schedules run whether or not Automatic control (AGS Auto) is on: the run ends by putting AGS back to what it was.
    if (cfg.force_on && !forceEnding) { actions.push(mark("force_active")); continue; }
    if (controlDone || writesLeft < 2 || !canWrite.control) { actions.push({ type: "defer", what: "schedule", id: s.id, reason: controlDone ? "another write this tick" : "no write time or no master this tick" }); break; }
    actions.push({ type: "control", op: "start", scheduleId: s.id, runMin: Number(s.duration_min), targetPct: s.target_pct == null ? null : Number(s.target_pct), writes: 2 });
    actions.push(mark(null));
    writesLeft -= 2; controlDone = true;
    break;
  }

  // 3. Automatic windows -> native thresholds.
  const setpoint = decision.setpoint || activeSetpoint(input?.windows, lp.minuteOfDay, lp.dow, cfg);
  if (cfg.enabled && cfg.auto_enabled && !cfg.force_on && !controlDone) {
    const differs = Number(setpoint.start_pct) !== n(cfg.applied_start_pct) || Number(setpoint.stop_pct) !== n(cfg.applied_stop_pct);
    if (differs) {
      if (wiring.capacityMode === 1) actions.push({ type: "defer", what: "thresholds", reason: "inverter is in Voltage capacity mode (2124=1); SOC thresholds do not apply" });
      else if (!canWrite.thresholds || writesLeft < 1) actions.push({ type: "defer", what: "thresholds", reason: "no write time, no master or backing off after a failure" });
      else actions.push({ type: "thresholds", start_pct: Number(setpoint.start_pct), stop_pct: Number(setpoint.stop_pct), from: setpoint.source, window_id: setpoint.window?.id ?? null, writes: 1 });
    }
  }

  return { running, source, soc, decision: { run: decision.run, reason: decision.reason }, setpoint: { source: setpoint.source, start_pct: setpoint.start_pct, stop_pct: setpoint.stop_pct, window_id: setpoint.window?.id ?? null }, actions };
}
