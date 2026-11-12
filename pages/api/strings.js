// ─────────────────────────────────────────────────────────────────────────────
// Strings (MPPT) API. POST /api/strings?action=X, Supabase JWT (Authorization: Bearer) like generator.js.
// body.site_key = the site's inverter serials, sorted and joined with "," (siteKeyOf).
//
// Access (canAccessSite): an own linked account holds the site, OR an active site_shares row, OR admin.
// Share recipients may rename strings and set sizes (Jason's decision). Labels are per inverter SERIAL
// and MPPT number (1-3), never by INV-N. Every save adds a gen_events row (action string_label_change).
// Read-only on the Midnite side: the only Midnite call is the day CSV export (backfill).
//
//   get       { site_key }                     labels + inverters (INV order) + MPPTs seen active
//   save      { site_key, sn, mppt, label, kw_dc }
//   energy    { site_key, from, to }           daily rows + per-string totals, per day/month, flags
//   backfill  { site_key, days }               admin only, <= 60 days per call, skips stored days
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin, getSaasUser } from "@/lib/midniteServer";
import { siteKeyOf, localParts } from "@/lib/generator/core";
import { httpErr, logEvent } from "@/lib/generator/server";
import { summarizeEnergy, validateLabel, dateRange, strKey } from "@/lib/strings/energy";
import {
  canAccessSite, loadLabels, fetchAllRows, everActiveSet, storedDays, collectDay, runPool, stringsDbCheck,
} from "@/lib/strings/server";

export const config = { maxDuration: 60 };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function requireSiteKey(body) {
  const k = String(body?.site_key || "");
  if (!k || siteKeyOf(k.split(",")) !== k) throw httpErr(400, "site_key must be the site's inverter serials, sorted and joined with ','");
  return k;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const t0 = Date.now();
  const action = req.query.action;
  const body = req.body || {};
  try {
    const { user, role: appRole } = await getSaasUser(req);
    const sb = supabaseAdmin();
    const site_key = requireSiteKey(body);
    const serials = site_key.split(",");
    const ctx = await canAccessSite(sb, user, appRole, site_key, { accountId: body.accountId || null });

    switch (action) {
      case "get": {
        const labels = await loadLabels(sb, site_key);
        // MPPTs seen producing in the last 14 days (cheap: from mppt_daily, no Midnite call).
        const recent = await fetchAllRows(() => sb.from("mppt_daily").select("sn,mppt").in("sn", serials)
          .gte("day", new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10)).gt("kwh", 0).order("day"));
        const active = {};
        for (const r of recent) { (active[r.sn] ||= new Set()).add(Number(r.mppt)); }
        const order = ctx.site?.GoodsID?.map((g) => g.GoodsID).filter((sn) => serials.includes(sn)) || serials;
        const inverters = order.map((sn, i) => ({ sn, label: `INV-${i + 1}`, active: [...(active[sn] || [])].sort() }));
        return res.json({ labels, inverters, role: ctx.role });
      }

      case "save": {
        const sn = String(body.sn || "");
        const mppt = Number(body.mppt);
        if (!serials.includes(sn)) return res.status(400).json({ error: `${sn || "sn"} is not one of this site's inverters.` });
        if (![1, 2, 3].includes(mppt)) return res.status(400).json({ error: "mppt must be 1, 2 or 3" });
        const v = validateLabel(body);
        if (v.error) return res.status(400).json({ error: v.error });
        const { data: before, error: e1 } = await sb.from("site_mppt_labels").select("label,kw_dc").eq("site_key", site_key).eq("sn", sn).eq("mppt", mppt).maybeSingle();
        stringsDbCheck(e1);
        let saved = null;
        if (!v.label && v.kw_dc == null) {
          const { error } = await sb.from("site_mppt_labels").delete().eq("site_key", site_key).eq("sn", sn).eq("mppt", mppt);
          stringsDbCheck(error);
        } else {
          const { data, error } = await sb.from("site_mppt_labels").upsert(
            { site_key, sn, mppt, label: v.label, kw_dc: v.kw_dc, updated_by: user.id, updated_at: new Date().toISOString() },
            { onConflict: "site_key,sn,mppt" }).select("sn,mppt,label,kw_dc,updated_at").single();
          stringsDbCheck(error);
          saved = data;
        }
        const { data: prof } = await sb.from("profiles").select("display_name").eq("id", user.id).maybeSingle();
        const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim() || null;
        const actor = { id: user.id, email: user.email || null, name: prof?.display_name || user.email || null, role: ctx.role,
          client: { ip, device: String(req.headers["user-agent"] || "").slice(0, 200) || null } };
        await logEvent(sb, site_key, actor, "string_label_change", {
          before: { sn, mppt, label: before?.label ?? null, kw_dc: before?.kw_dc ?? null },
          after: { sn, mppt, label: v.label, kw_dc: v.kw_dc },
        });
        return res.json({ ok: true, label: saved, labels: await loadLabels(sb, site_key) });
      }

      case "energy": {
        const from = String(body.from || ""), to = String(body.to || "");
        if (!YMD.test(from) || !YMD.test(to) || from > to) return res.status(400).json({ error: "from and to must be YYYY-MM-DD, from <= to" });
        if (dateRange(from, to, 400).length > 366) return res.status(400).json({ error: "Range can be at most 366 days." });
        const [rows, labels] = await Promise.all([
          fetchAllRows(() => sb.from("mppt_daily").select("sn,day,mppt,kwh,peak_w,peak_v,samples,inverter_etoday")
            .in("sn", serials).gte("day", from).lte("day", to).order("day").order("sn").order("mppt")),
          loadLabels(sb, site_key),
        ]);
        const sizes = Object.fromEntries(labels.filter((l) => Number(l.kw_dc) > 0).map((l) => [strKey(l.sn, l.mppt), Number(l.kw_dc)]));
        // Underperformance always looks at the 7 days ending at the range end, even for a short range.
        const flagFrom = new Date(new Date(`${to}T12:00:00Z`).getTime() - 6 * 86400000).toISOString().slice(0, 10);
        const flagRows = flagFrom >= from ? rows : await fetchAllRows(() => sb.from("mppt_daily").select("sn,day,mppt,kwh")
          .in("sn", serials).gte("day", flagFrom).lte("day", to).order("day"));
        const summary = summarizeEnergy(rows, { sizes });
        summary.flags = summarizeEnergy(flagRows.filter((r) => String(r.day) >= flagFrom), { sizes }).flags;
        return res.json({ from, to, rows, labels, ...summary });
      }

      case "backfill": {
        if (appRole !== "admin") return res.status(403).json({ error: "Backfill is admin only." });
        if (!ctx.auth || !ctx.site) return res.status(409).json({ error: "Can't reach this site's Midnite account (switch to the account that holds it)." });
        const days = Math.min(60, Math.max(1, Math.round(Number(body.days) || 30)));
        const tz = "America/New_York";
        const todayLocal = localParts(new Date(), tz).ymd;
        const to = new Date(new Date(`${todayLocal}T12:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
        const from = new Date(new Date(`${to}T12:00:00Z`).getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
        const have = await storedDays(sb, serials, from, to);
        const everActive = await everActiveSet(sb, serials);
        const memberId = ctx.site.MemberID;
        const jobs = [];
        for (const day of dateRange(from, to).reverse()) for (const sn of serials) {
          if (have.has(`${sn}|${day}`)) continue;
          jobs.push({ sn, day, run: () => collectDay({ sb, memberId, sn, day, siteKey: site_key, everActive }) });
        }
        const { results, skipped } = await runPool(jobs, { concurrency: 4, deadline: t0 + 45000 });
        const stored = results.filter((r) => r.ok && r.value.stored > 0).length;
        const empty = results.filter((r) => r.ok && r.value.stored === 0).length;
        const failed = results.filter((r) => !r.ok).map((r) => ({ sn: r.job.sn, day: r.job.day, error: r.error }));
        return res.json({ ok: true, from, to, alreadyStored: have.size, stored, empty, failed, remaining: skipped.length });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    const code = Number.isInteger(e.code) && e.code >= 400 && e.code < 600 ? e.code : 500;
    if (code >= 500) console.error("[strings]", action, e);
    return res.status(code).json({ error: e.message || "Server error" });
  }
}
