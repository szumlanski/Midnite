const CryptoJS = require("crypto-js");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const BASE = "https://service.midnitepower.com/API/CodeIgniter/index.php";
const AES_KEY = "05469137076236813460585715952089";
const AES_IV = "5161557162012237";
const SALT = "05469137076236813460585715952089";

// ── SaaS auth + credential encryption ───────────────────────────────────────
let _sb = null;
function supabaseAdmin() {
  if (_sb) return _sb;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _sb;
}
// 32-byte key from CREDS_ENC_KEY (accepts hex64 / base64-32 / any passphrase → sha256).
function encKey() {
  const k = process.env.CREDS_ENC_KEY || "";
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex");
  try { const b = Buffer.from(k, "base64"); if (b.length === 32) return b; } catch {}
  return crypto.createHash("sha256").update(String(k)).digest();
}
function encryptCred(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decryptCred(blob) {
  const b = Buffer.from(blob, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
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
// Resolve which linked Midnite account this request uses (by id, or the user's only one).
async function getLinkedAccount(userId, accountId) {
  const sb = supabaseAdmin();
  let q = sb.from("midnite_accounts").select("*").eq("user_id", userId);
  if (accountId) q = q.eq("id", accountId);
  const { data } = await q.order("created_at").limit(1);
  const acct = data && data[0];
  if (!acct) { const e = new Error("No linked Midnite account"); e.code = 409; throw e; }
  return acct;
}

function makeSign(params) {
  const filtered = Object.fromEntries(Object.entries(params).filter(([,v])=>v!==null&&v!==""&&typeof v!=="boolean"));
  const sortedKeys = Object.keys(filtered).sort();
  const parts = sortedKeys.map(k=>Array.isArray(filtered[k])?`${k}=Array`:`${k}=${filtered[k]}`);
  const plaintext = parts.join("&")+"&"+SALT;
  const key = CryptoJS.enc.Utf8.parse(AES_KEY);
  const iv  = CryptoJS.enc.Utf8.parse(AES_IV);
  return CryptoJS.AES.encrypt(plaintext,key,{iv,mode:CryptoJS.mode.CBC,padding:CryptoJS.pad.Pkcs7}).toString();
}

// Generic poster to an absolute URL (used to talk to the consumer "view" host as
// well as the installer "service" host). origin/referer must match the target site.
async function hostPost(fullUrl, body, token, origin, referer) {
  const headers = {
    "Content-Type": "application/json;charset=UTF-8",
    "Accept": "application/json",
    "Origin": origin,
    "Referer": referer || (origin + "/"),
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "Cookie": "timezone=America%2FNew_York",
  };
  if (token) headers["authorization"] = token;
  const res = await fetch(fullUrl, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
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
    "Cookie": "timezone=America%2FNew_York"
  };
  if (token) headers["authorization"] = token;
  
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Midnite ${res.status}: ${text}`);
  }
  return res.json();
}

async function login(user = null, pass = null) {
  const username = user || process.env.MIDNITE_USERNAME || "Wise Naples";
  const password = pass || process.env.MIDNITE_PASSWORD || "921551";

  let eagleToken = null, eagleMemberId = "";
  let senToken = null, senMemberId = "";

  // Try Eagle (installer) login
  try {
    const opParams = { MemberID: username, PassWord: password };
    opParams.sign = makeSign(opParams);
    const opData = await midnitePost("/Eagle/v1/Operation/login", opParams);
    if (opData.token) { eagleToken = opData.token; eagleMemberId = String(opData.MemberAutoID || ""); }
  } catch (e) { /* try Senergytec */ }

  // Always also try Senergytec login — gives us end-user memberAutoId even when Eagle succeeds
  try {
    const params = { MemberID: username, Password: password, type: "1" };
    params.sign = makeSign(params);
    const data = await midnitePost("/Senergytec/web/v2/Inverterapi/UserLogin", { ...params, remember: false });
    if (data.status === "ok") { senToken = data.token; senMemberId = String(data.MemberAutoID || ""); }
  } catch (e) { /* installer-only account */ }

  if (!eagleToken && !senToken) throw new Error("Login failed: Invalid username or password");

  const memberAutoId = senMemberId || eagleMemberId;
  if (eagleToken) {
    // Installer path — store BOTH tokens so Senergytec endpoints always use senToken
    return { token: eagleToken, senToken: senToken || null, memberAutoId, accountType: "installer", username };
  }
  return { token: senToken, senToken: senToken, memberAutoId, accountType: "enduser", username };
}

// Cache Midnite logins (tokens are long-lived) so high-frequency polling (5s flow, status, …) doesn't
// hammer the Midnite login endpoint on every proxy call and trip its rate limits → 500s.
const _midAuthCache = new Map(); // username(lc) → { auth, ts }
async function loginCached(username, password) {
  const k = (username || "").toLowerCase();
  const hit = _midAuthCache.get(k);
  if (hit && Date.now() - hit.ts < 4 * 60 * 1000) return hit.auth;
  const auth = await login(username, password);
  _midAuthCache.set(k, { auth, ts: Date.now() });
  return auth;
}

// Handles the richer getInverterStatus response (has mppts[], smartPortA/B/C, etc.)
function normalizeRich(raw) {
  if (!raw?.data) return null;
  const d = raw.data;
  // grid netW: negative current on a line = exporting
  const gridNetW = (d.grid?.lines||[]).reduce((s,l)=>s+((l.current||0)<0?-1:1)*(l.power||0),0);
  return {
    inverter: {
      online: d.inverter?.online ?? true,
      model: d.inverter?.model || "",
      sn: d.inverter?.sn || "",
      temperature: d.inverter?.temperature || 0,
      lastUpdateTime: d.inverter?.lastUpdateTime || "",
      selfConsumptionPercent: d.inverter?.selfConsumptionPercent ?? null,
      selfSufficiencyPercent: d.inverter?.selfSufficiencyPercent ?? null,
      state: d.inverter?.state ?? null,
      workMode: d.inverter?.workMode ?? null,
      wifiSignal: d.inverter?.wifi?.mdb ?? null,
      dspVer: d.inverter?.dspVer || "",
      slaveDspVer: d.inverter?.slaveDspVer || "",
      csbVer: d.inverter?.csbVer || "",
    },
    photovoltaic: {
      mppts: d.photovoltaic?.mppts || [],
      power: d.photovoltaic?.power || { totalDc:0, peak:0 },
      production: d.photovoltaic?.production || { today:0, total:0 },
    },
    grid: {
      lines: d.grid?.lines || [],
      netW: gridNetW,
      sold: d.grid?.sold || { today:0, total:0 },
      consumption: d.grid?.consumption || { today:0, total:0 },
    },
    load: {
      lines: d.load?.lines || [],
      power: d.load?.power || { today:0, total:0 },
    },
    battery: {
      brand: d.battery?.brand || "",
      capacityAh: parseFloat(d.battery?.capacity || 0),
      voltage: d.battery?.voltage || 0,
      current: d.battery?.current || 0,
      charge: d.battery?.charge || 0,
      discharge: d.battery?.discharge || 0,
      soc: d.battery?.soc || 0,
      healthPercent: d.battery?.healthPercent || 0,
      temperature: d.battery?.temperature || 0,
      chargeIn: d.battery?.chargeIn || { today:0, total:0 },
      dischargeOut: d.battery?.dischargeOut || { today:0, total:0 },
      bmsStatus: d.battery?.bmsStatus || "",
      bmsFWVer: d.battery?.bmsFWVer || "",
    },
    smartPorts: {
      A: d.smartPortA || null,
      B: d.smartPortB || null,
      C: d.smartPortC || null,
    },
    gen: d.gen || null,
  };
}

function normalizeDetail(raw, sn) {
  if(!raw || raw.GoodsID === undefined) return null;
  const pvW = parseFloat(raw.TotalDCpower || 0);
  // Some inverter models (AIO and others) serve load through the EPS port rather than the AC load port.
  // Auto-detect: if loadCurrpac sums to zero but epsCurrpac has power, use epsCurrpac.
  const loadPacRaw = raw.loadCurrpac;
  const epsPacRaw = raw.epsCurrpac;
  const loadSum = (parseFloat(loadPacRaw?.[0]||0) + parseFloat(loadPacRaw?.[1]||0) + parseFloat(loadPacRaw?.[2]||0));
  const epsSum  = (parseFloat(epsPacRaw?.[0]||0)  + parseFloat(epsPacRaw?.[1]||0));
  const useEPS  = loadSum === 0 && epsSum > 0;
  const loadPac = useEPS ? epsPacRaw : loadPacRaw;
  const loadVac = useEPS ? raw.epsVac : raw.loadVac;
  const loadIac = useEPS ? raw.epsIac : raw.loadIac;
  const loadEnergyDay   = useEPS ? parseFloat(raw.EPSDay   || 0) : parseFloat(raw.ELDay   || 0);
  const loadEnergyTotal = useEPS ? parseFloat(raw.EPSTotal || 0) : parseFloat(raw.ELTotal || 0);
  const loadW = (parseFloat(loadPac?.[0] || 0) + parseFloat(loadPac?.[1] || 0) + parseFloat(loadPac?.[2] || 0));
  // gridCurrpac: positive = importing from grid, negative = exporting to grid
  const gridNetW = (parseFloat(raw.gridCurrpac?.[0] || 0) + parseFloat(raw.gridCurrpac?.[1] || 0) + parseFloat(raw.gridCurrpac?.[2] || 0));
  const batChargeW = parseFloat(raw.toPbat || 0);
  const batDischargeW = parseFloat(raw.fromPbat || 0);
  return {
    inverter: {
      online: true,
      model: raw.modelName || "",
      sn: raw.GoodsID,
      temperature: parseFloat(raw.Tntc || 0),
      lastUpdateTime: raw.DataTime || "",
    },
    photovoltaic: {
      power: { totalDc: pvW, peak: parseFloat(raw.Peackpower || 0) },
      production: {
        today: parseFloat(raw.EToday || 0) * 1000,
        total: parseFloat(raw.ETotal || 0) * 1000,
      },
    },
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
      brand: raw.brand || "",
      capacityAh: parseFloat(raw.capacity || 0),
      voltage: parseFloat(raw.volt || 0),
      current: parseFloat(raw.cur || 0),
      charge: batChargeW,
      discharge: batDischargeW,
      soc: parseFloat(raw.SOC || 0),
      healthPercent: parseFloat(raw.SOH || 0),
      temperature: parseFloat(raw.BMS_temp || 0),
      // Etotal_batChrg/Dischrg are in kWh — convert to Wh for fmtE()
      chargeIn: { total: parseFloat(raw.Etotal_batChrg || 0) * 1000 },
      dischargeOut: { total: parseFloat(raw.Etotal_batDischrg || 0) * 1000 },
    },
  };
}

// ---- Access log (admin) ----------------------------------------------------
// Persists to Vercel KV when KV_REST_API_URL/TOKEN are set; otherwise keeps a recent
// in-memory buffer (resets on cold start / redeploy — add a KV store for durability).
let _accessLog = [];
function kvEnv() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    tok: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}
async function kvCmd(cmd) {
  const { url, tok } = kvEnv();
  if (!url || !tok) return null;
  try {
    const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
    return await r.json();
  } catch (e) { console.log("[kv]", e.message); return null; }
}
async function logAccess(evt) {
  const rec = { ...evt, ts: new Date().toISOString() };
  const kv = await kvCmd(["lpush", "accesslog", JSON.stringify(rec)]);
  if (kv) { await kvCmd(["ltrim", "accesslog", "0", "999"]); }
  else { _accessLog.unshift(rec); if (_accessLog.length > 500) _accessLog.length = 500; }
}
async function readAccessLog() {
  const kv = await kvCmd(["lrange", "accesslog", "0", "499"]);
  if (kv && Array.isArray(kv.result)) return kv.result.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
  return _accessLog;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;
  try {
    // ── SaaS authentication (Supabase) ──────────────────────────────────────
    const { user, role } = await getSaasUser(req);

    // Account-management actions — no linked Midnite account required.
    if (action === "accounts") {
      const sb = supabaseAdmin();
      const [{ data }, { data: prof }, { data: photos }] = await Promise.all([
        sb.from("midnite_accounts").select("id,label,midnite_username,account_type,created_at").eq("user_id", user.id).order("created_at"),
        sb.from("profiles").select("display_name,avatar_url").eq("id", user.id).maybeSingle(),
        sb.from("site_photos").select("site_name,url").eq("user_id", user.id),
      ]);
      const sitePhotos = Object.fromEntries((photos || []).map(p => [p.site_name, p.url]));
      return res.json({ role, email: user.email, accounts: data || [], profile: prof || {}, sitePhotos });
    }
    if (action === "updateprofile") {
      const { display_name, avatar_url } = req.body || {};
      const patch = {};
      if (display_name !== undefined) patch.display_name = display_name;
      if (avatar_url !== undefined) patch.avatar_url = avatar_url;
      if (Object.keys(patch).length) await supabaseAdmin().from("profiles").update(patch).eq("id", user.id);
      return res.json({ ok: true });
    }
    if (action === "setsitephoto") {
      const { site, url } = req.body || {};
      if (!site) return res.status(400).json({ error: "site required" });
      const sb = supabaseAdmin();
      if (url) await sb.from("site_photos").upsert({ user_id: user.id, site_name: site, url, updated_at: new Date().toISOString() });
      else await sb.from("site_photos").delete().eq("user_id", user.id).eq("site_name", site);
      return res.json({ ok: true });
    }
    if (action === "linkaccount") {
      const { username, password, label } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: "Midnite username and password required" });
      let v; try { v = await login(username, password); } catch (e) { return res.status(400).json({ error: "Those Midnite credentials didn't work." }); }
      const sb = supabaseAdmin();
      const { data: mine } = await sb.from("midnite_accounts").select("id").eq("user_id", user.id);
      if (role !== "admin" && (mine || []).length >= 1)
        return res.status(403).json({ error: "Your plan allows one linked Midnite account. Relink it from Settings." });
      const { data: ins, error } = await sb.from("midnite_accounts")
        .insert({ user_id: user.id, label: label || username, midnite_username: username, enc_password: encryptCred(password), account_type: v.accountType })
        .select("id,label,midnite_username,account_type,created_at").single();
      if (error) return res.status(error.code === "23505" ? 409 : 500)
        .json({ error: error.code === "23505" ? "This Midnite account is already linked to another login." : error.message });
      await logAccess({ type: "link", user: user.email, account: username });
      return res.json({ account: ins });
    }
    if (action === "unlinkaccount") {
      const { id } = req.body || {};
      const sb = supabaseAdmin();
      await sb.from("midnite_accounts").delete().eq("id", id).eq("user_id", user.id);
      return res.json({ ok: true });
    }

    // ── Data actions: resolve the linked Midnite account, authenticate to Midnite ──
    const acct = await getLinkedAccount(user.id, req.body?.accountId);
    let midPw;
    try { midPw = decryptCred(acct.enc_password); }
    catch (e) { const er = new Error("Stored Midnite credentials couldn't be read — please relink your account in Settings."); er.code = 409; throw er; }
    const auth = await loginCached(acct.midnite_username, midPw);

    switch (action) {
      case "logview": {
        await logAccess({ type: "view", user: user.email, account: acct.midnite_username, site: (req.body?.site || "").slice(0, 80) });
        return res.json({ ok: true });
      }
      case "adminlog": {
        if (role !== "admin") return res.status(403).json({ error: "forbidden" });
        return res.json({ log: await readAccessLog(), persistent: !!kvEnv().url });
      }
      case "sites": {
        if (auth.accountType === "installer") {
          const now = new Date();
          const baseBody = {
            MemberID: auth.username, EndUserName: "", OperationName: "",
            GoodsID: "", inDate: now.toISOString().split("T")[0],
            inTime: now.toTimeString().split(" ")[0], status: 0,
          };
          // Paginate until empty page — terminaluserinfo returns one page at a time
          const sites = [];
          for (let page = 1; page <= 100; page++) {
            const body = { ...baseBody, Page: page };
            body.sign = makeSign(body);
            const data = await midnitePost("/Eagle/v1/Operation/terminaluserinfo", body, auth.token);
            const pageSites = Array.isArray(data) ? data : [];
            sites.push(...pageSites);
            if (pageSites.length === 0) break;
          }

          // Use the end-user memberAutoId (captured via dual Senergytec login) to fetch
          // inverter AutoIDs from InverterList — required for Eagle getInverterStatus calls
          const autoIdMap = {};
          // Eagle's own InverterList returns AutoID + MemberAutoID per inverter
          // — no Senergytec token needed, works with installer Eagle token alone
          const memberIdsSeen = new Set(sites.map(s => s.MemberID).filter(Boolean));
          for (const memberID of memberIdsSeen) {
            try {
              const ilb = { MemberID: memberID };
              ilb.sign = makeSign(ilb);
              const result = await midnitePost("/Eagle/v1/Inverterapi/InverterList", ilb, auth.token);
              for (const inv of (result?.AllInverterList || [])) {
                if (inv.GoodsID && inv.AutoID) {
                  autoIdMap[inv.GoodsID] = { autoId: String(inv.AutoID), memberAutoId: String(inv.MemberAutoID || "") };
                }
              }
            } catch(e) { console.log("[Eagle InverterList err]", e.message); }
          }
          console.log("[installer autoIdMap]", JSON.stringify(autoIdMap));

          // Attach AutoID + MemberAutoID to each site/inverter so status calls can use them
          const enriched = sites.map(s => {
            const firstSn = typeof s.GoodsID?.[0] === "string" ? s.GoodsID[0] : s.GoodsID?.[0]?.GoodsID;
            const siteMemberAutoId = autoIdMap[firstSn]?.memberAutoId || s.MemberAutoID || "";
            return {
              ...s,
              MemberAutoID: siteMemberAutoId,
              GoodsID: (s.GoodsID || []).map(g => {
                const sn = typeof g === "string" ? g : g.GoodsID;
                return { GoodsID: sn, AutoID: autoIdMap[sn]?.autoId || null };
              }),
            };
          });
          return res.json({ accountType: "installer", sites: enriched });
        }
        // End-user: get groups, then inverters for each group
        const glBody = { MemberAutoID: auth.memberAutoId, inputValue: "" };
        glBody.sign = makeSign(glBody);
        const groups = await midnitePost("/Senergytec/web/v2/Inverterapi/GroupList", glBody, auth.token);
        const groupList = groups?.AllGroupList || [];

        const sites = [];
        for (const g of groupList) {
          const groupId = g.AutoID;
          const ilBody = { MemberAutoID: auth.memberAutoId, GroupAutoID: groupId };
          ilBody.sign = makeSign(ilBody);
          const result = await midnitePost("/Senergytec/web/v2/Inverterapi/InverterList", ilBody, auth.token);
          const list = result?.AllInverterList || [];
          const status = g.InverterStatus || {};
          // Debug: log full first inverter object to find AutoID field name
          if (list[0]) console.log("[InverterList fields]", JSON.stringify(Object.keys(list[0])), JSON.stringify(list[0]));
          sites.push({
            MemberID: auth.username,
            MemberAutoID: auth.memberAutoId,
            GoodsID: list.map(d => ({ GoodsID: d.GoodsID, AutoID: d.AutoID ?? d.InverterAutoID ?? d.auto_id ?? d.id ?? null })),
            MemberStateCount: [status.Green||0, status.yellow||0, status.red||0, status.gray||0],
          });
        }
        return res.json({ accountType: "enduser", sites });
      }
      case "status": {
        const {serials, autoIds, memberAutoId:endUserMemberId}=req.body||{};
        if(!serials?.length) return res.status(400).json({error:"serials required"});
        const results = await Promise.all(serials.map(async (sn,idx)=>{
          const autoId = autoIds?.[idx];
          const memberId = endUserMemberId || auth.memberAutoId;
          // Try Eagle getInverterStatus (MPPT, smart ports, self-sufficiency)
          if(autoId && memberId) {
            try {
              const richBody={AutoId:String(autoId), memberAutoID:String(memberId)};
              richBody.sign=makeSign(richBody);
              const rich=await midnitePost("/Eagle/v1/Inverterapi/getInverterStatus",richBody,auth.token);
              console.log(`[getInverterStatus ${sn}] ok=${rich?.status} hasMppts=${!!rich?.data?.photovoltaic?.mppts}`);
              if(rich?.data?.photovoltaic?.mppts) {
                const data=normalizeRich(rich);
                return {sn,ok:!!data,data,source:"rich",error:data?null:"No data"};
              }
            } catch(e) { console.log(`[getInverterStatus ${sn}] err: ${e.message}`); }
          }
          // Fallback: InverterDetailInfoNewone — always use Senergytec token
          const senTok2 = auth.senToken || auth.token;
          const body={GoodsID:sn,MemberAutoID:auth.memberAutoId};
          body.sign=makeSign(body);
          try {
            const raw=await midnitePost("/Senergytec/web/v2/Inverterapi/InverterDetailInfoNewone",body,senTok2);
            const data=normalizeDetail(raw,sn);
            return {sn,ok:!!data,data,error:data?null:"No data returned"};
          }
          catch(e){return {sn,ok:false,data:null,error:e.message};}
        }));
        return res.json({results});
      }
      case "flow": {
        // Real-time power-flow snapshot per inverter — the endpoint the consumer site uses for
        // its animated flow graphic. Returns PV / grid / battery / load instantaneous power.
        const { serials } = req.body || {};
        if(!serials?.length) return res.status(400).json({error:"serials required"});
        const results = await Promise.all(serials.map(async sn=>{
          const body = { GoodsID: sn }; body.sign = makeSign(body);
          try {
            const r = await midnitePost("/Eagle/v1/Inverterapi/getHybridFlowgraphRealTimeData", body, auth.token);
            return {
              sn, ok: true, online: r?.online ?? false,
              pv: parseFloat(r?.TotalDCpower || 0),
              grid: parseFloat(r?.gridCurrpac || 0),   // + import, − export
              load: parseFloat(r?.loadCurrpac || 0),
              eps: parseFloat(r?.epsCurrpac || 0),
              gen: parseFloat(r?.genCurrpac || 0),
              battery: parseFloat(r?.Pbat || 0),         // + charge, − discharge
              soc: parseFloat(r?.SOC || 0),
              time: r?.SystemTime || "",
            };
          } catch(e){ return { sn, ok:false, error:e.message }; }
        }));
        return res.json({ results });
      }
      case "flowrt": {
        // Freshness test for getHybridFlowgraphRealTimeData (the vendor's "real-time" flow endpoint).
        // Returns the FULL raw response so every timestamp/field can be inspected, plus extracted
        // power/SOC and a best-effort timestamp. Poll repeatedly to see if it beats the 5-min cache.
        const { serial } = req.body || {};
        if(!serial) return res.status(400).json({error:"serial required"});
        const body = { GoodsID: serial }; body.sign = makeSign(body);
        try {
          const r = await midnitePost("/Eagle/v1/Inverterapi/getHybridFlowgraphRealTimeData", body, auth.token);
          return res.json({
            ok: true, serial,
            time: r?.SystemTime || r?.DataTime || r?.lastUpdateTime || r?.Time || "",
            pv: parseFloat(r?.TotalDCpower || 0),
            grid: parseFloat(r?.gridCurrpac || 0),
            load: parseFloat(r?.loadCurrpac || 0),
            eps: parseFloat(r?.epsCurrpac || 0),
            gen: parseFloat(r?.genCurrpac || 0),
            battery: parseFloat(r?.Pbat || 0),
            soc: parseFloat(r?.SOC || 0),
            raw: r,
          });
        } catch(e){ return res.json({ ok:false, serial, error:e.message }); }
      }
      case "day": {
        const { sn, date } = req.body || {};
        if (!sn || !date) return res.status(400).json({ error: "sn and date required" });
        const body = { GoodsID: sn, date };
        body.sign = makeSign(body);
        return res.json(await midnitePost("/Senergytec/web/v2/Inverterapi/dayProductionAndConsumptionAreaTime", body, auth.token));
      }
      case "dayexcel": {
        // Per-MPPT intraday data, parsed from the installer site's day-chart CSV export.
        // GET /Eagle/v1//Excel/hybridStatusExcelMidNite?MemberID&inDate&GoodsID&sign (sign-authorized).
        const { sn, date, memberId } = req.body || {};
        if (!sn || !date) return res.status(400).json({ error: "sn and date required" });
        const MemberID = memberId || auth.username;
        const sign = makeSign({ MemberID, inDate: date, GoodsID: sn });
        const enc = encodeURIComponent;
        const url = `${BASE}/Eagle/v1//Excel/hybridStatusExcelMidNite?MemberID=${enc(MemberID)}&inDate=${enc(date)}&GoodsID=${enc(sn)}&sign=${enc(sign)}`;
        const resp = await fetch(url, { headers: {
          "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
          "Referer": "https://service.midnitepower.com/",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
          "Cookie": "timezone=America%2FNew_York",
        }});
        const text = await resp.text();
        if (!resp.ok) return res.status(502).json({ error: `excel ${resp.status}`, sample: text.slice(0,200) });
        // Parse the quoted CSV. Header row begins with "Time". Most cells are "V/A/W" (parse first
        // field for volts, middle for amps, last for watts); scalar columns (Temperature, SOC, …) are
        // a single number. Returns the legacy mppt/gridV/gridHz fields (used by the Day chart) PLUS a
        // flat per-row metric map and a catalog of the metrics that actually carry data — the source
        // for the Explorer per-parameter time-series charts (every column at 5-min resolution).
        const seg   = (cell) => String(cell||"").split("/");
        const fnum  = (s) => parseFloat(String(s).replace(/[^0-9.\-]/g,"")) || 0;
        const vOf   = (cell) => fnum(seg(cell)[0]);
        const wOf   = (cell) => { const p = seg(cell); return fnum(p[p.length-1]); };
        const aOf   = (cell) => { const p = seg(cell); return p.length>=3 ? fnum(p[1]) : fnum(p[p.length-1]); };
        const numOf = (cell) => fnum(cell);
        // Catalog of chartable parameters. The AC ports are "V/A/W" cells, so each is broken out into
        // three metrics (volts / amps / watts). The whole catalog is returned regardless of whether a
        // column reads zero (gen, smart loads, unused MPPT/legs stay selectable) — the Explorer tab
        // groups them and the user picks what to chart.
        const PORTS = [
          ["mppt1","MPPT1"],["mppt2","MPPT2"],["mppt3","MPPT3"],
          ["gridL1","Grid L1"],["gridL2","Grid L2"],
          ["loadL1","Load L1"],["loadL2","Load L2"],
          ["acOut1","AC Out L1"],["acOut2","AC Out L2"],
          ["smartB1","Smart Load B L1"],["smartB2","Smart Load B L2"],
          ["smartC1","Smart Load C L1"],["smartC2","Smart Load C L2"],
          ["genL1","Gen L1"],["genL2","Gen L2"],
          ["bat","Battery"],
        ];
        const METRIC_DEFS = [
          {key:"pvW", label:"PV Power", unit:"W", group:"Power"},
          ...PORTS.map(([k,l])=>({key:k+"W", label:l, unit:"W", group:"Power"})),
          ...PORTS.map(([k,l])=>({key:k+"V", label:l, unit:"V", group:"Voltage"})),
          ...PORTS.map(([k,l])=>({key:k+"A", label:l, unit:"A", group:"Current"})),
          {key:"gridHz", label:"Grid Frequency", unit:"Hz", group:"Frequency"},
          {key:"loadHz", label:"Load Frequency", unit:"Hz", group:"Frequency"},
          {key:"genHz",  label:"Gen Frequency",  unit:"Hz", group:"Frequency"},
          {key:"soc",      label:"Battery SOC",      unit:"%",  group:"Battery"},
          {key:"soh",      label:"Battery SOH",      unit:"%",  group:"Battery"},
          {key:"capacity", label:"Battery Capacity", unit:"Ah", group:"Battery"},
          {key:"temp",    label:"Inverter Temp", unit:"°C", group:"Temperature"},
          {key:"batTemp", label:"Battery Temp",  unit:"°C", group:"Temperature"},
          // Cumulative day counters (ramp from 0 over the day)
          {key:"eToday",           label:"PV Energy",          unit:"kWh", group:"Energy (today)"},
          {key:"consumptionToday", label:"Consumption",        unit:"kWh", group:"Energy (today)"},
          {key:"feedInToday",      label:"Feed-In",            unit:"kWh", group:"Energy (today)"},
          {key:"purchasedToday",   label:"Purchased",          unit:"kWh", group:"Energy (today)"},
          {key:"chargeToday",      label:"Battery Charged",    unit:"kWh", group:"Energy (today)"},
          {key:"dischargeToday",   label:"Battery Discharged", unit:"kWh", group:"Energy (today)"},
          {key:"outputToday",      label:"Output",             unit:"kWh", group:"Energy (today)"},
          {key:"smartLoadToday",   label:"Smart Load",         unit:"kWh", group:"Energy (today)"},
          // Lifetime counters
          {key:"eTotal",          label:"PV Energy",          unit:"kWh", group:"Energy (lifetime)"},
          {key:"totalConsumption",label:"Consumption",        unit:"kWh", group:"Energy (lifetime)"},
          {key:"totalFeedIn",     label:"Feed-In",            unit:"kWh", group:"Energy (lifetime)"},
          {key:"totalPurchased",  label:"Purchased",          unit:"kWh", group:"Energy (lifetime)"},
          {key:"totalCharge",     label:"Battery Charged",    unit:"kWh", group:"Energy (lifetime)"},
          {key:"totalDischarge",  label:"Battery Discharged", unit:"kWh", group:"Energy (lifetime)"},
          {key:"outputTotal",     label:"Output",             unit:"kWh", group:"Energy (lifetime)"},
          {key:"smartLoadTotal",  label:"Smart Load",         unit:"kWh", group:"Energy (lifetime)"},
          {key:"hTotal",          label:"Run Hours",          unit:"h",   group:"Energy (lifetime)"},
        ];
        const rows = []; let started = false; let header = []; let col = {};
        const ix = (name, fb) => { const i = col[name]; return i != null ? i : fb; }; // header index, or fallback
        for (const line of text.split(/\r?\n/)) {
          const f = [...line.matchAll(/"([^"]*)"/g)].map(m=>m[1]);
          if (!f.length) continue;
          if (f[0] === "Time") {
            header = f; started = true; col = {};
            f.forEach((h,i)=>{ if (col[h] === undefined) col[h] = i; });
            continue;
          }
          if (!started || !/^\d{4}-\d{2}-\d{2}[ T]/.test(f[0])) continue;
          // Each AC port is a "V/A/W" cell → break it into k+V / k+A / k+W. Battery V/A/W are scalar
          // columns parsed separately. The "PV" column is in kW (e.g. "8.31KW"), so PV power is taken
          // from the per-MPPT watt sum (true watts), scaling the PV column only as a fallback.
          const cells = {
            mppt1: f[ix("MPPT1",1)], mppt2: f[ix("MPPT2",2)], mppt3: f[ix("MPPT3",3)],
            gridL1: f[ix("Grid1",9)], gridL2: f[ix("Grid2",15)],
            loadL1: f[ix("Normal Load1",10)], loadL2: f[ix("Normal Load2",16)],
            acOut1: f[ix("AC OUT(100A)1",12)], acOut2: f[ix("AC OUT(100A)2",18)],
            smartB1: f[ix("Smart LoadB(50A)1",13)], smartB2: f[ix("Smart LoadB(50A)2",19)],
            smartC1: f[ix("Smart LoadC(30A)1",14)], smartC2: f[ix("Smart LoadC(30A)2",20)],
            genL1: f[ix("Gen Port1",11)], genL2: f[ix("Gen Port2",17)],
          };
          const flat = {};
          for (const [k, c] of Object.entries(cells)) { flat[k+"V"] = vOf(c); flat[k+"A"] = aOf(c); flat[k+"W"] = wOf(c); }
          rows.push({
            time: f[0].split(/[ T]/)[1],
            // legacy fields consumed by the Day chart (MPPT split + power-quality voltage plot)
            mppt: [flat.mppt1W, flat.mppt2W, flat.mppt3W],
            gridV: [flat.gridL1V, flat.gridL2V], // [L1-N, L2-N]
            gridHz: numOf(f[ix("GridFac",21)]),
            // flat metric map (Explorer charts) — every parameter at this 5-min interval
            pvW: (flat.mppt1W + flat.mppt2W + flat.mppt3W) || Math.round(numOf(f[ix("PV",4)])*1000),
            ...flat,
            batV: numOf(f[ix("Battery Voltage",36)]), batA: numOf(f[ix("Battery Current",35)]), batW: numOf(f[ix("Battery Power",37)]),
            loadHz: numOf(f[ix("LoadFac",22)]), genHz: numOf(f[ix("GenFac",23)]),
            soc: numOf(f[ix("SOC",32)]), soh: numOf(f[ix("SOH",33)]), capacity: numOf(f[ix("Capacity",30)]),
            temp: numOf(f[ix("Temperature",5)]), batTemp: numOf(f[ix("BatteryTemp",34)]),
            // cumulative day counters (kWh)
            eToday: numOf(f[ix("E-Today",6)]), consumptionToday: numOf(f[ix("Consumption Today",26)]),
            feedInToday: numOf(f[ix("Feed-In Energy Today",24)]), purchasedToday: numOf(f[ix("Purchased Energy Today",25)]),
            chargeToday: numOf(f[ix("Daily charge energy",38)]), dischargeToday: numOf(f[ix("Daily discharge energy",39)]),
            outputToday: numOf(f[ix("Outputs Energy Today",44)]), smartLoadToday: numOf(f[ix("smartLoadDay",42)]),
            // lifetime counters (kWh / hours)
            eTotal: numOf(f[ix("E-Total",7)]), hTotal: numOf(f[ix("H-Total",8)]),
            totalConsumption: numOf(f[ix("Total Consumption",29)]), totalFeedIn: numOf(f[ix("Total Feed-In Energy",27)]),
            totalPurchased: numOf(f[ix("Total Purchased Energy",28)]),
            totalCharge: numOf(f[ix("Total charge energy",40)]), totalDischarge: numOf(f[ix("Total discharge energy",41)]),
            outputTotal: numOf(f[ix("Outputs Energy Total",45)]), smartLoadTotal: numOf(f[ix("smartLoadTotal",43)]),
          });
        }
        const activeMppts = [0,1,2].filter(i => rows.some(r => Math.abs(r.mppt[i]) > 1));
        // Return the full catalog so every parameter stays selectable (gen, smart loads, unused legs
        // included), but drop any metric whose column is entirely absent from this CSV variant.
        const present = (key) => rows.some(r => r[key] !== undefined && !Number.isNaN(r[key]));
        const metrics = METRIC_DEFS.filter(md => present(md.key));
        return res.json({ rows, activeMppts, metrics, count: rows.length, header });
      }
      case "month": {
        const { sn, date } = req.body || {};
        if (!sn || !date) return res.status(400).json({ error: "sn and date required" });
        const body = { GoodsID: sn, date };
        body.sign = makeSign(body);
        return res.json(await midnitePost("/Senergytec/web/v2/Inverterapi/monthProductionAndConsumptionArea", body, auth.token));
      }
      case "year": {
        const { sn, date } = req.body || {};
        if (!sn) return res.status(400).json({ error: "sn required" });
        const body = { GoodsID: sn, date: date || new Date().getFullYear().toString() };
        body.sign = makeSign(body);
        return res.json(await midnitePost("/Senergytec/web/v2/Inverterapi/yearProductionAndConsumptionArea", body, auth.token));
      }
      case "probemonth": {
        // TEMPORARY endpoint-discovery probe — tries candidate month/year endpoints +
        // param/token variants and reports what each returns, so we can find the source
        // that yields a day-8 production near the true ~51 kWh/inverter. Remove after fix.
        const { sn, date } = req.body || {};
        if (!sn) return res.status(400).json({ error: "sn required" });
        const ym = date || "2026-06";
        const yr = ym.split("-")[0];
        const eagle = auth.token;
        const sen = auth.senToken || auth.token;
        const SEN = "/Senergytec/web/v2/Inverterapi/";
        const EAG = "/Eagle/v1/Inverterapi/";
        const candidates = [
          ["monthArea (current)",        SEN+"monthProductionAndConsumptionArea",     {GoodsID:sn,date:ym},        eagle],
          ["monthAreaTime",              SEN+"monthProductionAndConsumptionAreaTime", {GoodsID:sn,date:ym},        eagle],
          ["monthArea senToken",         SEN+"monthProductionAndConsumptionArea",     {GoodsID:sn,date:ym},        sen],
          ["monthArea date=YYYY-MM-01",  SEN+"monthProductionAndConsumptionArea",     {GoodsID:sn,date:ym+"-01"}, eagle],
          ["monthArea +MemberAutoID",    SEN+"monthProductionAndConsumptionArea",     {GoodsID:sn,date:ym,MemberAutoID:auth.memberAutoId}, eagle],
          ["monthEnergy",                SEN+"monthEnergy",                            {GoodsID:sn,date:ym},        eagle],
          ["getMonthProduction",         SEN+"getMonthProduction",                     {GoodsID:sn,date:ym},        eagle],
          ["Eagle monthArea",            EAG+"monthProductionAndConsumptionArea",     {GoodsID:sn,date:ym},        eagle],
          ["Eagle monthAreaTime",        EAG+"monthProductionAndConsumptionAreaTime", {GoodsID:sn,date:ym},        eagle],
          ["yearArea (current)",         SEN+"yearProductionAndConsumptionArea",      {GoodsID:sn,date:yr},        eagle],
          ["yearAreaTime",               SEN+"yearProductionAndConsumptionAreaTime",  {GoodsID:sn,date:yr},        eagle],
        ];
        const out = [];
        for (const [label, path, body, tok] of candidates) {
          const b = { ...body }; b.sign = makeSign(b);
          try {
            const r = await midnitePost(path, b, tok);
            const data = Array.isArray(r?.Data) ? r.Data : (Array.isArray(r?.data) ? r.data : null);
            if (data) {
              const d8 = data.find(x => String(x.day) === "8");
              out.push({ label, ok: true, count: data.length, keys: data[0] ? Object.keys(data[0]) : [], day8: d8 || data[0] || null });
            } else {
              out.push({ label, ok: true, count: 0, note: "no Data[] array", body: JSON.stringify(r).slice(0, 300) });
            }
          } catch (e) { out.push({ label, ok: false, err: e.message.slice(0, 160) }); }
        }
        return res.json({ probe: out });
      }
      case "vendorsrc": {
        // TEMPORARY — fetch the vendor's own web dashboard and its JS bundles, then extract
        // every API path / method name they reference. Reveals which month/year endpoint the
        // manufacturer's site actually calls. Remove after the correct source is found.
        const ROOT = (req.body && req.body.url) || "https://view.midnitepower.com/";
        const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0 Safari/537.36" };
        const grab = async (u) => { const r = await fetch(u, { headers: UA }); return { status: r.status, text: await r.text() }; };
        const out = { root: ROOT };
        try {
          const origin = new URL(ROOT).origin;
          const abs = (s, baseDir) => {
            if (s.startsWith("http")) return s;
            s = s.replace(/^\.\//, "");
            if (s.startsWith("/")) return origin + s;
            return (baseDir || origin + "/") + s;
          };
          const home = await grab(ROOT);
          out.rootStatus = home.status; out.rootLen = home.text.length;
          out.rootHtml = home.text.slice(0, 1500);
          const srcs = [...home.text.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/gi)].map(m => m[1]);

          // BFS-crawl same-origin .js chunks (follow the webpack/umi chunk graph)
          const seen = new Set();
          const queue = [...new Set(srcs)].map(s => abs(s)).filter(u => u.startsWith(origin));
          const results = [];
          let totalBytes = 0;
          while (queue.length && seen.size < 50 && totalBytes < 30_000_000) {
            const batch = queue.splice(0, 8).filter(u => !seen.has(u));
            batch.forEach(u => seen.add(u));
            const rs = await Promise.all(batch.map(async (u) => {
              try { const r = await grab(u); return { u, text: r.text }; }
              catch (e) { return { u, err: e.message }; }
            }));
            for (const r of rs) {
              if (!r.text) { results.push({ u: r.u, err: r.err }); continue; }
              results.push({ u: r.u, len: r.text.length, js: r.text });
              totalBytes += r.text.length;
              const baseDir = r.u.slice(0, r.u.lastIndexOf("/") + 1);
              // discover more .js filenames referenced inside this file
              for (const m of r.text.matchAll(/["'`]([A-Za-z0-9_\-./]{2,80}?\.(?:async\.)?js)["'`]/g)) {
                const u = abs(m[1], baseDir);
                if (u.startsWith(origin) && !seen.has(u) && !queue.includes(u)) queue.push(u);
              }
            }
          }
          out.fetched = results.map(r => ({ u: r.u, len: r.len, err: r.err }));
          // dump tiny runtime/manifest files raw so we can see the chunk-URL pattern
          out.smallFiles = results.filter(r => r.js && r.js.length < 4000).map(r => ({ u: r.u, raw: r.js }));
          const big = results.map(r => r.js || "").join("\n");

          // 1) full API paths (broad: any /Word/(web/)?vN/Word/Word)
          const pathSet = new Set();
          for (const m of big.matchAll(/\/[A-Za-z]+\/(?:web\/)?v[0-9]+\/[A-Za-z0-9_]+\/[A-Za-z0-9_]+/g)) pathSet.add(m[0]);

          // 2) quoted string literals that look like API method names / chart keys
          const KW = /(Production|Consumption|Area|Energy|Chart|Statistic|Histor|Kpi|Report|Overview|Generation|PowerCurve|Electric|Income|Revenue)/;
          const litSet = new Set();
          for (const m of big.matchAll(/["'`]([A-Za-z][A-Za-z0-9_]{4,60})["'`]/g)) {
            if (KW.test(m[1])) litSet.add(m[1]);
          }
          // 3) period-prefixed identifiers (monthXxx / yearXxx / dayXxx)
          const periodSet = new Set();
          for (const m of big.matchAll(/["'`]((?:month|year|day|week)[A-Z][A-Za-z0-9_]{2,50})["'`]/g)) periodSet.add(m[1]);

          // 4) base-URL / host clues
          const baseSet = new Set();
          for (const m of big.matchAll(/["'`]([^"'`]*(?:CodeIgniter|index\.php|appsrv|midnite[a-z]*\.com|\/API\/)[^"'`]*)["'`]/gi)) baseSet.add(m[1].slice(0, 120));

          // 5) context around the first few "AndConsumption" / "Area(" occurrences
          const ctx = [];
          for (const key of ["AndConsumption", "ProductionAnd", "ConsumptionArea", "AreaTime", "dayLoadConsumption", "EnergyFlow", "getChart", "Statistic"]) {
            let i = big.indexOf(key);
            if (i >= 0) ctx.push(`[${key}] …${big.slice(Math.max(0, i - 70), i + 90).replace(/\s+/g, " ")}…`);
          }

          out.apiPaths = [...pathSet].sort();
          out.methodLiterals = [...litSet].sort();
          out.periodIdentifiers = [...periodSet].sort();
          out.baseClues = [...baseSet].sort().slice(0, 40);
          out.context = ctx;
        } catch (e) { out.error = e.message; }
        return res.json(out);
      }
      case "viewtest": {
        // TEMPORARY — prove the consumer "view" host returns correct month data by logging
        // into BOTH hosts as the same end-user and pulling month for the SAME inverter.
        const sn = (req.body && req.body.sn) || "2426-90190114PH"; // Wise Naples INV-1
        const date = (req.body && req.body.date) || "2026-06";
        const u = process.env.MIDNITE_USERNAME || "Wise Naples";
        const p = process.env.MIDNITE_PASSWORD || "921551";
        const VIEW = "https://view.midnitepower.com/dist/server/api/CodeIgniter/index.php";
        const SVC = BASE;
        const out = { sn, date, account: u };
        const doHost = async (label, base, origin, referer) => {
          const lb = { MemberID: u, Password: p, type: "1" }; lb.sign = makeSign(lb);
          const lr = await hostPost(base + "/Senergytec/web/v2/Inverterapi/UserLogin", { ...lb, remember: false }, null, origin, referer);
          const tok = lr.token;
          out[label + "Login"] = { status: lr.status, tokenPresent: !!tok, memberAutoId: lr.MemberAutoID };
          if (!tok) return;
          const mb = { GoodsID: sn, date }; mb.sign = makeSign(mb);
          const mr = await hostPost(base + "/Senergytec/web/v2/Inverterapi/monthProductionAndConsumptionArea", mb, tok, origin, referer);
          out[label + "Month"] = (mr.Data || []).slice(0, 9).map(d => ({ day: d.day, Production: d.Production, Consumption: d.Consumption, toGrid: d.powerToGrid, fromGrid: d.powerFromGrid, ConsumedDirectly: d.ConsumedDirectly }));
        };
        try { await doHost("service", SVC, "https://service.midnitepower.com", "https://service.midnitepower.com/"); }
        catch (e) { out.serviceErr = e.message; }
        try { await doHost("view", VIEW, "https://view.midnitepower.com", "https://view.midnitepower.com/dist/"); }
        catch (e) { out.viewErr = e.message; }
        return res.json(out);
      }
      case "installertest": {
        // TEMPORARY — using the CURRENT login (installer Eagle token for a managed site),
        // try to make month return correct/balanced data by passing the end-user MemberAutoID.
        // "balance" = ConsumedDirectly + powerToBattery + powerToGrid; correct when ≈ Production.
        const { sn, memberAutoId, date } = req.body || {};
        if (!sn) return res.status(400).json({ error: "sn required" });
        const d = date || "2026-06";
        const out = { sn, memberAutoId, accountType: auth.accountType, tokenMemberAutoId: auth.memberAutoId };
        const variants = [
          ["A: eagleTok, no MemberAutoID", auth.token, { GoodsID: sn, date: d }],
          ["B: eagleTok + MemberAutoID", auth.token, { GoodsID: sn, date: d, MemberAutoID: memberAutoId }],
          ["C: eagleTok + MemberAutoID lower", auth.token, { GoodsID: sn, date: d, MemberAutoId: memberAutoId }],
          ["D: senTok + MemberAutoID", auth.senToken || auth.token, { GoodsID: sn, date: d, MemberAutoID: memberAutoId }],
        ];
        for (const [label, tok, body] of variants) {
          const b = { ...body }; b.sign = makeSign(b);
          try {
            const r = await midnitePost("/Senergytec/web/v2/Inverterapi/monthProductionAndConsumptionArea", b, tok);
            const x = (r.Data || []).find(o => String(o.day) === "8");
            out[label] = x
              ? { Prod: x.Production, Cons: x.Consumption, CD: x.ConsumedDirectly, toBat: x.powerToBattery, toGrid: x.powerToGrid, balance: (x.ConsumedDirectly || 0) + (x.powerToBattery || 0) + (x.powerToGrid || 0) }
              : "no day-8";
          } catch (e) { out[label] = "ERR " + e.message.slice(0, 90); }
        }
        return res.json(out);
      }
      case "readsettings": {
        // Full inverter settings read: trigger readDeviceShadow_RA_New_AutoID over the Modbus
        // register set (Power Control + Grid tabs), then poll getDeviceShadowStatus_RA for values.
        const { autoId, sn, memberAutoId, codes } = req.body || {};
        if (!autoId) return res.status(400).json({ error: "autoId required" });
        const REG = (codes && codes.length) ? codes : [...new Set([
          "1A18","5101","5000","5001","5019","5029","5002","5003","5004","5005","5006","5007","5008","5009","500A","500B","500C","500D","500E","500F","5010","5011","501A","5021","507F","5017","511D","2125","501F","5020","5025","5026","506C","506D","5033","5030","5031","5121","5059","5034","5035","5036","5037","5038","5039","503A","503B","503C","503D","503E","503F","5040","5041","5042","5043","505A","505B","505C","505D","505E","505F","5060","5061","5027","5028","5012","5013","507A","507B","5078","5079",
          "30B0","30B1","30B2","30B3","30B4","30B5","30B9","30BA","308E","3089","2100","2141","215B","214C","1A48","1A5A","2124","2110","2101","2102","2103","2104","2105","2106","2107","2108","2109","210A","210B","210C","210D","210E","210F","2168","2169","216C","216D","2170","2171","2174","2175","2178","2179","217C","217D","216A","216B","216E","216F","2172","2173","2176","2177","217A","217B","217E","217F","2122","2520","2540","256E","256F","2570","2571","2568","2569","256A","256B","2138","2139","213A","213B","213C","212A","2129","2134","2135","2127","2126","2136","2137","2151","2156","2152","2153","2154","2155","212C","212D","2130","2131","213F","219B",
        ])];
        const aid = String(autoId);
        // readDeviceShadow_RA_New_AutoID with Force:1 returns the register values synchronously,
        // in r.data.data ({code: value}), with reachability flags in r.data.status.
        const rb = { AutoId: aid, ModbusArr: JSON.stringify(REG), Force: 1 }; rb.sign = makeSign(rb);
        let r;
        try { r = await midnitePost("/Eagle/v1/Inverterapi/readDeviceShadow_RA_New_AutoID", rb, auth.token); }
        catch (e) { return res.json({ autoId: aid, err: e.message }); }
        const data = r?.data?.data || {};
        return res.json({ autoId: aid, ok: r?.status ?? null, requested: REG.length, count: Object.keys(data).length, data, statusFlags: r?.data?.status || {} });
      }
      case "shadowsweep": {
        // READ-ONLY discovery probe: sweep a hex range of device-shadow attribute codes via
        // readDeviceShadow_RA_New_AutoID with Force:1 (an on-demand live read of the inverter through
        // its dongle — same mechanism the Remote-Setting dialog uses to "Read"). Returns every code
        // that resolved to a value. Used to find which attribute IDs carry real-time measurements
        // (power / voltage / current / frequency / SOC) for a live data stream. Never writes.
        const { autoId, from, to, chunk } = req.body || {};
        if (!autoId) return res.status(400).json({ error: "autoId required" });
        const lo = parseInt(String(from||"2000"),16), hi = parseInt(String(to||"20FF"),16);
        if (!(Number.isFinite(lo) && Number.isFinite(hi) && hi>=lo)) return res.status(400).json({ error: "bad range (hex from/to)" });
        if (hi-lo+1 > 2048) return res.status(400).json({ error: "range too large (max 2048 codes per call)" });
        const size = Math.min(Math.max(parseInt(chunk||256,10)||256, 16), 512);
        const aid = String(autoId);
        const hex = (n)=> n.toString(16).toUpperCase().padStart(4,"0");
        const all = {}; const reach = {}; let requested = 0;
        for (let start=lo; start<=hi; start+=size) {
          const codes = [];
          for (let c=start; c<=Math.min(start+size-1,hi); c++) codes.push(hex(c));
          requested += codes.length;
          const rb = { AutoId: aid, ModbusArr: JSON.stringify(codes), Force: 1 }; rb.sign = makeSign(rb);
          try {
            const r = await midnitePost("/Eagle/v1/Inverterapi/readDeviceShadow_RA_New_AutoID", rb, auth.token);
            Object.assign(all, r?.data?.data || {});
            Object.assign(reach, r?.data?.status || {});
          } catch (e) { /* keep sweeping the remaining chunks */ }
        }
        const data = {};
        for (const [k,v] of Object.entries(all)) { if (v !== null && v !== "" && v !== undefined) data[k] = v; }
        return res.json({ autoId: aid, from: hex(lo), to: hex(hi), requested, found: Object.keys(data).length, data, reach });
      }
      case "shadow": {
        // Read the inverter's cached device-shadow (settings) — hex attribute codes → values.
        // Populate the full set first by opening the inverter's Settings page in the installer app,
        // then read it here. Returns the complete data object so it can be diffed across inverters.
        const { sn, autoId, memberAutoId } = req.body || {};
        const mid = String(memberAutoId || auth.memberAutoId || "");
        const aid = String(autoId || "");
        const body = { AutoId: aid, GoodsID: sn, memberAutoID: mid }; body.sign = makeSign(body);
        try {
          const r = await midnitePost("/Senergytec/v2/Inverterapi/getDeviceShadowStatus_RA", body, auth.token);
          const data = r?.data || {};
          return res.json({ ok: true, sn, busy: r?.busy ?? null, count: Object.keys(data).length, data });
        } catch (e) { return res.json({ ok: false, sn, err: e.message }); }
      }
      case "iotshadow": {
        // Aliyun IoT device-shadow command channel (salvaged from a parallel experiment).
        // setShadowCommand writes a Command into the unit's Aliyun IoT shadow; receiveShadowCommand
        // reads back whatever the device replied. Hypothesis: poking the shadow forces a fresh
        // telemetry sample / faster reporting — a possible alternate path to real-time data.
        // NOTE: poke=true performs a WRITE (Command); default command "0" — effect unverified.
        const { serial, command = "0", poke = true, receive = true } = req.body || {};
        if (!serial) return res.status(400).json({ error: "serial required" });
        const out = { serial, command };
        if (poke) {
          const setBody = { GoodsID: serial, Command: String(command) }; setBody.sign = makeSign(setBody);
          try { out.set = await midnitePost("/Aliyuniotapi/iot/setShadowCommand", setBody, auth.token); }
          catch (e) { out.set = { error: e.message }; }
        }
        if (receive) {
          const recvBody = { GoodsID: serial }; recvBody.sign = makeSign(recvBody);
          try { out.receive = await midnitePost("/Aliyuniotapi/iot/receiveShadowCommand", recvBody, auth.token); }
          catch (e) { out.receive = { error: e.message }; }
        }
        return res.json(out);
      }
      case "codelookup": {
        // Search the installer app's JS bundle for device-shadow attribute codes to recover their
        // human-readable labels and value meanings (so we can name the differing settings).
        const codes = (req.body && req.body.codes) || ["1A18","1A44","1A45","1A46","1A4E"];
        const ROOT = "https://service.midnitepower.com/";
        const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/148.0 Safari/537.36" };
        const grab = async (u) => (await fetch(u, { headers: UA })).text();
        const home = await grab(ROOT);
        const srcs = [...home.matchAll(/(?:src|href)=["']([^"']+\.js[^"']*)["']/gi)].map(m=>m[1]);
        const abs = (s)=> s.startsWith("http")?s:ROOT.replace(/\/$/,"")+(s.startsWith("/")?s:"/"+s);
        let js = "";
        for (const s of srcs.slice(0,6)) { try { js += "\n" + await grab(abs(s)); } catch(e){} }
        const out = {};
        for (const code of codes) {
          const hits = [];
          const re = new RegExp(code.replace(/[^A-Za-z0-9]/g,""), "gi");
          let m, n=0;
          while ((m = re.exec(js)) && n < 6) { hits.push(js.slice(Math.max(0,m.index-140), m.index+160).replace(/\s+/g," ")); n++; }
          out[code] = hits;
        }
        return res.json({ bundleLen: js.length, found: out });
      }
      case "probemppt": {
        // TEMPORARY — hunt for a per-MPPT/PV-string intraday history endpoint for the day chart.
        const { sn, date } = req.body || {};
        if (!sn) return res.status(400).json({ error: "sn required" });
        const d = date || new Date().toISOString().split("T")[0];
        const SEN = "/Senergytec/web/v2/Inverterapi/";
        const cand = [
          "getInverterHistoryData","getInverterHistory","getHistoryData","historyData",
          "dayHistoryData","getDayHistory","getDayDetailData","getDayDetail","dayDetailData",
          "dayDetailAreaTime","getInverterDayDetail","inverterDayHistory","historyDayData",
          "exportDayData","downloadDayData","dayDataExport","exportInverterData","getDayData",
          "getInverterRunData","InverterRunData","getRunData","dayRunDataAreaTime","getDayRunData",
        ];
        const out = [];
        for (const m of cand) {
          const body = { GoodsID: sn, date: d }; body.sign = makeSign(body);
          try {
            const r = await midnitePost(SEN + m, body, auth.token);
            const data = Array.isArray(r?.Data) ? r.Data : (Array.isArray(r?.data) ? r.data : null);
            if (data) out.push({ m, ok: true, count: data.length, keys: data[0] ? Object.keys(data[0]) : [], sample: data[Math.floor(data.length/2)] || data[0] });
            else out.push({ m, ok: true, count: 0, note: JSON.stringify(r).slice(0, 160) });
          } catch (e) { out.push({ m, ok: false, err: e.message.slice(0, 80) }); }
        }
        // Also try the Eagle namespace for a couple of the likeliest export names
        for (const [ns,m] of [["/Eagle/v1/Inverterapi/","getInverterHistoryData"],["/Eagle/v1/Inverterapi/","exportDayData"]]) {
          const body = { GoodsID: sn, date: d }; body.sign = makeSign(body);
          try { const r = await midnitePost(ns + m, body, auth.token); const data=Array.isArray(r?.Data)?r.Data:(Array.isArray(r?.data)?r.data:null);
            out.push({ m:"Eagle:"+m, ok:true, count:data?data.length:0, keys:data&&data[0]?Object.keys(data[0]):[], note:data?"":JSON.stringify(r).slice(0,120) });
          } catch(e){ out.push({ m:"Eagle:"+m, ok:false, err:e.message.slice(0,80) }); }
        }
        return res.json({ probe: out });
      }
      case "logsearch": {
        const {serials:ls,startDate,endDate}=req.body||{};
        if(!ls?.length) return res.status(400).json({error:"serials required"});
        const now=new Date();
        const eDate=endDate||now.toISOString().split('T')[0];
        const sDate=startDate||new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0];
        const results=await Promise.all(ls.map(async sn=>{
          const body={GoodsID:sn,MemberID:auth.username,selectType:2,SDate:sDate,EDate:eDate};
          body.sign=makeSign(body);
          try {
            const data=await midnitePost("/Senergytec/web/v2/Inverterapi/logsearch",body,auth.token);
            return {sn,ok:true,...data};
          } catch(e){return {sn,ok:false,error:e.message};}
        }));
        // Merge all inverter fault events, newest first
        const events=results.filter(r=>r.ok).flatMap(r=>(r.infoerror||[]).map(e=>({...e,sn:r.sn})));
        events.sort((a,b)=>new Date(b.Time)-new Date(a.Time));
        const totalErrors=results.reduce((s,r)=>s+(r.total_error_num||0),0);
        return res.json({events,totalErrors});
      }
      case "debug": {
        // Diagnostic endpoint — call from browser console to expose auth, site IDs, InverterList fields,
        // and a live getInverterStatus attempt. Remove this case before production.
        const {serials:ds}=req.body||{};
        const out = {
          auth: { accountType: auth.accountType, memberAutoId: auth.memberAutoId, username: auth.username },
        };

        out.senToken_present = !!auth.senToken;

        // --- installer path: show raw terminaluserinfo + probe Eagle endpoints for MemberAutoID ---
        if (auth.accountType === "installer") {
          try {
            const now=new Date();
            const tb={MemberID:auth.username,Page:1,EndUserName:"",OperationName:"",GoodsID:"",
              inDate:now.toISOString().split("T")[0],inTime:now.toTimeString().split(" ")[0],status:0};
            tb.sign=makeSign(tb);
            const sites=await midnitePost("/Eagle/v1/Operation/terminaluserinfo",tb,auth.token);
            const first=Array.isArray(sites)?sites[0]:null;
            out.terminaluserinfo_first_site_keys = first ? Object.keys(first) : [];
            out.terminaluserinfo_first_site = first;

            // Probe Eagle endpoints that might give us end-user MemberAutoID or rich status
            const endUserMemberID = first?.MemberID; // e.g. "Wise Naples"
            const firstSerial = first?.GoodsID?.[0]?.GoodsID || ds?.[0];
            out.installer_probe = { endUserMemberID, firstSerial };

            // Probe 1: getUserInfo or similar
            for (const ep of [
              "/Eagle/v1/Operation/getUserInfo",
              "/Eagle/v1/Operation/getEndUserInfo",
              "/Eagle/v1/Operation/getMemberInfo",
            ]) {
              try {
                const pb={MemberID:endUserMemberID}; pb.sign=makeSign(pb);
                const r=await midnitePost(ep,pb,auth.token);
                out.installer_probe[ep]={ok:true,keys:Object.keys(r||{}),sample:r};
                break;
              } catch(e){ out.installer_probe[ep]={ok:false,err:e.message}; }
            }

            // Probe 2: Eagle InverterList variants
            for (const ep of [
              "/Eagle/v1/Inverterapi/InverterList",
              "/Eagle/v1/Inverterapi/getInverterList",
            ]) {
              try {
                const pb={MemberID:endUserMemberID,GoodsID:firstSerial||""}; pb.sign=makeSign(pb);
                const r=await midnitePost(ep,pb,auth.token);
                out.installer_probe[ep]={ok:true,keys:Object.keys(r||{}),sample:r};
              } catch(e){ out.installer_probe[ep]={ok:false,err:e.message}; }
            }

            // Probe 3: getInverterStatus with MemberID instead of memberAutoID
            if(firstSerial) {
              try {
                const pb={GoodsID:firstSerial,MemberID:endUserMemberID}; pb.sign=makeSign(pb);
                const r=await midnitePost("/Eagle/v1/Inverterapi/getInverterStatus",pb,auth.token);
                out.installer_probe["getInverterStatus_with_MemberID"]={ok:true,hasMppts:!!r?.data?.photovoltaic?.mppts,status:r?.status};
              } catch(e){ out.installer_probe["getInverterStatus_with_MemberID"]={ok:false,err:e.message}; }
            }
          } catch(e){ out.terminaluserinfo_err=e.message; }
        }

        // --- InverterList: show raw first inverter object to find AutoID field ---
        if (auth.memberAutoId) {
          try {
            const glb={MemberAutoID:auth.memberAutoId,inputValue:""};
            glb.sign=makeSign(glb);
            const groups=await midnitePost("/Senergytec/web/v2/Inverterapi/GroupList",glb,auth.token);
            out.groups=(groups?.AllGroupList||[]).map(g=>({AutoID:g.AutoID,name:g.GroupName}));
            const firstGroup=(groups?.AllGroupList||[])[0];
            if(firstGroup) {
              const ilb={MemberAutoID:auth.memberAutoId,GroupAutoID:firstGroup.AutoID};
              ilb.sign=makeSign(ilb);
              const inv=await midnitePost("/Senergytec/web/v2/Inverterapi/InverterList",ilb,auth.token);
              const first=(inv?.AllInverterList||[])[0];
              out.inverterlist_first_keys = first ? Object.keys(first) : [];
              out.inverterlist_first = first;
            }
          } catch(e){ out.inverterlist_err=e.message; }
        }

        // --- Try getInverterStatus with first provided serial ---
        const testSn = ds?.[0];
        if (testSn) {
          // Try with GoodsID as AutoId fallback
          const autoIdGuesses = [
            out.inverterlist_first?.AutoID, out.inverterlist_first?.InverterAutoID,
            out.inverterlist_first?.auto_id, out.inverterlist_first?.id,
          ].filter(Boolean);
          out.autoId_candidates = autoIdGuesses;
          for (const aid of autoIdGuesses) {
            try {
              const rb2={AutoId:String(aid),memberAutoID:String(auth.memberAutoId)};
              rb2.sign=makeSign(rb2);
              const r=await midnitePost("/Eagle/v1/Inverterapi/getInverterStatus",rb2,auth.token);
              out.getInverterStatus_result={autoIdUsed:aid,status:r?.status,hasMppts:!!r?.data?.photovoltaic?.mppts,dataKeys:r?.data?Object.keys(r.data):[]};
              break;
            } catch(e){ out.getInverterStatus_err=e.message; }
          }
        }

        return res.json(out);
      }
      case "rawstatus": {
        // Debug endpoint — returns the full unprocessed InverterDetailInfoNewone response
        // Use this to discover MPPT/fault/mode field names
        const {serials:rs}=req.body||{};
        const sn=rs?.[0]; if(!sn) return res.status(400).json({error:"serials required"});
        const rb={GoodsID:sn,MemberAutoID:auth.memberAutoId}; rb.sign=makeSign(rb);
        const raw=await midnitePost("/Senergytec/web/v2/Inverterapi/InverterDetailInfoNewone",rb,auth.token);
        console.log("[rawstatus fields]", Object.keys(raw).join(", "));
        return res.json(raw);
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("[midnite proxy]", err.message);
    return res.status(err.code || 500).json({ error: err.message });
  }
}
