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

async function login() {
  const username = process.env.MIDNITE_USERNAME || "FLOSOL2";
  const password = process.env.MIDNITE_PASSWORD || "921551";
  const params = { MemberID: username, Password: password, type: "1" };
  const sign = makeSign(params);
  const body = { ...params, remember: false, sign };
  const data = await midnitePost("/Senergytec/web/v2/Inverterapi/UserLogin", body);
  if (data.status !== "ok") throw new Error(`Login failed: ${JSON.stringify(data)}`);
  return { token: data.token, memberAutoId: String(data.MemberAutoID) };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const action = req.query.action;
  try {
    const auth = await login();
    
    switch (action) {
      case "login": {
        return res.json({ ok: true, memberAutoId: auth.memberAutoId });
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
        const { sn } = req.body || {};
        if (!sn) return res.status(400).json({ error: "sn required" });
        const body = { GoodsID: sn };
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
