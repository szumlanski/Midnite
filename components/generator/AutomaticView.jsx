// Generator > Automatic: master switch, default start / charge-to / max run, and daily battery
// windows (24 h timeline, priority order, overlap warning, weekday chips).
import { useEffect, useState } from "react";
import { Button, IconButton, MoreMenu, Switch } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { confirmAlert, toast } from "@/components/ui/Alert";
import { TEXT, MUTED, FS } from "@/components/ui/tokens";
import { activeSetpoint, overlappingPairs, validateWindow, minToClock, minToInput, inputToMin, fmtDuration, fmtDays, localParts, windowCoversMinute, DAY_NAMES } from "@/lib/generator/core";
import { genApi, Card, Field, NumInput, DurationInput, DayChips, ErrorNote, InfoNote, EmptyState } from "./shared";

const WIN_COLORS = ["#7C3AED", "#A78BFA", "#C026D3", "#6366F1", "#9333EA", "#818CF8"];
const winName = (w) => w.label || `${minToClock(w.start_min)} to ${minToClock(w.end_min)}`;

export function AutomaticView({ state, siteKey, onChanged }) {
  const cfg = state.config || {};
  const tz = state.site?.timezone || "America/New_York";
  const windows = [...(state.windows || [])].sort((a, b) => (a.priority - b.priority) || String(a.created_at).localeCompare(String(b.created_at)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null); // window being edited, or {} for new

  const [startPct, setStartPct] = useState(String(cfg.default_start_pct ?? 20));
  const [stopPct, setStopPct] = useState(String(cfg.default_stop_pct ?? 80));
  const [maxRun, setMaxRun] = useState(Number(cfg.default_max_run_min ?? 240));
  useEffect(() => { setStartPct(String(cfg.default_start_pct ?? 20)); setStopPct(String(cfg.default_stop_pct ?? 80)); setMaxRun(Number(cfg.default_max_run_min ?? 240)); }, [cfg.default_start_pct, cfg.default_stop_pct, cfg.default_max_run_min]);
  const dirty = String(cfg.default_start_pct) !== startPct || String(cfg.default_stop_pct) !== stopPct || Number(cfg.default_max_run_min) !== maxRun;

  async function run(fn, done) {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await fn(); if (done) toast(done); await onChanged?.(false); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  // The switch IS the inverter's AGS: on = Auto, off = Off (no automatic starts at all). The write takes ~25 s.
  const setMaster = async (on) => {
    if (!on && !await confirmAlert("Turn off automatic generator starts?", {
      message: "The inverter's AGS goes to Off. The generator will not start on its own, even if the battery runs low. Run now and schedules still work.",
      action: "Turn off", destructive: true,
    })) return;
    run(() => genApi("setMaster", { site_key: siteKey, enabled: on }), on ? "Automatic control on (AGS Auto)" : "Automatic control off (AGS Off)");
  };
  const saveDefaults = () => run(() => genApi("saveConfig", { site_key: siteKey, default_start_pct: Number(startPct), default_stop_pct: Number(stopPct), default_max_run_min: maxRun }), "Defaults saved");
  const move = (i, d) => {
    const ids = windows.map((w) => w.id);
    const j = i + d; if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    run(() => genApi("reorderWindows", { site_key: siteKey, ids }), "Order saved");
  };
  const toggle = (w, on) => run(() => genApi("saveWindow", { site_key: siteKey, ...pickWin(w), id: w.id, enabled: on }), on ? "Window on" : "Window off");
  const remove = async (w) => {
    if (!await confirmAlert(`Delete "${winName(w)}"?`, { message: "The generator falls back to the defaults during these hours.", action: "Delete", destructive: true })) return;
    run(() => genApi("deleteWindow", { site_key: siteKey, id: w.id }), "Window deleted");
  };

  const overlaps = overlappingPairs(windows);
  const lp = localParts(new Date(), tz);
  const now = activeSetpoint(windows, lp.minuteOfDay, lp.dow, cfg);

  return (
    <>
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: FS.body, fontWeight: 700, color: TEXT }}>Automatic control</div>
            <div style={{ fontSize: FS.footnote, color: MUTED, marginTop: 2 }}>{busy ? "Sending to the inverter…" : cfg.force_on ? "A Run now is in progress. A change here takes effect when it ends." : "Sets the inverter\u2019s AGS to Auto (on) or Off (off). On Auto it starts and stops the generator from the battery level."}</div>
          </div>
          <Switch checked={!!cfg.enabled} onChange={setMaster} label="Automatic control" disabled={busy} />
        </div>
        <div style={{ marginTop: 12 }}>
          <InfoNote>The inverter enforces the active window's start and stop % itself, so it keeps working if the internet drops. A change made in the installer portal shows up here.</InfoNote>
        </div>
      </Card>

      <Card title="Defaults" icon="sliders">
        <div className="gen-grid3">
          <Field label="Start at" htmlFor="gen-def-start"><NumInput id="gen-def-start" value={startPct} onChange={setStartPct} min={0} max={100} suffix="%" /></Field>
          <Field label="Charge to" htmlFor="gen-def-stop"><NumInput id="gen-def-stop" value={stopPct} onChange={setStopPct} min={0} max={100} suffix="%" /></Field>
          <Field label="Max run (0 = none)" htmlFor="gen-def-max-h"><DurationInput idPrefix="gen-def-max" minutes={maxRun} onChange={setMaxRun} /></Field>
        </div>
        <div style={{ fontSize: FS.footnote, color: MUTED, marginTop: 10 }}>Used whenever no window below covers the time.</div>
        {dirty && <div style={{ marginTop: 12 }}><Button variant="primary" disabled={busy} onClick={saveDefaults}>Save defaults</Button></div>}
      </Card>

      <Card title="Time windows" icon="clock" right={<Button size="sm" icon="plus" disabled={busy} onClick={() => setEdit({})}>Add window</Button>}>
        <Timeline windows={windows} dow={lp.dow} minute={lp.minuteOfDay} />
        <div style={{ fontSize: FS.footnote, color: MUTED, margin: "8px 0 12px" }}>
          Today ({DAY_NAMES[lp.dow]}). Now: start at <strong style={{ color: TEXT }}>{now.start_pct}%</strong>, charge to <strong style={{ color: TEXT }}>{now.stop_pct}%</strong> ({now.source === "window" ? winName(now.window) : "defaults"}).
        </div>
        {overlaps.length > 0 && (
          <div role="note" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 12, padding: "10px 12px", fontSize: FS.subhead, color: "#92400E", marginBottom: 12 }}>
            {overlaps.map((p, i) => (
              <div key={i}>"{winName(p.a)}" and "{winName(p.b)}" overlap. "{winName(p.winner)}" wins because it is higher in the list.</div>
            ))}
          </div>
        )}
        {windows.length === 0 ? (
          <EmptyState icon="clock" title="No time windows" hint="Add a window to use different battery levels at night or on certain days." />
        ) : (
          <>
            <div className="ui-section-label">Highest priority first</div>
            <div className="ui-group">
              {windows.map((w, i) => (
                <div key={w.id} className="ui-row">
                  <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: WIN_COLORS[i % WIN_COLORS.length], flexShrink: 0, opacity: w.enabled === false ? 0.35 : 1 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: FS.body, fontWeight: 600, color: w.enabled === false ? MUTED : TEXT }}>{winName(w)}</div>
                    <div style={{ fontSize: FS.footnote, color: MUTED }}>
                      {w.label ? `${minToClock(w.start_min)} to ${minToClock(w.end_min)} · ` : ""}{fmtDays(w.days_mask)} · {w.start_pct}% to {w.stop_pct}%{w.max_run_min ? ` · max ${fmtDuration(w.max_run_min * 60)}` : ""}
                    </div>
                  </div>
                  <div className="hide-phone" style={{ display: "flex", gap: 2 }}>
                    <IconButton icon="back" label="Move up" disabled={busy || i === 0} onClick={() => move(i, -1)} style={{ transform: "rotate(90deg)" }} />
                    <IconButton icon="back" label="Move down" disabled={busy || i === windows.length - 1} onClick={() => move(i, 1)} style={{ transform: "rotate(-90deg)" }} />
                  </div>
                  <Switch checked={w.enabled !== false} onChange={(on) => toggle(w, on)} label={`${winName(w)} on`} disabled={busy} />
                  <MoreMenu label={`Options for ${winName(w)}`} items={[
                    { label: "Edit…", icon: "edit", onClick: () => setEdit(w) },
                    ...(i > 0 ? [{ label: "Move up", icon: "back", onClick: () => move(i, -1) }] : []),
                    ...(i < windows.length - 1 ? [{ label: "Move down", icon: "chevron", onClick: () => move(i, 1) }] : []),
                    { sep: true },
                    { label: "Delete", icon: "trash", destructive: true, onClick: () => remove(w) },
                  ]} />
                </div>
              ))}
            </div>
          </>
        )}
        <ErrorNote>{err}</ErrorNote>
      </Card>

      {edit && <WindowSheet win={edit} siteKey={siteKey} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); toast("Window saved"); await onChanged?.(false); }} />}
    </>
  );
}

const pickWin = (w) => ({ label: w.label ?? null, start_min: w.start_min, end_min: w.end_min, start_pct: w.start_pct, stop_pct: w.stop_pct, max_run_min: w.max_run_min ?? 0, days_mask: w.days_mask ?? 127, enabled: w.enabled !== false });

// 24 h strip for one weekday: each enabled window drawn where it is in force (lower priority under).
function Timeline({ windows, dow, minute }) {
  const segs = [];
  const enabled = windows.filter((w) => w.enabled !== false);
  // Draw lowest priority first so the winner sits on top.
  [...enabled].reverse().forEach((w) => {
    const idx = windows.indexOf(w);
    let start = null;
    for (let m = 0; m <= 1440; m++) {
      const on = m < 1440 && windowCoversMinute(w, m, dow);
      if (on && start == null) start = m;
      if (!on && start != null) { segs.push({ id: `${w.id}-${start}`, left: start, width: m - start, color: WIN_COLORS[idx % WIN_COLORS.length], title: winName(w) }); start = null; }
    }
  });
  return (
    <div>
      <div className="gen-timeline" role="img" aria-label="Time windows for today">
        {segs.map((s) => <span key={s.id} className="gen-timeline-seg" title={s.title} style={{ left: `${(s.left / 1440) * 100}%`, width: `${(s.width / 1440) * 100}%`, background: s.color }} />)}
        <span className="gen-timeline-now" style={{ left: `${(minute / 1440) * 100}%` }} aria-hidden="true" />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: FS.caption, color: MUTED, marginTop: 4 }}>
        <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span>
      </div>
    </div>
  );
}

function WindowSheet({ win, siteKey, onClose, onSaved }) {
  const isNew = !win.id;
  const [label, setLabel] = useState(win.label || "");
  const [start, setStart] = useState(minToInput(win.start_min ?? 1320));
  const [end, setEnd] = useState(minToInput(win.end_min ?? 360));
  const [sPct, setSPct] = useState(String(win.start_pct ?? 30));
  const [ePct, setEPct] = useState(String(win.stop_pct ?? 70));
  const [maxRun, setMaxRun] = useState(Number(win.max_run_min ?? 0));
  const [mask, setMask] = useState(Number(win.days_mask ?? 127));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    const w = { label: label.trim() || null, start_min: inputToMin(start), end_min: inputToMin(end), start_pct: Number(sPct), stop_pct: Number(ePct), max_run_min: maxRun, days_mask: mask, enabled: win.enabled !== false };
    if (w.start_min == null || w.end_min == null) { setErr("Pick a start and end time."); return; }
    const bad = validateWindow(w);
    if (bad) { setErr(bad.charAt(0).toUpperCase() + bad.slice(1) + "."); return; }
    setBusy(true); setErr(null);
    try { await genApi("saveWindow", { site_key: siteKey, ...w, ...(isNew ? {} : { id: win.id }) }); await onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Sheet title={isNew ? "New time window" : "Edit time window"} onClose={onClose} closeDisabled={busy}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button></>}>
      <div style={{ display: "grid", gap: 14 }}>
        <Field label="Name (optional)" htmlFor="gw-label"><input id="gw-label" className="ui-field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Night" style={{ width: "100%", boxSizing: "border-box", cursor: "text" }} /></Field>
        <div className="gen-grid2">
          <Field label="From" htmlFor="gw-start"><input id="gw-start" className="ui-field" type="time" value={start} onChange={(e) => setStart(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} /></Field>
          <Field label="To" htmlFor="gw-end" hint={start === end ? "Same time = all day" : inputToMin(end) < inputToMin(start) ? "Ends the next morning" : null}><input id="gw-end" className="ui-field" type="time" value={end} onChange={(e) => setEnd(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} /></Field>
        </div>
        <div className="gen-grid2">
          <Field label="Start at" htmlFor="gw-spct"><NumInput id="gw-spct" value={sPct} onChange={setSPct} min={0} max={100} suffix="%" /></Field>
          <Field label="Charge to" htmlFor="gw-epct"><NumInput id="gw-epct" value={ePct} onChange={setEPct} min={0} max={100} suffix="%" /></Field>
        </div>
        <Field label="Max run (0 = none)" htmlFor="gw-max-h"><DurationInput idPrefix="gw-max" minutes={maxRun} onChange={setMaxRun} /></Field>
        <Field label="Days"><DayChips mask={mask} onChange={setMask} /></Field>
        <ErrorNote>{err}</ErrorNote>
        <div style={{ fontSize: FS.footnote, color: MUTED }}>New windows go to the bottom of the list. Move them up to give them priority.</div>
      </div>
    </Sheet>
  );
}
