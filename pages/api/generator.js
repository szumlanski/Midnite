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
  supabaseAdmin, getSaasUser, fetchFlowRt, fetchSiteFlowRt, readShadow, writeShadow, fetchDayExcel, fetchGenLegs,
} from "@/lib/midniteServer";
import { DEFAULT_CONFIG, siteKeyOf, evaluateGen, localParts, computeNextRun, validateWindow, overlappingPairs } from "@/lib/generator/core";
import { summarizeRuns } from "@/lib/generator/history";
import { GEN_READ_CODES, genWiring } from "@/lib/generator/registers";
import { agsForAutomatic, automaticFromAgs } from "@/lib/generator/control";
import {
  httpErr, dbCheck, findSiteInAccount, resolveMasterAutoId, siteAutoIds, writeAll, getConfig, ensureConfig, patchConfig,
  logEvent, applyControl, pick, SYSTEM_ACTOR,
} from "@/lib/generator/server";
import { getVapidPublicKey, pushToUser, parseSubscription } from "@/lib/push/server";

export const config = { maxDuration: 180 }; // a start = two verified writes, up to ~35 s each, plus a put-back on failure

function requireSiteKey(body) {
  const k = String(body?.site_key || "");
  if (!k || siteKeyOf(k.split(",")) !== k) throw httpErr(400, "site_key must be the site's inverter serials, sorted and joined with ','");
  return k;
}

// ── Access ──────────────────────────────────────────────────────────────────
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

const resolveMaster = (ctx) => resolveMasterAutoId(ctx.gen, ctx.site, ctx.auth);
const CONFIG_FIELDS = ["enabled", "auto_enabled", "default_start_pct", "default_stop_pct", "default_max_run_min", "force_max_run_min", "comms_lost_action", "alerts_enabled"];
const intIn = (v, lo, hi) => Number.isInteger(Number(v)) && v !== "" && v !== null && Number(v) >= lo && Number(v) <= hi;


// First time we see a site's inverter, copy ITS generator settings into the app (2129/212A start/stop %, 2136 max
// run), and mark them as already applied. Otherwise the app's built-in 20/80 defaults would be written over the
// inverter's own values (OffTheHook: 15/35) the moment someone switches Automatic control on (Jason, 2026-11-12).
// Runs only while applied_start_pct is null, so it never overrides what a user later saves in the app.
async function seedFromInverter(sb, site_key, regs, actor) {
  const st = Number(regs?.["2129"]), sp = Number(regs?.["212A"]), mr = Number(regs?.["2136"]);
  if (!Number.isFinite(st) || !Number.isFinite(sp) || sp <= st) return null;
  const { data } = await sb.from("gen_config").update({
    default_start_pct: st, default_stop_pct: sp, applied_start_pct: st, applied_stop_pct: sp,
    ...(Number.isFinite(mr) && mr >= 0 && mr <= 1440 ? { default_max_run_min: mr } : {}),
    updated_at: new Date().toISOString(),
  }).eq("site_key", site_key).is("applied_start_pct", null).select("*").maybeSingle();
  if (data) await logEvent(sb, site_key, { ...(actor || SYSTEM_ACTOR), role: actor?.role || "system" }, "seed_from_inverter", {
    after: { note: "Copied the inverter's own generator settings into the app", start_pct: st, stop_pct: sp, max_run_min: Number.isFinite(mr) ? mr : null },
  });
  return data || null;
}

// ── Handler ─────────────────────────────────────────────────────────────────
// Latest 5-min row of the master's day CSV: generator (and grid) leg voltages. Cached 60 s per site, since the
// Control view polls every 5-30 s and the CSV only changes every 5 minutes.
const _legsCache = new Map();
async function genLegsCached(memberId, sn, tz) {
  if (!memberId || !sn) return null;
  const k = `${memberId}|${sn}`, hit = _legsCache.get(k);
  if (hit && Date.now() - hit.ts < 60000) return hit.data;
  const p = localParts(new Date(), tz);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const { rows } = await fetchDayExcel(memberId, sn, date);
  // The export sometimes has a single blank sample (gen V and Hz both 0) in the middle of a run (OffTheHook 12:30,
  // 2026-11-12). When the latest row is blank but the row before had the generator up, show the row before.
  const blank = (x) => x && !(x.genL1V > 0) && !(x.genL2V > 0) && !(x.genHz > 0);
  let r = rows[rows.length - 1] || null;
  const prev = rows[rows.length - 2];
  if (blank(r) && prev && !blank(prev)) r = prev;
  const data = r ? { at: r.ts, genL1V: r.genL1V, genL2V: r.genL2V, genL1W: r.genL1W, genL2W: r.genL2W, gridL1V: r.gridL1V, gridL2V: r.gridL2V, genHz: r.genHz, gridHz: r.gridHz } : null;
  _legsCache.set(k, { data, ts: Date.now() });
  return data;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const action = req.query.action;
  const body = req.body || {};
  const dry = req.query.dry === "1" || body.dry === true;
  try {
    const { user, role: appRole } = await getSaasUser(req);
    const sb = supabaseAdmin();
    const { data: prof } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
    const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || null;
    const actorBase = { id: user.id, email: user.email || null, name: prof?.display_name || user.email || null,
      client: { ip, device: String(req.headers["user-agent"] || "").slice(0, 200) || null } };

    // ── Web Push (any signed-in user; no site_key, no canControlGen) ──
    if (action === "pushKey") {
      try { return res.json({ publicKey: await getVapidPublicKey({ sb }) }); }
      catch (e) { return res.status(503).json({ error: `Push is not available: ${e.message}` }); }
    }
    if (action === "pushSubscribe") {
      const sub = parseSubscription(body.subscription);
      if (!sub) return res.status(400).json({ error: "subscription must be a PushSubscription JSON ({endpoint, keys:{p256dh, auth}})" });
      const row = { ...sub, user_id: user.id, user_agent: String(req.headers["user-agent"] || "").slice(0, 400) || null, failure_count: 0 };
      const { error } = await sb.from("push_subscriptions").upsert(row, { onConflict: "endpoint" });
      dbCheck(error);
      return res.json({ ok: true });
    }
    if (action === "pushUnsubscribe") {
      const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
      if (!endpoint) return res.status(400).json({ error: "endpoint required" });
      const { error } = await sb.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", endpoint);
      dbCheck(error);
      return res.json({ ok: true });
    }
    if (action === "pushTest") {
      const r = await pushToUser(user.id, { title: "Midnite Sentinel", body: "Test notification: push alerts are working on this device.", url: "/", tag: "sentinel-push-test" }, { sb });
      if (!r.total) return res.status(404).json({ error: "No push subscriptions for your account. Turn on push on this device first.", ...r });
      return res.json({ ok: r.sent > 0, ...r });
    }

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
      const cfgNow = await ensureConfig(sb, site_key);
      if (cfgNow?.applied_start_pct == null && ctx.auth && master_auto_id) {
        try { await seedFromInverter(sb, site_key, await readShadow(ctx.auth, master_auto_id, ["2129", "212A", "2136"]), actor); }
        catch (e) { console.log("[generator] seed from inverter failed", e.message); }
      }
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
          try { live.flow = await fetchSiteFlowRt(ctx.auth, site_key.split(","), ctx.gen.master_sn); } catch (e) { live.flowError = e.message; } // summed over all inverters
          try { live.registers = await readShadow(ctx.auth, resolveMaster(ctx), GEN_READ_CODES); } catch (e) { live.registersError = e.message; }
          // 213F = 1: generator on the GRID terminals (its power shows in the grid fields); 2100 = 3: Off-Grid.
          if (live.registers) Object.assign(live, genWiring(live.registers));
          // Per-leg generator voltages (L1/L2) from the master's 5-minute export (the live feed has no per-leg V).
          // Live per-leg generator V/A/W + Hz from the rich status (what the MNP app shows); the CSV is the fallback.
          try { live.genLegs = await fetchGenLegs(ctx.auth, resolveMaster(ctx), ctx.site?.MemberAutoID ?? ctx.auth?.memberAutoId); }
          catch (e) { live.genLegsError = e.message; }
          if (!live.genLegs) try { live.legs = await genLegsCached(ctx.gen.site_name || ctx.site?.MemberID, ctx.gen.master_sn, ctx.gen.timezone || "America/New_York"); }
          catch (e) { live.legsError = e.message; }
          // The switch shows the inverter's real AGS (a change made in the portal shows up here). Not during a
          // Run now: AGS is On then and the switch keeps the setting the run's end will restore.
          const realAuto = automaticFromAgs(live.registers?.["2156"]);
          if (realAuto != null && cfgRow && !cfgRow.force_on && (!!cfgRow.enabled !== realAuto || Number(cfgRow.applied_ags) !== Number(live.registers["2156"]))) {
            const synced = await patchConfig(sb, site_key, { enabled: realAuto, applied_ags: Number(live.registers["2156"]) }).catch(() => null);
            if (synced) {
              Object.assign(config, synced);
              await logEvent(sb, site_key, SYSTEM_ACTOR, "external_ags_change", {
                before: { automatic: !!cfgRow.enabled, ags: cfgRow.applied_ags ?? null },
                after: { automatic: realAuto, ags: Number(live.registers["2156"]), note: "AGS changed outside the app (installer portal or at the inverter). Noticed while " + (actor.name || actor.email || "a user") + " viewed the site." },
              });
            }
          }
          if (live.registers && cfgRow && cfgRow.applied_start_pct == null) {
            const seeded = await seedFromInverter(sb, site_key, live.registers, actor).catch(() => null);
            if (seeded) Object.assign(config, seeded);
          }
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
        const r = await applyControl({
          sb, auth: ctx.auth, autoId, site_key, cfg, op, runMin: body.runMin, targetPct: body.targetPct,
          actor, source: "user", dry, startedBy: user.id, autoIds: siteAutoIds(ctx.gen, ctx.site),
        }, op === "start"
          // Run now: hand the writes to the cloud and return fast (~5 s each). The app then shows "Start sent" and
          // checks every 5 s until the inverter accepts it or the run's time is up (Jason, 2026-11-12).
          ? { writeShadow: (au, w) => writeShadow(au, w, { tries: 2, rereads: 0 }) }
          : undefined);
        if (dry && r.status === 200) return res.json({ ...r.body, master_sn: ctx.gen.master_sn });
        return res.status(r.status).json(r.body);
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
        // The Automatic switch IS the inverter's AGS mode: on = Auto (0), off = Off (2). Without AGS on Auto the
        // inverter ignores its start/stop %, so the switch writes 2156 (Jason, 2026-11-12).
        if (typeof body.enabled !== "boolean") return res.status(400).json({ error: "enabled (true/false) required" });
        const cfg = await ensureConfig(sb, site_key);
        const ags = agsForAutomatic(body.enabled);
        const action = body.enabled ? "master_on" : "master_off";
        // During a Run now, AGS is On. Don't cut the run: record the choice as the value the run's end restores.
        if (cfg.force_on) {
          const after = await patchConfig(sb, site_key, { enabled: body.enabled, saved_ags: ags, config_rev: (cfg.config_rev || 1) + 1 });
          await logEvent(sb, site_key, actor, action, { before: { enabled: cfg.enabled, saved_ags: cfg.saved_ags }, after: { enabled: after.enabled, saved_ags: ags, note: "applied when the current run ends" } });
          return res.json({ ok: true, config: after, deferred: true });
        }
        let autoId;
        try { autoId = resolveMaster(ctx); } catch (e) { await logEvent(sb, site_key, actor, action, { after: { ags }, success: false, error: e.message }); throw e; }
        let r;
        try { r = await writeAll(writeShadow, ctx.auth, siteAutoIds(ctx.gen, ctx.site), { "2156": ags }); } catch (e) { r = { verified: false, err: e.message }; }
        if (!r.verified) {
          const msg = `The inverter did not confirm AGS ${body.enabled ? "Auto" : "Off"}${r.err ? ": " + r.err : ""}. Automatic control was not changed.`;
          await logEvent(sb, site_key, actor, action, { before: { enabled: cfg.enabled }, after: { ags }, success: false, error: msg });
          return res.status(502).json({ error: msg });
        }
        const after = await patchConfig(sb, site_key, { enabled: body.enabled, applied_ags: ags, config_rev: (cfg.config_rev || 1) + 1 });
        await logEvent(sb, site_key, actor, action, { before: { enabled: cfg.enabled, ags: r.before?.["2156"] ?? null }, after: { enabled: after.enabled, ags } });
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

