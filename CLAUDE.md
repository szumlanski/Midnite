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
- **Installer / admin (FLOSOL2)**: username `FLOSOL2`, password `F78qq13m!`. Logs in via Eagle API. Sees all managed sites via `terminaluserinfo`. **This is also the admin account** — when the logged-in username is `FLOSOL2` (case-insensitive, constant `ADMIN_USER` in the proxy / `isAdmin` in the frontend) the **Admin tab** appears. No other account sees it.

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
| `dayexcel` | `Eagle/v1//Excel/hybridStatusExcelMidNite` (GET, CSV) | `sn`, `date` (YYYY-MM-DD), `memberId` |
| `month` | `monthProductionAndConsumptionArea` | `sn`, `date` (YYYY-MM) |
| `year` | `yearProductionAndConsumptionArea` | `sn`, `date` (YYYY) |
| `logview` | (none — writes access log) | `site` |
| `adminlog` | (none — reads access log) | — (gated to `FLOSOL2`) |

**Critical**: All actions must exist in the proxy switch statement. If `status` is missing, the live tab crashes with a 400 error.

**Critical**: The `year` action must pass `date` to the API. Without it the API returns `{"status":false,"message":"no params"}`.

**Debug actions** (used by the Admin page only; safe to keep): `probemonth`, `probemppt`, `vendorsrc`, `viewtest`, `installertest`, `flow`, `rawstatus`, `debug`.

### `dayexcel` — per-MPPT intraday (the day-chart CSV export)
The day endpoint has **no per-MPPT** breakdown. The installer site's day-chart **Download** button hits a signed GET that returns a CSV with `MPPT1/2/3` (V/A/W), per-phase grid/load, battery, etc. at 5-min resolution. `dayexcel` calls it (sign over `{MemberID, inDate, GoodsID}`; **no token needed** — sign-authorized), parses the CSV, and returns `{ rows:[{time, mppt:[w1,w2,w3]}], activeMppts }`. Used only when **one inverter** is selected on the Day tab → production splits into stacked MPPT bands. `memberId` = `site.name` (the end-user MemberID, e.g. `Dotsikas, Konstantinos`).

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
aggregateDayData(all)   — per-inverter responses, keyed by r.inTime; keeps per-inverter series pv{i}/loadNeg{i}
aggregateDayMppt(...)   — single-inverter: merges dayexcel MPPT (pv0/pv1/pv2) with day load/grid/battery/soc
aggregateMonthData(all) — keyed by r.day
aggregateYearData(all)  — keyed by r.month (integer), mapped to Jan/Feb/etc
```

Day view data is in **watts**. Month and year data is in **kWh**.

### !! CRITICAL: month/year production is RECONSTRUCTED, do NOT use the `Production` field
The month/year endpoint's `Production` field is **unreliable** on some inverter firmwares (mode 795 / AIO):
it comes back far too low — even **less than `ConsumedDirectly`**, which is physically impossible. Host,
token, login, and `MemberAutoID` make **no** difference (the consumer `view.midnitepower.com` reads the same
broken field). PV production is physically `ConsumedDirectly + powerToBattery + powerToGrid` (where PV energy
goes), which holds on every inverter — so `rollupProduction(r)` reconstructs it. Battery charge/discharge come
straight from `powerToBattery`/`powerFromBattery` (not a net heuristic). **Never revert month/year production to
`r.Production`.**

### Day summary totals come from the MONTH rollup (so Day == Month exactly)
The Day chart shows the intraday power *shape*, but the Day **summary tiles** (Produced/Consumed/etc.) are read
from `aggregateMonthData(...)`'s entry for that day (`daySummary`), not by integrating power. This guarantees the
Day tab matches the Month tab. Integration (`* 5/60`) is only a fallback when the month rollup is unavailable.

### Load is balance-derived everywhere (`balanceLoad`)
AIO inverters serve the house through a smart/EPS port, so the AC `load` register reads 0. `balanceLoad(d) =
PV + gridImport + batteryDischarge − charge − export` recovers the true house load on all inverter types. Used by
SiteHero, InverterCard, InverterDetailPanel, and the Live flow diagram's Home node.

### Caching
`api()` has a session cache (`_apiCache`) for **historical, immutable** data only (`day`/`dayexcel`/`month`/`year`
where the date is before today/this-month/this-year). Current periods are never cached; live `status` is never
cached. Cleared on logout.

---

## Charts

**Day** is a Recharts **`ComposedChart`** (NOT a bar chart anymore): per-inverter **stacked Areas** —
production above zero (`pv{i}`, blue shades `PROD_SHADES`), consumption below zero (`loadNeg{i}`, orange
`CONS_SHADES`) — plus Grid / Battery net **Lines** and an SOC **Line** on a right axis, a draggable `<Brush>`
for zoom, the custom `DayTooltip` (per-inverter + totals), and the multi-toggle series legend. When exactly one
inverter is selected it renders **stacked per-MPPT** production instead (`dayMode.type === "mppt"`); a note below
the chart prompts this on multi-inverter sites (suppressed on single-inverter sites). The chart takes generic
`prodSeries`/`consSeries` descriptors so the same component handles inverters or MPPTs.

**Month** and **Year** are still `BarChart` (mirrored pos/neg). The bar-prop rules below apply to **them only**.

### !! MONTH/YEAR BAR CHART — DO NOT TOUCH THESE PROPS !!

Recurring regression: every time these get "cleaned up" the bars break. Named constants at the top of `index.jsx`:

```js
const BAR_DAY   = { barCategoryGap: -100,  barSize: 12, barGap: -12 };  // legacy — Day is no longer a BarChart
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

## Live — Power Flow Diagram
Animated SVG (`FlowDiagram`/`FlowNode`/`FlowEdge`) with Solar / Grid / Battery / Home around a center hub; moving
dots (CSS `flowdash` keyframes, `.flow-anim`/`.flow-rev`) show direction. Built from the **same `status` detail
data** as the cards (NOT a second `getHybridFlowgraphRealTimeData` call) so every node matches the cards exactly:
`grid.netW` (+import/−export), battery net (`charge−discharge`), Home = `balanceLoad`. Aggregates the **selected**
inverters (the multi-toggle selector doubles as per-inverter toggles).

## Inverter Selector — multi-toggle
`selectedSns` (array). Each pill toggles in/out (can't deselect the last); **All** selects everything. Applies to
Day/Month/Year/Live. `chartInverters` = inverters whose sn ∈ `selectedSns`; `allSelected` gates the aggregate
Live panels. Effects key on `snKey` (the joined sns).

## Battery Panel
- Capacity kWh uses **nominal 51.2 V** (`capacityAh * 51.2 / 1000`), not live voltage.
- Shows live **rate** (`±%/hr` of rated capacity) and **ETA** (`fmtHrs` → time to full / time remaining), or `Idle`.

## Admin Page (FLOSOL2 only)
- `AdminPanel` renders on the `admin` tab; tab only shown when `isAdmin` (username `FLOSOL2`). `adminlog` is also
  server-gated (`403` otherwise).
- **Access Log**: `logAccess()` records `{type:"login"|"view", user, site, ts}`. `login` action logs logins;
  `logview` action (called from a `useEffect` on `site`) logs site views. `adminlog` reads it back.
- **Persistence**: uses **Vercel KV / Upstash Redis** REST when `KV_REST_API_URL`+`KV_REST_API_TOKEN` (or the
  `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN`) env vars exist; otherwise an in-memory buffer that resets on
  cold start/redeploy. Add the store via Vercel **Storage → Marketplace → Upstash (Redis/KV)** → connect → redeploy.
- **API Debug runner**: generic `action` + JSON-body caller + preset buttons for the debug actions.

## Known Issues / History
- **Month/year "didn't match Day" saga**: root cause was the broken `Production` field (see CRITICAL note above),
  not units or auth. Fixed by `rollupProduction`. The vendor's own consumer site shows the same broken field.
- No per-MPPT **history** endpoint exists on the JSON API (18 names probed → all `405`); per-MPPT day data is only
  available via the **CSV export** (`dayexcel`). Live per-MPPT is in `getInverterStatus` (`photovoltaic.mppts`).

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
