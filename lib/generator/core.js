// ─────────────────────────────────────────────────────────────────────────────
// Generator control: PURE logic (no API, no DB, no I/O). Client-safe.
//
// Shared by pages/api/generator.js, the future tick cron and the UI so they all
// pick the same winning window and make the same start/stop decision.
// Written for Midnite from the FourScoped comm-hub design (generator-core +
// eg4/generator schedule helpers), keyed to the gen_* tables in supabase/schema.sql.
//
// Conventions:
//   - Minutes of day: 0..1439 in the SITE timezone.
//   - days_mask: bit 0 = Sunday .. bit 6 = Saturday (127 = every day).
//   - Windows: lowest `priority` wins on overlap; ties go to the earlier one in the list.
//   - A window with start_min === end_min covers the whole day.
//   - A window with start_min > end_min wraps past midnight. The part after midnight
//     belongs to the day it STARTED on (a Fri 22:00-06:00 window covers Sat 03:00).
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,            // master switch for automatic control
  auto_enabled: true,
  default_start_pct: 20,
  default_stop_pct: 80,
  default_max_run_min: 240,
  force_on: false,
  force_until: null,
  force_max_run_min: 120,
  force_target_pct: null,
  comms_lost_action: "stop", // 'stop' | 'hold'
  alerts_enabled: true,
});

export const ALL_DAYS = 127;

// site_key = the site's inverter serials, de-duplicated, sorted and joined with ",".
// Accepts strings or { GoodsID } objects (the shape loadSites returns).
export function siteKeyOf(serials) {
  return [...new Set((serials || []).map((s) => (typeof s === "string" ? s : s?.GoodsID)).map((s) => String(s || "").trim()).filter(Boolean))].sort().join(",");
}
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));
const dayBit = (dow) => 1 << (((dow % 7) + 7) % 7);
const maskOf = (w) => (w && Number.isInteger(w.days_mask) && w.days_mask > 0 ? w.days_mask : ALL_DAYS);

// Does window `w` cover minute-of-day `minute` on weekday `dow` (0 = Sunday)?
// `dow` is optional: without it the day mask is ignored.
export function windowCoversMinute(w, minute, dow) {
  if (!w) return false;
  const s = Number(w.start_min), e = Number(w.end_min), m = Number(minute);
  const dayOk = (d) => dow == null || (maskOf(w) & dayBit(d)) !== 0;
  if (s === e) return dayOk(dow);                       // whole day
  if (s < e) return m >= s && m < e && dayOk(dow);       // same day
  // wraps midnight: [s, 1440) today, [0, e) belongs to yesterday's window
  if (m >= s) return dayOk(dow);
  if (m < e) return dow == null ? true : dayOk(dow - 1);
  return false;
}

// Sort enabled windows by priority (stable).
function byPriority(windows) {
  return (windows || [])
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w && w.enabled !== false)
    .sort((a, b) => (Number(a.w.priority ?? 100) - Number(b.w.priority ?? 100)) || a.i - b.i)
    .map(({ w }) => w);
}

// The setpoint in force at (minute, dow): the highest-priority covering window, else the defaults.
// Returns { source: 'window'|'default', window, start_pct, stop_pct, max_run_min }.
export function activeSetpoint(windows, minute, dow, config = DEFAULT_CONFIG) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  for (const w of byPriority(windows)) {
    if (windowCoversMinute(w, minute, dow)) {
      return { source: "window", window: w, start_pct: Number(w.start_pct), stop_pct: Number(w.stop_pct), max_run_min: Number(w.max_run_min || 0) };
    }
  }
  return { source: "default", window: null, start_pct: Number(cfg.default_start_pct), stop_pct: Number(cfg.default_stop_pct), max_run_min: Number(cfg.default_max_run_min || 0) };
}

// Pairs of enabled windows that share at least one minute on at least one day.
// Returns [{ a, b, winner }] where a/b are the windows (in list order) and winner is the one that applies.
export function overlappingPairs(windows) {
  const list = (windows || []).filter((w) => w && w.enabled !== false);
  const ranked = byPriority(list);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      let hit = false;
      for (let d = 0; d < 7 && !hit; d++) {
        for (let m = 0; m < 1440; m++) {
          if (windowCoversMinute(a, m, d) && windowCoversMinute(b, m, d)) { hit = true; break; }
        }
      }
      if (hit) out.push({ a, b, winner: ranked.indexOf(a) <= ranked.indexOf(b) ? a : b });
    }
  }
  return out;
}

// ── Decision ────────────────────────────────────────────────────────────────
// evaluateGen(input) → { run, reason, setpoint, forceExpired }
//   run: true (want the gen on), false (want it off), or null (server leaves it alone).
// input:
//   config      gen_config row (merged over DEFAULT_CONFIG)
//   windows     gen_windows rows
//   soc         battery SOC %, or null/undefined when the cloud is unreachable
//   running     whether the generator is currently running (observed, or last command)
//   runStartedAt Date|string|number when the current run began (for max run time)
//   now         Date (default: new Date())
//   minute, dow site-local minute-of-day and weekday (from localParts(now, tz))
export function evaluateGen(input) {
  const cfg = { ...DEFAULT_CONFIG, ...(input?.config || {}) };
  const now = input?.now ? new Date(input.now) : new Date();
  const soc = input?.soc == null || Number.isNaN(Number(input.soc)) ? null : Number(input.soc);
  const running = !!input?.running;
  const minute = input?.minute ?? (now.getUTCHours() * 60 + now.getUTCMinutes());
  const dow = input?.dow ?? now.getUTCDay();
  const setpoint = activeSetpoint(input?.windows, minute, dow, cfg);

  // 1. A forced run (Run now) outranks everything, including the master switch.
  if (cfg.force_on) {
    const until = cfg.force_until ? new Date(cfg.force_until) : null;
    if (until && now >= until) return { run: false, reason: "force_deadline", setpoint, forceExpired: true };
    if (cfg.force_target_pct != null && soc != null && soc >= Number(cfg.force_target_pct))
      return { run: false, reason: "force_target", setpoint, forceExpired: true };
    return { run: true, reason: "force", setpoint, forceExpired: false };
  }

  // 2. Automatic control off: the server does not touch the generator.
  if (!cfg.enabled || !cfg.auto_enabled) return { run: null, reason: "disabled", setpoint, forceExpired: false };

  // 3. No battery reading: follow the comms-lost policy.
  if (soc == null) {
    if (cfg.comms_lost_action === "hold") return { run: running, reason: "comms_lost_hold", setpoint, forceExpired: false };
    return { run: false, reason: "comms_lost_stop", setpoint, forceExpired: false };
  }

  // 4. Hysteresis around the active setpoint.
  if (running) {
    if (soc >= setpoint.stop_pct) return { run: false, reason: "stop_pct", setpoint, forceExpired: false };
    if (setpoint.max_run_min > 0 && input?.runStartedAt != null) {
      const ranMin = (now - new Date(input.runStartedAt)) / 60000;
      if (ranMin >= setpoint.max_run_min) return { run: false, reason: "max_run", setpoint, forceExpired: false };
    }
    return { run: true, reason: "hold_running", setpoint, forceExpired: false };
  }
  if (soc <= setpoint.start_pct) return { run: true, reason: "start_pct", setpoint, forceExpired: false };
  return { run: false, reason: "hold_stopped", setpoint, forceExpired: false };
}

// ── Formatters ──────────────────────────────────────────────────────────────
// 0..1439 → "6:05 AM" (1440 → "12:00 AM", end of day).
export function minToClock(min) {
  const m = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), mm = m % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
// 0..1439 → "06:05" (for <input type="time">).
export function minToInput(min) {
  const m = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
// "06:05" → 365. Returns null for anything that is not a valid HH:MM.
export function inputToMin(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}
// Seconds → "1h 05m", "12m", "45s", "2d 3h".
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
// days_mask → "Every day" | "Weekdays" | "Weekends" | "Mon, Wed, Fri".
export function fmtDays(mask) {
  const m = Number(mask) & ALL_DAYS;
  if (m === ALL_DAYS) return "Every day";
  if (m === 0b0111110) return "Weekdays";
  if (m === 0b1000001) return "Weekends";
  return DAY_NAMES.filter((_, d) => m & (1 << d)).join(", ");
}

// ── Time zones (exercise schedules) ─────────────────────────────────────────
const _dtf = new Map();
function dtf(tz) {
  if (!_dtf.has(tz)) {
    _dtf.set(tz, new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    }));
  }
  return _dtf.get(tz);
}

// Wall-clock parts of `date` in `tz`: { year, month (1-12), day, hour, minute, second, dow (0=Sun), minuteOfDay, ymd }.
export function localParts(date, tz = "America/New_York") {
  const p = Object.fromEntries(dtf(tz).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  const year = Number(p.year), month = Number(p.month), day = Number(p.day);
  const hour = Number(p.hour) % 24, minute = Number(p.minute), second = Number(p.second);
  const dow = DAY_NAMES.indexOf(p.weekday);
  return { year, month, day, hour, minute, second, dow, minuteOfDay: hour * 60 + minute,
    ymd: `${p.year}-${p.month}-${p.day}` };
}

// UTC offset of `tz` at instant `date`, in minutes (EDT → -240).
function offsetMin(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(new Date(date).getTime() / 1000) * 1000) / 60000);
}

// The instant whose wall clock in `tz` is year-month-day hour:minute.
// A time skipped by spring-forward (e.g. 02:30) maps to the same offset as before the gap,
// which lands one hour later on the clock (03:30). A repeated fall-back time picks the first one.
export function zonedTimeToUtc(year, month, day, hour, minute, tz = "America/New_York") {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const o1 = offsetMin(guess, tz);
  let t = guess - o1 * 60000;
  const o2 = offsetMin(t, tz);
  if (o2 !== o1) {
    // The first guess used the offset on the wrong side of a transition. Retry with the other
    // offset; if that one is self-consistent use it, else the time is in a spring-forward gap
    // and the first candidate (pushed one hour later on the clock) stands.
    const t2 = guess - o2 * 60000;
    if (offsetMin(t2, tz) === o2) t = t2;
  }
  return new Date(t);
}

// Next run of a weekly exercise schedule strictly after `from`.
// sched: { days_mask, time_local: 'HH:MM' }. Returns a Date or null (nothing selected / bad time).
export function computeNextRun(sched, tz = "America/New_York", from = new Date()) {
  const mask = Number(sched?.days_mask) & ALL_DAYS;
  const tmin = inputToMin(sched?.time_local);
  if (!mask || tmin == null) return null;
  const h = Math.floor(tmin / 60), m = tmin % 60;
  const start = localParts(from, tz);
  const fromMs = new Date(from).getTime();
  // Walk forward up to 8 local calendar days (covers "today but already passed" + a full week).
  for (let k = 0; k <= 8; k++) {
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + k));
    const dow = d.getUTCDay();
    if (!(mask & (1 << dow))) continue;
    const at = zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, m, tz);
    if (at.getTime() > fromMs) return at;
  }
  return null;
}

// ── Validation (shared by the API and the UI form) ──────────────────────────
// Returns an error string, or null if the window is valid.
export function validateWindow(w) {
  const ints = ["start_min", "end_min", "start_pct", "stop_pct"];
  for (const k of ints) if (!Number.isInteger(Number(w?.[k])) || w?.[k] === "" || w?.[k] == null) return `${k} must be a whole number`;
  if (w.start_min < 0 || w.start_min > 1439 || w.end_min < 0 || w.end_min > 1439) return "start/end must be 0-1439 minutes";
  if (w.start_pct < 0 || w.start_pct > 100 || w.stop_pct < 0 || w.stop_pct > 100) return "start/stop % must be 0-100";
  if (Number(w.stop_pct) <= Number(w.start_pct)) return "stop % must be above start %";
  if (w.max_run_min != null && (!Number.isInteger(Number(w.max_run_min)) || w.max_run_min < 0 || w.max_run_min > 1440)) return "max run must be 0-1440 minutes";
  if (w.days_mask != null && (!Number.isInteger(Number(w.days_mask)) || w.days_mask < 1 || w.days_mask > 127)) return "pick at least one day";
  return null;
}

export { clampInt };
