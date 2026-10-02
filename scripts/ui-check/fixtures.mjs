// Fake /api/midnite responses for the headless screenshot harness (scripts/ui-check/shots.mjs).
//
// respond(action, body) returns the JSON the real proxy (pages/api/midnite.js) would return for
// that action, shaped exactly the way pages/index.jsx reads it. Nothing here touches the network.
//
// Data model (all made up):
//   - Admin user jason@example.com ("Jason"), one linked installer account.
//   - Fleet of 3 sites: "Wise Naples" (4 x MN 15-12KW-AIO, all online, ~9 kW PV, 72% SOC charging,
//     exporting ~1.2 kW), "Bochan" (2 inverters, INV-2 offline and 25 min stale), "OffTheHook"
//     (1 inverter, open-loop battery at 18% SOC, importing).
//   - A deterministic per-site day simulation (5-min steps) drives day, month, year and dayexcel, so
//     Day totals == Month rollup for the same date (the app's Day==Month invariant holds).
// Dates are computed at runtime. "Today" for history cutoffs is the UTC date, because the app's own
// `today` constant is new Date().toISOString() (UTC). Report times (DataTime / lastUpdateTime /
// SystemTime) are America/New_York wall-clock "YYYY-MM-DD HH:MM:SS", like the real API.

export const ACCOUNT_ID = "6f1c2a9e-0b7d-4c1e-9a55-3d2f8e7b1c01";
export const USER = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "jason@example.com",
  displayName: "Jason",
};

const TZ = "America/New_York";
const p2 = (n) => String(n).padStart(2, "0");
const r0 = (n) => Math.round(n);
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const sum = (a, f = (x) => x) => a.reduce((s, x) => s + f(x), 0);

/** America/New_York wall-clock "YYYY-MM-DD HH:MM:SS", optionally offset by minutes. */
export function etWall(offsetMin = 0, roundSec = 1) {
  let ms = Date.now() + offsetMin * 60000;
  if (roundSec > 1) ms = Math.floor(ms / (roundSec * 1000)) * roundSec * 1000;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const utcToday = () => new Date().toISOString().slice(0, 10);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const isoAgo = (min) => new Date(Date.now() - min * 60000).toISOString();

// Deterministic pseudo-random in [0, 1) from a string (FNV-1a + a murmur-style finalizer).
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
const gauss = (x, mu, s) => Math.exp(-0.5 * ((x - mu) / s) ** 2);

// ── Fleet model ───────────────────────────────────────────────────────────────────────────────────
// `now` holds site totals for the 5-min status / live flow snapshot (W): grid is +import / -export,
// home is the house load. Battery net is derived (pv + grid - home), as the app itself does.
const SITES = [
  {
    name: "Wise Naples", memberAutoId: "48120", model: "MN 15-12KW-AIO", aio: true, source: "rich",
    statusCounts: [4, 0, 0, 0],
    inverters: [
      { sn: "2426-90191014PH", autoId: "70114", w: 0.26 },
      { sn: "2426-90191051PH", autoId: "70151", w: 0.25 },
      { sn: "2426-90191086PH", autoId: "70186", w: 0.25 },
      { sn: "2426-90191087PH", autoId: "70187", w: 0.24 },
    ],
    sim: { pvPeakW: 12000, loadScale: 1.0, capKwh: 80.4, chargeCapW: 6600, dischargeCapW: 7000, socStart: 49, socFloor: 40, socCeil: 95 },
    now: { pv: 9000, grid: -1200, home: 2400, soc: 72 },
    battery: { brand: "MidNite Battery", capacityAh: 1570, soh: 98, tempC: 27, bmsFWVer: "1.4.2" },
    life: { pv: 18420, exp: 6210, imp: 2140, load: 13880, chg: 5120, dis: 4790 }, // site kWh
  },
  {
    name: "Bochan", memberAutoId: "51377", model: "MN 15-12KW-AIO", aio: true, source: "detail",
    statusCounts: [1, 0, 1, 0],
    inverters: [
      { sn: "2431-90274411PH", autoId: null, w: 0.55 },
      { sn: "2431-90274412PH", autoId: null, w: 0.45, offline: true, staleMin: 25 },
    ],
    sim: { pvPeakW: 8000, loadScale: 0.6, capKwh: 32.2, chargeCapW: 3000, dischargeCapW: 5000, socStart: 58, socFloor: 30, socCeil: 100 },
    now: { pv: 3100, grid: -500, home: 1600, soc: 64 },
    battery: { brand: "MidNite Battery", capacityAh: 628, soh: 99, tempC: 26, bmsFWVer: "1.3.9" },
    life: { pv: 9120, exp: 2105, imp: 1830, load: 7420, chg: 3120, dis: 2988 },
  },
  {
    name: "OffTheHook", memberAutoId: "39904", model: "MN 15-12KW-AIO", aio: false, source: "rich",
    statusCounts: [1, 0, 0, 0],
    inverters: [{ sn: "2508-90330077PH", autoId: "61398", w: 1 }],
    sim: { pvPeakW: 4600, loadScale: 1.1, capKwh: 15.4, chargeCapW: 2500, dischargeCapW: 4000, socStart: 24, socFloor: 15, socCeil: 100 },
    now: { pv: 1200, grid: 1700, home: 2800, soc: 18 },
    battery: { brand: "", capacityAh: 300, soh: 0, tempC: 0, bmsFWVer: "" }, // open loop (no BMS)
    life: { pv: 4210, exp: 310, imp: 6120, load: 9870, chg: 1540, dis: 1390 },
  },
];

const BY_SN = new Map();
SITES.forEach((site) => site.inverters.forEach((inv, idx) => BY_SN.set(inv.sn, { site, inv, idx })));

// ── Day simulation (site totals, W, 288 x 5-min) ──────────────────────────────────────────────────
// PV is a seasonal bell curve (today is always clear-sky; other days get a deterministic cloud
// factor). House load = base + morning / afternoon-A/C / evening bumps. The battery absorbs PV
// surplus up to chargeCapW until socCeil, then the rest is exported; at night it discharges down to
// socFloor, then the grid covers the rest. Energy identities hold per step:
//   pv = direct + charge + export,   load = direct + discharge + import.
const SEASON = [0.78, 0.86, 0.96, 1.04, 1.07, 1.0, 0.97, 0.97, 0.93, 0.9, 0.82, 0.76];
const SNAPSHOT_MIN = 13 * 60 + 30; // energy-today counters are integrated up to 13:30 (a midday snapshot)
const SIM_CACHE = new Map();
function simDay(site, dateStr) {
  const key = `${site.name}|${dateStr}`;
  if (SIM_CACHE.has(key)) return SIM_CACHE.get(key);
  const month = Number(dateStr.slice(5, 7)) || 1;
  const isToday = dateStr === utcToday();
  const cloud = isToday ? 1 : 0.55 + 0.45 * hash01(site.name + dateStr);
  const s = site.sim;
  const peak = s.pvPeakW * SEASON[month - 1] * cloud;
  const sigma = 120 + 30 * SEASON[month - 1];
  const dt = 5 / 60;
  let soc = s.socStart + (hash01(`soc${site.name}${dateStr}`) - 0.5) * 6;
  const rows = [];
  for (let i = 0; i < 288; i++) {
    const min = i * 5;
    const bell = gauss(min, 790, sigma);
    let pv = bell < 0.012 ? 0 : peak * bell;
    if (!isToday && cloud < 0.85) pv *= 1 - 0.35 * hash01(`${site.name}${dateStr}c${i}`) * (1 - cloud);
    const noise = 1 + (hash01(`${site.name}${dateStr}l${i}`) - 0.5) * 0.16;
    const load = s.loadScale * noise * (850 + 1100 * gauss(min, 465, 40) + 700 * gauss(min, 900, 170) + 1700 * gauss(min, 1170, 75));
    const direct = Math.min(pv, load);
    const surplus = pv - direct, deficit = load - direct;
    const roomW = Math.max(0, ((s.socCeil - soc) / 100) * s.capKwh * 1000 / dt);
    const availW = Math.max(0, ((soc - s.socFloor) / 100) * s.capKwh * 1000 / dt);
    const charge = Math.min(surplus, s.chargeCapW, roomW);
    const exp = surplus - charge;
    const dis = Math.min(deficit, s.dischargeCapW, availW);
    const imp = deficit - dis;
    soc += ((charge - dis) * dt / 1000 / s.capKwh) * 100;
    rows.push({ min, pv, load, direct, charge, exp, dis, imp, soc });
  }
  const kwh = (k, upTo = 1440) => sum(rows.filter((r) => r.min < upTo), (r) => r[k]) * dt / 1000;
  const out = {
    rows,
    totals: { pv: kwh("pv"), load: kwh("load"), direct: kwh("direct"), charge: kwh("charge"), exp: kwh("exp"), dis: kwh("dis"), imp: kwh("imp") },
    snapshot: { pv: kwh("pv", SNAPSHOT_MIN), load: kwh("load", SNAPSHOT_MIN), charge: kwh("charge", SNAPSHOT_MIN), exp: kwh("exp", SNAPSHOT_MIN), dis: kwh("dis", SNAPSHOT_MIN), imp: kwh("imp", SNAPSHOT_MIN) },
    peakW: Math.max(...rows.filter((r) => r.min < SNAPSHOT_MIN).map((r) => r.pv)),
  };
  SIM_CACHE.set(key, out);
  return out;
}

// Site "now" split across ONLINE inverters by weight. Offline inverters report zero power.
function invNow(site, inv) {
  if (inv.offline) return { pv: 0, grid: 0, home: 0, bat: 0 };
  const online = site.inverters.filter((i) => !i.offline);
  const f = inv.w / sum(online, (i) => i.w);
  const pv = site.now.pv * f, grid = site.now.grid * f, home = site.now.home * f;
  return { pv, grid, home, bat: pv + grid - home };
}
function energyToday(site, inv) { // kWh, this inverter's share, integrated to the midday snapshot
  const s = simDay(site, utcToday());
  const o = {}; for (const [k, v] of Object.entries(s.snapshot)) o[k] = v * inv.w;
  o.peakW = s.peakW * inv.w;
  return o;
}

// ── Normalizers, copied verbatim from pages/api/midnite.js (keep in sync) ─────────────────────────
function normalizeRich(raw) {
  if (!raw?.data) return null;
  const d = raw.data;
  const gridNetW = (d.grid?.lines||[]).reduce((s,l)=>s+((l.current||0)<0?-1:1)*(l.power||0),0);
  return {
    inverter: {
      online: d.inverter?.online ?? true,
      model: d.inverter?.model || "",
      sn: d.inverter?.sn || "",
      temperature: d.inverter?.temperature || 0,
      lastUpdateTime: d.inverter?.lastUpdateTime || "",
      selfConsumptionPercent: d.inverter?.selfConsumptionPercent ?? null,
      selfSufficiencyPercent: d.inverter?.selfSufficiencyPercent ?? null,
      state: d.inverter?.state ?? null,
      workMode: d.inverter?.workMode ?? null,
      wifiSignal: d.inverter?.wifi?.mdb ?? null,
      dspVer: d.inverter?.dspVer || "",
      slaveDspVer: d.inverter?.slaveDspVer || "",
      csbVer: d.inverter?.csbVer || "",
    },
    photovoltaic: {
      mppts: d.photovoltaic?.mppts || [],
      power: d.photovoltaic?.power || { totalDc:0, peak:0 },
      production: d.photovoltaic?.production || { today:0, total:0 },
    },
    grid: {
      lines: d.grid?.lines || [],
      netW: gridNetW,
      sold: d.grid?.sold || { today:0, total:0 },
      consumption: d.grid?.consumption || { today:0, total:0 },
    },
    load: {
      lines: d.load?.lines || [],
      power: d.load?.power || { today:0, total:0 },
    },
    battery: {
      brand: d.battery?.brand || "",
      capacityAh: parseFloat(d.battery?.capacity || 0),
      voltage: d.battery?.voltage || 0,
      current: d.battery?.current || 0,
      charge: d.battery?.charge || 0,
      discharge: d.battery?.discharge || 0,
      soc: d.battery?.soc || 0,
      healthPercent: d.battery?.healthPercent || 0,
      temperature: d.battery?.temperature || 0,
      chargeIn: d.battery?.chargeIn || { today:0, total:0 },
      dischargeOut: d.battery?.dischargeOut || { today:0, total:0 },
      bmsStatus: d.battery?.bmsStatus || "",
      bmsFWVer: d.battery?.bmsFWVer || "",
    },
    smartPorts: {
      A: d.smartPortA || null,
      B: d.smartPortB || null,
      C: d.smartPortC || null,
    },
    gen: d.gen || null,
  };
}
function normalizeDetail(raw, sn) {
  if(!raw || raw.GoodsID === undefined) return null;
  const pvW = parseFloat(raw.TotalDCpower || 0);
  const loadPacRaw = raw.loadCurrpac;
  const epsPacRaw = raw.epsCurrpac;
  const loadSum = (parseFloat(loadPacRaw?.[0]||0) + parseFloat(loadPacRaw?.[1]||0) + parseFloat(loadPacRaw?.[2]||0));
  const epsSum  = (parseFloat(epsPacRaw?.[0]||0)  + parseFloat(epsPacRaw?.[1]||0));
  const useEPS  = loadSum === 0 && epsSum > 0;
  const loadPac = useEPS ? epsPacRaw : loadPacRaw;
  const loadVac = useEPS ? raw.epsVac : raw.loadVac;
  const loadIac = useEPS ? raw.epsIac : raw.loadIac;
  const loadEnergyDay   = useEPS ? parseFloat(raw.EPSDay   || 0) : parseFloat(raw.ELDay   || 0);
  const loadEnergyTotal = useEPS ? parseFloat(raw.EPSTotal || 0) : parseFloat(raw.ELTotal || 0);
  const gridNetW = (parseFloat(raw.gridCurrpac?.[0] || 0) + parseFloat(raw.gridCurrpac?.[1] || 0) + parseFloat(raw.gridCurrpac?.[2] || 0));
  const batChargeW = parseFloat(raw.toPbat || 0);
  const batDischargeW = parseFloat(raw.fromPbat || 0);
  return {
    inverter: {
      online: true,
      model: raw.modelName || "",
      sn: raw.GoodsID,
      temperature: parseFloat(raw.Tntc || 0),
      lastUpdateTime: raw.DataTime || "",
    },
    photovoltaic: {
      power: { totalDc: pvW, peak: parseFloat(raw.Peackpower || 0) },
      production: {
        today: parseFloat(raw.EToday || 0) * 1000,
        total: parseFloat(raw.ETotal || 0) * 1000,
      },
    },
    grid: {
      lines: [
        { power: Math.abs(parseFloat(raw.gridCurrpac?.[0] || 0)), voltage: parseFloat(raw.gridVac?.[0] || 0), current: parseFloat(raw.gridIac?.[0] || 0), frequency: parseFloat(raw.gridFac || 0) },
        { power: Math.abs(parseFloat(raw.gridCurrpac?.[1] || 0)), voltage: parseFloat(raw.gridVac?.[1] || 0), current: parseFloat(raw.gridIac?.[1] || 0), frequency: parseFloat(raw.gridFac || 0) },
      ],
      netW: gridNetW,
      sold: { today: parseFloat(raw.ETDay || 0) * 1000, total: parseFloat(raw.ETTotal || 0) * 1000 },
      consumption: { today: parseFloat(raw.EFDay || 0) * 1000, total: parseFloat(raw.EFTotal || 0) * 1000 },
    },
    load: {
      lines: [
        { power: parseFloat(loadPac?.[0] || 0), voltage: parseFloat(loadVac?.[0] || 0), current: parseFloat(loadIac?.[0] || 0) },
        { power: parseFloat(loadPac?.[1] || 0), voltage: parseFloat(loadVac?.[1] || 0), current: parseFloat(loadIac?.[1] || 0) },
      ],
      power: { today: loadEnergyDay * 1000, total: loadEnergyTotal * 1000 },
    },
    battery: {
      brand: raw.brand || "",
      capacityAh: parseFloat(raw.capacity || 0) + parseFloat(raw.capacity2 || 0),
      voltage: parseFloat(raw.volt || 0),
      current: parseFloat(raw.cur || 0),
      charge: batChargeW,
      discharge: batDischargeW,
      soc: parseFloat(raw.SOC || 0),
      healthPercent: parseFloat(raw.SOH || 0),
      temperature: parseFloat(raw.BMS_temp || 0),
      chargeIn: { total: parseFloat(raw.Etotal_batChrg || 0) * 1000 },
      dischargeOut: { total: parseFloat(raw.Etotal_batDischrg || 0) * 1000 },
    },
  };
}

// ── Raw vendor payloads (pre-normalization) ───────────────────────────────────────────────────────
const VLEG = [121.4, 120.8];
const batVolts = (site) => (site.battery.capacityAh ? 51.0 + site.now.soc * 0.035 : 0);

// getInverterStatus (Eagle): the "rich" shape, used when the inverter has an AutoID.
function richRaw(site, inv, idx) {
  const n = invNow(site, inv);
  const e = energyToday(site, inv);
  const mppts = [0.42, 0.36, 0.22].map((share, k) => {
    const p = n.pv * share; const v = p > 0 ? 372 - k * 9 + idx * 2 : 0;
    return { voltage: r1(v), current: v ? r2(p / v) : 0, power: r0(p) };
  });
  const legs = (w) => VLEG.map((v) => ({ power: r0(Math.abs(w / 2)), voltage: v, current: r2(w / 2 / v), frequency: 60.01 }));
  const bv = batVolts(site);
  const life = (k) => site.life[k] * inv.w;
  const houseLegs = VLEG.map((v) => ({ power: r0(n.home / 2), voltage: v, current: r2(n.home / 2 / v) }));
  return {
    status: true,
    data: {
      inverter: {
        online: !inv.offline, model: site.model, sn: inv.sn, temperature: r1(39 + idx * 1.5 + n.pv / 1000),
        lastUpdateTime: etWall(-(inv.staleMin || 0)), selfConsumptionPercent: site.now.grid < 0 ? 81 : 100,
        selfSufficiencyPercent: site.now.grid < 0 ? 94 : 39, state: 3, workMode: 0, wifi: { mdb: -58 - idx * 3 },
        dspVer: "V1.32", slaveDspVer: "V1.18", csbVer: "V2.07",
      },
      photovoltaic: {
        mppts,
        power: { totalDc: r0(n.pv), peak: r0(e.peakW) },
        production: { today: r0(e.pv * 1000), total: r0((life("pv") + e.pv) * 1000) },
      },
      grid: {
        lines: legs(n.grid),
        sold: { today: r0(e.exp * 1000), total: r0((life("exp") + e.exp) * 1000) },
        consumption: { today: r0(e.imp * 1000), total: r0((life("imp") + e.imp) * 1000) },
      },
      load: {
        // AIO units serve the house through a smart/EPS port, so the Normal Load port reads 0 W.
        lines: site.aio ? VLEG.map((v) => ({ power: 0, voltage: v, current: 0, frequency: 60.0 })) : houseLegs.map((l) => ({ ...l, frequency: 60.0 })),
        power: { today: r0(e.load * 1000), total: r0((life("load") + e.load) * 1000) },
      },
      battery: {
        brand: site.battery.brand, capacity: String(site.battery.capacityAh), voltage: r1(bv),
        current: bv ? r1(n.bat / bv) : 0, charge: r0(Math.max(0, n.bat)), discharge: r0(Math.max(0, -n.bat)),
        soc: site.now.soc, healthPercent: site.battery.soh, temperature: site.battery.tempC,
        chargeIn: { today: r0(e.charge * 1000), total: r0((life("chg") + e.charge) * 1000) },
        dischargeOut: { today: r0(e.dis * 1000), total: r0((life("dis") + e.dis) * 1000) },
        bmsStatus: site.battery.brand ? "Normal" : "", bmsFWVer: site.battery.bmsFWVer,
      },
      smartPortA: site.aio ? { lines: houseLegs, power: { today: r0(e.load * 1000), total: r0(life("load") * 1000) } } : null,
      smartPortB: null,
      smartPortC: null,
      gen: null,
    },
  };
}

// InverterDetailInfoNewone (Senergytec): the fallback shape, used when there is no AutoID.
function detailRaw(site, inv, idx) {
  const n = invNow(site, inv);
  const e = energyToday(site, inv);
  const bv = batVolts(site);
  const life = (k) => site.life[k] * inv.w;
  const half = (w) => String(r0(w / 2));
  const amps = (w, v) => String(r2(w / 2 / v));
  return {
    GoodsID: inv.sn, modelName: site.model, Tntc: String(r1(36 + idx * 2 + n.pv / 1000)),
    DataTime: etWall(-(inv.staleMin || 0)),
    TotalDCpower: String(r0(n.pv)), Peackpower: String(r0(e.peakW)),
    EToday: String(r2(e.pv)), ETotal: String(r2(life("pv") + e.pv)),
    loadCurrpac: ["0", "0", "0"], loadVac: VLEG.map(String), loadIac: ["0", "0"],
    epsCurrpac: site.aio ? [half(n.home), half(n.home)] : ["0", "0"],
    epsVac: VLEG.map(String), epsIac: site.aio ? [amps(n.home, VLEG[0]), amps(n.home, VLEG[1])] : ["0", "0"],
    ELDay: "0", ELTotal: "0", EPSDay: String(r2(e.load)), EPSTotal: String(r2(life("load") + e.load)),
    gridCurrpac: [half(n.grid), half(n.grid), "0"], gridVac: VLEG.map(String),
    gridIac: [amps(n.grid, VLEG[0]), amps(n.grid, VLEG[1])], gridFac: "60.00",
    ETDay: String(r2(e.exp)), ETTotal: String(r2(life("exp") + e.exp)),
    EFDay: String(r2(e.imp)), EFTotal: String(r2(life("imp") + e.imp)),
    toPbat: String(r0(Math.max(0, n.bat))), fromPbat: String(r0(Math.max(0, -n.bat))),
    brand: site.battery.brand, capacity: String(site.battery.capacityAh), capacity2: "",
    volt: String(r1(bv)), cur: String(bv ? r1(n.bat / bv) : 0), SOC: String(site.now.soc),
    SOH: String(site.battery.soh), BMS_temp: String(site.battery.tempC),
    Etotal_batChrg: String(r2(life("chg"))), Etotal_batDischrg: String(r2(life("dis"))),
  };
}

function statusFor(sn) {
  const hit = BY_SN.get(sn);
  if (!hit) return { sn, ok: false, data: null, error: "No data returned" };
  const { site, inv, idx } = hit;
  if (site.source === "rich" && inv.autoId) {
    const data = normalizeRich(richRaw(site, inv, idx));
    return { sn, ok: !!data, data, source: "rich", error: data ? null : "No data" };
  }
  const data = normalizeDetail(detailRaw(site, inv, idx), sn);
  return { sn, ok: !!data, data, error: data ? null : "No data returned" };
}

// getHybridFlowgraphRealTimeData (live ~5s feed). SystemTime ticks on a 5 s cadence so the app's
// LIVE chip sees a genuinely advancing sample on every poll. Values wobble slightly with time.
function flowSample(sn) {
  const hit = BY_SN.get(sn);
  if (!hit) return null;
  const { site, inv, idx } = hit;
  if (inv.offline) {
    return { online: false, pv: 0, grid: 0, load: 0, eps: 0, gen: 0, battery: 0, soc: 0, time: etWall(-(inv.staleMin || 0)) };
  }
  const n = invNow(site, inv);
  const t = Date.now() / 1000;
  const pv = r0(n.pv * (1 + 0.015 * Math.sin(t / 7 + idx)));
  const home = r0(n.home * (1 + 0.02 * Math.cos(t / 11 + idx)));
  const grid = r0(n.grid);
  return {
    online: true, pv, grid, load: site.aio ? 0 : home, eps: site.aio ? home : 0, gen: 0,
    battery: pv + grid - home, soc: site.now.soc, time: etWall(0, 5),
  };
}

// ── History endpoints ─────────────────────────────────────────────────────────────────────────────
function dayResp(sn, date) {
  const hit = BY_SN.get(sn);
  if (!hit || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { Data: [] };
  const { site, inv } = hit;
  const w = inv.w;
  return {
    Data: simDay(site, date).rows.map((r) => ({
      inTime: `${p2(Math.floor(r.min / 60))}:${p2(r.min % 60)}`, // "HH:MM" (as lib/notifications/digest.js documents)
      Production: r0(r.pv * w), Consumption: r0(r.load * w),
      powerFromGrid: r0(r.imp * w), powerToGrid: r0(r.exp * w),
      powerToBattery: r0(r.charge * w), powerFromBattery: r0(r.dis * w),
      ConsumedDirectly: r0(r.direct * w), SOC: r0(r.soc),
    })),
  };
}
// One rollup row (kWh). Production deliberately mimics the broken firmware field (too low); the
// app must reconstruct PV as ConsumedDirectly + powerToBattery + powerToGrid.
function rollupRow(t, w) {
  return {
    Production: r2(t.pv * w * 0.55), Consumption: r2(t.load * w),
    powerFromGrid: r2(t.imp * w), powerToGrid: r2(t.exp * w),
    ConsumedDirectly: r2(t.direct * w), powerToBattery: r2(t.charge * w), powerFromBattery: r2(t.dis * w),
  };
}
const ZERO_T = { pv: 0, load: 0, imp: 0, exp: 0, direct: 0, charge: 0, dis: 0 };
function addT(a, b) { const o = {}; for (const k of Object.keys(ZERO_T)) o[k] = (a[k] || 0) + (b[k] || 0); return o; }
function lastDayWithData(y, m) {
  const [ty, tm, td] = utcToday().split("-").map(Number);
  if (y > ty || (y === ty && m > tm)) return 0;
  if (y === ty && m === tm) return td;
  return daysInMonth(y, m);
}
function monthTotals(site, y, m) {
  const out = [];
  for (let d = 1; d <= lastDayWithData(y, m); d++) out.push({ d, t: simDay(site, `${y}-${p2(m)}-${p2(d)}`).totals });
  return out;
}
function monthResp(sn, date) {
  const hit = BY_SN.get(sn);
  const [y, m] = String(date || "").split("-").map(Number);
  if (!hit || !y || !m) return { Data: [] };
  return { Data: monthTotals(hit.site, y, m).map(({ d, t }) => ({ day: d, ...rollupRow(t, hit.inv.w) })) };
}
function yearResp(sn, date) {
  const hit = BY_SN.get(sn);
  const y = Number(String(date || "").slice(0, 4)) || new Date().getUTCFullYear();
  if (!hit) return { Data: [] };
  const Data = [];
  for (let m = 1; m <= 12; m++) { // 12 rows; months after today come back as zeros
    const t = monthTotals(hit.site, y, m).reduce((acc, x) => addT(acc, x.t), ZERO_T);
    Data.push({ month: m, ...rollupRow(t, hit.inv.w) });
  }
  return { Data };
}

// ── dayexcel (per-inverter 5-min CSV export, as parsed by the proxy) ─────────────────────────────
const CSV_HEADER = ["Time", "MPPT1", "MPPT2", "MPPT3", "PV", "Temperature", "E-Today", "E-Total", "H-Total", "Grid1", "Normal Load1", "Gen Port1", "AC OUT(100A)1", "Smart LoadB(50A)1", "Smart LoadC(30A)1", "Grid2", "Normal Load2", "Gen Port2", "AC OUT(100A)2", "Smart LoadB(50A)2", "Smart LoadC(30A)2", "GridFac", "LoadFac", "GenFac", "Feed-In Energy Today", "Purchased Energy Today", "Consumption Today", "Total Feed-In Energy", "Total Purchased Energy", "Total Consumption", "Capacity", "BMS_Version", "SOC", "SOH", "BatteryTemp", "Battery Current", "Battery Voltage", "Battery Power", "Daily charge energy", "Daily discharge energy", "Total charge energy", "Total discharge energy", "smartLoadDay", "smartLoadTotal", "Outputs Energy Today", "Outputs Energy Total"];
const PORTS = [
  ["mppt1","MPPT1"],["mppt2","MPPT2"],["mppt3","MPPT3"],
  ["gridL1","Grid L1"],["gridL2","Grid L2"],
  ["loadL1","Load L1"],["loadL2","Load L2"],
  ["acOut1","AC Out L1"],["acOut2","AC Out L2"],
  ["smartB1","Smart Load B L1"],["smartB2","Smart Load B L2"],
  ["smartC1","Smart Load C L1"],["smartC2","Smart Load C L2"],
  ["genL1","Gen L1"],["genL2","Gen L2"],
  ["bat","Battery"],
];
const METRIC_DEFS = [ // copied from the proxy's dayexcel case
  {key:"pvW", label:"PV Power", unit:"W", group:"Power"},
  ...PORTS.map(([k,l])=>({key:k+"W", label:l, unit:"W", group:"Power"})),
  ...PORTS.map(([k,l])=>({key:k+"V", label:l, unit:"V", group:"Voltage"})),
  ...PORTS.map(([k,l])=>({key:k+"A", label:l, unit:"A", group:"Current"})),
  {key:"gridHz", label:"Grid Frequency", unit:"Hz", group:"Frequency"},
  {key:"loadHz", label:"Load Frequency", unit:"Hz", group:"Frequency"},
  {key:"genHz",  label:"Gen Frequency",  unit:"Hz", group:"Frequency"},
  {key:"soc",      label:"Battery SOC",      unit:"%",  group:"Battery"},
  {key:"soh",      label:"Battery SOH",      unit:"%",  group:"Battery"},
  {key:"capacity", label:"Battery Capacity", unit:"Ah", group:"Battery"},
  {key:"temp",    label:"Inverter Temp", unit:"°C", group:"Temperature"},
  {key:"batTemp", label:"Battery Temp",  unit:"°C", group:"Temperature"},
  {key:"eToday",           label:"PV Energy",          unit:"kWh", group:"Energy (today)"},
  {key:"consumptionToday", label:"Consumption",        unit:"kWh", group:"Energy (today)"},
  {key:"feedInToday",      label:"Feed-In",            unit:"kWh", group:"Energy (today)"},
  {key:"purchasedToday",   label:"Purchased",          unit:"kWh", group:"Energy (today)"},
  {key:"chargeToday",      label:"Battery Charged",    unit:"kWh", group:"Energy (today)"},
  {key:"dischargeToday",   label:"Battery Discharged", unit:"kWh", group:"Energy (today)"},
  {key:"outputToday",      label:"Output",             unit:"kWh", group:"Energy (today)"},
  {key:"smartLoadToday",   label:"Smart Load",         unit:"kWh", group:"Energy (today)"},
  {key:"eTotal",          label:"PV Energy",          unit:"kWh", group:"Energy (lifetime)"},
  {key:"totalConsumption",label:"Consumption",        unit:"kWh", group:"Energy (lifetime)"},
  {key:"totalFeedIn",     label:"Feed-In",            unit:"kWh", group:"Energy (lifetime)"},
  {key:"totalPurchased",  label:"Purchased",          unit:"kWh", group:"Energy (lifetime)"},
  {key:"totalCharge",     label:"Battery Charged",    unit:"kWh", group:"Energy (lifetime)"},
  {key:"totalDischarge",  label:"Battery Discharged", unit:"kWh", group:"Energy (lifetime)"},
  {key:"outputTotal",     label:"Output",             unit:"kWh", group:"Energy (lifetime)"},
  {key:"smartLoadTotal",  label:"Smart Load",         unit:"kWh", group:"Energy (lifetime)"},
  {key:"hTotal",          label:"Run Hours",          unit:"h",   group:"Energy (lifetime)"},
];
function dayexcelResp(sn, date) {
  const hit = BY_SN.get(sn);
  if (!hit || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return { rows: [], activeMppts: [], metrics: [], count: 0, header: CSV_HEADER };
  const { site, inv, idx } = hit;
  const w = inv.w, dt = 5 / 60;
  const life = (k) => site.life[k] * w;
  const acc = { pv: 0, load: 0, exp: 0, imp: 0, charge: 0, dis: 0 };
  const rows = simDay(site, date).rows.map((r) => {
    for (const k of Object.keys(acc)) acc[k] += r[k] * w * dt / 1000;
    const pv = r.pv * w, load = r.load * w, gridW = (r.imp - r.exp) * w, batW = (r.charge - r.dis) * w;
    const port = (V, W) => ({ V: r1(V), A: V ? r2(W / V) : 0, W: r0(W) });
    const wob = (k) => (hash01(`${sn}${date}${k}${r.min}`) - 0.5);
    const cells = {};
    [0.42, 0.36, 0.22].forEach((share, k) => { const W = pv * share; cells[`mppt${k + 1}`] = port(W > 0 ? 372 - k * 9 + idx * 2 + wob(`m${k}`) * 6 : 0, W); });
    cells.gridL1 = port(VLEG[0] + wob("g1"), gridW / 2); cells.gridL2 = port(VLEG[1] + wob("g2"), gridW / 2);
    cells.loadL1 = port(VLEG[0], site.aio ? 0 : load / 2); cells.loadL2 = port(VLEG[1], site.aio ? 0 : load / 2);
    cells.acOut1 = port(VLEG[0], site.aio ? load / 2 : 0); cells.acOut2 = port(VLEG[1], site.aio ? load / 2 : 0);
    for (const k of ["smartB1", "smartB2", "smartC1", "smartC2", "genL1", "genL2"]) cells[k] = port(0, 0);
    const flat = {};
    for (const [k, c] of Object.entries(cells)) { flat[k + "V"] = c.V; flat[k + "A"] = c.A; flat[k + "W"] = c.W; }
    const batV = r1(51.0 + r.soc * 0.035);
    const gridHz = r2(60 + wob("hz") * 0.04);
    return {
      time: `${p2(Math.floor(r.min / 60))}:${p2(r.min % 60)}:00`,
      mppt: [flat.mppt1W, flat.mppt2W, flat.mppt3W],
      gridV: [flat.gridL1V, flat.gridL2V],
      gridHz,
      pvW: flat.mppt1W + flat.mppt2W + flat.mppt3W,
      ...flat,
      batV, batA: r1(batW / batV), batW: r0(batW),
      loadHz: r2(60 + wob("lhz") * 0.02), genHz: 0,
      soc: r0(r.soc), soh: site.battery.soh, capacity: site.battery.capacityAh,
      temp: r1(31 + pv / 900 + wob("t")), batTemp: r1(site.battery.tempC || 25),
      eToday: r2(acc.pv), consumptionToday: r2(acc.load), feedInToday: r2(acc.exp), purchasedToday: r2(acc.imp),
      chargeToday: r2(acc.charge), dischargeToday: r2(acc.dis), outputToday: r2(acc.load), smartLoadToday: 0,
      eTotal: r1(life("pv") + acc.pv), hTotal: r0(9800 + idx * 37),
      totalConsumption: r1(life("load") + acc.load), totalFeedIn: r1(life("exp") + acc.exp),
      totalPurchased: r1(life("imp") + acc.imp), totalCharge: r1(life("chg") + acc.charge),
      totalDischarge: r1(life("dis") + acc.dis), outputTotal: r1(life("load") + acc.load), smartLoadTotal: 0,
    };
  });
  const activeMppts = [0, 1, 2].filter((i) => rows.some((r) => Math.abs(r.mppt[i]) > 1));
  const metrics = METRIC_DEFS.filter((md) => rows.some((r) => r[md.key] !== undefined && !Number.isNaN(r[md.key])));
  return { rows, activeMppts, metrics, count: rows.length, header: CSV_HEADER };
}

// ── Inverter settings (device-shadow registers, raw values) ──────────────────────────────────────
// Voltages are x10, frequencies x100 (see SETTINGS_MAP in pages/index.jsx).
const SETTINGS_BASE = {
  "30BA": 10000, "308E": 12000, "2100": 0, "2141": 1, "215B": 0, "214C": 0, "30B5": 0, "30B2": 0, "30B3": 3, "30B0": 1, "3089": 2, "30B1": 2,
  "2127": 8000, "2126": 3000, "2134": 480, "2135": 540, "2137": 30, "2136": 120, "213F": 0, "2122": 0, "2156": 0,
  "2110": 17, "2124": 0, "2115": 0, "218C": 0, "21B4": 95, "21B5": 25, "214F": 8, "2118": 9000, "211A": 9000, "2116": 10000, "2150": 3000,
  "211B": 20, "2119": 100, "2144": 15, "2145": 30, "214A": 25,
  "2113": 480, "2114": 540, "2180": 560, "2146": 490, "2147": 520, "214B": 485,
  "2148": 576, "212F": 500, "2181": 576, "2182": 60, "2183": 120, "2184": 30, "2186": 120,
  "2143": 1, "5112": 1, "510E": 1, "3088": 0, "2140": 1, "5104": 100, "501B": 100, "5110": 300,
  "5101": 18, "2125": 12000, "5000": 300, "5029": 10, "5001": 300, "5019": 10,
  "507A": 1320, "507B": 1056, "5078": 6050, "5079": 5950, "5027": 1260, "5028": 1056, "5012": 6010, "5013": 5910,
  "5004": 1320, "500C": 1440, "5005": 1056, "500D": 600, "5002": 6120, "500A": 6200, "5003": 5850, "500B": 5700,
  "1A18": 1, "2562": 600, "2563": 38, "3000": 2310, "3001": 2250, "3002": -310, "3003": 1380,
};
// Per-AutoID deviations so the fleet Compare view has something to highlight.
const SETTINGS_OVERRIDES = { "70186": { "30BA": 8000, "2119": 95 }, "61398": { "2110": 33, "2124": 1 } };
function readsettingsResp(body) {
  const aid = String(body?.autoId || "");
  const codes = Array.isArray(body?.codes) && body.codes.length ? body.codes : Object.keys(SETTINGS_BASE);
  const over = SETTINGS_OVERRIDES[aid] || {};
  const data = {};
  for (const c of codes) {
    const code = String(c).toUpperCase();
    if (code in over) data[code] = over[code];
    else if (code in SETTINGS_BASE) data[code] = SETTINGS_BASE[code];
    else if (/^30[01][0-9A-F]$/.test(code)) data[code] = 0; // rest of the live power block
  }
  return { autoId: aid, ok: true, requested: codes.length, count: Object.keys(data).length, data, statusFlags: { "1A18": 1 } };
}

// ── Account / admin / notifications fixtures ─────────────────────────────────────────────────────
const SITE_PHOTO = "data:image/svg+xml," + encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' fill='#BFDBFE'/>" +
  "<circle cx='51' cy='12' r='7' fill='#FBBF24'/><rect y='46' width='64' height='18' fill='#86EFAC'/>" +
  "<polygon points='10,31 32,13 54,31' fill='#1E3A8A'/><rect x='15' y='31' width='34' height='19' fill='#F5F5F4'/>" +
  "<rect x='28' y='38' width='8' height='12' fill='#92400E'/><polygon points='33,20 47,29 50,27 37,17' fill='#334155'/></svg>");

function accountsResp() {
  return {
    role: "admin",
    email: USER.email,
    accounts: [{ id: ACCOUNT_ID, label: "Installer fleet", midnite_username: "DEMO-INSTALLER", account_type: "installer", created_at: "2026-03-14T15:02:11.000Z" }],
    sharedAccounts: [],
    profile: { display_name: USER.displayName, avatar_url: null },
    sitePhotos: { "Wise Naples": SITE_PHOTO },
  };
}
function sitesResp() {
  return {
    accountType: "installer",
    sites: SITES.map((s) => ({
      MemberID: s.name,
      MemberAutoID: s.memberAutoId,
      GoodsID: s.inverters.map((i) => ({ GoodsID: i.sn, AutoID: i.autoId })),
      MemberStateCount: s.statusCounts,
      op_member: { installer: "" },
    })),
  };
}
function adminFleetResp() {
  return {
    ok: true,
    sites: SITES.map((s) => {
      const fl = s.inverters.map((i) => flowSample(i.sn));
      const up = fl.filter((f) => f.online);
      const st = s.inverters.map((i) => statusFor(i.sn)).filter((r) => r.ok);
      const pv = sum(up, (f) => f.pv), load = sum(up, (f) => (f.load > 0 ? f.load : f.eps)), gridNet = sum(up, (f) => f.grid);
      const pvToday = sum(st, (r) => r.data.photovoltaic.production.today);
      const expToday = sum(st, (r) => r.data.grid.sold.today), impToday = sum(st, (r) => r.data.grid.consumption.today);
      return {
        name: s.name, ownerEmail: null, total: s.inverters.length,
        status: up.length === 0 ? "offline" : up.length < s.inverters.length ? "partial" : "online",
        invOnline: up.length, pv, load, gridNet, batNet: pv + gridNet - load, soc: s.now.soc,
        pvToday, expToday, impToday, consumedToday: pvToday - expToday + impToday,
        updated: st.map((r) => r.data.inverter.lastUpdateTime).filter(Boolean).sort().slice(-1)[0] || null,
      };
    }),
  };
}
function adminUsersResp() {
  return {
    users: [
      { id: USER.id, email: USER.email, created_at: "2026-03-14T14:58:00.000Z", last_sign_in_at: isoAgo(3),
        profile: { id: USER.id, display_name: USER.displayName, role: "admin" },
        accounts: [{ user_id: USER.id, midnite_username: "DEMO-INSTALLER", label: "Installer fleet", account_type: "installer" }] },
      { id: "00000000-0000-0000-0000-000000000002", email: "homeowner@example.com", created_at: "2026-05-02T18:20:00.000Z", last_sign_in_at: isoAgo(60 * 26),
        profile: { id: "00000000-0000-0000-0000-000000000002", display_name: "Pat Homeowner", role: "user" },
        accounts: [{ user_id: "00000000-0000-0000-0000-000000000002", midnite_username: "Wise Naples", label: "Wise Naples", account_type: "enduser" }] },
      { id: "00000000-0000-0000-0000-000000000003", email: "bochan.family@example.com", created_at: "2026-08-21T12:00:00.000Z", last_sign_in_at: null,
        profile: { id: "00000000-0000-0000-0000-000000000003", display_name: null, role: "user" }, accounts: [] },
    ],
  };
}
function adminLogResp() {
  return {
    persistent: false,
    log: [
      { type: "view", user: "homeowner@example.com", account: "Wise Naples", site: "Wise Naples", ts: isoAgo(12) },
      { type: "view", user: USER.email, account: "DEMO-INSTALLER", site: "Wise Naples", ts: isoAgo(1) },
      { type: "link", user: "bochan.family@example.com", account: "Bochan", ts: isoAgo(60 * 5) },
      { type: "view", user: "ops@example.com", account: "DEMO-INSTALLER", site: "OffTheHook", ts: isoAgo(60 * 9) },
      { type: "login", user: "homeowner@example.com", ts: isoAgo(60 * 26) },
    ],
  };
}
function alertRulesResp() {
  const wise = SITES[0];
  const rule = (n, inv, trigger_type, threshold_value, extra = {}) => ({
    id: `9b0c0000-0000-4000-8000-00000000000${n}`, user_id: USER.id, account_id: ACCOUNT_ID, site_name: wise.name,
    device_id: inv.sn, device_label: `INV-${wise.inverters.indexOf(inv) + 1}`, name: null, trigger_type, threshold_value,
    channel: "email", enabled: true, cooldown_minutes: 60, trigger_after_time: null, last_triggered_at: null,
    created_at: "2026-09-01T12:00:00.000Z", ...extra,
  });
  return {
    rules: [
      rule(1, wise.inverters[0], "battery_soc_below", 25, { last_triggered_at: isoAgo(60 * 30) }),
      rule(2, wise.inverters[0], "device_offline", 30),
      rule(3, wise.inverters[1], "pv_today_below", 8, { trigger_after_time: "18:00", cooldown_minutes: 720 }),
      rule(4, wise.inverters[2], "inverter_temp_above", 60, { enabled: false }),
    ],
    entitled: true, emailConfigured: true, dailyCap: 50, dailyUsed: 2,
  };
}
function digestGetResp() {
  return {
    digest: {
      id: "5d1e0000-0000-4000-8000-000000000001", user_id: USER.id, account_id: ACCOUNT_ID, frequency: "daily", channel: "email",
      enabled: true, send_hour: 7, timezone: "America/New_York", site_name: null,
      last_sent_date: utcToday(), last_sent_at: isoAgo(60 * 6),
    },
    emailConfigured: true, schemaReady: true,
  };
}
function shareListResp() {
  return {
    outgoing: [
      { id: "7a2e0000-0000-4000-8000-000000000001", owner_account_id: ACCOUNT_ID, site_name: "Wise Naples", shared_with_email: "homeowner@example.com", status: "active", created_at: "2026-06-10T15:00:00.000Z" },
      { id: "7a2e0000-0000-4000-8000-000000000002", owner_account_id: ACCOUNT_ID, site_name: "Wise Naples", shared_with_email: "tenant@example.com", status: "pending", created_at: "2026-09-28T19:30:00.000Z" },
      { id: "7a2e0000-0000-4000-8000-000000000003", owner_account_id: ACCOUNT_ID, site_name: "Bochan", shared_with_email: "bochan.family@example.com", status: "active", created_at: "2026-08-22T13:10:00.000Z" },
    ],
    incoming: [],
  };
}
function logsearchResp(body) {
  const serials = Array.isArray(body?.serials) ? body.serials : [];
  const events = serials.slice(0, 2).flatMap((sn, i) => [
    { GoodsID: sn, sn, ErrorCode: "22", status: "0", Time: etWall(-60 * (30 + i * 7)) },
    { GoodsID: sn, sn, ErrorCode: "50", status: i === 0 ? "1" : "0", Time: etWall(-60 * (4 + i)) },
  ]).sort((a, b) => (a.Time < b.Time ? 1 : -1));
  return { events, totalErrors: events.length };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────────────────────────
const HANDLERS = {
  accounts: () => accountsResp(),
  sites: () => sitesResp(),
  status: (b) => ({ results: (Array.isArray(b?.serials) ? b.serials : []).map(statusFor) }),
  flow: (b) => ({ results: (Array.isArray(b?.serials) ? b.serials : []).map((sn) => { const f = flowSample(sn); return f ? { sn, ok: true, ...f } : { sn, ok: false, error: "unknown serial" }; }) }),
  flowrt: (b) => {
    const f = flowSample(b?.serial);
    if (!f) return { ok: false, serial: b?.serial, error: "unknown serial" };
    const raw = { GoodsID: b.serial, online: f.online, SystemTime: f.time, TotalDCpower: String(f.pv), gridCurrpac: String(f.grid), loadCurrpac: String(f.load), epsCurrpac: String(f.eps), genCurrpac: String(f.gen), Pbat: String(f.battery), SOC: String(f.soc) };
    return { ok: true, serial: b.serial, time: f.time, pv: f.pv, grid: f.grid, load: f.load, eps: f.eps, gen: f.gen, battery: f.battery, soc: f.soc, raw };
  },
  day: (b) => dayResp(b?.sn, b?.date),
  dayexcel: (b) => dayexcelResp(b?.sn, b?.date),
  month: (b) => monthResp(b?.sn, b?.date),
  year: (b) => yearResp(b?.sn, b?.date),
  alertrules: () => alertRulesResp(),
  digest_get: () => digestGetResp(),
  alerttest: () => ({ ok: true, to: "jason@example.com" }),
  share_list: () => shareListResp(),
  logview: () => ({ ok: true }),
  admin_users: () => adminUsersResp(),
  admin_fleet: () => adminFleetResp(),
  adminlog: () => adminLogResp(),
  readsettings: (b) => readsettingsResp(b),
  logsearch: (b) => logsearchResp(b),
};
export const KNOWN_ACTIONS = new Set(Object.keys(HANDLERS));

/** JSON body for POST /api/midnite?action=<action>. Unknown actions get a harmless {ok:true}. */
export function respond(action, body) {
  const h = HANDLERS[action];
  return h ? h(body || {}) : { ok: true };
}
