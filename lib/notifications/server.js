// ─────────────────────────────────────────────────────────────────────────────
// Server-side notification orchestration (the impure layer).
//
// evaluateNotificationsForDevice() is the heart: for one device + snapshot it
// checks entitlement, loads enabled rules, evaluates each (pure engine), enforces
// per-rule cooldown + a per-user/day cap, sends via the channel wrapper, stamps
// last_triggered_at ONLY on a successful send (so failures retry next cycle), and
// writes a send-audit row for every outcome.
//
// All DB access uses the Supabase service-role client; the user-facing tables are
// RLS-protected (defense-in-depth) and reads in the proxy are scoped by user_id.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "../midniteServer";
import { evaluateRule, describeRule } from "./engine";
import { send, buildAlertMessage, buildCapMessage, channelConfigured } from "./deliver";

const DAILY_CAP = () => Math.max(1, parseInt(process.env.ALERTS_DAILY_CAP || "50", 10) || 50);

// Entitlement — centralized so alerts can become a paid feature later without
// touching the engine or heartbeat. Today: every signed-in user is entitled.
function isEntitled(profile) {
  return !!profile; // any authenticated user with a profile row
}

async function persistSnapshot({ userId, accountId, deviceId, siteName, snapshot }) {
  const sb = supabaseAdmin();
  if (!sb) return;
  await sb.from("device_snapshots").insert({
    user_id: userId,
    account_id: accountId || null,
    device_id: deviceId,
    site_name: siteName || null,
    online: !!snapshot.online,
    metrics: snapshot.metrics || {},
    captured_at: snapshot.capturedAt,
  });
}

// Minutes since the most recent ONLINE snapshot for this device. If the current
// sample is online → 0. Derived purely from snapshot timestamps (the time-gap),
// never from the API's self-reported health.
async function minutesSinceOnline(deviceId, snapshot) {
  if (snapshot.online) return 0;
  const sb = supabaseAdmin();
  if (!sb) return Number.POSITIVE_INFINITY;
  const { data } = await sb
    .from("device_snapshots")
    .select("captured_at")
    .eq("device_id", deviceId)
    .eq("online", true)
    .order("captured_at", { ascending: false })
    .limit(1);
  const last = data?.[0]?.captured_at;
  if (!last) return Number.POSITIVE_INFINITY;
  return Math.max(0, (Date.now() - new Date(last).getTime()) / 60000);
}

async function logSend(sb, { userId, rule, deviceId, channel, status, value, detail }) {
  try {
    await sb.from("notification_log").insert({
      user_id: userId,
      rule_id: rule?.id || null,
      device_id: deviceId,
      trigger_type: rule?.trigger_type || null,
      channel: channel || rule?.channel || "email",
      status,
      value: value == null || Number.isNaN(value) ? null : Number(value),
      detail: (detail || "").slice(0, 300),
      sent_at: new Date().toISOString(),
    });
  } catch (e) { /* logging must never break delivery */ }
}

// Atomic per-user/day counter via the SQL RPC (see schema.sql). Always increments,
// returns the new count. Caller compares against the cap.
async function bumpQuota(sb, userId, cap) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await sb.rpc("notif_quota_increment", { p_user: userId, p_day: day, p_cap: cap });
    if (error) return null;
    return typeof data === "number" ? data : (Array.isArray(data) ? data[0] : null);
  } catch (e) { return null; }
}

/**
 * Evaluate all of a device's rules against one snapshot and deliver.
 * @returns { sent, evaluated, gap, results[] }
 */
async function evaluateNotificationsForDevice({
  userId, accountId, siteName, deviceId, deviceLabel, snapshot, nowLocal, recipientEmail, profile,
}) {
  const sb = supabaseAdmin();
  if (!sb) return { error: "supabase not configured", sent: 0, evaluated: 0 };
  if (!isEntitled(profile)) return { skipped: "not entitled", sent: 0, evaluated: 0 };

  const { data: rules } = await sb
    .from("notification_rules")
    .select("*")
    .eq("user_id", userId)
    .eq("device_id", deviceId)
    .eq("enabled", true);
  if (!rules?.length) return { sent: 0, evaluated: 0, results: [] };

  const gap = await minutesSinceOnline(deviceId, snapshot);
  const cap = DAILY_CAP();
  const now = Date.now();
  const results = [];
  let sent = 0;

  for (const rule of rules) {
    const ctx = { minutesSinceOnline: gap, nowLocal };
    const ev = evaluateRule(rule, snapshot, ctx);
    if (!ev.fired) { results.push({ rule: rule.id, fired: false }); continue; }

    const channel = rule.channel || "email";

    // Per-rule cooldown — suppress repeat spam.
    if (rule.last_triggered_at) {
      const since = now - new Date(rule.last_triggered_at).getTime();
      if (since < (rule.cooldown_minutes || 60) * 60000) {
        results.push({ rule: rule.id, fired: true, skipped: "cooldown" });
        continue;
      }
    }

    // No channel configured → log 'skipped', do NOT stamp (retries once configured).
    if (!channelConfigured(channel)) {
      await logSend(sb, { userId, rule, deviceId, channel, status: "skipped", value: ev.value, detail: "channel not configured" });
      results.push({ rule: rule.id, fired: true, skipped: "no-channel" });
      continue;
    }

    // Daily cap (atomic). Over cap → suspend; send a single heads-up the first time.
    const count = await bumpQuota(sb, userId, cap);
    if (count != null && count > cap) {
      if (count === cap + 1) {
        await send({ channel, to: recipientEmail, message: buildCapMessage({ cap }) });
      }
      await logSend(sb, { userId, rule, deviceId, channel, status: "capped", value: ev.value, detail: `daily cap ${cap} reached` });
      results.push({ rule: rule.id, fired: true, skipped: "capped" });
      continue;
    }

    // Build + send.
    const desc = describeRule(rule, snapshot, ctx);
    const message = buildAlertMessage({
      siteName, deviceLabel, deviceId,
      title: desc.title, line: desc.line,
      whenLocal: snapshot.lastUpdateTime || nowLocal || "",
    });
    const r = await send({ channel, to: recipientEmail, message });

    if (r.ok) {
      await sb.from("notification_rules").update({ last_triggered_at: new Date().toISOString() }).eq("id", rule.id);
      await logSend(sb, { userId, rule, deviceId, channel, status: "sent", value: ev.value, detail: r.providerId || "" });
      sent++;
      results.push({ rule: rule.id, fired: true, sent: true });
    } else {
      // Failed (or skipped) → do NOT stamp last_triggered_at, so it retries next cycle.
      await logSend(sb, { userId, rule, deviceId, channel, status: r.skipped ? "skipped" : "failed", value: ev.value, detail: r.reason || "" });
      results.push({ rule: rule.id, fired: true, sent: false, reason: r.reason });
    }
  }
  return { sent, evaluated: rules.length, gap, results };
}

export {
  isEntitled, persistSnapshot, minutesSinceOnline, evaluateNotificationsForDevice,
  logSend, DAILY_CAP,
};
