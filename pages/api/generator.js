// ─────────────────────────────────────────────────────────────────────────────
// Generator control API (Phase 2 server). POST /api/generator?action=X
//
// Kept apart from the high-traffic pages/api/midnite.js. Auth = the same Supabase JWT
// (Authorization: Bearer). Every action except siteToggle takes body.site_key = the site's
// inverter serials, sorted and joined with ",".
//
// Who may use it (canControlGen): the site is enabled in gen_sites AND the user owns a linked
// Midnite account that holds the site OR has an ACTIVE site_shares row for it. Share recipients
// CAN control the generator on purpose (their only write). Admins always can.
//
// Inverter writes go ONLY to gen_sites.master_sn, with the AutoId resolved on the server from that
// serial and checked against gen_sites.master_auto_id. Nothing from the client picks the target.
// Every write action adds a gen_events row (who, role, before/after, success/error).
// See CLAUDE.md "Generator server" and docs/generator-plan.md.
// ─────────────────────────────────────────────────────────────────────────────

import {
  supabaseAdmin, decryptCred, loginCached, getSaasUser,
  loadSitesWithAutoIdsCached, fetchFlowRt, readShadow, writeShadow,
} from "@/lib/midniteServer";
import { DEFAULT_CONFIG, siteKeyOf, evaluateGen, localParts, computeNextRun, validateWindow, overlappingPairs } from "@/lib/generator/core";
import { summarizeRuns } from "@/lib/generator/history";
import { planControl } from "@/lib/generator/control";
import { GEN_READ_CODES, genWiring } from "@/lib/generator/registers";

export const config = { maxDuration: 60 }; // a start = two verified writes, up to ~25 s each

const SCHEMA_HINT = "Generator tables aren't set up yet: run supabase/schema.sql in the Supabase SQL editor.";

function httpErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
function schemaMissing(err) { return /PGRST205|42P01|schema cache|does not exist/i.test(`${err?.code || ""} ${err?.message || ""}`); }
function dbCheck(error) { if (error) throw schemaMissing(error) ? httpErr(503, SCHEMA_HINT) : httpErr(500, error.message); }

function requireSiteKey(body) {
  const k = String(body?.site_key || "");
  if (!k || siteKeyOf(k.split(",")) !== k) throw httpErr(400, "site_key must be the site's inverter serials, sorted and joined with ','");
  return k;
}

// ── Access ──────────────────────────────────────────────────────────────────
// Log in with a linked account and find the site whose serial set == site_key.
async function findSiteInAccount(acct, site_key) {
  let pw;
  try { pw = decryptCred(acct.enc_password); } catch { return null; }
  try {
    const auth = await loginCached(acct.midnite_username, pw);
    const { sites } = await loadSitesWithAutoIdsCached(auth, acct.id);
    const site = (sites || []).find(s => siteKeyOf(s.GoodsID) === site_key);
    return site ? { auth, site } : null;
  } catch (e) { console.log("[generator] site lookup failed for account", acct.id, e.message); return null; }
}

// Returns { role:'owner'|'shared'|'admin', gen, acct, auth, site }. Throws 403 when not allowed.
// requireEnabled=false is used by siteToggle (admin, before the site exists in gen_sites).
async function canControlGen(sb, user, appRole, site_key, { requireEnabled = true, accountId = null } = {}) {
  const { data: gen, error } = await sb.from("gen_sites").select("*").eq("site_key", site_key).maybeSingle();
  dbCheck(error);
  const isAdmin = appRole === "admin";
  if (!isAdmin && requireEnabled && !gen?.enabled) throw httpErr(403, "Generator control is not turned on for this site.");

  // 1. Owner: one of the user's own linked accounts holds the site (gen owner account first).
  const { data: owned } = await sb.from("midnite_accounts").select("*").eq("user_id", user.id).order("created_at");
  const ordered = [...(owned || [])].sort((a, b) => (b.id === gen?.owner_account_id) - (a.id === gen?.owner_account_id));
  for (const acct of ordered) {
    const hit = await findSiteInAccount(acct, site_key);
    if (hit) return { role: "owner", gen, acct, ...hit };
  }

  // 2. Share recipient: an ACTIVE share of this site (by name, and owner account when known).
  if (gen?.site_name) {
    let q = sb.from("site_shares").select("owner_account_id,site_name").eq("shared_with_user_id", user.id).eq("status", "active").eq("site_name", gen.site_name);
    if (gen.owner_account_id) q = q.eq("owner_account_id", gen.owner_account_id);
    const { data: shares } = await q;
    for (const sh of shares || []) {
      const { data: oacct } = await sb.from("midnite_accounts").select("*").eq("id", sh.owner_account_id).maybeSingle();
      if (!oacct) continue;
      const hit = await findSiteInAccount(oacct, site_key);
      // The shared site name must be the site we matched, so a same-named site elsewhere can't leak in.
      if (hit && hit.site.MemberID === sh.site_name) return { role: "shared", gen, acct: oacct, ...hit };
    }
  }

  // 3. Admin: always allowed. Talk to Midnite through the given account or the site's owner account.
  if (isAdmin) {
    for (const id of [accountId, gen?.owner_account_id].filter(Boolean)) {
      const { data: acct } = await sb.from("midnite_accounts").select("*").eq("id", id).maybeSingle();
      if (!acct) continue;
      const hit = await findSiteInAccount(acct, site_key);
      if (hit) return { role: "admin", gen, acct, ...hit };
    }
    return { role: "admin", gen, acct: null, auth: null, site: null };
  }
  throw httpErr(403, "You don't have access to this site's generator.");
}

// Master AutoId from the serial, on the server, checked against what the admin stored.
function resolveMaster(ctx) {
  const { gen, site, auth } = ctx;
  if (!gen?.master_sn || !gen?.master_auto_id) throw httpErr(409, "No generator master inverter is set for this site.");
  if (!auth || !site) throw httpErr(409, "Can't reach this site's Midnite account to send the command.");
  const keySerials = gen.site_key.split(",");
  if (!keySerials.includes(gen.master_sn)) throw httpErr(409, `Refused: master ${gen.master_sn} is not part of this site.`);
  const inv = (site.GoodsID || []).find(g => g.GoodsID === gen.master_sn);
  const aid = inv?.AutoID ? String(inv.AutoID) : null;
  if (!aid) throw httpErr(409, `Refused: ${gen.master_sn} not found on the account.`);
  if (aid !== String(gen.master_auto_id)) throw httpErr(409, `Refused: stored master AutoId ${gen.master_auto_id} does not match ${gen.master_sn} (it is ${aid}).`);
  return aid;
}

// ── DB helpers ──────────────────────────────────────────────────────────────
async function getConfig(sb, site_key) {
  const { data, error } = await sb.from("gen_config").select("*").eq("site_key", site_key).maybeSingle();
  dbCheck(error);
  return data;
}
async function ensureConfig(sb, site_key) {
  let cfg = await getConfig(sb, site_key);
  if (!cfg) {
    const { error } = await sb.from("gen_config").upsert({ site_key }, { onConflict: "site_key", ignoreDuplicates: true });
    dbCheck(error);
    cfg = await getConfig(sb, site_key);
  }
  return cfg;
}
async function patchConfig(sb, site_key, patch) {
  const { data, error } = await sb.from("gen_config").update({ ...patch, updated_at: new Date().toISOString() }).eq("site_key", site_key).select("*").single();
  dbCheck(error);
  return data;
}
async function logEvent(sb, site_key, actor, action, { before = null, after = null, success = true, error = null } = {}) {
  try {
    await sb.from("gen_events").insert({
      site_key, actor_id: actor.id, actor_email: actor.email, actor_name: actor.name, actor_role: actor.role,
      action, source: "user", before, after, success, error: error ? String(error).slice(0, 1000) : null,
    });
  } catch (e) { console.error("[generator] event log failed", action, e.message); }
}
const pick = (o, keys) => (o ? Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]])) : null);
const CONFIG_FIELDS = ["enabled", "auto_enabled", "default_start_pct", "default_stop_pct", "default_max_run_min", "force_max_run_min", "comms_lost_action", "alerts_enabled"];
const FORCE_FIELDS = ["force_on", "force_until", "force_max_run_min", "force_target_pct", "saved_max_run_min", "applied_ags"];
const intIn = (v, lo, hi) => Number.isInteger(Number(v)) && v !== "" && v !== null && Number(v) >= lo && Number(v) <= hi;

// ── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const action = req.query.action;
  const body = req.body || {};
  const dry = req.query.dry === "1" || body.dry === true;
  try {
    const { user, role: appRole } = await getSaasUser(req);
    const sb = supabaseAdmin();
    const { data: prof } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
    const actorBase = { id: user.id, email: user.email || null, name: prof?.display_name || user.email || null };

    // ── Admin: turn a site on/off and set its master inverter ──
    if (action === "siteToggle") {
      if (appRole !== "admin") return res.status(403).json({ error: "forbidden" });
      const site_key = requireSiteKey(body);
      const { site_name, enabled = false, master_sn = null, timezone } = body;
      const ctx = await canControlGen(sb, user, appRole, site_key, { requireEnabled: false, accountId: body.accountId || null });
      const actor = { ...actorBase, role: "admin" };
      const before = ctx.gen ? { ...ctx.gen } : null;
      let master_auto_id = ctx.gen?.master_auto_id || null, msn = ctx.gen?.master_sn || null;
      if (master_sn) {
        if (!site_key.split(",").includes(master_sn)) return res.status(400).json({ error: `${master_sn} is not one of this site's inverters.` });
        if (!ctx.site) return res.status(409).json({ error: "Can't load this site's inverter list to resolve the master AutoId (pass accountId)." });
        const inv = (ctx.site.GoodsID || []).find(g => g.GoodsID === master_sn);
        if (!inv?.AutoID) return res.status(409).json({ error: `No AutoId found for ${master_sn}.` });
        master_auto_id = String(inv.AutoID); msn = master_sn;
      }
      if (enabled && (!msn || !master_auto_id)) return res.status(400).json({ error: "Set a master inverter before enabling generator control." });
      const name = site_name || ctx.gen?.site_name || ctx.site?.MemberID;
      if (!name) return res.status(400).json({ error: "site_name required" });
      const row = {
        site_key, site_name: name, enabled: !!enabled, master_sn: msn, master_auto_id,
        master_source: master_sn ? "admin" : (ctx.gen?.master_source || null),
        master_checked_at: master_sn ? new Date().toISOString() : (ctx.gen?.master_checked_at || null),
        owner_account_id: ctx.acct?.id || ctx.gen?.owner_account_id || null,
        enabled_by: user.id, updated_at: new Date().toISOString(),
        ...(timezone ? { timezone } : {}),
      };
      const { data: saved, error } = await sb.from("gen_sites").upsert(row, { onConflict: "site_key" }).select("*").single();
      if (error) { await logEvent(sb, site_key, actor, "site_toggle", { before, after: row, success: false, error: error.message }); dbCheck(error); }
      await ensureConfig(sb, site_key);
      await logEvent(sb, site_key, actor, enabled ? "site_enable" : "site_disable", { before, after: saved });
      return res.json({ ok: true, site: saved });
    }

    const site_key = requireSiteKey(body);
    const ctx = await canControlGen(sb, user, appRole, site_key, { accountId: body.accountId || null });
    if (!ctx.gen) return res.status(404).json({ error: "This site has no generator setup yet." });
    const actor = { ...actorBase, role: ctx.role };
    const tz = ctx.gen.timezone || "America/New_York";

    switch (action) {
      case "state": {
        const cfgRow = await getConfig(sb, site_key);
        const config = { ...DEFAULT_CONFIG, ...(cfgRow || {}) };
        const [{ data: windows }, { data: schedules }, { data: alerts }] = await Promise.all([
          sb.from("gen_windows").select("*").eq("site_key", site_key).order("priority").order("created_at"),
          sb.from("gen_schedules").select("*").eq("site_key", site_key).order("created_at"),
          sb.from("gen_alert_prefs").select("email,push").eq("user_id", user.id).eq("site_key", site_key).maybeSingle(),
        ]);
        let live = null;
        if (body.live !== false && ctx.auth && ctx.gen.master_sn) {
          live = {};
          try { live.flow = await fetchFlowRt(ctx.auth, ctx.gen.master_sn); } catch (e) { live.flowError = e.message; }
          try { live.registers = await readShadow(ctx.auth, resolveMaster(ctx), GEN_READ_CODES); } catch (e) { live.registersError = e.message; }
          // 213F = 1: generator on the GRID terminals (its power shows in the grid fields); 2100 = 3: Off-Grid.
          if (live.registers) Object.assign(live, genWiring(live.registers));
        }
        const lp = localParts(new Date(), tz);
        const soc = live?.flow?.soc > 0 ? live.flow.soc : null;
        const decision = evaluateGen({ config, windows: windows || [], soc, running: !!config.observed_running, minute: lp.minuteOfDay, dow: lp.dow });
        const { master_auto_id: _omit, ...site } = ctx.gen;
        return res.json({
          site, access: { role: ctx.role }, genLocation: live?.genLocation ?? null, offGrid: live?.offGrid ?? null, config, windows: windows || [], schedules: schedules || [],
          overlaps: overlappingPairs(windows || []).map(p => ({ a: p.a.id, b: p.b.id, winner: p.winner.id })),
          alerts: alerts || { email: true, push: true }, live, decision,
        });
      }

      case "control": {
        const op = body.op;
        const cfg = await ensureConfig(sb, site_key);
        if (!ctx.gen.enabled && ctx.role !== "admin") return res.status(403).json({ error: "Generator control is not turned on for this site." });
        let autoId;
        try { autoId = resolveMaster(ctx); }
        catch (e) { if (!dry) await logEvent(sb, site_key, actor, `control_${op}`, { after: { op }, success: false, error: e.message }); throw e; }
        // Current 2136 (and 2156) from the inverter: needed to remember the original max run time.
        let current = {};
        try { current = await readShadow(ctx.auth, autoId, ["2136", "2156"]); } catch (e) { current = { error: e.message }; }
        const plan = planControl(op, { runMin: body.runMin, targetPct: body.targetPct, current2136: current["2136"], saved: cfg.saved_max_run_min });
        if (plan.error) return res.status(400).json({ error: plan.error });
        if (op === "start" && plan.saveMaxRun == null && cfg.saved_max_run_min == null) {
          if (!dry) await logEvent(sb, site_key, actor, "control_start", { after: { op }, success: false, error: "could not read the current max run time (2136)" });
          return res.status(502).json({ error: "Couldn't read the inverter's current max run time, so it couldn't be restored later. Nothing was written.", current });
        }
        if (dry) return res.json({ dry: true, op, master_sn: ctx.gen.master_sn, current, planned: plan.steps, saveMaxRun: plan.saveMaxRun, force: plan.force });

        const before = pick(cfg, FORCE_FIELDS);
        // Remember the original 2136 BEFORE changing it, so a failure later can still restore it.
        if (op === "start" && cfg.saved_max_run_min == null) await patchConfig(sb, site_key, { saved_max_run_min: plan.saveMaxRun });
        const results = [];
        for (const step of plan.steps) {
          let r;
          try { r = await writeShadow(ctx.auth, { autoId, writes: { [step.code]: step.value } }); }
          catch (e) { r = { err: e.message, verified: false }; }
          results.push({ code: step.code, value: step.value, verified: !!r.verified, before: r.before?.[step.code], after: r.after?.[step.code], err: r.err || null });
          if (!r.verified) {
            const msg = `Write ${step.code}=${step.value} was not confirmed${r.err ? ": " + r.err : ""}.`;
            // A start whose cap or AGS write failed leaves the original 2136 saved for the next stop/auto.
            // A stop/auto whose AGS write landed but whose 2136 restore failed records the new AGS state
            // and keeps saved_max_run_min, so the next stop/auto retries the restore.
            let cfgAfter = null;
            if (op !== "start" && results.some(x => x.code === "2156" && x.verified))
              cfgAfter = await patchConfig(sb, site_key, { ...plan.force, applied_ags: plan.ags, force_started_by: null });
            await logEvent(sb, site_key, actor, `control_${op}`, { before, after: { op, results }, success: false, error: msg });
            return res.status(502).json({ error: msg, results, config: cfgAfter });
          }
        }
        const patch = { ...plan.force, applied_ags: plan.ags, ...(plan.clearSaved ? { saved_max_run_min: null } : {}), ...(op === "start" ? { force_started_by: user.id } : { force_started_by: null }) };
        const after = await patchConfig(sb, site_key, patch);
        await logEvent(sb, site_key, actor, `control_${op}`, { before, after: { ...pick(after, FORCE_FIELDS), results } });
        return res.json({ ok: true, op, results, config: after });
      }

      case "saveConfig": {
        const cfg = await ensureConfig(sb, site_key);
        const patch = {};
        for (const k of ["default_start_pct", "default_stop_pct"]) if (k in body) { if (!intIn(body[k], 0, 100)) return res.status(400).json({ error: `${k} must be 0-100` }); patch[k] = Number(body[k]); }
        for (const k of ["default_max_run_min", "force_max_run_min"]) if (k in body) { if (!intIn(body[k], 0, 1440)) return res.status(400).json({ error: `${k} must be 0-1440` }); patch[k] = Number(body[k]); }
        for (const k of ["auto_enabled", "alerts_enabled"]) if (k in body) patch[k] = !!body[k];
        if ("comms_lost_action" in body) { if (!["stop", "hold"].includes(body.comms_lost_action)) return res.status(400).json({ error: "comms_lost_action must be stop or hold" }); patch.comms_lost_action = body.comms_lost_action; }
        if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing to save" });
        const start = patch.default_start_pct ?? cfg.default_start_pct, stop = patch.default_stop_pct ?? cfg.default_stop_pct;
        if (stop <= start) return res.status(400).json({ error: "stop % must be above start %" });
        const after = await patchConfig(sb, site_key, { ...patch, config_rev: (cfg.config_rev || 1) + 1 });
        await logEvent(sb, site_key, actor, "save_config", { before: pick(cfg, Object.keys(patch)), after: pick(after, Object.keys(patch)) });
        return res.json({ ok: true, config: after });
      }

      case "setMaster": {
        if (typeof body.enabled !== "boolean") return res.status(400).json({ error: "enabled (true/false) required" });
        const cfg = await ensureConfig(sb, site_key);
        const after = await patchConfig(sb, site_key, { enabled: body.enabled, config_rev: (cfg.config_rev || 1) + 1 });
        await logEvent(sb, site_key, actor, body.enabled ? "master_on" : "master_off", { before: { enabled: cfg.enabled }, after: { enabled: after.enabled } });
        return res.json({ ok: true, config: after });
      }

      case "setAlerts": {
        const { data: prev } = await sb.from("gen_alert_prefs").select("email,push").eq("user_id", user.id).eq("site_key", site_key).maybeSingle();
        const row = { user_id: user.id, site_key, email: body.email ?? prev?.email ?? true, push: body.push ?? prev?.push ?? true };
        row.email = !!row.email; row.push = !!row.push;
        const { data, error } = await sb.from("gen_alert_prefs").upsert(row, { onConflict: "user_id,site_key" }).select("email,push").single();
        dbCheck(error);
        await logEvent(sb, site_key, actor, "set_alerts", { before: prev || null, after: data });
        return res.json({ ok: true, alerts: data });
      }

      case "saveWindow": {
        const w = {
          label: body.label ?? null, start_min: Number(body.start_min), end_min: Number(body.end_min),
          start_pct: Number(body.start_pct), stop_pct: Number(body.stop_pct), max_run_min: Number(body.max_run_min ?? 0),
          days_mask: Number(body.days_mask ?? 127), enabled: body.enabled !== false,
        };
        const bad = validateWindow(w);
        if (bad) return res.status(400).json({ error: bad });
        if (body.priority != null) { if (!Number.isInteger(Number(body.priority))) return res.status(400).json({ error: "priority must be a whole number" }); w.priority = Number(body.priority); }
        let before = null, saved;
        if (body.id) {
          const { data: prev } = await sb.from("gen_windows").select("*").eq("id", body.id).eq("site_key", site_key).maybeSingle();
          if (!prev) return res.status(404).json({ error: "window not found" });
          before = prev;
          const { data, error } = await sb.from("gen_windows").update(w).eq("id", body.id).eq("site_key", site_key).select("*").single();
          dbCheck(error); saved = data;
        } else {
          if (w.priority == null) {
            const { data: last } = await sb.from("gen_windows").select("priority").eq("site_key", site_key).order("priority", { ascending: false }).limit(1);
            w.priority = (last?.[0]?.priority ?? 0) + 10;
          }
          const { data, error } = await sb.from("gen_windows").insert({ ...w, site_key }).select("*").single();
          dbCheck(error); saved = data;
        }
        await logEvent(sb, site_key, actor, "save_window", { before, after: saved });
        return res.json({ ok: true, window: saved });
      }

      case "deleteWindow": {
        if (!body.id) return res.status(400).json({ error: "id required" });
        const { data: prev } = await sb.from("gen_windows").select("*").eq("id", body.id).eq("site_key", site_key).maybeSingle();
        if (!prev) return res.status(404).json({ error: "window not found" });
        const { error } = await sb.from("gen_windows").delete().eq("id", body.id).eq("site_key", site_key);
        dbCheck(error);
        await logEvent(sb, site_key, actor, "delete_window", { before: prev });
        return res.json({ ok: true });
      }

      case "reorderWindows": {
        const ids = Array.isArray(body.ids) ? body.ids : null;
        if (!ids?.length) return res.status(400).json({ error: "ids (array, highest priority first) required" });
        const { data: rows } = await sb.from("gen_windows").select("id,priority").eq("site_key", site_key);
        const mine = new Set((rows || []).map(r => r.id));
        if (ids.some(id => !mine.has(id)) || new Set(ids).size !== ids.length) return res.status(400).json({ error: "ids must be this site's windows, each once" });
        for (let i = 0; i < ids.length; i++) {
          const { error } = await sb.from("gen_windows").update({ priority: (i + 1) * 10 }).eq("id", ids[i]).eq("site_key", site_key);
          dbCheck(error);
        }
        await logEvent(sb, site_key, actor, "reorder_windows", { before: rows, after: ids.map((id, i) => ({ id, priority: (i + 1) * 10 })) });
        return res.json({ ok: true });
      }

      case "saveSchedule": {
        const kind = body.kind === "exercise" ? "exercise" : body.kind === "oneoff" ? "oneoff" : null;
        if (!kind) return res.status(400).json({ error: "kind must be oneoff or exercise" });
        if (!intIn(body.duration_min, 1, 1440)) return res.status(400).json({ error: "duration_min must be 1-1440" });
        if (body.target_pct != null && body.target_pct !== "" && !intIn(body.target_pct, 0, 100)) return res.status(400).json({ error: "target_pct must be 0-100" });
        const s = {
          kind, label: body.label ?? null, duration_min: Number(body.duration_min),
          target_pct: body.target_pct == null || body.target_pct === "" ? null : Number(body.target_pct),
          enabled: body.enabled !== false, fired: false,
          starts_at: null, days_mask: null, time_local: null,
        };
        if (kind === "oneoff") {
          const at = new Date(body.starts_at);
          if (!body.starts_at || Number.isNaN(at.getTime())) return res.status(400).json({ error: "starts_at (ISO time) required" });
          if (at.getTime() < Date.now() - 60000) return res.status(400).json({ error: "starts_at is in the past" });
          s.starts_at = at.toISOString(); s.next_run_at = s.starts_at;
        } else {
          if (!intIn(body.days_mask, 1, 127)) return res.status(400).json({ error: "days_mask must be 1-127 (bit 0 = Sunday)" });
          s.days_mask = Number(body.days_mask); s.time_local = String(body.time_local || "");
          const next = computeNextRun(s, tz, new Date());
          if (!next) return res.status(400).json({ error: "time_local must be HH:MM" });
          s.next_run_at = next.toISOString();
        }
        let before = null, saved;
        if (body.id) {
          const { data: prev } = await sb.from("gen_schedules").select("*").eq("id", body.id).eq("site_key", site_key).maybeSingle();
          if (!prev) return res.status(404).json({ error: "schedule not found" });
          before = prev;
          const { data, error } = await sb.from("gen_schedules").update(s).eq("id", body.id).eq("site_key", site_key).select("*").single();
          dbCheck(error); saved = data;
        } else {
          const { data, error } = await sb.from("gen_schedules").insert({ ...s, site_key, created_by: user.id }).select("*").single();
          dbCheck(error); saved = data;
        }
        await logEvent(sb, site_key, actor, "save_schedule", { before, after: saved });
        return res.json({ ok: true, schedule: saved });
      }

      case "deleteSchedule": {
        if (!body.id) return res.status(400).json({ error: "id required" });
        const { data: prev } = await sb.from("gen_schedules").select("*").eq("id", body.id).eq("site_key", site_key).maybeSingle();
        if (!prev) return res.status(404).json({ error: "schedule not found" });
        const { error } = await sb.from("gen_schedules").delete().eq("id", body.id).eq("site_key", site_key);
        dbCheck(error);
        await logEvent(sb, site_key, actor, "delete_schedule", { before: prev });
        return res.json({ ok: true });
      }

      case "history": {
        const days = Math.min(90, Math.max(1, Number(body.days) || 30));
        const months = Math.min(24, Math.max(1, Number(body.months) || 12));
        const { data: runs, error } = await sb.from("gen_runs").select("*").eq("site_key", site_key).order("started_at", { ascending: false }).limit(5000);
        dbCheck(error);
        const h = summarizeRuns(runs || [], { tz, days, months });
        return res.json({ ...h, runs: h.runs.slice(0, Math.min(200, Number(body.limit) || 50)), tz });
      }

      case "events": {
        const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
        let q = sb.from("gen_events").select("*").eq("site_key", site_key).order("ts", { ascending: false }).limit(limit);
        if (body.before) q = q.lt("ts", new Date(body.before).toISOString());
        const { data, error } = await q;
        dbCheck(error);
        const events = data || [];
        return res.json({ events, next: events.length === limit ? events[events.length - 1].ts : null });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    const code = Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500;
    if (code >= 500) console.error("[generator]", action, e.message);
    return res.status(code).json({ error: e.message || "error" });
  }
}

