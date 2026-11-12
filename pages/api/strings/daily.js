// ─────────────────────────────────────────────────────────────────────────────
// Nightly per-string (MPPT) energy collection. vercel.json runs it hourly at :15.
//
// A site is due when its local hour (gen_sites.timezone, default America/New_York) is 1 to 5 AM. The
// 1 AM run does the work; later runs only retry inverters whose YESTERDAY rows are still missing (time
// budget ran out, Midnite error, inverter offline). So each site is collected once a day.
// Every site reachable through a linked account is covered, deduped by site_key, one account per site.
// Per inverter: fetch yesterday's CSV export, integrate per MPPT, upsert mppt_daily. Read-only on Midnite.
//
// Auth (any one): Authorization: Bearer <CRON_SECRET> (Vercel Cron), x-cron-secret, or ?secret=.
// ?dry=1 = compute and return what it would store, write nothing. ?site_key=… = only that site, even
// outside the night window (manual retry).
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin, decryptCred, loginCached, loadSitesWithAutoIdsCached } from "@/lib/midniteServer";
import { siteKeyOf } from "@/lib/generator/core";
import { nightlyDue } from "@/lib/strings/energy";
import { everActiveSet, storedDays, collectDay, runPool } from "@/lib/strings/server";

export const config = { maxDuration: 60 };
const DEFAULT_TZ = "America/New_York";
const BUDGET_MS = 45000; // stop starting new work here; the next hour retries what is left

export default async function handler(req, res) {
  const t0 = Date.now();
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: "CRON_SECRET not set: refusing to run unauthenticated" });
  const provided = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || req.headers["x-cron-secret"] || req.query.secret || "";
  if (provided !== secret) return res.status(401).json({ error: "unauthorized" });
  const dry = req.query.dry === "1";
  const only = req.query.site_key ? String(req.query.site_key) : null;
  const sb = supabaseAdmin();
  if (!sb) return res.status(500).json({ error: "supabase not configured" });
  const now = new Date();

  // Site time zones (generator sites carry one). Nothing is due anywhere: skip the Midnite logins.
  const { data: genSites } = await sb.from("gen_sites").select("site_key,timezone");
  const tzOf = Object.fromEntries((genSites || []).filter((g) => g.timezone).map((g) => [g.site_key, g.timezone]));
  const tzs = new Set([DEFAULT_TZ, ...Object.values(tzOf)]);
  if (!only && ![...tzs].some((tz) => nightlyDue(now, tz).due)) return res.json({ ok: true, note: "no site is in its 1-5 AM window", sites: [] });

  // Every linked account -> its sites, deduped by site_key (first account that holds a site wins).
  const { data: accts, error } = await sb.from("midnite_accounts").select("id,midnite_username,enc_password").order("created_at");
  if (error) return res.status(500).json({ error: error.message });
  const sites = new Map();
  for (const acct of accts || []) {
    if (Date.now() - t0 > 20000) break;
    let auth, list;
    try { auth = await loginCached(acct.midnite_username, decryptCred(acct.enc_password)); ({ sites: list } = await loadSitesWithAutoIdsCached(auth, acct.id)); }
    catch (e) { console.log("[strings/daily] account", acct.id, e.message); continue; }
    for (const s of list || []) {
      const serials = (s.GoodsID || []).map((g) => (typeof g === "string" ? g : g.GoodsID)).filter(Boolean);
      const key = siteKeyOf(serials);
      if (!key || sites.has(key)) continue;
      sites.set(key, { site_key: key, name: s.MemberID, serials, accountId: acct.id });
    }
  }

  // Due sites and their missing (inverter, yesterday) pairs.
  const jobs = [], report = [];
  for (const s of sites.values()) {
    if (only && s.site_key !== only) continue;
    const tz = tzOf[s.site_key] || DEFAULT_TZ;
    const { due, yesterday } = nightlyDue(now, tz);
    if (!due && !only) continue;
    try {
      const have = await storedDays(sb, s.serials, yesterday, yesterday);
      const missing = s.serials.filter((sn) => !have.has(`${sn}|${yesterday}`));
      const r = { site: s.name, site_key: s.site_key, day: yesterday, tz, missing: missing.length, results: [] };
      report.push(r);
      if (!missing.length) continue;
      const everActive = await everActiveSet(sb, s.serials);
      for (const sn of missing) jobs.push({ r, sn, run: () => collectDay({ sb, memberId: s.name, sn, day: yesterday, siteKey: s.site_key, everActive, dry }) });
    } catch (e) { report.push({ site: s.name, site_key: s.site_key, error: e.message }); }
  }

  const { results, skipped } = await runPool(jobs, { concurrency: 4, deadline: t0 + BUDGET_MS });
  for (const x of results) x.job.r.results.push(x.ok
    ? { sn: x.job.sn, samples: x.value.samples, stored: x.value.stored, ...(dry ? { rows: x.value.rows } : {}) }
    : { sn: x.job.sn, error: x.error });
  for (const j of skipped) j.r.results.push({ sn: j.sn, deferred: true });
  return res.json({
    ok: true, dry, ms: Date.now() - t0, sitesKnown: sites.size, sitesDue: report.length,
    stored: results.reduce((a, x) => a + (x.ok ? x.value.stored : 0), 0), deferred: skipped.length, sites: report,
  });
}
