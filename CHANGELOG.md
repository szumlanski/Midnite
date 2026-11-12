# Changelog

Midnite Sentinel follows the HIG rollout in `docs/hig/audit.md`: one version per phase.

## 1.2.3 (2026-11-12): Strings moved to the Month and Year tabs

- The Strings chart left the bottom of the Day tab. Month and Year now have a **Site | Strings** switch above the
  chart: Strings shows each string's kWh for the same month (daily bars) or year (monthly bars), with its own
  previous/next arrows that stay in step with the tab. The choice is remembered.

## 1.2.2 (2026-11-12): Strings toggles, live string readings, no warnings

- Strings chart: tap an inverter to hide or show all its strings, or a string chip to hide or show one. Remembered
  per site on this device.
- The "X% below the other strings" warning is gone (strings differ in rating and some are paralleled).
- Settings > Strings shows each MPPT's live volts, amps and watts.

## 1.2.1 (2026-11-12): Generator power summed, grid voltage chips fixed

- Generator power on the Generator tab (and in run records/alerts) is now the total of all inverters, not just the
  master's share.
- Inverter cards label the leg voltages "Grid L1/L2" and hide them when there is no grid on the terminals (an
  off-grid site read a meaningless 5 V).

## 1.2.0 (2026-11-12): String names and daily energy per string

- Name each solar string (MPPT input) and optionally set its DC size in **Settings → Strings**. Names are per
  inverter serial and MPPT number, and anyone with access to the site can edit them (shared viewers included).
  Every change is logged with who made it.
- The names show wherever MPPTs appear: Live inverter cards and the single-inverter view, the Day chart's
  per-MPPT bands and tooltip, and Explorer's MPPT readings. Unnamed strings still read "MPPT 1".
- New **Strings** section at the bottom of the Day tab: 7 days / 30 days / this month / this year, a stacked
  daily bar per string, a table with kWh, kWh per kW and share of the inverter, an amber flag for any string more
  than 15% below the others over 7 days, and a check that the strings add up to the inverter's own E-Today.
- Energy per string is collected each night at 1 AM site time from the 5-minute export (a new hourly cron that
  retries until 5 AM). Admins can backfill 30 days from the Strings section.

## 1.1.9 (2026-11-12): Generator activity log covers every change

- Every generator state change is now in the site's Activity log with who made it: each user action records the
  person, their role, before/after, and their IP and device. Automatic actions name the user they acted for (whose
  Run now ended, whose schedule started).
- New entries: generator seen starting and stopping, alerts sent, settings copied from the inverter, AGS changed in
  the installer portal, and the admin register tool.
- Activity CSV adds "on behalf of", IP and device columns.

## 1.1.8 (2026-11-12): Automatic control sets the inverter's AGS

- The Automatic control switch now IS the inverter's AGS mode: on writes AGS Auto, off writes AGS Off (with a
  warning that the generator then never starts on its own). Before, it never touched AGS, so Automatic did nothing
  while AGS was Off.
- The switch shows the inverter's real AGS, so a change made in the installer portal shows up in the app.
- Turn generator off switches Automatic off; Return to automatic switches it on; a Run now ending follows the
  restored setting. Scheduled runs work with Automatic on or off.
- The app copies the inverter's own start/stop % and max run the first time it reads the site, so switching
  Automatic on never overwrites them with the built-in 20/80.

## 1.1.7 (2026-11-11): Generator control, phase 3 (UI)

- New **Generator** tab, only on sites an admin enabled. On phones it takes Explorer's tab bar slot and
  Explorer moves to the "..." menu. Deep link `?site=X&tab=generator` works.
- Six views: **Control** (status, live power, Run now with hours + minutes and an optional stop-at %, a
  one-time safety notice, a countdown, a big Stop that ends the run and puts the inverter back to its
  pre-run setting, plus Return to automatic and a separate Turn generator off), **Automatic** (master switch, defaults,
  time windows with a 24 h strip, priority order and overlap warning), **Schedules** (one-off and weekly
  exercise runs), **History** (totals, daily chart by source, recent runs), **Activity** (site-wide log with
  CSV export) and **Alerts** (email and push for this user).
- Shared viewers see "generator control allowed" on enabled sites. Nothing else is unlocked for them.
- Admin: a Generator control card per site (enable + master inverter).
- New generator colors in `components/ui/tokens.js`; existing chart colors unchanged.

## 1.1.6 (2026-11-11): Generator control, phase 2b (cron, alerts, push)

- Every-minute generator cron (`/api/generator/tick`): opens and closes generator runs from the live reading
  (grid terminals on Off-Grid sites, else the gen port), ends Run now at its time or battery target, starts
  one-off and weekly exercise schedules, and writes the active battery window's start/stop % to the inverter so
  its own auto-start enforces them. `?dry=1` shows the decisions without writing.
- Generator started/stopped alerts by email and push to everyone who can control the site, per their alert choices.
- Web Push server: VAPID keys made once and kept, `pushKey`, `pushSubscribe`, `pushUnsubscribe` and `pushTest`.
- Still no generator UI.

## 1.1.5 (2026-11-11): Generator control, phase 2 (server)

- New `/api/generator` route: generator state, Run now / Stop / Auto (with `?dry=1`), automatic settings, battery
  windows, one-off and weekly exercise schedules, run history and a site activity log. Share recipients can
  control the generator on sites an admin has enabled.
- Writes go only to the site's master inverter, through the shared allow-list, and are verified by read-back.
- `state` reports whether the generator is wired to the grid terminals (`213F`) and whether the site is
  Off-Grid (`2100`). Read only.
- No UI yet, and no cron: nothing runs on its own.

## 1.1.4 (2026-11-11): Install as an app (generator plan, phase 4)

- Midnite Sentinel is now an installable app: web manifest, home-screen icons (192, 512, 512 maskable, Apple
  180) rendered from `public/logo.svg` by `scripts/pwa/render-icons.mjs`.
- Service worker `public/sw.js`: shows push notifications and opens the linked page on tap. It caches nothing
  except an offline page, so inverter data is always live.
- Install banner on the dashboard after 2.5 s: an Install button on Chrome/Edge/Android, and "Tap Share, then
  Add to Home Screen" on iPhone and iPad. Hidden once installed or dismissed.
- `lib/push/client.js`: browser push subscribe/unsubscribe helpers for the generator alerts (server side to follow).

## 1.1.3 (2026-11-11): Generator control, phase 0

- Admin-only `genwrite` action: the first and only register write path, limited to an allow-list of
  generator registers with ranges, master inverter only, verified by read-back.
- Inverter Settings now show Gen Port, AGS mode, generator start/stop SOC, run cycle and run day, with labels
  and values taken from the installer portal.

## 1.1.2 (2026-11-11): Share emails report real delivery

- Sharing a site used to say "Invite emailed" even when the email provider rejected it, because the send
  result was thrown away. It now shows the actual error (red) when the email did not go out, and logs it
  in Vercel as `[share_create] email to ... failed:`.
- New **Resend email** item in each share's "..." menu (Settings > Sharing and the Share sheet).

## 1.1.1 (2026-10-08): Leave out impossible energy readings

- The vendor's month/year rollups sometimes return an impossible number for one inverter. Mark Gorovoy's
  Year 2026 showed 4,204,844 kWh of solar in January (4,206.89 MWh charged) because one January row
  reported that much battery charge.
- New guard (`lib/rollupGuard.js`): any energy field above 600 kWh per inverter per day (31 days for a
  monthly row) is left out of the totals. The MN 15-12KW-AIO is rated 15 kW, so real values never come close.
- Day, Month, Year and the custom range show an amber note naming each value that was left out
  (inverter, period, field, value). The daily digest email uses the same guard.

## 1.1.0 (2026-10-06): Download diagnostics (admin)

- Admins get "Download diagnostics" in the "…" menu on any site, including sites shared with them. One click
  captures the raw vendor data for every inverter at the site (status, detail, live flow, today's and
  yesterday's day data and 5-minute CSV export, month and year) next to what the app made of it, and the
  app's own live view. It downloads as a JSON file and is saved to the `diagnostics` table. Read-only:
  nothing is sent to the inverters; tokens and passwords are redacted.
- Purpose: diagnose 3-phase and AC-coupled sites (Zeke's GC_EMS, 194WPC, GenevasWay) without their
  Midnite logins.

## 1.0.1 (2026-10-05): Remove phantom smart-port readings

- Inverter cards and the single-inverter view no longer show "Smart ports". The status call reports the
  same smart-port power and energy on every inverter (3.8 kW / 15.0 kWh today on all five at Wise Naples)
  even though nothing is wired to the smart ports.
- The power-flow diagram no longer builds a Smart load node from those readings before the live feed
  connects (it would have shown 19 kW). A genuine separate backup load still comes from the live feed.

## 1.0.0 (2026-10-02): Motion polish, HIG rollout complete

- Charts: Month and Year bars grow in over 0.45s instead of Recharts' default 1.5s, and not at all under
  Reduce Motion (bar layout rules unchanged). Day and Explorer lines stay static.
- Day / Month / Year / Explorer / Admin content eases in when you switch tabs (0.28s, 6px), the Live tab
  keeps its card stagger; nothing animates on data polls.
- Chart summary totals (Produced, Consumed, Exported, …) glide to the new value when you change the
  day, month or year.
- `usePrefersReducedMotion()` hook for libraries that take an animate flag.
- Verified: 25 seconds of live polling on the Live tab produced zero long main-thread tasks (phone and
  desktop); the full Reduce Motion pass renders every screen with final values and no motion.
- Harness: `--perf` measures long tasks on the Live tab.

## 0.9.0 (2026-10-02): Remaining screens

- Landing page on phones: the nav shows the logo, name and Sign in only (FAQ, Terms and Sign up move out
  of the way), nothing wraps; outline buttons use the text-safe amber; buttons press in slightly.
- One logo everywhere: the canonical Sentinel mark moved to `components/ui/Logo.jsx`; FAQ and Terms were
  drawing an older variant and now share it, along with the shared color tokens and type scale (FAQ/Terms
  text contrast and sizes fixed by the same codemod as the app).
- FAQ: copy updated for the new interface (Settings → Alerts, Export CSV, Share, the Fleet page), a chevron
  icon on each question, "Sign in" in sentence case, desktop sidebar at the 768px breakpoint.
- Terms: comfortable padding on phones.
- Sign-in screens: sentence-case labels with proper autocomplete hints, Sign out as a real button,
  errors announced to screen readers.
- Loading: a branded splash (the logo breathes gently) instead of "Loading…".
- Admin → Users: each row has a "…" menu (Send password reset, Link Midnite account…, and a red Unlink
  after a divider) instead of inline colored buttons; role pills; reset results shown under the date.
- Harness covers FAQ and Terms (42 screens).

## 0.8.0 (2026-10-02): Icons

- Every emoji or symbol used as an icon in the app is now the one SVG icon set, so icons look the same on
  every device and take the surrounding text color: 21 converted by an AST codemod
  (`scripts/hig/codemod-icons.mjs`) plus the landing-page illustrations (SVG icons inside SVG), the
  landing checklist ticks (CSS mask) and the Admin tables (sort chevrons, grid arrows, "Sent" check).
- New icon: sparkle (pre-launch badges).
- Emails keep their emoji on purpose (Gmail strips SVG); typographic characters (· — … → °) stay text.

## 0.7.0 (2026-10-02): Alerts and toasts

- Every browser `confirm()` and `alert()` is gone (6 call sites). Confirmations are HIG alerts: a short
  question, one line of consequence, Cancel and the action side by side; destructive actions (Delete,
  Revoke, Unlink, Remove) are red and focus starts on Cancel; Escape cancels. A small pop-in on open.
- Removing a site photo now asks first (it can't be undone).
- Finished actions confirm with a toast that disappears on its own: alert added or deleted, test email
  sent, access revoked, account unlinked, profile or photo saved, password updated, photo removed.
  Failures in Admin unlink show as an error toast.
- Fixed a hydration warning: the alert host renders only after the page hydrates.

## 0.6.0 (2026-10-02): Sheets

- One `Sheet` component for every pop-up: Settings, Share site, Inverter settings, Compare inverter
  settings and the site photo viewer. On phones it rises from the bottom with a grabber and can be dragged
  down to dismiss; on desktop it is a centered dialog. Escape and the backdrop close it, focus moves in and
  stays inside while it is open, the page behind stops scrolling, and focus returns afterwards. GSAP
  in/out motion, none under Reduce Motion.
- Settings: sections are a segmented control (Midnite, Profile, Security, Photos, Alerts, Sharing) that
  scrolls sideways on phones; Help and Sign out sit in a footer that stays put.
- Inverter settings: grouped rows with names in sentence case and skeleton rows while the inverter answers.
- Compare: All settings / Differences segmented filter with a count, Export CSV, sticky header row and
  setting column, differing rows flagged with an icon.
- Site photo viewer: Take photo / Choose file buttons with icons; can't be dismissed mid-upload.

## 0.5.0 (2026-10-02): Lists

- Fleet: navigation bar with Refresh (spins while working) and a "…" menu (Export CSV, Help, Sign out);
  large "Fleet" title with an online/attention summary; KPI tiles count up and the first three filter the
  table; full-width search and an All/Online/Issues segmented filter with counts; the table stays a table
  on phones (as preferred) with a sticky site column, 56px rows, keyboard-openable rows, sortable column
  buttons, skeleton cells while loading, and rows that glide to their new places when you sort or filter
  (GSAP Flip, off under Reduce Motion).
- Settings lists are grouped rows with a "…" menu per row; destructive actions (Delete alert, Revoke
  access, Unlink account, Remove photo) sit in the menu, in red, after a divider.
- The "…" menu now renders above everything and flips upward near the bottom of the screen, so sheets and
  tables never clip it.
- Alert rules: inverter header with Send test, sentence-case details, Add alert as a plain button.
- Linked accounts: an Active pill and "Use this account" in the menu replace the radio buttons.

## 0.4.0 (2026-10-02): Detail views and charts

- Day, Month, Year and Explorer share one header: a title with a plain-language subtitle, then 44px step
  buttons around the date picker. Day gets a "Today" button. Month switches between Month and Custom range
  with a segmented control. On phones the controls take the full width, and date ranges put both dates on
  one row and the step buttons on the next.
- Chart series toggles are chips that keep their series color (Grid and Battery replace
  "Imported/Exported" and "Charged/Discharged"). Series colors and the Month/Year bar rules are unchanged.
- Axis labels: round values (12k, 8k, 4k); fixes the clipped negative labels on the Year chart and the
  repeated "2k, 2k" labels in Explorer. The Day chart's power axis now snaps to round extents.
- Explorer: the readings picker is grouped with a count, Select all and Clear; on phones each group is one
  sideways-scrolling row.
- Loading shows a skeleton instead of "Loading…"; empty charts and searches explain what to do next.
- Single-inverter view: icon section titles, animated numbers and charge bar, a proper "Inverter
  settings" button, a status pill with a dot, and a disclosure chevron for details and firmware.
- Fault log: icon title, Search button, Active/Cleared pills, clear empty states.
- An inverter with no report for 30+ minutes now reads Offline (the older status call always said Online).

## 0.3.0 (2026-10-02): Foundation, app wide

- Readable text everywhere: 156 text colors moved from the 2.5:1 gray to the 5.3:1 gray (including chart
  axis labels); 359 font sizes moved onto the type scale, so phone text is one step larger (minimum 12px on
  phones, 11px on desktop); chart axis labels raised from 10px to 11px.
- Sentence case: ALL CAPS styling removed from 28 labels; Title Case labels rewritten ("Peak today",
  "Inverter temperature", "Net exported").
- Touch targets: every button and field is at least 44px tall on phones and 28px on desktop; switches are
  real on/off switches (51x31 on phones) with a springy knob.
- Keyboard focus is visible everywhere (the six `outline: none` overrides are gone).
- Plus Jakarta Sans loads once for every page instead of four times.
- Removed dead code (`AppLogin`, `Legend`).
- Tooling: `scripts/hig/codemod-foundation.mjs` (AST codemod: text contrast, sentence case, type scale).

## 0.2.0 (2026-10-02): Showcase, header and Live tab

- New navigation bar. Desktop: "‹ Fleet" back link, site name, section tabs as a segmented control whose
  selection pill glides, Share and Settings buttons, and a "…" menu with account switching and Sign out.
  Phone: back link, Share, and a "…" menu (Settings, Admin, accounts, Sign out); the site name is a large
  title that hands off to a compact title in the bar as you scroll.
- Phone tab bar: five sections (Live, Day, Month, Year, Explorer) with SVG icons and a sliding highlight.
  Admin moved to the "…" menu on phones.
- Live tab: hero card with an animated "Solar now" number and icon tiles; power-flow diagram with SVG icons,
  larger labels and animated values; battery card with an animated charge bar; inverter cards with an
  Online/Offline pill, icon tiles and a full-width "Inverter settings" row; an "Inverters" section header
  with Compare settings; a skeleton while the first read loads; cards ease in on tab or site change.
- Readability: secondary text color raised to 4.8:1 contrast or better; amber/green small text uses darker
  text-safe tones; sentence case labels throughout the Live tab.
- Motion: GSAP 3.15 (numbers count between readings, bars glide, menus pop, tab highlight slides). Nothing
  moves when the OS asks for reduced motion, and a poll that returns the same reading never animates.
- Foundation pieces: shared UI kit in `components/ui/` (tokens, icons, buttons, menu, segmented control,
  motion hooks), `styles/globals.css` rewritten (type scale and 44px phone targets as CSS variables, focus
  rings, 16px phone inputs, Reduce Motion), Apple HIG pages saved to `docs/hig/apple/`, audit in
  `docs/hig/audit.md`, screenshot harness in `scripts/ui-check/`.
- The build marker in Admin now shows the app version.
