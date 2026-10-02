// AST codemod for the HIG foundation pass (v0.3.0). Edits are computed on the AST and applied from the
// end of the file backwards, so offsets stay valid.
//   1. Text colors: `color`/`fill` set to FAINT (2.5:1) become MUTED (5.3:1). Covers plain values and
//      either branch of a ternary, in style objects and in color/fill JSX attributes on SVG text.
//   2. Sentence case: drop `textTransform:"uppercase"` and the tracking that went with it.
//   3. Type scale: numeric `fontSize` in HTML inline styles and shared style objects becomes FS.* (CSS vars
//      that grow on phones). SVG text, Recharts props and display numbers (>= 30px) stay as they are.
// Usage: node scripts/hig/codemod-foundation.mjs <file> [--write] [--verbose]
import fs from "node:fs";
import * as acorn from "acorn";
import jsx from "acorn-jsx";
import * as walk from "acorn-walk";

const file = process.argv[2];
const write = process.argv.includes("--write");
const verbose = process.argv.includes("--verbose");
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

const SVG_TAGS = new Set(["svg", "text", "tspan", "g", "path", "circle", "rect", "line", "polyline", "polygon"]);
const SVG_TEXT = new Set(["text", "tspan"]);
const MAP = (px) => (px >= 30 ? null : px <= 11.5 ? "caption" : px <= 12.5 ? "footnote" : px <= 13 ? "subhead" : px <= 14 ? "body" : px <= 16 ? "callout" : px <= 18 ? "headline" : px <= 20 ? "title3" : px <= 24 ? "title2" : "title1");

const edits = [];
const log = [];
const stat = { faint: 0, uppercase: 0, tracking: 0, fontSize: 0 };
const keyName = (p) => (p.key?.type === "Identifier" ? p.key.name : p.key?.value);
const isFaint = (n) => n && n.type === "Identifier" && n.name === "FAINT";

function faintToMuted(node) {
  if (isFaint(node)) { edits.push({ start: node.start, end: node.end, text: "MUTED" }); stat.faint++; return; }
  if (node?.type === "ConditionalExpression") { faintToMuted(node.consequent); faintToMuted(node.alternate); }
  if (node?.type === "LogicalExpression") { faintToMuted(node.right); }
}

function context(ancestors) {
  let attr = null, el = null;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (!attr && a.type === "JSXAttribute") attr = a;
    if (attr && a.type === "JSXOpeningElement") { el = a; break; }
  }
  const tag = el?.name?.type === "JSXIdentifier" ? el.name.name : "";
  return { attrName: attr?.name?.name || null, tag };
}

// Remove a property including its trailing comma (or the preceding one when it is last).
function removeProp(obj, prop) {
  const i = obj.properties.indexOf(prop);
  const next = obj.properties[i + 1];
  if (next) edits.push({ start: prop.start, end: next.start, text: "" });
  else if (i > 0) edits.push({ start: obj.properties[i - 1].end, end: prop.end, text: "" });
  else edits.push({ start: prop.start, end: prop.end, text: "" });
}

walk.fullAncestor(ast, (node, _st, ancestors) => {
  // JSX attribute color={FAINT} / fill={FAINT} on SVG text or components that pass it on as text color.
  if (node.type === "JSXAttribute" && (node.name?.name === "fill" || node.name?.name === "color") && node.value?.type === "JSXExpressionContainer") {
    const op = ancestors[ancestors.length - 2];
    const tag = op?.name?.type === "JSXIdentifier" ? op.name.name : "";
    if (SVG_TEXT.has(tag) || /^[A-Z]/.test(tag)) faintToMuted(node.value.expression);
    return;
  }
  if (node.type !== "ObjectExpression") return;
  const props = node.properties.filter((p) => p.type === "Property" && !p.computed);
  const upper = props.find((p) => keyName(p) === "textTransform" && p.value.type === "Literal" && p.value.value === "uppercase");
  if (upper) {
    removeProp(node, upper); stat.uppercase++;
    const ls = props.find((p) => keyName(p) === "letterSpacing" && p.value.type === "Literal" && /^0?\.\d+em$/.test(String(p.value.value)));
    if (ls) { removeProp(node, ls); stat.tracking++; }
    log.push(`${upper.loc.start.line}: uppercase removed`);
  }
  for (const p of props) {
    const k = keyName(p);
    if (k === "color" || k === "fill") faintToMuted(p.value);
    if (k === "fontSize" && p.value.type === "Literal" && typeof p.value.value === "number") {
      const { attrName, tag } = context(ancestors);
      const ok = attrName ? attrName === "style" && /^[a-z]/.test(tag) && !SVG_TAGS.has(tag) : ancestors.some((a) => a.type === "VariableDeclarator");
      const tok = MAP(p.value.value);
      if (ok && tok) { edits.push({ start: p.value.start, end: p.value.end, text: `FS.${tok}` }); stat.fontSize++; }
      else log.push(`${p.loc.start.line}: fontSize ${p.value.value} kept (${!ok ? `context ${attrName || "?"}/${tag}` : "display size"})`);
    }
  }
}, base);

// Apply back to front; drop overlapping edits (first one wins).
edits.sort((a, b) => b.start - a.start || b.end - a.end);
let out = src, lastStart = Infinity;
for (const e of edits) {
  if (e.end > lastStart) continue;
  out = out.slice(0, e.start) + e.text + out.slice(e.end);
  lastStart = e.start;
}
console.log(JSON.stringify({ file, ...stat }));
if (verbose) console.log(log.join("\n"));
if (write) fs.writeFileSync(file, out);
