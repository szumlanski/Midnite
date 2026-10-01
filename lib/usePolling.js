import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Interval poller that never runs while the browser tab is hidden.
 *
 * Why this exists: the Live tab polled `flowrt` every 5s per inverter with no
 * visibility guard, so a forgotten tab kept firing ~6 requests every 5 seconds
 * forever. That single route was 87% of all Vercel function calls (28,498 in
 * one 24h window) and is what burns the Pro plan's monthly credit.
 *
 * Behaviour:
 *  - The tick is skipped entirely while `document.hidden` is true. No request.
 *  - Returning to the tab fires an immediate catch-up tick, so the user does
 *    not stare at stale numbers waiting out a full interval.
 *  - Overlapping runs are suppressed: a slow response never stacks up.
 *  - `fn` is held in a ref, so an inline arrow does not restart the interval on
 *    every render. Pass `deps` for the values that SHOULD restart it.
 *
 * @param {Function} fn         Async or sync work to run each tick.
 * @param {number}   intervalMs Gap between ticks, in milliseconds.
 * @param {Array}    deps       Values that restart the poller when they change.
 * @param {object}   opts
 * @param {boolean}  opts.enabled  When false the poller does not run at all.
 * @param {boolean}  opts.leading  Run once immediately on start. Default true.
 */
export function usePolling(fn, intervalMs, deps = [], opts = {}) {
  const { enabled = true, leading = true } = opts;
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return undefined;

    let alive = true;
    let busy = false;

    const isHidden = () =>
      typeof document !== "undefined" && document.visibilityState === "hidden";

    const tick = async () => {
      if (!alive || busy || isHidden()) return;
      busy = true;
      try {
        await fnRef.current();
      } catch (e) {
        /* keep polling: one failed request must not kill the loop */
      } finally {
        busy = false;
      }
    };

    if (leading) tick();
    const id = setInterval(tick, intervalMs);

    const onVisibility = () => { if (!isHidden()) tick(); };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      alive = false;
      clearInterval(id);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, ...deps]);
}

/** Poll rates and caps, in one place so they are easy to find and tune. */
export const POLL = {
  LIVE_FLOW_MS: 10000,       // Live tab real-time overlay (was 5000)
  LIVE_STATUS_MS: 60000,     // Live tab 5-min status refresh
  SITE_MS: 120000,           // SiteHero status + flow
  FLEET_MS: 120000,          // Fleet view
  IDLE_PAUSE_MS: 10 * 60000, // Pause the live feed after 10 min with no interaction
  SESSION_MAX_MS: 60 * 60000,// Pause the live feed after 1 hour of continuous use
};

/** User actions that count as "someone is actually watching this". */
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart", "mousemove", "scroll"];

/**
 * Gate for the expensive live feed. It answers one question: should we still be
 * paying for real-time polling right now?
 *
 * Two independent caps, because they catch different people:
 *
 *  1. IDLE  - the tab is open and visible but nobody has touched it for
 *     `idleMs`. They walked away. Pause.
 *  2. SESSION - someone has genuinely been using the live view for
 *     `sessionMs` straight. Pause and make them opt back in. This is the
 *     "no free live view forever" rule, and an idly jiggled mouse cannot
 *     defeat it the way it defeats the idle cap alone.
 *
 * Either cap pauses the feed; `resume()` clears both and restarts the clock.
 * The check runs on a 1s local timer. It makes no network requests, and it
 * only touches React state when the paused flag actually flips.
 *
 * NOTE: this is client-side, so it is a cost control, not a security control.
 * A determined user with dev tools can bypass it. The server-side per-user
 * cap is the thing that would actually enforce it.
 *
 * @returns {{paused: boolean, reason: "idle"|"session"|null, resume: Function}}
 */
export function useLiveGate({ idleMs, sessionMs, enabled = true }) {
  const [state, setState] = useState({ paused: false, reason: null });
  const lastActivityRef = useRef(Date.now());
  const sessionStartRef = useRef(Date.now());

  const resume = useCallback(() => {
    lastActivityRef.current = Date.now();
    sessionStartRef.current = Date.now();
    setState({ paused: false, reason: null });
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Leaving the live view ends the session. Coming back starts a fresh hour.
      lastActivityRef.current = Date.now();
      sessionStartRef.current = Date.now();
      setState((cur) => (cur.paused ? { paused: false, reason: null } : cur));
      return undefined;
    }

    lastActivityRef.current = Date.now();
    sessionStartRef.current = Date.now();

    const onActivity = () => { lastActivityRef.current = Date.now(); };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }

    const check = () => {
      const now = Date.now();
      let reason = null;
      if (now - sessionStartRef.current >= sessionMs) reason = "session";
      else if (now - lastActivityRef.current >= idleMs) reason = "idle";
      // Only touch state when the answer changes, so this does not re-render every second.
      setState((cur) => (cur.reason === reason ? cur : { paused: !!reason, reason }));
    };
    const id = setInterval(check, 1000);

    return () => {
      clearInterval(id);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
    };
  }, [enabled, idleMs, sessionMs]);

  return { paused: state.paused, reason: state.reason, resume };
}
