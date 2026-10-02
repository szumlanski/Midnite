// Buttons, the "…" menu and segmented controls. Styling lives in styles/globals.css (ui-* classes)
// so hover, press, focus and the phone/desktop target sizes come from one place.
import { useEffect, useRef, useState } from "react";
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
  const wrap = useRef(null);
  const btn = useRef(null);
  const menu = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => {
      if (e.key === "Escape") { setOpen(false); btn.current?.focus(); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const els = [...(menu.current?.querySelectorAll("button.ui-menu-item") || [])];
        if (!els.length) return;
        e.preventDefault();
        const i = els.indexOf(document.activeElement);
        const n = e.key === "ArrowDown" ? (i + 1) % els.length : (i - 1 + els.length) % els.length;
        els[n].focus();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open]);

  useIsoLayoutEffect(() => {
    if (!open || !menu.current) return;
    menu.current.querySelector("button.ui-menu-item")?.focus({ preventScroll: true });
    if (prefersReducedMotion()) return;
    gsap.fromTo(menu.current, { autoAlpha: 0, scale: 0.96, y: -4 },
      { autoAlpha: 1, scale: 1, y: 0, duration: 0.16, ease: "power2.out", transformOrigin: align === "right" ? "top right" : "top left" });
  }, [open]);

  const choose = (it) => { setOpen(false); btn.current?.focus(); it.onClick?.(); };

  return (
    <div ref={wrap} className="ui-menu-wrap">
      <button ref={btn} type="button" className={`ui-iconbtn ${buttonClassName}`.trim()} aria-label={label} title={label}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} />
      </button>
      {open && (
        <div ref={menu} role="menu" className={`ui-menu ui-menu--${align}`}>
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
        </div>
      )}
    </div>
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
