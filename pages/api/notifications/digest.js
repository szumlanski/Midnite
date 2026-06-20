// ─────────────────────────────────────────────────────────────────────────────
// Daily-digest cron — runs HOURLY (vercel.json). For each enabled digest config
// whose send_hour matches the current hour *in that user's timezone* (and which
// hasn't already been sent today), it builds yesterday's recap and emails it.
//
// Secured by the shared CRON_SECRET (same scheme as the heartbeat):
//   Authorization: Bearer <CRON_SECRET>  | x-cron-secret: <…> | ?secret=<…>
//
// Per-user timezone + send-hour means one hourly cron serves every send time and
// every zone. `last_sent_date` (in the user's tz) makes the send idempotent so a
// double cron fire in the same hour can't send twice.
//
// Debug: add ?dry=1 to see which configs WOULD send this hour without sending.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "@/lib/midniteServer";
import { isEntitled } from "@/lib/notifications/server";
import { buildAndSendDigest, ymdInTz, hourInTz } from "@/lib/notifications/digestServer";

const DEFAULT_TZ = "America/New_York";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: "CRON_SECRET not set — refusing to run unauthenticated" });
  const provided =
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() ||
    req.headers["x-cron-secret"] ||
    req.query.secret || "";
  if (provided !== secret) return res.status(401).json({ error: "unauthorized" });

  const sb = supabaseAdmin();
  if (!sb) return res.status(500).json({ error: "supabase not configured" });
  const dry = req.query.dry === "1" || req.query.dry === "true";
  const now = new Date();

  // Enabled daily digests.
  const { data: digests, error } = await sb
    .from("notification_digests")
    .select("user_id,account_id,frequency,enabled,send_hour,timezone,site_name,last_sent_date")
    .eq("enabled", true).eq("frequency", "daily");
  if (error) return res.status(500).json({ error: error.message });
  if (!digests?.length) return res.json({ ok: true, due: 0, sent: 0, note: "no enabled daily digests" });

  // Which are due THIS hour (in their own tz) and not yet sent today?
  const due = [];
  for (const d of digests) {
    const tz = d.timezone || DEFAULT_TZ;
    const sendHour = Number.isFinite(d.send_hour) ? d.send_hour : 7;
    let curHour, today;
    try { curHour = hourInTz(now, tz); today = ymdInTz(now, tz); }
    catch { curHour = hourInTz(now, DEFAULT_TZ); today = ymdInTz(now, DEFAULT_TZ); }
    if (curHour !== sendHour) continue;
    if (d.last_sent_date === today) continue;
    due.push({ ...d, _tz: tz, _today: today });
  }

  if (dry) return res.json({ ok: true, dry: true, candidates: digests.length, due: due.map(d => ({ user: d.user_id, tz: d._tz, hour: d.send_hour, today: d._today })) });

  // Profiles (recipient email + entitlement) for the due users.
  const userIds = [...new Set(due.map(d => d.user_id))];
  const { data: profs } = userIds.length ? await sb.from("profiles").select("id,email,role").in("id", userIds) : { data: [] };
  const profById = Object.fromEntries((profs || []).map(p => [p.id, p]));

  let sent = 0, skipped = 0, failed = 0;
  const errors = [];

  for (const d of due) {
    const prof = profById[d.user_id];
    if (!isEntitled(prof)) { skipped++; continue; }
    const to = prof?.email;

    // Resolve the account whose creds we use: the configured account, else the
    // user's first linked account.
    let acct = null;
    if (d.account_id) {
      const { data } = await sb.from("midnite_accounts").select("id,midnite_username,enc_password").eq("id", d.account_id).maybeSingle();
      acct = data || null;
    }
    if (!acct) {
      const { data } = await sb.from("midnite_accounts").select("id,midnite_username,enc_password").eq("user_id", d.user_id).order("created_at").limit(1);
      acct = data?.[0] || null;
    }

    let result;
    try {
      result = await buildAndSendDigest({ acct, to, tz: d._tz, siteFilter: d.site_name || null });
    } catch (e) { result = { ok: false, reason: e.message }; }

    if (result.ok) sent++;
    else if (result.skipped || result.empty) skipped++;
    else { failed++; errors.push({ user: d.user_id, reason: result.reason }); }

    // Stamp the day regardless of outcome — the send-hour only matches once/day,
    // so this just guards against a duplicate cron fire within the same hour.
    await sb.from("notification_digests")
      .update({ last_sent_date: d._today, last_sent_at: new Date().toISOString() })
      .eq("user_id", d.user_id).eq("frequency", "daily");
  }

  return res.json({ ok: true, due: due.length, sent, skipped, failed, errors: errors.slice(0, 20) });
}
