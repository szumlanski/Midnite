// Admin > Generator control for the current site: enable toggle + master inverter picker
// (siteToggle). The site can't be enabled until a master is set. Shows the stored master and who
// last turned the feature on or off (from the site's activity log).
import { useEffect, useState } from "react";
import { Button, Switch } from "@/components/ui/Button";
import { toast, confirmAlert } from "@/components/ui/Alert";
import { TEXT, MUTED, FS, GEN_TEXT } from "@/components/ui/tokens";
import { siteKeyOf } from "@/lib/generator/core";
import { genApi, Card, ErrorNote, InfoNote, fmtWhen } from "./shared";

export const PILOT_MASTER = "2452-40920023PH";

export function GeneratorAdminCard({ site, onChanged }) {
  const siteKey = siteKeyOf(site.inverters.map((i) => i.sn));
  const [gen, setGen] = useState(undefined); // undefined = loading, null = not set up
  const [who, setWho] = useState(null);
  const [pick, setPick] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  async function load() {
    setErr(null);
    try {
      const r = await genApi("state", { site_key: siteKey, live: false });
      setGen(r.site || null);
      setPick(r.site?.master_sn || null);
      try {
        const ev = await genApi("events", { site_key: siteKey, limit: 100 });
        setWho((ev.events || []).find((e) => e.action === "site_enable" || e.action === "site_disable") || null);
      } catch { setWho(null); }
    } catch (e) {
      if (e.status === 404 || e.status === 403) { setGen(null); setWho(null); }
      else { setErr(e.message); setGen(null); }
    }
  }
  useEffect(() => {
    setGen(undefined); setWho(null);
    setPick(site.inverters.some((i) => i.sn === PILOT_MASTER) ? PILOT_MASTER : null);
    load();
  }, [siteKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(enabled, master_sn) {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await genApi("siteToggle", { site_key: siteKey, site_name: site.name, enabled, master_sn: master_sn || null });
      toast(enabled ? "Generator control on for this site" : "Generator control off for this site");
      await load();
      onChanged?.();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function toggle(on) {
    if (on && !pick) { setErr("Pick the master inverter first."); return; }
    if (on && !await confirmAlert(`Turn on generator control for ${site.name}?`, { message: "Everyone who can open this site, including people it is shared with, will be able to start and stop the generator.", action: "Turn on", destructive: false })) return;
    save(on, on ? pick : (gen?.master_sn || null));
  }

  const enabled = !!gen?.enabled;
  const masterChanged = pick && pick !== gen?.master_sn;
  const invLabel = (sn) => site.inverters.find((i) => i.sn === sn)?.label || sn;

  return (
    <Card title="Generator control" icon="generator" right={gen !== undefined && <Switch checked={enabled} onChange={toggle} label="Generator control" disabled={busy} />}>
      {gen === undefined ? <div className="ui-skel" aria-busy="true" aria-label="Loading generator setup" style={{ height: 90, borderRadius: 12 }} /> : (
        <>
          <div style={{ fontSize: FS.footnote, color: MUTED, marginBottom: 10 }}>
            {enabled ? "On. The Generator tab shows for everyone who can open this site." : "Off. The Generator tab is hidden on this site."}
          </div>
          <div className="ui-section-label">Master inverter (all generator writes go here)</div>
          <div className="inv-scroll" style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
            {site.inverters.map((inv) => {
              const on = pick === inv.sn;
              return (
                <button key={inv.sn} type="button" className="ui-chip" aria-pressed={on} disabled={busy} onClick={() => setPick(inv.sn)}
                  style={{ flexDirection: "column", alignItems: "flex-start", gap: 0, padding: "6px 12px", borderRadius: 12, ...(on ? { background: "#F5F3FF", borderColor: "#C4B5FD", color: GEN_TEXT } : {}) }}>
                  <span style={{ fontWeight: 700 }}>{inv.label}</span>
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: FS.caption }}>{inv.sn}</span>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: FS.footnote, color: TEXT, marginTop: 10, display: "grid", gap: 4 }}>
            <div>Stored master: {gen?.master_sn ? <strong>{invLabel(gen.master_sn)} · {gen.master_sn}</strong> : <span style={{ color: MUTED }}>none</span>}{gen?.master_source ? <span style={{ color: MUTED }}> (set by {gen.master_source === "admin" ? "an admin" : "detection"}{gen.master_checked_at ? `, ${fmtWhen(gen.master_checked_at)}` : ""})</span> : null}</div>
            {who && <div style={{ color: MUTED }}>{who.action === "site_enable" ? "Turned on" : "Turned off"} by {who.actor_name || who.actor_email || "an admin"}, {fmtWhen(who.ts)}</div>}
          </div>
          {masterChanged && (
            <div style={{ marginTop: 12 }}>
              <Button variant="primary" disabled={busy} onClick={() => save(enabled, pick)}>{busy ? "Saving…" : `Set ${invLabel(pick)} as master`}</Button>
            </div>
          )}
          {!site.inverters.some((i) => i.autoId) && <div style={{ marginTop: 10 }}><InfoNote icon="alert">This account doesn't report inverter AutoIds, so the server may not be able to resolve the master. Use the installer account.</InfoNote></div>}
          <ErrorNote>{err}</ErrorNote>
        </>
      )}
    </Card>
  );
}
