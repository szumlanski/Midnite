# Midnite Solar Dashboard — Project Knowledge

**App name**: Midnite Sentinel | **URL**: https://midnite-rose.vercel.app | **Repo**: https://github.com/szumlanski/Midnite
**Project path on Jason's Mac**: `~/Midnite/midnite/` (git root is `~/Midnite/`, Next.js project is `~/Midnite/midnite/`)

---

## Architecture

- `pages/index.jsx` — React frontend dashboard (single-file, all components inline)
- `pages/api/midnite.js` — Next.js serverless proxy (handles auth + API signing)
- `public/favicon.svg` — Bold amber sun + sentinel eye icon
- `public/logo.svg` — Same design as favicon
- No `vercel.json`. No `output: standalone`. Standard Next.js build. Framework preset = Next.js.
- Deployment protection is OFF in Vercel settings.

**Environment variables in Vercel** (fallback only, login is dynamic):
- `MIDNITE_USERNAME` = `Wise Naples`
- `MIDNITE_PASSWORD` = `921551`

---

## Accounts

- **End-user (Wise Naples)**: username `Wise Naples`, password `921551`. Logs in via Senergytec API. Sees only their own site.
- **Installer (FLOSOL2)**: username `FLOSOL2`, password `F78qq13m!`. Logs in via Eagle API. Sees all managed sites via `terminaluserinfo`.

## Site Data (Wise Naples)

- Group ID: `47031`
- 4 inverters: `2426-90190114PH`, `2426-90190151PH`, `2426-90190186PH`, `2426-90190187PH`

---

## API

**Base URL**: `https://service.midnitepower.com/API/CodeIgniter/index.php`

This is the ONLY working API. The newer `appsrv.midniteelectric.com` is NOT accessible from Vercel servers. Do not switch to it.

### Signing Algorithm

```js
// Sort params (excluding null, "", boolean), join as key=value&key=value&SALT
// AES-256-CBC encrypt with PKCS7 padding
const AES_KEY = "05469137076236813460585715952089";
const AES_IV  = "5161557162012237";
const SALT    = "05469137076236813460585715952089";
```

### Login (dual path)

The proxy tries **installer login first**, then falls back to **end-user login**.

**Installer (Eagle)**:
```
POST /Eagle/v1/Operation/login
Body: { MemberID, PassWord (capital W), sign }
Returns: { token } (MemberAutoID is null for installers)
```

**End-user (Senergytec)**:
```
POST /Senergytec/web/v2/Inverterapi/UserLogin
Body: { MemberID, Password (lowercase w), type: "1", remember: false, sign }
Returns: { token, MemberAutoID }
```

Note: field is `MemberID` not `memberID` or `Account`.

### Sites (installer only)

```
POST /Eagle/v1/Operation/terminaluserinfo
Body: { MemberID, Page: 1, EndUserName: "", OperationName: "", GoodsID: "", inDate, inTime, status: 0, sign }
Returns: [{ MemberID, GoodsID: [{GoodsID: "serial"}], MemberStateCount: [online,alarm,offline,disc], op_member }]
```

The Eagle token works with both Eagle and Senergytec data endpoints.

### Proxy Actions (`/api/midnite?action=X`)

All actions accept optional `username` and `password` in the request body. Falls back to env vars.

| Action | Endpoint | Required body fields |
|--------|----------|----------------------|
| `login` | (dual path above) | `username`, `password` |
| `sites` | `terminaluserinfo` (installer) | `username`, `password` |
| `status` | `InverterDetailInfoNewone` | `serials: string[]` |
| `day` | `dayProductionAndConsumptionAreaTime` | `sn`, `date` (YYYY-MM-DD) |
| `month` | `monthProductionAndConsumptionArea` | `sn`, `date` (YYYY-MM) |
| `year` | `yearProductionAndConsumptionArea` | `sn`, `date` (YYYY) |

**Critical**: All actions must exist in the proxy switch statement. If `status` is missing, the live tab crashes with a 400 error.

**Critical**: The `year` action must pass `date` to the API. Without it the API returns `{"status":false,"message":"no params"}`.

### Response field names

- Day: `r.inTime`, `r.Production`, `r.Consumption`, `r.powerFromGrid`, `r.powerToGrid`, `r.SOC`
- Month: `r.day`, `r.Production`, `r.Consumption`, `r.powerFromGrid`
- Year: `r.month` (integer 1-12), `r.Production`, `r.Consumption`
- All wrapped in `{ Data: [...] }`

### normalizeDetail()

The `status` action calls `normalizeDetail(raw, sn)` before returning. Key logic:

**EPS auto-detect**: Some inverters (AIO and others) serve load through EPS port, not AC load port. `loadCurrpac` = 0, `epsCurrpac` has actual load. Auto-detect: if `loadSum === 0 && epsSum > 0`, use `epsCurrpac`/`epsVac`/`epsIac`/`EPSDay`/`EPSTotal`.

**Battery fields**: All battery data is in `InverterDetailInfoNewone` — no separate endpoint needed.
- `brand` = BMS brand (empty string = open loop / no BMS comms, e.g. lead acid)
- `SOC`, `SOH`, `volt`, `cur`, `BMS_temp`, `capacity` (Ah), `toPbat` (charge W), `fromPbat` (discharge W)
- `Etotal_batChrg`, `Etotal_batDischrg` in kWh → multiply × 1000 for Wh

---

## Frontend Design System

**Theme**: Light warm residential (not dark/glassmorphism).

### Design Tokens (index.jsx)
```js
const BG = "#F7F4EF";       // page background
const CARD = "#FFFFFF";
const BORDER = "#EAE4DC";
const TEXT = "#1C1917";
const MUTED = "#78716C";
const FAINT = "#A8A29E";
const SOLAR = "#D97706";    // amber — PV
const BATTERY = "#16A34A";  // green — battery
const GRID_IN = "#DC2626";  // red — importing from grid
const GRID_OUT = "#059669"; // green — exporting to grid
const LOAD_C = "#2563EB";   // blue — load/consumption
const CHART_PROD = "#3B82F6";
const CHART_CONS = "#F97316";
const CHART_BAT = "#22C55E";
const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";
```

### Logo
Bold amber sun with sentinel eye. Inline React `Logo` component in `index.jsx`, also `public/favicon.svg` and `public/logo.svg`. All three must match.

Design: navy `#0D1F33` rounded-rect background → 8 amber `#F59E0B` pill rays rotated 0/45/90…315° → amber disc r=66 → navy ring r=44 → cyan `#00C8E8` iris r=28 → navy pupil r=12 → white core r=5. All on 256×256 viewBox centered at (128,128).

### Mobile / Layout
- Bottom nav bar (fixed, mobile only via CSS `@media(max-width:640px)`): Live / Day / Month / Year tabs with SVG icons
- Top tabs hidden on mobile (`display:none!important`)
- Inverter selector: horizontal scroll, no-wrap, `.inv-scroll` class (hidden scrollbar CSS)
- Pills show `INV-N · power` with last-8-chars SN as monospace subtitle

### Battery Panel (BatteryPanel component)
- Sums `charge`, `discharge`, `current` across all inverters with `voltage > 0`
- Averages `soc`, `voltage`, `healthPercent`, `temperature` from those same inverters
- Open loop detection: `brand === ""` → hide SOH/temp, label SOC as "estimated"
- All 4 inverters report the same battery bank (master inverter replicates to all)
- `capacityAh` is the total bank capacity (e.g. 3140 Ah = 10 × 314 Ah batteries)

---

## Frontend Data Flow

```
aggregateDayData(all)   — all = array of per-inverter responses, keyed by r.inTime
aggregateMonthData(all) — keyed by r.day
aggregateYearData(all)  — keyed by r.month (integer), mapped to Jan/Feb/etc
```

Day view data is in **watts** (live power readings). Summary card totals use `* (5/60)` to convert to Wh.
Month and year data is in **kWh**. Summary card totals use `* 1000` to convert to Wh for display.

---

## !! BAR CHART — DO NOT TOUCH THESE PROPS !!

This is the #1 recurring regression in this codebase. Every time these get "cleaned up" the bars break. They are defined as named constants at the top of `index.jsx` and must not be changed:

```js
const BAR_DAY   = { barCategoryGap: -100,  barSize: 12, barGap: -12 };
const BAR_MONTH = { barCategoryGap: "20%", barSize: 20, barGap: -20 };
const BAR_YEAR  = { barCategoryGap: "20%", barSize: 40, barGap: -40 };
```

**Why `BAR_DAY` has NO `barSize`**: In Recharts 3.x (`combineAllBarPositions.js`), when `barSize` IS set, the positioning code checks `if (sum >= bandSize) { realBarGap = 0; }`. With 288 data points, `bandSize ≈ 3px` and any reasonable `barSize` makes `sum >> bandSize`, so Recharts **always resets barGap to 0**, rendering pos and neg groups side-by-side. The `barCategoryGap` prop is also only consulted in the else branch (no barSize). Fix: omit `barSize` entirely. Recharts then uses `originalSize = (bandSize - 0 - 1*(-bandSize)) / 2 = bandSize`, and both group offsets collapse to 0 — perfect overlap.

**Why `BAR_MONTH` and `BAR_YEAR` use `barSize`**: These charts have far fewer data points (~30 and 12), so `bandSize` is large enough that `barSize < bandSize` — the reset condition never triggers. `barGap = -barSize` aligns pos/neg groups to overlap correctly.

**Other invariants that must never change:**
- Each `<Bar>` must have `activeBar={false}` — prevents white hover box (Recharts 3.x bug)
- `<Tooltip>` must have `cursor={false}` — same reason
- Do NOT add `verticalPoints` to `<CartesianGrid>` — causes misalignment
- `stackId="pos"` for above-zero bars, `stackId="neg"` for below-zero bars — never share a stackId between them
- Month/year use `consumptionNeg: -(d.consumption||0)` etc. to render below zero — do NOT use ComposedChart

---

## Known Issues / History

---

## Deployment Rules

1. Never add `vercel.json` unless you know exactly why.
2. Never set `output: 'standalone'` in `next.config.mjs`.
3. Never set Root Directory in Vercel settings — the project IS the root.
4. Framework preset in Vercel must be **Next.js**, not "Other".
5. After any Vercel settings change, redeploy from the Vercel dashboard.
6. Always hard refresh (Cmd+Shift+R) after a new deployment.

---

## Working with Claude Code

Claude Code (CLI) can read and write files directly in the project directory. No need to use `/mnt/user-data/outputs/` or manual `cp` steps. Claude commits and pushes directly via git.

**After every code change, Claude must automatically commit and push to GitHub without waiting to be asked.** Use a clear commit message summarizing what changed. Vercel deploys automatically on push.
