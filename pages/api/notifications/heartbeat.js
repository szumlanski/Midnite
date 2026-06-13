// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat — the scheduled evaluation cron (wired via vercel.json → every 15m).
//
// Secured by a shared secret (CRON_SECRET). For each device that has ≥1 enabled
// rule it: resolves the owning Midnite account's credentials → logs in → fetches
// the live inverter status → builds a normalized DeviceSnapshot → persists it →
// evaluates that device's rules and delivers. Offline/no-data is derived from the
// snapshot time-gap (lib/notifications/server.js), never the API's health claim.
//
// Auth (any one): Authorization: Bearer <CRON_SECRET>  (Vercel Cron sends this)
//                 x-cron-secret: <CRON_SECRET>
//                 ?secret=<CRON_SECRET>
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin, decryptCred, loginCached, fetchInverterDetail } from "@/lib/midniteServer";
import { buildSnapshot, offlineSnapshot } from "@/lib/notifications/snapshot";
import { persistSnapshot, evaluateNotificationsForDevice, isEntitled } from "@/lib/notifications/server";

// Current time as "HH:MM" in the site timezone (the fleet runs on US Eastern;
// the proxy already pins the Midnite cookie to America/New_York) — for time-gates.
function etHHMM() {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })
      .format(new Date()).replace(/[^\d:]/g, "");
  } catch { return new Date().toTimeString().slice(0, 5); }
}

export default async function handler(req, res) {
  // ── Shared-secret auth ──────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ error: "CRON_SECRET not set — refusing to run unauthenticated" });
  const provided =
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim() ||
    req.headers["x-cron-secret"] ||
    req.query.secret || "";
  if (provided !== secret) return res.status(401).json({ error: "unauthorized" });

  const sb = supabaseAdmin();
  if (!sb) return res.status(500).json({ error: "supabase not configured" });

  // ── Enumerate devices that have enabled rules ───────────────────────────────
  const { data: rules, error: rerr } = await sb
    .from("notification_rules")
    .select("user_id,account_id,site_name,device_id,device_label")
    .eq("enabled", true);
  if (rerr) return res.status(500).json({ error: rerr.message });
  if (!rules?.length) return res.json({ ok: true, devices: 0, evaluated: 0, sent: 0, note: "no enabled rules" });

  // Profiles (entitlement + recipient email) for involved users.
  const userIds = [...new Set(rules.map((r) => r.user_id))];
  const { data: profs } = await sb.from("profiles").select("id,email,role").in("id", userIds);
  const profById = Object.fromEntries((profs || []).map((p) => [p.id, p]));

  // Linked accounts (credentials) referenced by the rules.
  const acctIds = [...new Set(rules.map((r) => r.account_id).filter(Boolean))];
  const { data: accts } = acctIds.length
    ? await sb.from("midnite_accounts").select("id,user_id,midnite_username,enc_password").in("id", acctIds)
    : { data: [] };
  const acctById = Object.fromEntries((accts || []).map((a) => [a.id, a]));

  // Distinct devices keyed by (user_id, account_id, device_id).
  const deviceMap = new Map();
  for (const r of rules) {
    const k = `${r.user_id}|${r.account_id || ""}|${r.device_id}`;
    if (!deviceMap.has(k)) deviceMap.set(k, r);
  }

  const authCache = new Map();  // accountId → auth | null  (one login per account)
  const snapCache = new Map();  // accountId|device → snapshot (fetch once per device)
  const nowLocal = etHHMM();
  let totalSent = 0, evaluated = 0;
  const errors = [];

  for (const d of deviceMap.values()) {
    const prof = profById[d.user_id];
    if (!isEntitled(prof)) continue;
    const recipientEmail = prof?.email || null;

    // Resolve credentials: rule's account, else the user's first linked account.
    let acct = d.account_id ? acctById[d.account_id] : null;
    if (!acct) {
      const { data: mine } = await sb.from("midnite_accounts")
        .select("id,midnite_username,enc_password").eq("user_id", d.user_id).order("created_at").limit(1);
      acct = mine?.[0] || null;
    }
    const accountId = acct?.id || d.account_id || null;

    // Login (cached per account for this run).
    let auth = authCache.get(accountId);
    if (auth === undefined) {
      auth = null;
      if (acct) {
        try { auth = await loginCached(acct.midnite_username, decryptCred(acct.enc_password)); }
        catch (e) { errors.push({ device: d.device_id, err: "login: " + e.message }); }
      }
      authCache.set(accountId, auth);
    }

    // Fetch + normalize snapshot (cached per account|device for this run).
    const skey = `${accountId}|${d.device_id}`;
    let snapshot = snapCache.get(skey);
    if (snapshot === undefined) {
      snapshot = offlineSnapshot();
      if (auth) {
        try {
          const data = await fetchInverterDetail(auth, d.device_id);
          snapshot = data ? buildSnapshot(data, { online: true }) : offlineSnapshot();
        } catch (e) {
          errors.push({ device: d.device_id, err: "fetch: " + e.message });
          snapshot = offlineSnapshot();
        }
      }
      snapCache.set(skey, snapshot);
    }

    // Persist the time-series sample, then evaluate + deliver.
    await persistSnapshot({ userId: d.user_id, accountId, deviceId: d.device_id, siteName: d.site_name, snapshot });
    const r = await evaluateNotificationsForDevice({
      userId: d.user_id, accountId, siteName: d.site_name, deviceId: d.device_id, deviceLabel: d.device_label,
      snapshot, nowLocal, recipientEmail, profile: prof,
    });
    totalSent += r.sent || 0;
    evaluated += r.evaluated || 0;
  }

  return res.json({ ok: true, devices: deviceMap.size, evaluated, sent: totalSent, errors: errors.slice(0, 20) });
}
