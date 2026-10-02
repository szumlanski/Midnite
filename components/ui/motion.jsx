// GSAP setup and the small set of motion hooks the app uses.
// Rules (docs/hig/notes.md, Motion): every tween is short, transform/opacity only, never blocks input,
// and nothing moves when the OS asks for reduced motion.
import { useEffect, useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";
import { Flip } from "gsap/Flip";
import { useGSAP } from "@gsap/react";

if (typeof window !== "undefined") gsap.registerPlugin(useGSAP, Flip);

export { gsap, Flip, useGSAP };

export const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function prefersReducedMotion() {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// Animated number. Renders an empty span and writes the text itself, so a tween never fights React.
// Tweens from the previous value to the new one; first render shows the value at once unless
// `fromZero` (used once for the big hero number). Equal values never animate, so a 10s poll that
// returns the same reading causes no motion.
export function CountUp({ value, format = (v) => String(Math.round(v)), duration = 0.6, fromZero = false, className, style, as: Tag = "span" }) {
  const ref = useRef(null);
  const prev = useRef(null);
  const tween = useRef(null);
  const text = format(value);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    tween.current?.kill();
    const to = typeof value === "number" && isFinite(value) ? value : null;
    let from = prev.current;
    if (from == null && fromZero && to != null) from = 0;
    prev.current = to;
    if (to == null || from == null || from === to || prefersReducedMotion()) { el.textContent = text; return; }
    const o = { v: from };
    tween.current = gsap.to(o, {
      v: to, duration, ease: "power2.out",
      onUpdate: () => { el.textContent = format(o.v); },
      onComplete: () => { el.textContent = text; },
    });
  }, [value, text]);
  useEffect(() => () => tween.current?.kill(), []);
  return <Tag ref={ref} className={className} style={{ fontVariantNumeric: "tabular-nums", ...style }} />;
}

// Children of `scope` fade and rise in a short stagger. Re-runs only when `deps` change
// (tab or site switch), never on data polls.
export function useStaggerIn(scope, deps = [], { selector = ":scope > *", y = 8, stagger = 0.04, duration = 0.32 } = {}) {
  useGSAP(() => {
    if (prefersReducedMotion() || !scope.current) return;
    const items = scope.current.querySelectorAll(selector);
    if (!items.length) return;
    gsap.from(items, { autoAlpha: 0, y, duration, stagger, ease: "power2.out", clearProps: "opacity,visibility,transform" });
  }, { scope, dependencies: deps });
}

// A horizontal level bar (battery SOC and friends). The fill scales on the x axis, which is cheap to
// animate, and glides to each new level.
export function Meter({ value = 0, color, height = 8, track = "#EFEBE5", radius, label }) {
  const fill = useRef(null);
  const first = useRef(true);
  const pct = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  useIsoLayoutEffect(() => {
    const el = fill.current;
    if (!el) return;
    if (prefersReducedMotion()) { gsap.set(el, { scaleX: pct }); first.current = false; return; }
    if (first.current) {
      first.current = false;
      gsap.fromTo(el, { scaleX: 0 }, { scaleX: pct, duration: 0.7, ease: "power3.out", delay: 0.1 });
    } else {
      gsap.to(el, { scaleX: pct, duration: 0.5, ease: "power2.out", overwrite: true });
    }
  }, [pct]);
  const r = radius ?? height / 2;
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label={label}
      style={{ height, background: track, borderRadius: r, overflow: "hidden" }}>
      <div ref={fill} style={{ height: "100%", width: "100%", background: color, borderRadius: r, transformOrigin: "left center", transform: `scaleX(${pct})` }} />
    </div>
  );
}

// Slides an indicator element to sit behind the active item of a group (segmented controls, tab bar).
// `container` holds the items; each item carries data-active="true" when selected.
export function useSlidingIndicator(container, indicator, activeKey, { axisY = false, inset = 0 } = {}) {
  const placed = useRef(false);
  useIsoLayoutEffect(() => {
    const box = container.current, ind = indicator.current;
    if (!box || !ind) return;
    const place = (animate) => {
      const el = box.querySelector('[data-active="true"]');
      if (!el) { gsap.set(ind, { autoAlpha: 0 }); return; }
      const vars = { x: el.offsetLeft + inset, width: Math.max(0, el.offsetWidth - inset * 2), autoAlpha: 1, ...(axisY ? { y: el.offsetTop, height: el.offsetHeight } : {}) };
      if (!animate || prefersReducedMotion()) gsap.set(ind, vars);
      else gsap.to(ind, { ...vars, duration: 0.32, ease: "power3.out", overwrite: true });
    };
    place(placed.current);
    placed.current = true;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => place(false)) : null;
    ro?.observe(box);
    return () => ro?.disconnect();
  }, [activeKey]);
}
