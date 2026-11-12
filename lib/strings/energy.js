// ─────────────────────────────────────────────────────────────────────────────
// Per-string (MPPT) energy: PURE functions, no network, no DB. Used by the nightly cron
// (pages/api/strings/daily.js), the backfill action and the energy summary (pages/api/strings.js).
//
//   computeMpptDay(rows)        per-MPPT kWh / peak W / peak V / samples from one day's CSV rows
//   etodayFromRows(rows)        the inverter's own E-Today for the day (max of the cumulative column)
//   flagUnderperformers(rows)   strings more than `threshold` below the site median over the last N days
//   summarizeEnergy(rows, ...)  per-string totals, per-day / per-month totals, cross-check vs E-Today
//
// Row shape from fetchDayExcel: { ts:"YYYY-MM-DD HH:MM:SS", mppt1W, mppt1V, mppt1A, ..., eToday }.
// ─────────────────────────────────────────────────────────────────────────────

import { localParts } from "../generator/core.js";

export const MAX_GAP_MIN = 15;          // gaps longer than this are not bridged by the trapezoid
export const ACTIVE_W = 1;              // a sample above this many watts counts as producing
export const strKey = (sn, mppt) => `${sn}:${mppt}`;

// "YYYY-MM-DD HH:MM[:SS]" -> minutes since the Unix epoch, as wall time (tz cancels within a day).
export function wallMinutes(ts) {
  const m = String(ts || "").replace("T", " ").match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) / 60000;
}

const num = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// Trapezoid integration over the actual sample times. Returns [{mppt, kwh, peak_w, peak_v, samples, active}].
// samples = readings with power above ACTIVE_W. active = at least one such reading.
export function computeMpptDay(rows, { maxGapMin = MAX_GAP_MIN } = {}) {
  const pts = (rows || [])
    .map((r) => ({ t: wallMinutes(r.ts || r.time), r }))
    .filter((p) => p.t != null)
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const n of [1, 2, 3]) {
    let wh = 0, peakW = 0, peakV = 0, samples = 0;
    for (let i = 0; i < pts.length; i++) {
      const w = Math.max(0, num(pts[i].r[`mppt${n}W`]));
      const v = num(pts[i].r[`mppt${n}V`]);
      if (w > peakW) peakW = w;
      if (v > peakV) peakV = v;
      if (w > ACTIVE_W) samples++;
      if (i > 0) {
        const dt = pts[i].t - pts[i - 1].t;
        if (dt > 0 && dt <= maxGapMin) {
          const w0 = Math.max(0, num(pts[i - 1].r[`mppt${n}W`]));
          wh += ((w0 + w) / 2) * (dt / 60);
        }
      }
    }
    out.push({ mppt: n, kwh: Math.round(wh) / 1000, peak_w: Math.round(peakW), peak_v: Math.round(peakV * 10) / 10, samples, active: samples > 0 });
  }
  return out;
}

// The inverter's E-Today for the day (kWh). Cumulative, so the max is the day's total. null if absent.
export function etodayFromRows(rows) {
  let best = null;
  for (const r of rows || []) { const e = Number(r?.eToday); if (Number.isFinite(e) && (best == null || e > best)) best = e; }
  return best;
}

// Which MPPTs to store for a day: active today, or ever active before (so a dead string shows 0 kWh
// instead of disappearing). everActive = Set of strKey(sn, mppt).
export function rowsToStore(sn, day, computed, { everActive = new Set(), siteKey = null, etoday = null } = {}) {
  return computed
    .filter((c) => c.active || everActive.has(strKey(sn, c.mppt)))
    .map((c) => ({ sn, day, mppt: c.mppt, site_key: siteKey, kwh: c.kwh, peak_w: c.peak_w, peak_v: c.peak_v, samples: c.samples, inverter_etoday: etoday }));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// rows: [{sn, mppt, day, kwh}]. sizes: { "sn:mppt": kw_dc }. Compares the last `days` days present in rows.
// Basis = kWh/kW when EVERY compared string has a size, else raw kWh (sizes mixed or missing).
// Returns { basis, median, window:{from,to}, strings:[{sn, mppt, kwh, metric, pctBelow, flagged}] }.
export function flagUnderperformers(rows, { days = 7, threshold = 0.15, sizes = {} } = {}) {
  const allDays = [...new Set((rows || []).map((r) => String(r.day)))].sort();
  const win = allDays.slice(-days);
  const inWin = new Set(win);
  const tot = new Map();
  for (const r of rows || []) {
    if (!inWin.has(String(r.day))) continue;
    const k = strKey(r.sn, r.mppt);
    tot.set(k, (tot.get(k) || 0) + num(r.kwh));
  }
  const keys = [...tot.keys()];
  const sized = keys.length > 0 && keys.every((k) => num(sizes[k]) > 0);
  const basis = sized ? "kwh_per_kw" : "kwh";
  const strings = keys.map((k) => {
    const [sn, m] = [k.slice(0, k.lastIndexOf(":")), Number(k.slice(k.lastIndexOf(":") + 1))];
    const kwh = tot.get(k);
    return { sn, mppt: m, kwh: Math.round(kwh * 1000) / 1000, metric: sized ? kwh / num(sizes[k]) : kwh };
  });
  const med = strings.length >= 2 ? median(strings.map((s) => s.metric)) : null;
  for (const s of strings) {
    s.pctBelow = med > 0 ? Math.max(0, 1 - s.metric / med) : 0;
    s.flagged = med > 0 && s.metric < med * (1 - threshold);
  }
  return { basis, median: med, window: win.length ? { from: win[0], to: win[win.length - 1], days: win.length } : null, strings };
}

// rows: mppt_daily rows for the range. sizes: { "sn:mppt": kw_dc }.
// Returns { strings, byDay, byMonth, total, etodayTotal, crossCheck, flags }.
//   strings: per sn/mppt { sn, mppt, kwh, kw_dc, kwh_per_kw, share (of that inverter's string total), peak_w, days }
//   byDay:   [{ day, total, etoday, "sn:mppt": kwh, ... }] sorted
//   byMonth: [{ month:"YYYY-MM", total, etoday, "sn:mppt": kwh, ... }] sorted
//   crossCheck: { strings, etoday, diffPct, mismatch (>10%) } over days where both exist
export function summarizeEnergy(rows, { sizes = {}, flagDays = 7, threshold = 0.15 } = {}) {
  const r2 = (x) => Math.round(x * 1000) / 1000;
  const per = new Map(), invTot = new Map(), dayMap = new Map(), monMap = new Map();
  const etodaySeen = new Set();
  for (const r of rows || []) {
    const day = String(r.day).slice(0, 10), mon = day.slice(0, 7), k = strKey(r.sn, r.mppt), kwh = num(r.kwh);
    const s = per.get(k) || { sn: r.sn, mppt: Number(r.mppt), kwh: 0, peak_w: 0, days: 0 };
    s.kwh += kwh; s.days++; s.peak_w = Math.max(s.peak_w, num(r.peak_w));
    per.set(k, s);
    invTot.set(r.sn, (invTot.get(r.sn) || 0) + kwh);
    for (const [map, key, field] of [[dayMap, day, "day"], [monMap, mon, "month"]]) {
      const b = map.get(key) || { [field]: key, total: 0, etoday: 0, _hasE: false };
      b[k] = r2((b[k] || 0) + kwh);
      b.total = r2(b.total + kwh);
      map.set(key, b);
    }
    // E-Today is per inverter per day (repeated on each MPPT row): count it once.
    const ek = `${r.sn}|${day}`;
    if (r.inverter_etoday != null && !etodaySeen.has(ek)) {
      etodaySeen.add(ek);
      const e = num(r.inverter_etoday);
      for (const [map, key] of [[dayMap, day], [monMap, mon]]) { const b = map.get(key); b.etoday = r2(b.etoday + e); b._hasE = true; }
    }
  }
  const strings = [...per.values()].map((s) => {
    const kw = num(sizes[strKey(s.sn, s.mppt)]) || null;
    const it = invTot.get(s.sn) || 0;
    return { ...s, kwh: r2(s.kwh), kw_dc: kw, kwh_per_kw: kw ? Math.round((s.kwh / kw) * 100) / 100 : null, share: it > 0 ? s.kwh / it : null };
  }).sort((a, b) => (a.sn === b.sn ? a.mppt - b.mppt : a.sn < b.sn ? -1 : 1));
  const clean = (b) => { const { _hasE, ...rest } = b; return { ...rest, etoday: _hasE ? rest.etoday : null }; };
  const byDay = [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).map(clean);
  const byMonth = [...monMap.values()].sort((a, b) => (a.month < b.month ? -1 : 1)).map(clean);
  // Cross-check only over days that have the inverter's E-Today recorded.
  let cs = 0, ce = 0;
  for (const d of byDay) if (d.etoday != null) { cs += d.total; ce += d.etoday; }
  const diffPct = ce > 0 ? (cs - ce) / ce : null;
  const crossCheck = { strings: r2(cs), etoday: r2(ce), diffPct, mismatch: diffPct != null && Math.abs(diffPct) > 0.10 };
  const flags = flagUnderperformers(rows, { days: flagDays, threshold, sizes });
  return { strings, byDay, byMonth, total: r2(strings.reduce((a, s) => a + s.kwh, 0)), crossCheck, flags };
}

// Label + size validation for the save action. Returns { label, kw_dc } or { error }.
export function validateLabel({ label, kw_dc }) {
  const l = label == null ? "" : String(label).trim();
  if (l.length > 40) return { error: "Name can be at most 40 characters." };
  let kw = null;
  if (kw_dc !== null && kw_dc !== undefined && String(kw_dc).trim() !== "") {
    kw = Number(kw_dc);
    if (!Number.isFinite(kw) || kw <= 0 || kw > 100) return { error: "Size must be more than 0 and at most 100 kW DC." };
    kw = Math.round(kw * 1000) / 1000;
  }
  return { label: l || null, kw_dc: kw };
}

// Inclusive list of YYYY-MM-DD dates from `from` to `to` (noon UTC math, DST-proof).
export function dateRange(from, to, max = 400) {
  const out = []; let d = new Date(`${from}T12:00:00Z`); const end = new Date(`${to}T12:00:00Z`);
  while (d <= end && out.length < max) { out.push(d.toISOString().slice(0, 10)); d = new Date(d.getTime() + 86400000); }
  return out;
}

// Nightly collection window: a site is due when its local hour is in [startHour, endHour]. The first
// hour (1 AM) does the work; later hours retry inverters whose yesterday rows are still missing.
// Returns { due, yesterday } with yesterday = the site's local calendar yesterday.
export function nightlyDue(now, tz = "America/New_York", { startHour = 1, endHour = 5 } = {}) {
  const p = localParts(now, tz);
  const y = new Date(Date.UTC(p.year, p.month - 1, p.day, 12) - 86400000).toISOString().slice(0, 10);
  return { due: p.hour >= startHour && p.hour <= endHour, hour: p.hour, yesterday: y };
}
