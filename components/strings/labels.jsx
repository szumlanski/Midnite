// Strings (MPPT) names on the client: the API client, and a context so every MPPT readout (Live cards,
// detail panel, Day chart, Explorer, Strings view) shows the same names. Names are per inverter SERIAL
// and MPPT number (1-3). Fallback: "MPPT 1".
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// POST /api/strings?action=X with the Supabase JWT and the active Midnite account. Throws the server's
// own error text with e.status.
export async function stringsApi(action, body = {}) {
  let token = null;
  try { token = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch { /* signed out */ }
  let accountId;
  try { accountId = localStorage.getItem("midnite_account_id") || undefined; } catch { /* storage blocked */ }
  const res = await fetch(`/api/strings?action=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ accountId, ...body }),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) { const e = new Error(data?.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data || {};
}

export const mpptKey = (sn, n) => `${sn}:${n}`;
const EMPTY = { byKey: {}, inverters: [], loaded: false, error: null, siteKey: "" };

const Ctx = createContext({ ...EMPTY, nameOf: (sn, n) => `MPPT ${n}`, sizeOf: () => null, customName: () => null, reload: () => {}, setLabels: () => {} });
export const useStringLabels = () => useContext(Ctx);

// Index labels rows [{sn, mppt, label, kw_dc}] by "sn:mppt".
export const indexLabels = (rows) => Object.fromEntries((rows || []).map((r) => [mpptKey(r.sn, r.mppt), { label: r.label || null, kw_dc: r.kw_dc != null ? Number(r.kw_dc) : null }]));

// The labels state for one site (the Dashboard owns it so it can name the Day-chart bands itself, then
// hands it down with <StringLabelsContext.Provider value={...}>).
export const StringLabelsContext = Ctx;
export function useStringLabelsState(siteKey) {
  const [raw, setSt] = useState(EMPTY);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!siteKey) return;
    let alive = true;
    stringsApi("get", { site_key: siteKey })
      .then((r) => { if (alive) setSt({ byKey: indexLabels(r.labels), inverters: r.inverters || [], loaded: true, error: null, siteKey }); })
      .catch((e) => { if (alive) setSt((p) => ({ ...(p.siteKey === siteKey ? p : EMPTY), loaded: true, error: e, siteKey })); });
    return () => { alive = false; };
  }, [siteKey, tick]);
  // State from another site (or none yet) reads as empty, so a site change never shows stale names.
  const st = raw.siteKey === siteKey ? raw : EMPTY;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setLabels = useCallback((rows) => setSt((p) => ({ ...p, byKey: indexLabels(rows) })), []);
  const value = useMemo(() => ({
    ...st, reload, setLabels,
    customName: (sn, n) => st.byKey[mpptKey(sn, n)]?.label || null,
    nameOf: (sn, n) => st.byKey[mpptKey(sn, n)]?.label || `MPPT ${n}`,
    sizeOf: (sn, n) => st.byKey[mpptKey(sn, n)]?.kw_dc ?? null,
  }), [st, reload, setLabels]);
  return value;
}
