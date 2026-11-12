// ─────────────────────────────────────────────────────────────────────────────
// Generator control: shared SERVER helpers (DB + Midnite), used by pages/api/generator.js and the
// tick cron (pages/api/generator/tick.js) so both run the exact same register writes.
//
//   findSiteInAccount  log in with a linked account and find the site whose serial set == site_key
//   resolveMasterAutoId the master AutoId from the serial (server side), checked against gen_sites
//   getConfig / ensureConfig / patchConfig / logEvent   gen_config + gen_events helpers
//   applyControl       Run now / Stop / Auto: read 2136, plan, save the original 2136, write, patch, log
//
// Server only (imports lib/midniteServer.js). Every dependency can be injected for tests.
// ─────────────────────────────────────────────────────────────────────────────

import { decryptCred, loginCached, loadSitesWithAutoIdsCached, readShadow, writeShadow } from "../midniteServer.js";
import { siteKeyOf } from "./core.js";
import { planControl, automaticAfterOp } from "./control.js";

export const SCHEMA_HINT = "Generator tables aren't set up yet: run supabase/schema.sql in the Supabase SQL editor.";
export function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
export function schemaMissing(err) { return /PGRST205|42P01|schema cache|does not exist/i.test(`${err?.code || ""} ${err?.message || ""}`); }
export function dbCheck(error) { if (error) throw schemaMissing(error) ? httpErr(503, SCHEMA_HINT) : httpErr(500, error.message); }

export const SYSTEM_ACTOR = Object.freeze({ id: null, email: null, name: "Midnite Sentinel (automatic)", role: "system" });
export const FORCE_FIELDS = ["force_on", "force_until", "force_max_run_min", "force_target_pct", "saved_max_run_min", "saved_ags", "applied_ags"];
export const pick = (o, keys) => (o ? Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]])) : null);

// ── Access helpers ──────────────────────────────────────────────────────────
export async function findSiteInAccount(acct, site_key, deps = {}) {
  const decrypt = deps.decryptCred || decryptCred, loginFn = deps.loginCached || loginCached, sitesFn = deps.loadSites || loadSitesWithAutoIdsCached;
  let pw;
  try { pw = decrypt(acct.enc_password); } catch { return null; }
  try {
    const auth = await loginFn(acct.midnite_username, pw);
    const { sites } = await sitesFn(auth, acct.id);
    const site = (sites || []).find(s => siteKeyOf(s.GoodsID) === site_key);
    return site ? { auth, site } : null;
  } catch (e) { console.log("[generator] site lookup failed for account", acct.id, e.message); return null; }
}

// Master AutoId from the serial, on the server, checked against what the admin stored. Throws 409.
export function resolveMasterAutoId(gen, site, auth = true) {
  if (!gen?.master_sn || !gen?.master_auto_id) throw httpErr(409, "No generator master inverter is set for this site.");
  if (!auth || !site) throw httpErr(409, "Can't reach this site's Midnite account to send the command.");
  if (!String(gen.site_key || "").split(",").includes(gen.master_sn)) throw httpErr(409, `Refused: master ${gen.master_sn} is not part of this site.`);
  const inv = (site.GoodsID || []).find(g => g.GoodsID === gen.master_sn);
  const aid = inv?.AutoID ? String(inv.AutoID) : null;
  if (!aid) throw httpErr(409, `Refused: ${gen.master_sn} not found on the account.`);
  if (aid !== String(gen.master_auto_id)) throw httpErr(409, `Refused: stored master AutoId ${gen.master_auto_id} does not match ${gen.master_sn} (it is ${aid}).`);
  return aid;
}

// ── DB helpers ──────────────────────────────────────────────────────────────
export async function getConfig(sb, site_key) {
  const { data, error } = await sb.from("gen_config").select("*").eq("site_key", site_key).maybeSingle();
  dbCheck(error);
  return data;
}
export async function ensureConfig(sb, site_key) {
  let cfg = await getConfig(sb, site_key);
  if (!cfg) {
    const { error } = await sb.from("gen_config").upsert({ site_key }, { onConflict: "site_key", ignoreDuplicates: true });
    dbCheck(error);
    cfg = await getConfig(sb, site_key);
  }
  return cfg;
}
export async function patchConfig(sb, site_key, patch) {
  const { data, error } = await sb.from("gen_config").update({ ...patch, updated_at: new Date().toISOString() }).eq("site_key", site_key).select("*").single();
  dbCheck(error);
  return data;
}
// actor = { id, email, name, role }. source = 'user' | 'cron'. Never throws.
export async function logEvent(sb, site_key, actor, action, { before = null, after = null, success = true, error = null, source = "user" } = {}) {
  try {
    // Detail: who (actor columns), from where (client IP + device), and for cron rows, on whose behalf.
    if (actor?.client || actor?.onBehalfOf) {
      const extra = { ...(actor.client ? { client: actor.client } : {}), ...(actor.onBehalfOf ? { on_behalf_of: actor.onBehalfOf } : {}) };
      after = after && typeof after === "object" && !Array.isArray(after) ? { ...after, ...extra } : { value: after, ...extra };
    }
    await sb.from("gen_events").insert({
      site_key, actor_id: actor?.id ?? null, actor_email: actor?.email ?? null, actor_name: actor?.name ?? null, actor_role: actor?.role ?? null,
      action, source, before, after, success, error: error ? String(error).slice(0, 1000) : null,
    });
  } catch (e) { console.error("[generator] event log failed", action, e.message); }
}

// ── Run now / End / Stop / Auto (the ONE place that writes 2136/2156) ──────────────
// args: { sb, auth, autoId, site_key, cfg, op, runMin, targetPct, actor, source, dry, startedBy, action, extra }
//   cfg       the current gen_config row
//   startedBy user id stored in force_started_by on a start (null for the scheduler)
//   action    event name (default `control_${op}`); extra = merged into the event's `after`
// Returns { status, body } (HTTP-style; status 200 = done). Every write path logs a gen_events row.
export async function applyControl(args, deps = {}) {
  const read = deps.readShadow || readShadow, write = deps.writeShadow || writeShadow;
  const { sb, auth, autoId, site_key, cfg, op, runMin, targetPct, actor, source = "user", dry = false, startedBy = null, extra = null } = args;
  const action = args.action || `control_${op}`;
  // Current 2136 and 2156 from the inverter: needed to put both back when the run ends.
  let current = {};
  try { current = await read(auth, autoId, ["2136", "2156", "2124", "2129", "212A"]); } catch (e) { current = { error: e.message }; }
  const socMode = current["2124"] != null && current["2124"] !== "" && Number(current["2124"]) === 0;
  const plan = planControl(op, {
    runMin, targetPct, current2136: current["2136"], current2156: current["2156"], saved: cfg.saved_max_run_min, savedAgs: cfg.saved_ags,
    socMode, current2129: current["2129"], current212A: current["212A"],
    normalStart: cfg.applied_start_pct ?? cfg.default_start_pct, normalStop: cfg.applied_stop_pct ?? cfg.default_stop_pct,
  });
  if (plan.error) return { status: 400, body: { error: plan.error } };
  if (op === "start" && (plan.saveMaxRun == null || plan.saveAgs == null)) {
    if (!dry) await logEvent(sb, site_key, actor, action, { after: { op, ...extra }, success: false, error: "could not read the current max run time (2136) or AGS (2156)", source });
    return { status: 502, body: { error: "Couldn't read the inverter's current max run time and AGS setting, so they couldn't be put back after the run. Nothing was written.", current } };
  }
  if (dry) return { status: 200, body: { dry: true, op, current, planned: plan.steps, saveMaxRun: plan.saveMaxRun, force: plan.force } };

  const before = pick(cfg, FORCE_FIELDS);
  // Remember the original 2136 and 2156 BEFORE changing them, so a failure later can still restore them.
  if (op === "start" && (cfg.saved_max_run_min == null || cfg.saved_ags == null)) await patchConfig(sb, site_key, { saved_max_run_min: plan.saveMaxRun, saved_ags: plan.saveAgs });
  // The normal start/stop SOC the run's end puts back: the app's record, or the inverter's values right now.
  if (op === "start" && plan.seedThresholds && (cfg.applied_start_pct == null || cfg.applied_stop_pct == null))
    await patchConfig(sb, site_key, { applied_start_pct: plan.seedThresholds.start, applied_stop_pct: plan.seedThresholds.stop });
  const results = [];
  for (const step of plan.steps) {
    let r;
    try { r = await write(auth, { autoId, writes: step.writes || { [step.code]: step.value } }); }
    catch (e) { r = { err: e.message, verified: false }; }
    // Accepted by the cloud (it returned a RequestId) but not confirmed in time: the inverter often applies it
    // later (seen 2026-11-12 on OffTheHook). Treat it as pending, keep going, and track the run, so a late
    // landing is still labeled Run now and still ends on time. Only a write the cloud refused is a failure.
    const pending = !r.verified && !!r.write?.RequestId;
    results.push({ code: step.code, value: step.value, verified: !!r.verified, pending, before: step.writes ? r.before : r.before?.[step.code], after: step.writes ? r.after : r.after?.[step.code], err: r.err || null });
    if (!r.verified && !pending) {
      const msg = `Write ${step.code}=${step.value} was not confirmed${r.err ? ": " + r.err : ""}.`;
      // A start whose cap or AGS write failed leaves the original 2136 saved for the next stop/auto.
      // A stop/auto whose AGS write landed but whose 2136 restore failed records the new AGS state
      // and keeps saved_max_run_min, so the next stop/auto retries the restore.
      // A failed user Run now must not leave the short cap behind on the inverter (it would also cap the
      // native auto runs): best effort, put back the original 2136 and AGS. Not from the cron (time budget).
      if (op === "start" && source === "user") {
        const back = { "2136": plan.saveMaxRun };
        if (results.some(x => x.code === "2156")) back["2156"] = plan.saveAgs;
        const ns = cfg.applied_start_pct ?? plan.seedThresholds?.start, np = cfg.applied_stop_pct ?? plan.seedThresholds?.stop;
        if (results.some(x => x.code === "2129+212A") && ns != null && np != null) back["2129+212A"] = { "2129": ns, "212A": np };
        for (const [code, value] of Object.entries(back)) {
          if (value == null) continue;
          const w = typeof value === "object" ? value : { [code]: value };
          let rb; try { rb = await write(auth, { autoId, writes: w }); } catch (e) { rb = { err: e.message }; }
          results.push({ code, value, restore: true, verified: !!rb.verified, after: typeof value === "object" ? rb.after : rb.after?.[code], err: rb.err || null });
        }
      }
      let cfgAfter = null;
      if (op !== "start" && results.some(x => x.code === "2156" && x.verified))
        cfgAfter = await patchConfig(sb, site_key, { ...plan.force, applied_ags: plan.ags, force_started_by: null });
      await logEvent(sb, site_key, actor, action, { before, after: { op, results, ...extra }, success: false, error: msg, source });
      return { status: 502, body: { error: msg, results, config: cfgAfter } };
    }
  }
  // The Automatic switch mirrors AGS: after stop (Off) it shows off, after auto (Auto) on, after end it follows the
  // restored value. A start (AGS On) leaves it alone so the run's end can put it back.
  const autoAfter = op === "start" ? null : automaticAfterOp(plan.ags);
  const patch = { ...plan.force, applied_ags: plan.ags, ...(plan.clearSaved ? { saved_max_run_min: null, saved_ags: null } : {}), force_started_by: op === "start" ? startedBy : null, ...(autoAfter == null ? {} : { enabled: autoAfter }) };
  const after = await patchConfig(sb, site_key, patch);
  const pendingCodes = results.filter(x => x.pending).map(x => `${x.code}=${x.value}`);
  await logEvent(sb, site_key, actor, action, { before, after: { ...pick(after, FORCE_FIELDS), results, ...(pendingCodes.length ? { pending: pendingCodes } : {}), ...extra }, source });
  return { status: 200, body: { ok: true, op, results, pending: pendingCodes.length > 0, config: after } };
}

// Who a user id is, for cron rows that act on a user's behalf (their Run now or their schedule).
export async function whoIs(sb, userId) {
  if (!userId) return null;
  try {
    const { data } = await sb.from("profiles").select("id,email,display_name").eq("id", userId).maybeSingle();
    return data ? { id: data.id, email: data.email || null, name: data.display_name || data.email || null } : { id: userId };
  } catch { return { id: userId }; }
}
