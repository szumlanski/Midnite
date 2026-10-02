# Changelog

Midnite Sentinel follows the HIG rollout in `docs/hig/audit.md`: one version per phase.

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
