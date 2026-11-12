// Generator > Activity: the site-wide gen_events log. Who, role, what (plain words), when; tap a row
// for before -> after. Paged with "Show more"; CSV export of what is loaded.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Icon } from "@/components/ui/Icon";
import { TEXT, MUTED, FS, GRID_IN_TEXT, GEN_TEXT, SOLAR_TEXT } from "@/components/ui/tokens";
import { genApi, Card, ErrorNote, EmptyState, fmtWhen, downloadCsv, ROLE_LABEL } from "./shared";

const ACTION_WORDS = {
  control_start: "Started the generator",
  control_end: "Stopped the generator (ended the run)",
  control_stop: "Turned the generator off",
  control_auto: "Returned the generator to automatic",
  save_config: "Changed the automatic defaults",
  master_on: "Turned automatic control on",
  master_off: "Turned automatic control off",
  set_alerts: "Changed their generator alerts",
  save_window: "Saved a time window",
  delete_window: "Deleted a time window",
  reorder_windows: "Reordered the time windows",
  save_schedule: "Saved a schedule",
  delete_schedule: "Deleted a schedule",
  site_enable: "Turned on generator control for this site",
  site_disable: "Turned off generator control for this site",
  site_toggle: "Changed generator control for this site",
  seed_from_inverter: "Copied the inverter's generator settings into the app",
  external_ags_change: "AGS was changed outside the app (portal or inverter)",
  external_setting_change: "A generator setting was changed outside the app; copied to every inverter",
  resync_write: "Re-sent a setting an inverter had not taken",
  end_check_ok: "After the run: every inverter checked and correct",
  start_confirmed: "Checked: the generator is on (voltage)",
  charge_confirmed: "Checked: the inverters are charging from the generator",
  start_not_confirmed: "The generator had not started 10 minutes after the start",
  charge_not_confirmed: "The generator is on but the inverters are not charging from it",
  charge_stop_confirmed: "After the run: charging stopped, generator cooling down",
  stop_confirmed: "After the run: the generator is off (no voltage, no power)",
  watchdog_stop_sent: "After the run the generator did not stop; AGS Off forced on every inverter",
  end_confirmed: "After the run: normal settings confirmed on every inverter (3 checks)",
  generator_started: "Generator started (seen running)",
  generator_stopped: "Generator stopped (seen stopped)",
  alert_started_sent: "Sent the generator-started alert",
  alert_stopped_sent: "Sent the generator-stopped alert",
  cron_force_end: "Ended the Run now (time up or target reached)",
  cron_schedule_start: "Started a scheduled run",
  cron_schedule_skipped: "Skipped a scheduled run",
  cron_thresholds: "Wrote the active window's start/stop % to the inverter",
  admin_register_write: "Wrote generator settings directly (admin tool)",
};
export const actionWords = (a) => ACTION_WORDS[a] || String(a || "").replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

function detailOf(ev) {
  const a = ev.after || {};
  if (ev.action === "control_start" && a.force_max_run_min) return `for up to ${a.force_max_run_min} min${a.force_target_pct != null ? `, stop at ${a.force_target_pct}%` : ""}`;
  if (ev.action === "save_window" && a.start_pct != null) return `${a.label ? `"${a.label}" ` : ""}${a.start_pct}% to ${a.stop_pct}%`;
  return null;
}
const ROLE_TONE = { owner: ["#ECFDF5", "#047857"], shared: ["#FFFBEB", SOLAR_TEXT], admin: ["#F5F3FF", GEN_TEXT], system: ["#F1F5F9", MUTED] };

export function ActivityView({ siteKey, tz, siteName, refreshKey }) {
  const [events, setEvents] = useState(null);
  const [next, setNext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    genApi("events", { site_key: siteKey, limit: 50 })
      .then((r) => { if (alive) { setEvents(r.events || []); setNext(r.next || null); } })
      .catch((e) => { if (alive) { setErr(e.message); setEvents((x) => x || []); } });
    return () => { alive = false; };
  }, [siteKey, refreshKey]);

  async function more() {
    if (!next || busy) return;
    setBusy(true);
    try { const r = await genApi("events", { site_key: siteKey, limit: 50, before: next }); setEvents((e) => [...(e || []), ...(r.events || [])]); setNext(r.next || null); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  function exportCsv() {
    const rows = [["time", "who", "email", "role", "on behalf of", "ip", "device", "action", "success", "error", "before", "after"],
      ...(events || []).map((e) => [e.ts, e.actor_name || "", e.actor_email || "", roleOf(e),
        e.after?.on_behalf_of ? (e.after.on_behalf_of.email || e.after.on_behalf_of.name || e.after.on_behalf_of.id) : "",
        e.after?.client?.ip || "", e.after?.client?.device || "", e.action, e.success === false ? "no" : "yes", e.error || "", e.before, e.after])];
    downloadCsv(`generator-activity-${String(siteName || "site").replace(/[^A-Za-z0-9_-]+/g, "_")}.csv`, rows);
  }

  if (!events) return <div aria-busy="true" aria-label="Loading activity"><div className="ui-skel" style={{ height: 320, borderRadius: 16 }} /></div>;

  return (
    <Card title="Activity" icon="activity" right={events.length ? <Button size="sm" icon="download" onClick={exportCsv}>Export CSV</Button> : null}>
      <div style={{ fontSize: FS.footnote, color: MUTED, marginBottom: 12 }}>Everything anyone did with this site's generator. Everyone who can open the site sees the same list.</div>
      {events.length === 0 ? <EmptyState icon="activity" title="No activity yet" hint="Starts, stops and setting changes show up here." /> : (
        <div className="ui-group">
          {events.map((e) => {
            const role = roleOf(e);
            const [bg, fg] = ROLE_TONE[role] || ROLE_TONE.system;
            const d = detailOf(e);
            return (
              <button key={e.id} type="button" className="ui-row ui-rowlink" onClick={() => setOpen(e)} style={{ width: "100%", textAlign: "left", background: "transparent", border: 0, borderTop: "1px solid var(--border)", font: "inherit", cursor: "pointer" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: FS.body, fontWeight: 600, color: e.success === false ? GRID_IN_TEXT : TEXT, display: "flex", gap: 6, alignItems: "center" }}>
                    {e.success === false && <Icon name="alert" />}{actionWords(e.action)}{e.success === false ? " (failed)" : ""}
                  </div>
                  <div style={{ fontSize: FS.footnote, color: MUTED, overflowWrap: "anywhere" }}>
                    {e.actor_name || e.actor_email || (e.source === "cron" ? "Automatic" : "Someone")}{e.after?.on_behalf_of ? ` for ${e.after.on_behalf_of.name || e.after.on_behalf_of.email || "a user"}` : ""} · {fmtWhen(e.ts, tz)}{d ? ` · ${d}` : ""}
                  </div>
                </div>
                <span className="ui-pill" style={{ background: bg, color: fg }}>{ROLE_LABEL[role] || role}</span>
                <Icon name="chevron" />
              </button>
            );
          })}
        </div>
      )}
      {next && <div style={{ marginTop: 12, textAlign: "center" }}><Button disabled={busy} onClick={more}>{busy ? "Loading more…" : "Show more"}</Button></div>}
      <ErrorNote>{err}</ErrorNote>
      {open && (
        <Sheet title={actionWords(open.action)} subtitle={`${open.actor_name || open.actor_email || "System"}${open.after?.on_behalf_of ? ` for ${open.after.on_behalf_of.name || open.after.on_behalf_of.email || "a user"}` : ""}${open.actor_email && open.actor_name !== open.actor_email ? ` (${open.actor_email})` : ""} · ${fmtWhen(open.ts, tz)}`} onClose={() => setOpen(null)} maxWidth={640}>
          {open.error && <ErrorNote>{open.error}</ErrorNote>}
          <div className="gen-grid2" style={{ marginTop: 10 }}>
            <JsonBox title="Before" value={open.before} />
            <JsonBox title="After" value={open.after} />
          </div>
        </Sheet>
      )}
    </Card>
  );
}
const roleOf = (e) => e.actor_role || (e.source === "cron" ? "system" : "system");

function JsonBox({ title, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div className="ui-section-label" style={{ marginTop: 0 }}>{title}</div>
      <pre style={{ margin: 0, background: "#FBF9F6", border: "1px solid var(--border)", borderRadius: 10, padding: 10, fontSize: 12, color: TEXT, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflow: "auto" }}>
        {value == null ? "Nothing" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
