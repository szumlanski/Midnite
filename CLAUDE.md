# Midnite Solar Dashboard — Project Knowledge

**Site**: Wise Naples | **URL**: https://midnite-rose.vercel.app | **Repo**: https://github.com/szumlanski/Midnite
**Project path on Jason's Mac**: `~/midnite/midnite/` (note: nested — git root is `~/midnite/`, Next.js project is `~/midnite/midnite/`)

---

## Architecture

- `pages/index.jsx` — React frontend dashboard
- `pages/api/midnite.js` — Next.js serverless proxy (handles auth + API signing)
- No `vercel.json`. No `output: standalone`. Standard Next.js build. Framework preset = Next.js.
- Deployment protection is OFF in Vercel settings.

**Environment variables in Vercel**:
- `MIDNITE_USERNAME` = `FLOSOL2`
- `MIDNITE_PASSWORD` = `921551`

---

## Site Data

- Group ID: `47031`
- 4 inverters: `2426-90190114PH`, `2426-90190151PH`, `2426-90190186PH`, `2426-90190187PH`
- Dealer account credentials: FLOSOL2 / 921551

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

### Login

```
POST /Senergytec/web/v2/Inverterapi/UserLogin
Body: { MemberID, Password, type: "1", remember: false, sign }
Returns: { token, MemberAutoID }
```

Note: field is `MemberID` not `memberID` or `Account`.

### Proxy Actions (`/api/midnite?action=X`)

| Action | Endpoint | Required body fields |
|--------|----------|----------------------|
| `status` | `InverterDetailInfoNewone` | `serials: string[]` |
| `day` | `dayProductionAndConsumptionAreaTime` | `sn`, `date` (YYYY-MM-DD) |
| `month` | `monthProductionAndConsumptionArea` | `sn`, `date` (YYYY-MM) |
| `year` | `yearProductionAndConsumptionArea` | `sn`, `date` (YYYY) |

**Critical**: All four actions must exist in the proxy switch statement. If `status` is missing, the live tab crashes with a 400 error and the whole app breaks with `Cannot read properties of undefined (reading 'lines')`.

**Critical**: The `year` action must pass `date` to the API. Without it the API returns `{"status":false,"message":"no params"}`.

### Response field names

- Day: `r.inTime`, `r.Production`, `r.Consumption`, `r.powerFromGrid`, `r.powerToGrid`, `r.SOC`
- Month: `r.day`, `r.Production`, `r.Consumption`, `r.powerFromGrid`
- Year: `r.month` (integer 1-12), `r.Production`, `r.Consumption`
- All wrapped in `{ Data: [...] }`

### normalizeDetail()

The `status` action must call `normalizeDetail(raw, sn)` before returning. The frontend `InverterCard` and `AggregateBar` components access `data.load.lines`, `data.grid.lines`, etc. If raw data is returned without normalization, the app crashes.

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

## Known Issues / History

### Bar alignment in charts
The month and year charts use `consumptionNeg: -(d.consumption||0)` to render consumption bars below zero. This is the correct approach. Do NOT switch to ComposedChart or stackId approaches — they break the data entirely.

### verticalPoints prop
The original working charts had `verticalPoints={[0]}` on `CartesianGrid`. This caused misalignment. Remove it. Use plain `<CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>`.

### White hover bar
Add `activeBar={false}` to each `<Bar>` component to remove the white highlight on hover.

---

## Deployment Rules

1. Never add `vercel.json` unless you know exactly why.
2. Never set `output: 'standalone'` in `next.config.mjs`.
3. Never set Root Directory in Vercel settings — the project IS the root.
4. Framework preset in Vercel must be **Next.js**, not "Other".
5. After any Vercel settings change, redeploy from the Vercel dashboard.
6. Always hard refresh (Cmd+Shift+R) after a new deployment.

---

## File Delivery to Jason

Claude cannot write directly to Jason's Mac filesystem. Workflow:
1. Create files at `/mnt/user-data/outputs/`
2. Use `present_files` to surface them
3. Jason downloads and runs `cp ~/Downloads/filename path/in/project`
4. Jason runs `git add`, `git commit`, `git push`

Always give Jason the exact bash commands to run, one block, copy-paste ready.
