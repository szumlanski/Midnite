// ─────────────────────────────────────────────────────────────────────────────
// Daily digest — pure data shaping + email rendering (no fetch, no DB, no env).
//
// Two halves, both pure so they're unit-testable and portable:
//   • compute*  — turn raw day/month API responses into a per-site digest model
//                 (yesterday's KPIs, an hourly production/consumption profile, a
//                 7-day comparative trend, battery SOC range, self-sufficiency).
//   • render*   — turn that model into an email-safe HTML message.
//
// Charts are built from HTML tables + fixed-pixel-height <div> bars (NOT SVG —
// Gmail strips inline SVG). This technique renders in Gmail, Apple Mail, Outlook
// web, and most mobile clients. Colors mirror the app's chart palette exactly.
// ─────────────────────────────────────────────────────────────────────────────

const BRAND = "Midnite Sentinel";

// Palette — identical to the in-app chart tokens (index.jsx).
const C = {
  bg: "#F7F4EF", card: "#FFFFFF", border: "#EAE4DC", text: "#1C1917",
  muted: "#78716C", faint: "#A8A29E",
  solar: "#D97706", prod: "#3B82F6", cons: "#F97316", bat: "#22C55E",
  batLine: "#16A34A", gridIn: "#DC2626", gridOut: "#059669", grid: "#94A3B8",
};

// PV production from a month/day rollup row. The endpoint's own "Production"
// field is unreliable (mode-795/AIO firmwares under-report it), so reconstruct
// from where PV energy physically goes — identical to rollupProduction() in
// index.jsx. NEVER trust r.Production here.
function rollupProduction(r) {
  return num(r.ConsumedDirectly) + num(r.powerToBattery) + num(r.powerToGrid);
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

// ── Aggregation (mirrors aggregateDayData / aggregateMonthData) ──────────────
// Day responses are per-inverter { Data:[{inTime,Production,Consumption,
// powerFromGrid,powerToGrid,SOC}] } in WATTS. Month responses are per-inverter
// { Data:[{day,Production,Consumption,powerFromGrid,powerToGrid,powerToBattery,
// powerFromBattery,ConsumedDirectly}] } in kWh.

function aggregateDay(dayResponses) {
  const map = {};
  for (const inv of dayResponses || []) {
    for (const r of (inv?.Data || [])) {
      const k = r.inTime;
      if (!map[k]) map[k] = { time: k, pv: 0, load: 0, gridImport: 0, gridExport: 0, soc: 0, socN: 0 };
      const row = map[k];
      row.pv += num(r.Production);
      row.load += num(r.Consumption);
      row.gridImport += num(r.powerFromGrid);
      row.gridExport += num(r.powerToGrid);
      const s = num(r.SOC); if (s > 0) { row.soc += s; row.socN += 1; }
    }
  }
  return Object.values(map)
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map(r => ({ ...r, soc: r.socN ? r.soc / r.socN : null }));
}

function aggregateMonth(monthResponses) {
  const map = {};
  for (const inv of monthResponses || []) {
    for (const r of (inv?.Data || [])) {
      const k = parseInt(r.day, 10);
      if (!Number.isFinite(k)) continue;
      if (!map[k]) map[k] = { day: k, production: 0, consumption: 0, fromGrid: 0, toGrid: 0, batCharge: 0, batDischarge: 0 };
      map[k].production += rollupProduction(r);
      map[k].consumption += num(r.Consumption);
      map[k].fromGrid += num(r.powerFromGrid);
      map[k].toGrid += num(r.powerToGrid);
      map[k].batCharge += num(r.powerToBattery);
      map[k].batDischarge += num(r.powerFromBattery);
    }
  }
  return map; // keyed by day-of-month
}

// Hour-of-day energy profile (kWh) from 5-min day intervals. Interval energy =
// power(W) × (intervalMinutes/60) ÷ 1000. inTime is "HH:MM".
function hourlyProfile(dayRows) {
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, prod: 0, cons: 0 }));
  // Estimate interval length from the data (usually 5 min); default 5.
  let stepMin = 5;
  if (dayRows.length >= 2) {
    const a = toMin(dayRows[0].time), b = toMin(dayRows[1].time);
    if (b > a && b - a <= 60) stepMin = b - a;
  }
  const f = stepMin / 60 / 1000; // W → kWh for one interval
  let peakPv = 0, peakTime = null, socMin = null, socMax = null, socEnd = null;
  for (const r of dayRows) {
    const h = Math.floor(toMin(r.time) / 60);
    if (h >= 0 && h < 24) { hours[h].prod += r.pv * f; hours[h].cons += r.load * f; }
    if (r.pv > peakPv) { peakPv = r.pv; peakTime = r.time; }
    if (r.soc != null) {
      socMin = socMin == null ? r.soc : Math.min(socMin, r.soc);
      socMax = socMax == null ? r.soc : Math.max(socMax, r.soc);
      socEnd = r.soc;
    }
  }
  return { hours, peakPv, peakTime, socMin, socMax, socEnd };
}
function toMin(t) { const [h, m] = String(t || "0:0").split(":").map(x => parseInt(x, 10) || 0); return h * 60 + m; }

// Build the full digest model for ONE site.
//   dateStr            — yesterday "YYYY-MM-DD" (in the digest timezone)
//   dayResponses       — per-inverter day responses for dateStr (WATTS)
//   monthResponses     — per-inverter month responses for dateStr's month (kWh)
//   prevMonthResponses — (optional) prior month, for 7-day windows near the 1st
export function computeSiteDigest({ siteName, dateStr, dayResponses, monthResponses, prevMonthResponses = [] }) {
  const [yy, mm, dd] = String(dateStr).split("-").map(n => parseInt(n, 10));
  const dayOfMonth = dd;
  const prevMonthDays = daysInMonth(mm === 1 ? yy - 1 : yy, mm === 1 ? 12 : mm - 1);
  const monthByDay = aggregateMonth(monthResponses);
  const prevMonthByDay = aggregateMonth(prevMonthResponses);

  const dayRows = aggregateDay(dayResponses);
  const prof = hourlyProfile(dayRows);

  // Yesterday's totals come from the MONTH rollup (so the digest matches the
  // app's Day/Month tabs exactly — see index.jsx "Day == Month" invariant).
  const y = monthByDay[dayOfMonth] || { production: 0, consumption: 0, fromGrid: 0, toGrid: 0, batCharge: 0, batDischarge: 0 };
  const consumed = y.consumption, imported = y.fromGrid;
  const directUse = Math.max(0, consumed - imported);

  // No-PV correction: rollupProduction (ConsumedDirectly + powerToBattery + powerToGrid)
  // can return phantom kWh on battery-only / no-PV sites because grid→battery charge flows
  // through powerToBattery and looks like solar output in the monthly accounting.
  // The intraday Production field is a direct PV measurement and is 0 on sites with no panels.
  // If we have intraday data and the peak PV reading was < 50 W all day, zero out the phantom.
  const hasRealPv = !dayRows.length || prof.peakPv >= 0.05;
  const produced = hasRealPv ? y.production : 0;
  const exported = hasRealPv ? y.toGrid : 0;

  // 7-day comparative trend (days D-6 … D), pulling from prior month when needed.
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const dn = dayOfMonth - i;
    let rec, dayLabel;
    if (dn >= 1) { rec = monthByDay[dn]; dayLabel = String(dn); }
    else { const pd = prevMonthDays + dn; rec = prevMonthByDay[pd]; dayLabel = String(pd); }
    week.push({ label: dayLabel, production: rec?.production || 0, consumption: rec?.consumption || 0, isYesterday: i === 0 });
  }

  // Comparisons — prior day, 7-day average.
  const prior = monthByDay[dayOfMonth - 1] || (dayOfMonth - 1 < 1 ? prevMonthByDay[prevMonthDays + dayOfMonth - 1] : null);
  const vsPriorDay = pctDelta(produced, prior?.production);
  const past = week.slice(0, 6).filter(d => d.production > 0);
  const weekAvg = past.length ? past.reduce((s, d) => s + d.production, 0) / past.length : null;
  const vsWeekAvg = pctDelta(produced, weekAvg);

  // 30-day average production (D-29 … D-1); requires prevMonthResponses to cover early-month windows.
  // Only meaningful when we have at least 10 prior days of data.
  const window30 = [];
  for (let i = 29; i >= 1; i--) {
    const dn = dayOfMonth - i;
    let rec;
    if (dn >= 1) rec = monthByDay[dn];
    else { const pd = prevMonthDays + dn; rec = prevMonthByDay[pd]; }
    if (rec && rec.production > 0) window30.push(rec);
  }
  const avg30 = window30.length >= 10 ? window30.reduce((s, d) => s + d.production, 0) / window30.length : null;
  const vs30DayAvg = pctDelta(produced, avg30);

  // Issue detection — surface actionable anomalies in the exec summary.
  // PV-related issues only fire on real solar sites (hasRealPv), not battery-only systems.
  const issues = [];
  if (hasRealPv) {
    if (produced < 0.5) {
      issues.push("zero_production");
    } else if (weekAvg && weekAvg > 2 && produced < weekAvg * 0.6) {
      issues.push("low_production");
    }
    const selfSuffCheck = consumed > 0 ? clamp((consumed - imported) / consumed * 100, 0, 100) : null;
    if (selfSuffCheck != null && selfSuffCheck < 30 && produced > 2) issues.push("high_import");
  }
  if (prof.socEnd != null && prof.socEnd < 15) issues.push("low_soc");

  return {
    siteName,
    hasRealPv,
    kpis: { produced, consumed, exported, imported, batCharge: y.batCharge, batDischarge: y.batDischarge, directUse,
            peakPv: prof.peakPv / 1000, peakTime: prof.peakTime,
            socMin: prof.socMin, socMax: prof.socMax, socEnd: prof.socEnd },
    hourly: prof.hours,
    week,
    compare: { vsPriorDay, vsWeekAvg, weekAvg, vs30DayAvg, avg30 },
    issues,
    hasIntraday: dayRows.length > 0,
  };
}

function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function pctDelta(cur, base) {
  if (base == null || base <= 0 || cur == null) return null;
  return (cur - base) / base * 100;
}

// ── Number / label formatting ────────────────────────────────────────────────
function kwh(x) { const v = num(x); return (v >= 100 ? Math.round(v) : v.toFixed(1)).toLocaleString?.() ?? String(v); }
function fmtKwh(x) { const v = num(x); return v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1); }
function fmtKw(x) { const v = num(x); return v.toFixed(1); }
function pct(x) { return x == null ? "—" : Math.round(x) + "%"; }

// ── Email-safe chart primitives (HTML tables + fixed-px bars) ────────────────

// Grouped vertical bar chart. cats=[{label}], series=[{name,color,data:[…]}].
// Bars are fixed-pixel-height divs (email-safe). `plotH` = plot area px height.
function vBarChart({ cats, series, plotH = 132, barW = 7, showEvery = 1, unit = "kWh" }) {
  let max = 0;
  for (const s of series) for (const v of s.data) if (v > max) max = v;
  if (max <= 0) max = 1;
  const hpx = (v) => (v > 0 ? Math.max(2, Math.round((v / max) * plotH)) : 0);

  const plotCells = cats.map((cat, i) => {
    const bars = series.map((s, si) => {
      const h = hpx(s.data[i] || 0);
      const bar = h > 0
        ? `<div style="width:${barW}px;height:${h}px;background:${s.color};border-radius:2px 2px 0 0;font-size:1px;line-height:1px;mso-line-height-rule:exactly">&nbsp;</div>`
        : `<div style="width:${barW}px;height:1px;background:${C.border};font-size:1px;line-height:1px">&nbsp;</div>`;
      return `<td valign="bottom" style="padding:0 1px">${bar}</td>`;
    }).join("");
    return `<td valign="bottom" align="center" style="height:${plotH}px"><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr>${bars}</tr></table></td>`;
  }).join("");

  const axisCells = cats.map((cat, i) =>
    `<td align="center" style="font-size:9px;color:${C.faint};padding-top:5px;font-family:Arial,sans-serif">${(i % showEvery === 0 || cat.always) ? cat.label : ""}</td>`
  ).join("");

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>${plotCells}</tr>
    <tr>${axisCells}</tr>
  </table>`;
}

function legend(items) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:10px auto 0"><tr>` +
    items.map(it => `<td style="padding:0 10px;font-size:11px;color:${C.muted};font-family:Arial,sans-serif"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${it.color};margin-right:5px"></span>${it.label}</td>`).join("") +
    `</tr></table>`;
}

// Horizontal progress bar (self-sufficiency, SOC range).
function hBar({ pct: p, color, track = "#EFEAE3", h = 12 }) {
  const w = Math.max(0, Math.min(100, p || 0));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${track};border-radius:${h / 2}px"><tr><td style="height:${h}px;width:${w}%;background:${color};border-radius:${h / 2}px;font-size:1px;line-height:1px">&nbsp;</td><td style="font-size:1px;line-height:1px">&nbsp;</td></tr></table>`;
}

function delta(d) {
  if (d == null) return `<span style="color:${C.faint}">—</span>`;
  const up = d >= 0;
  const col = up ? C.gridOut : C.gridIn;
  const arrow = up ? "▲" : "▼";
  return `<span style="color:${col};font-weight:700">${arrow} ${Math.abs(Math.round(d))}%</span>`;
}

// KPI tile grid (2 rows × 3) as a table.
function kpiGrid(k) {
  const tiles = [
    { label: "Produced", value: fmtKwh(k.produced), unit: "kWh", color: C.prod },
    { label: "Consumed", value: fmtKwh(k.consumed), unit: "kWh", color: C.cons },
    { label: "Exported", value: fmtKwh(k.exported), unit: "kWh", color: C.gridOut },
    { label: "Imported", value: fmtKwh(k.imported), unit: "kWh", color: C.gridIn },
    { label: "Peak PV", value: fmtKw(k.peakPv), unit: "kW", color: C.solar },
    { label: "Bat. charged", value: fmtKwh(k.batCharge), unit: "kWh", color: C.batLine },
  ];
  const cell = (t) => `<td width="33.33%" style="padding:6px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};border:1px solid ${C.border};border-radius:12px">
      <tr><td style="padding:12px 14px;text-align:center;font-family:Arial,sans-serif">
        <div style="font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${C.muted}">${t.label}</div>
        <div style="font-size:22px;font-weight:800;color:${t.color};margin-top:4px;line-height:1.1">${t.value}${t.unit ? `<span style="font-size:11px;font-weight:600;color:${C.faint}"> ${t.unit}</span>` : ""}</div>
      </td></tr>
    </table>
  </td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr>${tiles.slice(0, 3).map(cell).join("")}</tr>
    <tr>${tiles.slice(3, 6).map(cell).join("")}</tr>
  </table>`;
}

function sectionTitle(txt, sub) {
  return `<div style="font-size:13px;font-weight:800;color:${C.text};font-family:Arial,sans-serif;margin:4px 0 ${sub ? 2 : 12}px">${txt}</div>` +
    (sub ? `<div style="font-size:11px;color:${C.faint};font-family:Arial,sans-serif;margin-bottom:12px">${sub}</div>` : "");
}

// ── Executive summary: fleet-at-a-glance table + issues block ────────────────
// Shown at the very top of the email so key numbers are visible without scrolling.
function renderExecSummary(sites, totals, appUrl) {
  const APP = appUrl || "https://midnite-rose.vercel.app";
  const multi = sites.length > 1;
  const has30d = sites.some(s => s.compare.vs30DayAvg != null);

  // Inline style helpers (all inline — email clients strip <style> blocks).
  const TH = (a = "right", extra = "") =>
    `padding:8px 10px;text-align:${a};font-size:10px;font-weight:700;text-transform:uppercase;` +
    `letter-spacing:.05em;color:#92400E;font-family:Arial,sans-serif;white-space:nowrap;` +
    `border-bottom:1px solid #FDE68A;${extra}`;
  const TD = (a = "right", c = C.text, bold = false, extra = "") =>
    `padding:7px 10px;text-align:${a};font-size:12px;color:${c};font-weight:${bold ? 700 : 500};` +
    `font-family:Arial,sans-serif;font-variant-numeric:tabular-nums;white-space:nowrap;` +
    `border-top:1px solid ${C.border};${extra}`;

  // Issue descriptions (plain text — HTML will be applied by the caller).
  function issueMsg(iss, k, cmp) {
    switch (iss) {
      case "zero_production": return `No production recorded (${fmtKwh(k.produced)} kWh) — inverters may not have reported.`;
      case "low_production":  return `Low production — ${fmtKwh(k.produced)} kWh vs ${fmtKwh(cmp.weekAvg)} kWh 7-day avg (${Math.round(cmp.vsWeekAvg)}%).`;
      case "high_import":     return `High grid dependence — ${pct(k.selfSuff)} self-sufficient, drew ${fmtKwh(k.imported)} kWh from grid.`;
      case "low_soc":         return `Battery nearly drained — ended the day at ${Math.round(k.socEnd)}% SOC.`;
      default:                return iss;
    }
  }

  const allIssues = sites.flatMap(s => (s.issues || []).map(iss => ({ site: s.siteName, iss, kpis: s.kpis, compare: s.compare })));

  // Issue block (amber card below the table).
  const issueBlock = allIssues.length === 0 ? "" : `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#FFFBEB;border:1px solid #FDE68A;margin-bottom:18px">
      <tr><td style="padding:10px 14px;font-size:12px;font-weight:800;color:#92400E;font-family:Arial,sans-serif;border-bottom:1px solid #FDE68A">
        ⚠ Issues to Review
      </td></tr>
      ${allIssues.map(({ site, iss, kpis: k, compare: cmp }) => `
      <tr><td style="padding:6px 14px;font-family:Arial,sans-serif;border-top:1px solid #FDE68A">
        <span style="font-size:12px;font-weight:700;color:#92400E">${escapeHtml(site)}</span>
        <span style="font-size:12px;color:#78716C"> — ${escapeHtml(issueMsg(iss, k, cmp))}</span>
      </td></tr>`).join("")}
    </table>`;

  // Per-site data rows.
  const siteRows = sites.map((s, idx) => {
    const k = s.kpis, cmp = s.compare;
    const hasIss = (s.issues || []).length > 0;
    const rowBg = hasIss ? "#FFFBEB" : (idx % 2 === 0 ? "#fff" : "#FAFAF9");
    const socC = k.socEnd == null ? C.faint : k.socEnd < 15 ? C.gridIn : k.socEnd < 40 ? C.solar : C.batLine;
    const siteUrl = `${APP}/?site=${encodeURIComponent(s.siteName)}`;
    return `<tr style="background:${rowBg}">
      <td style="${TD("left", C.text, true)}"><a href="${siteUrl}" style="color:${C.text};text-decoration:none;font-weight:700">${escapeHtml(s.siteName)}</a></td>
      <td style="${TD("right", C.prod, true)}">${fmtKwh(k.produced)}</td>
      <td style="${TD("right", C.cons)}">${fmtKwh(k.consumed)}</td>
      <td style="${TD("right", C.gridOut)}">${fmtKwh(k.exported)}</td>
      <td style="${TD("right", C.gridIn)}">${fmtKwh(k.imported)}</td>
      <td style="${TD("right", socC)}">${k.socEnd != null ? Math.round(k.socEnd) + "%" : "—"}</td>
      <td style="${TD("right")}">${delta(cmp.vsWeekAvg)}</td>
      ${has30d ? `<td style="${TD("right")}">${delta(cmp.vs30DayAvg)}</td>` : ""}
      <td style="${TD("center", hasIss ? C.solar : C.faint, hasIss)}">${hasIss ? "⚠" : ""}</td>
    </tr>`;
  }).join("");

  // Fleet totals row (only when multiple sites).
  const totalsRow = !multi ? "" : `
    <tr style="background:${C.bg}">
      <td style="${TD("left", C.muted, true)}">Fleet total</td>
      <td style="${TD("right", C.prod, true)}">${fmtKwh(totals.produced)}</td>
      <td style="${TD("right", C.cons, true)}">${fmtKwh(totals.consumed)}</td>
      <td style="${TD("right", C.gridOut, true)}">${fmtKwh(totals.exported)}</td>
      <td style="${TD("right", C.gridIn, true)}">${fmtKwh(totals.imported)}</td>
      <td style="${TD("right", C.faint)}">—</td>
      <td style="${TD("right")}">—</td>
      ${has30d ? `<td style="${TD("right")}">—</td>` : ""}
      <td style="${TD("center")}"></td>
    </tr>`;

  const colCount = 8 + (has30d ? 1 : 0);

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${C.border};margin-bottom:16px">
      <tr style="background:linear-gradient(135deg,#FFFBEB,#FEF3C7)">
        <td colspan="${colCount}" style="padding:12px 14px;font-size:13px;font-weight:800;color:#92400E;font-family:Arial,sans-serif;border-bottom:1px solid #FDE68A">
          ☀ Yesterday at a Glance
        </td>
      </tr>
      <tr style="background:#FFFBEB">
        <th style="${TH("left")}">Site</th>
        <th style="${TH()}">PV (kWh)</th>
        <th style="${TH()}">Used</th>
        <th style="${TH()}">Exported</th>
        <th style="${TH()}">Imported</th>
        <th style="${TH()}">SOC end</th>
        <th style="${TH()}">Δ 7d avg</th>
        ${has30d ? `<th style="${TH()}">Δ 30d avg</th>` : ""}
        <th style="${TH("center")}"> </th>
      </tr>
      ${siteRows}
      ${totalsRow}
    </table>
    ${issueBlock}`;
}

// Render ONE site's section.
function renderSiteSection(d, multi, appUrl) {
  const k = d.kpis;
  // Intraday hourly chart (production vs consumption).
  const cats = d.hourly.map((h, i) => ({ label: h.h % 6 === 0 ? hourLabel(h.h) : "", always: false }));
  const intradayChart = d.hasIntraday ? `
    ${sectionTitle("Production through the day", "Hourly energy (kWh) — produced vs. consumed")}
    ${vBarChart({ cats, series: [
      { name: "Produced", color: C.prod, data: d.hourly.map(h => h.prod) },
      { name: "Consumed", color: C.cons, data: d.hourly.map(h => h.cons) },
    ], plotH: 130, barW: 6 })}
    ${legend([{ color: C.prod, label: "Produced" }, { color: C.cons, label: "Consumed" }])}
  ` : `<div style="font-size:12px;color:${C.faint};font-family:Arial,sans-serif;padding:8px 0">No intraday data available for this site.</div>`;

  // 7-day comparative trend.
  const weekCats = d.week.map(w => ({ label: w.label, always: true }));
  const weekChart = `
    ${sectionTitle("Last 7 days", "Daily production vs. consumption (kWh)")}
    ${vBarChart({ cats: weekCats, series: [
      { name: "Produced", color: C.prod, data: d.week.map(w => w.production) },
      { name: "Consumed", color: C.cons, data: d.week.map(w => w.consumption) },
    ], plotH: 110, barW: 12 })}
    ${legend([{ color: C.prod, label: "Produced" }, { color: C.cons, label: "Consumed" }])}
  `;

  // Battery strip.
  const socRange = (k.socMin != null && k.socMax != null)
    ? `${Math.round(k.socMin)}%–${Math.round(k.socMax)}%` : "—";
  const batStrip = `
    <div style="background:${C.bg};border:1px solid ${C.border};border-radius:12px;padding:14px;font-family:Arial,sans-serif;margin-top:6px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${C.muted};margin-bottom:8px">Battery</div>
      <div style="font-size:12px;color:${C.text};margin-bottom:8px">Range today <strong>${socRange}</strong>${k.socEnd != null ? ` · ended <strong>${Math.round(k.socEnd)}%</strong>` : ""}</div>
      ${hBar({ pct: k.socEnd != null ? k.socEnd : (k.socMax || 0), color: C.batLine })}
      <div style="font-size:11px;color:${C.muted};margin-top:8px">Charged ${fmtKwh(k.batCharge)} kWh · Discharged ${fmtKwh(k.batDischarge)} kWh</div>
    </div>`;

  // Comparison line.
  const cmp = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 4px">
      <tr>
        <td width="50%" style="padding:6px">
          <div style="background:#fff;border:1px solid ${C.border};border-radius:12px;padding:12px 14px;font-family:Arial,sans-serif;text-align:center">
            <div style="font-size:11px;color:${C.muted};margin-bottom:4px">vs. previous day</div>
            <div style="font-size:15px">${delta(d.compare.vsPriorDay)}</div>
          </div>
        </td>
        <td width="50%" style="padding:6px">
          <div style="background:#fff;border:1px solid ${C.border};border-radius:12px;padding:12px 14px;font-family:Arial,sans-serif;text-align:center">
            <div style="font-size:11px;color:${C.muted};margin-bottom:4px">vs. 7-day average${d.compare.weekAvg ? ` (${fmtKwh(d.compare.weekAvg)} kWh)` : ""}</div>
            <div style="font-size:15px">${delta(d.compare.vsWeekAvg)}</div>
          </div>
        </td>
      </tr>
    </table>`;

  const APP = appUrl || "https://midnite-rose.vercel.app";
  const siteUrl = `${APP}/?site=${encodeURIComponent(d.siteName)}`;
  const header = multi
    ? `<div style="font-family:Arial,sans-serif;margin:0 0 4px;display:flex;align-items:baseline;gap:10px">
        <a href="${siteUrl}" style="font-size:16px;font-weight:800;color:${C.text};text-decoration:none">${escapeHtml(d.siteName)}</a>
        <a href="${siteUrl}" style="font-size:11px;color:${C.solar};font-weight:700;text-decoration:none">Open ↗</a>
      </div>`
    : `<div style="font-family:Arial,sans-serif;margin:0 0 4px;text-align:right">
        <a href="${siteUrl}" style="font-size:11px;color:${C.solar};font-weight:700;text-decoration:none">Open this site ↗</a>
      </div>`;

  return `
    <div style="background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:20px 22px;margin-bottom:18px">
      ${header}
      ${kpiGrid(k)}
      ${cmp}
      <div style="height:8px"></div>
      ${intradayChart}
      <div style="height:18px"></div>
      ${weekChart}
      ${batStrip}
    </div>`;
}

function hourLabel(h) {
  if (h === 0) return "12a"; if (h === 12) return "12p";
  return h < 12 ? `${h}a` : `${h - 12}p`;
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ── Top-level email renderer ─────────────────────────────────────────────────
// model = { dateLabel, generatedLabel, sites:[siteDigest…], totals, appUrl }
export function renderDigestEmail({ dateLabel, generatedLabel, sites, totals, appUrl }) {
  const APP = appUrl || "https://midnite-rose.vercel.app";
  const multi = sites.length > 1;

  // Exec summary is always first — it IS the executive brief the user reads immediately.
  const execSummary = renderExecSummary(sites, totals, APP);

  // Divider + "Full Report" label separates exec summary from per-site detail.
  const divider = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px">
      <tr><td height="2" style="font-size:1px;line-height:1px;background:${C.border}">&nbsp;</td></tr>
      <tr><td style="padding:10px 0;text-align:center;font-size:10px;font-weight:700;color:${C.faint};text-transform:uppercase;letter-spacing:.1em;font-family:Arial,sans-serif">Full Site Details</td></tr>
      <tr><td height="2" style="font-size:1px;line-height:1px;background:${C.border}">&nbsp;</td></tr>
    </table>`;

  const body = sites.map(s => renderSiteSection(s, multi, APP)).join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"></head>
  <body style="margin:0;background:${C.bg};padding:0;-webkit-text-size-adjust:100%">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}">
      <tr><td align="center" style="padding:24px 12px">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%">
          <!-- Header -->
          <tr><td style="background:linear-gradient(135deg,#FFFBEB,#FEF3C7);border:1px solid #FDE68A;border-radius:18px;padding:22px 24px">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="font-family:Arial,sans-serif">
                <div style="font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#92400E">${BRAND}</div>
                <div style="font-size:24px;font-weight:800;color:${C.solar};margin-top:4px">☀ Daily Solar Recap</div>
                <div style="font-size:13px;color:#92400E;margin-top:4px">${escapeHtml(dateLabel)}</div>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="height:18px"></td></tr>
          <!-- Body -->
          <tr><td>
            ${execSummary}
            ${divider}
            ${body}
          </td></tr>
          <!-- CTA -->
          <tr><td align="center" style="padding:6px 0 18px">
            <a href="${APP}" style="display:inline-block;padding:13px 28px;background:${C.solar};color:#fff;border-radius:12px;font-size:14px;font-weight:700;text-decoration:none;font-family:Arial,sans-serif">Open dashboard</a>
          </td></tr>
          <!-- Footer -->
          <tr><td style="padding:14px 22px;border-top:1px solid ${C.border};font-size:11px;color:${C.faint};font-family:Arial,sans-serif;line-height:1.6">
            You're receiving this because you turned on the daily digest in ${BRAND}.
            Change the time or turn it off in <strong>Settings → Notifications</strong>.${generatedLabel ? `<br/>Generated ${escapeHtml(generatedLabel)}.` : ""}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body></html>`;

  const subject = multi
    ? `☀ Fleet solar recap — ${dateLabel} · ${fmtKwh(totals.produced)} kWh produced`
    : `☀ Your solar recap — ${dateLabel} · ${fmtKwh(sites[0]?.kpis.produced || 0)} kWh produced`;

  const text = renderDigestText({ dateLabel, sites, totals, multi, APP });
  return { subject, html, text };
}

function renderDigestText({ dateLabel, sites, totals, multi, APP }) {
  const lines = [`${BRAND} — Daily Solar Recap`, dateLabel, ""];

  // Exec summary (plain-text table).
  const colW = [22, 8, 8, 8, 8, 7, 7, 7];
  const hdrs = ["Site", "PV kWh", "Used", "Exp", "Imp", "SOC", "Δ7d", "Δ30d"];
  const pad = (s, w, r = false) => r ? String(s).padStart(w) : String(s).padEnd(w);
  lines.push(hdrs.map((h, i) => pad(h, colW[i], i > 0)).join("  "));
  lines.push(colW.map(w => "-".repeat(w)).join("  "));
  for (const s of sites) {
    const k = s.kpis, cmp = s.compare;
    const d7 = cmp.vsWeekAvg == null ? "—" : (cmp.vsWeekAvg >= 0 ? "+" : "") + Math.round(cmp.vsWeekAvg) + "%";
    const d30 = cmp.vs30DayAvg == null ? "—" : (cmp.vs30DayAvg >= 0 ? "+" : "") + Math.round(cmp.vs30DayAvg) + "%";
    lines.push([
      pad(s.siteName.slice(0, 21), colW[0]),
      pad(fmtKwh(k.produced), colW[1], true),
      pad(fmtKwh(k.consumed), colW[2], true),
      pad(fmtKwh(k.exported), colW[3], true),
      pad(fmtKwh(k.imported), colW[4], true),
      pad(k.socEnd != null ? Math.round(k.socEnd) + "%" : "—", colW[5], true),
      pad(d7, colW[6], true),
      pad(d30, colW[7], true),
    ].join("  "));
  }
  if (multi) {
    lines.push(colW.map(w => "-".repeat(w)).join("  "));
    lines.push([
      pad("FLEET TOTAL", colW[0]),
      pad(fmtKwh(totals.produced), colW[1], true),
      pad(fmtKwh(totals.consumed), colW[2], true),
      pad(fmtKwh(totals.exported), colW[3], true),
      pad(fmtKwh(totals.imported), colW[4], true),
      pad("—", colW[5], true),
      pad("—", colW[6], true),
      pad("—", colW[7], true),
    ].join("  "));
  }
  lines.push("");

  // Issues.
  const allIssues = sites.flatMap(s => (s.issues || []).map(iss => ({ site: s.siteName, iss, kpis: s.kpis, compare: s.compare })));
  if (allIssues.length) {
    lines.push("ISSUES TO REVIEW:");
    for (const { site, iss, kpis: k, compare: cmp } of allIssues) {
      let msg;
      switch (iss) {
        case "zero_production": msg = `No production recorded (${fmtKwh(k.produced)} kWh)`; break;
        case "low_production":  msg = `Low production — ${fmtKwh(k.produced)} vs ${fmtKwh(cmp.weekAvg)} kWh 7d avg`; break;
        case "high_import":     msg = `High grid import — ${pct(k.selfSuff)} self-sufficient`; break;
        case "low_soc":         msg = `Battery nearly drained — ended at ${Math.round(k.socEnd)}% SOC`; break;
        default:                msg = iss;
      }
      lines.push(`  • ${site}: ${msg}`);
    }
    lines.push("");
  }

  // Per-site detail.
  lines.push("--- SITE DETAILS ---", "");
  for (const s of sites) {
    const k = s.kpis;
    if (multi) lines.push(`— ${s.siteName} —`, `  ${APP}/?site=${encodeURIComponent(s.siteName)}`);
    lines.push(
      `Produced: ${fmtKwh(k.produced)} kWh   Consumed: ${fmtKwh(k.consumed)} kWh`,
      `Exported: ${fmtKwh(k.exported)} kWh   Imported: ${fmtKwh(k.imported)} kWh`,
      `Peak PV: ${fmtKw(k.peakPv)} kW${k.peakTime ? ` at ${k.peakTime}` : ""}`,
      `Battery: charged ${fmtKwh(k.batCharge)} kWh, discharged ${fmtKwh(k.batDischarge)} kWh${k.socEnd != null ? `, ended ${Math.round(k.socEnd)}%` : ""}`,
      `vs prior day: ${s.compare.vsPriorDay == null ? "—" : Math.round(s.compare.vsPriorDay) + "%"}   vs 7d avg: ${s.compare.vsWeekAvg == null ? "—" : Math.round(s.compare.vsWeekAvg) + "%"}   vs 30d avg: ${s.compare.vs30DayAvg == null ? "—" : Math.round(s.compare.vs30DayAvg) + "%"}`,
      ""
    );
  }
  lines.push(`Open ${BRAND}: ${APP}`, "", "Change the time or turn off this digest in Settings → Notifications.");
  return lines.join("\n");
}

// Sum site KPIs into fleet totals.
export function sumTotals(sites) {
  const t = { produced: 0, consumed: 0, exported: 0, imported: 0 };
  for (const s of sites) { t.produced += s.kpis.produced; t.consumed += s.kpis.consumed; t.exported += s.kpis.exported; t.imported += s.kpis.imported; }
  return t;
}
