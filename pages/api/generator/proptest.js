// ─────────────────────────────────────────────────────────────────────────────
// Cron: parallel-settings propagation test runner (Jason, 2026-11-13). Every minute (vercel.json). For each site
// with a running `prop_run` (started by an admin from Admin > Generator control): one trial at a time, ~2 min each.
//   start: read 2153 on every inverter twice (read-noise check; also catches a late arrival of the last trial's
//          value), write a fresh value to ONE inverter (source rotates master / 2nd / 3rd), read all at ~10/30/45 s.
//   later minutes: read again; close at ~110 s.
// Never starts a trial in a minute when the generator system made a real write (the real write goes first).
// Every trial is tagged with whether the generator was running. At the end, the original value goes back on every
// inverter (retried each minute until all match). Only 2153 is written (inert while the exercise cycle is off).
// Rows: gen_events action 'prop_run' (one per test) and 'prop_trial' (one per trial), hidden from Activity.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin, readShadow, writeShadow, fetchInverterInfo } from "@/lib/midniteServer";
import { findSiteInAccount, getConfig } from "@/lib/generator/server";
import { TEST_CODE, TRIAL_SEC, nextValue } from "@/lib/generator/proptest";

export const config = { maxDuration: 60 };
const BUDGET_MS = 50000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, code: 503, error: "CRON_SECRET not set" };
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || req.headers["x-cron-secret"] || req.query.secret || "";
  return provided === secret ? { ok: true } : { ok: false, code: 401, error: "unauthorized" };
}

async function readAll(auth, sns, aid) {
  const res = await Promise.all(sns.map(sn => readShadow(auth, aid[sn], [TEST_CODE]).then(r => [sn, num(r?.[TEST_CODE])], () => [sn, null])));
  return Object.fromEntries(res);
}
const saveRow = (sb, id, after) => sb.from("gen_events").update({ after }).eq("id", id);

async function runSite(sb, run, startedAt) {
  const site_key = run.site_key, st = { ...(run.after || {}) };
  const left = () => BUDGET_MS - (Date.now() - startedAt);
  const { data: gen } = await sb.from("gen_sites").select("*").eq("site_key", site_key).maybeSingle();
  if (!gen) return { site_key, error: "no gen_sites row" };
  const { data: acct } = await sb.from("midnite_accounts").select("*").eq("id", gen.owner_account_id).maybeSingle();
  const hit = acct ? await findSiteInAccount(acct, site_key) : null;
  if (!hit) return { site_key, error: "can't log in to the site's account" };
  const { auth, site } = hit;
  const all = site_key.split(",");
  const sns = [gen.master_sn, ...all.filter(s => s !== gen.master_sn)].filter(Boolean);
  const aid = Object.fromEntries((site.GoodsID || []).map(g => [g.GoodsID, g.AutoID ? String(g.AutoID) : null]));
  if (sns.some(sn => !aid[sn])) return { site_key, error: "missing AutoId" };
  const now = () => Date.now();

  // First minute: original values + firmware.
  if (!st.original) {
    st.original = await readAll(auth, sns, aid);
    st.sns = sns;
    try { st.firmware = Object.fromEntries(await Promise.all(sns.map(sn => fetchInverterInfo(auth, aid[sn], site.MemberAutoID ?? auth.memberAutoId).then(i => [sn, i], () => [sn, null])))); } catch { /* optional */ }
    await saveRow(sb, run.id, st);
  }

  // Wrap-up: put the original value back on every inverter, retried each minute until all match.
  if (st.status === "restoring" || (st.status === "running" && now() >= Date.parse(st.ends_at) && !st.open_trial)) {
    const vals = await readAll(auth, sns, aid);
    const wrong = sns.filter(sn => st.original?.[sn] != null && vals[sn] !== st.original[sn]);
    if (!wrong.length) { st.status = "done"; st.finished_at = new Date().toISOString(); }
    else {
      st.status = "restoring"; st.restore_attempts = (st.restore_attempts || 0) + 1;
      for (const sn of wrong) { try { await writeShadow(auth, { autoId: aid[sn], writes: { [TEST_CODE]: st.original[sn] } }, { tries: 2, rereads: 0 }); } catch { /* retried next minute */ } }
      if (st.restore_attempts > 30) { st.status = "done"; st.restore_failed = wrong; st.finished_at = new Date().toISOString(); }
    }
    await saveRow(sb, run.id, st);
    return { site_key, status: st.status, wrong };
  }

  const cfg = await getConfig(sb, site_key);
  const genRunning = !!(cfg?.observed_running || cfg?.force_on);
  let did = [];

  // Advance the open trial.
  if (st.open_trial) {
    const { data: row } = await sb.from("gen_events").select("id,after").eq("id", st.open_trial).maybeSingle();
    const tr = row?.after;
    if (tr && !tr.closed) {
      const vals = await readAll(auth, sns, aid);
      const s = Math.round((now() - Date.parse(tr.t0)) / 1000);
      tr.reads.push({ s, vals });
      if (s >= TRIAL_SEC) { tr.closed = true; st.open_trial = null; st.last_trial = row.id; st.last_value = tr.value; }
      await saveRow(sb, row.id, tr);
      did.push(`read ${s}s`);
    } else st.open_trial = null;
    await saveRow(sb, run.id, st);
  }

  // Start a new trial.
  if (!st.open_trial && st.status === "running" && now() < Date.parse(st.ends_at) && left() > 45000) {
    const since = new Date(now() - 60000).toISOString();
    const { data: real } = await sb.from("gen_events").select("action").eq("site_key", site_key).gte("ts", since)
      .or("action.like.control_%,action.like.cron_%,action.like.master_%,action.like.resync_write,action.like.watchdog_%").limit(1);
    if (real?.length) { st.skipped_for_real_write = (st.skipped_for_real_write || 0) + 1; await saveRow(sb, run.id, st); return { site_key, skipped: "real generator write this minute" }; }
    const pre1 = await readAll(auth, sns, aid); await sleep(2000); const pre2 = await readAll(auth, sns, aid);
    // A late arrival of the previous trial's value (after its 2-minute window).
    if (st.last_trial && st.last_value != null) {
      const { data: prev } = await sb.from("gen_events").select("id,after").eq("id", st.last_trial).maybeSingle();
      if (prev?.after) {
        const late = { ...(prev.after.late || {}) };
        for (const sn of sns) if ((pre1[sn] === st.last_value || pre2[sn] === st.last_value) && !(prev.after.reads || []).some(x => x.vals?.[sn] === st.last_value)) late[sn] = true;
        await saveRow(sb, prev.id, { ...prev.after, late });
      }
    }
    const n = (st.trials || 0) + 1;
    const source = sns[(n - 1) % sns.length];
    const value = nextValue(n, Object.values(pre2), st.last_value);
    const t0 = new Date().toISOString();
    let w;
    try { w = await writeShadow(auth, { autoId: aid[source], writes: { [TEST_CODE]: value } }, { tries: 2, rereads: 0 }); } catch (e) { w = { err: e.message }; }
    const tr = { n, source, value, t0, gen_running: genRunning, pre: [{ vals: pre1 }, { vals: pre2 }],
      write: { accepted: !!w?.write?.RequestId, verified: !!w?.verified, err: w?.err || null, ms: now() - Date.parse(t0) }, reads: [], late: {}, closed: false };
    const { data: ins } = await sb.from("gen_events").insert({ site_key, action: "prop_trial", source: "cron", actor_role: "system", actor_name: "Propagation test", after: tr, success: true }).select("id").single();
    st.trials = n; st.open_trial = ins?.id || null;
    await saveRow(sb, run.id, st);
    for (const at of [10, 30, 45]) {
      const wait = Date.parse(t0) + at * 1000 - now();
      if (wait > 0) await sleep(wait);
      if (left() < 4000) break;
      const vals = await readAll(auth, sns, aid);
      tr.reads.push({ s: Math.round((now() - Date.parse(t0)) / 1000), vals });
      if (ins?.id) await saveRow(sb, ins.id, tr);
    }
    did.push(`trial ${n} from ${source} = ${value}`);
  }
  return { site_key, did, trials: st.trials };
}

export default async function handler(req, res) {
  const a = authorized(req);
  if (!a.ok) return res.status(a.code).json({ error: a.error });
  const sb = supabaseAdmin();
  if (!sb) return res.status(500).json({ error: "supabase not configured" });
  const startedAt = Date.now();
  const { data: runs } = await sb.from("gen_events").select("id,site_key,after,ts").eq("action", "prop_run").order("ts", { ascending: false }).limit(20);
  const seen = new Set(), active = [];
  for (const r of runs || []) { if (seen.has(r.site_key)) continue; seen.add(r.site_key); if (["running", "restoring"].includes(r.after?.status)) active.push(r); }
  const results = await Promise.all(active.map(r => runSite(sb, r, startedAt).catch(e => ({ site_key: r.site_key, error: e.message }))));
  return res.json({ ok: true, ms: Date.now() - startedAt, results });
}
