// ─────────────────────────────────────────────────────────────────────────────
// Server-side Midnite helpers for the notifications heartbeat (and the alert
// engine's Supabase access). These are FROZEN copies of the proven helpers in
// pages/api/midnite.js — the signing constants, login dual-path, and the
// InverterDetailInfoNewone normaliser are documented as immutable ("the ONLY
// working API"), so duplicating them here keeps the high-traffic proxy file
// 100% untouched (zero regression risk) rather than refactoring it.
//
// SOURCE OF TRUTH for this logic: pages/api/midnite.js. If the signing or login
// flow ever changes there (it shouldn't), mirror it here.
// ─────────────────────────────────────────────────────────────────────────────

import CryptoJS from "crypto-js";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { validateGenWrites } from "./generator/registers.js";

const BASE = "https://service.midnitepower.com/API/CodeIgniter/index.php";
const AES_KEY = "05469137076236813460585715952089";
const AES_IV = "5161557162012237";
const SALT = "05469137076236813460585715952089";

let _sb = null;
function supabaseAdmin() {
  if (_sb) return _sb;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _sb;
}

function encKey() {
  const k = process.env.CREDS_ENC_KEY || "";
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex");
  try { const b = Buffer.from(k, "base64"); if (b.length === 32) return b; } catch {}
  return crypto.createHash("sha256").update(String(k)).digest();
}
function decryptCred(blob) {
  const b = Buffer.from(blob, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}

function makeSign(params) {
  const filtered = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== "" && typeof v !== "boolean"));
  const sortedKeys = Object.keys(filtered).sort();
  const parts = sortedKeys.map((k) => (Array.isArray(filtered[k]) ? `${k}=Array` : `${k}=${filtered[k]}`));
  const plaintext = parts.join("&") + "&" + SALT;
  const key = CryptoJS.enc.Utf8.parse(AES_KEY);
  const iv = CryptoJS.enc.Utf8.parse(AES_IV);
  return CryptoJS.AES.encrypt(plaintext, key, { iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }).toString();
}

async function midnitePost(path, body, token = null) {
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json",
    "Origin": "https://service.midnitepower.com",
    "Referer": "https://service.midnitepower.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    "Cookie": "timezone=America%2FNew_York",
  };
  if (token) headers["authorization"] = token;
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) { const text = await res.text(); throw new Error(`Midnite ${res.status}: ${text}`); }
  return res.json();
}

async function login(user = null, pass = null) {
  const username = user || process.env.MIDNITE_USERNAME || "Wise Naples";
  const password = pass || process.env.MIDNITE_PASSWORD || "921551";
  let eagleToken = null, eagleMemberId = "";
  let senToken = null, senMemberId = "";
  try {
    const opParams = { MemberID: username, PassWord: password };
    opParams.sign = makeSign(opParams);
    const opData = await midnitePost("/Eagle/v1/Operation/login", opParams);
    if (opData.token) { eagleToken = opData.token; eagleMemberId = String(opData.MemberAutoID || ""); }
  } catch (e) { /* try Senergytec */ }
  try {
    const params = { MemberID: username, Password: password, type: "1" };
    params.sign = makeSign(params);
    const data = await midnitePost("/Senergytec/web/v2/Inverterapi/UserLogin", { ...params, remember: false });
    if (data.status === "ok") { senToken = data.token; senMemberId = String(data.MemberAutoID || ""); }
  } catch (e) { /* installer-only account */ }
  if (!eagleToken && !senToken) throw new Error("Login failed: Invalid username or password");
  const memberAutoId = senMemberId || eagleMemberId;
  if (eagleToken) return { token: eagleToken, senToken: senToken || null, memberAutoId, accountType: "installer", username };
  return { token: senToken, senToken, memberAutoId, accountType: "enduser", username };
}

const _midAuthCache = new Map(); // username(lc) → { auth, ts }
async function loginCached(username, password) {
  const k = (username || "").toLowerCase();
  const hit = _midAuthCache.get(k);
  if (hit && Date.now() - hit.ts < 4 * 60 * 1000) return hit.auth;
  const auth = await login(username, password);
  _midAuthCache.set(k, { auth, ts: Date.now() });
  return auth;
}

// Normalize InverterDetailInfoNewone (the universal per-inverter status feed) —
// frozen copy of normalizeDetail() from pages/api/midnite.js.
function normalizeDetail(raw) {
  if (!raw || raw.GoodsID === undefined) return null;
  const pvW = parseFloat(raw.TotalDCpower || 0);
  const loadPacRaw = raw.loadCurrpac;
  const epsPacRaw = raw.epsCurrpac;
  const loadSum = (parseFloat(loadPacRaw?.[0] || 0) + parseFloat(loadPacRaw?.[1] || 0) + parseFloat(loadPacRaw?.[2] || 0));
  const epsSum = (parseFloat(epsPacRaw?.[0] || 0) + parseFloat(epsPacRaw?.[1] || 0));
  const useEPS = loadSum === 0 && epsSum > 0;
  const loadPac = useEPS ? epsPacRaw : loadPacRaw;
  const loadVac = useEPS ? raw.epsVac : raw.loadVac;
  const loadIac = useEPS ? raw.epsIac : raw.loadIac;
  const loadEnergyDay = useEPS ? parseFloat(raw.EPSDay || 0) : parseFloat(raw.ELDay || 0);
  const loadEnergyTotal = useEPS ? parseFloat(raw.EPSTotal || 0) : parseFloat(raw.ELTotal || 0);
  const gridNetW = (parseFloat(raw.gridCurrpac?.[0] || 0) + parseFloat(raw.gridCurrpac?.[1] || 0) + parseFloat(raw.gridCurrpac?.[2] || 0));
  const batChargeW = parseFloat(raw.toPbat || 0);
  const batDischargeW = parseFloat(raw.fromPbat || 0);
  return {
    inverter: { online: true, model: raw.modelName || "", sn: raw.GoodsID, temperature: parseFloat(raw.Tntc || 0), lastUpdateTime: raw.DataTime || "" },
    photovoltaic: { power: { totalDc: pvW, peak: parseFloat(raw.Peackpower || 0) }, production: { today: parseFloat(raw.EToday || 0) * 1000, total: parseFloat(raw.ETotal || 0) * 1000 } },
    grid: {
      lines: [
        { power: Math.abs(parseFloat(raw.gridCurrpac?.[0] || 0)), voltage: parseFloat(raw.gridVac?.[0] || 0), current: parseFloat(raw.gridIac?.[0] || 0), frequency: parseFloat(raw.gridFac || 0) },
        { power: Math.abs(parseFloat(raw.gridCurrpac?.[1] || 0)), voltage: parseFloat(raw.gridVac?.[1] || 0), current: parseFloat(raw.gridIac?.[1] || 0), frequency: parseFloat(raw.gridFac || 0) },
      ],
      netW: gridNetW,
      sold: { today: parseFloat(raw.ETDay || 0) * 1000, total: parseFloat(raw.ETTotal || 0) * 1000 },
      consumption: { today: parseFloat(raw.EFDay || 0) * 1000, total: parseFloat(raw.EFTotal || 0) * 1000 },
    },
    load: {
      lines: [
        { power: parseFloat(loadPac?.[0] || 0), voltage: parseFloat(loadVac?.[0] || 0), current: parseFloat(loadIac?.[0] || 0) },
        { power: parseFloat(loadPac?.[1] || 0), voltage: parseFloat(loadVac?.[1] || 0), current: parseFloat(loadIac?.[1] || 0) },
      ],
      power: { today: loadEnergyDay * 1000, total: loadEnergyTotal * 1000 },
    },
    battery: {
      brand: raw.brand || "", capacityAh: parseFloat(raw.capacity || 0) + parseFloat(raw.capacity2 || 0), voltage: parseFloat(raw.volt || 0), current: parseFloat(raw.cur || 0),
      charge: batChargeW, discharge: batDischargeW, soc: parseFloat(raw.SOC || 0), healthPercent: parseFloat(raw.SOH || 0), temperature: parseFloat(raw.BMS_temp || 0),
      chargeIn: { total: parseFloat(raw.Etotal_batChrg || 0) * 1000 }, dischargeOut: { total: parseFloat(raw.Etotal_batDischrg || 0) * 1000 },
    },
  };
}

// Fetch one inverter's normalized status via the universal Senergytec endpoint
// (no AutoID needed — works for every linked account type).
async function fetchInverterDetail(auth, sn) {
  const senTok = auth.senToken || auth.token;
  const body = { GoodsID: sn, MemberAutoID: auth.memberAutoId };
  body.sign = makeSign(body);
  const raw = await midnitePost("/Senergytec/web/v2/Inverterapi/InverterDetailInfoNewone", body, senTok);
  return normalizeDetail(raw);
}

// Generator legs from the rich inverter status (getInverterStatus), the same call the MNP app's detail screen uses
// ("Generator L1 / L2 V / A / W, Frequency"). Shape of data.gen read defensively; `raw` kept for checking.
async function fetchGenLegs(auth, autoId, memberAutoId) {
  if (!autoId || !memberAutoId) return null;
  const body = { AutoId: String(autoId), memberAutoID: String(memberAutoId) }; body.sign = makeSign(body);
  const r = await midnitePost("/Eagle/v1/Inverterapi/getInverterStatus", body, auth.token);
  const g = r?.data?.gen; if (!g) return null;
  const n = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const lines = Array.isArray(g.lines) ? g.lines : Array.isArray(g.line) ? g.line : [];
  const leg = (l) => l ? { v: n(l.voltage ?? l.volt ?? l.v), a: n(l.current ?? l.cur ?? l.a), w: n(l.power ?? l.w) } : null;
  return {
    l1: leg(lines[0]), l2: leg(lines[1]),
    hz: n(g.frequency ?? g.freq ?? g.fac ?? g.hz),
    at: r?.data?.inverter?.lastUpdateTime || null,
    raw: g,
  };
}

// Recipient email for a user = the email on their profile (kept in sync by the
// new-user trigger + getSaasUser upsert in the proxy).
async function getRecipientEmail(userId) {
  const sb = supabaseAdmin();
  if (!sb) return null;
  const { data } = await sb.from("profiles").select("email").eq("id", userId).maybeSingle();
  return data?.email || null;
}

// ── Site enumeration + historical fetch (for the daily digest) ───────────────
// Frozen copies of loadSites / the day & month actions from pages/api/midnite.js.
// Returns sites as [{ name, memberAutoId, serials:[sn…] }].
async function fetchSites(auth) {
  if (auth.accountType === "installer") {
    const now = new Date();
    const base = { MemberID: auth.username, EndUserName: "", OperationName: "", GoodsID: "",
      inDate: now.toISOString().split("T")[0], inTime: now.toTimeString().split(" ")[0], status: 0 };
    const raw = [];
    for (let page = 1; page <= 100; page++) {
      const body = { ...base, Page: page }; body.sign = makeSign(body);
      const data = await midnitePost("/Eagle/v1/Operation/terminaluserinfo", body, auth.token);
      const pageSites = Array.isArray(data) ? data : [];
      raw.push(...pageSites);
      if (pageSites.length === 0) break;
    }
    return raw.map(s => ({
      name: s.MemberID,
      memberAutoId: String(s.MemberAutoID || ""),
      serials: (s.GoodsID || []).map(g => (typeof g === "string" ? g : g.GoodsID)).filter(Boolean),
    }));
  }
  // End-user: enumerate groups → inverter lists.
  const glBody = { MemberAutoID: auth.memberAutoId, inputValue: "" }; glBody.sign = makeSign(glBody);
  const groups = await midnitePost("/Senergytec/web/v2/Inverterapi/GroupList", glBody, auth.token);
  const sites = [];
  for (const g of (groups?.AllGroupList || [])) {
    const ilBody = { MemberAutoID: auth.memberAutoId, GroupAutoID: g.AutoID }; ilBody.sign = makeSign(ilBody);
    const result = await midnitePost("/Senergytec/web/v2/Inverterapi/InverterList", ilBody, auth.token);
    sites.push({
      name: auth.username,
      memberAutoId: String(auth.memberAutoId || ""),
      serials: (result?.AllInverterList || []).map(d => d.GoodsID).filter(Boolean),
    });
  }
  // Fallback: a single implicit site for the account if GroupList came back empty.
  if (!sites.length) return [{ name: auth.username, memberAutoId: String(auth.memberAutoId || ""), serials: [] }];
  return sites;
}

// Intraday day curve for one inverter (WATTS). date = "YYYY-MM-DD".
async function fetchDay(auth, sn, date) {
  const body = { GoodsID: sn, date }; body.sign = makeSign(body);
  return midnitePost("/Senergytec/web/v2/Inverterapi/dayProductionAndConsumptionAreaTime", body, auth.token);
}

// Per-day month rollup for one inverter (kWh). ym = "YYYY-MM".
async function fetchMonth(auth, sn, ym) {
  const body = { GoodsID: sn, date: ym }; body.sign = makeSign(body);
  return midnitePost("/Senergytec/web/v2/Inverterapi/monthProductionAndConsumptionArea", body, auth.token);
}

// ── SaaS user (frozen copy of getSaasUser in pages/api/midnite.js) ───────────
// Verify the Supabase access token, ensure a profile exists, return { user, role }.
async function getSaasUser(req) {
  const sb = supabaseAdmin();
  if (!sb) { const e = new Error("Auth not configured"); e.code = 500; throw e; }
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) { const e = new Error("Not authenticated"); e.code = 401; throw e; }
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) { const e = new Error("Invalid session"); e.code = 401; throw e; }
  const user = data.user;
  let { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!prof) { await sb.from("profiles").upsert({ id: user.id, email: user.email }); prof = { role: "user" }; }
  return { user, role: prof.role || "user" };
}

// ── Sites WITH inverter AutoIds (frozen copy of loadSites in pages/api/midnite.js) ──
// Returns { accountType, sites:[{ MemberID, MemberAutoID, GoodsID:[{GoodsID, AutoID}] , ...}] }.
async function loadSitesWithAutoIds(auth) {
  if (auth.accountType === "installer") {
    const now = new Date();
    const baseBody = { MemberID: auth.username, EndUserName: "", OperationName: "", GoodsID: "", inDate: now.toISOString().split("T")[0], inTime: now.toTimeString().split(" ")[0], status: 0 };
    const sites = [];
    for (let page = 1; page <= 100; page++) {
      const body = { ...baseBody, Page: page }; body.sign = makeSign(body);
      const data = await midnitePost("/Eagle/v1/Operation/terminaluserinfo", body, auth.token);
      const pageSites = Array.isArray(data) ? data : []; sites.push(...pageSites);
      if (pageSites.length === 0) break;
    }
    const autoIdMap = {};
    for (const memberID of new Set(sites.map(s => s.MemberID).filter(Boolean))) {
      try {
        const ilb = { MemberID: memberID }; ilb.sign = makeSign(ilb);
        const result = await midnitePost("/Eagle/v1/Inverterapi/InverterList", ilb, auth.token);
        for (const inv of (result?.AllInverterList || [])) if (inv.GoodsID && inv.AutoID) autoIdMap[inv.GoodsID] = { autoId: String(inv.AutoID), memberAutoId: String(inv.MemberAutoID || "") };
      } catch (e) { console.log("[Eagle InverterList err]", e.message); }
    }
    const enriched = sites.map(s => {
      const firstSn = typeof s.GoodsID?.[0] === "string" ? s.GoodsID[0] : s.GoodsID?.[0]?.GoodsID;
      const siteMemberAutoId = autoIdMap[firstSn]?.memberAutoId || s.MemberAutoID || "";
      return { ...s, MemberAutoID: siteMemberAutoId, GoodsID: (s.GoodsID || []).map(g => { const sn = typeof g === "string" ? g : g.GoodsID; return { GoodsID: sn, AutoID: autoIdMap[sn]?.autoId || null }; }) };
    });
    return { accountType: "installer", sites: enriched };
  }
  const glBody = { MemberAutoID: auth.memberAutoId, inputValue: "" }; glBody.sign = makeSign(glBody);
  const groups = await midnitePost("/Senergytec/web/v2/Inverterapi/GroupList", glBody, auth.token);
  const sites = [];
  for (const g of (groups?.AllGroupList || [])) {
    const ilBody = { MemberAutoID: auth.memberAutoId, GroupAutoID: g.AutoID }; ilBody.sign = makeSign(ilBody);
    const result = await midnitePost("/Senergytec/web/v2/Inverterapi/InverterList", ilBody, auth.token);
    const list = result?.AllInverterList || [];
    sites.push({ MemberID: auth.username, MemberAutoID: auth.memberAutoId, GoodsID: list.map(d => ({ GoodsID: d.GoodsID, AutoID: d.AutoID ?? d.InverterAutoID ?? d.auto_id ?? d.id ?? null })) });
  }
  return { accountType: "enduser", sites };
}
const _sitesCache = new Map(); // key → { data, ts } (3-min TTL)
async function loadSitesWithAutoIdsCached(auth, key) {
  const k = key || auth.username;
  const hit = _sitesCache.get(k);
  if (hit && Date.now() - hit.ts < 3 * 60 * 1000) return hit.data;
  const data = await loadSitesWithAutoIds(auth);
  _sitesCache.set(k, { data, ts: Date.now() });
  return data;
}

// Live power flow for one inverter (getHybridFlowgraphRealTimeData, ~5 s fresh). Read-only.
async function fetchFlowRt(auth, sn) {
  const body = { GoodsID: sn }; body.sign = makeSign(body);
  const r = await midnitePost("/Eagle/v1/Inverterapi/getHybridFlowgraphRealTimeData", body, auth.token);
  return {
    sn, online: r?.online ?? false, time: r?.SystemTime || r?.DataTime || "",
    pv: parseFloat(r?.TotalDCpower || 0), grid: parseFloat(r?.gridCurrpac || 0),
    load: parseFloat(r?.loadCurrpac || 0), eps: parseFloat(r?.epsCurrpac || 0),
    gen: parseFloat(r?.genCurrpac || 0), battery: parseFloat(r?.Pbat || 0), soc: parseFloat(r?.SOC || 0),
    // Voltages / frequencies, when the feed carries them (field names unverified; null when absent).
    gridV: flowNum(r, ["gridVac", "gridVoltage", "Vgrid"]), gridHz: flowNum(r, ["gridFac", "gridFreq", "Fgrid"]),
    genV: flowNum(r, ["genVac", "genVoltage", "Vgen"]), genHz: flowNum(r, ["genFac", "genFreq", "Fgen"]),
    // Every raw field whose name mentions gen, so a live per-leg voltage can be found (field names unverified).
    genRaw: Object.fromEntries(Object.entries(r || {}).filter(([k]) => /gen/i.test(k))),
  };
}
// Live flow for a WHOLE SITE: every inverter in parallel, power fields SUMMED over the online ones (a generator on a
// parallel stack feeds every inverter, so the master alone shows only its share; Jason, 2026-11-12). SOC, time and
// V/Hz come from the master (else the first online inverter). `inverters` keeps the per-inverter readings.
async function fetchSiteFlowRt(auth, serials, masterSn) {
  const list = [...new Set((serials || []).filter(Boolean))];
  if (masterSn && !list.includes(masterSn)) list.unshift(masterSn);
  const flows = await Promise.all(list.map(sn => fetchFlowRt(auth, sn).catch(e => ({ sn, online: false, error: e.message }))));
  const on = flows.filter(f => f.online !== false && !f.error);
  const base = flows.find(f => f.sn === masterSn && f.online !== false && !f.error) || on[0] || flows[0] || { online: false };
  const sum = (k) => on.reduce((a, f) => a + (Number.isFinite(f[k]) ? f[k] : 0), 0);
  return {
    ...base, online: on.length > 0,
    pv: sum("pv"), grid: sum("grid"), load: sum("load"), eps: sum("eps"), gen: sum("gen"), battery: sum("battery"),
    summed: true, online_count: on.length, inverter_count: flows.length,
    inverters: flows.map(f => ({ sn: f.sn, online: f.online !== false && !f.error, gen: f.gen ?? null, grid: f.grid ?? null, error: f.error || null })),
  };
}
// First present field among `keys`; arrays (per-phase) give the mean of the non-zero entries.
function flowNum(r, keys) {
  for (const k of keys) {
    const v = r?.[k];
    if (v == null || v === "") continue;
    if (Array.isArray(v)) {
      const xs = v.map(x => parseFloat(x)).filter(x => Number.isFinite(x) && x !== 0);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    }
    const x = parseFloat(v);
    if (Number.isFinite(x)) return x;
  }
  return null;
}

// ── Device shadow read / write (mirrors the proven admin `genwrite` action) ──
// readShadow: live read through the dongle (Force:1). Returns { code: value }.
async function readShadow(auth, autoId, codes, deps = {}) {
  const post = deps.post || midnitePost;
  const rb = { AutoId: String(autoId), ModbusArr: JSON.stringify(codes), Force: 1 }; rb.sign = makeSign(rb);
  const r = await post("/Eagle/v1/Inverterapi/readDeviceShadow_RA_New_AutoID", rb, auth.token);
  return r?.data?.data || {};
}

// writeShadow: allow-listed generator registers ONLY. Reads before, writes, polls
// getDeviceShadowResult every 2 s (up to 10 tries), reads back.
// Returns { autoId, requested, before, write, result, after, verified }.
// Throws (e.code = 400) on any code outside GEN_WRITABLE or out of range: nothing is written.
// The CALLER must have resolved autoId from the master serial server-side.
async function writeShadow(auth, { autoId, writes }, deps = {}) {
  const post = deps.post || midnitePost;
  const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 2000, tries = deps.tries ?? 10;
  if (!autoId) { const e = new Error("autoId required"); e.code = 400; throw e; }
  const { ModbusArr, bad } = validateGenWrites(writes);
  if (bad.length || !Object.keys(ModbusArr).length) { const e = new Error(bad.length ? bad.join("; ") : "no writes given"); e.code = 400; throw e; }
  const aid = String(autoId);
  const codes = Object.keys(ModbusArr);
  const out = { autoId: aid, requested: ModbusArr, verified: false };
  try { out.before = await readShadow(auth, aid, codes, { post }); }
  catch (e) { out.err = "read-before failed: " + e.message; return out; }
  const wb = { AutoId: aid, ModbusArr: JSON.stringify(ModbusArr) }; wb.sign = makeSign(wb);
  try { out.write = await post("/Eagle/v1/Inverterapi/setDeviceShadow_WA_New_AutoID", wb, auth.token); }
  catch (e) { out.err = "write failed: " + e.message; return out; }
  const reqId = out.write?.RequestId;
  out.result = null;
  if (reqId) {
    for (let i = 0; i < tries && !out.result; i++) {
      await sleep(pollMs);
      const pb = { RequestId: JSON.stringify([reqId]) }; pb.sign = makeSign(pb);
      try { const p = await post("/Eagle/v1/Inverterapi/getDeviceShadowResult", pb, auth.token); if (p?.data?.[reqId]?.status === true) out.result = p.data[reqId]; else out.lastPoll = p; }
      catch (e) { out.lastPoll = { error: e.message }; }
    }
  }
  if (!reqId) out.err = "the inverter did not accept the write: " + String(out.write?.message || out.write?.msg || JSON.stringify(out.write || null)).slice(0, 200);
  // Read back. The live read can lag the write by a few seconds, so re-read a few times before giving up.
  const rereads = deps.rereads ?? 3;
  for (let i = 0; i <= rereads; i++) {
    if (i) await sleep(3000);
    try { out.after = await readShadow(auth, aid, codes, { post }); } catch (e) { out.after = { error: e.message }; }
    out.verified = codes.every(c => String(out.after?.[c]) === ModbusArr[c]);
    if (out.verified || !reqId) break;
  }
  if (out.verified) delete out.err;
  else if (!out.err) out.err = `no confirmation from the inverter after ${Math.round((tries * pollMs + rereads * 3000) / 1000)} s (it reads back ${codes.map(c => `${c}=${out.after?.[c] ?? "?"}`).join(", ")})`;
  return out;
}

// ── Day CSV export (frozen copy of the `dayexcel` fetch + parse in pages/api/midnite.js) ──
// GET /Eagle/v1//Excel/hybridStatusExcelMidNite?MemberID&inDate&GoodsID&sign (sign-authorized, no token).
// memberId = the site's end-user MemberID (site name). Returns { rows, header } where each row is
// { ts:"YYYY-MM-DD HH:MM:SS", time, mppt{1..3}{V,A,W}, pvW, eToday }. Read-only. Columns are found by
// header name (positional fallbacks), exactly like the proxy.
function parseDayExcelCsv(text) {
  const seg = (cell) => String(cell || "").split("/");
  const fnum = (s) => parseFloat(String(s).replace(/[^0-9.\-]/g, "")) || 0;
  const vOf = (cell) => fnum(seg(cell)[0]);
  const wOf = (cell) => { const p = seg(cell); return fnum(p[p.length - 1]); };
  const aOf = (cell) => { const p = seg(cell); return p.length >= 3 ? fnum(p[1]) : fnum(p[p.length - 1]); };
  const rows = []; let started = false; let header = []; let col = {};
  const ix = (name, fb) => { const i = col[name]; return i != null ? i : fb; };
  for (const line of String(text || "").split(/\r?\n/)) {
    const f = [...line.matchAll(/"([^"]*)"/g)].map(m => m[1]);
    if (!f.length) continue;
    if (f[0] === "Time") { header = f; started = true; col = {}; f.forEach((h, i) => { if (col[h] === undefined) col[h] = i; }); continue; }
    if (!started || !/^\d{4}-\d{2}-\d{2}[ T]/.test(f[0])) continue;
    const row = { ts: f[0].replace("T", " "), time: f[0].split(/[ T]/)[1] };
    for (const [k, name, fb] of [["mppt1", "MPPT1", 1], ["mppt2", "MPPT2", 2], ["mppt3", "MPPT3", 3]]) {
      const c = f[ix(name, fb)];
      row[k + "V"] = vOf(c); row[k + "A"] = aOf(c); row[k + "W"] = wOf(c);
    }
    row.pvW = (row.mppt1W + row.mppt2W + row.mppt3W) || Math.round(fnum(f[ix("PV", 4)]) * 1000);
    row.eToday = fnum(f[ix("E-Today", 6)]);
    // Generator / grid legs (line-to-neutral V, signed W) and frequencies, for the Generator card.
    row.genL1V = vOf(f[ix("Gen Port1", 11)]); row.genL2V = vOf(f[ix("Gen Port2", 17)]);
    row.genL1W = wOf(f[ix("Gen Port1", 11)]); row.genL2W = wOf(f[ix("Gen Port2", 17)]);
    row.gridL1V = vOf(f[ix("Grid1", 9)]); row.gridL2V = vOf(f[ix("Grid2", 15)]);
    row.genHz = fnum(f[ix("GenFac", 23)]); row.gridHz = fnum(f[ix("GridFac", 21)]);
    rows.push(row);
  }
  return { rows, header };
}
async function fetchDayExcel(memberId, sn, date, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const sign = makeSign({ MemberID: memberId, inDate: date, GoodsID: sn });
  const enc = encodeURIComponent;
  const url = `${BASE}/Eagle/v1//Excel/hybridStatusExcelMidNite?MemberID=${enc(memberId)}&inDate=${enc(date)}&GoodsID=${enc(sn)}&sign=${enc(sign)}`;
  const resp = await fetchFn(url, { headers: {
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Referer": "https://service.midnitepower.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Cookie": "timezone=America%2FNew_York",
  }});
  const text = await resp.text();
  if (!resp.ok) throw new Error(`excel ${resp.status}: ${text.slice(0, 200)}`);
  return parseDayExcelCsv(text);
}

export {
  fetchSiteFlowRt,
  supabaseAdmin, encKey, decryptCred, makeSign, midnitePost,
  login, loginCached, normalizeDetail, fetchInverterDetail, getRecipientEmail,
  fetchSites, fetchDay, fetchMonth,
  getSaasUser, loadSitesWithAutoIds, loadSitesWithAutoIdsCached, fetchFlowRt, readShadow, writeShadow,
  fetchDayExcel, parseDayExcelCsv, fetchGenLegs,
};
