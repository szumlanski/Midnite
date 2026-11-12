// Fake /api/generator responses for the screenshot harness. Nothing here reaches an inverter:
// every write action just answers {ok:true}, and shots.mjs never presses a write button anyway.
//
// Only "OffTheHook" (1 inverter, 2508-90330077PH) is generator-enabled. Every other site answers
// 404 like the real route does for an admin on a site with no gen_sites row (the UI hides the tab).
// The generator is mid-way through a Run now: wired to the grid terminals of an off-grid site, so
// its power arrives in the grid field.

import { summarizeRuns } from "../../lib/generator/history.js";
import { DEFAULT_CONFIG, evaluateGen, localParts, overlappingPairs } from "../../lib/generator/core.js";
import { USER } from "./fixtures.mjs";

const GEN_SITE_KEY = "2508-90330077PH";
const TZ = "America/New_York";
const iso = (minFromNow) => new Date(Date.now() + minFromNow * 60000).toISOString();

const SITE = {
  site_key: GEN_SITE_KEY, site_name: "OffTheHook", enabled: true, timezone: TZ,
  master_sn: GEN_SITE_KEY, master_source: "admin", master_checked_at: "2026-11-11T15:20:00.000Z",
  owner_account_id: "6f1c2a9e-0b7d-4c1e-9a55-3d2f8e7b1c01", enabled_by: USER.id,
};
const CONFIG = {
  ...DEFAULT_CONFIG, site_key: GEN_SITE_KEY, enabled: true, default_start_pct: 20, default_stop_pct: 80, default_max_run_min: 240,
  force_on: true, force_until: iso(83), force_max_run_min: 120, force_target_pct: 60, saved_max_run_min: 0, saved_ags: 0, applied_ags: 1,
};
const WINDOWS = [
  { id: "a1000000-0000-4000-8000-000000000001", site_key: GEN_SITE_KEY, label: "Night", start_min: 1320, end_min: 360, start_pct: 30, stop_pct: 70, max_run_min: 180, days_mask: 127, priority: 10, enabled: true, created_at: "2026-11-01T12:00:00Z" },
  { id: "a1000000-0000-4000-8000-000000000002", site_key: GEN_SITE_KEY, label: "Storm watch", start_min: 0, end_min: 0, start_pct: 40, stop_pct: 90, max_run_min: 0, days_mask: 0b0111110, priority: 20, enabled: true, created_at: "2026-11-02T12:00:00Z" },
  { id: "a1000000-0000-4000-8000-000000000003", site_key: GEN_SITE_KEY, label: null, start_min: 720, end_min: 900, start_pct: 15, stop_pct: 50, max_run_min: 60, days_mask: 65, priority: 30, enabled: false, created_at: "2026-11-03T12:00:00Z" },
];
const SCHEDULES = [
  { id: "b1000000-0000-4000-8000-000000000001", site_key: GEN_SITE_KEY, kind: "oneoff", label: "Before the storm", starts_at: iso(60 * 26), duration_min: 90, target_pct: 85, enabled: true, next_run_at: iso(60 * 26), fired: false },
  { id: "b1000000-0000-4000-8000-000000000002", site_key: GEN_SITE_KEY, kind: "exercise", label: null, days_mask: 64, time_local: "10:00", duration_min: 20, target_pct: null, enabled: true, next_run_at: iso(60 * 50), fired: false },
];

// 40 days of runs, deterministic.
function runs() {
  const out = [];
  const src = ["auto", "auto", "schedule", "force", "auto", "manual"];
  for (let d = 0; d < 40; d++) {
    if (d % 3 === 1) continue;
    const start = Date.now() - d * 86400000 - (3 + (d % 5)) * 3600000;
    const dur = (35 + ((d * 37) % 110)) * 60;
    out.push({ id: `c1000000-0000-4000-8000-${String(d).padStart(12, "0")}`, site_key: GEN_SITE_KEY, started_at: new Date(start).toISOString(),
      ended_at: new Date(start + dur * 1000).toISOString(), duration_sec: dur, source: src[d % src.length], soc_start: 18 + (d % 6), soc_end: 62 + (d % 20), peak_w: 5200 + (d % 7) * 140 });
  }
  out.unshift({ id: "c1000000-0000-4000-8000-999999999999", site_key: GEN_SITE_KEY, started_at: iso(-37), ended_at: null, source: "force", soc_start: 18, peak_w: 5400 });
  return out;
}

const EVENTS = [
  { id: "e1", ts: iso(-37), actor_name: "Jason", actor_email: "jason@example.com", actor_role: "admin", action: "control_start", source: "user", success: true, before: { force_on: false }, after: { force_on: true, force_max_run_min: 120, force_target_pct: 60 } },
  { id: "e2", ts: iso(-60 * 5), actor_name: "Pat Homeowner", actor_email: "homeowner@example.com", actor_role: "shared", action: "save_window", source: "user", success: true, before: null, after: WINDOWS[1] },
  { id: "e3", ts: iso(-60 * 26), actor_name: "Pat Homeowner", actor_email: "homeowner@example.com", actor_role: "shared", action: "control_stop", source: "user", success: false, error: "Write 2156=2 was not confirmed: device did not answer.", before: null, after: { op: "stop" } },
  { id: "e4", ts: iso(-60 * 30), actor_name: "Dana Owner", actor_email: "owner@example.com", actor_role: "owner", action: "master_on", source: "user", success: true, before: { enabled: false }, after: { enabled: true } },
  { id: "e5", ts: iso(-60 * 50), actor_name: null, actor_email: null, actor_role: "system", action: "schedule_fired", source: "cron", success: true, before: null, after: { schedule: "exercise" } },
  { id: "e6", ts: "2026-11-11T15:20:00.000Z", actor_name: "Jason", actor_email: "jason@example.com", actor_role: "admin", action: "site_enable", source: "user", success: true, before: null, after: SITE },
];

function state() {
  const lp = localParts(new Date(), TZ);
  const live = {
    flow: { sn: GEN_SITE_KEY, online: true, time: new Date().toISOString().slice(0, 19).replace("T", " "), pv: 1200, grid: 5400, load: 2800, eps: 0, gen: 0, battery: 3800, soc: 24 },
    registers: { "2156": "1", "2136": "120", "2129": "15", "212A": "35", "213F": "1", "2100": "3", "2124": "0" },
    genLegs: { l1: { v: 121.5, a: 0, w: 0 }, l2: { v: 120.7, a: 0, w: 0 }, hz: 60.0, at: "2026-11-12 11:40:00" },
    legs: { at: "2026-11-12 11:35:00", genL1V: 0, genL2V: 0, gridL1V: 121.4, gridL2V: 120.8, genHz: 0, gridHz: 60.0 },
    genLocation: "grid", offGrid: true,
  };
  return {
    site: SITE, access: { role: "admin" }, genLocation: "grid", offGrid: true, config: CONFIG, windows: WINDOWS, schedules: SCHEDULES,
    overlaps: overlappingPairs(WINDOWS).map((p) => ({ a: p.a.id, b: p.b.id, winner: p.winner.id })),
    alerts: { email: true, push: false }, live,
    decision: evaluateGen({ config: CONFIG, windows: WINDOWS, soc: 24, running: true, minute: lp.minuteOfDay, dow: lp.dow }),
  };
}

/** { status, body } for POST /api/generator?action=<action>. */
export function genRespond(action, body = {}) {
  const key = String(body?.site_key || "");
  if (action === "siteToggle") return { status: 200, body: { ok: true, site: { ...SITE, site_key: key } } };
  if (key !== GEN_SITE_KEY) return { status: 404, body: { error: "This site has no generator setup yet." } };
  switch (action) {
    case "state": return { status: 200, body: state() };
    case "history": { const h = summarizeRuns(runs(), { tz: TZ, days: Number(body.days) || 30 }); return { status: 200, body: { ...h, runs: h.runs.slice(0, 50), tz: TZ } }; }
    case "events": return { status: 200, body: { events: EVENTS, next: null } };
    case "pushKey": return { status: 404, body: { error: "Unknown action: pushKey" } };
    default: return { status: 200, body: { ok: true } };
  }
}
