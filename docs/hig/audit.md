# HIG audit: Midnite Sentinel

Measured 2026-10-02 on `pages/index.jsx` (4,300 lines, 47 components, inline styles). Rules in `notes.md`.

## Numbers

| Measure | Phone (iOS rule) | Desktop (macOS rule) | Today | Status |
|---|---|---|---|---|
| Body text | 17 default, 11 min | 13 default, 10 min | 20 distinct sizes; 284 of 431 uses at 12px or less; 1x8px, 18x9px, 57x10px | Fail |
| Text contrast | 4.5:1 | 4.5:1 | `FAINT #A8A29E` 2.52:1 on white (194 uses), `MUTED #78716C` 4.37:1 on `BG` | Fail |
| Colored text | 4.5:1 | 4.5:1 | `SOLAR` 3.19:1, `BATTERY` 3.30:1, `GRID_OUT` 3.77:1 on white | Fail |
| Tap / click target | 44 | 28 | Common buttons 19 to 29px tall; modal close "×" about 20x12px; tab bar items about 42px | Fail |
| Input font size | 16 (no iOS zoom) | n/a | Every input is 11 to 14px | Fail |
| Focus ring | visible | visible | 0 `:focus-visible`; 6 `outline:none` with no replacement | Fail |
| Reduce Motion | honored | honored | 0 `prefers-reduced-motion`; `pulse` and `flowdash` loop forever | Fail |
| Modals | bottom sheet, grabber | centered dialog | 5 copied overlays; no Escape, no `role="dialog"`, no focus handling | Fail |
| Alerts | HIG alert | HIG alert | 5 `window.confirm`, 1 `alert()`; Remove site photo unguarded | Fail |
| Icons | one symbol set | one symbol set | about 35 emoji/glyph types used as icons (about 110 uses) | Fail |
| Labels | sentence case | sentence case | 33 `textTransform:"uppercase"` | Fail |
| Tab bar | 5 max, sections only | n/a | 6 tabs for admins; Share/Fleet/Settings scroll sideways in the header | Fail |
| Breakpoint | 768 | n/a | 640 (app) and 768 (landing) | Fail |
| Global CSS | n/a | n/a | `globals.css` paints body `#0a0a0a` + Arial in OS dark mode; font loaded 4 times | Fail |
| Dead code | n/a | n/a | `AppLogin`, `Legend` unused | Fail |

## Gaps ranked by impact
1. Tiny, low-contrast text everywhere (284 small sizes, 194 `FAINT` text uses). Hard to read outdoors on a phone,
   which is where installers check sites.
2. Tap targets of 19 to 29px and inputs that zoom on iOS. Every interaction on a phone is fiddly.
3. Pop-ups and confirms: no Escape, no sheet behavior, browser `confirm()` dialogs, a 20px close button.
4. Header on phones: a sideways-scrolling strip of buttons, 6 tabs for admins.
5. Emoji as icons render differently per device and cannot be colored or sized consistently.

## Checklist (one version per phase; merged to master once the harness passes, per Jason 2026-10-02)
- [x] 1. v0.2.0 Showcase: header + Live tab (plus setup: HIG docs, UI kit, GSAP, screenshot harness)
- [x] 2. v0.3.0 Foundation: contrast tokens, type scale, focus rings, 44px phone targets, 16px inputs,
      sentence case, 768 breakpoint, 5-tab bar, globals.css + font cleanup, Reduce Motion, dead code
- [x] 3. v0.4.0 Other detail views: inverter detail, battery/lifetime/fault, Day/Month/Year/Explorer headers
- [ ] 4. v0.5.0 Lists: Fleet (table kept on phones), alert rules, shares, linked accounts with "…" menus
- [ ] 5. v0.6.0 Sheets: one `<Sheet>` for the 5 overlays; Settings sub-tabs as a segmented control
- [ ] 6. v0.7.0 Alerts + toasts: `confirmAlert` at every confirm site, toasts for completed actions
- [ ] 7. v0.8.0 Icons: emoji/glyphs to the SVG icon set (emails excluded)
- [ ] 8. v0.9.0 Remaining screens at 390px: landing, auth, FAQ, Terms, Admin, empty/loading/error states
- [ ] 9. v1.0.0 Motion polish: GSAP pass across every screen, Reduce Motion pass, poll-time performance

Skipped: host-page breakout (not embedded), PWA shell (no manifest), dark mode (Jason's call, 2026-10-02).
