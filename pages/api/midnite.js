const CryptoJS = require("crypto-js");

const BASE = "https://service.midnitepower.com/API/CodeIgniter/index.php";
const AES_KEY = "05469137076236813460585715952089";
const AES_IV = "5161557162012237";
const SALT = "05469137076236813460585715952089";

function makeSign(params) {
  const filtered = Object.fromEntries(Object.entries(params).filter(([,v])=>v!==null&&v!==""&&typeof v!=="boolean"));
  const sortedKeys = Object.keys(filtered).sort();
  const parts = sortedKeys.map(k=>Array.isArray(filtered[k])?`${k}=Array`:`${k}=${filtered[k]}`);
  const plaintext = parts.join("&")+"&"+SALT;
  const key = CryptoJS.enc.Utf8.parse(AES_KEY);
  const iv  = CryptoJS.enc.Utf8.parse(AES_IV);
  return CryptoJS.AES.encrypt(plaintext,key,{iv,mode:CryptoJS.mode.CBC,padding:CryptoJS.pad.Pkcs7}).toString();
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

async function login(user = null, pass = null, loginType = "1") {
  const username = user || process.env.MIDNITE_USERNAME || "FLOSOL2";
  const password = pass || process.env.MIDNITE_PASSWORD || "921551";
  const params = { MemberID: username, Password: password, type: loginType };
  const sign = makeSign(params);
  const body = { ...params, remember: false, sign };
  const data = await midnitePost("/Senergytec/web/v2/Inverterapi/UserLogin", body);
  if (data.status !== "ok") throw new Error(`Login failed: ${JSON.stringify(data)}`);
  return { token: data.token, memberAutoId: String(data.MemberAutoID) };
}

function normalizeDetail(raw, sn) {
  if(!raw || raw.GoodsID === undefined) return null;
  const pvW = parseFloat(raw.TotalDCpower || 0);
  const loadW = (parseFloat(raw.loadCurrpac?.[0] || 0) + parseFloat(raw.loadCurrpac?.[1] || 0) + parseFloat(raw.loadCurrpac?.[2] || 0));
  const gridExportW = (parseFloat(raw.gridCurrpac?.[0] || 0) + parseFloat(raw.gridCurrpac?.[1] || 0) + parseFloat(raw.gridCurrpac?.[2] || 0));
  const gridNetW = -gridExportW;
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
        { power: parseFloat(raw.loadCurrpac?.[0] || 0), voltage: parseFloat(raw.loadVac?.[0] || 0), current: parseFloat(raw.loadIac?.[0] || 0) },
        { power: parseFloat(raw.loadCurrpac?.[1] || 0), voltage: parseFloat(raw.loadVac?.[1] || 0), current: parseFloat(raw.loadIac?.[1] || 0) },
      ],
      power: { today: parseFloat(raw.ELDay || 0) * 1000, total: parseFloat(raw.ELTotal || 0) * 1000 },
    },
    battery: {
      brand: raw.brand || "",
      voltage: parseFloat(raw.volt || 0),
      current: parseFloat(raw.cur || 0),
      charge: batChargeW,
      discharge: batDischargeW,
      soc: parseFloat(raw.SOC || 0),
      healthPercent: parseFloat(raw.SOH || 0),
      temperature: parseFloat(raw.BMS_temp || 0),
      chargeIn: { today: parseFloat(raw.Etotal_batChrg || 0) * 1000, total: 0 },
      dischargeOut: { today: parseFloat(raw.Etotal_batDischrg || 0) * 1000, total: 0 },
    },
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;
  try {
    const { username, password, loginType } = req.body || {};
    const auth = await login(username, password, loginType || "1");

    switch (action) {
      case "login": {
        return res.json({ ok: true, memberAutoId: auth.memberAutoId });
      }
      case "sites": {
        const body = { MemberAutoID: auth.memberAutoId };
        body.sign = makeSign(body);
        // Try multiple endpoint name variations
        const paths = [
          "/Senergytec/web/v2/Inverterapi/TerminalUserInfo",
          "/Senergytec/web/v2/Inverterapi/terminaluserinfo",
          "/Senergytec/web/v2/Inverterapi/terminalUserInfo",
        ];
        let data = null;
        for (const path of paths) {
          try { data = await midnitePost(path, body, auth.token); break; }
          catch (e) { if (!e.message.includes("405")) throw e; }
        }
        if (!data) throw new Error("terminaluserinfo endpoint not found");
        return res.json(data);
      }
      case "status": {
        const {serials}=req.body||{};
        if(!serials?.length) return res.status(400).json({error:"serials required"});
        const results = await Promise.all(serials.map(async sn=>{
          const body={GoodsID:sn,MemberAutoID:auth.memberAutoId};
          body.sign=makeSign(body);
          try {
            const raw=await midnitePost("/Senergytec/web/v2/Inverterapi/InverterDetailInfoNewone",body,auth.token);
            const data=normalizeDetail(raw,sn);
            return {sn,ok:!!data,data,error:data?null:"No data returned"};
          }
          catch(e){return {sn,ok:false,data:null,error:e.message};}
        }));
        return res.json({results});
      }
      case "day": {
        const { sn, date } = req.body || {};
        if (!sn || !date) return res.status(400).json({ error: "sn and date required" });
        const body = { GoodsID: sn, date };
        body.sign = makeSign(body);
        return res.json(await midnitePost("/Senergytec/web/v2/Inverterapi/dayProductionAndConsumptionAreaTime", body, auth.token));
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
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error("[midnite proxy]", err.message);
    return res.status(500).json({ error: err.message });
  }
}
