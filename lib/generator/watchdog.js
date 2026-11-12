// ─────────────────────────────────────────────────────────────────────────────
// Generator watchdog: PURE planner (no API, no DB). Jason, 2026-11-12: these inverters are slow to start charging
// from the generator and slow to stop, so after every start and every end the server waits and then checks that the
// generator really did what was intended, and acts if it didn't. Same logic for Run now, one-off and exercise runs
// (all three go through the same start/end path and set force_on / force_until).
//
// planWatchdog({ cfg, running, now, events }) -> { actions:[...], forceOff:boolean, info }
//   cfg      gen_config row; running = observed true / false / null (unknown, nothing is decided)
//   events   recent gen_events rows, newest first: { action, created_at }
//
//   Start check (a run is on): the run started at force_until - force_max_run_min.
//     running -> 'start_confirmed' once.  Not running START_GRACE_MIN after the start -> 'start_not_confirmed' once
//     (+ alert). The every-minute resync keeps re-sending the run's settings meanwhile.
//   Stop check (no run on, a run ended in the last 60 min by end / stop / cron_force_end / schedule end):
//     not running at or after STOP_GRACE_MIN -> 'stop_confirmed' once.
//     still running STOP_GRACE_MIN after the end -> 'watchdog_stop_sent' (+ alert): AGS Off (2) is forced on every
//     inverter (forceOff) until the generator is seen stopped, then the normal AGS goes back. Re-alerts every
//     STOP_GRACE_MIN while it keeps running. "Return to automatic" (control_auto) is left to the inverter's own
//     start/stop, so it is not forced off.
// ─────────────────────────────────────────────────────────────────────────────

export const START_GRACE_MIN = 10;
export const STOP_GRACE_MIN = 5;
const END_ACTIONS = /^(control_end|control_stop|control_auto|cron_force_end)$/;
const START_ACTIONS = /^(control_start|cron_schedule_start)$/;

const t = (x) => (x ? new Date(x).getTime() : null);

export function planWatchdog({ cfg = {}, running = null, now = new Date(), events = [] } = {}) {
  const nowMs = new Date(now).getTime();
  const actions = [];
  const since = (ms, re) => events.some(e => re.test(e.action) && t(e.created_at) >= ms);
  const lastOf = (re) => events.find(e => re.test(e.action));
  let forceOff = false;

  if (cfg.force_on) {
    const until = t(cfg.force_until);
    const startMs = until != null && Number(cfg.force_max_run_min) > 0 ? until - Number(cfg.force_max_run_min) * 60000 : t(lastOf(START_ACTIONS)?.created_at);
    if (startMs != null && running != null) {
      if (running && !since(startMs, /^start_confirmed$/)) actions.push({ type: "event", action: "start_confirmed", minutes: Math.round((nowMs - startMs) / 60000) });
      if (!running && nowMs - startMs >= START_GRACE_MIN * 60000 && !since(startMs, /^(start_confirmed|start_not_confirmed)$/))
        actions.push({ type: "event", action: "start_not_confirmed", alert: true, minutes: Math.round((nowMs - startMs) / 60000) });
    }
    return { actions, forceOff, info: { phase: "run", startMs } };
  }

  const end = lastOf(END_ACTIONS);
  const endMs = t(end?.created_at);
  if (endMs == null || nowMs - endMs > 60 * 60000) return { actions, forceOff, info: { phase: "idle" } };
  // A new start after this end belongs to the start check, not here.
  if (events.some(e => START_ACTIONS.test(e.action) && t(e.created_at) > endMs)) return { actions, forceOff, info: { phase: "idle" } };
  const stopSent = events.filter(e => e.action === "watchdog_stop_sent" && t(e.created_at) >= endMs);
  const confirmed = since(endMs, /^stop_confirmed$/);
  const elapsed = nowMs - endMs;
  if (confirmed) return { actions, forceOff, info: { phase: "stopped", endMs } };
  if (running == null) return { actions, forceOff: stopSent.length > 0, info: { phase: "unknown", endMs } };

  if (!running) {
    if (elapsed >= STOP_GRACE_MIN * 60000 || stopSent.length) actions.push({ type: "event", action: "stop_confirmed", minutes: Math.round(elapsed / 60000), forced: stopSent.length > 0 });
    // Keep AGS Off until that confirmation is written (this tick); the next tick restores the normal AGS.
    return { actions, forceOff: stopSent.length > 0 && !(elapsed >= STOP_GRACE_MIN * 60000 || stopSent.length), info: { phase: "stopping", endMs } };
  }
  // Still running after the end.
  if (end.action === "control_auto") return { actions, forceOff, info: { phase: "auto", endMs } };
  if (elapsed >= STOP_GRACE_MIN * 60000) {
    forceOff = true;
    const lastSent = t(stopSent[0]?.created_at);
    if (lastSent == null || nowMs - lastSent >= STOP_GRACE_MIN * 60000)
      actions.push({ type: "event", action: "watchdog_stop_sent", alert: true, minutes: Math.round(elapsed / 60000), attempt: stopSent.length + 1 });
  }
  return { actions, forceOff, info: { phase: "stopping", endMs } };
}
