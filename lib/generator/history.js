// ─────────────────────────────────────────────────────────────────────────────
// Generator run history: PURE aggregation over gen_runs rows (no DB, no I/O).
// summarizeRuns(runs, { tz, now, days, months }) →
//   { totals: { day, week, month, year, all } (each { sec, runs }),
//     daily:  [{ date:'YYYY-MM-DD', sec, runs, bySource:{auto,force,schedule,manual} }] (oldest first),
//     monthly:[{ month:'YYYY-MM', sec, runs }] (oldest first),
//     runs:   newest first, each with duration_sec filled in (open runs count up to `now`) }
// A run that crosses local midnight is split across the days it covers.
// ─────────────────────────────────────────────────────────────────────────────

import { localParts, zonedTimeToUtc } from "./core.js";

const SOURCES = ["auto", "force", "schedule", "manual"];

function runSpan(r, nowMs) {
  const s = new Date(r.started_at).getTime();
  const e = r.ended_at ? new Date(r.ended_at).getTime() : nowMs;
  return Number.isFinite(s) && Number.isFinite(e) && e > s ? [s, e] : null;
}

// Local calendar date string for an instant.
const ymdAt = (ms, tz) => localParts(ms, tz).ymd;

// Split [s,e) into per-local-day pieces: [{ ymd, sec }], cutting at each local midnight (DST-safe).
function splitByDay(s, e, tz) {
  const out = [];
  let cur = s;
  while (cur < e) {
    const p = localParts(cur, tz);
    const nextMidnight = zonedTimeToUtc(p.year, p.month, p.day + 1, 0, 0, tz).getTime();
    const next = Math.min(e, nextMidnight > cur ? nextMidnight : e);
    out.push({ ymd: p.ymd, sec: Math.round((next - cur) / 1000) });
    cur = next;
  }
  return out;
}

export function summarizeRuns(runs, opts = {}) {
  const tz = opts.tz || "America/New_York";
  const nowMs = new Date(opts.now || Date.now()).getTime();
  const nDays = opts.days || 30;
  const nMonths = opts.months || 12;

  const windows = { day: 1, week: 7, month: 30, year: 365 };
  const totals = { day: { sec: 0, runs: 0 }, week: { sec: 0, runs: 0 }, month: { sec: 0, runs: 0 }, year: { sec: 0, runs: 0 }, all: { sec: 0, runs: 0 } };

  // Day + month buckets in the site timezone.
  const today = localParts(nowMs, tz);
  const dayKeys = [];
  for (let k = nDays - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day - k));
    dayKeys.push(d.toISOString().slice(0, 10));
  }
  const daily = new Map(dayKeys.map((k) => [k, { date: k, sec: 0, runs: 0, bySource: Object.fromEntries(SOURCES.map((s) => [s, 0])) }]));
  const monthKeys = [];
  for (let k = nMonths - 1; k >= 0; k--) {
    const d = new Date(Date.UTC(today.year, today.month - 1 - k, 1));
    monthKeys.push(d.toISOString().slice(0, 7));
  }
  const monthly = new Map(monthKeys.map((k) => [k, { month: k, sec: 0, runs: 0 }]));

  const outRuns = [];
  for (const r of runs || []) {
    const span = runSpan(r, nowMs);
    const duration = span ? Math.round((span[1] - span[0]) / 1000) : 0;
    outRuns.push({ ...r, duration_sec: r.ended_at && r.duration_sec != null ? r.duration_sec : duration, open: !r.ended_at });
    if (!span) continue;
    const [s, e] = span;
    totals.all.sec += duration; totals.all.runs += 1;
    for (const [k, nd] of Object.entries(windows)) {
      const lo = nowMs - nd * 86400000;
      const ov = Math.max(0, Math.min(e, nowMs) - Math.max(s, lo));
      if (ov > 0) { totals[k].sec += Math.round(ov / 1000); totals[k].runs += 1; }
    }
    const src = SOURCES.includes(r.source) ? r.source : "auto";
    const startDay = ymdAt(s, tz);
    for (const piece of splitByDay(s, e, tz)) {
      const d = daily.get(piece.ymd);
      if (d) { d.sec += piece.sec; d.bySource[src] += piece.sec; if (piece.ymd === startDay) d.runs += 1; }
      const m = monthly.get(piece.ymd.slice(0, 7));
      if (m) { m.sec += piece.sec; if (piece.ymd === startDay) m.runs += 1; }
    }
  }
  outRuns.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  return { totals, daily: [...daily.values()], monthly: [...monthly.values()], runs: outRuns };
}
