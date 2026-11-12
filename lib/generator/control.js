// ─────────────────────────────────────────────────────────────────────────────
// Generator control: PURE planner for Run now / End / Stop / Auto (no API, no DB).
// planControl(op, ctx) -> { steps:[{code, value, why}], saveMaxRun, saveAgs, clearSaved, force, ags } or { error }.
//
//   start: remember the inverter's own 2136 AND 2156 (unless a forced run already saved them),
//          write 2136 = runMin as the hardware cap, then 2156 = 1 (AGS On).
//   end:   the normal end of a Run now (time up, target reached, or the Stop button): put 2156 back
//          to what it was BEFORE the run (Jason, 2026-11-12), then put 2136 back.
//   stop:  2156 = 2 (AGS Off), then put 2136 back. Explicit "turn the generator off".
//   auto:  2156 = 0 (AGS Auto, native SOC start/stop takes over), then put 2136 back.
// ctx: { runMin, targetPct, current2136, current2156, saved, savedAgs, now }
// ─────────────────────────────────────────────────────────────────────────────

import { AGS } from "./registers.js";

const num = (v) => (v == null || v === "" ? null : Number(v));

export function planControl(op, ctx = {}) {
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const saved = num(ctx.saved);
  const savedAgs = num(ctx.savedAgs);
  if (op === "start") {
    const runMin = Number(ctx.runMin);
    if (!Number.isInteger(runMin) || runMin < 1 || runMin > 1440) return { error: "runMin must be a whole number of minutes, 1-1440" };
    let targetPct = null;
    if (ctx.targetPct != null && ctx.targetPct !== "") {
      targetPct = Number(ctx.targetPct);
      if (!Number.isInteger(targetPct) || targetPct < 1 || targetPct > 100) return { error: "targetPct must be 1-100" };
    }
    // Keep the originals across back-to-back Run now presses (a second press must not save "On").
    const keep = saved != null ? saved : num(ctx.current2136);
    const keepAgs = savedAgs != null ? savedAgs : num(ctx.current2156);
    return {
      steps: [
        { code: "2136", value: runMin, why: "max run time = hardware cap for this run" },
        { code: "2156", value: AGS.ON, why: "AGS On (start generator)" },
      ],
      saveMaxRun: keep,
      saveAgs: keepAgs,
      clearSaved: false,
      ags: AGS.ON,
      force: { force_on: true, force_until: new Date(now.getTime() + runMin * 60000).toISOString(), force_max_run_min: runMin, force_target_pct: targetPct },
    };
  }
  if (op === "end" || op === "stop" || op === "auto") {
    // end: back to the pre-run AGS; if none was saved (no run in progress), fall back to Auto.
    const ags = op === "stop" ? AGS.OFF : op === "auto" ? AGS.AUTO : (savedAgs != null ? savedAgs : AGS.AUTO);
    const why = op === "stop" ? "AGS Off (stop generator)" : op === "auto" ? "AGS Auto (native start/stop)" : "AGS back to its setting before the run";
    const steps = [{ code: "2156", value: ags, why }];
    if (saved != null) steps.push({ code: "2136", value: saved, why: "restore the inverter's own max run time" });
    return {
      steps, saveMaxRun: null, saveAgs: null, clearSaved: saved != null || savedAgs != null, ags,
      force: { force_on: false, force_until: null, force_target_pct: null },
    };
  }
  return { error: "op must be start, end, stop or auto" };
}
