# HIG rules that apply to Midnite Sentinel

Source: Apple Human Interface Guidelines, downloaded to `docs/hig/apple/` (2026-10). Phones follow the iOS
rules, desktops follow the macOS rules. On the web, 1 pt = 1 CSS px. Phone rules live in
`@media (max-width: 768px)`.

## Text
- Body text: 17 pt default, 11 pt minimum on iOS; 13 pt default, 10 pt minimum on macOS. [typography, accessibility]
- Our scale (dense monitoring app, so we sit below the iOS 17 pt default but never below the minimums):
  caption 11/12, footnote 12/13, subhead 13/14, body 14/15, callout 15/16, headline 17, title3 20, title2 22,
  title1 28, large title 26 desktop / 30 phone (values are desktop/phone).
- Keep truncation to a minimum; let text wrap. [typography]
- Sentence case for labels and buttons, applied consistently. [writing]
- Menu item labels drop articles ("Share site", not "Share this site"). [menus]
- An ellipsis on a label means it asks for more input ("Share…", "Settings…"). [menus]

## Contrast and color
- Text up to 17 pt: 4.5:1. 18 pt+ or bold: 3:1. [accessibility]
- Never rely on color alone for status (Online/Offline gets a word and an icon too). [color]
- Use one color for one meaning across the app (amber = solar, green = battery, red = import/error). [color]
- Color reads best in bold text and large areas; small light text in color is hard to read. [color]

## Targets and layout
- Minimum control size: 44x44 pt on iOS, 28x28 pt on macOS. [accessibility, buttons]
- Button sizes: mini 28, small 32, regular 44, large 52. [buttons]
- Button centers at least 60 pt apart where possible; no more than 3 icon buttons or 2 text buttons in a row. [buttons, layout]
- Primary phone actions can span the full width. [buttons]
- Prefer buttons with a visible background shape; plain text buttons only in toolbars, menus, alerts. [buttons]
- Do not make a custom button with a white fill and black text: that reads as "toggled on". [buttons]

## Navigation
- Phone tab bar: sections only, never actions; single-word labels with an icon; no overflow tabs (5 max). [tab-bars]
- Segmented controls: all text or all icons, not a mix. [segmented-controls]
- Put frequently used menu items first; group related commands; destructive items last after a separator. [menus]

## Modals
- Sheets are for brief, occasional tasks, not for navigation. [sheets]
- If a sheet has Done, pair it with Cancel; never show Cancel, Done and Back together. [sheets]
- Phone sheets rise from the bottom with a grabber; desktop sheets are centered dialogs at a sensible size. [sheets, modality]

## Alerts and feedback
- Use alerts sparingly; never for information only; never at app start. [alerts]
- No alert for common, undoable actions. Warn only for unexpected, irreversible data loss. [alerts, feedback]
- Title describes the situation; message only if it adds value; buttons are 1 or 2 word verbs, not "OK". [alerts]
- Destructive button is red and never the default; focus goes to Cancel. [alerts]
- Confirm significant completed actions with lightweight feedback (a toast), not an alert. [feedback]
- Error messages sit near the problem, avoid blame, say how to fix it. [writing]
- Empty screens give a clear next step. [writing]

## Loading
- Show something as soon as possible (skeletons, cached data), let people keep working while it loads. [loading]
- Say what is loading and roughly how long when it takes more than a moment. [loading]

## Motion (GSAP)
- Motion must have a purpose: explain a change, give feedback, show status. No motion for its own sake. [motion]
- Make motion optional: honor Reduce Motion, and never make motion the only signal. [motion, accessibility]
- Brief and precise. Avoid motion on interactions that happen often (keep tab switches very light). [motion]
- Never make people wait for an animation; input is never blocked. [motion]
- Avoid sustained oscillation, especially around 0.2 Hz (long pulsing loops). [motion]
