// ─────────────────────────────────────────────────────────────────────────────
// Generator watchdog: PURE planner (no API, no DB). Jason, 2026-11-12: these inverters are slow to start charging
// from the generator and slow to stop, and the generator itself runs a cool-down after its start signal drops. So
// after every start and every end the server waits, then checks the real result, in two separate parts:
//   CHARGING = the inverters drawing power from the generator (W > RUN_W)
//   GENERATOR ON = generator voltage present (V > RUN_V), even at 0 W (idle, cool-down, not yet drawn on)
// Same logic for Run now, one-off and exercise runs (all share the start/end path and set force_on/force_until).
//
// planWatchdog({ cfg, reading:{w, v}, now, events }) -> { actions:[...], forceOff, info }
//   reading  generator-side power (W) and voltage (V); null = not known (nothing is decided from it)
//   events   recent gen_events rows, newest first: { action, created_at }
//
// During a run (force_on), measured from the start (force_until - force_max_run_min):
//   V or W seen            -> 'start_confirmed' once
//   W seen                 -> 'charge_confirmed' once
//   nothing by START_GRACE_MIN        -> 'start_not_confirmed' + alert (once)
//   voltage but no power by CHARGE_GRACE_MIN -> 'charge_not_confirmed' + alert (once)
// After a run ends (control_end / control_stop / cron_force_end; control_auto is left to the inverter) for 60 min:
//   1. Charging must stop: W <= RUN_W -> 'charge_stop_confirmed' once. Still charging CHARGE_STOP_MIN after the end
//      -> force AGS Off on every inverter.
//   2. The generator must shut off (cool-down allowed): no voltage and no power -> 'stop_confirmed' (done). Voltage
//      still there GEN_OFF_MIN after the end -> force AGS Off.
//   Forcing logs 'watchdog_stop_sent' + alert, repeated every REALERT_MIN while it persists; AGS Off is held
//   (forceOff) until the generator is confirmed off, then the normal setting goes back.
// ─────────────────────────────────────────────────────────────────────────────

export const RUN_W = 200, RUN_V = 50;
export const START_GRACE_MIN = 10;     // no voltage and no power this long after a start -> alert
export const CHARGE_GRACE_MIN = 15;    // voltage but still no charging this long after a start -> alert
export const CHARGE_STOP_MIN = 5;      // still charging this long after the end -> force Off
export const GEN_OFF_MIN = 15;         // generator voltage still there this long after the end (cool-down) -> force Off
export const REALERT_MIN = 5;
const END_ACTIONS = /^(control_end|control_stop|control_auto|cron_force_end)$/;
const START_ACTIONS = /^(control_start|cron_schedule_start)$/;

const t = (x) => (x ? new Date(x).getTime() : null);
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function planWatchdog({ cfg = {}, reading = {}, now = new Date(), events = [] } = {}) {
  const nowMs = new Date(now).getTime();
  const w = num(reading.w), v = num(reading.v);
  const charging = w == null ? null : Math.abs(w) > RUN_W;
  const voltage = v == null ? null : v > RUN_V;
  const anyOn = charging === true || voltage === true;
  const known = charging != null || voltage != null;
  const actions = [];
  const since = (ms, re) => events.some(e => re.test(e.action) && t(e.created_at) >= ms);
  const lastOf = (re) => events.find(e => re.test(e.action));
  const mins = (ms) => Math.round((nowMs - ms) / 60000);

  if (cfg.force_on) {
    const until = t(cfg.force_until);
    const startMs = until != null && Number(cfg.force_max_run_min) > 0 ? until - Number(cfg.force_max_run_min) * 60000 : t(lastOf(START_ACTIONS)?.created_at);
    if (startMs != null && known) {
      if (anyOn && !since(startMs, /^start_confirmed$/)) actions.push({ type: "event", action: "start_confirmed", minutes: mins(startMs) });
      if (charging && !since(startMs, /^charge_confirmed$/)) actions.push({ type: "event", action: "charge_confirmed", minutes: mins(startMs) });
      if (!anyOn && nowMs - startMs >= START_GRACE_MIN * 60000 && !since(startMs, /^(start_confirmed|start_not_confirmed)$/))
        actions.push({ type: "event", action: "start_not_confirmed", alert: true, minutes: mins(startMs) });
      if (voltage && charging === false && nowMs - startMs >= CHARGE_GRACE_MIN * 60000 && !since(startMs, /^(charge_confirmed|charge_not_confirmed)$/))
        actions.push({ type: "event", action: "charge_not_confirmed", alert: true, minutes: mins(startMs) });
    }
    return { actions, forceOff: false, info: { phase: "run", startMs } };
  }

  const end = lastOf(END_ACTIONS);
  const endMs = t(end?.created_at);
  if (endMs == null || nowMs - endMs > 60 * 60000) return { actions, forceOff: false, info: { phase: "idle" } };
  if (events.some(e => START_ACTIONS.test(e.action) && t(e.created_at) > endMs)) return { actions, forceOff: false, info: { phase: "idle" } };
  if (since(endMs, /^stop_confirmed$/)) return { actions, forceOff: false, info: { phase: "stopped", endMs } };
  const stopSent = events.filter(e => e.action === "watchdog_stop_sent" && t(e.created_at) >= endMs);
  const holding = stopSent.length > 0;
  const elapsed = nowMs - endMs;
  if (!known) return { actions, forceOff: holding, info: { phase: "unknown", endMs } };
  if (end.action === "control_auto") return { actions, forceOff: false, info: { phase: "auto", endMs } };

  // Stage 1: charging stopped.
  if (charging === false && !since(endMs, /^charge_stop_confirmed$/)) actions.push({ type: "event", action: "charge_stop_confirmed", minutes: mins(endMs) });
  // Stage 2: generator off (no voltage, no power). With no voltage reading, power alone decides after the cool-down.
  const genOff = voltage === false ? charging !== true : (voltage == null && charging === false && elapsed >= GEN_OFF_MIN * 60000);
  if (genOff) {
    actions.push({ type: "event", action: "stop_confirmed", minutes: mins(endMs), forced: holding, powerOnly: voltage == null });
    return { actions, forceOff: false, info: { phase: "stopped", endMs } };
  }

  let reason = null;
  if (charging === true && elapsed >= CHARGE_STOP_MIN * 60000) reason = "charging";
  else if (voltage === true && elapsed >= GEN_OFF_MIN * 60000) reason = "voltage";
  const forceOff = holding || reason != null;
  if (reason) {
    const lastSent = t(stopSent[0]?.created_at);
    if (lastSent == null || nowMs - lastSent >= REALERT_MIN * 60000)
      actions.push({ type: "event", action: "watchdog_stop_sent", alert: true, reason, minutes: mins(endMs), attempt: stopSent.length + 1 });
  }
  return { actions, forceOff, info: { phase: charging ? "charging" : "cooldown", endMs } };
}
