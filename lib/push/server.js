// ─────────────────────────────────────────────────────────────────────────────
// Web Push, server side (port of eg4-monitor lib/comm-hub/push.ts). Server only.
//
// VAPID keys: env VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY (optional VAPID_SUBJECT) win when both are
// set. Otherwise the pair lives in public.vapid_keys (single row, id = 1), generated on first use.
// The pair must NEVER change: every subscription is bound to the public key it was made with.
// Concurrent first calls are safe: the second insert hits the primary key and re-reads the winner.
//
// Dead subscriptions: a push service answers 404 or 410 when the browser is gone for good. Those
// rows are deleted. Anything else only bumps failure_count (a phone that is off keeps its row).
// Nothing here throws to the caller: a push problem must never break the tick cron or an action.
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "../midniteServer.js";

const DEFAULT_SUBJECT = "mailto:alerts@midnite-sentinel.app";
let _cached = null;

// For tests only.
export function _resetVapidCache() { _cached = null; }

async function loadWebPush(deps) {
  if (deps?.webpush) return deps.webpush;
  return await import("web-push"); // lazy: keeps it out of any client bundle
}

// { publicKey, privateKey, subject }
export async function getVapidKeys(deps = {}) {
  if (_cached) return _cached;
  const env = deps.env || process.env;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    _cached = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || DEFAULT_SUBJECT };
    return _cached;
  }
  const sb = deps.sb || supabaseAdmin();
  if (!sb) throw new Error("Supabase not configured");
  const shape = (r) => ({ publicKey: r.public_key, privateKey: r.private_key, subject: r.subject || DEFAULT_SUBJECT });

  const { data: row, error } = await sb.from("vapid_keys").select("public_key,private_key,subject").eq("id", 1).maybeSingle();
  if (error) throw new Error(error.message);
  if (row) return (_cached = shape(row));

  const wp = await loadWebPush(deps);
  const gen = wp.generateVAPIDKeys();
  // Plain insert (never upsert): if another caller won the race, this conflicts and we re-read theirs.
  const { data: ins } = await sb.from("vapid_keys")
    .insert({ id: 1, public_key: gen.publicKey, private_key: gen.privateKey, subject: DEFAULT_SUBJECT })
    .select("public_key,private_key,subject").maybeSingle();
  if (ins) return (_cached = shape(ins));
  const { data: winner, error: e2 } = await sb.from("vapid_keys").select("public_key,private_key,subject").eq("id", 1).single();
  if (e2 || !winner) throw new Error(e2?.message || "could not read VAPID keys");
  return (_cached = shape(winner));
}

export async function getVapidPublicKey(deps = {}) {
  return (await getVapidKeys(deps)).publicKey;
}

// One device. Returns 'sent' | 'gone' | 'failed'. Never throws.
export async function pushToSubscription(sub, msg, deps = {}) {
  const sb = deps.sb || supabaseAdmin();
  try {
    const keys = await getVapidKeys(deps);
    const wp = await loadWebPush(deps);
    wp.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
    await wp.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || "/", tag: msg.tag || undefined }),
      { TTL: 3600 },
    );
    try { await sb.from("push_subscriptions").update({ last_used_at: new Date().toISOString(), failure_count: 0 }).eq("id", sub.id); } catch { /* ignore */ }
    return "sent";
  } catch (e) {
    const status = e?.statusCode;
    try {
      if (status === 404 || status === 410) {
        await sb.from("push_subscriptions").delete().eq("id", sub.id);
        return "gone";
      }
      await sb.from("push_subscriptions").update({ failure_count: (Number(sub.failure_count) || 0) + 1 }).eq("id", sub.id);
    } catch { /* ignore */ }
    if (!(status === 404 || status === 410)) console.log("[push] send failed", status || "", e?.message || e);
    return "failed";
  }
}

// Every device of one user. Returns { sent, gone, failed, total }. Never throws.
export async function pushToUser(userId, msg, deps = {}) {
  const out = { sent: 0, gone: 0, failed: 0, total: 0 };
  try {
    const sb = deps.sb || supabaseAdmin();
    const { data, error } = await sb.from("push_subscriptions").select("id,endpoint,p256dh,auth,failure_count").eq("user_id", userId);
    if (error) { console.log("[push] subscription lookup failed", error.message); return out; }
    const subs = data || [];
    out.total = subs.length;
    const results = await Promise.all(subs.map(s => pushToSubscription(s, msg, { ...deps, sb })));
    for (const r of results) out[r]++;
  } catch (e) { console.log("[push] pushToUser failed", e?.message || e); }
  return out;
}

// Validate a browser PushSubscription JSON ({endpoint, keys:{p256dh, auth}}).
// Returns { endpoint, p256dh, auth } or null.
export function parseSubscription(sub) {
  const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint.trim() : "";
  const p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 2048) return null;
  if (typeof p256dh !== "string" || !p256dh || typeof auth !== "string" || !auth) return null;
  return { endpoint, p256dh, auth };
}
