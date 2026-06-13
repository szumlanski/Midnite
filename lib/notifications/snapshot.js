// ─────────────────────────────────────────────────────────────────────────────
// DeviceSnapshot — the portability boundary.
//
// Everything vendor-specific ends here: buildSnapshot() takes the *normalized*
// Midnite status object (the same shape normalizeDetail()/normalizeRich() return
// in pages/api/midnite.js and lib/midniteServer.js) and produces a flat, neutral
// metric map. Rule evaluation (lib/notifications/engine.js) is a pure function
// over this snapshot with ZERO API knowledge — which is what makes the whole
// notifications system portable to a different device/app.
//
// Metric keys here MUST match the `metric` fields in lib/notifications/triggers.js.
// ─────────────────────────────────────────────────────────────────────────────

const n = (v) => {
  const x = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};

// House load derived from the energy balance (mirrors balanceLoad() in index.jsx):
// PV + grid-import + battery-discharge − charge − export. Robust across inverter
// types — AIO units serve load through a smart/EPS port so the AC load register
// reads 0 and the real consumption only shows up in this balance.
function balanceLoad(d) {
  const pv = n(d?.photovoltaic?.power?.totalDc);
  const gridNet = n(d?.grid?.netW); // + import / − export
  const dis = n(d?.battery?.discharge);
  const chg = n(d?.battery?.charge);
  return Math.max(0, pv + gridNet + dis - chg);
}

// Build a normalized snapshot from one inverter's normalized status `data`.
// `online` reflects whether we got a fresh sample THIS poll (the heartbeat sets
// it); offline detection itself is time-gap based, never the API's health claim.
export function buildSnapshot(data, { online = true, capturedAt = new Date() } = {}) {
  const gridNet = n(data?.grid?.netW); // + import / − export
  const metrics = {
    pvPowerW: n(data?.photovoltaic?.power?.totalDc),
    loadPowerW: balanceLoad(data),
    gridImportW: Math.max(0, gridNet),
    gridExportW: Math.max(0, -gridNet),
    batteryChargeW: n(data?.battery?.charge),
    batteryDischargeW: n(data?.battery?.discharge),
    batterySoc: n(data?.battery?.soc),
    batterySoh: n(data?.battery?.healthPercent),
    batteryTempC: n(data?.battery?.temperature),
    inverterTempC: n(data?.inverter?.temperature),
    gridVoltageV: n(data?.grid?.lines?.find?.((l) => n(l?.voltage) > 0)?.voltage),
    gridFrequencyHz: n(data?.grid?.lines?.find?.((l) => n(l?.frequency) > 0)?.frequency),
    // Energy-today counters are reported in Wh by the normaliser → expose as kWh.
    pvEnergyTodayKwh: n(data?.photovoltaic?.production?.today) / 1000,
    exportTodayKwh: n(data?.grid?.sold?.today) / 1000,
    importTodayKwh: n(data?.grid?.consumption?.today) / 1000,
  };
  return {
    online: !!online,
    capturedAt: capturedAt instanceof Date ? capturedAt.toISOString() : capturedAt,
    model: data?.inverter?.model || "",
    lastUpdateTime: data?.inverter?.lastUpdateTime || "",
    batteryOpenLoop: (data?.battery?.brand || "") === "", // no BMS comms (e.g. lead-acid)
    metrics,
  };
}

// An "offline" placeholder snapshot for when a live fetch returned nothing.
export function offlineSnapshot({ capturedAt = new Date() } = {}) {
  return {
    online: false,
    capturedAt: capturedAt instanceof Date ? capturedAt.toISOString() : capturedAt,
    model: "",
    lastUpdateTime: "",
    batteryOpenLoop: false,
    metrics: {},
  };
}
