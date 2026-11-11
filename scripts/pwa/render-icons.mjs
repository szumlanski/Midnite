// Render the PWA icons from public/logo.svg with the preinstalled Playwright Chromium.
//   node scripts/pwa/render-icons.mjs
// Writes public/icon-192.png, public/icon-512.png, public/icon-512-maskable.png, public/apple-touch-icon.png.
// - "any" icons: the logo as drawn (rounded navy square on a transparent background).
// - maskable: full-bleed navy square, logo scaled to 80% so the sun stays inside the maskable safe zone.
// - apple-touch-icon: full-bleed navy square (iOS adds its own rounded mask and shows black behind transparency).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core"; // devDependency, same as scripts/ui-check

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUB = path.join(ROOT, "public");
const svg = fs.readFileSync(path.join(PUB, "logo.svg"), "utf8");
const NAVY = "#0D1F33";
// Square-cornered copy of the logo (no rx on the background) for full-bleed icons.
const squareSvg = svg.replace(/<rect width="256" height="256" rx="40"/, '<rect width="256" height="256"');

const page = (inner, bg) => `<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:${bg};}
.wrap{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;}
svg{display:block;}
</style></head><body><div class="wrap">${inner}</div></body></html>`;

const sized = (s, pct) => s.replace("<svg ", `<svg width="${pct}vw" height="${pct}vh" `);

const JOBS = [
  { file: "icon-192.png", size: 192, html: page(sized(svg, 100), "transparent"), transparent: true },
  { file: "icon-512.png", size: 512, html: page(sized(svg, 100), "transparent"), transparent: true },
  { file: "icon-512-maskable.png", size: 512, html: page(sized(squareSvg, 80), NAVY), transparent: false },
  { file: "apple-touch-icon.png", size: 180, html: page(sized(squareSvg, 100), NAVY), transparent: false },
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium", headless: true });
try {
  for (const j of JOBS) {
    const ctx = await browser.newContext({ viewport: { width: j.size, height: j.size }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();
    await p.setContent(j.html, { waitUntil: "load" });
    await p.screenshot({ path: path.join(PUB, j.file), omitBackground: j.transparent });
    await ctx.close();
    console.log(`wrote public/${j.file} (${j.size}x${j.size})`);
  }
} finally {
  await browser.close();
}
