// ─────────────────────────────────────────────────────────────────────────────
// Evaluation engine — PURE. No API, no DB, no I/O.
//
// evaluateRule(rule, snapshot, ctx) → { fired, value } decides whether a rule
// trips for a given DeviceSnapshot. describeRule(...) renders the human sentence
// (with the current value) used in the alert message and the UI preview.
// Keeping this pure is what lets the same logic run in the heartbeat, the
// test-send endpoint, and (for previews) the browser.
// ─────────────────────────────────────────────────────────────────────────────

import { getTrigger, opPhrase } from "./triggers";

function fmtNum(v, unit) {
  if (v == null || Number.isNaN(v)) return "--";
  if (unit === "W") return `${Math.round(v)} W`;
  if (unit === "kWh") return `${v.toFixed(2)} kWh`;
  if (unit === "%") return `${v.toFixed(0)}%`;
  if (unit === "V") return `${v.toFixed(1)} V`;
  if (unit === "°C") return `${v.toFixed(1)} °C`;
  if (unit === "min") return `${Math.round(v)} min`;
  return `${v}`;
}

// Is the rule's optional time-gate satisfied? trigger_after_time is "HH:MM" in the
// device's local time; we compare against `nowLocal` ("HH:MM", from the snapshot's
// site-local clock when available, else server local — the heartbeat passes it in).
function timeGateOk(rule, nowLocal) {
  if (!rule.trigger_after_time) return true;
  if (!nowLocal) return true; // can't determine → don't block
  return String(nowLocal) >= String(rule.trigger_after_time);
}

/**
 * @param rule     { trigger_type, threshold_value, trigger_after_time }
 * @param snapshot DeviceSnapshot from lib/notifications/snapshot.js
 * @param ctx      { minutesSinceOnline, nowLocal }
 * @returns { fired:boolean, value:number|null, reason?:string }
 */
export function evaluateRule(rule, snapshot, ctx = {}) {
  const t = getTrigger(rule.trigger_type);
  if (!t) return { fired: false, value: null, reason: "unknown trigger" };
  const threshold = Number(rule.threshold_value);

  // Status trigger: offline = time since last ONLINE snapshot exceeds threshold.
  // Derived purely from snapshot timing (never the API's self-reported health).
  if (t.op === "gap") {
    const gap = Number(ctx.minutesSinceOnline);
    if (!Number.isFinite(gap)) return { fired: false, value: null };
    return { fired: gap > threshold, value: gap };
  }

  // Numeric triggers need a live value for the metric.
  const value = snapshot?.metrics?.[t.metric];
  if (value == null || Number.isNaN(value)) return { fired: false, value: null, reason: "no value" };

  // Time-gate (e.g. "PV produced today below X" only checked after 18:00).
  if (t.timeGate && !timeGateOk(rule, ctx.nowLocal)) return { fired: false, value };

  let fired = false;
  if (t.op === "gt") fired = value > threshold;
  else if (t.op === "lt") fired = value < threshold;
  return { fired, value };
}

// Human description of the rule + the current value, for the alert body / UI.
export function describeRule(rule, snapshot, ctx = {}) {
  const t = getTrigger(rule.trigger_type);
  if (!t) return { title: rule.name || rule.trigger_type, line: "" };
  const threshold = Number(rule.threshold_value);
  if (t.op === "gap") {
    const gap = ctx.minutesSinceOnline;
    return {
      title: rule.name || `${t.label} ${threshold} ${t.unit}`,
      line: `No fresh data for ${fmtNum(gap, "min")} (alert after ${fmtNum(threshold, "min")}).`,
    };
  }
  const value = snapshot?.metrics?.[t.metric];
  const gate = t.timeGate && rule.trigger_after_time ? ` (checked after ${rule.trigger_after_time})` : "";
  return {
    title: rule.name || `${t.label} ${fmtNum(threshold, t.unit)}`,
    line: `Now ${fmtNum(value, t.unit)} — ${t.label.toLowerCase()} ${fmtNum(threshold, t.unit)}${gate}. ` +
          `Triggers when the reading ${opPhrase(t.op)} the threshold.`,
    value,
  };
}

// Short one-liner used in the UI rule list (no live snapshot needed).
export function summarizeRule(rule) {
  const t = getTrigger(rule.trigger_type);
  if (!t) return rule.trigger_type;
  if (t.op === "gap") return `${t.label} ${Number(rule.threshold_value)} ${t.unit}`;
  return `${t.label} ${fmtNum(Number(rule.threshold_value), t.unit)}`;
}

export { fmtNum };
