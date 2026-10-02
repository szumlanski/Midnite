// HIG alerts and toasts.
//   await confirmAlert("Delete this alert?", { message, action: "Delete", destructive: true })  -> true/false
//   toast("Alert deleted", { icon: "check" })
// Alerts: a short title, an optional message, two buttons side by side. A destructive action is red and
// never the default: focus starts on Cancel. Escape cancels. Toasts confirm a finished action without
// interrupting and disappear on their own. Mount <AlertHost/> once (pages/_app.js).
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { gsap, prefersReducedMotion, useIsoLayoutEffect } from "./motion";

const alertSubs = new Set();
const toastSubs = new Set();
let alertQueue = [];
let toastSeq = 0;

const DESTRUCTIVE = /^(delete|remove|clear|discard|void|reset|unlink|archive|revoke|overwrite|sign out|stop)/i;

export function confirmAlert(title, opts = {}) {
  return new Promise((resolve) => {
    const action = opts.action || "OK";
    const destructive = opts.destructive ?? DESTRUCTIVE.test(action);
    alertQueue = [...alertQueue, { id: Date.now() + Math.random(), title, message: opts.message || null, action, cancel: opts.cancel || "Cancel", destructive, resolve }];
    alertSubs.forEach((fn) => fn(alertQueue));
  });
}

export function toast(text, opts = {}) {
  const t = { id: ++toastSeq, text, icon: opts.icon || (opts.tone === "error" ? "alert" : "check"), tone: opts.tone || "ok", ms: opts.ms || 2600 };
  toastSubs.forEach((fn) => fn(t));
}

function AlertCard({ a, onDone }) {
  const card = useRef(null), overlay = useRef(null), cancelBtn = useRef(null), actionBtn = useRef(null);
  const finish = (val) => {
    const done = () => onDone(a, val);
    if (prefersReducedMotion()) return done();
    gsap.to(overlay.current, { autoAlpha: 0, duration: 0.15 });
    gsap.to(card.current, { autoAlpha: 0, scale: 0.96, duration: 0.15, onComplete: done });
  };
  useIsoLayoutEffect(() => {
    (a.destructive ? cancelBtn : actionBtn).current?.focus({ preventScroll: true });
    if (prefersReducedMotion()) return;
    gsap.fromTo(overlay.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18 });
    gsap.fromTo(card.current, { autoAlpha: 0, scale: 1.08 }, { autoAlpha: 1, scale: 1, duration: 0.22, ease: "back.out(1.6)" });
  }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
      if (e.key === "Tab") { e.preventDefault(); (document.activeElement === cancelBtn.current ? actionBtn : cancelBtn).current?.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <div className="ui-alert-root">
      <div ref={overlay} className="ui-alert-overlay" />
      <div ref={card} className="ui-alert" role="alertdialog" aria-modal="true" aria-labelledby={`al-${a.id}`} aria-describedby={a.message ? `ald-${a.id}` : undefined}>
        <div className="ui-alert-text">
          <div id={`al-${a.id}`} className="ui-alert-title">{a.title}</div>
          {a.message && <div id={`ald-${a.id}`} className="ui-alert-msg">{a.message}</div>}
        </div>
        <div className="ui-alert-btns">
          <button ref={cancelBtn} type="button" className="ui-alert-btn" onClick={() => finish(false)}>{a.cancel}</button>
          <button ref={actionBtn} type="button" className={`ui-alert-btn ui-alert-btn--action${a.destructive ? " is-destructive" : ""}`} onClick={() => finish(true)}>{a.action}</button>
        </div>
      </div>
    </div>
  );
}

function Toast({ t, onGone }) {
  const el = useRef(null);
  useIsoLayoutEffect(() => {
    const leave = () => {
      if (prefersReducedMotion()) return onGone(t.id);
      gsap.to(el.current, { autoAlpha: 0, y: 8, duration: 0.2, onComplete: () => onGone(t.id) });
    };
    if (!prefersReducedMotion()) gsap.fromTo(el.current, { autoAlpha: 0, y: 14, scale: 0.98 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.28, ease: "power3.out" });
    const timer = setTimeout(leave, t.ms);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div ref={el} className={`ui-toast ui-toast--${t.tone}`} role={t.tone === "error" ? "alert" : "status"}>
      <Icon name={t.icon} />
      <span>{t.text}</span>
    </div>
  );
}

export function AlertHost() {
  const [queue, setQueue] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [mounted, setMounted] = useState(false); // portal only after hydration (server renders nothing)
  useEffect(() => {
    setMounted(true);
    const onAlerts = (q) => setQueue(q);
    const onToast = (t) => setToasts((list) => [...list.slice(-2), t]);
    alertSubs.add(onAlerts); toastSubs.add(onToast);
    return () => { alertSubs.delete(onAlerts); toastSubs.delete(onToast); };
  }, []);
  const done = (a, val) => {
    alertQueue = alertQueue.filter((x) => x.id !== a.id);
    setQueue(alertQueue);
    a.resolve(val);
  };
  if (!mounted) return null;
  return createPortal(
    <>
      {queue[0] && <AlertCard key={queue[0].id} a={queue[0]} onDone={done} />}
      <div className="ui-toasts" aria-live="polite">
        {toasts.map((t) => <Toast key={t.id} t={t} onGone={(id) => setToasts((l) => l.filter((x) => x.id !== id))} />)}
      </div>
    </>,
    document.body
  );
}
