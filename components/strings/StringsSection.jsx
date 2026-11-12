// Day tab → Strings section: daily energy per string (MPPT) from mppt_daily (collected nightly from the
// 5-minute CSV export). Range picker, a stacked daily bar chart by string, a per-string table with kWh/kW
// and share, chart toggles per string and per inverter, and the sum-of-strings vs inverter E-Today cross-check.
// Bar chart rules (CLAUDE.md): ONE stackId + stackOffset="sign", activeBar={false}, Tooltip cursor={false}.
import { useEffect, useMemo, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Button, IconButton, Segmented } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { toast } from "@/components/ui/Alert";
import { TEXT, MUTED, BORDER, CARD, BG, FS, SANS, GRID_IN_TEXT, SOLAR_TEXT, stringColor } from "@/components/ui/tokens";
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

// period (optional): {kind:"month", value:"YYYY-MM"} or {kind:"year", value:"YYYY"} from the Month / Year tab, with
// onPeriodChange(nextValue) so the tab's own month/year stays in step. Without it, the old 7d/30d/month/year picker.
const fullMonth = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
function periodRange(p, today = etToday()) {
  if (p.kind === "year") {
    const to = `${p.value}-12-31` > today ? today : `${p.value}-12-31`;
    return { from: `${p.value}-01-01`, to, label: p.value, year: true };
  }
  const last = `${p.value}-${String(fullMonth(p.value)).padStart(2, "0")}`;
  const [y, m] = p.value.split("-").map(Number);
  return { from: `${p.value}-01`, to: last > today ? today : last, label: `${MONTHS[m - 1]} ${y}`, year: false };
}
function shiftPeriod(p, n) {
  if (p.kind === "year") return String(Number(p.value) + n);
  const [y, m] = p.value.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function StringsSection({ site, siteKey, isAdmin, period = null, onPeriodChange = null }) {
  const motionOK = !usePrefersReducedMotion();
  const { nameOf, customName } = useStringLabels();
  const [range, setRange] = useState("7d");
  const [res, setRes] = useState({ key: null, data: null, err: null });
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const r = period ? periodRange(period) : rangeFor(range);
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
  const byMonth = period ? period.kind === "year" : range === "year";
  const chartData = ((byMonth ? data?.byMonth : data?.byDay) || []).map((b) => ({
    ...b, x: byMonth ? MONTHS[Number(b.month.slice(5, 7)) - 1] : `${Number(b.day.slice(5, 7))}/${Number(b.day.slice(8, 10))}`,
  }));
  // Underperformer warnings were removed (Jason, 2026-11-12): strings differ in rating and one is paralleled, so a
  // site-median comparison is meaningless. The server still computes flags; the UI does not show them.
  // On/off toggles for strings and whole inverters (chart only). Remembered per site in this browser.
  const hideKey = `midnite_strings_hidden:${siteKey}`;
  const [hidden, setHidden] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem(hideKey) || "[]")); } catch { return new Set(); } });
  useEffect(() => { try { setHidden(new Set(JSON.parse(localStorage.getItem(hideKey) || "[]"))); } catch { setHidden(new Set()); } }, [hideKey]);
  const saveHidden = (next) => { setHidden(next); try { localStorage.setItem(hideKey, JSON.stringify([...next])); } catch { /* storage blocked */ } };
  const toggleKey = (k) => { const n = new Set(hidden); n.has(k) ? n.delete(k) : n.add(k); saveHidden(n); };
  const invKeys = (sn) => series.filter((x) => x.sn === sn).map((x) => x.key);
  const invAllHidden = (sn) => invKeys(sn).length > 0 && invKeys(sn).every((k) => hidden.has(k));
  const toggleInv = (sn) => { const n = new Set(hidden); const off = !invAllHidden(sn); invKeys(sn).forEach((k) => off ? n.add(k) : n.delete(k)); saveHidden(n); };
  const shown = series.filter((x) => !hidden.has(x.key));
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
          <div style={{ fontSize: FS.subhead, color: MUTED, marginTop: 2 }}>{byMonth ? "Monthly" : "Daily"} kWh per solar string (MPPT){period ? "" : `, ${r.label}`}</div>
        </div>
        <div className="period-ctrls">
          {period ? (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <IconButton icon="back" label={period.kind === "year" ? "Previous year" : "Previous month"} onClick={() => onPeriodChange?.(shiftPeriod(period, -1))} />
              <span style={{ fontSize: FS.subhead, fontWeight: 700, color: TEXT, minWidth: 84, textAlign: "center" }}>{r.label}</span>
              <IconButton icon="chevron" label={period.kind === "year" ? "Next year" : "Next month"} disabled={r.to >= etToday()} onClick={() => onPeriodChange?.(shiftPeriod(period, 1))} />
            </div>
          ) : <Segmented size="sm" label="Strings range" value={range} onChange={setRange} options={RANGES} />}
        </div>
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
            <div className="ui-card" style={{ padding: "16px 12px 12px", marginBottom: 12 }}>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={chartData} stackOffset="sign" margin={{ top: 4, right: 4, left: 0, bottom: 0 }} barCategoryGap="20%" maxBarSize={byMonth ? 44 : 22}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="x" tick={{ fill: MUTED, fontSize: 11, fontFamily: SANS }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={8} />
                  <YAxis tick={{ fill: MUTED, fontSize: 11, fontFamily: SANS }} tickLine={false} axisLine={false} width={38} />
                  <Tooltip contentStyle={TOOLTIP_S} cursor={false} labelStyle={{ color: MUTED, marginBottom: 4 }} formatter={(v, n) => [`${Number(v).toFixed(1)} kWh`, n]} />
                  {shown.map((s) => <Bar key={s.key} dataKey={s.key} name={s.name} stackId="a" fill={s.color} fillOpacity={0.9} activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out" />)}
                </BarChart>
              </ResponsiveContainer>
              <div style={{ borderTop: `1px solid ${BORDER}`, marginTop: 8, padding: "10px 4px 2px" }}>
                {multiInv && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }} role="group" aria-label="Show or hide inverters">
                    {site.inverters.filter((inv) => invKeys(inv.sn).length).map((inv) => {
                      const on = !invAllHidden(inv.sn);
                      return (
                        <button key={inv.sn} type="button" aria-pressed={on} onClick={() => toggleInv(inv.sn)} title={inv.sn}
                          style={{ minHeight: "var(--tap)", padding: "4px 12px", borderRadius: 999, border: `1px solid ${on ? TEXT : BORDER}`, background: on ? TEXT : CARD, color: on ? CARD : MUTED, fontSize: FS.caption, fontWeight: 700, fontFamily: SANS, cursor: "pointer" }}>
                          {invLabel(inv.sn)}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-label="Show or hide strings">
                  {series.map((x) => {
                    const on = !hidden.has(x.key);
                    return (
                      <button key={x.key} type="button" aria-pressed={on} onClick={() => toggleKey(x.key)}
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, minHeight: "var(--tap)", padding: "4px 10px", borderRadius: 999, border: `1px solid ${BORDER}`, background: on ? CARD : BG, color: on ? TEXT : MUTED, opacity: on ? 1 : 0.55, textDecoration: on ? "none" : "line-through", fontSize: FS.caption, fontWeight: 600, fontFamily: SANS, cursor: "pointer" }}>
                        <span style={{ width: 10, height: 10, borderRadius: 3, background: on ? x.color : "transparent", border: `2px solid ${x.color}`, boxSizing: "border-box" }} />{x.name}
                      </button>
                    );
                  })}
                  {hidden.size > 0 && <button type="button" onClick={() => saveHidden(new Set())} style={{ minHeight: "var(--tap)", padding: "4px 10px", border: "none", background: "transparent", color: SOLAR_TEXT, fontSize: FS.caption, fontWeight: 700, fontFamily: SANS, cursor: "pointer" }}>Show all</button>}
                </div>
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
                    const k = mpptKey(s.sn, s.mppt);
                    return (
                      <tr key={k} style={{ opacity: hidden.has(k) ? 0.45 : 1 }}>
                        <td style={{ ...td, textAlign: "left", whiteSpace: "normal" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ width: 10, height: 10, borderRadius: 3, background: stringColor(s.mppt, invIndex[s.sn] || 0), flexShrink: 0 }} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 700 }}>{nameOf(s.sn, s.mppt)}</div>
                              <div style={{ fontSize: FS.caption, color: MUTED }}>{invLabel(s.sn)} · MPPT {s.mppt}{s.kw_dc ? ` · ${s.kw_dc} kW DC` : ""}</div>
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
