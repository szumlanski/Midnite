// Fake /api/strings responses for the screenshot harness (no DB, no network).
// Wise Naples: 4 inverters x 2 active MPPTs, every string sized, some named; INV-3 MPPT 2 runs ~25% low
// (shading) so the underperformer flag shows. Other sites have no string data yet (empty state).

import { summarizeEnergy, dateRange, strKey } from "../../lib/strings/energy.js";

const WISE = ["2426-90191014PH", "2426-90191051PH", "2426-90191086PH", "2426-90191087PH"];
const WISE_KEY = [...WISE].sort().join(",");
const LABELS = [
  { sn: WISE[0], mppt: 1, label: "South roof", kw_dc: 6.4 },
  { sn: WISE[0], mppt: 2, label: "West roof", kw_dc: 4.8 },
  { sn: WISE[1], mppt: 1, label: "Garage", kw_dc: 5.6 },
  { sn: WISE[1], mppt: 2, label: null, kw_dc: 5.6 },
  { sn: WISE[2], mppt: 1, label: "Pool house", kw_dc: 6.0 },
  { sn: WISE[2], mppt: 2, label: "Pool house east", kw_dc: 4.0 },
  { sn: WISE[3], mppt: 1, label: null, kw_dc: 6.0 },
  { sn: WISE[3], mppt: 2, label: null, kw_dc: 5.2 },
].map((l) => ({ ...l, updated_at: "2026-11-10T14:00:00Z" }));
const SIZE = Object.fromEntries(LABELS.map((l) => [strKey(l.sn, l.mppt), l.kw_dc]));

// Deterministic "weather": 3.2 to 4.8 kWh/kW per day.
const sunOf = (day) => { const n = Number(day.replace(/-/g, "")); return 3.2 + ((n * 7919) % 17) / 10; };
function rows(from, to) {
  const out = [];
  const last = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  for (const day of dateRange(from, to < last ? to : last)) {
    for (const sn of WISE) {
      let et = 0;
      const day_rows = [1, 2].map((m) => {
        const k = strKey(sn, m);
        const shade = sn === WISE[2] && m === 2 ? 0.74 : 1;
        const kwh = Math.round(SIZE[k] * sunOf(day) * shade * 1000) / 1000;
        et += kwh;
        return { sn, day, mppt: m, kwh, peak_w: Math.round(SIZE[k] * 820 * shade), peak_v: 410, samples: 140 };
      });
      for (const r of day_rows) out.push({ ...r, inverter_etoday: Math.round(et * 1.02 * 10) / 10 });
    }
  }
  return out;
}

/** { status, body } for POST /api/strings?action=<action>. */
export function stringsRespond(action, body = {}) {
  const key = String(body?.site_key || "");
  const wise = key === WISE_KEY;
  switch (action) {
    case "get":
      return { status: 200, body: { role: "admin", labels: wise ? LABELS : [], inverters: key.split(",").map((sn, i) => ({ sn, label: `INV-${i + 1}`, active: wise ? [1, 2] : [] })) } };
    case "save": return { status: 200, body: { ok: true, labels: wise ? LABELS : [] } };
    case "energy": {
      const r = wise ? rows(body.from, body.to) : [];
      const s = summarizeEnergy(r, { sizes: SIZE });
      return { status: 200, body: { from: body.from, to: body.to, rows: r, labels: wise ? LABELS : [], ...s } };
    }
    case "backfill": return { status: 200, body: { ok: true, stored: 0, empty: 0, failed: [], remaining: 0 } };
    default: return { status: 400, body: { error: `Unknown action: ${action}` } };
  }
}
