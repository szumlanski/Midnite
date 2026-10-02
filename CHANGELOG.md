# Changelog

Midnite Sentinel follows the HIG rollout in `docs/hig/audit.md`: one version per phase.

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
