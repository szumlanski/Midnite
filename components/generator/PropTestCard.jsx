// Admin > Propagation test: does a setting written to ONE parallel inverter reach the others? Writes only the inert
// exercise run date (2153), one inverter at a time, ~2 min per trial, for 8 hours (cron pages/api/generator/proptest.js).
import { useEffect, useState } from "react";
import { Button, Segmented } from "@/components/ui/Button";
import { confirmAlert, toast } from "@/components/ui/Alert";
import { TEXT, MUTED, FS } from "@/components/ui/tokens";
import { genApi, Card, ErrorNote, InfoNote, fmtWhen } from "./shared";

export function PropTestCard({ site, siteKey }) {
  const [d, setD] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [view, setView] = useState("all");
  const label = (sn) => { const i = site.inverters.find(x => x.sn === sn); return `${i?.label || "?"} …${String(sn).slice(-6)}`; };

  async function load() { try { setD(await genApi("propTest", { site_key: siteKey, op: "status" })); setErr(null); } catch (e) { setErr(e.message); setD(null); } }
  useEffect(() => { load(); const id = setInterval(load, 60000); return () => clearInterval(id); }, [siteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    if (!await confirmAlert("Start an 8-hour propagation test?", { message: "Writes only the exercise run date (2153) to one inverter at a time and checks the others. The exercise cycle is off, so it has no effect. The original value is put back at the end.", action: "Start" })) return;
    setBusy(true); try { await genApi("propTest", { site_key: siteKey, op: "start", hours: 8 }); toast("Test started; the first trial runs within a minute"); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function stop() {
    if (!await confirmAlert("Stop the test?", { message: "It stops after the current trial and puts the original value back on every inverter.", action: "Stop", destructive: true })) return;
    setBusy(true); try { await genApi("propTest", { site_key: siteKey, op: "stop" }); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const run = d?.run, active = run && ["running", "restoring"].includes(run.status);
  const sum = d?.[view];
  const done = (d?.all?.sources || []).reduce((a, r) => a + r.n, 0);
  const inProgress = !!run?.open_trial;
  return (
    <Card title="Settings propagation test" icon="refresh">
      {d === undefined ? <div className="ui-skel" style={{ height: 60, borderRadius: 12 }} /> : (
        <>
          <div style={{ fontSize: FS.footnote, color: MUTED, marginBottom: 10 }}>
            Writes the exercise run date (2153, inert while the exercise cycle is off) to one inverter at a time and checks whether the others pick it up within about 2 minutes.
          </div>
          {run ? (
            <div style={{ fontSize: FS.footnote, color: TEXT, display: "grid", gap: 2, marginBottom: 10 }}>
              <div><strong>{{ running: "Running", restoring: "Finishing: putting the original value back", done: "Done" }[run.status] || run.status}</strong>, {done} trials finished{inProgress ? ", 1 in progress" : ""}{run.skipped_for_real_write ? `, ${run.skipped_for_real_write} minutes skipped for real generator writes` : ""}</div>
              <div style={{ color: MUTED }}>Started {fmtWhen(run.started_at)} by {run.started_by || "an admin"}; {run.status === "done" ? `finished ${fmtWhen(run.finished_at)}` : `ends ${fmtWhen(run.ends_at)}`}</div>
              {run.firmware && <div style={{ color: MUTED }}>Firmware: {Object.entries(run.firmware).map(([sn, f]) => `${label(sn)} DSP ${f?.dspVer || "?"} / slave ${f?.slaveDspVer || "?"} / CSB ${f?.csbVer || "?"}`).join("; ")}</div>}
              {run.restore_failed && <div style={{ color: "#B91C1C" }}>Could not put the original value back on: {run.restore_failed.map(label).join(", ")}</div>}
            </div>
          ) : <div style={{ fontSize: FS.footnote, color: MUTED, marginBottom: 10 }}>No test run yet.</div>}
          <div className="gen-actions">
            {!active && <Button variant="primary" disabled={busy} onClick={start}>Start 8-hour test</Button>}
            {active && run.status === "running" && <Button variant="destructive" disabled={busy} onClick={stop}>Stop test</Button>}
            <Button disabled={busy} onClick={load}>Refresh</Button>
          </div>
          {sum && d.trials > 0 && (
            <div style={{ marginTop: 14 }}>
              <Segmented size="sm" label="Trials" value={view} onChange={setView} options={[{ value: "all", label: "All" }, { value: "idle", label: "Generator off" }, { value: "running", label: "Generator running" }]} />
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table style={{ borderCollapse: "collapse", fontSize: FS.footnote, minWidth: 420 }}>
                  <thead><tr><th style={th}>Written to</th><th style={th}>Trials</th><th style={th}>Write accepted</th>{(run?.sns || []).map(t => <th key={t} style={th}>Reached {label(t)}</th>)}</tr></thead>
                  <tbody>{sum.sources.map(r => (
                    <tr key={r.source}>
                      <td style={td}><strong>{label(r.source)}</strong></td><td style={td}>{r.n}</td><td style={td}>{r.acceptedPct == null ? "--" : `${r.acceptedPct}%`}</td>
                      {r.targets.map(c => <td key={c.target} style={{ ...td, color: c.pct != null && c.pct < 95 ? "#B91C1C" : TEXT }}>{r.n ? <>{c.pct}%{c.medianSec != null ? <span style={{ color: MUTED }}> · {c.medianSec}s</span> : null}{c.late ? <div style={{ color: MUTED }}>late {c.late}</div> : null}{c.never ? <div style={{ color: MUTED }}>never {c.never}</div> : null}</> : "--"}</td>)}
                    </tr>))}</tbody>
                </table>
              </div>
              <div style={{ fontSize: FS.caption, color: MUTED, marginTop: 6 }}>
                Each cell: share of trials where the value reached that inverter within ~2 min, with median seconds. The diagonal is the inverter written to. "Late" = arrived after 2 min; "never" = not seen by the next trial. Read check: {sum.readNoise.disagreements} of {sum.readNoise.trials} back-to-back reads disagreed.
              </div>
            </div>
          )}
          <ErrorNote>{err}</ErrorNote>
        </>
      )}
    </Card>
  );
}
const th = { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid var(--border)", fontWeight: 700, whiteSpace: "nowrap" };
const td = { padding: "6px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "top", whiteSpace: "nowrap" };
