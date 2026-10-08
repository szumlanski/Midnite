// Plausibility guard for the vendor's month/year energy rollups (isomorphic: used by the app and the
// daily digest).
//
// The rollup endpoints occasionally return physically impossible energy for one inverter and one period.
// Example (Mark Gorovoy, Year 2026): one January row reported powerToBattery ≈ 4,204,844 kWh, so the Year
// chart showed 4,204,844 kWh of "solar" (production is reconstructed as ConsumedDirectly + powerToBattery +
// powerToGrid) and 4,206.89 MWh charged, against 3,368 kWh of load.
//
// No inverter in this app can move more than MAX_KWH_PER_INVERTER_DAY through one path in a day (the
// MN 15-12KW-AIO is rated 15 kW; 25 kW for 24 h is a generous ceiling). A field above
// ceiling × days is treated as corrupt: it is set to 0 and reported, so totals stay sane and the UI
// can say exactly what was left out. Only impossible values are touched; everything else passes through.

export const MAX_KWH_PER_INVERTER_DAY = 600;

// Energy fields (kWh) the app reads from rollup rows.
export const ROLLUP_ENERGY_FIELDS = [
  "ConsumedDirectly", "powerToBattery", "powerFromBattery", "powerToGrid", "powerFromGrid", "Consumption",
];

const FIELD_LABEL = {
  ConsumedDirectly: "solar used directly",
  powerToBattery: "battery charged",
  powerFromBattery: "battery discharged",
  powerToGrid: "exported",
  powerFromGrid: "imported",
  Consumption: "consumed",
};

// `days` = how many days the row covers (1 for a daily row, the month length for a monthly row).
// Returns { row, bad } where `row` is a copy with impossible fields zeroed and `bad` lists them.
export function sanitizeRollupRow(r, days = 1) {
  const ceiling = MAX_KWH_PER_INVERTER_DAY * Math.max(1, days);
  let row = r;
  const bad = [];
  for (const f of ROLLUP_ENERGY_FIELDS) {
    const v = parseFloat(r?.[f]);
    if (Number.isFinite(v) && v > ceiling) {
      if (row === r) row = { ...r };
      row[f] = 0;
      bad.push({ field: f, label: FIELD_LABEL[f] || f, value: v });
    }
  }
  return { row, bad };
}

export function daysInMonth(year, month) {
  return new Date(Date.UTC(Number(year) || 2000, Number(month), 0)).getUTCDate();
}
