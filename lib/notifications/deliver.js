// ─────────────────────────────────────────────────────────────────────────────
// Delivery — a thin send() wrapper over the configured channel(s).
//
// Today: email via Resend (chosen for the no-SDK HTTP API). The channel is kept
// abstracted (send({channel,...})) so SMS/push can be added later without
// touching the engine. If the provider env vars are missing, send() NO-OPS
// SAFELY (returns {ok:false, skipped:true}) — it never throws and never blocks
// the heartbeat — so the rest of the system is testable before a key is set.
//
// Env:
//   RESEND_API_KEY     — Resend API key (https://resend.com). If unset → no-op.
//   ALERTS_FROM_EMAIL  — From address, e.g. "Midnite Sentinel <alerts@yourdomain>".
//                        Defaults to Resend's onboarding sender for first-run tests.
//   NEXT_PUBLIC_APP_URL / app URL — used for the "Open dashboard" link.
// ─────────────────────────────────────────────────────────────────────────────

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://midnite-rose.vercel.app";
const BRAND = "Midnite Sentinel";
const AMBER = "#D97706";

export function channelConfigured(channel = "email") {
  if (channel === "email") return !!process.env.RESEND_API_KEY;
  return false; // sms/push not wired yet
}

function fromAddress() {
  return process.env.ALERTS_FROM_EMAIL || "Midnite Sentinel <onboarding@resend.dev>";
}

async function sendEmail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, skipped: true, reason: "RESEND_API_KEY not set" };
  if (!to) return { ok: false, skipped: true, reason: "no recipient email" };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromAddress(), to: [to], subject, html, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, skipped: false, reason: body?.message || `Resend ${res.status}`, providerId: null };
    return { ok: true, skipped: false, providerId: body?.id || null };
  } catch (e) {
    return { ok: false, skipped: false, reason: e.message };
  }
}

// Channel-agnostic entry point. Returns { ok, skipped, reason?, providerId? }.
// `skipped:true` means "no channel configured" (not an error → caller may retry
// later once configured, and must NOT stamp last_triggered_at).
export async function send({ channel = "email", to, message }) {
  if (channel === "email") return sendEmail({ to, subject: message.subject, html: message.html, text: message.text });
  return { ok: false, skipped: true, reason: `channel ${channel} not configured` };
}

// ── Branded message builders ────────────────────────────────────────────────
function shell(title, lines, accent = AMBER) {
  const body = lines.map((l) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.5;color:#1C1917">${l}</p>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#F7F4EF;padding:24px;font-family:'Plus Jakarta Sans',system-ui,-apple-system,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #EAE4DC;border-radius:16px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#FFFBEB,#FEF3C7);padding:18px 22px;border-bottom:1px solid #FDE68A">
      <div style="font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#92400E">${BRAND}</div>
      <div style="font-size:19px;font-weight:800;color:${accent};margin-top:4px">${title}</div>
    </div>
    <div style="padding:20px 22px">${body}
      <a href="${APP_URL}" style="display:inline-block;margin-top:8px;padding:10px 18px;background:${accent};color:#fff;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none">Open dashboard</a>
    </div>
    <div style="padding:12px 22px;border-top:1px solid #EAE4DC;font-size:11px;color:#A8A29E">
      You're receiving this because you set up an alert in ${BRAND}. Manage or turn off alerts in Settings → Notifications.
    </div>
  </div></body></html>`;
}

// Build the message for a fired rule.
//   info = { siteName, deviceLabel, deviceId, title, line, whenLocal }
export function buildAlertMessage(info) {
  const where = [info.siteName, info.deviceLabel].filter(Boolean).join(" · ");
  const subject = `⚠ ${where ? where + " — " : ""}${info.title}`;
  const lines = [
    `<strong>${info.title}</strong>`,
    info.line || "",
    `<span style="color:#78716C">Device:</span> ${info.deviceLabel || ""} <span style="color:#A8A29E">(${info.deviceId})</span>`,
    info.siteName ? `<span style="color:#78716C">Site:</span> ${info.siteName}` : "",
    info.whenLocal ? `<span style="color:#78716C">As of:</span> ${info.whenLocal}` : "",
  ].filter(Boolean);
  const text = `${info.title}\n${info.line || ""}\nDevice: ${info.deviceLabel || ""} (${info.deviceId})` +
    (info.siteName ? `\nSite: ${info.siteName}` : "") + (info.whenLocal ? `\nAs of: ${info.whenLocal}` : "") +
    `\n\nOpen ${BRAND}: ${APP_URL}`;
  return { subject, html: shell(info.title, lines), text };
}

// Daily-cap "limit reached" heads-up (sent once per user per day).
export function buildCapMessage({ cap }) {
  const title = "Daily alert limit reached";
  const lines = [
    `You've reached your daily limit of <strong>${cap}</strong> alert emails.`,
    `Further alerts are paused until tomorrow so your inbox doesn't get flooded. Your rules are still active and evaluating — only the emails are paused.`,
    `If you're seeing a lot of alerts, consider raising thresholds or cooldowns in Settings → Notifications.`,
  ];
  const text = `${title}\nYou've reached your daily limit of ${cap} alert emails. Further alerts are paused until tomorrow.\nOpen ${BRAND}: ${APP_URL}`;
  return { subject: `${BRAND} — ${title}`, html: shell(title, lines), text };
}

// Test-send message (verifies delivery end-to-end).
export function buildTestMessage({ siteName, deviceLabel, deviceId, ruleSummary }) {
  const title = "Test alert";
  const lines = [
    `This is a <strong>test</strong> from ${BRAND} — your notification delivery is working. ✅`,
    ruleSummary ? `Rule: <strong>${ruleSummary}</strong>` : "",
    `Device: ${deviceLabel || ""} <span style="color:#A8A29E">(${deviceId})</span>`,
    siteName ? `Site: ${siteName}` : "",
  ].filter(Boolean);
  const text = `${title}\nThis is a test from ${BRAND} — delivery is working.` +
    (ruleSummary ? `\nRule: ${ruleSummary}` : "") + `\nDevice: ${deviceLabel || ""} (${deviceId})` +
    (siteName ? `\nSite: ${siteName}` : "") + `\nOpen ${BRAND}: ${APP_URL}`;
  return { subject: `${BRAND} — ${title}${deviceLabel ? " · " + deviceLabel : ""}`, html: shell(title, lines, "#16A34A"), text };
}
