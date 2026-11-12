// ─────────────────────────────────────────────────────────────────────────────
// Generator start/stop alerts (port of eg4-monitor lib/comm-hub/generator-alert.ts). Server only.
//
// notifyGeneratorEvent(site, 'start'|'stop', { source, socPct, durationSec }) is called by the tick
// cron when an observed run opens or closes. It NEVER throws: an email or push problem must not break
// the cron.
//
// Skipped entirely when gen_config.alerts_enabled is false.
// Recipients = every user who can open the site's generator (the canControlGen rules), deduped:
//   - owners: linked Midnite accounts that really hold the site (verified by logging in). Candidates are
//     the site's owner account, an end-user account whose login IS the site name, and accounts of users
//     who already saved generator alert prefs for this site;
//   - share recipients: ACTIVE site_shares of gen_sites.site_name (and owner account), verified against
//     the owner's site list like canControlGen;
//   - admins: always (they can open every site); each can turn theirs off in the Alerts view.
// Per user, gen_alert_prefs (email / push, both default on) picks the channels.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "../midniteServer.js";
import { send, shell } from "../notifications/deliver.js";
import { pushToUser } from "../push/server.js";
import { findSiteInAccount } from "./server.js";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://midnite-rose.vercel.app";
const BRAND = "Midnite Sentinel";

const SOURCE_WORD = { auto: "Automatic (battery level)", force: "Run now", schedule: "Scheduled run", manual: "Started at the generator" };

export function fmtRunDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${Math.max(1, m)} min`;
}

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Pure: the email + push for one event. info = { source, socPct, durationSec, whenLocal }.
export function buildGeneratorMessage(siteName, event, info = {}) {
  const started = event === "start";
  const headline = `${siteName} generator ${started ? "started" : "stopped"}`;
  const reason = info.source ? SOURCE_WORD[info.source] || null : null;
  const soc = info.socPct == null || Number.isNaN(Number(info.socPct)) ? null : Math.round(Number(info.socPct));
  const dur = !started && info.durationSec != null ? fmtRunDuration(info.durationSec) : null;
  const preheader = started ? (reason ? `${reason}${info.initiator ? ` by ${info.initiator}` : ""}.` : "The generator started.") : (dur ? `Ran for ${dur}.` : "The generator stopped.");

  const lines = [`Your generator at <strong>${esc(siteName)}</strong> has ${started ? "started" : "stopped"}.`];
  if (started && reason) lines.push(`<span style="color:#716A65">Reason:</span> <strong>${esc(reason)}</strong>`);
  if (started && info.initiator) lines.push(`<span style="color:#716A65">Started by:</span> <strong>${esc(info.initiator)}</strong>`);
  if (dur) lines.push(`<span style="color:#716A65">Ran for:</span> <strong>${dur}</strong>`);
  if (soc != null) lines.push(`<span style="color:#716A65">Battery:</span> <strong>${soc}%</strong>`);
  if (info.whenLocal) lines.push(`<span style="color:#716A65">As of:</span> ${esc(info.whenLocal)}`);
  lines.push(`<span style="color:#716A65;font-size:12px">Detected from the inverter's live generator reading, which can lag by a minute or two.</span>`);

  const text = `${headline}.` + (started && reason ? ` Reason: ${reason}.` : "") + (started && info.initiator ? ` Started by ${info.initiator}.` : "") + (dur ? ` Ran for ${dur}.` : "") +
    (soc != null ? ` Battery ${soc}%.` : "") + (info.whenLocal ? ` As of ${info.whenLocal}.` : "") + `\n\nOpen ${BRAND}: ${APP_URL}`;
  const footer = `You're receiving this because you can control this site's generator in ${BRAND}. Turn these alerts off in the site's Generator, Alerts view.`;
  return {
    email: { subject: headline, html: shell(headline, lines, started ? "#D97706" : "#15803D", footer), text },
    push: { title: headline, body: preheader + (soc != null ? ` Battery ${soc}%.` : ""), url: "/", tag: `gen-${event}-${String(info.siteKey || siteName).slice(0, 60)}` },
  };
}

// Users who can open this site's generator. Returns [{ user_id, via }] deduped. deps.findSite for tests.
export async function generatorRecipients(sb, site, deps = {}) {
  const findSite = deps.findSite || findSiteInAccount;
  const out = new Map();
  const site_key = site.site_key;

  const { data: prefRows } = await sb.from("gen_alert_prefs").select("user_id").eq("site_key", site_key);
  const prefUsers = [...new Set((prefRows || []).map(r => r.user_id).filter(Boolean))];

  // Candidate owner accounts.
  const cand = new Map();
  const addAccts = (rows) => { for (const a of rows || []) if (a?.id) cand.set(a.id, a); };
  if (site.owner_account_id) { const { data } = await sb.from("midnite_accounts").select("*").eq("id", site.owner_account_id); addAccts(data); }
  if (site.site_name) { const { data } = await sb.from("midnite_accounts").select("*").eq("midnite_username_lc", String(site.site_name).toLowerCase()); addAccts(data); }
  if (prefUsers.length) { const { data } = await sb.from("midnite_accounts").select("*").in("user_id", prefUsers); addAccts(data); }

  const hits = new Map(); // account id -> { site } or null
  for (const acct of cand.values()) {
    const hit = await findSite(acct, site_key);
    hits.set(acct.id, hit);
    if (hit && !out.has(acct.user_id)) out.set(acct.user_id, { user_id: acct.user_id, via: "owner" });
  }

  // Active shares of this site.
  if (site.site_name) {
    let q = sb.from("site_shares").select("owner_account_id,site_name,shared_with_user_id").eq("status", "active").eq("site_name", site.site_name);
    if (site.owner_account_id) q = q.eq("owner_account_id", site.owner_account_id);
    const { data: shares } = await q;
    for (const sh of shares || []) {
      if (!sh.shared_with_user_id || out.has(sh.shared_with_user_id)) continue;
      let hit = hits.get(sh.owner_account_id);
      if (hit === undefined) {
        const { data: oacct } = await sb.from("midnite_accounts").select("*").eq("id", sh.owner_account_id).maybeSingle();
        hit = oacct ? await findSite(oacct, site_key) : null;
        hits.set(sh.owner_account_id, hit);
      }
      if (hit && hit.site?.MemberID === sh.site_name) out.set(sh.shared_with_user_id, { user_id: sh.shared_with_user_id, via: "shared" });
    }
  }

  // Admins can open every site, so they get alerts too (Jason, 2026-11-12); each can turn theirs off in Alerts.
  const { data: admins } = await sb.from("profiles").select("id").eq("role", "admin");
  for (const a of admins || []) if (!out.has(a.id)) out.set(a.id, { user_id: a.id, via: "admin" });
  return [...out.values()];
}

// site = gen_sites row (+ optional `config` = gen_config row). Returns a summary; never throws.
export async function notifyGeneratorEvent(site, event, info = {}, deps = {}) {
  const summary = { event, recipients: 0, emails: 0, pushes: 0, skipped: null, errors: [] };
  try {
    const sb = deps.sb || supabaseAdmin();
    const sendFn = deps.send || send, pushFn = deps.pushToUser || pushToUser;
    let cfg = site.config;
    if (!cfg) { const { data } = await sb.from("gen_config").select("alerts_enabled").eq("site_key", site.site_key).maybeSingle(); cfg = data; }
    if (cfg && cfg.alerts_enabled === false) { summary.skipped = "alerts_disabled"; return summary; }

    const recips = await generatorRecipients(sb, site, deps);
    summary.recipients = recips.length;
    if (!recips.length) return summary;
    const ids = recips.map(r => r.user_id);
    const [{ data: prefs }, { data: profs }] = await Promise.all([
      sb.from("gen_alert_prefs").select("user_id,email,push").eq("site_key", site.site_key).in("user_id", ids),
      sb.from("profiles").select("id,email").in("id", ids),
    ]);
    const prefOf = new Map((prefs || []).map(p => [p.user_id, p]));
    const emailOf = new Map((profs || []).map(p => [p.id, p.email]));

    let whenLocal = info.whenLocal;
    if (!whenLocal) {
      try { whenLocal = new Date(info.at || Date.now()).toLocaleString("en-US", { timeZone: site.timezone || "America/New_York", dateStyle: "medium", timeStyle: "short" }); } catch { whenLocal = null; }
    }
    const msg = buildGeneratorMessage(site.site_name || "Your site", event, { ...info, whenLocal, siteKey: site.site_key });
    const sentTo = new Set();
    for (const r of recips) {
      const p = prefOf.get(r.user_id) || { email: true, push: true };
      const to = emailOf.get(r.user_id);
      if (p.email !== false && to && !sentTo.has(to.toLowerCase())) {
        sentTo.add(to.toLowerCase());
        try { const s = await sendFn({ channel: "email", to, message: msg.email }); if (s?.ok) summary.emails++; else if (s && !s.skipped) summary.errors.push(`email: ${s.reason}`); }
        catch (e) { summary.errors.push(`email: ${e.message}`); }
      }
      if (p.push !== false) {
        try { const pr = await pushFn(r.user_id, msg.push, { sb }); summary.pushes += pr?.sent || 0; }
        catch (e) { summary.errors.push(`push: ${e.message}`); }
      }
    }
  } catch (e) {
    summary.errors.push(e?.message || String(e));
    console.log("[generator] alert failed", event, site?.site_key, e?.message);
  }
  return summary;
}
