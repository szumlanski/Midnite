// AST codemod: numeric `fontSize` in HTML inline styles -> type-scale tokens (FS.*).
// Usage: node scripts/hig/codemod-fontsize.mjs pages/index.jsx [--write]
// Only touches `fontSize: <number>` inside a `style={{...}}` on a lowercase HTML element, or inside a
// top-level `const xxx = {...}` / arrow returning an object (shared style objects). SVG text, Recharts
// props (tick, label, contentStyle) and display numbers (>= 30px) are left alone.
import fs from "node:fs";
import * as acorn from "acorn";
import jsx from "acorn-jsx";
import * as walk from "acorn-walk";

const file = process.argv[2];
const write = process.argv.includes("--write");
const src = fs.readFileSync(file, "utf8");
const Parser = acorn.Parser.extend(jsx());
const ast = Parser.parse(src, { ecmaVersion: "latest", sourceType: "module", locations: true });

// JSX node types for acorn-walk
const base = { ...walk.base };
const jsxTypes = ["JSXElement", "JSXFragment", "JSXOpeningElement", "JSXClosingElement", "JSXAttribute", "JSXSpreadAttribute",
  "JSXExpressionContainer", "JSXText", "JSXIdentifier", "JSXMemberExpression", "JSXNamespacedName", "JSXEmptyExpression", "JSXClosingFragment", "JSXOpeningFragment", "JSXSpreadChild"];
for (const t of jsxTypes) base[t] = () => {};
base.JSXElement = (n, st, c) => { c(n.openingElement, st); for (const ch of n.children) c(ch, st); };
base.JSXFragment = (n, st, c) => { for (const ch of n.children) c(ch, st); };
base.JSXOpeningElement = (n, st, c) => { for (const a of n.attributes) c(a, st); };
base.JSXAttribute = (n, st, c) => { if (n.value) c(n.value, st); };
base.JSXSpreadAttribute = (n, st, c) => c(n.argument, st);
base.JSXExpressionContainer = (n, st, c) => { if (n.expression.type !== "JSXEmptyExpression") c(n.expression, st); };

const MAP = (px) => {
  if (px >= 30) return null;
  if (px <= 11.5) return "caption";
  if (px <= 12.5) return "footnote";
  if (px <= 13) return "subhead";
  if (px <= 14) return "body";
  if (px <= 16) return "callout";
  if (px <= 18) return "headline";
  if (px <= 20) return "title3";
  if (px <= 24) return "title2";
  return "title1";
};
const SVG_TAGS = new Set(["svg", "text", "tspan", "g", "path", "circle", "rect", "line"]);

const edits = [];
const skipped = [];
// Walk with ancestors to decide context.
walk.fullAncestor(ast, (node, _st, ancestors) => {
  if (node.type !== "Property" || node.computed) return;
  const key = node.key.type === "Identifier" ? node.key.name : node.key.value;
  if (key !== "fontSize" || node.value.type !== "Literal" || typeof node.value.value !== "number") return;
  const px = node.value.value;
  // Find the nearest JSXAttribute ancestor (if any).
  let attr = null, el = null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (!attr && a.type === "JSXAttribute") attr = a;
    if (attr && a.type === "JSXOpeningElement") { el = a; break; }
  }
  let ok = false;
  if (attr) {
    const attrName = attr.name.name;
    const tag = el?.name?.type === "JSXIdentifier" ? el.name.name : "";
    ok = attrName === "style" && /^[a-z]/.test(tag) && !SVG_TAGS.has(tag);
  } else {
    // Shared style objects (const fooS = {...} or const fooBtn = (x)=>({...})) at any level outside JSX.
    ok = ancestors.some((a) => a.type === "VariableDeclarator");
  }
  const tok = MAP(px);
  const line = node.loc.start.line;
  if (!ok || !tok) { skipped.push(`${line}: fontSize ${px}${!ok ? " (context)" : " (display size)"}`); return; }
  edits.push({ start: node.value.start, end: node.value.end, text: `FS.${tok}`, line, px, tok });
}, base);

edits.sort((a, b) => b.start - a.start);
let out = src;
for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
const counts = edits.reduce((m, e) => ((m[`${e.px}->${e.tok}`] = (m[`${e.px}->${e.tok}`] || 0) + 1), m), {});
console.log(JSON.stringify({ file, changed: edits.length, skipped: skipped.length, counts }, null, 0));
if (process.argv.includes("--verbose")) console.log(skipped.join("\n"));
if (write) fs.writeFileSync(file, out);
