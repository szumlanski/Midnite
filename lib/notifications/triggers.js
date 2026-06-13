// ─────────────────────────────────────────────────────────────────────────────
// Notification trigger taxonomy — the SINGLE SOURCE OF TRUTH.
//
// This module is isomorphic (no node/browser-only deps) so it drives BOTH:
//   • the UI add-rule form (pages/index.jsx → Notifications settings), and
//   • server-side validation + the DB CHECK constraint (supabase/schema.sql).
// The CHECK constraint in schema.sql lists exactly TRIGGER_TYPES below — keep
// them in lockstep. `alertrule_save` also validates against TRIGGER_TYPES at
// write time, so even if the SQL drifts the app still can't store a bad type.
//
// Every trigger is derived from a metric this app ACTUALLY exposes (see
// lib/notifications/snapshot.js, which is built from the Midnite `status`
// normaliser). We don't invent triggers for data that isn't there.
// ─────────────────────────────────────────────────────────────────────────────

// op: how the live metric is compared against threshold_value.
//   "gt"  → fire when metric >  threshold
//   "lt"  → fire when metric <  threshold
//   "gap" → status trigger: fire when minutes since last ONLINE snapshot > threshold
export const TRIGGERS = [
  // ── Battery ────────────────────────────────────────────────────────────────
  { type: "battery_soc_below", label: "Battery SOC below", group: "Battery",
    metric: "batterySoc", op: "lt", unit: "%", defaultThreshold: 20, min: 0, max: 100, step: 1 },
  { type: "battery_soc_above", label: "Battery SOC above", group: "Battery",
    metric: "batterySoc", op: "gt", unit: "%", defaultThreshold: 98, min: 0, max: 100, step: 1 },
  { type: "battery_soh_below", label: "Battery health (SOH) below", group: "Battery",
    metric: "batterySoh", op: "lt", unit: "%", defaultThreshold: 80, min: 0, max: 100, step: 1 },

  // ── Temperature ──────────────────────────────────────────────────────────────
  { type: "battery_temp_above", label: "Battery temperature above", group: "Temperature",
    metric: "batteryTempC", op: "gt", unit: "°C", defaultThreshold: 45, min: 0, max: 100, step: 1 },
  { type: "inverter_temp_above", label: "Inverter temperature above", group: "Temperature",
    metric: "inverterTempC", op: "gt", unit: "°C", defaultThreshold: 60, min: 0, max: 120, step: 1 },

  // ── Load / Grid (instantaneous power) ───────────────────────────────────────
  { type: "load_power_above", label: "House load above", group: "Power",
    metric: "loadPowerW", op: "gt", unit: "W", defaultThreshold: 8000, min: 0, max: 60000, step: 100 },
  { type: "grid_import_above", label: "Grid import above", group: "Power",
    metric: "gridImportW", op: "gt", unit: "W", defaultThreshold: 5000, min: 0, max: 60000, step: 100 },
  { type: "grid_export_above", label: "Grid export above", group: "Power",
    metric: "gridExportW", op: "gt", unit: "W", defaultThreshold: 5000, min: 0, max: 60000, step: 100 },

  // ── Grid quality ────────────────────────────────────────────────────────────
  { type: "grid_voltage_above", label: "Grid voltage above", group: "Grid quality",
    metric: "gridVoltageV", op: "gt", unit: "V", defaultThreshold: 253, min: 0, max: 320, step: 1 },
  { type: "grid_voltage_below", label: "Grid voltage below", group: "Grid quality",
    metric: "gridVoltageV", op: "lt", unit: "V", defaultThreshold: 211, min: 0, max: 320, step: 1 },

  // ── Production (cumulative today; time-gated so it checks late in the day) ────
  { type: "pv_today_below", label: "PV produced today below", group: "Production",
    metric: "pvEnergyTodayKwh", op: "lt", unit: "kWh", defaultThreshold: 5, min: 0, max: 500, step: 0.5,
    timeGate: true, defaultAfterTime: "18:00" },

  // ── Status (heartbeat gap — never trusts the API's self-reported health) ─────
  { type: "device_offline", label: "Device offline for", group: "Status",
    metric: null, op: "gap", unit: "min", defaultThreshold: 30, min: 5, max: 1440, step: 5, status: true },
];

export const TRIGGER_TYPES = TRIGGERS.map((t) => t.type);

export const TRIGGER_BY_TYPE = Object.fromEntries(TRIGGERS.map((t) => [t.type, t]));

export function getTrigger(type) {
  return TRIGGER_BY_TYPE[type] || null;
}

// Groups in stable display order, each with its triggers (drives the UI form).
export function triggerGroups() {
  const order = [];
  const map = {};
  for (const t of TRIGGERS) {
    if (!map[t.group]) { map[t.group] = []; order.push(t.group); }
    map[t.group].push(t);
  }
  return order.map((g) => ({ group: g, triggers: map[g] }));
}

// Human phrase for the comparison (used in messages + the UI preview).
export function opPhrase(op) {
  if (op === "gt") return "rises above";
  if (op === "lt") return "drops below";
  if (op === "gap") return "has had no data for over";
  return "crosses";
}
