// ─────────────────────────────────────────────────────────────────────────────
// Generator registers the app may WRITE (raw device-shadow values), from the installer
// portal's Remote-Setting form (umi bundle). Anything not listed here can never be written.
// Shared by the admin `genwrite` action (pages/api/midnite.js) and writeShadow()
// (lib/midniteServer.js), which pages/api/generator.js uses.
// Raw encoding: voltages x10, times HH*256+MM, the rest as typed.
// ─────────────────────────────────────────────────────────────────────────────

export const between = (lo, hi) => ({ ok: (n) => n >= lo && n <= hi, range: `${lo}-${hi}` });
export const isTime = { ok: (n) => Math.floor(n / 256) <= 23 && n % 256 <= 59 && n >= 0, range: "HH*256+MM" };

export const GEN_WRITABLE = Object.freeze({
  "2156": between(0, 2),     // AGS dry contact: 0 Auto, 1 On, 2 Off
  "2136": between(0, 1440),  // Generator Max Run Time (min)
  "2137": between(0, 1440),  // Generator Standby Time (min)
  "2129": between(0, 100),   // Generator Start SOC (%), Capacity Mode 2124=0
  "212A": between(0, 100),   // Generator Stop SOC (%), Capacity Mode 2124=0
  "2134": between(400, 640), // Generator Start Voltage (V x10), Capacity Mode 2124=1
  "2135": between(400, 640), // Generator End Voltage (V x10), Capacity Mode 2124=1
  "2151": between(0, 2),     // Run cycle: 0 Disable, 1 Weekly, 2 Monthly
  "2152": between(1, 7),     // Run day: 1 Mon .. 7 Sun
  // NOT writable: 2122 Gen Port ("Adjust In Standby Mode", inverter must be in standby) and 219B Cold Start.
  "2153": between(1, 31),    // Run date (monthly)
  "2154": isTime,            // Cycle start time
  "2155": isTime,            // Cycle end time
});

// Read-only extras worth reading next to the writable set: Gen Port, Capacity Mode, Cold Start,
// Generator input location (213F, 1 = generator on the grid terminals) and Work Mode (2100, 3 = Off-Grid).
// 213F and 2100 are NEVER writable.
export const GEN_READ_EXTRA = ["2122", "2124", "219B", "213F", "2100"];
export const GEN_READ_CODES = [...Object.keys(GEN_WRITABLE), ...GEN_READ_EXTRA];

// Where the generator is wired, from a register read. null when the register didn't come back.
export function genWiring(regs) {
  const loc = regs?.["213F"], mode = regs?.["2100"];
  return {
    genLocation: loc == null || loc === "" ? null : Number(loc) === 1 ? "grid" : "gen_port",
    offGrid: mode == null || mode === "" ? null : Number(mode) === 3,
  };
}

export const AGS = Object.freeze({ AUTO: 0, ON: 1, OFF: 2 });

// Validate a {code: value} map against the allow-list.
// Returns { ModbusArr: {code: "rawString"}, bad: ["code: why", ...] }.
export function validateGenWrites(writes) {
  const bad = [];
  const ModbusArr = {};
  for (const [code, v] of Object.entries(writes || {})) {
    const rule = Object.prototype.hasOwnProperty.call(GEN_WRITABLE, code) ? GEN_WRITABLE[code] : null;
    const n = Number(v);
    if (!rule) { bad.push(`${code}: not an allowed generator register`); continue; }
    if (v === "" || v == null || !Number.isInteger(n) || !rule.ok(n)) { bad.push(`${code}: ${v} out of range (${rule.range})`); continue; }
    ModbusArr[code] = String(n);
  }
  return { ModbusArr, bad };
}
