// Design tokens shared by every page. CSS mirrors live in styles/globals.css (:root).
// Contrast is measured against CARD (#FFF) and BG (#F7F4EF); text colors are 4.5:1 or better on both
// unless noted. Chart series colors are fixed by CLAUDE.md and must not change without Jason's OK.

export const BG = "#F7F4EF";
export const CARD = "#FFFFFF";
export const BORDER = "#EAE4DC";
export const TEXT = "#1C1917";        // 17.5:1
export const MUTED = "#716A65";       // 5.3:1 on white, 4.8:1 on BG (was #78716C, 4.4:1 on BG)
export const FAINT = "#A8A29E";       // 2.5:1: borders, dividers and disabled fills only, never text

// Semantic colors: use these for fills, dots, icons and large/bold numbers.
export const SOLAR = "#D97706";
export const BATTERY = "#16A34A";
export const GRID_IN = "#DC2626";
export const GRID_OUT = "#059669";
export const LOAD_C = "#2563EB";

// Text-safe twins for small text on light backgrounds.
export const SOLAR_TEXT = "#B45309";    // 5.0:1
export const BATTERY_TEXT = "#15803D";  // 5.0:1
export const GRID_OUT_TEXT = "#047857"; // 5.5:1
export const GRID_IN_TEXT = "#B91C1C";  // 6.5:1

// Map a semantic fill color to its text-safe twin (anything else passes through).
const TEXT_TONE = { ["#3B82F6"]: "#2563EB", [SOLAR]: SOLAR_TEXT, [BATTERY]: BATTERY_TEXT, [GRID_OUT]: GRID_OUT_TEXT, [GRID_IN]: GRID_IN_TEXT, [FAINT]: MUTED };
export const textTone = (c) => TEXT_TONE[c] || c;

export const SHADOW = "0 1px 2px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.06)";
export const SHADOW_SM = "0 1px 2px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.04)";
export const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";

// Chart series (do not change; see CLAUDE.md "CHART COLORS").
export const CHART_PROD = "#3B82F6";
export const CHART_CONS = "#F97316";
export const CHART_BAT = "#22C55E";
export const CHART_GRID = "#94A3B8";

// Type scale and target size. Values switch at 768px in globals.css, so inline styles stay responsive.
export const FS = {
  caption: "var(--fs-caption)",   // 11 desktop / 12 phone
  footnote: "var(--fs-footnote)", // 12 / 13
  subhead: "var(--fs-subhead)",   // 13 / 14
  body: "var(--fs-body)",         // 14 / 15
  callout: "var(--fs-callout)",   // 15 / 16
  headline: "var(--fs-headline)", // 17
  title3: "var(--fs-title3)",     // 20
  title2: "var(--fs-title2)",     // 22
  title1: "var(--fs-title1)",     // 28
  large: "var(--fs-large)",       // 26 / 30
};
export const TAP = "var(--tap)"; // 28 desktop / 44 phone
