// Generator > History: run-time totals, a stacked daily chart by source, and the recent runs.
// Bar rules from CLAUDE.md: one shared stackId, stackOffset="sign", activeBar={false}, Tooltip cursor={false}.
import { useEffect, useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Segmented } from "@/components/ui/Button";
import { TEXT, MUTED, BORDER, FS, GEN_AUTO, GEN_FORCE, GEN_SCHEDULE, GEN_MANUAL } from "@/components/ui/tokens";
import { fmtDuration } from "@/lib/generator/core";
import { genApi, Card, ErrorNote, EmptyState, fmtHours, fmtWhen, fmtW, SOURCE_LABEL } from "./shared";

const SERIES = [
  { key: "auto", color: GEN_AUTO },
  { key: "force", color: GEN_FORCE },
  { key: "schedule", color: GEN_SCHEDULE },
  { key: "manual", color: GEN_MANUAL },
];

export function HistoryView({ siteKey, tz, refreshKey }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    genApi("history", { site_key: siteKey, days, limit: 50 })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setErr(e.message); setData((d) => d || { totals: null, daily: [], runs: [] }); } });
    return () => { alive = false; };
  }, [siteKey, days, refreshKey]);

  if (!data) return <div aria-busy="true" aria-label="Loading run history"><div className="ui-skel" style={{ height: 90, borderRadius: 16, marginBottom: 12 }} /><div className="ui-skel" style={{ height: 280, borderRadius: 16 }} /></div>;

  const t = data.totals || {};
  const rows = (data.daily || []).map((d) => ({
    label: d.date.slice(5).replace("-", "/"),
    ...Object.fromEntries(SERIES.map((s) => [s.key, +((d.bySource?.[s.key] || 0) / 3600).toFixed(2)])),
  }));
  const anyData = rows.some((r) => SERIES.some((s) => r[s.key] > 0));
  const shown = SERIES.filter((s) => rows.some((r) => r[s.key] > 0));

  return (
    <>
      <div className="gen-kpis" style={{ marginBottom: 12 }}>
        {[["Today", t.day], ["7 days", t.week], ["30 days", t.month], ["Year", t.year], ["All time", t.all]].map(([k, v]) => (
          <div key={k} className="ui-card" style={{ padding: "10px 12px", minWidth: 0 }}>
            <div style={{ fontSize: FS.caption, color: MUTED, fontWeight: 600 }}>{k}</div>
            <div style={{ fontSize: FS.headline, fontWeight: 800, color: TEXT, fontVariantNumeric: "tabular-nums" }}>{fmtHours(v?.sec)}</div>
            <div style={{ fontSize: FS.caption, color: MUTED }}>{v?.runs || 0} run{v?.runs === 1 ? "" : "s"}</div>
          </div>
        ))}
      </div>

      <Card title="Run time per day" icon="chart" right={<Segmented size="sm" label="Range" value={String(days)} onChange={(v) => setDays(Number(v))} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />}>
        {anyData ? (
          <>
            <div style={{ width: "100%", height: 240 }}>
              <ResponsiveContainer>
                <BarChart data={rows} stackOffset="sign" barCategoryGap="20%" margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke={BORDER} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={18} />
                  <YAxis tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} unit=" h" allowDecimals />
                  <Tooltip cursor={false} formatter={(v, k) => [fmtDuration(Number(v) * 3600), SOURCE_LABEL[k] || k]} contentStyle={{ borderRadius: 10, border: `1px solid ${BORDER}`, fontSize: 12 }} />
                  {SERIES.map((s) => <Bar key={s.key} dataKey={s.key} name={s.key} stackId="a" fill={s.color} maxBarSize={22} activeBar={false} isAnimationActive={false} />)}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
              {shown.map((s) => <span key={s.key} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: FS.footnote, color: MUTED }}><span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} />{SOURCE_LABEL[s.key]}</span>)}
            </div>
          </>
        ) : <EmptyState icon="chart" title="No runs in this range" hint="Runs show up here once the generator has run." />}
      </Card>

      <Card title="Recent runs" icon="clock">
        {(data.runs || []).length ? (
          <div className="ui-group">
            {data.runs.map((r) => (
              <div key={r.id} className="ui-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: FS.body, fontWeight: 600, color: TEXT }}>{fmtWhen(r.started_at, tz)}</div>
                  <div style={{ fontSize: FS.footnote, color: MUTED }}>
                    {SOURCE_LABEL[r.source] || r.source}
                    {r.soc_start != null ? ` · battery ${Math.round(r.soc_start)}%${r.soc_end != null ? ` to ${Math.round(r.soc_end)}%` : ""}` : ""}
                    {r.peak_w ? ` · peak ${fmtW(r.peak_w)}` : ""}
                  </div>
                </div>
                <span className="ui-pill" style={{ background: r.open ? "#F5F3FF" : "#F5F2EE", color: r.open ? "#6D28D9" : MUTED }}>{r.open ? "Running " : ""}{fmtDuration(r.duration_sec)}</span>
              </div>
            ))}
          </div>
        ) : <EmptyState icon="generator" title="No runs yet" hint="Each start and stop of the generator is listed here." />}
      </Card>
      <ErrorNote>{err}</ErrorNote>
    </>
  );
}
