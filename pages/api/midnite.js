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

async function login(user = null, pass = null) {
  const username = user || process.env.MIDNITE_USERNAME || "Wise Naples";
  const password = pass || process.env.MIDNITE_PASSWORD || "921551";

  // Try installer (Eagle/Operation) login first
  try {
    const opParams = { MemberID: username, PassWord: password };
    opParams.sign = makeSign(opParams);
    const opData = await midnitePost("/Eagle/v1/Operation/login", opParams);
    if (opData.status === "ok" || opData.token) {
      return { token: opData.token, memberAutoId: String(opData.MemberAutoID || ""), accountType: "installer", username };
    }
  } catch (e) { /* fall through to end-user login */ }

  // Fall back to end-user (Senergytec) login
  const params = { MemberID: username, Password: password, type: "1" };
  params.sign = makeSign(params);
  const body = { ...params, remember: false };
  const data = await midnitePost("/Senergytec/web/v2/Inverterapi/UserLogin", body);
  if (data.status !== "ok") throw new Error(`Login failed: Invalid username or password`);
  return { token: data.token, memberAutoId: String(data.MemberAutoID), accountType: "enduser", username };
}

function normalizeDetail(raw, sn) {
  if(!raw || raw.GoodsID === undefined) return null;
  const pvW = parseFloat(raw.TotalDCpower || 0);
  const loadW = (parseFloat(raw.loadCurrpac?.[0] || 0) + parseFloat(raw.loadCurrpac?.[1] || 0) + parseFloat(raw.loadCurrpac?.[2] || 0));
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
    const { username, password } = req.body || {};
    const auth = await login(username, password);

    switch (action) {
      case "login": {
        return res.json({ ok: true, memberAutoId: auth.memberAutoId, accountType: auth.accountType });
      }
      case "sites": {
        if (auth.accountType === "installer") {
          const now = new Date();
          const body = {
            MemberID: auth.username,
            Page: 1,
            EndUserName: "",
            OperationName: "",
            GoodsID: "",
            inDate: now.toISOString().split("T")[0],
            inTime: now.toTimeString().split(" ")[0],
            status: 0,
          };
          body.sign = makeSign(body);
          const data = await midnitePost("/Eagle/v1/Operation/terminaluserinfo", body, auth.token);
          return res.json({ accountType: "installer", sites: Array.isArray(data) ? data : [] });
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
          sites.push({
            MemberID: auth.username,
            GoodsID: list.map(d => ({ GoodsID: d.GoodsID })),
            MemberStateCount: [status.Green||0, status.yellow||0, status.red||0, status.gray||0],
          });
        }
        return res.json({ accountType: "enduser", sites });
      }
      case "rawstatus": {
        const {sn}=req.body||{};
        if(!sn) return res.status(400).json({error:"sn required"});
        const body={GoodsID:sn,MemberAutoID:auth.memberAutoId};
        body.sign=makeSign(body);
        const raw=await midnitePost("/Senergytec/web/v2/Inverterapi/InverterDetailInfoNewone",body,auth.token);
        return res.json({raw});
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
