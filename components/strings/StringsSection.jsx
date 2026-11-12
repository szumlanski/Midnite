// Day tab → Strings section: daily energy per string (MPPT) from mppt_daily (collected nightly from the
// 5-minute CSV export). Range picker, a stacked daily bar chart by string, a per-string table with kWh/kW
// and share, underperformer flags, and the sum-of-strings vs inverter E-Today cross-check.
// Bar chart rules (CLAUDE.md): ONE stackId + stackOffset="sign", activeBar={false}, Tooltip cursor={false}.
import { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Button, Segmented } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { toast } from "@/components/ui/Alert";
import { TEXT, MUTED, BORDER, CARD, BG, FS, SANS, GRID_IN_TEXT, stringColor } from "@/components/ui/tokens";
import { usePrefersReducedMotion } from "@/components/ui/motion";
import { useStringLabels, stringsApi, mpptKey } from "./labels";

const etToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shift = (ymd, n) => new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
export function rangeFor(id, today = etToday()) {
  if (id === "7d") return { from: shift(today, -7), to: shift(today, -1), label: "the last 7 days" };
  if (id === "30d") return { from: shift(today, -30), to: shift(today, -1), label: "the last 30 days" };
  if (id === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today, label: "this year" };
  return { from: `${today.slice(0, 7)}-01`, to: today, label: "this month" };
}
const RANGES = [{ value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "month", label: "This month" }, { value: "year", label: "This year" }];
const kwh = (v, d = 1) => (v == null ? "--" : `${Number(v).toFixed(v >= 100 ? 0 : d)} kWh`);
const pct = (v) => (v == null ? "--" : `${Math.round(v * 100)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TOOLTIP_S = { background: CARD, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 14px", fontSize: FS.footnote, color: TEXT, boxShadow: "0 4px 20px rgba(0,0,0,0.12)", fontFamily: SANS };
const th = { textAlign: "right", padding: "8px 8px", fontSize: FS.caption, fontWeight: 700, color: MUTED, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap" };
const td = { textAlign: "right", padding: "10px 8px", fontSize: FS.footnote, color: TEXT, borderBottom: `1px solid ${BORDER}`, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

export function StringsSection({ site, siteKey, isAdmin }) {
  const motionOK = !usePrefersReducedMotion();
  const { nameOf, customName } = useStringLabels();
  const [range, setRange] = useState("7d");
  const [res, setRes] = useState({ key: null, data: null, err: null });
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const r = rangeFor(range);
  const reqKey = `${siteKey}|${r.from}|${r.to}|${tick}`;

  useEffect(() => {
    if (!siteKey) return;
    let alive = true;
    stringsApi("energy", { site_key: siteKey, from: r.from, to: r.to })
      .then((d) => { if (alive) setRes({ key: reqKey, data: d, err: null }); })
      .catch((e) => { if (alive) setRes({ key: reqKey, data: null, err: e }); });
    return () => { alive = false; };
  }, [siteKey, r.from, r.to, reqKey]);
  const loading = res.key !== reqKey;
  const data = loading ? null : res.data, err = loading ? null : res.err;

  const invIndex = useMemo(() => Object.fromEntries(site.inverters.map((inv, i) => [inv.sn, i])), [site]);
  const invLabel = (sn) => site.inverters.find((i) => i.sn === sn)?.label || sn.slice(-8);
  const multiInv = site.inverters.length > 1;
  const displayName = (sn, n) => (multiInv && !customName(sn, n) ? `${invLabel(sn)} ${nameOf(sn, n)}` : nameOf(sn, n));
  const strings = data?.strings || [];
  const series = strings.map((s) => ({ key: mpptKey(s.sn, s.mppt), sn: s.sn, mppt: s.mppt, color: stringColor(s.mppt, invIndex[s.sn] || 0), name: displayName(s.sn, s.mppt) }));
  const byMonth = range === "year";
  const chartData = ((byMonth ? data?.byMonth : data?.byDay) || []).map((b) => ({
    ...b, x: byMonth ? MONTHS[Number(b.month.slice(5, 7)) - 1] : `${Number(b.day.slice(5, 7))}/${Number(b.day.slice(8, 10))}`,
  }));
  const flags = data?.flags;
  const flagOf = Object.fromEntries((flags?.strings || []).map((f) => [mpptKey(f.sn, f.mppt), f]));
  const flagged = (flags?.strings || []).filter((f) => f.flagged);
  const cc = data?.crossCheck;

  const backfill = async () => {
    setBusy(true);
    let stored = 0, empty = 0, failed = 0;
    try {
      for (let i = 0; i < 10; i++) {
        const b = await stringsApi("backfill", { site_key: siteKey, days: 30 });
        stored += b.stored; empty += b.empty; failed += b.failed?.length || 0;
        if (!b.remaining) break;
      }
      toast(`Backfill done: ${stored} inverter-days stored${empty ? `, ${empty} with no string data` : ""}${failed ? `, ${failed} failed` : ""}`);
      setTick((t) => t + 1);
    } catch (e) { toast(`Backfill failed: ${e.message}`, { icon: "alert" }); }
    finally { setBusy(false); }
  };

  return (
    <section aria-labelledby="strings-h" style={{ marginBottom: 24 }}>
      <div className="period-head">
        <div style={{ minWidth: 0 }}>
          <h2 id="strings-h" style={{ fontSize: FS.title3, fontWeight: 800, color: TEXT, letterSpacing: "-0.3px" }}>Strings</h2>
          <div style={{ fontSize: FS.subhead, color: MUTED, marginTop: 2 }}>Daily kWh per solar string (MPPT), {r.label}</div>
        </div>
        <div className="period-ctrls"><Segmented size="sm" label="Strings range" value={range} onChange={setRange} options={RANGES} /></div>
      </div>

      {err && <div role="alert" className="ui-card" style={{ padding: "12px 16px", marginBottom: 12, fontSize: FS.subhead, color: GRID_IN_TEXT, display: "flex", gap: 8, alignItems: "center" }}><Icon name="alert" />{err.message}</div>}

      {loading ? <div className="ui-card" style={{ padding: 16 }}><div className="ui-skel" role="status" aria-label="Loading strings" style={{ height: 260, borderRadius: 12 }} /></div>
        : !err && strings.length === 0 ? (
          <div className="ui-card" style={{ textAlign: "center", padding: "32px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 28, color: MUTED }}><Icon name="chart" /></span>
            <div style={{ fontSize: FS.body, fontWeight: 700, color: TEXT }}>No string data for {r.label} yet</div>
            <div style={{ fontSize: FS.subhead, color: MUTED, maxWidth: 380 }}>Each night at 1 AM Sentinel adds up the day before for every string. The first numbers show up the morning after this site is first collected.</div>
            {isAdmin && <div style={{ marginTop: 8 }}><Button icon="download" onClick={backfill} disabled={busy}>{busy ? "Backfilling…" : "Backfill 30 days"}</Button></div>}
          </div>
        ) : !err && (
          <>
            {flagged.length > 0 && (
              <div className="ui-card" role="status" style={{ padding: "12px 16px", marginBottom: 12, background: "#FFFBEB", borderColor: "#FCD34D" }}>
                {flagged.map((f) => (
                  <div key={mpptKey(f.sn, f.mppt)} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: FS.subhead, color: "#92400E", marginBottom: 2 }}>
                    <Icon name="alert" /><span><b>{displayName(f.sn, f.mppt)}</b> is {Math.round(f.pctBelow * 100)}% below the other strings over {flags.window?.days || 7} days{flags.basis === "kwh" ? " (by raw kWh; add string sizes in Settings for a fair kWh/kW comparison)" : " (kWh per kW)"}.</span>
                  </div>
                ))}
              </div>
            )}

            <div className="ui-card" style={{ padding: "16px 12px 12px", marginBottom: 12 }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData} stackOffset="sign" margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="20%" maxBarSize={byMonth ? 44 : 22}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="x" tick={{ fill: MUTED, fontSize: 11, fontFamily: SANS }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11, fontFamily: SANS }} tickLine={false} axisLine={false} width={38} />
                  <Tooltip contentStyle={TOOLTIP_S} cursor={false} labelStyle={{ color: MUTED, marginBottom: 4 }} formatter={(v, n) => [`${Number(v).toFixed(1)} kWh`, n]} />
                  {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color} fillOpacity={0.9} activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out" />)}
                </BarChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", padding: "10px 4px 2px", borderTop: `1px solid ${BORDER}`, marginTop: 8 }}>
                {series.map((s) => <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: FS.caption, fontWeight: 600, color: MUTED }}><span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} />{s.name}</span>)}
              </div>
            </div>

            <div className="ui-card" style={{ padding: 0, overflowX: "auto", marginBottom: 12 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 0 }}>
                <thead><tr>
                  <th scope="col" style={{ ...th, textAlign: "left" }}>String</th>
                  <th scope="col" style={th}>kWh</th>
                  <th scope="col" style={th}>kWh/kW</th>
                  <th scope="col" style={th}><abbr title="Share of the inverter total" style={{ textDecoration: "none" }}>Share</abbr></th>
                </tr></thead>
                <tbody>
                  {strings.map((s) => {
                    const k = mpptKey(s.sn, s.mppt), f = flagOf[k];
                    return (
                      <tr key={k}>
                        <td style={{ ...td, textAlign: "left", whiteSpace: "normal" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 10, height: 10, borderRadius: 3, background: stringColor(s.mppt, invIndex[s.sn] || 0), flexShrink: 0 }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700 }}>{nameOf(s.sn, s.mppt)}</div>
                              <div style={{ fontSize: FS.caption, color: MUTED }}>{invLabel(s.sn)} · MPPT {s.mppt}{s.kw_dc ? ` · ${s.kw_dc} kW DC` : ""}</div>
                              {f?.flagged && <span className="ui-pill" title={`${Math.round(f.pctBelow * 100)}% below the other strings over ${flags.window?.days || 7} days`} style={{ marginTop: 4, background: "#FEF3C7", color: "#92400E", whiteSpace: "normal" }}><Icon name="alert" />{Math.round(f.pctBelow * 100)}% below the others</span>}
                            </div>
                          </div>
                        </td>
                        <td style={td}>{s.kwh.toFixed(s.kwh >= 100 ? 0 : 1)}</td>
                        <td style={td}>{s.kwh_per_kw != null ? s.kwh_per_kw.toFixed(2) : <span style={{ color: MUTED }}>Set size</span>}</td>
                        <td style={td}>{pct(s.share)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {cc && cc.etoday > 0 && (
              <div style={{ fontSize: FS.footnote, color: cc.mismatch ? "#92400E" : MUTED, background: cc.mismatch ? "#FEF3C7" : BG, borderRadius: 10, padding: "8px 12px", display: "flex", gap: 6, alignItems: "flex-start" }}>
                <Icon name={cc.mismatch ? "alert" : "check"} />
                <span>Strings add up to {kwh(cc.strings)} vs the inverter E-Today total of {kwh(cc.etoday)} ({cc.diffPct >= 0 ? "+" : ""}{Math.round(cc.diffPct * 100)}%).
                  {cc.mismatch ? " That is more than 10% apart: some 5-minute samples may be missing, or a string is not reported in the export." : ""}</span>
              </div>
            )}
            {isAdmin && <div style={{ marginTop: 10 }}><Button size="sm" variant="plain" icon="download" onClick={backfill} disabled={busy}>{busy ? "Backfilling…" : "Backfill 30 days"}</Button></div>}
          </>
        )}
    </section>
  );
}
