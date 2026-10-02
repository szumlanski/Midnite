// One component for every pop-up (HIG Sheets / Modality).
// Phones: a bottom sheet with a grabber that rises from the bottom; drag the grabber or header down to
// dismiss. Desktop: a centered dialog. Both: role="dialog" + aria-modal, Escape and the backdrop close it,
// focus moves in on open, stays inside while open, and returns to where it was on close.
// Motion is GSAP (0.2-0.36s), skipped entirely under Reduce Motion.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { gsap, prefersReducedMotion, useIsoLayoutEffect } from "./motion";

const isPhone = () => typeof window !== "undefined" && window.matchMedia?.("(max-width: 768px)").matches;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({ title, subtitle, leading = null, onClose, closeDisabled = false, maxWidth = 520, footer = null, toolbar = null, flush = false, children, labelId }) {
  const overlay = useRef(null);
  const panel = useRef(null);
  const body = useRef(null);
  const closing = useRef(false);
  const lastFocus = useRef(null);
  const idRef = useRef(labelId || `sheet-${Math.random().toString(36).slice(2, 8)}`);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const disabledRef = useRef(closeDisabled);
  disabledRef.current = closeDisabled;

  const requestClose = () => {
    if (disabledRef.current || closing.current) return;
    closing.current = true;
    const done = () => closeRef.current?.();
    if (prefersReducedMotion() || !panel.current) return done();
    const phone = isPhone();
    gsap.to(overlay.current, { autoAlpha: 0, duration: 0.2, ease: "power1.in" });
    gsap.to(panel.current, phone
      ? { yPercent: 100, y: 0, duration: 0.24, ease: "power2.in", onComplete: done }
      : { autoAlpha: 0, scale: 0.97, duration: 0.16, ease: "power1.in", onComplete: done });
  };

  // Enter animation + focus in.
  useIsoLayoutEffect(() => {
    lastFocus.current = typeof document !== "undefined" ? document.activeElement : null;
    const first = panel.current?.querySelector("[data-autofocus]") || panel.current;
    first?.focus({ preventScroll: true });
    if (prefersReducedMotion()) return;
    gsap.fromTo(overlay.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.22, ease: "power1.out" });
    if (isPhone()) gsap.fromTo(panel.current, { yPercent: 100 }, { yPercent: 0, duration: 0.36, ease: "power3.out" });
    else gsap.fromTo(panel.current, { autoAlpha: 0, scale: 0.96, y: 8 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.22, ease: "power2.out" });
  }, []);

  // Lock page scroll; Escape closes; Tab stays inside; focus returns on close.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); requestClose(); return; }
      if (e.key !== "Tab" || !panel.current) return;
      const els = [...panel.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      lastFocus.current?.focus?.({ preventScroll: true });
    };
  }, []);

  // Phones: drag the grabber/header down to dismiss (follows the finger; past 90px or a quick flick closes).
  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (!isPhone() || closeDisabled || e.target.closest("button, a, input, select, textarea")) return;
    drag.current = { y0: e.clientY, t0: performance.now(), dy: 0 };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y0);
    gsap.set(panel.current, { y: drag.current.dy });
  };
  const onPointerUp = () => {
    const d = drag.current; drag.current = null;
    if (!d) return;
    const fast = d.dy > 30 && d.dy / (performance.now() - d.t0) > 0.6;
    if (d.dy > 90 || fast) requestClose();
    else gsap.to(panel.current, { y: 0, duration: 0.25, ease: "power2.out" });
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="ui-sheet-root">
      <div ref={overlay} className="ui-sheet-overlay" onClick={requestClose} aria-hidden="true" />
      <div ref={panel} className="ui-sheet" role="dialog" aria-modal="true" aria-labelledby={idRef.current} tabIndex={-1} style={{ "--sheet-max": `${maxWidth}px` }}>
        <div className="ui-sheet-head" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span className="ui-sheet-grabber" aria-hidden="true" />
          <div className="ui-sheet-titlebar">
            {leading}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 id={idRef.current} className="ui-sheet-title">{title}</h2>
              {subtitle && <div className="ui-sheet-sub">{subtitle}</div>}
            </div>
            <button type="button" className="ui-iconbtn ui-sheet-close" aria-label="Close" onClick={requestClose} disabled={closeDisabled}>
              <Icon name="x" />
            </button>
          </div>
          {toolbar && <div className="ui-sheet-toolbar">{toolbar}</div>}
        </div>
        <div ref={body} className={`ui-sheet-body${flush ? " ui-sheet-body--flush" : ""}`}>{children}</div>
        {footer && <div className="ui-sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
