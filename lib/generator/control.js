// ─────────────────────────────────────────────────────────────────────────────
// Generator control: PURE planner for Run now / Stop / Auto (no API, no DB).
// planControl(op, ctx) → { steps:[{code, value, why}], saveMaxRun, clearSaved, force, ags } or { error }.
//
//   start: remember the inverter's own 2136 (unless a forced run already saved it),
//          write 2136 = runMin as the hardware cap, then 2156 = 1 (AGS On).
//   stop:  2156 = 2 (AGS Off), then put 2136 back.
//   auto:  2156 = 0 (AGS Auto, native SOC start/stop takes over), then put 2136 back.
// ctx: { runMin, targetPct, current2136, saved, now }
// ─────────────────────────────────────────────────────────────────────────────

import { AGS } from "./registers.js";

export function planControl(op, ctx = {}) {
  const now = ctx.now ? new Date(ctx.now) : new Date();
  const saved = ctx.saved == null ? null : Number(ctx.saved);
  if (op === "start") {
    const runMin = Number(ctx.runMin);
    if (!Number.isInteger(runMin) || runMin < 1 || runMin > 1440) return { error: "runMin must be a whole number of minutes, 1-1440" };
    let targetPct = null;
    if (ctx.targetPct != null && ctx.targetPct !== "") {
      targetPct = Number(ctx.targetPct);
      if (!Number.isInteger(targetPct) || targetPct < 1 || targetPct > 100) return { error: "targetPct must be 1-100" };
    }
    // Keep the original value across back-to-back Run now presses.
    const keep = saved != null ? saved : (ctx.current2136 == null || ctx.current2136 === "" ? null : Number(ctx.current2136));
    return {
      steps: [
        { code: "2136", value: runMin, why: "max run time = hardware cap for this run" },
        { code: "2156", value: AGS.ON, why: "AGS On (start generator)" },
      ],
      saveMaxRun: keep,
      clearSaved: false,
      ags: AGS.ON,
      force: { force_on: true, force_until: new Date(now.getTime() + runMin * 60000).toISOString(), force_max_run_min: runMin, force_target_pct: targetPct },
    };
  }
  if (op === "stop" || op === "auto") {
    const ags = op === "stop" ? AGS.OFF : AGS.AUTO;
    const steps = [{ code: "2156", value: ags, why: op === "stop" ? "AGS Off (stop generator)" : "AGS Auto (native start/stop)" }];
    if (saved != null) steps.push({ code: "2136", value: saved, why: "restore the inverter's own max run time" });
    return {
      steps, saveMaxRun: null, clearSaved: saved != null, ags,
      force: { force_on: false, force_until: null, force_target_pct: null },
    };
  }
  return { error: "op must be start, stop or auto" };
}
