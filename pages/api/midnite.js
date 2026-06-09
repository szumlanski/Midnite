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
        // Parse the quoted CSV. Header row begins with "Time"; columns: Time,MPPT1,MPPT2,MPPT3,...
        const wOf = (cell) => { const p = String(cell||"").split("/"); const last = p[p.length-1]||""; return parseFloat(last.replace(/[^0-9.\-]/g,"")) || 0; };
        const rows = []; let started = false;
        for (const line of text.split(/\r?\n/)) {
          const f = [...line.matchAll(/"([^"]*)"/g)].map(m=>m[1]);
          if (!f.length) continue;
          if (f[0] === "Time") { started = true; continue; }
          if (!started || !/^\d{4}-\d{2}-\d{2}[ T]/.test(f[0])) continue;
          rows.push({ time: f[0].split(/[ T]/)[1], mppt: [wOf(f[1]), wOf(f[2]), wOf(f[3])] });
        }
        const activeMppts = [0,1,2].filter(i => rows.some(r => Math.abs(r.mppt[i]) > 1));
        return res.json({ rows, activeMppts, count: rows.length });
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
    return res.status(500).json({ error: err.message });
  }
}
