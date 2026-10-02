// AST codemod: emoji/glyphs used as icons in JSX -> <Icon name="…"/> (v0.8.0).
// Only JSX text (and string literals rendered as JSX children) that START with a mapped glyph are changed,
// e.g. <button>⬇ CSV</button> -> <button><Icon name="download"/>CSV</button>. Attributes (title, placeholder,
// aria-label), <option>/<textarea>/<title>, typographic characters (— · … ° − Δ ≤ ≥ ≈) and email templates are
// never touched. Unmapped glyphs are reported, not changed.
// Usage: node scripts/hig/codemod-icons.mjs <file> [--write]
import fs from "node:fs";
import * as acorn from "acorn";
import jsx from "acorn-jsx";
import * as walk from "acorn-walk";

const file = process.argv[2];
const write = process.argv.includes("--write");
const src = fs.readFileSync(file, "utf8");
const ast = acorn.Parser.extend(jsx()).parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true });

const base = { ...walk.base };
for (const t of ["JSXText", "JSXIdentifier", "JSXMemberExpression", "JSXNamespacedName", "JSXEmptyExpression", "JSXClosingElement", "JSXClosingFragment", "JSXOpeningFragment"]) base[t] = () => {};
base.JSXElement = (n, st, c) => { c(n.openingElement, st); for (const ch of n.children) c(ch, st); };
base.JSXFragment = (n, st, c) => { for (const ch of n.children) c(ch, st); };
base.JSXOpeningElement = (n, st, c) => { for (const a of n.attributes) c(a, st); };
base.JSXAttribute = (n, st, c) => { if (n.value) c(n.value, st); };
base.JSXSpreadAttribute = (n, st, c) => c(n.argument, st);
base.JSXExpressionContainer = (n, st, c) => { if (n.expression.type !== "JSXEmptyExpression") c(n.expression, st); };
base.JSXSpreadChild = (n, st, c) => c(n.expression, st);

const MAP = {
  "⬇": "download", "↻": "refresh", "⊞": "fleet", "↗": "share", "⚙": "cog", "☀": "sun", "🔋": "battery", "🏠": "home",
  "⚡": "bolt", "🔌": "plug", "🔗": "link", "📷": "camera", "🖼": "image", "❓": "help", "⚠": "alert", "✓": "check",
  "✔": "check", "✅": "check", "⛔": "stop", "■": "stop", "▶": "play", "🔧": "wrench", "📡": "activity", "📊": "chart",
  "💡": "bulb", "🕐": "clock", "ⓘ": "info", "⤴": "arrow-up", "⤵": "arrow-down", "↑": "arrow-up", "↓": "arrow-down",
  "✉": "mail", "✦": "sparkle", "📧": "mail", "🔒": "lock", "👤": "user", "✕": "x", "×": "x", "+": null,
};
const GLYPH = /^\s*([←-⇿⌀-⏿①-⓿■-➿⤀-⥿⬀-⯿]|[\u{1F300}-\u{1FAFF}])️?\s*/u;
const SKIP_TAGS = new Set(["option", "textarea", "title", "style", "script", "code", "text", "tspan", "svg", "g"]);

const edits = [], report = {};
const tagOf = (el) => (el?.openingElement?.name?.type === "JSXIdentifier" ? el.openingElement.name.name : "");

walk.fullAncestor(ast, (node, _st, ancestors) => {
  let text = null, start = 0, kind = null;
  const parentEl = [...ancestors].reverse().find((a) => a.type === "JSXElement" && a !== node);
  if (node.type === "JSXText") { text = node.value; start = node.start; kind = "text"; }
  else if (node.type === "Literal" && typeof node.value === "string") {
    // String literal directly inside a JSX child expression: {"⬇ CSV"} or {cond?"↻ Refresh":"…"}
    // Only when every node between the literal and its {…} container is a ternary or && / ||, so the
    // value is rendered as a child (never inside a template string, a call argument or an attribute).
    let i = ancestors.length - 2, ok = false;
    for (; i >= 0; i--) {
      const a = ancestors[i];
      if (a.type === "ConditionalExpression" || a.type === "LogicalExpression") continue;
      ok = a.type === "JSXExpressionContainer" && ancestors[i - 1]?.type !== "JSXAttribute";
      break;
    }
    if (!ok) return;
    text = node.value; start = node.start + 1; kind = "lit";
  } else return;
  if (SKIP_TAGS.has(tagOf(parentEl))) return;
  const m = text.match(GLYPH);
  if (!m) return;
  const ch = m[1];
  const name = MAP[ch];
  const line = node.loc.start.line;
  if (!name) { (report[ch] ||= []).push(line); return; }
  const lead = text.length - text.trimStart().length;
  const rest = text.slice(m[0].length);
  if (kind === "text") {
    edits.push({ start: start + lead, end: start + m[0].length, text: `<Icon name="${name}"/>` });
  } else {
    // Literal: turn {"⬇ CSV"} / {a?"↻ x":"y"} into a fragment with the icon. Only when the literal is the
    // whole expression or a ternary branch.
    const q = src[node.start];
    edits.push({ start: node.start, end: node.end, text: `<><Icon name="${name}"/>${rest.replace(/[{}<>]/g, (c) => `{"${c}"}`)}</>` });
  }
  (report[`${ch}->${name}`] ||= []).push(line);
}, base);

edits.sort((a, b) => b.start - a.start);
let out = src, last = Infinity;
for (const e of edits) { if (e.end > last) continue; out = out.slice(0, e.start) + e.text + out.slice(e.end); last = e.start; }
console.log(JSON.stringify({ file, changed: edits.length, report }, null, 1));
if (write) fs.writeFileSync(file, out);
