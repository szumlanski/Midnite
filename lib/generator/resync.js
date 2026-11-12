// ─────────────────────────────────────────────────────────────────────────────
// Generator settings resync: PURE planner (no API, no DB). Jason, 2026-11-12: inverter writes don't always stick, and
// on a parallel stack every inverter must hold the same generator settings or nothing happens. The tick cron reads
// 2156/2136/2129/212A on EVERY inverter each minute and this decides what to rewrite, so a write is retried every
// minute until it sticks.
//
// desiredSettings(cfg, socMode):
//   during a Run now (force_on): 2156 = 1 (On), 2136 = force_max_run_min, and in SOC mode 212A = 100, 2129 = 95.
//   otherwise: 2156 = applied_ags, 2136 = saved_max_run_min (the pre-run value still being put back), and in SOC
//   mode 2129/212A = applied_start_pct/applied_stop_pct. A null value is not enforced.
//
// planResync({ cfg, socMode, inverters:[{autoId, regs}], recentAppWrite }):
//   Outside a run, when the MASTER (inverters[0]) differs and the app has not written in the last few minutes, the
//   change was made outside the app (portal, MNP app): adopt the master's value instead of fighting it, and copy
//   it to the other inverters. Otherwise rewrite every inverter that differs from the desired value.
//   Returns { desired, writes:[{autoId, code, value}], adopt:{code: value}, mismatched, allMatch }.
//   Writes per inverter are ordered so the start % stays below the stop %.
// ─────────────────────────────────────────────────────────────────────────────

import { RUN_NOW_START_PCT, RUN_NOW_STOP_PCT, restingAgs } from "./control.js";

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
export const RESYNC_CODES = ["2156", "2136", "2129", "212A"];

export function desiredSettings(cfg = {}, socMode = false) {
  const d = {};
  if (cfg.force_on) {
    d["2156"] = 1;
    if (num(cfg.force_max_run_min) != null) d["2136"] = num(cfg.force_max_run_min);
    if (socMode) { d["212A"] = RUN_NOW_STOP_PCT; d["2129"] = RUN_NOW_START_PCT; }
  } else {
    if (num(cfg.applied_ags) != null) d["2156"] = restingAgs(cfg.applied_ags); // never On outside a run
    if (num(cfg.saved_max_run_min) != null) d["2136"] = num(cfg.saved_max_run_min);
    if (socMode && num(cfg.applied_start_pct) != null && num(cfg.applied_stop_pct) != null) {
      d["2129"] = num(cfg.applied_start_pct); d["212A"] = num(cfg.applied_stop_pct);
    }
  }
  return d;
}

// Order one inverter's writes: AGS last (settings first, then the start/stop command), and start/stop % in the
// order that keeps start below stop given what the inverter holds now.
function orderWrites(list, regs) {
  const by = Object.fromEntries(list.map(w => [w.code, w]));
  const out = [];
  if (by["2136"]) out.push(by["2136"]);
  const s = by["2129"], p = by["212A"];
  if (s && p) {
    const curStop = num(regs?.["212A"]);
    if (curStop == null || p.value >= curStop) out.push(p, s); else out.push(s, p);
  } else if (s) out.push(s); else if (p) out.push(p);
  if (by["2156"]) out.push(by["2156"]);
  return out;
}

export function planResync({ cfg = {}, socMode = false, inverters = [], recentAppWrite = false, overrides = {} } = {}) {
  // overrides (e.g. the watchdog's forced AGS Off) win and are never adopted from the master.
  let desired = { ...desiredSettings(cfg, socMode), ...overrides };
  const adopt = {};
  const master = inverters[0];
  const readable = (inv) => inv && inv.regs && !inv.error;
  if (!cfg.force_on && !recentAppWrite && readable(master)) {
    for (const [code, want] of Object.entries(desired)) {
      if (code in overrides) continue;
      const have = num(master.regs[code]);
      if (have != null && have !== want && !(code === "2156" && have === 1)) adopt[code] = have; // On is never adopted
    }
    // Adopting only one of the start/stop pair could leave start >= stop: adopt both or neither.
    if (("2129" in adopt) !== ("212A" in adopt)) {
      const s = num(master.regs["2129"]), p = num(master.regs["212A"]);
      if (s != null && p != null && s < p) { adopt["2129"] = s; adopt["212A"] = p; } else { delete adopt["2129"]; delete adopt["212A"]; }
    }
    desired = { ...desired, ...adopt };
  }
  const writes = []; const mismatched = [];
  for (const inv of inverters) {
    if (!readable(inv)) continue;
    const diff = [];
    for (const [code, want] of Object.entries(desired)) if (num(inv.regs[code]) !== want) diff.push({ autoId: inv.autoId, code, value: want });
    if (diff.length) { mismatched.push(inv.autoId); writes.push(...orderWrites(diff, inv.regs)); }
  }
  const allRead = inverters.length > 0 && inverters.every(readable);
  return { desired, writes, adopt, mismatched, allMatch: allRead && writes.length === 0 };
}
