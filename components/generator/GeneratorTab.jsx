// Generator tab: shown only on generator-enabled sites (see pages/index.jsx). One Segmented with the
// six sub-views. State comes from POST /api/generator?action=state; the Control view polls it with live
// inverter reads every 30 s (never while the browser tab is hidden), the others reload without live reads.
import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "@/components/ui/Button";
import { usePolling } from "@/lib/usePolling";
import { genApi, ErrorNote } from "./shared";
import { ControlView, observedGen } from "./ControlView";
import { AutomaticView } from "./AutomaticView";
import { SchedulesView } from "./SchedulesView";
import { HistoryView } from "./HistoryView";
import { ActivityView } from "./ActivityView";
import { AlertsView } from "./AlertsView";

const VIEWS = [
  { value: "control", label: "Control" },
  { value: "automatic", label: "Automatic" },
  { value: "schedules", label: "Schedules" },
  { value: "history", label: "History" },
  { value: "activity", label: "Activity" },
  { value: "alerts", label: "Alerts" },
];
const VIEW_KEY = "midnite_gen_view";

export function GeneratorTab({ siteKey, siteName, userKey, initial = null }) {
  const [view, setViewRaw] = useState(() => {
    try { const v = localStorage.getItem(VIEW_KEY); return VIEWS.some((x) => x.value === v) ? v : "control"; } catch { return "control"; }
  });
  const setView = (v) => { setViewRaw(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage blocked */ } };
  const [state, setState] = useState(initial);
  const [err, setErr] = useState(null);
  const [liveAt, setLiveAt] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastTime = useRef(null);

  const load = useCallback(async (live) => {
    try {
      const r = await genApi("state", { site_key: siteKey, live: !!live });
      setErr(null);
      setState((prev) => (live || !prev ? r : { ...r, live: prev.live, genLocation: prev.genLocation ?? r.genLocation, offGrid: prev.offGrid ?? r.offGrid }));
      // Stamp freshness only when the inverter's own sample time moves (not on every poll).
      const t = r?.live?.flow?.time;
      if (live && t && t !== lastTime.current) { lastTime.current = t; setLiveAt(Date.now()); }
    } catch (e) { setErr(e.message); }
  }, [siteKey]);

  useEffect(() => { setState(initial); lastTime.current = null; setLiveAt(null); }, [siteKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a Run now is waiting for the inverter (sent, not yet running), check every 5 s instead of 30 s.
  const waiting = !!state?.config?.force_on && !observedGen(state).running;
  usePolling(() => load(true), waiting ? 5000 : 30000, [siteKey, waiting], { enabled: view === "control" });
  useEffect(() => {
    if (view === "control") return;
    // Automatic: read the inverter once if the app hasn't copied its start/stop % yet, so the screen shows the
    // inverter's real values (e.g. 15/35), not the built-in 20/80 defaults.
    if (view === "automatic" && state?.config?.applied_start_pct == null) load(true);
    else if (!state) load(false);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const onChanged = async (live) => { setRefreshKey((k) => k + 1); await load(live); };
  const tz = state?.site?.timezone || "America/New_York";

  return (
    <div>
      <div className="seg-scroll" style={{ marginBottom: 14 }}>
        <Segmented label="Generator sections" value={view} onChange={setView} options={VIEWS} />
      </div>
      {!state ? (
        err ? <ErrorNote>{err}</ErrorNote> : (
          <div aria-busy="true" aria-label="Loading generator">
            <div className="ui-skel" style={{ height: 200, borderRadius: 16, marginBottom: 12 }} />
            <div className="ui-skel" style={{ height: 180, borderRadius: 16 }} />
          </div>
        )
      ) : (
        <>
          {err && <div style={{ marginBottom: 12 }}><ErrorNote>{err}</ErrorNote></div>}
          {view === "control" && <ControlView state={state} siteKey={siteKey} userKey={userKey} liveAt={liveAt} onChanged={onChanged} />}
          {view === "automatic" && <AutomaticView state={state} siteKey={siteKey} onChanged={onChanged} />}
          {view === "schedules" && <SchedulesView state={state} siteKey={siteKey} onChanged={onChanged} />}
          {view === "history" && <HistoryView siteKey={siteKey} tz={tz} refreshKey={refreshKey} />}
          {view === "activity" && <ActivityView siteKey={siteKey} tz={tz} siteName={siteName} refreshKey={refreshKey} />}
          {view === "alerts" && <AlertsView state={state} siteKey={siteKey} onChanged={onChanged} />}
        </>
      )}
    </div>
  );
}
