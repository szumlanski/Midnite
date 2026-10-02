#!/usr/bin/env node
// Headless screenshot harness for the Midnite Sentinel UI.
//
//   node scripts/ui-check/shots.mjs [--base http://localhost:3100] [--out DIR] [--only a,b] [--reduced]
//
// Renders the real app (a `next start` server built with NEXT_PUBLIC_SUPABASE_URL=https://stub.supabase.co)
// with a seeded fake Supabase session and every /api/midnite call answered from ./fixtures.mjs.
// Nothing reaches a real service: other origins are aborted and counted in `blocked` (only Google
// Fonts may pass through). Prints ONE JSON summary line on stdout; progress goes to stderr.
// Exit code: 0 = clean, 1 = console/page errors, 2 = failed steps only, 3 = harness crash.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { respond, KNOWN_ACTIONS, ACCOUNT_ID, USER } from "./fixtures.mjs";

const DEFAULT_OUT = "/tmp/claude-0/-home-user-Midnite/1064332e-dd00-5b3f-aac2-b8d7bf1b365e/scratchpad/shots";
const SUPABASE_URL = process.env.UI_CHECK_SUPABASE_URL || "https://stub.supabase.co";
// supabase-js 2.x default storage key: sb-<first label of the project host>-auth-token
// (node_modules/@supabase/supabase-js: `sb-${baseUrl.hostname.split(".")[0]}-auth-token`).
const STORAGE_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const [k, inline] = a.slice(2).split("=", 2);
    if (k === "reduced") { o.reduced = true; continue; }
    o[k] = inline !== undefined ? inline : argv[++i];
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const BASE = String(args.base || "http://localhost:3100").replace(/\/$/, "");
const BASE_ORIGIN = new URL(BASE).origin;
const OUT = args.reduced ? path.join(args.out || DEFAULT_OUT, "reduced") : (args.out || DEFAULT_OUT);
const ONLY = args.only ? new Set(String(args.only).split(",").map((s) => s.trim()).filter(Boolean)) : null;
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { w: 390, h: 844, dsf: 2, mobile: true },
  { w: 1280, h: 800, dsf: 1, mobile: false },
];
const APP_SCREENS = ["fleet", "live", "live-scrolled", "menu", "day", "month", "year", "explorer", "admin", "settings", "settings-alerts", "settings-sharing", "share", "inverter", "compare", "inv-settings"];

const log = (...m) => process.stderr.write(m.join(" ") + "\n");
const summary = { screens: 0, errs: {}, blocked: 0, failedSteps: {} };
const blockedHosts = {};
const fallbackActions = {}; // actions answered by the fixtures' {ok:true} default
let ignoredNoise = 0; // "Failed to load resource" console lines caused by our own aborts / offline fonts

function session() {
  return {
    access_token: "stub", refresh_token: "stub", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600,
    user: { id: USER.id, email: USER.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} },
  };
}
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS" };

// Sandboxes with a TLS-inspecting egress proxy expose its CA via NODE_EXTRA_CA_CERTS / SSL_CERT_FILE.
// Chromium does not read those, so trust exactly those keys (only font requests ever leave the box).
function caSpkiArgs() {
  const file = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
  if (!file) return [];
  try {
    const pems = fs.readFileSync(file, "utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    const hashes = pems.map((p) => {
      try { return crypto.createHash("sha256").update(new crypto.X509Certificate(p).publicKey.export({ type: "spki", format: "der" })).digest("base64"); }
      catch { return null; }
    }).filter(Boolean);
    return hashes.length ? [`--ignore-certificate-errors-spki-list=${hashes.join(",")}`] : [];
  } catch { return []; }
}

async function installRoutes(ctx, abortedUrls) {
  await ctx.route("**/*", async (route) => {
    const req = route.request();
    try {
      const url = new URL(req.url());
      if (url.origin === BASE_ORIGIN) {
        if (url.pathname === "/api/midnite" && req.method() === "POST") {
          const action = url.searchParams.get("action") || "";
          let body = {};
          try { body = req.postDataJSON() || {}; } catch { body = {}; }
          if (!KNOWN_ACTIONS.has(action)) fallbackActions[action] = (fallbackActions[action] || 0) + 1;
          return await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(respond(action, body)) });
        }
        return await route.continue();
      }
      if (url.hostname === new URL(SUPABASE_URL).hostname) {
        if (req.method() === "OPTIONS") return await route.fulfill({ status: 204, headers: CORS, body: "" });
        const json = url.pathname === "/auth/v1/user" ? session().user : {};
        return await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(json) });
      }
      if (FONT_HOSTS.has(url.hostname) && req.method() === "GET") return await route.continue();
      summary.blocked++;
      const h = url.host || url.protocol;
      blockedHosts[h] = (blockedHosts[h] || 0) + 1;
      abortedUrls.add(req.url());
      return await route.abort();
    } catch {
      try { await route.abort(); } catch { /* already handled */ }
    }
  });
}

// Tracks in-flight requests so we can wait for a quiet network after clicks, not just navigations.
function netTracker(page) {
  let inflight = 0, last = Date.now();
  page.on("request", () => { inflight++; last = Date.now(); });
  const done = () => { inflight = Math.max(0, inflight - 1); last = Date.now(); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return async (quietMs = 500, timeout = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (inflight === 0 && Date.now() - last >= quietMs) return true;
      await page.waitForTimeout(100);
    }
    return false;
  };
}

// Placeholder text / busy markers that mean "not populated yet".
const LOADING_RE = "Loading…|Connecting to Midnite portal…|Reading live settings|Loading fleet data…|Loading digest…|Loading alerts…|Checking…";
const populated = (re) => {
  if (new RegExp(re).test(document.body?.innerText || "")) return false;
  return ![...document.querySelectorAll('[aria-busy="true"]')].some((el) => el.getClientRects().length > 0);
};

async function main() {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", headless: true, args: caSpkiArgs() });
  try {
    for (const vp of VIEWPORTS) await runViewport(browser, vp);
  } finally {
    await browser.close();
  }
  const out = { ...summary, blockedHosts, fallbackActions };
  if (ignoredNoise) out.ignoredResourceErrors = ignoredNoise;
  process.stdout.write(JSON.stringify(out) + "\n");
  const errCount = Object.values(summary.errs).reduce((s, a) => s + a.length, 0);
  process.exit(errCount ? 1 : Object.keys(summary.failedSteps).length ? 2 : 0);
}

async function newContext(browser, vp, withSession) {
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: vp.dsf, isMobile: vp.mobile, hasTouch: vp.mobile,
    locale: "en-US", timezoneId: "America/New_York", colorScheme: "light",
    reducedMotion: args.reduced ? "reduce" : "no-preference", serviceWorkers: "block",
  });
  if (withSession) {
    await ctx.addInitScript(({ key, value, accountId }) => {
      try { localStorage.setItem(key, value); localStorage.setItem("midnite_account_id", accountId); } catch { /* opaque origin */ }
    }, { key: STORAGE_KEY, value: JSON.stringify(session()), accountId: ACCOUNT_ID });
  }
  const abortedUrls = new Set();
  await installRoutes(ctx, abortedUrls);
  return { ctx, abortedUrls };
}

async function runViewport(browser, vp) {
  let screen = "init";
  const key = (name) => `${name}-${vp.w}`;
  const want = (name) => !ONLY || ONLY.has(name);

  const attach = (page, abortedUrls) => {
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      const loc = msg.location()?.url || "";
      let host = ""; try { host = new URL(loc).hostname; } catch { /* no url */ }
      if (/^Failed to load resource/.test(text) && (abortedUrls.has(loc) || FONT_HOSTS.has(host))) { ignoredNoise++; return; }
      (summary.errs[key(screen)] ||= []).push(text.slice(0, 500));
    });
    page.on("pageerror", (err) => { (summary.errs[key(screen)] ||= []).push(`pageerror: ${String(err?.message || err).slice(0, 500)}`); });
  };

  const step = async (name, fn) => {
    try { await fn(); return true; }
    catch (e) {
      summary.failedSteps[key(name)] = String(e?.message || e).split("\n")[0].slice(0, 300);
      log(`  x ${key(name)}: ${summary.failedSteps[key(name)]}`);
      return false;
    }
  };

  const settle = async (page, idle) => {
    await idle(500, 10000);
    const ok = await page.waitForFunction(populated, LOADING_RE, { timeout: 10000 }).then(() => true, () => false);
    if (!ok && !summary.failedSteps[key(screen)]) summary.failedSteps[key(screen)] = "still showing a loading placeholder after 10s";
    await idle(300, 5000);
    await page.waitForTimeout(800);
  };

  // Full-page shots grow the viewport to the document height first, so fixed bars (phone tab bar,
  // sticky nav) render where a real tall screen would put them instead of mid-page.
  const shoot = async (page, idle, name, { full = true } = {}) => {
    if (!want(name)) return;
    await settle(page, idle);
    const file = path.join(OUT, `${name}-${vp.w}.png`);
    try {
      if (full) {
        const h = await page.evaluate(() => Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0)));
        if (h > vp.h) { await page.setViewportSize({ width: vp.w, height: Math.min(h, 16000) }); await page.waitForTimeout(400); }
        await page.screenshot({ path: file, fullPage: true });
        await page.setViewportSize({ width: vp.w, height: vp.h });
      } else {
        await page.screenshot({ path: file });
      }
      summary.screens++;
      log(`  ok ${path.basename(file)}`);
    } catch (e) {
      summary.failedSteps[key(name)] = `screenshot: ${String(e?.message || e).split("\n")[0]}`;
      try { await page.setViewportSize({ width: vp.w, height: vp.h }); } catch { /* ignore */ }
    }
  };

  log(`viewport ${vp.w}x${vp.h} @${vp.dsf}x${args.reduced ? " (reduced motion)" : ""}`);

  // ── landing (no session) ──
  if (want("landing")) {
    const { ctx, abortedUrls } = await newContext(browser, vp, false);
    const page = await ctx.newPage(); attach(page, abortedUrls); const idle = netTracker(page);
    screen = "landing";
    if (await step("landing", async () => {
      await page.goto(BASE, { waitUntil: "load" });
      await page.locator("#lp-auth").waitFor({ timeout: 15000 });
    })) await shoot(page, idle, "landing");
    await ctx.close();
  }

  // ── signed-in flow: one page, screens in order ──
  if (ONLY && !APP_SCREENS.some((s) => ONLY.has(s))) return;
  const { ctx, abortedUrls } = await newContext(browser, vp, true);
  const page = await ctx.newPage(); attach(page, abortedUrls); const idle = netTracker(page);

  // Locators are tried in order; the first VISIBLE match wins (phone and desktop render different
  // controls for the same action, and the hidden twin stays in the DOM).
  const firstVisible = async (locators) => {
    for (const loc of locators) {
      const n = await loc.count();
      for (let i = 0; i < n; i++) { const el = loc.nth(i); if (await el.isVisible()) return el; }
    }
    return null;
  };
  const exactText = (label) => new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
  // Items that live in the "More" (…) menu on phones: Settings, Admin, Sign out.
  const viaMoreMenu = async (labelRe) => {
    const more = await firstVisible([page.getByRole("button", { name: "More", exact: true })]);
    if (!more) return false;
    await more.click();
    const item = page.locator('[role="menu"] [role^="menuitem"]').filter({ hasText: labelRe }).first();
    await item.waitFor({ timeout: 3000 });
    await item.click();
    return true;
  };
  const clickTab = async (label) => {
    const el = await firstVisible([
      page.getByRole("tab", { name: label, exact: true }),
      page.getByRole("button", { name: label, exact: true }),
      page.locator(".ui-tabbar button, .bottom-nav button, .top-tabs button").filter({ hasText: exactText(label) }),
    ]);
    if (el) return el.click();
    if (await viaMoreMenu(exactText(label))) return;
    throw new Error(`tab "${label}" not found`);
  };
  const openSettings = async () => {
    const el = await firstVisible([page.getByRole("button", { name: "Settings", exact: true }), page.getByRole("button", { name: "Account settings", exact: true })]);
    if (el) return el.click();
    if (await viaMoreMenu(/^\s*Settings/)) return;
    throw new Error('"Settings" control not found');
  };
  const openShare = async () => {
    const el = await firstVisible([page.getByRole("button", { name: /^(↗\s*)?Share( site)?$/ })]);
    if (!el) throw new Error('"Share" control not found');
    await el.click();
  };
  const clickModalTab = async (label) => {
    const el = await firstVisible([page.getByRole("tab", { name: label, exact: true }), page.getByRole("button", { name: label, exact: true })]);
    if (!el) throw new Error(`settings section "${label}" not found`);
    await el.click();
  };
  const chartReady = async (heading) => {
    await page.getByRole("heading", { name: heading, exact: true }).first().waitFor({ timeout: 15000 });
    await page.locator(".recharts-surface").first().waitFor({ timeout: 15000 });
  };
  const liveReady = async () => {
    await page.getByText(/power flow/i).first().waitFor({ timeout: 20000 });
    await page.locator(".inv-card").first().waitFor({ timeout: 10000 });
  };
  // Re-open the saved site on the Live tab (closes any modal, resets scroll and tab).
  const reloadSite = async () => {
    await page.evaluate(() => localStorage.setItem("midnite_selected_site", "Wise Naples"));
    await page.goto(BASE, { waitUntil: "load" });
    await liveReady();
  };

  screen = "fleet";
  const fleetOk = await step("fleet", async () => {
    await page.goto(BASE, { waitUntil: "load" });
    await page.getByRole("heading", { name: "Fleet", exact: true }).first().waitFor({ timeout: 20000 });
    await page.locator("tr", { hasText: "Wise Naples" }).first().waitFor({ timeout: 10000 });
  });
  if (fleetOk) await shoot(page, idle, "fleet");

  screen = "live";
  const liveOk = await step("live", async () => {
    try {
      await page.locator("tr", { hasText: "Wise Naples" }).first().getByText("Wise Naples", { exact: true }).click({ timeout: 5000 });
      await liveReady();
    } catch {
      await reloadSite(); // fallback: the app restores the saved site on load
    }
  });
  if (liveOk) await shoot(page, idle, "live");

  screen = "live-scrolled";
  if (liveOk && await step("live-scrolled", async () => {
    await page.locator(".inv-card").first().evaluate((el) => { el.scrollIntoView({ block: "start" }); window.scrollBy(0, -72); });
  })) await shoot(page, idle, "live-scrolled", { full: false });

  screen = "menu";
  if (liveOk && await step("menu", async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    const more = await firstVisible([page.getByRole("button", { name: "More", exact: true })]);
    if (!more) throw new Error('"More" button not found');
    await more.click();
    await page.locator('[role="menu"]').first().waitFor({ timeout: 3000 });
  })) {
    await shoot(page, idle, "menu", { full: false });
    await page.keyboard.press("Escape");
  }

  for (const [name, label, ready] of [
    ["day", "Day", () => chartReady("Day")],
    ["month", "Month", () => chartReady("Month")],
    ["year", "Year", () => chartReady("Year")],
    ["explorer", "Explorer", () => chartReady("Explorer")],
    ["admin", "Admin", async () => {
      await page.getByText("Fleet Overview", { exact: true }).waitFor({ timeout: 15000 });
      await page.getByText(/^Energy Registers/).first().waitFor({ timeout: 10000 });
    }],
  ]) {
    screen = name;
    if (!liveOk) { summary.failedSteps[key(name)] = "skipped: site did not open"; continue; }
    await page.evaluate(() => window.scrollTo(0, 0));
    if (await step(name, async () => { await clickTab(label); await ready(); })) await shoot(page, idle, name);
  }

  // Modals are viewport shots: they are fixed overlays with their own scroll.
  screen = "settings";
  const settingsOk = liveOk && await step("settings", async () => {
    await reloadSite();
    await openSettings();
    await page.getByText("Linked Midnite accounts", { exact: true }).waitFor({ timeout: 10000 });
  });
  if (settingsOk) await shoot(page, idle, "settings", { full: false });

  screen = "settings-alerts";
  if (settingsOk && await step("settings-alerts", async () => {
    await clickModalTab("Alerts");
    await page.getByText("Threshold alerts", { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText(/Daily digest/).first().waitFor({ timeout: 10000 });
  })) await shoot(page, idle, "settings-alerts", { full: false });

  screen = "settings-sharing";
  if (settingsOk && await step("settings-sharing", async () => {
    await clickModalTab("Sharing");
    await page.getByText("Shared by you", { exact: true }).waitFor({ timeout: 10000 });
  })) await shoot(page, idle, "settings-sharing", { full: false });

  screen = "share";
  if (liveOk && await step("share", async () => {
    await reloadSite();
    await openShare();
    await page.getByText("Share site", { exact: true }).first().waitFor({ timeout: 10000 });
    await page.getByText("homeowner@example.com").first().waitFor({ timeout: 10000 });
  })) await shoot(page, idle, "share", { full: false });

  // Single-inverter Live view (InverterDetailPanel): tap the first inverter pill.
  screen = "inverter";
  if (liveOk && await step("inverter", async () => {
    await reloadSite();
    await page.locator("button[aria-pressed]").filter({ hasText: /^INV-1/ }).first().click();
    await page.getByText("Inverter details and firmware", { exact: true }).first().waitFor({ timeout: 10000 });
  })) await shoot(page, idle, "inverter");

  screen = "compare";
  if (liveOk && await step("compare", async () => {
    await reloadSite();
    await page.getByRole("button", { name: "Compare settings" }).first().click();
    await page.getByRole("heading", { name: "Compare inverter settings" }).first().waitFor({ timeout: 10000 });
    await page.locator('[role="dialog"] table').first().waitFor({ timeout: 15000 });
  })) await shoot(page, idle, "compare", { full: false });

  screen = "inv-settings";
  if (liveOk && await step("inv-settings", async () => {
    await reloadSite();
    await page.getByRole("button", { name: "Inverter settings" }).first().click();
    await page.locator('[role="dialog"] .ui-group').first().waitFor({ timeout: 15000 });
  })) await shoot(page, idle, "inv-settings", { full: false });

  await ctx.close();
}

main().catch((e) => {
  log(`fatal: ${e?.stack || e}`);
  process.stdout.write(JSON.stringify({ ...summary, fatal: String(e?.message || e) }) + "\n");
  process.exit(3);
});
