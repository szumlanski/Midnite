import { useEffect, useRef } from "react";

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

/** Poll rates, in one place so they are easy to find and tune. */
export const POLL = {
  LIVE_FLOW_MS: 10000,   // Live tab real-time overlay (was 5000)
  LIVE_STATUS_MS: 60000, // Live tab 5-min status refresh
  SITE_MS: 120000,       // SiteHero status + flow
  FLEET_MS: 120000,      // Fleet view
};
