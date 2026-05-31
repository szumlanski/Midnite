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
          // Fallback: InverterDetailInfoNewone
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
    return res.status(500).json({ error: err.message });
  }
}
