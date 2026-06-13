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
      brand: raw.brand || "", capacityAh: parseFloat(raw.capacity || 0), voltage: parseFloat(raw.volt || 0), current: parseFloat(raw.cur || 0),
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

// Recipient email for a user = the email on their profile (kept in sync by the
// new-user trigger + getSaasUser upsert in the proxy).
async function getRecipientEmail(userId) {
  const sb = supabaseAdmin();
  if (!sb) return null;
  const { data } = await sb.from("profiles").select("email").eq("id", userId).maybeSingle();
  return data?.email || null;
}

export {
  supabaseAdmin, encKey, decryptCred, makeSign, midnitePost,
  login, loginCached, normalizeDetail, fetchInverterDetail, getRecipientEmail,
};
