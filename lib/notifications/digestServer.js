// ─────────────────────────────────────────────────────────────────────────────
// Daily-digest orchestration — the impure layer (fetch + DB + send) that wraps
// the pure model/renderer in ./digest.js. Shared by:
//   • pages/api/notifications/digest.js  (the hourly cron)
//   • pages/api/midnite.js  digest_test   (Send test digest from Settings)
//
// buildAndSendDigest() does: login → enumerate sites → fetch yesterday's day +
// month data per inverter → compute per-site models → render → send one email.
// It NEVER throws to the caller for per-site fetch failures (those sites are just
// skipped); only a hard login/credential failure propagates.
// ─────────────────────────────────────────────────────────────────────────────

import { decryptCred, loginCached, fetchSites, fetchDay, fetchMonth } from "@/lib/midniteServer";
import { computeSiteDigest, renderDigestEmail, sumTotals } from "@/lib/notifications/digest";
import { send, channelConfigured } from "@/lib/notifications/deliver";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://midnite-rose.vercel.app";
const MAX_SITES = 12; // cap a fleet digest so the email stays reasonable

// "YYYY-MM-DD" for a Date in a given IANA timezone.
function ymdInTz(date, tz) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day}`;
}
function hourInTz(date, tz) {
  return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(date).replace(/\D/g, ""), 10);
}
// Yesterday's date string in tz (the day the digest reports on).
export function yesterdayInTz(tz, now = new Date()) {
  const todayYmd = ymdInTz(now, tz);
  const [y, m, d] = todayYmd.split("-").map(Number);
  const prev = new Date(Date.UTC(y, m - 1, d) - 86400000);
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
}
export { ymdInTz, hourInTz };

function prevMonthYm(ym) {
  let [y, m] = ym.split("-").map(Number);
  m -= 1; if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function prettyDate(dateStr, tz) {
  const [y, m, d] = dateStr.split("-").map(Number);
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric" })
      .format(new Date(Date.UTC(y, m - 1, d, 12)));
  } catch { return dateStr; }
}

// Build the rendered email model for an account. Returns { message, sites, totals,
// dateStr } or { empty:true } if no site produced any data.
export async function buildDigest({ auth, dateStr, tz, siteFilter = null }) {
  const ym = dateStr.slice(0, 7);
  const pym = prevMonthYm(ym);
  const nearStart = parseInt(dateStr.slice(8, 10), 10) <= 7;

  let sites = await fetchSites(auth);
  if (siteFilter) sites = sites.filter(s => s.name === siteFilter);
  sites = sites.filter(s => s.serials.length > 0).slice(0, MAX_SITES);

  const models = [];
  for (const site of sites) {
    try {
      const [dayResponses, monthResponses, prevMonthResponses] = await Promise.all([
        Promise.all(site.serials.map(sn => fetchDay(auth, sn, dateStr).catch(() => null))),
        Promise.all(site.serials.map(sn => fetchMonth(auth, sn, ym).catch(() => null))),
        nearStart ? Promise.all(site.serials.map(sn => fetchMonth(auth, sn, pym).catch(() => null))) : Promise.resolve([]),
      ]);
      const model = computeSiteDigest({ siteName: site.name, dateStr, dayResponses, monthResponses, prevMonthResponses });
      // Skip dead sites (no production AND no consumption AND no intraday).
      if (model.kpis.produced > 0 || model.kpis.consumed > 0 || model.hasIntraday) models.push(model);
    } catch (e) { /* skip this site */ }
  }

  if (!models.length) return { empty: true, dateStr };

  const totals = sumTotals(models);
  const message = renderDigestEmail({
    dateLabel: prettyDate(dateStr, tz),
    generatedLabel: null,
    sites: models, totals, appUrl: APP_URL,
  });
  return { message, sites: models, totals, dateStr };
}

// Full path used by the cron + the test action: resolve creds → build → send.
//   acct = { midnite_username, enc_password }
// Returns { ok, skipped?, empty?, reason?, sites?, to }.
export async function buildAndSendDigest({ acct, to, tz = "America/New_York", siteFilter = null, dateStr = null, force = false }) {
  if (!channelConfigured("email")) return { ok: false, skipped: true, reason: "email not configured" };
  if (!to) return { ok: false, skipped: true, reason: "no recipient email" };
  if (!acct) return { ok: false, skipped: true, reason: "no linked account" };

  let auth;
  try { auth = await loginCached(acct.midnite_username, decryptCred(acct.enc_password)); }
  catch (e) { return { ok: false, skipped: false, reason: "login: " + e.message }; }

  const ds = dateStr || yesterdayInTz(tz);
  const built = await buildDigest({ auth, dateStr: ds, tz, siteFilter });
  if (built.empty) {
    if (!force) return { ok: false, empty: true, reason: "no data for " + ds, to };
    // Force (test) with no data still confirms delivery with a friendly note.
  }
  if (built.empty && force) {
    const note = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#F7F4EF;padding:24px">
      <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #EAE4DC;border-radius:16px;padding:24px">
        <div style="font-size:18px;font-weight:800;color:#D97706">☀ Daily Solar Recap — test</div>
        <p style="font-size:14px;color:#1C1917;line-height:1.6">Delivery is working ✅ — but there's no production data yet for <strong>${ds}</strong> on this account (the inverters may not have reported, or it's a brand-new link). Your real digest will populate once daily data is available.</p>
        <a href="${APP_URL}" style="display:inline-block;margin-top:8px;padding:10px 18px;background:#D97706;color:#fff;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none">Open dashboard</a>
      </div></body></html>`;
    const r = await send({ channel: "email", to, message: { subject: "☀ Midnite Sentinel — digest test (no data yet)", html: note, text: `Digest delivery is working, but no data yet for ${ds}.` } });
    return { ...r, empty: true, to };
  }

  const r = await send({ channel: "email", to, message: built.message });
  return { ...r, to, sites: built.sites?.length || 0, dateStr: ds };
}
