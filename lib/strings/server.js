// ─────────────────────────────────────────────────────────────────────────────
// Strings (MPPT) server helpers, shared by pages/api/strings.js and the nightly cron
// (pages/api/strings/daily.js). Server only. Read-only on the Midnite side: the only Midnite call is
// the day CSV export (fetchDayExcel). Every dependency can be injected for tests.
//
//   canAccessSite   owner account holds the site OR an active site_shares row OR admin (no gen_sites needed)
//   loadLabels      site_mppt_labels rows for a site
//   everActiveSet   which sn/mppt pairs ever produced (last 120 days of mppt_daily)
//   storedDays      which sn|day pairs already have rows
//   collectDay      fetch one inverter's CSV for a day, compute per-MPPT kWh, upsert mppt_daily
// ─────────────────────────────────────────────────────────────────────────────

import { fetchDayExcel, supabaseAdmin } from "../midniteServer.js";
import { findSiteInAccount, httpErr, dbCheck } from "../generator/server.js";
import { computeMpptDay, etodayFromRows, rowsToStore, strKey } from "./energy.js";

export const STRINGS_SCHEMA_HINT = "String tables aren't set up yet: run supabase/strings.sql in the Supabase SQL editor.";
export function stringsDbCheck(error) {
  if (error && /PGRST205|42P01|schema cache|does not exist/i.test(`${error.code || ""} ${error.message || ""}`)) throw httpErr(503, STRINGS_SCHEMA_HINT);
  dbCheck(error);
}

// Returns { role:'owner'|'shared'|'admin', acct, auth, site } (acct/auth/site null for an admin with no
// account holding the site). Throws 403. Same rules as canControlGen, minus the gen_sites.enabled check.
export async function canAccessSite(sb, user, appRole, site_key, { accountId = null } = {}, deps = {}) {
  const find = deps.findSiteInAccount || findSiteInAccount;
  const { data: owned } = await sb.from("midnite_accounts").select("*").eq("user_id", user.id).order("created_at");
  const ordered = [...(owned || [])].sort((a, b) => (b.id === accountId) - (a.id === accountId));
  for (const acct of ordered) {
    const hit = await find(acct, site_key);
    if (hit) return { role: "owner", acct, ...hit };
  }
  const { data: shares } = await sb.from("site_shares").select("owner_account_id,site_name")
    .eq("shared_with_user_id", user.id).eq("status", "active");
  for (const sh of shares || []) {
    const { data: oacct } = await sb.from("midnite_accounts").select("*").eq("id", sh.owner_account_id).maybeSingle();
    if (!oacct) continue;
    const hit = await find(oacct, site_key);
    // The shared site name must be the site we matched, so a same-named site elsewhere can't leak in.
    if (hit && hit.site.MemberID === sh.site_name) return { role: "shared", acct: oacct, ...hit };
  }
  if (appRole === "admin") {
    if (accountId) {
      const { data: acct } = await sb.from("midnite_accounts").select("*").eq("id", accountId).maybeSingle();
      const hit = acct ? await find(acct, site_key) : null;
      if (hit) return { role: "admin", acct, ...hit };
    }
    return { role: "admin", acct: null, auth: null, site: null };
  }
  throw httpErr(403, "You don't have access to this site.");
}

// All rows of a PostgREST query, 1000 at a time (the server's default page cap). build() returns a fresh query.
export async function fetchAllRows(build, { pageSize = 1000, max = 20000 } = {}) {
  const out = [];
  for (let from = 0; from < max; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    stringsDbCheck(error);
    out.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return out;
}

export async function loadLabels(sb, site_key) {
  const { data, error } = await sb.from("site_mppt_labels").select("sn,mppt,label,kw_dc,updated_at").eq("site_key", site_key);
  stringsDbCheck(error);
  return data || [];
}

const isoDaysAgo = (n, now = Date.now()) => new Date(now - n * 86400000).toISOString().slice(0, 10);

export async function everActiveSet(sb, serials, { days = 120 } = {}) {
  if (!serials?.length) return new Set();
  const rows = await fetchAllRows(() => sb.from("mppt_daily").select("sn,mppt").in("sn", serials).gt("kwh", 0).gte("day", isoDaysAgo(days)).order("day"));
  return new Set(rows.map((r) => strKey(r.sn, r.mppt)));
}

export async function storedDays(sb, serials, from, to) {
  if (!serials?.length) return new Set();
  const rows = await fetchAllRows(() => sb.from("mppt_daily").select("sn,day").in("sn", serials).gte("day", from).lte("day", to).order("day"));
  return new Set(rows.map((r) => `${r.sn}|${String(r.day).slice(0, 10)}`));
}

// One inverter, one day. Returns { sn, day, samples, stored, rows } (stored = rows upserted).
// dry = compute only. Throws on a fetch error (the caller counts it as failed).
export async function collectDay({ sb, memberId, sn, day, siteKey, everActive = new Set(), dry = false }, deps = {}) {
  const fetchCsv = deps.fetchDayExcel || fetchDayExcel;
  const { rows } = await fetchCsv(memberId, sn, day);
  const computed = computeMpptDay(rows);
  const store = rowsToStore(sn, day, computed, { everActive, siteKey, etoday: etodayFromRows(rows) })
    .map((r) => ({ ...r, computed_at: new Date().toISOString() }));
  if (store.length && !dry) {
    const { error } = await (sb || supabaseAdmin()).from("mppt_daily").upsert(store, { onConflict: "sn,day,mppt" });
    stringsDbCheck(error);
  }
  return { sn, day, samples: rows.length, stored: dry ? 0 : store.length, rows: store };
}

// Run async jobs with a concurrency cap and a deadline (ms epoch). Jobs not started by the deadline are
// returned as `skipped` so the caller can report them for a retry.
export async function runPool(jobs, { concurrency = 4, deadline = Infinity } = {}) {
  const results = [], skipped = [];
  let i = 0;
  async function worker() {
    while (i < jobs.length) {
      const j = jobs[i++];
      if (Date.now() > deadline) { skipped.push(j); continue; }
      try { results.push({ job: j, ok: true, value: await j.run() }); }
      catch (e) { results.push({ job: j, ok: false, error: e.message }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return { results, skipped };
}
