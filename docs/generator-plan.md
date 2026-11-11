# Generator control for Midnite Sentinel

## Context
Midnite Sentinel is view-only today. Jason wants FourScoped's generator features in Midnite:
- FourScoped's **simple user controls** (`eg4-monitor/app/dashboard/generator/page.tsx`): start/stop with a liability disclaimer and a confirm step, weekly exercise schedules, one-off runs, recent activity.
- The **comm hub's detailed controls** (`eg4-monitor/app/hub/[slug]/*`): master switch, battery-level time windows with priority, scheduled runs, Run now (hours + minutes cap, optional stop-at %), start/stop alerts by email and push, run history.

Rules from Jason:
- Only sites that an admin turns on get the feature.
- **Every user who can open the site can control it. This includes view-only share recipients.**
- The activity log belongs to the site, not to one user.
- Midnite users get a prompt to install the web app (PWA).
- Pilot site: **OffTheHook**. **Master inverter: `2452-40920023PH`** (Jason). We will write inverter registers. Master AutoId is `51400` (portal capture); `51398` is INV-1, not the master.

The big difference from FourScoped: the hub's low-battery logic runs on an ESP32 at the site, and Midnite has no such box. So either Sentinel's server runs the logic and writes registers, or we program the inverter's own auto-start settings. Phase 0 settles which one.

## Phase 0: Find the write path (OffTheHook, Jason + me)
Nothing gets built until one register write is proven safe.
1. **Jason captures from the installer portal Remote-Setting dialog** (DevTools → Network → "Preserve log"), on OffTheHook:
   - The request sent when he saves one harmless generator setting, for example "Generator Max Run Time" (`2136`). We need the URL, the full JSON body (including how `sign` is built) and the response.
   - Every generator control on that form: the input ids (`hybridForm_XXXX`), dropdown option values, and any "Generator start / force on / manual" button with its request.
   - The register that shows whether the gen relay is closed, if one exists.
2. I add an admin-only `genwrite` debug action in `pages/api/midnite.js`. It allows one register from an allow-list, then reads the value back with `readDeviceShadow_RA_New_AutoID` `Force:1`. First test: write `2136` to its current value (no change), then to a new value and back.
3. Confirm how we see "generator running": `flowrt.genCurrpac`, plus gen V/Hz from status and the CSV `genL1/genL2/genHz`. Run the generator once by hand and log all three.
4. **Find the master inverter.** All generator writes go to the master only. Find out how to detect it:
   - Jason captures the parallel-role field from the Remote-Setting form (the input id near `2143` Parallel Mode, for example a "Master/Slave" or parallel-address dropdown) and its value on each OffTheHook inverter.
   - Ground truth: OffTheHook's master is `2452-40920023PH`. The detection rule passes only if it picks that serial and rejects the others.
   - Cross-check by sweeping each inverter with Admin → Live Register Probe and diffing the results. The master register is the one that differs. With the gen running, also check which inverter reports non-zero gen V/Hz/`genCurrpac`.
   - Result: `detectMaster(serials)` in `lib/midniteServer.js` reads that register. If detection is unclear, it **refuses to write**, never guesses. The admin can always override it in the site toggle.
5. **Decision point:** if the inverter has its own start/stop by SOC (or by voltage through `2124` Capacity Mode, with `2134`/`2135`), the daily windows become **native thresholds that the server rewrites when a window changes**. The inverter then enforces them even when the cloud is down. If the inverter only has a force on/off command, the server cron runs the hub's logic and sends start/stop. Either way, every start first writes `2136` (max run time) as a hardware cap.

## Phase 0 findings (2026-11-11, from the vendor's public installer bundle)
- Write path and confirm loop found: `setDeviceShadow_WA_New_AutoID` then `getDeviceShadowResult`. Details and the
  register table are in `CLAUDE.md` → Generator control.
- **Decision (step 5): native AGS exists.** Hybrid design:
  - Run now = `2156`=1 with `2136` max run time as the hardware cap; Stop = `2156`=2; release = `2156`=0 (Auto).
    The server ends a timed or stop-at-% run by writing `2156`=0 (or 2), and the inverter's `2136` cap ends it if
    the server never does.
  - Battery windows = the server rewrites native `2129`/`212A` (SOC mode) at each window boundary. The inverter
    enforces the active window offline.
  - The native exercise cycle (`2151`-`2155`) holds ONE weekly or monthly slot. Use it for the first weekly
    exercise schedule; any others (and one-off runs) are fired by the server cron through `2156`.
- Still needed from a live test on OffTheHook: (a) `genwrite` dry-run values; (b) DONE 2026-11-11: no-op write of `2136` returned
  `verified:true`; (c) DONE: the master `2452-40920023PH` is AutoId `51400` (portal capture), not `51398`; (d) one Run now/Stop with the gen
  observed, logging `flowrt.genCurrpac` and gen V/Hz to settle run detection.

## Phase 1: Data model (Supabase, appended to `supabase/schema.sql`, idempotent)
Key every table by **`site_key`** (the site's sorted inverter serials). The installer login (FLOSOL2) and an end-user login that link the same site then share one config and one log.
- `gen_sites`: site_key, site_name, enabled, timezone, `master_sn` + `master_auto_id`, `master_source` ('detected' | 'admin'), `master_checked_at`, enabled_by, created_at.
- `gen_config`, `gen_windows`, `gen_schedules`: copy the hub schema (`comm_hub_gen_*`, fields in `lib/comm-hub/generator.ts`). Schedules add a `kind` of `'oneoff' | 'exercise'` and `days_mask` for FourScoped's weekly exercise runs.
- `gen_runs`: started_at, ended_at, source (auto/force/schedule/manual), duration, cap_min, target_pct, soc at start and end, peak gen V/Hz, kWh where available.
- **`gen_events`** (the site activity log): site_key, actor user_id + email + display name, whether the actor is the owner or a share recipient, action (start, stop, save_window, delete_schedule, master_on, write_register, …), before/after JSON, source (user/cron), success, error, ts.
- `push_subscriptions`, `vapid_keys`: copy `comm_hub_push_subscriptions` and `comm_hub_vapid_keys`. Key by user_id instead of email.
- `gen_alert_prefs`: user_id, site_key, email on/off, push on/off.
- RLS on with no policies. All access goes through service-role API routes, the same posture as `diagnostics`.

## Phase 2: Server
- **New route `pages/api/generator.js`.** Do not grow `pages/api/midnite.js`, which is high-traffic. Reuse `lib/midniteServer.js` (sign/login/post) and add `writeShadow()` + `readShadow()` there. `writeShadow()` checks an **allow-list of generator register codes and value ranges** and always reads the value back. **Writes go only to `gen_sites.master_auto_id`.** Before each write, the master is re-checked against the live parallel-role register (cached 1 h). On a mismatch the write is blocked, the event is logged and the admin gets an alert. Running state and gen V/Hz are read from the master.
- **Authorization `canControlGen(user, site_key)`:** the site is `enabled` in `gen_sites` AND the user owns a linked account that holds the site OR has an `active` `site_shares` row for it. Reuse the proxy's `resolveAccount` / `sharedSites` logic. This is the only path where a share recipient can write, and it stays limited to generator actions.
- **Actions:** `state`, `control` (start/stop/force with h:m cap + target %), `saveConfig`, `setMaster`, `setAlerts`, `saveWindow`, `deleteWindow`, `reorderWindows`, `saveSchedule`, `deleteSchedule`, `history`, `events`, `pushSubscribe`, `pushUnsubscribe`. Each write adds a `gen_events` row.
- **Port pure logic:** `eg4-monitor/lib/comm-hub/generator-core.ts` → `lib/generator/core.js` (`evaluateGen`, `activeSetpoint`, `windowCoversMinute`, `overlappingPairs`, formatters). The UI and the cron share the same winner rule. Copy `computeNextRun` / `localParts` / `zonedTimeToUtc` from `eg4-monitor/lib/eg4/generator.ts` for exercise schedules.
- **Cron `/api/generator/tick`** (every minute, `CRON_SECRET`, added to `vercel.json`): for each enabled site, read live SOC + gen state (`flowrt`), run the due schedules, enforce the force deadline, and run auto windows (Phase 0 decides between rewriting native thresholds and sending start/stop). Hysteresis remembers the last command. If the cloud is unreachable, apply `commsLostAction`. The run is opened and closed in `gen_runs` from the **observed** gen power, and start/stop alerts fire when that state flips.
- **Alerts:** port `generator-alert.ts` and `push.ts` (`web-push`, VAPID kept in the DB). Send email through the existing `lib/notifications/deliver.js` (now with the real send result). Recipients are every user who can open the site and has alerts on.

## Phase 3: UI (`pages/index.jsx` + `components/ui/*`, HIG rules in `docs/hig/notes.md`)
- A **Generator** tab appears only on enabled sites. On phones it takes Explorer's slot in the 5-tab `TabBar`, and Explorer moves to "…".
- `Segmented` sub-views:
  1. **Control** (simple): live status (running/stopped, gen W/V/Hz, freshness chip). **Run now** with hours + minutes and an optional stop-at %, behind a one-time liability disclaimer and a `confirmAlert`. Big Stop. A live countdown.
  2. **Automatic**: master switch, default start/charge-to/max run, daily time windows with the 24 h timeline strip, priority reorder and an overlap warning (port `GeneratorSettings.tsx`).
  3. **Schedules**: one-off runs and weekly exercise runs.
  4. **History**: totals (day/7d/30d/year/all), a stacked daily chart (generator colors from tokens; existing chart colors unchanged) and the run list (port `RunHistory.tsx` + history route).
  5. **Activity**: the site-wide `gen_events` log (who, what, when, before→after), with CSV export.
  6. **Alerts**: email/push toggles for this user, Enable push, Send test.
- Every pop-up uses `Sheet`, every confirm `confirmAlert`, every finished action `toast`.
- The SHARED badge stays, with "generator control allowed" added. The other view-only limits stay as they are.
- **Admin:** a site toggle "Generator control" (writes `gen_sites`) that shows the detected master (INV-N, serial, how it was found) with an override picker. The site cannot be enabled until a master is set. Plus a register test bench (the Phase 0 `genwrite`).

## Phase 4: PWA install
- `public/manifest.webmanifest`, `public/sw.js` (push + notificationclick, minimal offline page), PNG icons 192/512/maskable + `apple-touch-icon.png` rendered from `public/logo.svg`, linked in `pages/_document.js`.
- Port `InstallHint.tsx` as a bottom banner after login: Android gets a real Install button; iOS gets Share → Add to Home Screen with the share glyph. It hides once the app is installed and remembers dismissal. Show it to all users. On gen sites, Alerts says that iPhone push needs the installed app.

## Phase 5: Docs and release
- Update `CLAUDE.md`: replace "Writes would use setDeviceShadow_WA, do not write" with the allow-listed generator write rule. Add a Generator section.
- Add `CHANGELOG.md` entries and bump the version for each user-visible phase.
- Rollout: Phase 0 → (1+2) → Control view on OffTheHook only → the rest.

## Verification
- Unit tests for `lib/generator/core.js` (midnight-wrap windows, priority, hysteresis, force deadline, exercise next-run across DST).
- `next build` clean; `bash scripts/ui-check/run.sh` with fake gen data at 0 console errors, phone + desktop screenshots of each sub-view.
- Cron `?dry=1` mode logs the decisions without writing. Run it on OffTheHook for a day before turning on the master switch.
- Live test with Jason on site or on the phone: Run now 5 min → gen starts → `gen_runs` opens → push + email arrive → auto-stop at the cap → run closes. Repeat Stop mid-run. Repeat as a share-recipient account.
- Master check: on OffTheHook, `detectMaster` picks `2452-40920023PH`. A write aimed at a non-master is refused.
- Check that a share recipient on a site that is **not** enabled gets 403 on every generator action.
