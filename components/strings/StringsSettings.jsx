// Settings → Strings: name each MPPT and (optionally) set its DC size, per inverter serial.
// Anyone with access to the site can edit, share recipients included (Jason's decision).
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { toast } from "@/components/ui/Alert";
import { TEXT, MUTED, BORDER, FS, BATTERY_TEXT, GRID_IN_TEXT, SANS, stringColor } from "@/components/ui/tokens";
import { useStringLabels, stringsApi, mpptKey } from "./labels";

const mono = { fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" };

function StringRow({ siteKey, sn, n, invIndex, current, active, live, onSaved }) {
  const [label, setLabel] = useState(current?.label || "");
  const [kw, setKw] = useState(current?.kw_dc != null ? String(current.kw_dc) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const dirty = (label.trim() || "") !== (current?.label || "") || (kw.trim() === "" ? null : Number(kw)) !== (current?.kw_dc ?? null);
  const tooLong = label.trim().length > 40;
  const kwBad = kw.trim() !== "" && !(Number(kw) > 0 && Number(kw) <= 100);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await stringsApi("save", { site_key: siteKey, sn, mppt: n, label: label.trim(), kw_dc: kw.trim() === "" ? null : Number(kw) });
      onSaved(r.labels);
      toast(label.trim() ? `Saved "${label.trim()}"` : `MPPT ${n} reset to its default name`);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const idBase = `str-${sn}-${n}`;
  return (
    <div className="ui-row" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <label htmlFor={`${idBase}-name`} style={{ fontSize: FS.footnote, color: MUTED, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: stringColor(n, invIndex), flexShrink: 0 }} />
          MPPT {n}
          {live
            ? <span style={{ color: (live.w || 0) > 0 ? BATTERY_TEXT : MUTED, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                · {Math.round(live.v || 0)} V · {(live.a || 0).toFixed(2)} A · {Math.round(live.w || 0)} W
              </span>
            : active && <span style={{ color: BATTERY_TEXT, fontWeight: 600 }}>· producing</span>}
        </label>
        <input id={`${idBase}-name`} className="ui-field" value={label} maxLength={60} placeholder={`MPPT ${n}`} onChange={(e) => setLabel(e.target.value)}
          aria-invalid={tooLong || undefined} style={{ width: "100%", boxSizing: "border-box", fontFamily: SANS }} />
      </div>
      <div style={{ flex: "0 0 110px" }}>
        <label htmlFor={`${idBase}-kw`} style={{ fontSize: FS.footnote, color: MUTED, fontWeight: 600, display: "block", marginBottom: 4 }}>Size (optional)</label>
        <div style={{ position: "relative" }}>
          <input id={`${idBase}-kw`} className="ui-field" type="number" inputMode="decimal" min={0} max={100} step={0.01} value={kw}
            onChange={(e) => setKw(e.target.value)} aria-invalid={kwBad || undefined} style={{ width: "100%", boxSizing: "border-box", paddingRight: 48, fontFamily: SANS }} />
          <span aria-hidden="true" style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", fontSize: FS.footnote, color: MUTED, pointerEvents: "none" }}>kW DC</span>
        </div>
      </div>
      {(dirty || busy) && <Button variant="primary" onClick={save} disabled={busy || tooLong || kwBad}>{busy ? "Saving…" : "Save"}</Button>}
      {(err || tooLong || kwBad) && <div role="alert" style={{ flexBasis: "100%", fontSize: FS.footnote, color: GRID_IN_TEXT }}>
        {err || (tooLong ? "Names can be at most 40 characters." : "Size must be more than 0 and at most 100 kW DC.")}
      </div>}
    </div>
  );
}

// statuses = the Dashboard's live 5-min inverter status (same data as the Live cards), for the per-MPPT V/A/W readout.
export function StringsSettings({ site, siteKey, statuses = [] }) {
  const { byKey, inverters, loaded, error, setLabels } = useStringLabels();
  if (!site) return <div style={{ fontSize: FS.subhead, color: MUTED }}>Open a site first, then come back here to name its strings.</div>;
  const activeOf = (sn) => new Set(inverters.find((i) => i.sn === sn)?.active || []);
  const liveOf = (sn, n) => {
    const m = statuses.find((x) => x.sn === sn)?.data?.photovoltaic?.mppts?.[n - 1];
    return m ? { v: Number(m.voltage) || 0, a: Number(m.current) || 0, w: Number(m.power) || 0 } : null;
  };
  return (
    <>
      <div style={{ fontSize: FS.subhead, color: MUTED, marginBottom: 12 }}>
        Name each solar string (MPPT input) at <b style={{ color: TEXT }}>{site.name}</b>, like &ldquo;South roof&rdquo;. Names show on the Live cards,
        the Day chart, Explorer and the Strings view. Add a DC size to compare strings fairly (kWh per kW). Edit a row, then tap Save.
      </div>
      {error && <div role="alert" style={{ fontSize: FS.subhead, color: GRID_IN_TEXT, marginBottom: 12, display: "flex", gap: 6, alignItems: "center" }}><Icon name="alert" />{error.message}</div>}
      {!loaded && <div className="ui-skel" style={{ height: 180, borderRadius: 12 }} aria-label="Loading strings" />}
      {loaded && site.inverters.map((inv, i) => (
        <div key={inv.sn} style={{ marginBottom: 16 }}>
          <div className="ui-section-label" style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ ...mono, color: TEXT, fontWeight: 700 }}>{inv.sn}</span>
            <span style={{ fontWeight: 500 }}>{inv.label}</span>
          </div>
          <div className="ui-group" style={{ borderColor: BORDER }}>
            {[1, 2, 3].map((n) => (
              <StringRow key={`${n}|${byKey[mpptKey(inv.sn, n)]?.label || ""}|${byKey[mpptKey(inv.sn, n)]?.kw_dc ?? ""}`} siteKey={siteKey} sn={inv.sn} n={n} invIndex={i} current={byKey[mpptKey(inv.sn, n)]} active={activeOf(inv.sn).has(n)} live={liveOf(inv.sn, n)} onSaved={setLabels} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
