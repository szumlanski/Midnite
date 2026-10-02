// Buttons, the "…" menu and segmented controls. Styling lives in styles/globals.css (ui-* classes)
// so hover, press, focus and the phone/desktop target sizes come from one place.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { gsap, prefersReducedMotion, useIsoLayoutEffect, useSlidingIndicator } from "./motion";

// variant: "primary" | "secondary" | "plain" | "destructive"; size: "sm" | "md" | "lg"
export function Button({ variant = "secondary", size = "md", icon, iconRight, full, className = "", children, ...rest }) {
  return (
    <button type="button" className={`ui-btn ui-btn--${variant} ui-btn--${size}${full ? " ui-btn--full" : ""} ${className}`.trim()} {...rest}>
      {icon && <Icon name={icon} />}
      {children != null && <span>{children}</span>}
      {iconRight && <Icon name={iconRight} />}
    </button>
  );
}

export function IconButton({ icon, label, className = "", badge, ...rest }) {
  return (
    <button type="button" className={`ui-iconbtn ${className}`.trim()} aria-label={label} title={label} {...rest}>
      <Icon name={icon} />
      {badge}
    </button>
  );
}

// The "…" menu. items: [{ label, icon, onClick, destructive, checked, sep, header }]
// - `sep: true` draws a divider; `header` draws a small section label.
// - Destructive items go last, after a divider (callers order them; see docs/hig/notes.md).
// Escape or a click outside closes it and returns focus to the button.
export function MoreMenu({ items = [], label = "More", icon = "more", buttonClassName = "", align = "right" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const btn = useRef(null);
  const menu = useRef(null);

  // The menu renders in a portal with fixed positioning so scrolling sheets and tables never clip it.
  // It opens below the button, or above when there is not enough room underneath.
  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const h = menu.current?.offsetHeight || 0;
    const below = window.innerHeight - r.bottom;
    const up = h && below < h + 12 && r.top > below;
    setPos({
      top: up ? Math.max(8, r.top - h - 6) : r.bottom + 6,
      left: align === "right" ? undefined : Math.max(8, r.left),
      right: align === "right" ? Math.max(8, window.innerWidth - r.right) : undefined,
      origin: `${up ? "bottom" : "top"} ${align === "right" ? "right" : "left"}`,
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (btn.current?.contains(e.target) || menu.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const els = [...(menu.current?.querySelectorAll("button.ui-menu-item:not([disabled])") || [])];
        if (!els.length) return;
        e.preventDefault();
        const i = els.indexOf(document.activeElement);
        const n = e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
        els[n].focus();
      }
    };
    const onMove = () => setOpen(false);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  useIsoLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open]);

  useIsoLayoutEffect(() => {
    if (!open || !pos || !menu.current) return;
    // Re-measure once the real height is known (decides whether to open upward).
    if (!menu.current.dataset.placed) { menu.current.dataset.placed = "1"; place(); return; }
    menu.current.querySelector("button.ui-menu-item:not([disabled])")?.focus({ preventScroll: true });
    if (prefersReducedMotion()) return;
    gsap.fromTo(menu.current, { autoAlpha: 0, scale: 0.96 },
      { autoAlpha: 1, scale: 1, duration: 0.16, ease: "power2.out", transformOrigin: pos.origin });
  }, [pos]);

  const choose = (it) => { setOpen(false); btn.current?.focus(); it.onClick?.(); };

  return (
    <>
      <button ref={btn} type="button" className={`ui-iconbtn ${buttonClassName}`.trim()} aria-label={label} title={label}
        aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        <Icon name={icon} />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div ref={menu} role="menu" className="ui-menu" onClick={(e) => e.stopPropagation()}
          style={{ position: "fixed", top: pos?.top ?? -9999, left: pos?.left, right: pos?.right, visibility: pos ? "visible" : "hidden" }}>
          {items.filter(Boolean).map((it, i) => {
            if (it.sep) return <div key={`s${i}`} className="ui-menu-sep" role="separator" />;
            if (it.header) return <div key={`h${i}`} className="ui-menu-header">{it.header}</div>;
            return (
              <button key={i} type="button" role={it.checked != null ? "menuitemradio" : "menuitem"}
                aria-checked={it.checked != null ? !!it.checked : undefined}
                className={`ui-menu-item${it.destructive ? " ui-menu-item--destructive" : ""}`}
                disabled={it.disabled} onClick={() => choose(it)}>
                <span className="ui-menu-icon">{it.icon && <Icon name={it.icon} />}</span>
                <span className="ui-menu-label">{it.label}</span>
                {it.checked && <Icon name="check" className="ui-menu-check" />}
              </button>
            );
          })}
        </div>,
        document.body)}
    </>
  );
}

// Segmented control: all text segments (HIG: don't mix text and icons). The selection pill glides.
export function Segmented({ options, value, onChange, label, size = "md", className = "" }) {
  const box = useRef(null);
  const ind = useRef(null);
  useSlidingIndicator(box, ind, value);
  return (
    <div ref={box} role="tablist" aria-label={label} className={`ui-seg ui-seg--${size} ${className}`.trim()}>
      <span ref={ind} className="ui-seg-ind" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value}
          data-active={o.value === value ? "true" : "false"} className="ui-seg-btn" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// On/off switch (HIG toggle). Use for settings that take effect immediately.
export function Switch({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={label} title={label} disabled={disabled}
      className="ui-switch" data-on={checked ? "true" : "false"} onClick={() => onChange(!checked)}>
      <span className="ui-switch-knob" />
    </button>
  );
}
