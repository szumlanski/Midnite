// Generator > Schedules: one-off runs and weekly exercise runs.
import { useState } from "react";
import { Button, MoreMenu, Segmented, Switch } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { confirmAlert, toast } from "@/components/ui/Alert";
import { TEXT, MUTED, FS } from "@/components/ui/tokens";
import { fmtDuration, fmtDays, localParts, zonedTimeToUtc, inputToMin } from "@/lib/generator/core";
import { genApi, Card, Field, NumInput, DurationInput, DayChips, ErrorNote, EmptyState, fmtWhen, pctOrNull } from "./shared";

function schedTitle(s, tz) {
  if (s.label) return s.label;
  if (s.kind === "exercise") return `Exercise ${fmtDays(s.days_mask)} at ${clock12(s.time_local)}`;
  return `One-off run ${fmtWhen(s.starts_at, tz)}`;
}
const clock12 = (hhmm) => { const m = inputToMin(hhmm); if (m == null) return hhmm || "--"; const h = Math.floor(m / 60), mm = m % 60; return `${h % 12 || 12}:${String(mm).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
const pickSched = (s) => ({ kind: s.kind, label: s.label ?? null, duration_min: s.duration_min, target_pct: s.target_pct, starts_at: s.starts_at, days_mask: s.days_mask, time_local: s.time_local });

export function SchedulesView({ state, siteKey, onChanged }) {
  const tz = state.site?.timezone || "America/New_York";
  const list = [...(state.schedules || [])];
  const oneoffs = list.filter((s) => s.kind !== "exercise").sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
  const exercises = list.filter((s) => s.kind === "exercise");
  const [edit, setEdit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function run(fn, done) {
    if (busy) return;
    setBusy(true); setErr(null);
    try { await fn(); toast(done); await onChanged?.(false); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  const toggle = (s, on) => {
    // A past one-off can't be re-enabled (the server refuses a start time in the past).
    run(() => genApi("saveSchedule", { site_key: siteKey, ...pickSched(s), id: s.id, enabled: on }), on ? "Schedule on" : "Schedule off");
  };
  const remove = async (s) => {
    if (!await confirmAlert(`Delete "${schedTitle(s, tz)}"?`, { action: "Delete", destructive: true })) return;
    run(() => genApi("deleteSchedule", { site_key: siteKey, id: s.id }), "Schedule deleted");
  };

  const Row = ({ s }) => {
    const past = s.kind !== "exercise" && (s.fired || (s.starts_at && new Date(s.starts_at) < new Date()));
    return (
      <div className="ui-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: FS.body, fontWeight: 600, color: s.enabled === false || past ? MUTED : TEXT }}>{schedTitle(s, tz)}</div>
          <div style={{ fontSize: FS.footnote, color: MUTED }}>
            Runs {fmtDuration(s.duration_min * 60)}{s.target_pct != null ? ` or until ${s.target_pct}%` : ""}
            {past ? " · done" : s.next_run_at && s.enabled !== false ? ` · next ${fmtWhen(s.next_run_at, tz)}` : ""}
          </div>
        </div>
        {!past && <Switch checked={s.enabled !== false} onChange={(on) => toggle(s, on)} label="Schedule on" disabled={busy} />}
        <MoreMenu label="Schedule options" items={[
          ...(!past ? [{ label: "Edit…", icon: "edit", onClick: () => setEdit(s) }, { sep: true }] : []),
          { label: "Delete", icon: "trash", destructive: true, onClick: () => remove(s) },
        ]} />
      </div>
    );
  };

  return (
    <>
      <Card title="One-off runs" icon="calendar" right={<Button size="sm" icon="plus" disabled={busy} onClick={() => setEdit({ kind: "oneoff" })}>Add run</Button>}>
        {oneoffs.length ? <div className="ui-group">{oneoffs.map((s) => <Row key={s.id} s={s} />)}</div>
          : <EmptyState icon="calendar" title="No one-off runs" hint="Plan a single run, for example before a storm." />}
      </Card>
      <Card title="Weekly exercise" icon="refresh" right={<Button size="sm" icon="plus" disabled={busy} onClick={() => setEdit({ kind: "exercise" })}>Add exercise</Button>}>
        {exercises.length ? <div className="ui-group">{exercises.map((s) => <Row key={s.id} s={s} />)}</div>
          : <EmptyState icon="refresh" title="No exercise runs" hint="A short weekly run keeps the generator ready to start." />}
      </Card>
      <ErrorNote>{err}</ErrorNote>
      <div style={{ fontSize: FS.footnote, color: MUTED, margin: "4px 4px 0" }}>Times are in the site's time zone ({tz.replace(/_/g, " ")}).</div>
      {edit && <ScheduleSheet sched={edit} tz={tz} siteKey={siteKey} onClose={() => setEdit(null)} onSaved={async () => { setEdit(null); toast("Schedule saved"); await onChanged?.(false); }} />}
    </>
  );
}

function ScheduleSheet({ sched, tz, siteKey, onClose, onSaved }) {
  const isNew = !sched.id;
  const [kind, setKind] = useState(sched.kind || "oneoff");
  const lp0 = sched.starts_at ? localParts(sched.starts_at, tz) : localParts(Date.now() + 86400000, tz);
  const [date, setDate] = useState(lp0.ymd);
  const [time, setTime] = useState(sched.starts_at ? `${String(lp0.hour).padStart(2, "0")}:${String(lp0.minute).padStart(2, "0")}` : (sched.time_local || "09:00"));
  const [dur, setDur] = useState(Number(sched.duration_min ?? (kind === "exercise" ? 20 : 60)));
  const [target, setTarget] = useState(sched.target_pct != null ? String(sched.target_pct) : "");
  const [mask, setMask] = useState(Number(sched.days_mask ?? 64));
  const [label, setLabel] = useState(sched.label || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function save() {
    setErr(null);
    if (!Number.isInteger(dur) || dur < 1 || dur > 1440) { setErr("Run time must be between 1 minute and 24 hours."); return; }
    const tp = pctOrNull(target);
    if (tp != null && (!Number.isInteger(tp) || tp < 0 || tp > 100)) { setErr("Stop at % must be 0 to 100, or empty."); return; }
    const t = inputToMin(time);
    if (t == null) { setErr("Pick a time."); return; }
    const body = { site_key: siteKey, kind, label: label.trim() || null, duration_min: dur, target_pct: tp, ...(isNew ? {} : { id: sched.id }) };
    if (kind === "oneoff") {
      const [y, m, d] = String(date).split("-").map(Number);
      if (!y || !m || !d) { setErr("Pick a date."); return; }
      const at = zonedTimeToUtc(y, m, d, Math.floor(t / 60), t % 60, tz);
      if (at.getTime() < Date.now()) { setErr("That time has already passed."); return; }
      body.starts_at = at.toISOString();
    } else {
      if (!mask) { setErr("Pick at least one day."); return; }
      body.days_mask = mask; body.time_local = time;
    }
    setBusy(true);
    try { await genApi("saveSchedule", body); await onSaved(); }
    catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <Sheet title={isNew ? (kind === "exercise" ? "New exercise run" : "New one-off run") : "Edit schedule"} onClose={onClose} closeDisabled={busy}
      toolbar={isNew ? <Segmented size="sm" label="Kind" value={kind} onChange={setKind} options={[{ value: "oneoff", label: "One-off" }, { value: "exercise", label: "Weekly exercise" }]} /> : null}
      footer={<><Button onClick={onClose} disabled={busy}>Cancel</Button><Button variant="primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</Button></>}>
      <div style={{ display: "grid", gap: 14 }}>
        <Field label="Name (optional)" htmlFor="gs-label"><input id="gs-label" className="ui-field" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "exercise" ? "Saturday exercise" : "Before the storm"} style={{ width: "100%", boxSizing: "border-box", cursor: "text" }} /></Field>
        {kind === "oneoff" ? (
          <div className="gen-grid2">
            <Field label="Date" htmlFor="gs-date"><input id="gs-date" className="ui-field" type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} /></Field>
            <Field label="Time" htmlFor="gs-time"><input id="gs-time" className="ui-field" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} /></Field>
          </div>
        ) : (
          <>
            <Field label="Days"><DayChips mask={mask} onChange={setMask} /></Field>
            <Field label="Time" htmlFor="gs-time"><input id="gs-time" className="ui-field" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ width: "100%", boxSizing: "border-box" }} /></Field>
          </>
        )}
        <div className="gen-grid2">
          <Field label="Run for" htmlFor="gs-dur-h"><DurationInput idPrefix="gs-dur" minutes={dur} onChange={setDur} /></Field>
          <Field label="Stop at battery (optional)" htmlFor="gs-target"><NumInput id="gs-target" value={target} onChange={setTarget} min={0} max={100} suffix="%" placeholder="None" /></Field>
        </div>
        <ErrorNote>{err}</ErrorNote>
      </div>
    </Sheet>
  );
}
