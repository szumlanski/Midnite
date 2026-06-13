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

**Environment variables in Vercel**:
- `MIDNITE_USERNAME` / `MIDNITE_PASSWORD` — legacy fallback only (not used in the SaaS flow).
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase (client auth).
- `SUPABASE_SERVICE_ROLE_KEY` — server-only (proxy reads/decrypts linked accounts).
- `CREDS_ENC_KEY` — 32-byte secret for AES-256-GCM encryption of Midnite passwords. **Never change once accounts are linked.**

---

## Authentication (SaaS)  — see `SETUP_AUTH.md`
The app uses **Supabase Auth** (Google OAuth + email/password, email confirmation OFF). Flow:
1. **App login** (Supabase) → if no Midnite account linked, the **Link your Midnite account** screen.
2. The Midnite password is **encrypted AES-256-GCM** (`CREDS_ENC_KEY`, server-side) and stored in
   `midnite_accounts.enc_password` — plaintext never touches the browser or the DB.
3. `api()` sends the Supabase JWT (`Authorization: Bearer`) + the active `accountId`. The proxy verifies the
   JWT (`getSaasUser`), loads the user's linked account (`getLinkedAccount`, service role), `decryptCred`s it,
   and calls Midnite via `login()`.
- **Role** = `profiles.role` (`'user'` | `'admin'`). `isAdmin` (Admin tab + multi-account) is driven by this,
  NOT by the Midnite username anymore. Make an admin: `update profiles set role='admin' where email=…`.
- **Users**: exactly one linked Midnite account (relink via **Settings**). **Admins**: multiple, with a header
  account switcher (`activeAccountId` in `localStorage.midnite_account_id`). A Midnite account links to one app
  login only (global unique index on `midnite_username_lc`).
- DB schema + RLS in `supabase/schema.sql`. New proxy actions: `accounts` (returns role+email+linked accounts
  +profile+sitePhotos), `linkaccount` (validate→encrypt→insert, enforces one-per-user for role `user`),
  `unlinkaccount`, `updateprofile` (display_name/avatar_url), `setsitephoto` ({site,url}). The old `login`
  action is gone (Supabase handles auth).
- **Settings page** (`AccountSettings` modal, sub-tabs): **Midnite** (link/unlink/switch), **Profile**
  (display name + avatar), **Security** (change email/password via `supabase.auth.updateUser`), **Site Photos**
  (per Midnite-site image). Avatars + site photos upload to **Supabase Storage** public buckets `avatars`/`sites`
  (path `<uid>/…`, write-RLS to own folder); the public URL is saved to `profiles.avatar_url` / `site_photos`
  via the proxy (service role) so clients can't touch `role`. Re-run `schema.sql` after pulling — it adds the
  profile columns, `site_photos` table, buckets, and storage policies (idempotent).

## Midnite accounts (data sources behind the link)
- **End-user (Wise Naples)**: Senergytec API, sees its own site. **Installer (FLOSOL2)**: Eagle API, sees all
  managed sites via `terminaluserinfo`. These are what users/admins *link*; app admin is now a separate role flag.

## Site Data

- **Wise Naples** (reference "good" site): Group ID `47031`; 4 inverters `2426-90190114PH`, `2426-90190151PH`,
  `2426-90190186PH`, `2426-90190187PH`. Feed-in/export metering works correctly.
- **FLOSOL2 manages a fleet** (~8 sites): Wise Naples, Daggett Cayo Costa, Bochan, Mark Gorovoy, Jaime Theobald,
  OffTheHook, GaleanaFrank, **Dotsikas, Konstantinos** (the one with the export-metering quirk — see Known Issues).
- Inverter model in play: `MN 15-12KW-AIO` (AIO = all-in-one; serves house load through a smart/EPS port, so the
  AC `load` register reads 0 — hence `balanceLoad`).

## Current state / handoff (2026-06)
Stable and deployed to `master` (auto-deploys to Vercel). Recent work this cycle: month/year production
reconstruction; Day == Month consistency; Day chart rebuilt as ComposedChart (per-inverter or per-MPPT stacked
areas + lines + zoom brush + per-inverter/total tooltip); multi-toggle inverter selector; balance-derived load;
session caching; battery card (nominal-V capacity + rate/ETA); redesigned Live flow diagram (SVG inverter,
squared connectors, value-relative speed, optional gen/smart-load/AC-couple nodes); **month/year bar alignment
permanent fix** (single `stackId` + `stackOffset="sign"`); Admin page (access log on Vercel KV, energy-register
read-out + fleet scan, full API debug runner + inverter-settings reader); **Explorer tab** (chart any raw inverter
parameter(s) over a date range up to 7 days at 5-min resolution from the expanded `dayexcel` CSV parser; single-select
inverter; auto-spawns a chart per axis-pair). **No open code tasks** — the Dotsikas export issue is diagnosed as
inverter-side and intentionally left alone in the app.

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

**Debug actions** (Admin page only; safe to keep): `probemonth`, `probemppt`, `vendorsrc`, `viewtest`,
`installertest`, `flow`, `rawstatus`, `debug`, `shadow`, `readsettings`, `shadowsweep`, `iotshadow`, `codelookup`.

**`iotshadow`** (salvaged from a parallel session) is a *different* shadow path: the **Aliyun IoT** command
channel — `POST /Aliyuniotapi/iot/setShadowCommand` `{GoodsID, Command, sign}` writes a command into the unit's
Aliyun IoT shadow, then `receiveShadowCommand` `{GoodsID, sign}` reads the device reply. Hypothesis: poking the
shadow forces a fresh telemetry sample (an alternate real-time path to the Eagle `readDeviceShadow` sweep).
**`poke:true` is a WRITE** (default `command:"0"`, effect unverified) — use cautiously.

### Reading inverter settings (device shadow / Modbus registers)
The installer app's Remote-Setting dialog reads/writes inverter parameters via **device-shadow** endpoints.
- **Read all settings** (`readsettings` action): `POST /Eagle/v1/Inverterapi/readDeviceShadow_RA_New_AutoID`
  with `{ AutoId, ModbusArr: "[\"30B0\",\"2122\",…]" (JSON string of hex register codes), Force: 1, sign }`.
  With `Force:1` it returns the values **synchronously** in `r.data.data` (`{code: value}`) plus reachability
  flags in `r.data.status`. `readsettings` ships a default ~164-register set (Power-Control + Grid tabs).
- `getDeviceShadowStatus_RA` returns only ~5 cached status flags (`1A18/1A44/1A45/1A46/1A4E`) — NOT the full set.
- `shadow` action = the quick 5-flag read; `codelookup` searches the installer JS bundle for a code's label
  (note: register labels are NOT in the bundle, so this returns nothing useful — map codes via the UI instead).
- AutoIds seen: Wise INV-1 `65856`, Dotsikas INV-1 `56076`, OffTheHook INV-1 `51398`. Writes would use `setDeviceShadow_WA` — **do not write.**
- **Inverter Settings detail** (`SettingsModal`, opened by a **Settings ›** link on each inverter card / detail panel):
  requests the `SETTINGS_MAP` register codes via `readsettings` and renders a plain-English, grouped list. The
  labels were captured **directly from the Remote-Setting form** (each `<input>` id embeds its register code, e.g.
  `hybridForm_2114` → "Floating Charge Voltage"), so they're certain — not value-guessed. `SETTINGS_MAP` =
  `[{code,label,group,unit?,scale?,enum?,bool?}]`, ~50 numeric settings across Power Control / Generator / Battery /
  General / Grid. **Raw-register scaling**: voltages ×10 (`scale:0.1`), frequencies ×100 (`scale:0.01`),
  power/percent/time ×1. **Omitted** (not certain): enum/dropdown fields (no value→label map) and the 32-bit
  protection-time fields (`5007(5020)` etc., split across two registers). NB: the form labels disproved earlier
  value-guesses — `2183` = "Max Time To Attempt Equalize" (not grid V), `212F` = "Stop Discharge Reconnect Voltage"
  (not battery V) — vindicating the certain-only rule. Dropdown/toggle enums hold **sparse value codes, NOT option
  positions** (Work Mode 0=Self-Consumption/3=Off-Grid; Power Control 0=Disable/3=Smart Meter; Battery Brand
  17=MidNite/33=Lithium-No-BMS; Meter Type 2=DTSU666) — each mapped only from a value confirmed on a real inverter;
  unknown values render `(raw)`. Toggles (`bool:true`) → On/Off.
- **`SettingsCompareModal`** (standalone **⚙ Compare all inverter settings** button under the inverter selector):
  reads `SETTINGS_MAP` for **every** inverter at the site and renders a table (settings = rows grouped by section,
  inverters = columns). Rows whose formatted values differ across inverters are **highlighted amber with a ⚠**;
  a "Differences only" filter collapses to just those. The per-card **Settings ›** modal stays for single-inverter view.
- **`shadowsweep` action** (read-only discovery probe): sweeps a hex code range (`{autoId, from, to, chunk}`,
  ≤2048 codes/call) through the same `readDeviceShadow_RA_New_AutoID` `Force:1` live read and returns every
  code that resolved to a value. Surfaced in **Admin → Live Register Probe** — one **Read all** button sweeps the
  attribute space client-side in 2048-code windows (0x0000–0x6FFF), merges, shows only non-zero registers, and on a
  second run highlights **Δ vs the previous full read** (with a "changed only" filter). A **Match to live status**
  table cross-references each live reading (PV/grid/load/battery power, SOC, SOH, grid+battery V, Hz, temp) against
  the swept registers at sane per-unit scales (config codes excluded) to auto-label candidates. A **Watch power
  block** button polls a focused set (0x3000–0x301F + Hz/temp/batV) every 10s via `readsettings` so register values
  can be read off next to a live power-flow screen (resolves snapshot-timing ambiguity; best done at a site with
  active PV/battery). **Findings so far:** the shadow only exposes a small live set — a power block at 0x3000–0x3003
  (0x3002/0x3003 change on demand), plus rough 0x2562 Hz / 0x2563 temp / 0x212F battery-V. SOC, grid voltage, and
  currents are **not** in the shadow (0x0000–0xFFFF fully swept); they only update on the 5-min cloud report.
  Purpose: find which attribute IDs carry **real-time measurements** (power /
  voltage / current / freq / SOC) so we can offer an on-demand live stream instead of the 5-min cloud cache.
  Note: device-shadow codes (e.g. `0x2100`) are the cloud's **attribute IDs**, NOT raw Modbus addresses; the
  known set is all config — measurement IDs must be discovered empirically (run the probe twice; changing values
  are live). `Force:1` is an on-demand poll through the WiFi dongle (request/response, ~1-3s latency, possible
  rate limits) — near-real-time, not a true push stream.

### `dayexcel` — per-MPPT intraday (the day-chart CSV export)
The day endpoint has **no per-MPPT** breakdown. The installer site's day-chart **Download** button hits a signed GET that returns a CSV with `MPPT1/2/3` (V/A/W), per-phase grid/load, battery, etc. at 5-min resolution. `dayexcel` calls it (sign over `{MemberID, inDate, GoodsID}`; **no token needed** — sign-authorized), parses the CSV, and returns `{ rows:[{time, mppt:[w1,w2,w3], gridV:[L1,L2], gridHz}], activeMppts, header }`. Used only when **one inverter** is selected on the Day tab → production splits into stacked MPPT bands. `memberId` = `site.name` (the end-user MemberID, e.g. `Dotsikas, Konstantinos`).

**Full CSV column layout** (confirmed from the header): `Time, MPPT1, MPPT2, MPPT3, PV, Temperature, E-Today, E-Total, H-Total, Grid1, Normal Load1, Gen Port1, AC OUT(100A)1, Smart LoadB(50A)1, Smart LoadC(30A)1, Grid2, Normal Load2, Gen Port2, AC OUT(100A)2, Smart LoadB(50A)2, Smart LoadC(30A)2, GridFac, LoadFac, GenFac, Feed-In Energy Today, Purchased Energy Today, Consumption Today, Total Feed-In Energy, Total Purchased Energy, Total Consumption, Capacity, BMS_Version, SOC, SOH, BatteryTemp, Battery Current, Battery Voltage, Battery Power, Daily charge energy, Daily discharge energy, Total charge energy, Total discharge energy, smartLoadDay, smartLoadTotal, Outputs Energy Today, Outputs Energy Total`. The real export has a 4-row preamble (`Account`/`Model`/`SN`/blank); the actual column header is **row 5** (`f[0]==="Time"`). Most cells are `"V/A/W"` (parse first field for volts, middle for amps, last for watts) — and the **watt field is signed** (Grid `-410W` = exporting). **Exception: the `PV` column is in kW** (e.g. `"8.31KW"`), so PV-power is taken from the per-MPPT watt sum, not that column. Other cells carry unit suffixes parsed away by `numOf` (`kWh`, `HZ`, `℃`, `%`, `Ah`, `Hrs`). `Grid1`/`Grid2` = the two grid legs' **line-to-neutral voltage** (split-phase 120/240 V → ~120 V each leg); `GridFac` = grid frequency. The proxy locates columns **by header name** (with positional fallbacks) via the `ix(name,fallback)` helper — never hard-code indices.

`dayexcel` returns, per 5-min row: the legacy `mppt[]`/`gridV[]`/`gridHz` (Day chart) **plus a flat metric map** and a **`metrics` catalog** (`[{key,label,unit,group}]`). Every AC port (`mppt1-3`, `gridL1/2`, `loadL1/2`, `acOut1/2`, `smartB1/2`, `smartC1/2`, `genL1/2`, `bat`) is a `"V/A/W"` cell broken out into `{key}V` / `{key}A` / `{key}W`; plus frequencies (`gridHz/loadHz/genHz`), `soc/soh/capacity`, `temp/batTemp`, and the **cumulative counters** both daily (`eToday`, `consumptionToday`, `feedInToday`, `purchasedToday`, `chargeToday`, `dischargeToday`, `outputToday`, `smartLoadToday`) and lifetime (`eTotal`, `totalConsumption`, `totalFeedIn`, `totalPurchased`, `totalCharge`, `totalDischarge`, `outputTotal`, `smartLoadTotal`, `hTotal`). Parse helpers: `vOf` (first `/` field = volts), `aOf` (middle = amps), `wOf` (last = watts), `numOf` (scalar columns). The **full catalog is returned regardless of zero values** (gen/smart-load/unused legs stay selectable) — only a column entirely absent from the CSV variant is dropped. This feeds the **Explorer** tab (below).

### Explorer tab — chart any parameter(s) over a date range (5-min resolution)
A dedicated **Explorer** tab (**after Year**) renders `ExplorerChart`: pick any raw inverter parameters from grouped chips (Power / Voltage / Current / Frequency / Battery / Temperature / Energy today / Energy lifetime; **Select all** + **Clear**) and plot them at 5-min resolution over a **date range up to 7 days** (From/To pickers + `‹ ›` paging, clamped to ≤7 days and not into the future; each day's rows tagged `_date`, concatenated, metric catalog unioned). **Single inverter** (the CSV is per-inverter): on this tab the inverter selector is **single-select** (`InverterSelector single` — no "All", picking one replaces the current), defaulting to the first inverter. Each chart holds **two distinct units** (left + right axis); selecting parameters in a 3rd/4th unit **spawns additional charts below** (units chunked in pairs, in selection order). Multi-day x-labels are `M/D HH:MM`. Colors from `EXPLORER_COLORS` (by catalog index). The `dayexcel` cache is shared with the Day tab's MPPT/grid-voltage consumers (legacy `mppt`/`gridV`/`gridHz` fields retained).

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

### !! MONTH/YEAR BAR ALIGNMENT — THE PERMANENT FIX !!

Recurring regression: the up (production) and down (consumption) bars render **side-by-side** instead of
flush over the zero line. The bulletproof fix is already in place and must stay:

**Every `<Bar>` (positive AND negative) shares ONE `stackId="a"`, and the `<BarChart>` MUST set
`stackOffset="sign"`.** With `stackOffset="sign"` Recharts stacks positives upward from 0 and negatives
downward from 0 at the *same* x — aligned, and each series keeps its own colour. **Without `stackOffset="sign"`
the default cumulative stacking draws the negative (orange consumption) bar *over* the positive (blue
production) one — production disappears.** Both pieces are required together.

```js
const BAR_MONTH = { barCategoryGap: "20%", maxBarSize: 22 };
const BAR_YEAR  = { barCategoryGap: "20%", maxBarSize: 44 };
```

- **DO NOT** split positives and negatives into separate stackIds (`"pos"`/`"neg"`). Different stackIds become
  side-by-side groups → misalignment. This was the old bug; the `barGap = -barSize` hack that "fixed" it was
  fragile and broke whenever sizing changed. The single shared stackId needs no `barGap`/`barSize` tricks.
- Day is a `ComposedChart` (areas/lines), so this does not apply to it.

**Other invariants that must never change:**
- Each `<Bar>` must have `activeBar={false}` — prevents white hover box (Recharts 3.x bug)
- `<Tooltip>` must have `cursor={false}` — same reason
- Do NOT add `verticalPoints` to `<CartesianGrid>` — causes misalignment
- Month/year use `consumptionNeg: -(d.consumption||0)` etc. to render below zero — do NOT use ComposedChart

### !! CHART COLORS — DO NOT CHANGE WITHOUT AN EXPLICIT REQUEST !!
The palette is intentional and consistent across the app. **Never recolor a chart/series as a side effect of a
redesign.** (A Day-chart redesign once silently changed grid → teal and battery → amber; it had to be reverted.)
The canonical series colors:
- Production / Solar = **blue** `CHART_PROD #3B82F6` (Day shades lead with this in `PROD_SHADES`)
- Consumption / Load = **orange** `CHART_CONS #F97316` (`CONS_SHADES`)
- Battery = **green** `CHART_BAT #22C55E` / `BAT_LINE`
- Grid = **gray** `CHART_GRID #94A3B8` / `GRID_LINE`
- SOC = green `SOC_LINE #16A34A`

If a color genuinely needs changing, confirm with Jason first.

---

## Live — Power Flow Diagram
Animated SVG (`FlowDiagram`/`FlowNode`/`FlowEdge`/`InverterGraphic`). Solar (top-left), Grid (top-right),
Battery (bottom-left), Home (bottom-right) around a center **SVG inverter cabinet** (`InverterGraphic`, a drawn
white unit — NOT a photo; user explicitly chose the SVG). Connectors are **squared/orthogonal elbows** (not
diagonal). Moving dots (CSS `flowdash` keyframes, `.flow-anim`/`.flow-rev`); **dot speed ∝ watts**
(`animationDuration = clamp(4000/|W|, 0.3, 3)s` — 10kW flows 2× faster than 5kW).
- Built from the **same `status` detail data** as the cards (5-min) so every node matches: `grid.netW`
  (+import/−export), battery net (`charge−discharge`), Home = `balanceLoad`. Aggregates the **selected**
  inverters; `flow.count` drives a **×N badge** on the inverter.
- **Real-time overlay (`flowrt` / getHybridFlowgraphRealTimeData):** on the Live tab a 5s poll of `flowrt`
  per selected inverter overlays live power onto `flowAgg` and `SiteHero` (only when a reading exists for
  **every** selected inverter, else falls back to 5-min `status`). A **LIVE** pulse shows on the flow header +
  hero. This endpoint **is** genuinely live: `SystemTime` ticks per second, the values refresh ~every 5s
  (verified by 1s logging) — the first poll can return one stale (cached) sample, then it goes live.
  **AIO/EPS handling (critical):** on AIO units the house is served through the **EPS** port, so `loadCurrpac`
  reads **0** and the real house load is in **`epsCurrpac`** — Home = `load>0 ? load : eps`. Battery net is
  **balance-derived** (`pv + grid + gen − load`) because the live `Pbat` sign is unreliable; live `SOC` can come
  back `0`, so fall back to the 5-min status SOC when live SOC ≤ 0. Getting Home right (= eps) also makes the
  smart-load node auto-suppress, since the smart-port reading IS that EPS house load (don't show it twice).
  Note: `flowrt` `SystemTime` can be **12h off** (inverter clock) — cosmetic. (Device-shadow registers do NOT
  carry real-time telemetry — only this flow endpoint does.)
- Node text sits on the side **away** from the inverter (`place="above"` top nodes / `"below"` bottom) so
  connectors never cross labels.
- Grid icon = drawn **transmission pylon** (`gridPylon`, passed via `iconSvg`), not a bank emoji.
- **Optional nodes** appear only when active (>20 W): **Generator** (top-center, from `gen` smart-port power),
  **Smart Load** (bottom-center) and **AC Couple** (left). Smart Load is **suppressed when it ≈ Home**
  (`|smartLoad − load| < max(80, load*0.1)`) — on AIO units the house is served through a smart port, so the
  reading IS Home and must not be shown twice.

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
- **Energy Registers read-out**: per-inverter table (Grid now, Export today/total, Import today, PV today/total)
  from the live `status` feed, with a ⚠ flag = **exporting now but Export-Today ≈ 0** (stuck feed-in counter).
- **Scan all sites**: sweeps every managed site's live status and flags ones exporting but logging ~0 feed-in.
  Only meaningful while a site is **actively exporting** (run midday ET); "idle ✓" just means "can't tell now".
- **API Debug runner**: generic `action` + JSON-body caller + preset buttons (incl. `Read settings`,
  `Device shadow`, `Lookup codes`) for the debug actions.

## Known Issues / History
- **Month/year "didn't match Day" saga**: root cause was the broken `Production` field (see CRITICAL note above),
  not units or auth. Fixed by `rollupProduction`. The vendor's own consumer site shows the same broken field.
- No per-MPPT **history** endpoint exists on the JSON API (18 names probed → all `405`); per-MPPT day data is only
  available via the **CSV export** (`dayexcel`). Live per-MPPT is in `getInverterStatus` (`photovoltaic.mppts`).
- **Dotsikas zero-export (RESOLVED — inverter-side, not the app)**: the Dotsikas site (Naples FL) shows **0
  grid export** in month/year (and the stuck ⚠ flag) even though it clearly exports (the day feed `powerToGrid`
  is correct). Cause: the inverter's **feed-in energy counter is frozen** (Total Feed-In stuck; the day CT reads
  export instantaneously but the energy register doesn't accumulate). The monthly/yearly API faithfully reports
  that 0 — verified by comparing the raw `monthProductionAndConsumptionArea` for Dotsikas (all `powerToGrid:0`)
  vs Wise (correct). A full **164-register settings diff** (Dotsikas `56076` vs Wise `65856`) showed the **only**
  differences are the **generator configuration** (`2122=1` vs 0, `2156=1` vs 0, plus gen power/SOC params
  `2125/2126/2129`); every grid/feed-in/meter register is identical. So a generator-config flag (likely
  "Generator on grid side") gates feed-in accounting. **Fix is on-site only** (changing gen settings needs the
  inverter in standby — not remote). **Decision: do nothing in the app** — Day/Month/Year all show the honest `0`
  from the rollup (consistent). When a tech fixes it on-site, re-run Admin → Scan all sites to confirm. The day
  feed has the real export if an integrated workaround is ever wanted (rejected for now — "not changing the whole
  app over one site").

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
