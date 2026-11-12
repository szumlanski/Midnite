// ─────────────────────────────────────────────────────────────────────────────
// Generator tick cron: GET/POST /api/generator/tick, every minute (vercel.json).
//
// Auth (any one, like pages/api/notifications/heartbeat.js): Authorization: Bearer <CRON_SECRET>,
// x-cron-secret header, or ?secret=. ?dry=1 = compute and return the decisions; writes NOTHING to the
// inverter or the DB (it still logs in and reads live data).
//
// Per enabled gen_sites row (in parallel, each in its own try/catch):
//   1. lease: skip if this instance is already ticking the site, or another tick holds it
//      (gen_config.updated_at in the future = a lease, claimed atomically with "updated_at <= now")
//   2. log in with the site's owner account, resolve the master AutoId, read wiring (213F/2100/2124,
//      cached 1 h per instance), live flowrt for the master (+ the 5-min status when SOC/grid V is missing)
//   3. planTick() (lib/generator/tick.js, pure) decides; this file only carries the actions out:
//      gen_runs open/close/peaks + alerts, forced-run end, schedule starts, native 2129/212A thresholds,
//      observed_running/observed_at. Register writes go through applyControl / writeShadow only.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin, fetchFlowRt, fetchInverterDetail, readShadow, writeShadow } from "@/lib/midniteServer";
import { DEFAULT_CONFIG, computeNextRun } from "@/lib/generator/core";
import { genWiring } from "@/lib/generator/registers";
import { planTick } from "@/lib/generator/tick";
import {
  findSiteInAccount, resolveMasterAutoId, ensureConfig, getConfig, patchConfig, logEvent, applyControl, SYSTEM_ACTOR, whoIs,
} from "@/lib/generator/server";
import { notifyGeneratorEvent } from "@/lib/generator/alerts";

export const config = { maxDuration: 60 };

const BUDGET_MS = 55000;          // stop starting work after this
const CONTROL_NEEDS_MS = 40000;   // a control op = up to two verified writes
const THRESH_NEEDS_MS = 25000;    // one verified write
const LEASE_MS = 58000;
const WIRING_TTL_MS = 60 * 60 * 1000;
const THRESH_BACKOFF_MS = 10 * 60 * 1000;

const _ticking = new Set();        // site_keys this instance is working on
const _wiring = new Map();         // site_key -> { ts, genLocation, offGrid, capacityMode }
const _threshFail = new Map();     // site_key -> ts of the last failed threshold write

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, code: 503, error: "CRON_SECRET not set: refusing to run unauthenticated" };
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || req.headers["x-cron-secret"] || req.query.secret || "";
  return provided === secret ? { ok: true } : { ok: false, code: 401, error: "unauthorized" };
}

const avgPos = (xs) => { const v = (xs || []).map(Number).filter(x => Number.isFinite(x) && x > 0); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

async function readLive(auth, sn, wiring) {
  const live = { ok: false };
  let flow = null, status = null;
  try { flow = await fetchFlowRt(auth, sn); } catch (e) { live.flowError = e.message; }
  if (flow && flow.online !== false) {
    Object.assign(live, { ok: true, soc: flow.soc, genW: flow.gen, genV: flow.genV, genHz: flow.genHz, gridW: flow.grid, gridV: flow.gridV, gridHz: flow.gridHz, time: flow.time });
  } else if (flow) live.offline = true;
  // 5-min status: SOC fallback, and grid V/Hz on grid-side generators when the live feed lacks them.
  const needStatus = !live.ok || !(live.soc > 0) || (wiring?.genLocation === "grid" && live.gridV == null);
  if (needStatus && !live.offline) {
    try { status = await fetchInverterDetail(auth, sn); } catch (e) { live.statusError = e.message; }
    if (status) {
      if (!(live.soc > 0) && status.battery?.soc > 0) live.soc = status.battery.soc;
      if (live.gridV == null) live.gridV = avgPos(status.grid?.lines?.map(l => l.voltage));
      if (live.gridHz == null) live.gridHz = avgPos(status.grid?.lines?.map(l => l.frequency));
      if (!live.ok && wiring?.genLocation === "grid") { live.ok = true; live.gridW = status.grid?.netW; live.fromStatus = true; }
      if (!live.ok) live.socOnly = true; // SOC known, generator state not
    }
  }
  return live;
}

async function tickSite(sb, gen, { dry, startedAt }) {
  const site_key = gen.site_key;
  const out = { site_key, site_name: gen.site_name };
  if (_ticking.has(site_key)) return { ...out, skipped: "busy (this instance)" };
  _ticking.add(site_key);
  let leased = false;
  try {
    let cfg = dry ? ((await getConfig(sb, site_key)) || { ...DEFAULT_CONFIG, site_key }) : await ensureConfig(sb, site_key);

    // Lease (column-free): updated_at in the future = another tick holds the site.
    if (!dry) {
      if (cfg.updated_at && new Date(cfg.updated_at).getTime() > Date.now()) return { ...out, skipped: "busy (lease held)" };
      const lease = new Date(Date.now() + LEASE_MS).toISOString();
      // Atomic claim: only succeeds while no lease is held (updated_at not in the future). A second
      // concurrent tick re-checks the WHERE after the first commits and matches no row.
      const { data: got, error } = await sb.from("gen_config").update({ updated_at: lease })
        .eq("site_key", site_key).lte("updated_at", new Date().toISOString()).select("site_key");
      if (error) throw new Error(error.message);
      if (!got?.length) return { ...out, skipped: "busy (lease taken by another tick)" };
      leased = true;
    }

    // Owner account -> login -> site -> master.
    if (!gen.owner_account_id) return { ...out, error: "site has no owner account" };
    const { data: acct } = await sb.from("midnite_accounts").select("*").eq("id", gen.owner_account_id).maybeSingle();
    if (!acct) return { ...out, error: "owner account not found" };
    const hit = await findSiteInAccount(acct, site_key);
    if (!hit) return { ...out, error: "can't log in or find the site on the owner account" };
    const { auth, site } = hit;
    let autoId = null;
    try { autoId = resolveMasterAutoId(gen, site, auth); } catch (e) { out.masterError = e.message; }

    // Wiring, cached 1 h.
    let wiring = _wiring.get(site_key);
    if ((!wiring || Date.now() - wiring.ts > WIRING_TTL_MS) && autoId) {
      try {
        const regs = await readShadow(auth, autoId, ["213F", "2100", "2124"]);
        const w = genWiring(regs);
        const cm = regs?.["2124"];
        wiring = { ts: Date.now(), ...w, capacityMode: cm == null || cm === "" ? null : Number(cm) };
        if (w.genLocation != null) _wiring.set(site_key, wiring);
      } catch (e) { out.wiringError = e.message; }
    }
    wiring = wiring || { genLocation: null, offGrid: null, capacityMode: null };
    out.wiring = { genLocation: wiring.genLocation, offGrid: wiring.offGrid, capacityMode: wiring.capacityMode };

    const live = gen.master_sn ? await readLive(auth, gen.master_sn, wiring) : { ok: false };
    out.live = live;

    const [{ data: windows }, { data: schedules }, { data: openRuns }] = await Promise.all([
      sb.from("gen_windows").select("*").eq("site_key", site_key).order("priority").order("created_at"),
      sb.from("gen_schedules").select("*").eq("site_key", site_key).eq("enabled", true),
      sb.from("gen_runs").select("*").eq("site_key", site_key).is("ended_at", null).order("started_at", { ascending: false }).limit(1),
    ]);

    const tz = gen.timezone || "America/New_York";
    const now = new Date();
    const left = BUDGET_MS - (Date.now() - startedAt);
    const backoff = _threshFail.has(site_key) && Date.now() - _threshFail.get(site_key) < THRESH_BACKOFF_MS;
    const plan = planTick({
      config: cfg, windows: windows || [], schedules: schedules || [], live, wiring, openRun: openRuns?.[0] || null, now, tz,
      canWrite: { control: !!autoId && left > CONTROL_NEEDS_MS, thresholds: !!autoId && !backoff && left > THRESH_NEEDS_MS },
      computeNext: (s, from) => computeNextRun(s, tz, from),
    });
    out.plan = plan;
    if (dry) return { ...out, dry: true };

    // ── Carry out the plan ──
    const done = [];
    let runId = openRuns?.[0]?.id || null;
    for (const a of plan.actions) {
      try {
        if (a.type === "run_open") {
          const { data: row, error } = await sb.from("gen_runs").insert({
            site_key, started_at: now.toISOString(), source: a.source, soc_start: a.soc, cap_min: a.cap_min, target_pct: a.target_pct,
            peak_w: a.peak.w, peak_v: a.peak.v, peak_hz: a.peak.hz,
          }).select("id").single();
          if (error) throw new Error(error.message);
          runId = row.id; done.push({ type: a.type, id: runId });
          await logEvent(sb, site_key, { ...SYSTEM_ACTOR, onBehalfOf: await whoIs(sb, cfg.force_started_by) }, "generator_started", {
            after: { run_id: runId, cause: a.source, battery_pct: a.soc ?? null, cap_min: a.cap_min ?? null, target_pct: a.target_pct ?? null,
              reading: { w: a.peak?.w ?? null, v: a.peak?.v ?? null, hz: a.peak?.hz ?? null }, note: "The generator was seen running" },
            source: "cron",
          });
        } else if (a.type === "run_update") {
          const { id, type, ...peak } = a;
          await sb.from("gen_runs").update(peak).eq("id", id);
          done.push({ type, id });
        } else if (a.type === "run_close") {
          const { error } = await sb.from("gen_runs").update({ ended_at: a.ended_at, duration_sec: a.duration_sec, soc_end: a.soc_end }).eq("id", a.id);
          if (error) throw new Error(error.message);
          done.push({ type: a.type, id: a.id });
          await logEvent(sb, site_key, SYSTEM_ACTOR, "generator_stopped", {
            after: { run_id: a.id, ended_at: a.ended_at, duration_sec: a.duration_sec, battery_pct: a.soc_end ?? null, note: "The generator was seen stopped" },
            source: "cron",
          });
        } else if (a.type === "notify") {
          const r = await notifyGeneratorEvent({ ...gen, config: cfg }, a.event, { source: a.source, socPct: a.socPct, durationSec: a.durationSec, at: now });
          done.push({ type: a.type, event: a.event, emails: r.emails, pushes: r.pushes, recipients: r.recipients, skipped: r.skipped, errors: r.errors });
          await logEvent(sb, site_key, SYSTEM_ACTOR, a.event === "start" ? "alert_started_sent" : "alert_stopped_sent", {
            after: { emails: r.emails ?? 0, pushes: r.pushes ?? 0, recipients: r.recipients ?? null, skipped: r.skipped ?? null },
            success: !(r.errors && r.errors.length), error: r.errors && r.errors.length ? JSON.stringify(r.errors).slice(0, 900) : null, source: "cron",
          });
        } else if (a.type === "control") {
          cfg = (await getConfig(sb, site_key)) || cfg;
          // On whose behalf: the user who pressed Run now (an ending run) or who created the schedule (a start).
          const sched = a.scheduleId ? (schedules || []).find(x => x.id === a.scheduleId) : null;
          const behalf = await whoIs(sb, a.op === "end" ? cfg.force_started_by : sched?.created_by);
          const r = await applyControl({
            sb, auth, autoId, site_key, cfg, op: a.op, runMin: a.runMin, targetPct: a.targetPct,
            actor: { ...SYSTEM_ACTOR, onBehalfOf: behalf }, source: "cron", startedBy: null,
            action: a.op === "end" ? "cron_force_end" : "cron_schedule_start",
            extra: { reason: a.reason || null, schedule_id: a.scheduleId || null },
          });
          if (r.body?.config) cfg = r.body.config;
          done.push({ type: a.type, op: a.op, status: r.status, error: r.body?.error || null });
        } else if (a.type === "schedule_mark") {
          const patch = { fired: a.kind === "oneoff" ? true : false };
          if (a.kind === "exercise") patch.next_run_at = a.next_run_at;
          if (a.kind === "oneoff") patch.next_run_at = null;
          if (a.last_run_at) patch.last_run_at = a.last_run_at;
          await sb.from("gen_schedules").update(patch).eq("id", a.id).eq("site_key", site_key);
          if (a.skipped) await logEvent(sb, site_key, SYSTEM_ACTOR, "cron_schedule_skipped", { after: { schedule_id: a.id, reason: a.skipped, next_run_at: a.next_run_at }, source: "cron" });
          done.push({ type: a.type, id: a.id, skipped: a.skipped });
        } else if (a.type === "thresholds") {
          const before = { applied_start_pct: cfg.applied_start_pct, applied_stop_pct: cfg.applied_stop_pct };
          let r;
          try { r = await writeShadow(auth, { autoId, writes: { "2129": a.start_pct, "212A": a.stop_pct } }); }
          catch (e) { r = { verified: false, err: e.message }; }
          const after = { start_pct: a.start_pct, stop_pct: a.stop_pct, from: a.from, window_id: a.window_id, inverter_before: r.before || null, inverter_after: r.after || null };
          if (r.verified) {
            _threshFail.delete(site_key);
            cfg = await patchConfig(sb, site_key, { applied_start_pct: a.start_pct, applied_stop_pct: a.stop_pct });
            await logEvent(sb, site_key, SYSTEM_ACTOR, "cron_thresholds", { before, after, source: "cron" });
          } else {
            _threshFail.set(site_key, Date.now());
            await logEvent(sb, site_key, SYSTEM_ACTOR, "cron_thresholds", { before, after, success: false, error: `2129/212A write not confirmed${r.err ? ": " + r.err : ""}`, source: "cron" });
          }
          done.push({ type: a.type, verified: !!r.verified });
        } else if (a.type === "observe") {
          cfg = await patchConfig(sb, site_key, { observed_running: a.running, observed_at: a.at });
          done.push({ type: a.type, running: a.running });
        }
      } catch (e) {
        done.push({ type: a.type, error: e.message });
        console.error("[generator tick]", site_key, a.type, e.message);
      }
    }
    return { ...out, done };
  } catch (e) {
    console.error("[generator tick]", site_key, e.message);
    return { ...out, error: e.message };
  } finally {
    // Release the lease (only a future updated_at; a real patch already moved it to now).
    if (leased) { try { await sb.from("gen_config").update({ updated_at: new Date().toISOString() }).eq("site_key", site_key).gt("updated_at", new Date().toISOString()); } catch { /* ignore */ } }
    _ticking.delete(site_key);
  }
}

export default async function handler(req, res) {
  const a = authorized(req);
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const sb = supabaseAdmin();
  if (!sb) return res.status(500).json({ error: "supabase not configured" });
  const dry = req.query.dry === "1";
  const startedAt = Date.now();
  const { data: sites, error } = await sb.from("gen_sites").select("*").eq("enabled", true);
  if (error) return res.status(500).json({ error: error.message });
  const results = await Promise.all((sites || []).map(g => tickSite(sb, g, { dry, startedAt }).catch(e => ({ site_key: g.site_key, error: e.message }))));
  return res.json({ ok: true, dry, sites: results.length, ms: Date.now() - startedAt, results });
}
