// Generator UI: shared pieces (API client, small form controls, formatters).
// Everything here follows the app design system (components/ui/*, styles/globals.css ui-* classes).
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Icon } from "@/components/ui/Icon";
import { TEXT, MUTED, FAINT, BORDER, CARD, FS, GRID_IN_TEXT, BATTERY, BATTERY_TEXT, GEN_TEXT, SANS } from "@/components/ui/tokens";
import { DAY_NAMES } from "@/lib/generator/core";

// POST /api/generator?action=X with the Supabase JWT and the active Midnite account. Throws an Error
// carrying the server's own error text and the HTTP status (e.status).
export async function genApi(action, body = {}) {
  let token = null;
  try { token = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch { /* signed out */ }
  let accountId;
  try { accountId = localStorage.getItem("midnite_account_id") || undefined; } catch { /* storage blocked */ }
  const res = await fetch(`/api/generator?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ accountId, ...body }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const e = new Error(data?.error || `Request failed (${res.status})`);
    e.status = res.status;
    throw e;
  }
  return data || {};
}

export const lbl = { fontSize: FS.footnote, color: MUTED, fontWeight: 600, display: "block", marginBottom: 6 };
export const fieldS = { width: "100%", boxSizing: "border-box", cursor: "text", fontFamily: SANS };

// Labelled field wrapper.
export function Field({ label, htmlFor, hint, children, style }) {
  return (
    <div style={{ minWidth: 0, ...style }}>
      <label htmlFor={htmlFor} style={lbl}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: FS.caption, color: MUTED, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

// Whole-number input that keeps its text while typing (empty allowed).
export function NumInput({ id, value, onChange, min, max, placeholder, suffix, width, disabled }) {
  return (
    <div style={{ position: "relative", width: width || "100%" }}>
      <input id={id} className="ui-field" type="number" inputMode="numeric" min={min} max={max} step={1} value={value ?? ""} placeholder={placeholder}
        disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ ...fieldS, paddingRight: suffix ? 34 : 12 }} />
      {suffix && <span aria-hidden="true" style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", fontSize: FS.footnote, color: MUTED, pointerEvents: "none" }}>{suffix}</span>}
    </div>
  );
}

// Hours + minutes pair -> minutes.
export function DurationInput({ idPrefix, minutes, onChange, disabled }) {
  const m = Number(minutes) || 0;
  const [h, setH] = useState(String(Math.floor(m / 60)));
  const [mm, setMm] = useState(String(m % 60));
  useEffect(() => { setH(String(Math.floor((Number(minutes) || 0) / 60))); setMm(String((Number(minutes) || 0) % 60)); }, [minutes]);
  const push = (hh, mi) => { const t = (parseInt(hh, 10) || 0) * 60 + (parseInt(mi, 10) || 0); onChange(t); };
  return (
    <div style={{ display: "flex", gap: 8 }}>
      <NumInput id={`${idPrefix}-h`} value={h} min={0} max={24} suffix="h" disabled={disabled} onChange={(v) => { setH(v); push(v, mm); }} />
      <NumInput id={`${idPrefix}-m`} value={mm} min={0} max={59} suffix="m" disabled={disabled} onChange={(v) => { setMm(v); push(h, v); }} />
    </div>
  );
}

// Weekday chips (days_mask bit 0 = Sunday).
export function DayChips({ mask, onChange, disabled }) {
  const m = Number(mask) || 0;
  return (
    <div role="group" aria-label="Days" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
      {DAY_NAMES.map((d, i) => {
        const on = (m & (1 << i)) !== 0;
        return (
          <button key={d} type="button" className="ui-chip" aria-pressed={on} disabled={disabled}
            onClick={() => onChange(on ? m & ~(1 << i) : m | (1 << i))}
            style={{ minWidth: 48, justifyContent: "center", ...(on ? { background: "#F5F3FF", borderColor: "#C4B5FD", color: GEN_TEXT } : {}) }}>
            {d}
          </button>
        );
      })}
    </div>
  );
}

export function ErrorNote({ children }) {
  if (!children) return null;
  return (
    <div role="alert" style={{ display: "flex", gap: 8, alignItems: "flex-start", background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12, padding: "10px 12px", fontSize: FS.subhead, color: GRID_IN_TEXT, marginTop: 10 }}>
      <Icon name="alert" style={{ marginTop: 2, flexShrink: 0 }} /><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </div>
  );
}

export function InfoNote({ children, icon = "info" }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: FS.footnote, color: MUTED, lineHeight: 1.5 }}>
      <Icon name={icon} style={{ marginTop: 2, flexShrink: 0 }} /><span>{children}</span>
    </div>
  );
}

// "Sending to the inverter..." banner while a register write is in flight.
export function PendingNote({ text }) {
  if (!text) return null;
  return (
    <div role="status" style={{ display: "flex", gap: 10, alignItems: "center", background: "#F5F3FF", border: "1px solid #DDD6FE", borderRadius: 12, padding: "10px 12px", fontSize: FS.subhead, color: GEN_TEXT, marginTop: 10 }}>
      <span className="gen-spin" aria-hidden="true" />{text}
    </div>
  );
}

export function EmptyState({ icon = "info", title, hint, action = null }) {
  return (
    <div style={{ textAlign: "center", padding: "32px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 28, color: FAINT }}><Icon name={icon} /></span>
      <div style={{ fontSize: FS.body, fontWeight: 700, color: TEXT }}>{title}</div>
      {hint && <div style={{ fontSize: FS.subhead, color: MUTED, maxWidth: 360 }}>{hint}</div>}
      {action}
    </div>
  );
}

export function Card({ title, icon, right, children, style }) {
  return (
    <section className="ui-card" style={{ padding: 16, marginBottom: 12, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {title && <h3 className="ui-card-title" style={{ margin: 0 }}>{icon && <Icon name={icon} />}{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

// Live freshness chip in the app's LiveChip style: seconds since the generator reading last CHANGED.
export function FreshChip({ atMs, stale = 120 }) {
  const [, setT] = useState(0);
  useEffect(() => { const id = setInterval(() => setT((t) => t + 1), 1000); return () => clearInterval(id); }, []);
  if (!atMs) return null;
  const s = Math.max(0, Math.round((Date.now() - atMs) / 1000));
  const old = s > stale;
  const label = s < 3 ? "just now" : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return (
    <span style={{ fontSize: FS.caption, fontWeight: 600, color: old ? "#92400E" : BATTERY_TEXT, background: old ? "#FEF3C7" : "transparent", padding: old ? "2px 8px" : 0, borderRadius: 10, whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}>
      {old ? <Icon name="alert" /> : <span style={{ width: 6, height: 6, borderRadius: "50%", background: BATTERY, display: "inline-block" }} />}Updated {label}
    </span>
  );
}

// ── Formatters ──
export const fmtW = (w) => (w == null || Number.isNaN(Number(w)) ? "--" : Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`);
export const fmtHours = (sec) => {
  const h = (Number(sec) || 0) / 3600;
  return h === 0 ? "0 h" : h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h)} h`;
};
export function fmtWhen(iso, tz) {
  if (!iso) return "--";
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch { return String(iso); }
}
export function fmtClockAt(iso, tz) {
  try { return new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, hour: "numeric", minute: "2-digit" }).format(new Date(iso)); } catch { return ""; }
}
export const pctOrNull = (v) => (v === "" || v == null ? null : Number(v));
export const AGS_LABEL = { 0: "Automatic", 1: "Forced on", 2: "Forced off" };
export const ROLE_LABEL = { owner: "Owner", shared: "Shared", admin: "Admin", system: "System" };
export const SOURCE_LABEL = { auto: "Automatic", force: "Run now", schedule: "Schedule", manual: "At the unit" };

// CSV download (client-side).
export function downloadCsv(filename, rows) {
  const esc = (v) => { const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

export const tinyMuted = { fontSize: FS.caption, color: MUTED };
export const rowTitle = { fontSize: FS.body, fontWeight: 600, color: TEXT };
export const subtle = { fontSize: FS.footnote, color: MUTED };
export const borderC = BORDER;
export const cardC = CARD;
