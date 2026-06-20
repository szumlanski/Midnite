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
Stable and deployed to `master` (auto-deploys to Vercel). **This session** added the **SaaS auth layer**
(Supabase Google+email login, encrypted linked Midnite accounts, role-based limits, Settings page) on top of
the prior monitoring features. Full feature set now: month/year production reconstruction; Day == Month
consistency; Day ComposedChart (per-inverter/per-MPPT areas+lines+zoom); multi-toggle inverter selector;
balance-derived load; session caching; battery card; redesigned Live flow diagram; **month/year bar alignment
fix** (single `stackId` + `stackOffset="sign"`); Admin page (KV access log, energy-register read-out + fleet
scan, API debug runner, device-shadow probes); **Explorer tab** (chart any raw inverter parameter over ≤7 days
at 5-min res); **real-time Live overlay** (`flowrt`/getHybridFlowgraphRealTimeData, 5s poll, EPS-aware Home,
balance-derived battery); **per-inverter Settings ›** + fleet **Compare** (CSV export) from device-shadow
registers (`SETTINGS_MAP`, certain mappings only); **SaaS auth** (see Authentication section + `SETUP_AUTH.md`).
- **Ops note (this session):** a `/api/midnite` 500 spike came from per-request Midnite logins under 5s/1s
  polling → fixed with `loginCached` (4-min token cache) + graceful 409 on decrypt failure. Build marker
  (commit+time) shows at the top of the Admin panel to tell deploy-vs-cache.
- **Google login** is gated behind `NEXT_PUBLIC_GOOGLE_AUTH=1` (email-only until set).

### OPEN / PENDING
- **Notifications & alerts system** — ✅ **BUILT** (see the **Notifications / Alerts** section below). Per-device
  email threshold alerts + a 15-min heartbeat cron, portable `DeviceSnapshot` + pure engine, RLS tables, daily
  cap, Settings → Notifications UI with CRUD + test-send. Delivery via **Resend** (`RESEND_API_KEY`); cron secured
  by `CRON_SECRET`.
- **Daily digest email** — ✅ **BUILT** (see the **Daily Digest** section below). A morning recap of yesterday's
  performance (KPIs + hourly production/consumption chart + 7-day comparative trend + battery/self-sufficiency),
  rendered as **email-safe HTML** (no SVG — Gmail strips it). Per-user configurable send time + timezone; hourly
  cron (`/api/notifications/digest`). Settings → Notifications has the toggle + Send-test.
- **Recommended before paying customers:** security pass on the auth + `CREDS_ENC_KEY` encryption + RLS path.
- **Nice-to-have:** surface site photos beyond Settings (site header / Sites picker).

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
`installertest`, `flow`, `rawstatus`, `debug`, `shadow`, `readsettings`, `shadowsweep`, `iotshadow`, `codelookup`,
`rtsweep`.

**Real-time data exploration** (read-only): the live power-flow path is already `flowrt`
(`getHybridFlowgraphRealTimeData`) — a synchronous query down the dongle's persistent Aliyun-IoT link, ~5s
refresh (the device's own sampling ceiling; 1s polling returns duplicates). To hunt for anything faster:
`vendorsrc` (crawls the vendor site's **public** JS bundles — no login needed — now also reports `streaming`
= any WebSocket/SSE/socket.io/signalr/mqtt transport + `realtimeContext` = how the flow graphic is fed/polled)
and **`rtsweep`** (`{serial}`, uses the installer token: probes ~22 candidate real-time endpoint names × Eagle/
Senergytec, flags any returning power-ish data, "interesting" hits first). Device-shadow is NOT a faster path
(only a partial 0x3000 power block, no live SOC/grid-V).

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
- **Capacity Mode (SOC vs Voltage) — conditional battery setpoints:** the battery charge/discharge setpoints exist
  as BOTH an SOC-% set and a Voltage set; register **`2124` "Capacity Mode"** (`0`=SOC %, `1`=Voltage) selects which
  is active. `SETTINGS_MAP` tags each setpoint `mode:"soc"` or `mode:"voltage"` and the Settings modal +
  Compare table show only the set matching that inverter's `2124` (mode-independent rows — power limits, equalize,
  protection — always show). SOC codes: `211B` Discharge To, `2119` Charge To, `2144`/`2145` Start/Stop Recovery,
  `214A` Discharge End SOC. Voltage twins: `2113`/`2114`/`2180`/`2146`/`2147`/`214B`. Codes captured from the
  Remote-Setting form input ids (`hybridForm_211B` etc.) — certain, not guessed. (Battery **Capacity** `2112` was
  dropped: not a reliable register, and capacity is a live BMS value shown on the Battery card, not a config.)
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

## "Last updated" freshness indicators (data delay, NOT fetch time)
Every Live-tab surface shows how stale its data actually is, from the inverter's REPORT time — never our fetch
time. Two chips: **`UpdatedChip`** (`ageMin(lastUpdateTime)` = the 5-min `DataTime`, "Updated Xm ago", amber
>10 min) on the 5-min surfaces (inverter cards, battery card, hero/flow when not live); **`LiveChip`** (seconds,
self-ticking each 1s, green ●) on the live `flowrt` surfaces (hero PV + flow when the LIVE overlay is active).
`liveUpdatedAt` is stamped only when a flowrt sample's `SystemTime` genuinely ADVANCES (a new report), not on
every poll — so duplicate polls let the "Xs ago" honestly grow and it's timezone-robust (browser clock, not the
inverter's unreliable clock). Age helpers (`ageMin`/`fmtAge`) compare ET wall-clock via `Date.UTC` so the tz cancels.

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
- **Optional nodes** appear only when active (>20 W): **Generator** (top-center), **Smart Load** (bottom-center)
  and **AC Couple** (left). Smart Load is **suppressed when it ≈ Home** (`|smartLoad − load| < max(80, load*0.1)`)
  — on AIO units the house is served through a smart port, so the reading IS Home and must not be shown twice.
- **Live gen + smart-load source (important):** in the live overlay, **gen and smart-load come from the 5s
  `flowrt` feed, NOT the 5-min `status`** (the 5-min smart-port values were phantom — e.g. a 25.8 kW "GEN" on an
  idle generator, an 8 kW "SMART LOAD" that was really the EPS house load). Gen = `flowrt.genCurrpac`; smart-load
  shows only a **genuine separate** EPS/backup load (`load>0 AND eps>0`) — zero on AIO units where the EPS port
  IS the house (folded into Home). **Smart loads are not a live signal** (`flowrt` carries no smart-port
  breakdown); that detail stays in the 5-min cards/Day/Explorer. **Generator-on-a-smart-port assumption:** when a
  smart port is configured as "generator input", we assume the inverter reports its power in `flowrt.genCurrpac`
  (the vendor's real-time flow field), so a running gen shows live and reads 0 when off. (Unverified — no gen has
  run during testing. If a future `flowrt` sample shows `genCurrpac:0` while a smart-port gen is running, the
  fallback is to derive gen from the live balance `gen = home − pv − grid − battery_net`, using `Pbat` magnitude
  with the sign from the SOC trend.)
- **Last-complete-snapshot:** when a `flowrt` poll doesn't cover every selected inverter, the diagram reuses the
  last poll where **all** inverters reported (cached per selection) rather than dropping to partial sums or the
  5-min status — old-but-correct over new-but-invalid. Only the cold start (before any complete live snapshot)
  uses the 5-min status.

## Inverter Selector — focus-then-subset
`selectedSns` (array), defaults to all. **Tap behavior** (`toggleInv`): when *all* are selected (the default
aggregate), the first tap **focuses** to just that inverter; once narrowed to a subset, taps add/remove to build
a custom set (can't remove the last). **All** reselects everything. Applies to Day/Month/Year/Live. `chartInverters`
= inverters whose sn ∈ `selectedSns`; `allSelected` gates the aggregate Live panels. Effects key on `snKey` (the
joined sns). (Explorer uses `InverterSelector single` → `onPick`, unaffected.)

## Fleet View (`FleetView`, multi-site accounts only)
A fleet-management page that **replaces the Sites picker** for multi-site accounts (`authState==="fleet"`; the
`"sites"` route also aliases to it; `SiteSelector` is retained but unused). Routing lands multi-site accounts here;
a **⊞ Fleet** header button (and `openFleet()`) returns to it; the back arrow shows only when a site is selected.
Per site it fetches **both** `status` (5-min: SOC, energy-today, freshness, online-detection) **and** `flow` (live
5s power — the only feed that captures EPS/generator pass-through load) in parallel; first-load skeletons only,
background refresh keeps data. **Online = the live `flow` per-inverter `online` flag** (the API returns stale cached
data for offline sites, so "returned data" wrongly showed offline sites online — Daggett); power is summed from
ONLINE flow readings (offline → blank); load is EPS-aware (`load>0?load:eps`). **Sortable table on all widths**
(horizontal scroll on mobile — the card layout was reverted by preference). Columns: Site, **Status**
(Offline/Partial/Online from the flow flag, ranked so problems sort first), PV Now, Load, Battery SOC (+arrow),
Grid, PV Today, Exported, **Updated**. KPI summary (Sites/Online/Need-Attention/Fleet-PV-Now/Today; first three are
clickable filters), search, All/Online/Issues, sticky totals footer, CSV export, ↻ refresh + 2-min auto-refresh,
click-through to a site.

## Site Sharing (per-site, view-only) — `site_shares`
An owner shares ONE of their sites with someone by email; **credentials never move** — the proxy fetches the shared
site using the OWNER's stored creds (service role), scoped to the shared site only. **Schema:** `site_shares`
(owner_user_id, owner_account_id, site_name, shared_with_email, shared_with_user_id (null until signup), status
pending|active|revoked) in `supabase/schema.sql` — RLS lets the owner + recipient read. **Proxy:** `resolveAccount()`
accepts an accountId that's the user's OWN account or one **shared to them** (returns `sharedSites`); `loadSites`
extracted + `loadSitesCached` (3-min) reused by the `sites` action and scoping; `SHARED_ALLOWED` gates which actions
a viewer may call and `assertSharedScope` rejects serials/sites outside the share; write/admin actions blocked.
Actions: **`share_create`** (looks up recipient by email → active share + `buildShareMessage` email, or pending
invite + `buildShareInviteMessage` via Resend), **`share_list`** (outgoing+incoming), **`share_revoke`**; the
`accounts` action **claims pending invites** for this email on load and returns `sharedAccounts`. **UI:** a per-site
**↗ Share** header button (`ShareModal`) + a central **Settings → Sharing** tab (`SharingSettings`: share any site,
manage/revoke, see incoming). Shared accounts appear in the **account switcher** (shown when own+shared > 1);
selecting one loads its shared sites; a **SHARED · view-only** badge shows and the Admin tab + Share button hide.
`loadContext`/`reloadAccounts` consider shared accounts so a recipient with no linked account of their own lands on
their shared sites. Degrades gracefully (no shared accounts, "run schema.sql" hints) until the table exists.

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

## Notifications / Alerts
Per-device threshold alerts (email) evaluated by a scheduled heartbeat. **A "device" = an inverter (by `sn`).**

**Architecture (portable by design):** all vendor specifics end at a normalized **`DeviceSnapshot`**; rule
evaluation is a **pure function** over it (zero API knowledge), so the system would port to a different app by
swapping only the snapshot builder. The **trigger taxonomy is the single source of truth** that drives the UI
form, server validation, and the DB CHECK constraint together (they can't drift).

**Files:**
- `lib/notifications/triggers.js` — canonical trigger metadata (`TRIGGERS`, `TRIGGER_TYPES`, `triggerGroups()`).
  Isomorphic (imported by the UI **and** the server). The schema CHECK mirrors `TRIGGER_TYPES`; `alertrule_save`
  also validates against it at write time.
- `lib/notifications/snapshot.js` — `buildSnapshot(normalizedStatus)` → flat metric map (the portability boundary).
- `lib/notifications/engine.js` — `evaluateRule()` / `describeRule()` / `summarizeRule()`, **pure**.
- `lib/notifications/deliver.js` — `send()` channel wrapper (Resend email; **no-ops safely** if unconfigured) +
  branded message builders. Channel is abstracted for future SMS/push.
- `lib/notifications/server.js` — `evaluateNotificationsForDevice()` (entitlement → load rules → cooldown →
  daily cap → send → stamp `last_triggered_at` **only on success** → audit log), `persistSnapshot()`,
  `minutesSinceOnline()` (offline from the **snapshot time-gap**, never the API's health claim), `isEntitled()`.
- `lib/midniteServer.js` — frozen copies of the proven Midnite sign/login/post/normalize helpers, so the
  high-traffic `pages/api/midnite.js` stays untouched. (Source of truth for that logic is still `midnite.js`.)
- `pages/api/notifications/heartbeat.js` — shared-secret cron: per device → login → fetch → snapshot → persist →
  evaluate. `vercel.json` runs it every 5 min (`*/5 * * * *`).

**Triggers** (derived only from metrics this app exposes): battery SOC below/above, SOH below, battery temp above,
inverter temp above, house load above, grid import/export above, grid voltage above/below, **PV produced today
below** (time-gated, e.g. only after 18:00), and **device offline** (heartbeat gap).

**Proxy actions** (in `midnite.js`, before the Midnite-login step — DB/email only): `alertrules` (list + cap usage
+ `emailConfigured`), `alertrule_save` (create/update, validates trigger + account ownership), `alertrule_delete`,
`alerttest` (sends a sample to your account email — verifies delivery), `alertlog`.

**UI:** Settings → **Notifications** sub-tab (`NotificationsSettings`/`RuleForm` in `index.jsx`) — per-device rule
list with enable/disable/delete, an add-form generated from the trigger metadata, a **Send test** button, and a
"today: N/cap sent" line. Banner warns if email isn't configured yet (rules still save + evaluate).

**Schema** (idempotent, appended to `supabase/schema.sql` — **re-run after pulling**): `notification_rules`,
`notification_log`, `device_snapshots` (time-series for offline detection), `notification_quota` + the atomic
`notif_quota_increment()` RPC (daily cap), and `notification_digests` (now the live daily-digest config —
`send_hour`/`timezone`/`site_name`/`last_sent_date` columns added idempotently). All RLS-gated to the owning
user; all writes go through the service-role proxy + heartbeat/digest crons.

**Email transport (`lib/notifications/deliver.js`) — first configured wins:**
1. **SMTP** (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`, optional `SMTP_SECURE`) — any SMTP relay; **needs no
   domain verification**, so it's the pre-launch "send now" path. Gmail/Google Workspace: `SMTP_HOST=smtp.gmail.com`,
   `SMTP_PORT=465`, `SMTP_USER=you@floridasolardesigngroup.com`, `SMTP_PASS=<16-char Google App Password>` (requires
   2-Step Verification on the Google account; create at myaccount.google.com → Security → App passwords). Nodemailer
   is lazy-imported so it never reaches the client bundle.
2. **Resend** (`RESEND_API_KEY`) — used only if SMTP isn't set. Needs a **verified domain** to email arbitrary
   recipients; `onboarding@resend.dev` (the default From) only reaches your own Resend-account email. Note: the
   Resend sending domain is **independent of the app's host** — verify any domain you own (e.g.
   `floridasolardesigngroup.com`) and set `ALERTS_FROM_EMAIL`; the Vercel subdomain is irrelevant.

**Env vars (Vercel):** the transport vars above, plus
`ALERTS_FROM_EMAIL` (e.g. `Midnite Sentinel <alerts@yourdomain>`; for SMTP, Gmail rewrites the From to the
authed user unless it's an allowed Send-As alias; defaults to `SMTP_USER` then Resend's onboarding sender),
`CRON_SECRET` (protects the heartbeat; Vercel Cron sends it as `Authorization: Bearer`), optional
`ALERTS_DAILY_CAP` (default 50) and `NEXT_PUBLIC_APP_URL` (email link). **Entitlement** = all signed-in users
(centralized `isEntitled()` — flip to paid later without touching the engine). **Note:** sub-daily Vercel Cron
(e.g. `*/5`) needs a **Pro** plan (Hobby = daily only); on Hobby, point any external cron at
`/api/notifications/heartbeat` with the secret instead.

---

## Daily Digest (morning recap email)
A configurable per-user **daily digest** email that recaps **yesterday's** performance with charts. Built on top
of the notifications infra (same `deliver.js` transport — SMTP or Resend — + `CRON_SECRET`). **A "digest" = one config row per user**
(`notification_digests`, keyed `user_id,frequency='daily'`).

**Architecture (mirrors the alerts split — pure core, impure shell):**
- `lib/notifications/digest.js` — **pure** compute + render. `computeSiteDigest({siteName,dateStr,dayResponses,
  monthResponses,prevMonthResponses})` → a per-site model (KPIs, hourly profile, 7-day trend, comparisons);
  `renderDigestEmail({dateLabel,sites,totals,appUrl})` → `{subject,html,text}`; `sumTotals()`. **Charts are
  email-safe HTML tables + fixed-pixel-height `<div>` bars — NEVER inline SVG (Gmail strips SVG).** Reuses the
  `rollupProduction` identity (never trusts the broken `Production` field) and matches the app's chart palette.
- `lib/notifications/digestServer.js` — **impure** orchestration shared by the cron + the test action.
  `buildDigest({auth,dateStr,tz,siteFilter})` fetches per inverter and computes; `buildAndSendDigest({acct,to,tz,
  siteFilter,force})` does login→build→send. Timezone helpers (`yesterdayInTz`/`ymdInTz`/`hourInTz`). Caps a
  fleet digest at `MAX_SITES=12`; skips dead sites (no production/consumption/intraday). `force:true` (test)
  with no data still sends a friendly "delivery works, no data yet" note.
- `lib/midniteServer.js` — added `fetchSites` (installer terminaluserinfo / enduser GroupList→InverterList →
  `[{name,memberAutoId,serials}]`), `fetchDay` (`dayProductionAndConsumptionAreaTime`, WATTS), `fetchMonth`
  (`monthProductionAndConsumptionArea`, kWh) — frozen copies of the proxy logic.
- `pages/api/notifications/digest.js` — **hourly** cron (`vercel.json` → `0 * * * *`), `CRON_SECRET`-gated like
  the heartbeat. Sends to each enabled config whose `send_hour` == current hour **in its `timezone`** and whose
  `last_sent_date` ≠ today (idempotent). `?dry=1` previews which configs are due without sending.

**KPIs per site (yesterday):** Produced / Consumed / Exported / Imported (from the **month rollup** → matches the
app's Day==Month invariant), Peak PV (kW, from intraday), Self-sufficiency %, battery charged/discharged + SOC
range, plus **▲/▼ deltas vs the previous day and vs the 7-day average**. **Charts:** an hourly produced-vs-consumed
bar chart (intraday energy, kWh/hr) and a 7-day produced-vs-consumed trend; horizontal bars for SOC + self-suff.

**Proxy actions** (DB/login as noted, before the data-action login block): `digest_get` (config + `emailConfigured`),
`digest_save` (upsert config — enabled/send_hour/timezone/site_name; verifies account ownership), `digest_test`
(builds + sends a **real** digest to your account email **now**, `force:true`).

**UI:** Settings → **Notifications** → a **☀ Daily digest** card at the top (`DigestSettings` in `index.jsx`):
enable toggle, send-time (`hourLabel12`), timezone (`DIGEST_TZS`, preselects the browser tz if recognized),
coverage (All sites / current site), **Save** + **Send test digest**. Threshold alerts now sit below under a
"Threshold alerts" heading.

**Env vars:** reuses `RESEND_API_KEY` / `ALERTS_FROM_EMAIL` / `CRON_SECRET` / `NEXT_PUBLIC_APP_URL`. Same Pro-plan
caveat for sub-daily cron — the hourly digest cron is fine on Pro; on Hobby point an external hourly cron at
`/api/notifications/digest` with the secret.

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
