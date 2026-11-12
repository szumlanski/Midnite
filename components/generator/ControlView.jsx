// Generator > Control: the simple view most people use. Status, Run now (with a one-time liability
// disclaimer and a confirm), a live countdown, a big Stop and Return to automatic.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { Icon } from "@/components/ui/Icon";
import { confirmAlert, toast } from "@/components/ui/Alert";
import { TEXT, MUTED, FS, GEN, GEN_TEXT, BATTERY_TEXT } from "@/components/ui/tokens";
import { fmtDuration, minToClock } from "@/lib/generator/core";
import { genApi, Card, Field, NumInput, DurationInput, ErrorNote, InfoNote, PendingNote, FreshChip, fmtW, fmtClockAt, pctOrNull, AGS_LABEL } from "./shared";

const DISCLAIMER_KEY = "midnite_gen_disclaimer_v1";
function disclaimerAccepted(user) {
  try { return localStorage.getItem(`${DISCLAIMER_KEY}:${user || "me"}`) === "1"; } catch { return false; }
}
function rememberDisclaimer(user) {
  try { localStorage.setItem(`${DISCLAIMER_KEY}:${user || "me"}`, "1"); } catch { /* storage blocked: ask again next time */ }
}

// Is the generator actually producing power right now? (Observed, not commanded.)
export function observedGen(state) {
  const f = state?.live?.flow;
  if (!f) return { known: false, running: false, watts: null };
  // Generator on the grid terminals (213F = 1): its power arrives in the grid field.
  const watts = state?.genLocation === "grid" ? Math.max(0, Number(f.grid) || 0) : Math.max(0, Number(f.gen) || 0);
  return { known: true, running: watts > 20, watts };
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

export function ControlView({ state, siteKey, userKey, liveAt, onChanged }) {
  const cfg = state.config || {};
  const tz = state.site?.timezone || "America/New_York";
  const obs = observedGen(state);
  const regs = state.live?.registers || null;
  const ags = regs && regs["2156"] != null && regs["2156"] !== "" ? Number(regs["2156"]) : null;
  const soc = state.live?.flow?.soc > 0 ? Math.round(state.live.flow.soc) : null;
  const now = useNow();
  const until = cfg.force_on && cfg.force_until ? new Date(cfg.force_until).getTime() : null;
  const left = until ? Math.max(0, Math.round((until - now) / 1000)) : null;

  const [runMin, setRunMin] = useState(Number(cfg.force_max_run_min) || 120);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(null); // text while a write is in flight
  const [err, setErr] = useState(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const inFlight = useRef(false);

  const source = state.genLocation === "grid" ? "Generator (grid terminals)" : "Generator";
  // A Run now goes Sent (cloud has it, inverter not yet on AGS On) -> Accepted (AGS reads On) -> Running
  // (power seen). It stays in Sent/Accepted, checked every 5 s, until it runs or its time is up.
  const phase = !cfg.force_on ? null : obs.running ? "running" : ags === 1 ? "accepted" : "sent";
  const statusWord = obs.running ? "Running" : phase === "accepted" ? "Starting" : phase === "sent" ? "Start sent" : obs.known ? "Stopped" : "Unknown";
  const statusColor = obs.running ? GEN_TEXT : cfg.force_on ? GEN_TEXT : MUTED;

  async function send(op, extra = {}, label) {
    if (inFlight.current) return;
    inFlight.current = true;
    setErr(null);
    setBusy(label);
    try {
      const r = await genApi("control", { site_key: siteKey, op, ...extra });
      if (r?.pending) toast(op === "start" ? "Start sent. Waiting for the inverter" : "Sent. Waiting for the inverter to confirm", { icon: "check", ms: 5000 });
      else toast({ start: "Generator start sent", end: "Run ended", stop: "Generator turned off", auto: "Generator back on automatic" }[op], { icon: "check" });
      await onChanged?.(true);
    } catch (e) {
      setErr(e.message);
      toast("The inverter did not confirm the change", { tone: "error", ms: 4000 });
      await onChanged?.(true);
    } finally {
      setBusy(null);
      inFlight.current = false;
    }
  }

  async function confirmStart() {
    const tp = pctOrNull(target);
    if (!Number.isInteger(runMin) || runMin < 1 || runMin > 1440) { setErr("Run time must be between 1 minute and 24 hours."); return; }
    if (tp != null && (!Number.isInteger(tp) || tp < 1 || tp > 100)) { setErr("Stop at % must be 1 to 100, or left empty."); return; }
    const ok = await confirmAlert("Start the generator now?", {
      message: `It runs for up to ${fmtDuration(runMin * 60)}${tp != null ? ` or until the battery reaches ${tp}%` : ""}, then stops on its own. Make sure nobody is working on it.`,
      action: "Start",
      destructive: false,
    });
    if (ok) send("start", { runMin, targetPct: tp }, "Sending to the inverter...");
  }

  function startPressed() {
    if (busy) return;
    if (!disclaimerAccepted(userKey)) { setShowDisclaimer(true); return; }
    confirmStart();
  }

  // "Turn generator off" = AGS Off: no automatic starts either, so say so first.
  async function turnOff() {
    if (busy) return;
    const ok = await confirmAlert("Turn the generator off?", {
      message: "It stays off, including automatic starts on low battery, until you choose Return to automatic or Run now.",
      action: "Turn off", destructive: true,
    });
    if (ok) send("stop", {}, "Turning the generator off. This can take up to 25 seconds.");
  }

  const sp = state.decision?.setpoint;
  const savedAgsLabel = cfg.saved_ags != null && AGS_LABEL[Number(cfg.saved_ags)] ? AGS_LABEL[Number(cfg.saved_ags)].toLowerCase() : "its previous setting";
  return (
    <>
      <Card>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 12, alignItems: "center", minWidth: 0 }}>
            <span aria-hidden="true" style={{ width: 48, height: 48, borderRadius: 14, background: obs.running ? "#F5F3FF" : "#F5F2EE", color: obs.running ? GEN : MUTED, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 26, flexShrink: 0 }}>
              <Icon name="generator" />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: FS.footnote, color: MUTED, fontWeight: 600 }}>{source}</div>
              <div style={{ fontSize: FS.title2, fontWeight: 800, color: statusColor, letterSpacing: "-0.3px", display: "flex", alignItems: "center", gap: 8 }}>
                {obs.running && <span className="ui-dot" style={{ width: 9, height: 9, background: GEN }} />}{statusWord}
              </div>
            </div>
          </div>
          <FreshChip atMs={liveAt} />
        </div>
        <div className="gen-grid3" style={{ marginTop: 14 }}>
          <Stat label="Power" value={obs.known ? fmtW(obs.watts) : "--"} />
          <Stat label="Battery" value={soc != null ? `${soc}%` : "--"} tone={soc != null ? BATTERY_TEXT : undefined} />
          <Stat label="Inverter mode" value={ags != null ? AGS_LABEL[ags] || `Code ${ags}` : "--"} />
          {state.live?.flow?.genV > 0 && <Stat label="Voltage" value={`${Math.round(state.live.flow.genV)} V`} />}
          {state.live?.flow?.genHz > 0 && <Stat label="Frequency" value={`${Number(state.live.flow.genHz).toFixed(1)} Hz`} />}
        </div>
        {sp && (
          <div style={{ marginTop: 12 }}>
            <InfoNote>
              {cfg.enabled
                ? <>Automatic control is on. Right now it starts at <strong>{sp.start_pct}%</strong> and charges to <strong>{sp.stop_pct}%</strong>{sp.source === "window" && sp.window ? <> (window {sp.window.label ? `"${sp.window.label}"` : `${minToClock(sp.window.start_min)} to ${minToClock(sp.window.end_min)}`})</> : " (defaults)"}.</>
                : <>Automatic control is off. The inverter's own start and stop settings still apply.</>}
            </InfoNote>
          </div>
        )}
        {state.live?.flowError && <InfoNote icon="alert">Couldn't read live power: {state.live.flowError}</InfoNote>}
        {!state.live && <div style={{ marginTop: 10 }}><InfoNote icon="alert">Live readings are not available for this account right now.</InfoNote></div>}
        {state.offGrid && state.genLocation === "grid" && <div style={{ marginTop: 8 }}><InfoNote>This site is off grid, so grid power here is the generator.</InfoNote></div>}
      </Card>

      {cfg.force_on ? (
        <Card title="Run in progress" icon="clock">
          <div style={{ fontSize: FS.title1, fontWeight: 800, color: TEXT, letterSpacing: "-0.5px", fontVariantNumeric: "tabular-nums" }}>
            {left != null ? fmtDuration(left) : "--"}
          </div>
          {phase !== "running" && (
            <div style={{ marginTop: 8 }}>
              <PendingNote text={phase === "sent"
                ? "Start sent. Waiting for the inverter to accept it (checking every 5 seconds). This can take a few minutes."
                : "The inverter accepted the start. Waiting for the generator to come on (checking every 5 seconds)."} />
            </div>
          )}
          <div style={{ fontSize: FS.subhead, color: MUTED, marginTop: 2 }}>
            {until ? `Stops at ${fmtClockAt(cfg.force_until, tz)}` : "No end time set"}
            {cfg.force_target_pct != null ? `, or sooner when the battery reaches ${cfg.force_target_pct}%` : ""}
          </div>
          <div className="gen-actions" style={{ marginTop: 14 }}>
            <Button variant="destructive" size="lg" icon="stop" full disabled={!!busy} onClick={() => send("end", {}, "Ending the run. This can take up to 25 seconds.")}>Stop generator</Button>
          </div>
          <div style={{ fontSize: FS.footnote, color: MUTED, marginTop: 8 }}>Ends this run and puts the inverter back to how it was before ({savedAgsLabel}).</div>
          <div className="gen-actions" style={{ marginTop: 12 }}>
            <Button icon="refresh" disabled={!!busy} onClick={() => send("auto", {}, "Returning to automatic. This can take up to 25 seconds.")}>Return to automatic</Button>
            <Button icon="x" disabled={!!busy} onClick={turnOff}>Turn generator off</Button>
          </div>
          <PendingNote text={busy} />
          <ErrorNote>{err}</ErrorNote>
        </Card>
      ) : (
        <Card title="Run now" icon="play">
          <div className="gen-grid2">
            <Field label="Run for" htmlFor="gen-run-h"><DurationInput idPrefix="gen-run" minutes={runMin} onChange={setRunMin} disabled={!!busy} /></Field>
            <Field label="Stop at battery (optional)" htmlFor="gen-target"><NumInput id="gen-target" value={target} onChange={setTarget} min={1} max={100} suffix="%" placeholder="None" disabled={!!busy} /></Field>
          </div>
          <div className="gen-actions" style={{ marginTop: 14 }}>
            <Button variant="primary" size="lg" icon="play" disabled={!!busy} onClick={startPressed}>Run now</Button>
            {ags !== 0 && ags != null && <Button size="lg" icon="refresh" disabled={!!busy} onClick={() => send("auto", {}, "Returning to automatic. This can take up to 25 seconds.")}>Return to automatic</Button>}
            {(obs.running || (ags != null && ags !== 2)) && <Button variant="destructive" size="lg" icon="stop" disabled={!!busy} onClick={turnOff}>Turn generator off</Button>}
          </div>
          <PendingNote text={busy} />
          <ErrorNote>{err}</ErrorNote>
          <div style={{ marginTop: 12 }}>
            {/* Plain-language summary of exactly what this Run now will do, built from the inputs above. */}
            <InfoNote>
              {(() => {
                const tpv = pctOrNull(target);
                const dur = Number.isInteger(runMin) && runMin > 0 ? fmtDuration(runMin * 60) : "the time above";
                const back = ags != null && AGS_LABEL[ags] ? AGS_LABEL[ags].toLowerCase() : "its current setting";
                return (
                  <>
                    {tpv != null
                      ? <>Runs for <strong>{dur}</strong> or until the battery reaches <strong>{tpv}%</strong>, <strong>whichever comes first</strong>.</>
                      : <>Runs for <strong>{dur}</strong>, then stops.</>}
                    {" "}Afterwards the inverter goes back to <strong>{back}</strong>.
                    {" "}The time limit is also stored on the inverter, so it stops on time even if the internet drops{tpv != null ? "; the battery % needs the internet to be checked" : ""}.
                    {" "}Stop ends it at any time.
                  </>
                );
              })()}
            </InfoNote>
          </div>
        </Card>
      )}

      {showDisclaimer && (
        <Sheet title="Before you start the generator" onClose={() => setShowDisclaimer(false)}
          footer={<>
            <Button onClick={() => setShowDisclaimer(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => { rememberDisclaimer(userKey); setShowDisclaimer(false); confirmStart(); }}>I understand</Button>
          </>}>
          <div style={{ fontSize: FS.body, color: TEXT, lineHeight: 1.55, display: "grid", gap: 10 }}>
            <p style={{ margin: 0 }}>Run now starts the generator remotely. Nobody may be on site to watch it.</p>
            <p style={{ margin: 0 }}>A generator that starts on its own can hurt someone working on it, or on the wiring it feeds. Make sure nobody is servicing the generator, the transfer equipment or the inverter before you start it.</p>
            <p style={{ margin: 0 }}>Check that it has fuel, ventilation and nothing blocking the exhaust. Never run it in a closed space.</p>
            <p style={{ margin: 0 }}>You are responsible for starting it. The app sends the command and confirms the inverter received it, but it can't see the generator itself.</p>
            <p style={{ margin: 0, color: MUTED, fontSize: FS.subhead }}>You only see this once on this device.</p>
          </div>
        </Sheet>
      )}
    </>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ background: "#FBF9F6", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 12px", minWidth: 0 }}>
      <div style={{ fontSize: FS.caption, color: MUTED, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: FS.headline, fontWeight: 800, color: tone || TEXT, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}</div>
    </div>
  );
}
