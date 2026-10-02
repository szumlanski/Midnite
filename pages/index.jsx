import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import { supabase, supabaseReady } from "../lib/supabaseClient";
import { AreaChart, Area, BarChart, Bar, ComposedChart, Line, Brush, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from "recharts";
import { triggerGroups, getTrigger } from "@/lib/notifications/triggers";
import { summarizeRule } from "@/lib/notifications/engine";
import { usePolling, useLiveGate, POLL } from "../lib/usePolling";
import { BG, CARD, BORDER, TEXT, MUTED, FAINT, SOLAR, BATTERY, GRID_IN, GRID_OUT, LOAD_C, SOLAR_TEXT, BATTERY_TEXT, GRID_OUT_TEXT, GRID_IN_TEXT, SHADOW, SHADOW_SM, SANS, CHART_PROD, CHART_CONS, CHART_BAT, CHART_GRID, FS, textTone } from "@/components/ui/tokens";
import { Icon, svgIcon } from "@/components/ui/Icon";
import { Logo } from "@/components/ui/Logo";
import { Button, IconButton, MoreMenu, Segmented, Switch } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { confirmAlert, toast } from "@/components/ui/Alert";
import { CountUp, Meter, useStaggerIn, useSlidingIndicator, gsap, Flip, prefersReducedMotion, useIsoLayoutEffect, usePrefersReducedMotion } from "@/components/ui/motion";

const today = new Date().toISOString().split("T")[0];
const thisMonth = today.slice(0,7);
const thisYear = today.slice(0,4);
// Build marker (baked in at build time via next.config env) — lets you confirm a deploy landed.
const BUILD = `v${process.env.NEXT_PUBLIC_APP_VERSION || "?"} · ${process.env.NEXT_PUBLIC_COMMIT || "local"} · ${(process.env.NEXT_PUBLIC_BUILD_TIME || "").slice(5,16).replace("T"," ")}`;
// Date math for the Explorer date-range picker (operate at noon to dodge DST edges).
const addDays = (d,n) => { const x=new Date(d+"T12:00:00"); x.setDate(x.getDate()+n); return x.toISOString().split("T")[0]; };
const dayDiff = (a,b) => Math.round((new Date(b+"T12:00:00")-new Date(a+"T12:00:00"))/86400000);
const datesInRange = (start,end) => { const out=[]; let d=start; while(d<=end && out.length<7){ out.push(d); d=addDays(d,1); } return out; };

const fmt = (w,d=1) => { if(w==null) return "--"; if(Math.abs(w)>=1000) return `${(w/1000).toFixed(d)} kW`; return `${Math.round(w)} W`; };
const fmtE = (wh) => { if(wh==null) return "--"; if(wh>=1000000) return `${(wh/1000000).toFixed(2)} MWh`; if(wh>=1000) return `${(wh/1000).toFixed(1)} kWh`; return `${Math.round(wh)} Wh`; };
// House load derived from the energy balance: PV + grid-import + battery-discharge − charge − export.
// Robust across inverter types — AIO units serve load through a smart/EPS port, so the AC load
// register reads 0 and the real consumption only shows up in this balance.
const balanceLoad = (d) => d ? Math.max(0, (d.photovoltaic?.power?.totalDc||0) + (d.grid?.netW||0) + (d.battery?.discharge||0) - (d.battery?.charge||0)) : null;
const fmtHrs = (h) => { if(!isFinite(h)||h<=0) return "--"; if(h>=48) return `${(h/24).toFixed(1)} days`; const H=Math.floor(h), M=Math.round((h-H)*60); return M? `${H}h ${M}m` : `${H}h`; };
// Data-age in minutes from an inverter report timestamp (DataTime / lastUpdateTime, ET wall-clock
// "YYYY-MM-DD HH:MM:SS"): parse both it and now-in-ET as wall time via Date.UTC so the timezone cancels.
// Null if unparseable. This is the inverter's REPORT time, not our fetch time — how delayed the data is.
const _wallMs = (s) => { const m=String(s||"").replace("T"," ").match(/(\d{4})-(\d{2})-(\d{2})\D+(\d{1,2}):(\d{2})(?::(\d{2}))?/); return m? Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+(m[6]||0)) : null; };
const _etNow = () => new Intl.DateTimeFormat("en-CA",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date());
const ageMin = (s) => { const a=_wallMs(s), b=_wallMs(_etNow()); return (a!=null&&b!=null)? Math.max(0,Math.round((b-a)/60000)) : null; };
const fmtAge = (m) => m==null?null : m<1?"just now" : m<60?`${m}m ago` : m<1440?`${Math.floor(m/60)}h ${m%60}m ago` : `${Math.floor(m/1440)}d ago`;
// "Updated Xm ago" chip — turns amber past `stale` minutes (data refreshes ~every 5 min, so >10 = a missed report).
function UpdatedChip({time, stale=10}){
  const m = ageMin(time);
  if(m==null) return null;
  const old = m>stale;
  return <span style={{fontSize:FS.caption,fontWeight:600,color:old?"#92400E":MUTED,background:old?"#FEF3C7":"transparent",padding:old?"2px 8px":0,borderRadius:10,whiteSpace:"nowrap",textTransform:"none",letterSpacing:0,display:"inline-flex",alignItems:"center",gap:4}}>{old&&<Icon name="alert"/>}Updated {fmtAge(m)}</span>;
}
// Live freshness chip — seconds since the last FRESH flowrt sample arrived (ticks every 1s on its own).
// `atMs` is set when the inverter's real-time sample actually advanced (its report time), not on every poll.
function LiveChip({atMs, stale=30}){
  const [,setT]=useState(0);
  useEffect(()=>{ const id=setInterval(()=>setT(t=>t+1),1000); return ()=>clearInterval(id); },[]);
  if(!atMs) return null;
  const s = Math.max(0, Math.round((Date.now()-atMs)/1000));
  const old = s>stale;
  const label = s<3 ? "just now" : s<60 ? `${s}s ago` : `${Math.floor(s/60)}m ${s%60}s ago`;
  return <span style={{fontSize:FS.caption,fontWeight:600,color:old?"#92400E":BATTERY_TEXT,background:old?"#FEF3C7":"transparent",padding:old?"2px 8px":0,borderRadius:10,whiteSpace:"nowrap",textTransform:"none",letterSpacing:0,display:"inline-flex",alignItems:"center",gap:4}}>{old?<Icon name="alert"/>:<span style={{width:6,height:6,borderRadius:"50%",background:BATTERY,display:"inline-block",animation:"pulse 2s infinite"}}/>}Updated {label}</span>;
}

// "Live" badge shown while the real-time overlay is feeding a surface.
function LiveBadge(){
  return <span className="ui-pill" style={{padding:"2px 8px",background:"#DCFCE7",border:"1px solid #86EFAC",color:BATTERY_TEXT}}><span className="ui-dot" style={{width:6,height:6,background:BATTERY,animation:"pulse 2s infinite"}}/>Live</span>;
}

// Placeholder shown while the first live read is in flight (HIG Loading: show something at once).
function LiveSkeleton(){
  const blk = (h, mb=16) => <div className="ui-skel" style={{height:h,borderRadius:16,marginBottom:mb}}/>;
  return (<div aria-busy="true" aria-label="Loading live data">
    {blk(320)}{blk(170)}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>{blk(260,0)}{blk(260,0)}</div>
  </div>);
}

// Session cache for historical, immutable data (past day/month/year + their MPPT export). The
// current day/month/year is never cached so live periods stay fresh. Cleared on logout.
const _apiCache = new Map();
const _activeAccountId = () => (typeof localStorage!=="undefined" ? localStorage.getItem("midnite_account_id")||"" : "");
function _cacheKey(action, body){ return `${_activeAccountId()}:${action}:${body?.sn||""}:${body?.date||""}:${body?.memberId||""}`; }
function _isHistorical(action, body){
  const d = body?.date;
  if(!d) return false;
  if(action==="day"||action==="dayexcel") return d < today;
  if(action==="month") return d < thisMonth;
  if(action==="year") return d < thisYear;
  return false;
}
async function api(action, body=null) {
  const cacheable = _isHistorical(action, body);
  const key = cacheable ? _cacheKey(action, body) : null;
  if(key && _apiCache.has(key)) return _apiCache.get(key);
  let token = null;
  try { token = (await supabase?.auth.getSession())?.data?.session?.access_token || null; } catch {}
  const accountId = _activeAccountId() || undefined;
  const merged = { ...body, accountId };
  const res = await fetch(`/api/midnite?action=${action}`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", ...(token?{ Authorization:`Bearer ${token}` }:{}) },
    body:JSON.stringify(merged),
  });
  if(!res.ok){ let msg=`API error ${res.status}`; try{ msg=(await res.json()).error||msg; }catch{} const e=new Error(msg); e.status=res.status; throw e; }
  const data = await res.json();
  if(key) _apiCache.set(key, data);
  return data;
}

// Keeps per-inverter series (pv{i} above zero, loadNeg{i} below zero) for the stacked-area
// day chart, plus the summed pv/load/grid/soc used for fallbacks and the grid line.
function aggregateDayData(all) {
  const map = {};
  all.forEach((inv, idx) => {
    if(!inv||!inv.Data) return;
    for(const r of inv.Data) {
      const k=r.inTime;
      if(!map[k]) map[k]={time:k,pv:0,load:0,gridImport:0,gridExport:0,soc:0,n:0};
      const row=map[k];
      const prod=parseFloat(r.Production||0), cons=parseFloat(r.Consumption||0);
      row["pv"+idx]=(row["pv"+idx]||0)+prod;
      row["loadNeg"+idx]=(row["loadNeg"+idx]||0)-cons;
      row.pv+=prod; row.load+=cons;
      row.gridImport+=parseFloat(r.powerFromGrid||0);
      row.gridExport+=parseFloat(r.powerToGrid||0);
      const soc=parseFloat(r.SOC||0); if(soc>0){row.soc+=soc; row.n+=1;}
    }
  });
  return Object.values(map).sort((a,b)=>a.time.localeCompare(b.time)).map(r=>{
    const avg=r.n?r.soc/r.n:null; const batNet=r.pv-r.load-r.gridExport+r.gridImport;
    return {...r,soc:avg,gridNet:r.gridImport-r.gridExport,batCharge:Math.max(0,batNet),batDischarge:Math.max(0,-batNet)};
  });
}
// PV production from the month/year rollup. The endpoint's own "Production" field is unreliable
// on some inverter firmwares (e.g. mode 795) — it can come back far too low, even less than
// ConsumedDirectly, which is physically impossible. PV energy can only go three places:
// directly to load, into the battery, or out to the grid. That identity holds on every inverter,
// so reconstruct production from it instead of trusting "Production". Battery charge/discharge
// come straight from powerToBattery/powerFromBattery (the rollup provides them — no heuristic).
function rollupProduction(r){ return parseFloat(r.ConsumedDirectly||0)+parseFloat(r.powerToBattery||0)+parseFloat(r.powerToGrid||0); }
// Single-inverter per-MPPT day data: merges the CSV-export MPPT power (pv0/pv1/pv2) with the
// regular day endpoint's load/grid/battery/soc, keyed by time.
function aggregateDayMppt(dayResp, excelRows) {
  const dmap = {};
  for(const r of (dayResp?.Data||[])) dmap[r.inTime] = r;
  return excelRows.map(er=>{
    const dr = dmap[er.time] || {};
    const load = parseFloat(dr.Consumption||0);
    const gi = parseFloat(dr.powerFromGrid||0), ge = parseFloat(dr.powerToGrid||0);
    const ch = parseFloat(dr.powerToBattery||0), di = parseFloat(dr.powerFromBattery||0);
    const socv = parseFloat(dr.SOC||0);
    const row = { time: er.time, loadNeg0: -load, gridNet: gi-ge, batNet: ch-di, soc: socv>0?socv:null };
    er.mppt.forEach((w,i)=>{ row["pv"+i]=w; });
    return row;
  });
}
function aggregateMonthData(all) {
  const map = {};
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.day; if(!map[k]) map[k]={day:k,production:0,consumption:0,fromGrid:0,toGrid:0,batCharge:0,batDischarge:0}; map[k].production+=rollupProduction(r); map[k].consumption+=parseFloat(r.Consumption||0); map[k].fromGrid+=parseFloat(r.powerFromGrid||0); map[k].toGrid+=parseFloat(r.powerToGrid||0); map[k].batCharge+=parseFloat(r.powerToBattery||0); map[k].batDischarge+=parseFloat(r.powerFromBattery||0); } }
  return Object.values(map).sort((a,b)=>a.day-b.day);
}
function aggregateYearData(all) {
  const M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const map = {};
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.month; if(!map[k]) map[k]={month:M[k-1]||k,_m:k,production:0,consumption:0,fromGrid:0,toGrid:0,batCharge:0,batDischarge:0}; map[k].production+=rollupProduction(r); map[k].consumption+=parseFloat(r.Consumption||0); map[k].fromGrid+=parseFloat(r.powerFromGrid||0); map[k].toGrid+=parseFloat(r.powerToGrid||0); map[k].batCharge+=parseFloat(r.powerToBattery||0); map[k].batDischarge+=parseFloat(r.powerFromBattery||0); } }
  return Object.values(map).sort((a,b)=>a._m-b._m);
}
// Custom date range (e.g. utility billing period) — list the YYYY-MM months a range spans, and flatten
// per-month daily rollups into one date-sorted array of {..., _date, day:"M/D"} within [start,end].
function monthsInRange(start, end){
  const out=[]; let [y,m]=start.split("-").map(Number); const [ey,em]=end.split("-").map(Number);
  while(y<ey || (y===ey&&m<=em)){ out.push(`${y}-${String(m).padStart(2,"0")}`); m++; if(m>12){m=1;y++;} if(out.length>60)break; }
  return out;
}
function aggregateRange(perMonth, start, end){
  const rows=[];
  for(const {m, days} of perMonth){
    for(const d of days){
      const date=`${m}-${String(d.day).padStart(2,"0")}`;
      if(date>=start && date<=end && date<=today) rows.push({ ...d, _date:date, day:`${parseInt(m.slice(5),10)}/${d.day}` });
    }
  }
  return rows.sort((a,b)=>a._date.localeCompare(b._date));
}

// Design tokens live in components/ui/tokens.js (imported above).

// MONTH/YEAR bar alignment — the permanent fix is a SINGLE shared stackId ("a") on every Bar
// (positives and negatives). Recharts stacks positives up and negatives down at the SAME x, so
// pos/neg are always flush over the zero line — no barGap/barSize hacks, robust to any bar width.
// DO NOT split pos/neg into separate stackIds (that puts them in side-by-side groups → misaligned).
const BAR_MONTH = { barCategoryGap: "20%", maxBarSize: 22 };
const BAR_YEAR  = { barCategoryGap: "20%", maxBarSize: 44 };
const TOOLTIP_S = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"10px 14px", fontSize:FS.footnote, color:TEXT, boxShadow:"0 4px 20px rgba(0,0,0,0.12)", fontFamily:SANS };

const WORK_MODE_LABELS = {0:"Self Consumption",1:"Feed-In Priority",2:"Backup Priority",3:"Time of Use",4:"Peak Shaving",5:"Off Grid"};
const INV_STATE_LABELS  = {0:"Standby",1:"Normal",2:"Checking",3:"On Grid",4:"Off Grid",5:"Fault"};


const PageHead = ({title}) => (
  <Head>
    <title>{title||"Midnite Sentinel"}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
    <style>{`
      *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
      body{background:${BG};color:${TEXT};font-family:${SANS};-webkit-font-smoothing:antialiased}
      input[type=date],input[type=month]{color-scheme:light}
      input[type=date]::-webkit-calendar-picker-indicator,input[type=month]::-webkit-calendar-picker-indicator{cursor:pointer;opacity:0.5}
      @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
      @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
      @keyframes flowdash{to{stroke-dashoffset:-16}}
      .flow-anim{animation:flowdash 0.8s linear infinite}
      .flow-rev{animation:flowdash 0.8s linear infinite reverse}
      .site-card{transition:box-shadow 0.2s,transform 0.2s}
      .site-card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.1)!important}
      .inv-card{transition:box-shadow 0.2s}
      .inv-card:hover{box-shadow:0 4px 20px rgba(0,0,0,0.1)!important}
      .fleet-row{transition:background 0.12s}
      .fleet-row:hover{background:#FAF7F2}
      .inv-scroll::-webkit-scrollbar{display:none}
      .inv-scroll{-ms-overflow-style:none;scrollbar-width:none}
      @keyframes nodeIn{from{opacity:0;transform:scale(.85)}to{opacity:1;transform:scale(1)}}
      .flow-node-opt{transform-box:fill-box;transform-origin:center;animation:nodeIn .35s ease-out}
    `}</style>
  </Head>
);

const authInput = {width:"100%",padding:"11px 14px",background:BG,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,fontSize:FS.body,fontFamily:SANS,boxSizing:"border-box"};
const lblS = {fontSize:FS.footnote,color:MUTED,fontWeight:600,display:"block",marginBottom:6};
const errBox = {background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:FS.subhead,color:GRID_IN};
const okBox = {background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:FS.subhead,color:BATTERY};
const authBtn = (disabled)=>({width:"100%",padding:"13px 0",borderRadius:10,border:"none",background:disabled?"#E5E7EB":"linear-gradient(135deg,#FCD34D,#D97706)",color:disabled?MUTED:"#7C2D12",fontSize:FS.body,fontWeight:700,fontFamily:SANS,cursor:disabled?"wait":"pointer",boxShadow:disabled?"none":"0 4px 16px rgba(217,119,6,0.3)"});
const GOOGLE_ON = process.env.NEXT_PUBLIC_GOOGLE_AUTH === "1" || process.env.NEXT_PUBLIC_GOOGLE_AUTH === "true";
const GoogleG = ()=>(<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/><path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"/><path fill="#EA4335" d="M24 9.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 2.97 29.93 1 24 1 15.4 1 7.96 5.93 4.34 14.12l7.35 5.7C13.42 13.62 18.27 9.75 24 9.75z"/></svg>);
function AuthShell({children, subtitle}){
  return (<><PageHead/><div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
    <div style={{width:"100%",maxWidth:380,animation:"fadeUp 0.4s ease"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <div style={{marginBottom:14,display:"inline-block"}}><Logo size={60}/></div>
        <div style={{fontSize:FS.title2,fontWeight:800,color:TEXT,letterSpacing:"-0.3px"}}>Midnite Sentinel</div>
        {subtitle&&<div style={{fontSize:FS.subhead,color:MUTED,marginTop:4}}>{subtitle}</div>}
      </div>
      {children}
    </div>
  </div></>);
}
function LandingPage(){
  const [mode,setMode]=useState("signup");
  const [email,setEmail]=useState(""); const [pw,setPw]=useState(""); const [tc,setTc]=useState(false);
  const [err,setErr]=useState(null); const [msg,setMsg]=useState(null); const [busy,setBusy]=useState(false);

  const submit=async(e)=>{
    e.preventDefault();
    if(mode==="signup"&&!tc){setErr("Please accept the Terms & Conditions to continue.");return;}
    if(!supabaseReady){setErr("Configuration error — contact support.");return;}
    setBusy(true);setErr(null);setMsg(null);
    try{
      const{data,error}=mode==="signup"
        ?await supabase.auth.signUp({email,password:pw})
        :await supabase.auth.signInWithPassword({email,password:pw});
      if(error)throw error;
      if(mode==="signup"&&!data.session)setMsg("Account created! Sign in to continue.");
    }catch(ex){setErr(ex.message||String(ex));}finally{setBusy(false);}
  };

  const google=async()=>{
    if(!supabaseReady)return;
    setErr(null);
    const{error}=await supabase.auth.signInWithOAuth({provider:"google",options:{redirectTo:typeof window!=="undefined"?window.location.origin:undefined}});
    if(error)setErr(error.message);
  };

  const scrollToAuth=(target)=>{
    if(target){setMode(target);setErr(null);setMsg(null);if(target!=="signup")setTc(false);}
    const el=document.getElementById("lp-auth");if(el)el.scrollIntoView({behavior:"smooth"});
  };

  const features=[
    {
      tag:"Live Data",title:"Real-Time Power Flow",
      desc:"Watch solar, battery, grid, and home load update every 5 seconds. Animated flow arrows show exactly where every watt is going — no guessing.",
      bullets:["Live 5-second refresh","EPS/AIO inverter support","Per-inverter breakdown"],
      mockup:(
        <svg viewBox="0 0 460 300" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",borderRadius:16,boxShadow:SHADOW}}>
          <rect width="460" height="300" rx="16" fill={BG}/>
          <rect width="460" height="36" rx="16" fill="#0D1F33"/><rect y="20" width="460" height="16" fill="#0D1F33"/>
          <circle cx="14" cy="18" r="5" fill="#FF6058"/><circle cx="30" cy="18" r="5" fill="#FFBD2E"/><circle cx="46" cy="18" r="5" fill="#28C840"/>
          <text x="230" y="22" textAnchor="middle" fill="white" fontSize="11" fontFamily="system-ui" opacity="0.7">Live Power Flow</text>
          <rect x="14" y="52" width="108" height="64" rx="10" fill={CARD} stroke={BORDER}/>
          {svgIcon("sun",68,71,22,SOLAR,2)}
          <text x="68" y="94" textAnchor="middle" fill={TEXT} fontSize="9" fontFamily="system-ui" fontWeight="600">Solar</text>
          <text x="68" y="108" textAnchor="middle" fill={SOLAR} fontSize="12" fontFamily="system-ui" fontWeight="700">8.3 kW</text>
          <rect x="338" y="52" width="108" height="64" rx="10" fill={CARD} stroke={BORDER}/>
          {svgIcon("pylon",392,72,20,GRID_OUT,1.8)}
          <text x="392" y="94" textAnchor="middle" fill={TEXT} fontSize="9" fontFamily="system-ui" fontWeight="600">Grid</text>
          <text x="392" y="108" textAnchor="middle" fill={GRID_OUT} fontSize="12" fontFamily="system-ui" fontWeight="700">{"↑ 3.1 kW"}</text>
          <rect x="163" y="116" width="134" height="76" rx="12" fill="#0D1F33"/>
          <text x="230" y="142" textAnchor="middle" fill="#F59E0B" fontSize="10" fontFamily="system-ui" fontWeight="700">MIDNITE AIO</text>
          <text x="230" y="157" textAnchor="middle" fill="rgba(255,255,255,0.6)" fontSize="8" fontFamily="system-ui">15kW Inverter</text>
          <rect x="178" y="165" width="104" height="14" rx="4" fill="rgba(255,255,255,0.1)"/>
          <rect x="180" y="167" width="82" height="10" rx="3" fill="#22C55E" opacity="0.8"/>
          <text x="230" y="177" textAnchor="middle" fill="white" fontSize="7" fontFamily="system-ui">SOC 82%</text>
          <rect x="14" y="220" width="108" height="64" rx="10" fill={CARD} stroke={BORDER}/>
          {svgIcon("battery",68,240,20,BATTERY,1.8)}
          <text x="68" y="262" textAnchor="middle" fill={TEXT} fontSize="9" fontFamily="system-ui" fontWeight="600">Battery</text>
          <text x="68" y="276" textAnchor="middle" fill={BATTERY} fontSize="12" fontFamily="system-ui" fontWeight="700">Idle · 82%</text>
          <rect x="338" y="220" width="108" height="64" rx="10" fill={CARD} stroke={BORDER}/>
          {svgIcon("home",392,240,20,LOAD_C,1.8)}
          <text x="392" y="262" textAnchor="middle" fill={TEXT} fontSize="9" fontFamily="system-ui" fontWeight="600">Home</text>
          <text x="392" y="276" textAnchor="middle" fill={LOAD_C} fontSize="12" fontFamily="system-ui" fontWeight="700">5.2 kW</text>
          <line x1="122" y1="84" x2="163" y2="140" stroke={SOLAR} strokeWidth="2" strokeDasharray="5,3" opacity="0.7"/>
          <line x1="297" y1="140" x2="338" y2="84" stroke={GRID_OUT} strokeWidth="2" strokeDasharray="5,3" opacity="0.7"/>
          <line x1="163" y1="168" x2="122" y2="252" stroke={BORDER} strokeWidth="1.5" opacity="0.6"/>
          <line x1="297" y1="168" x2="338" y2="252" stroke={LOAD_C} strokeWidth="2" strokeDasharray="5,3" opacity="0.7"/>
          <rect x="10" y="40" width="48" height="16" rx="8" fill="#22C55E"/>
          <circle cx="20" cy="48" r="3" fill="white"/>
          <text x="36" y="52" textAnchor="middle" fill="white" fontSize="8" fontFamily="system-ui" fontWeight="700">LIVE</text>
        </svg>
      ),
    },
    {
      tag:"Fleet",title:"Fleet Management",
      desc:"Manage a whole portfolio of sites from one dashboard. Spot offline systems instantly, see live PV output per site, and drill in with one click.",
      bullets:["Unlimited sites","Offline detection + alerts","CSV export for reporting"],
      mockup:(
        <svg viewBox="0 0 460 258" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",borderRadius:16,boxShadow:SHADOW}}>
          <rect width="460" height="258" rx="16" fill={BG}/>
          <rect width="460" height="36" rx="16" fill="#0D1F33"/><rect y="20" width="460" height="16" fill="#0D1F33"/>
          <circle cx="14" cy="18" r="5" fill="#FF6058"/><circle cx="30" cy="18" r="5" fill="#FFBD2E"/><circle cx="46" cy="18" r="5" fill="#28C840"/>
          <text x="230" y="22" textAnchor="middle" fill="white" fontSize="11" fontFamily="system-ui" opacity="0.7">Fleet View</text>
          <rect x="12" y="48" width="96" height="40" rx="8" fill={CARD} stroke={BORDER}/>
          <text x="60" y="63" textAnchor="middle" fill={MUTED} fontSize="8" fontFamily="system-ui">Sites Online</text>
          <text x="60" y="79" textAnchor="middle" fill={BATTERY} fontSize="14" fontFamily="system-ui" fontWeight="700">7 / 8</text>
          <rect x="116" y="48" width="96" height="40" rx="8" fill={CARD} stroke={BORDER}/>
          <text x="164" y="63" textAnchor="middle" fill={MUTED} fontSize="8" fontFamily="system-ui">Fleet PV Now</text>
          <text x="164" y="79" textAnchor="middle" fill={SOLAR} fontSize="14" fontFamily="system-ui" fontWeight="700">42.1 kW</text>
          <rect x="220" y="48" width="96" height="40" rx="8" fill={CARD} stroke={BORDER}/>
          <text x="268" y="63" textAnchor="middle" fill={MUTED} fontSize="8" fontFamily="system-ui">PV Today</text>
          <text x="268" y="79" textAnchor="middle" fill={CHART_PROD} fontSize="14" fontFamily="system-ui" fontWeight="700">187 kWh</text>
          <rect x="324" y="48" width="124" height="40" rx="8" fill="#FEF3C7" stroke="#FCD34D"/>
          <text x="386" y="63" textAnchor="middle" fill="#92400E" fontSize="8" fontFamily="system-ui">Need Attention</text>
          <text x="380" y="79" textAnchor="middle" fill="#D97706" fontSize="14" fontFamily="system-ui" fontWeight="700">1 site</text>{svgIcon("alert",412,74,13,"#D97706",2.2)}
          <rect x="12" y="100" width="436" height="20" rx="4" fill="#F1EDE8"/>
          <text x="52" y="114" fill={MUTED} fontSize="8" fontFamily="system-ui" fontWeight="600">SITE</text>
          <text x="148" y="114" fill={MUTED} fontSize="8" fontFamily="system-ui" fontWeight="600">STATUS</text>
          <text x="210" y="114" fill={MUTED} fontSize="8" fontFamily="system-ui" fontWeight="600">PV NOW</text>
          <text x="272" y="114" fill={MUTED} fontSize="8" fontFamily="system-ui" fontWeight="600">BATTERY</text>
          <text x="342" y="114" fill={MUTED} fontSize="8" fontFamily="system-ui" fontWeight="600">LOAD</text>
          <text x="410" y="114" fill={MUTED} fontSize="8" fontFamily="system-ui" fontWeight="600">UPDATED</text>
          <rect x="12" y="122" width="436" height="30" rx="4" fill={CARD}/>
          <text x="52" y="141" fill={TEXT} fontSize="9" fontFamily="system-ui" fontWeight="600">Maple Street Home</text>
          <rect x="148" y="130" width="42" height="14" rx="7" fill="#DCFCE7"/>
          <text x="169" y="141" textAnchor="middle" fill={BATTERY} fontSize="7" fontFamily="system-ui" fontWeight="700">Online</text>
          <text x="210" y="141" fill={SOLAR} fontSize="9" fontFamily="system-ui" fontWeight="600">8.3 kW</text>
          <text x="272" y="141" fill={BATTERY} fontSize="9" fontFamily="system-ui" fontWeight="600">{"82% ↑"}</text>
          <text x="342" y="141" fill={LOAD_C} fontSize="9" fontFamily="system-ui">5.2 kW</text>
          <text x="410" y="141" fill={MUTED} fontSize="8" fontFamily="system-ui">2m ago</text>
          <rect x="12" y="154" width="436" height="30" rx="4" fill={BG}/>
          <text x="52" y="173" fill={TEXT} fontSize="9" fontFamily="system-ui" fontWeight="600">Coastal Retreat</text>
          <rect x="148" y="162" width="42" height="14" rx="7" fill="#DCFCE7"/>
          <text x="169" y="173" textAnchor="middle" fill={BATTERY} fontSize="7" fontFamily="system-ui" fontWeight="700">Online</text>
          <text x="210" y="173" fill={SOLAR} fontSize="9" fontFamily="system-ui" fontWeight="600">6.8 kW</text>
          <text x="272" y="173" fill={BATTERY} fontSize="9" fontFamily="system-ui" fontWeight="600">{"68% →"}</text>
          <text x="342" y="173" fill={LOAD_C} fontSize="9" fontFamily="system-ui">4.1 kW</text>
          <text x="410" y="173" fill={MUTED} fontSize="8" fontFamily="system-ui">5m ago</text>
          <rect x="12" y="186" width="436" height="30" rx="4" fill="#FFF7F7"/>
          <text x="52" y="205" fill={TEXT} fontSize="9" fontFamily="system-ui" fontWeight="600">Riverside Cabin</text>
          <rect x="148" y="194" width="42" height="14" rx="7" fill="#FEE2E2"/>
          <text x="169" y="205" textAnchor="middle" fill={GRID_IN} fontSize="7" fontFamily="system-ui" fontWeight="700">Offline</text>
          <text x="210" y="205" fill={MUTED} fontSize="9" fontFamily="system-ui">—</text>
          <text x="272" y="205" fill={MUTED} fontSize="9" fontFamily="system-ui">—</text>
          <text x="342" y="205" fill={MUTED} fontSize="9" fontFamily="system-ui">—</text>
          <text x="410" y="205" fill={GRID_IN} fontSize="8" fontFamily="system-ui">47m ago</text>
          <text x="230" y="242" textAnchor="middle" fill={MUTED} fontSize="8" fontFamily="system-ui">+ 5 more sites</text>
        </svg>
      ),
    },
    {
      tag:"Alerts",title:"Smart Alerts",
      desc:"Set threshold alerts for battery SOC, temperature, grid import/export, or device offline events. Alerts fire by email with configurable cooldowns and daily caps.",
      bullets:["12+ trigger types","Per-device rules","Time-gated alerts (e.g. after 18:00)"],
      mockup:(
        <svg viewBox="0 0 460 258" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",borderRadius:16,boxShadow:SHADOW}}>
          <rect width="460" height="258" rx="16" fill={BG}/>
          <rect width="460" height="36" rx="16" fill="#0D1F33"/><rect y="20" width="460" height="16" fill="#0D1F33"/>
          <circle cx="14" cy="18" r="5" fill="#FF6058"/><circle cx="30" cy="18" r="5" fill="#FFBD2E"/><circle cx="46" cy="18" r="5" fill="#28C840"/>
          <text x="230" y="22" textAnchor="middle" fill="white" fontSize="11" fontFamily="system-ui" opacity="0.7">Notifications · Settings</text>
          <rect x="12" y="48" width="436" height="50" rx="10" fill={CARD} stroke={BORDER}/>
          <rect x="22" y="58" width="26" height="26" rx="8" fill="#FEF3C7"/>
          {svgIcon("battery",35,71,15,SOLAR,2)}
          <text x="58" y="68" fill={TEXT} fontSize="10" fontFamily="system-ui" fontWeight="700">Battery SOC below 20%</text>
          <text x="58" y="83" fill={MUTED} fontSize="8" fontFamily="system-ui">All inverters · Email · 60 min cooldown</text>
          <rect x="376" y="62" width="34" height="16" rx="8" fill={BATTERY} opacity="0.2"/>
          <rect x="382" y="66" width="20" height="8" rx="4" fill={BATTERY}/>
          <circle cx="402" cy="70" r="6" fill={BATTERY}/>
          <rect x="12" y="106" width="436" height="50" rx="10" fill={CARD} stroke={BORDER}/>
          <rect x="22" y="116" width="26" height="26" rx="8" fill="#FEE2E2"/>
          {svgIcon("bolt",35,129,15,GRID_IN,2)}
          <text x="58" y="126" fill={TEXT} fontSize="10" fontFamily="system-ui" fontWeight="700">Grid import above 2 kW</text>
          <text x="58" y="141" fill={MUTED} fontSize="8" fontFamily="system-ui">Maple Street Home · Email · 30 min cooldown</text>
          <rect x="376" y="120" width="34" height="16" rx="8" fill="#E5E7EB"/>
          <circle cx="388" cy="128" r="6" fill="#9CA3AF"/>
          <rect x="12" y="164" width="436" height="50" rx="10" fill={CARD} stroke={BORDER}/>
          <rect x="22" y="174" width="26" height="26" rx="8" fill="#EFF6FF"/>
          {svgIcon("activity",35,187,15,LOAD_C,2)}
          <text x="58" y="184" fill={TEXT} fontSize="10" fontFamily="system-ui" fontWeight="700">Device offline</text>
          <text x="58" y="199" fill={MUTED} fontSize="8" fontFamily="system-ui">All sites · Email · 120 min cooldown · After 08:00</text>
          <rect x="376" y="178" width="34" height="16" rx="8" fill={BATTERY} opacity="0.2"/>
          <rect x="382" y="182" width="20" height="8" rx="4" fill={BATTERY}/>
          <circle cx="402" cy="186" r="6" fill={BATTERY}/>
          <rect x="12" y="222" width="436" height="24" rx="8" fill="#F0FDF4" stroke="#BBF7D0"/>
          <text x="20" y="238" fill={BATTERY} fontSize="8" fontFamily="system-ui">Test alert sent — 3 of 50 daily emails used</text>
        </svg>
      ),
    },
    {
      tag:"Analytics",title:"Deep Analytics",
      desc:"Monthly and yearly production history, per-MPPT intraday breakdown, and an Explorer to chart any raw inverter parameter over up to 7 days at 5-minute resolution.",
      bullets:["Per-MPPT day charts","Explorer: 60+ metrics","Month ↔ Day consistency"],
      mockup:(
        <svg viewBox="0 0 460 258" fill="none" xmlns="http://www.w3.org/2000/svg" style={{width:"100%",borderRadius:16,boxShadow:SHADOW}}>
          <rect width="460" height="258" rx="16" fill={BG}/>
          <rect width="460" height="36" rx="16" fill="#0D1F33"/><rect y="20" width="460" height="16" fill="#0D1F33"/>
          <circle cx="14" cy="18" r="5" fill="#FF6058"/><circle cx="30" cy="18" r="5" fill="#FFBD2E"/><circle cx="46" cy="18" r="5" fill="#28C840"/>
          <text x="230" y="22" textAnchor="middle" fill="white" fontSize="11" fontFamily="system-ui" opacity="0.7">Month · June 2025</text>
          <rect x="12" y="48" width="100" height="38" rx="8" fill={CARD} stroke={BORDER}/>
          <text x="62" y="62" textAnchor="middle" fill={MUTED} fontSize="7" fontFamily="system-ui">Produced</text>
          <text x="62" y="78" textAnchor="middle" fill={CHART_PROD} fontSize="13" fontFamily="system-ui" fontWeight="700">412 kWh</text>
          <rect x="120" y="48" width="100" height="38" rx="8" fill={CARD} stroke={BORDER}/>
          <text x="170" y="62" textAnchor="middle" fill={MUTED} fontSize="7" fontFamily="system-ui">Consumed</text>
          <text x="170" y="78" textAnchor="middle" fill={CHART_CONS} fontSize="13" fontFamily="system-ui" fontWeight="700">298 kWh</text>
          <rect x="228" y="48" width="100" height="38" rx="8" fill={CARD} stroke={BORDER}/>
          <text x="278" y="62" textAnchor="middle" fill={MUTED} fontSize="7" fontFamily="system-ui">Exported</text>
          <text x="278" y="78" textAnchor="middle" fill={GRID_OUT} fontSize="13" fontFamily="system-ui" fontWeight="700">114 kWh</text>
          <rect x="336" y="48" width="112" height="38" rx="8" fill={CARD} stroke={BORDER}/>
          <text x="392" y="62" textAnchor="middle" fill={MUTED} fontSize="7" fontFamily="system-ui">Self-sufficient</text>
          <text x="392" y="78" textAnchor="middle" fill={BATTERY} fontSize="13" fontFamily="system-ui" fontWeight="700">94%</text>
          <rect x="12" y="96" width="436" height="148" rx="10" fill={CARD} stroke={BORDER}/>
          {[0,1,2].map(i=><line key={i} x1="38" y1={130+i*36} x2="440" y2={130+i*36} stroke={BORDER} strokeWidth="0.5"/>)}
          {[18,20,22,15,25,28,24,22,20,18,26,24,22,20,28,30,27,25,22,20,24,26,22,19,24,22,25,23,21,28].map((h,i)=>{
            const x=40+i*13;
            return <g key={i}><rect x={x} y={202-h*2.8} width={6} height={h*2.8} fill={CHART_PROD} opacity="0.85" rx="1"/><rect x={x} y={202} width={6} height={h*2.2} fill={CHART_CONS} opacity="0.8" rx="1"/></g>;
          })}
          <rect x="280" y="228" width="8" height="8" rx="1" fill={CHART_PROD} opacity="0.85"/>
          <text x="293" y="236" fill={MUTED} fontSize="8" fontFamily="system-ui">Produced</text>
          <rect x="346" y="228" width="8" height="8" rx="1" fill={CHART_CONS} opacity="0.8"/>
          <text x="359" y="236" fill={MUTED} fontSize="8" fontFamily="system-ui">Consumed</text>
        </svg>
      ),
    },
  ];

  const steps=[
    {n:"1",title:"Create your account",body:"Sign up with email — no credit card needed. Your account is free during pre-launch."},
    {n:"2",title:"Link your Midnite inverter",body:"Enter your Midnite portal credentials once. They're encrypted with AES-256-GCM and stored securely — never visible again."},
    {n:"3",title:"Monitor everything",body:"Your dashboard populates instantly. Live data, charts, alerts, and fleet view are all ready."},
  ];

  const freeFt=["Live power flow (5-sec refresh)","Day / Month / Year charts","Per-MPPT intraday breakdown","Battery + temperature monitoring","Email alerts (50/day)","1 Midnite account linked"];
  const proFt=["Everything in Free","Fleet view (multi-site)","Site sharing (view-only)","Explorer — 60+ metrics, 7-day range","Multiple linked accounts","CSV export","Priority support"];

  const contactEmail=()=>['jason+midnite','floridasolardesigngroup.com'].join('@');

  return (<>
    <PageHead title="Midnite Sentinel — Solar Monitoring Platform"/>
    <style>{`
      *{box-sizing:border-box;}
      .lp-hero{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center;}
      .lp-feat{display:grid;grid-template-columns:1fr 1fr;gap:48px;align-items:center;}
      .lp-feat.rev{direction:rtl;}
      .lp-feat.rev>*{direction:ltr;}
      .lp-price{display:grid;grid-template-columns:1fr 1fr;gap:24px;max-width:800px;margin:0 auto;}
      .lp-steps{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;}
      @media(max-width:768px){
        .lp-hero,.lp-feat,.lp-price,.lp-steps{grid-template-columns:1fr;}
        .lp-feat.rev{direction:ltr;}
      }
      .lp-pbtn{background:linear-gradient(135deg,#FCD34D,#D97706);color:#7C2D12;border:none;border-radius:10px;padding:13px 28px;font-size:15px;font-weight:700;font-family:${SANS};cursor:pointer;box-shadow:0 4px 16px rgba(217,119,6,0.3);transition:opacity .15s;}
      .lp-pbtn:hover{opacity:.9;}
      .lp-pbtn:disabled{background:#E5E7EB;color:${MUTED};box-shadow:none;cursor:default;opacity:1;}
      .lp-pbtn:active:not(:disabled),.lp-obtn:active{transform:scale(.97);}
      .lp-obtn{background:transparent;color:${SOLAR_TEXT};border:2px solid ${SOLAR};border-radius:10px;padding:11px 24px;font-size:14px;font-weight:700;font-family:${SANS};cursor:pointer;transition:all .15s;}
      .lp-obtn:hover{background:${SOLAR_TEXT};border-color:${SOLAR_TEXT};color:white;}
      .lp-chk::before{content:"";display:inline-block;width:1em;height:1em;margin-right:8px;vertical-align:-0.15em;background:${BATTERY};-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6L9 17l-5-5'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6L9 17l-5-5'/%3E%3C/svg%3E") center/contain no-repeat;}
      .lp-flink{color:rgba(255,255,255,0.6);text-decoration:none;font-weight:500;}
      .lp-flink:hover{color:white;}
      .lp-nav-link{font-size:14px;font-weight:600;color:${MUTED};text-decoration:none;}
      .lp-nav-link:hover{color:${TEXT};}
    `}</style>

    {/* NAV */}
    <nav style={{position:"sticky",top:0,zIndex:100,background:"rgba(247,244,239,0.92)",backdropFilter:"blur(12px)",borderBottom:`1px solid ${BORDER}`,padding:"0 24px"}}>
      <div style={{maxWidth:1100,margin:"0 auto",height:60,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
        <a href="/" style={{display:"flex",alignItems:"center",gap:10,textDecoration:"none"}}>
          <Logo size={32}/>
          <span style={{fontWeight:800,fontSize:FS.callout,color:TEXT,letterSpacing:"-0.5px",whiteSpace:"nowrap"}}>Midnite Sentinel</span>
        </a>
        <div style={{display:"flex",alignItems:"center",gap:16}}>
          <a href="/faq" className="lp-nav-link hide-phone">FAQ</a>
          <a href="/terms" className="lp-nav-link hide-phone">Terms</a>
          <button className="lp-obtn" style={{padding:"7px 18px",fontSize:FS.subhead,whiteSpace:"nowrap"}} onClick={()=>scrollToAuth("signin")}>Sign in</button>
          <button className="lp-pbtn hide-phone" style={{padding:"9px 20px",fontSize:FS.subhead,whiteSpace:"nowrap"}} onClick={()=>scrollToAuth("signup")}>Sign up</button>
        </div>
      </div>
    </nav>

    {/* HERO */}
    <section style={{background:`linear-gradient(160deg,#FFFBF0 0%,${BG} 60%)`,padding:"72px 24px 80px"}}>
      <div style={{maxWidth:1100,margin:"0 auto"}} className="lp-hero">
        <div>
          <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#FEF3C7",border:"1px solid #FCD34D",borderRadius:20,padding:"4px 12px",fontSize:FS.footnote,fontWeight:700,color:"#92400E",marginBottom:20}}>
            <Icon name="sparkle"/>Pre-launch — all features free
          </div>
          <h1 style={{fontSize:"clamp(32px,5vw,52px)",fontWeight:800,lineHeight:1.15,letterSpacing:"-1.5px",color:TEXT,marginBottom:20}}>
            Monitor Your Solar<br/><span style={{color:SOLAR}}>In Real Time</span>
          </h1>
          <p style={{fontSize:FS.headline,lineHeight:1.7,color:MUTED,marginBottom:32,maxWidth:480}}>
            Midnite Sentinel gives solar owners and installers a live window into every watt — power flow, battery state, grid interaction, and fleet health — all in one clean dashboard.
          </p>
          <div style={{display:"flex",flexWrap:"wrap",gap:16}}>
            {["Live 5-sec updates","Email alerts","Fleet management","Site sharing"].map(f=>(
              <span key={f} style={{fontSize:FS.subhead,color:MUTED,display:"flex",alignItems:"center",gap:6}}>
                <span style={{color:BATTERY,fontWeight:700}}><Icon name="check"/></span>{f}
              </span>
            ))}
          </div>
        </div>
        <div id="lp-auth">
          <div style={{background:CARD,borderRadius:20,padding:28,boxShadow:SHADOW,border:`1px solid ${BORDER}`}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{fontWeight:800,fontSize:FS.headline,color:TEXT,marginBottom:4}}>{mode==="signup"?"Start monitoring free":"Welcome back"}</div>
              <div style={{fontSize:FS.subhead,color:MUTED}}>{mode==="signup"?"No credit card required.":"Sign in to your portal."}</div>
            </div>
            {err&&<div role="alert" style={errBox}>{err}</div>}
            {msg&&<div style={okBox}>{msg}</div>}
            {GOOGLE_ON&&<>
              <button onClick={google} style={{width:"100%",padding:"11px 0",borderRadius:10,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:FS.body,fontWeight:600,fontFamily:SANS,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:14}}><GoogleG/> Continue with Google</button>
              <div style={{display:"flex",alignItems:"center",gap:10,margin:"0 0 14px",color:MUTED,fontSize:FS.footnote}}>
                <div style={{flex:1,height:1,background:BORDER}}/>or<div style={{flex:1,height:1,background:BORDER}}/>
              </div>
            </>}
            <form onSubmit={submit}>
              <div style={{marginBottom:12}}><label style={lblS}>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" style={authInput}/></div>
              <div style={{marginBottom:14}}><label style={lblS}>Password</label><input type="password" value={pw} onChange={e=>setPw(e.target.value)} autoComplete={mode==="signup"?"new-password":"current-password"} placeholder={mode==="signup"?"Choose a password":"Your password"} style={authInput}/></div>
              {mode==="signup"&&(
                <label style={{display:"flex",alignItems:"flex-start",gap:8,cursor:"pointer",fontSize:FS.footnote,color:MUTED,marginBottom:16,lineHeight:1.5}}>
                  <input type="checkbox" checked={tc} onChange={e=>setTc(e.target.checked)} style={{marginTop:2,accentColor:SOLAR,cursor:"pointer",flexShrink:0}}/>
                  <span>I agree to the <a href="/terms" target="_blank" style={{color:SOLAR,fontWeight:600}}>Terms &amp; Conditions</a>. During pre-launch, all features are free — pricing TBD.</span>
                </label>
              )}
              <button type="submit" disabled={busy||!email||!pw||(mode==="signup"&&!tc)} className="lp-pbtn" style={{width:"100%"}}>
                {busy?"Please wait…":mode==="signup"?"Create free account":"Sign in"}
              </button>
            </form>
            <div style={{textAlign:"center",marginTop:14,fontSize:FS.subhead,color:MUTED}}>
              {mode==="signup"?"Already have an account? ":"New here? "}
              <button onClick={()=>{setMode(mode==="signup"?"signin":"signup");setErr(null);setMsg(null);setTc(false);}} style={{border:"none",background:"none",color:SOLAR,fontWeight:700,cursor:"pointer",fontFamily:SANS,fontSize:FS.subhead}}>
                {mode==="signup"?"Sign in":"Create free account"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    {/* FEATURES */}
    <section style={{padding:"80px 24px",background:BG}}>
      <div style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:64}}>
          <h2 style={{fontSize:"clamp(26px,4vw,40px)",fontWeight:800,letterSpacing:"-1px",color:TEXT,marginBottom:12}}>Everything your system needs</h2>
          <p style={{fontSize:FS.callout,color:MUTED,maxWidth:540,margin:"0 auto"}}>Built for Midnite solar systems — from a single home installation to a full installer fleet.</p>
        </div>
        {features.map((f,i)=>(
          <div key={i} className={`lp-feat${i%2===1?" rev":""}`} style={{marginBottom:i<features.length-1?80:0}}>
            <div>
              <div style={{display:"inline-block",background:"#FEF3C7",borderRadius:8,padding:"3px 10px",fontSize:FS.caption,fontWeight:700,color:"#92400E",marginBottom:14}}>{f.tag}</div>
              <h3 style={{fontSize:"clamp(22px,3vw,32px)",fontWeight:800,letterSpacing:"-0.5px",color:TEXT,marginBottom:14}}>{f.title}</h3>
              <p style={{fontSize:FS.callout,lineHeight:1.7,color:MUTED,marginBottom:20}}>{f.desc}</p>
              <ul style={{listStyle:"none",display:"flex",flexDirection:"column",gap:8,padding:0}}>
                {f.bullets.map(b=><li key={b} className="lp-chk" style={{fontSize:FS.body,color:TEXT}}>{b}</li>)}
              </ul>
            </div>
            <div>{f.mockup}</div>
          </div>
        ))}
      </div>
    </section>

    {/* HOW IT WORKS */}
    <section style={{padding:"80px 24px",background:CARD,borderTop:`1px solid ${BORDER}`,borderBottom:`1px solid ${BORDER}`}}>
      <div style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:48}}>
          <h2 style={{fontSize:"clamp(26px,4vw,40px)",fontWeight:800,letterSpacing:"-1px",color:TEXT,marginBottom:12}}>Up and running in minutes</h2>
        </div>
        <div className="lp-steps">
          {steps.map((s,i)=>(
            <div key={i} style={{background:BG,borderRadius:16,padding:28,border:`1px solid ${BORDER}`}}>
              <div style={{width:40,height:40,borderRadius:12,background:"linear-gradient(135deg,#FCD34D,#D97706)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:FS.title3,color:"#7C2D12",marginBottom:16}}>{s.n}</div>
              <h4 style={{fontWeight:700,fontSize:FS.callout,color:TEXT,marginBottom:8}}>{s.title}</h4>
              <p style={{fontSize:FS.body,color:MUTED,lineHeight:1.6}}>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>

    {/* PRICING */}
    <section style={{padding:"80px 24px",background:BG}}>
      <div style={{maxWidth:1100,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <h2 style={{fontSize:"clamp(26px,4vw,40px)",fontWeight:800,letterSpacing:"-1px",color:TEXT,marginBottom:16}}>Simple pricing</h2>
          <div style={{display:"inline-flex",alignItems:"center",gap:8,background:"#FEF3C7",border:"1px solid #FCD34D",borderRadius:20,padding:"6px 16px",fontSize:FS.subhead,fontWeight:700,color:"#92400E"}}>
            <Icon name="sparkle"/>Pre-launch: Pro features free for all users — pricing TBD
          </div>
        </div>
        <div className="lp-price">
          <div style={{background:CARD,borderRadius:20,padding:32,border:`1px solid ${BORDER}`,boxShadow:SHADOW_SM}}>
            <div style={{fontWeight:700,fontSize:FS.caption,color:MUTED,letterSpacing:1,marginBottom:8}}>Free</div>
            <div style={{fontSize:36,fontWeight:800,color:TEXT,marginBottom:4}}>$0<span style={{fontSize:FS.body,fontWeight:500,color:MUTED}}>/mo</span></div>
            <div style={{fontSize:FS.subhead,color:MUTED,marginBottom:24}}>Forever free for individual owners</div>
            <ul style={{listStyle:"none",display:"flex",flexDirection:"column",gap:10,marginBottom:28,padding:0}}>
              {freeFt.map(f=><li key={f} className="lp-chk" style={{fontSize:FS.subhead,color:TEXT}}>{f}</li>)}
            </ul>
            <button className="lp-obtn" style={{width:"100%"}} onClick={()=>scrollToAuth("signup")}>Get started free</button>
          </div>
          <div style={{background:"#0D1F33",borderRadius:20,padding:32,border:"2px solid #F59E0B",boxShadow:"0 8px 32px rgba(217,119,6,0.2)",position:"relative"}}>
            <div style={{position:"absolute",top:16,right:16,background:"#F59E0B",borderRadius:12,padding:"3px 10px",fontSize:FS.caption,fontWeight:700,color:"#7C2D12"}}>Pre-launch: FREE</div>
            <div style={{fontWeight:700,fontSize:FS.caption,color:"#F59E0B",letterSpacing:1,marginBottom:8}}>Pro</div>
            <div style={{fontSize:36,fontWeight:800,color:"white",marginBottom:4}}>TBD<span style={{fontSize:FS.body,fontWeight:500,color:"rgba(255,255,255,0.5)"}}>/mo</span></div>
            <div style={{fontSize:FS.subhead,color:"rgba(255,255,255,0.5)",marginBottom:24}}>For installers managing a fleet</div>
            <ul style={{listStyle:"none",display:"flex",flexDirection:"column",gap:10,marginBottom:28,padding:0}}>
              {proFt.map(f=><li key={f} style={{fontSize:FS.subhead,color:"rgba(255,255,255,0.85)",display:"flex",alignItems:"center",gap:8}}><span style={{color:"#F59E0B",fontWeight:700}}><Icon name="check"/></span>{f}</li>)}
            </ul>
            <button className="lp-pbtn" style={{width:"100%"}} onClick={()=>scrollToAuth("signup")}>Start free during pre-launch</button>
          </div>
        </div>
      </div>
    </section>

    {/* FAQ CTA */}
    <section style={{padding:"60px 24px",background:CARD,borderTop:`1px solid ${BORDER}`}}>
      <div style={{maxWidth:700,margin:"0 auto",textAlign:"center"}}>
        <h2 style={{fontSize:"clamp(22px,3vw,32px)",fontWeight:800,color:TEXT,marginBottom:12}}>Questions?</h2>
        <p style={{fontSize:FS.callout,color:MUTED,marginBottom:28,lineHeight:1.6}}>Our FAQ covers everything from getting started to advanced fleet features. Or email us directly.</p>
        <div style={{display:"flex",justifyContent:"center",gap:16,flexWrap:"wrap"}}>
          <a href="/faq" style={{textDecoration:"none"}}><button className="lp-pbtn">Read the FAQ</button></a>
          <a href={"mailto:"+contactEmail()} style={{textDecoration:"none"}}><button className="lp-obtn">Email us</button></a>
        </div>
      </div>
    </section>

    {/* FOOTER */}
    <footer style={{background:"#0D1F33",padding:"40px 24px",color:"rgba(255,255,255,0.5)",fontSize:FS.subhead,fontFamily:SANS}}>
      <div style={{maxWidth:1100,margin:"0 auto",display:"flex",flexWrap:"wrap",gap:24,justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <Logo size={28}/>
          <div>
            <div style={{fontWeight:700,color:"white",fontSize:FS.body}}>Midnite Sentinel</div>
            <div style={{fontSize:FS.caption}}>{`© ${new Date().getFullYear()} Second Stream LLC. All rights reserved.`}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:24,flexWrap:"wrap"}}>
          <a href="/faq" className="lp-flink">FAQ</a>
          <a href="/terms" className="lp-flink">Terms &amp; Conditions</a>
          <a href={"mailto:"+contactEmail()} className="lp-flink">Contact</a>
        </div>
      </div>
    </footer>
  </>);
}
// Password reset — shown when user arrives via a reset-password email link.
function ResetPasswordPage({onDone}){
  const [pw,setPw]=useState(""); const [pw2,setPw2]=useState("");
  const [busy,setBusy]=useState(false); const [err,setErr]=useState(null); const [done,setDone]=useState(false);
  const inputS={width:"100%",padding:"10px 12px",borderRadius:10,border:`1px solid ${BORDER}`,fontSize:FS.body,fontFamily:SANS,color:TEXT,background:CARD,boxSizing:"border-box"};
  const submit=async(e)=>{
    e.preventDefault(); setErr(null);
    if(pw.length<6){setErr("Password must be at least 6 characters");return;}
    if(pw!==pw2){setErr("Passwords don't match");return;}
    setBusy(true);
    const {error}=await supabase.auth.updateUser({password:pw});
    setBusy(false);
    if(error){setErr(error.message);return;}
    setDone(true);
    setTimeout(onDone,1500);
  };
  return (
    <div style={{minHeight:"100vh",background:BG,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24,fontFamily:SANS}}>
      <PageHead title="Set new password — Midnite Sentinel"/>
      <Logo size={44} style={{marginBottom:20}}/>
      <div style={{fontSize:FS.title2,fontWeight:700,color:TEXT,marginBottom:4}}>Set new password</div>
      <div style={{fontSize:FS.subhead,color:MUTED,marginBottom:28,textAlign:"center"}}>Enter a new password for your Midnite Sentinel account.</div>
      <div style={{width:"100%",maxWidth:360}}>
        {done
          ? <div style={{background:"#D1FAE5",border:"1px solid #6EE7B7",borderRadius:12,padding:"14px 20px",color:BATTERY,fontWeight:600,fontSize:FS.body,textAlign:"center"}}><Icon name="check"/>Password updated — signing you in…</div>
          : <form onSubmit={submit} style={{display:"flex",flexDirection:"column",gap:12}}>
              <input type="password" placeholder="New password" value={pw} onChange={e=>setPw(e.target.value)} autoFocus required minLength={6} style={inputS}/>
              <input type="password" placeholder="Confirm new password" value={pw2} onChange={e=>setPw2(e.target.value)} required style={inputS}/>
              {err&&<div style={{color:GRID_IN,fontSize:FS.footnote}}>{err}</div>}
              <button type="submit" disabled={busy} style={{padding:"11px",minHeight:44,borderRadius:10,border:"none",background:SOLAR_TEXT,color:"#fff",fontSize:FS.body,fontWeight:700,fontFamily:SANS,cursor:busy?"default":"pointer",marginTop:4}}>
                {busy?"Updating…":"Update password"}
              </button>
            </form>
        }
      </div>
    </div>
  );
}
// First-run: connect a Midnite account to the signed-in app account.
function LinkMidnite({email,onLinked,onSignOut,initErr=null}){
  const [u,setU]=useState(""); const [p,setP]=useState(""); const [err,setErr]=useState(initErr); const [busy,setBusy]=useState(false);
  const submit=async(e)=>{ e.preventDefault(); setBusy(true); setErr(null);
    try{ const r=await api("linkaccount",{username:u,password:p}); onLinked(r.account); }
    catch(e){ setErr(e.message); setBusy(false); }
  };
  return (
    <AuthShell subtitle="Link your Midnite account">
      <div style={{background:CARD,borderRadius:20,padding:28,boxShadow:SHADOW}}>
        <div style={{fontSize:FS.subhead,color:MUTED,lineHeight:1.6,marginBottom:18}}>Signed in as <b style={{color:TEXT}}>{email}</b>. Connect your Midnite login to pull in your system’s data — your credentials are encrypted and never shown again.</div>
        {err&&<div role="alert" style={errBox}>{err}</div>}
        <form onSubmit={submit}>
          <div style={{marginBottom:14}}><label style={lblS} htmlFor="lm-user">Midnite username</label><input id="lm-user" value={u} onChange={e=>setU(e.target.value)} autoFocus autoComplete="username" autoCapitalize="none" style={authInput}/></div>
          <div style={{marginBottom:20}}><label style={lblS} htmlFor="lm-pw">Midnite password</label><input id="lm-pw" type="password" value={p} onChange={e=>setP(e.target.value)} autoComplete="current-password" style={authInput}/></div>
          <button type="submit" disabled={busy||!u||!p} style={authBtn(busy||!u||!p)}>{busy?"Linking…":"Link account"}</button>
        </form>
        <div style={{textAlign:"center",marginTop:12}}><Button variant="plain" icon="logout" onClick={onSignOut}>Sign out</Button></div>
      </div>
    </AuthShell>
  );
}
// Account settings modal: relink (users) / manage multiple Midnite accounts + active switch (admins).
async function uploadMedia(bucket, path, file){
  const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert:true, cacheControl:"3600" });
  if(error) throw error;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
// Settings → Notifications: per-device alert rules. The add-form is generated
// entirely from the shared trigger metadata (lib/notifications/triggers.js), so
// the UI and the DB CHECK can't drift. Rules save + evaluate even before an email
// provider is configured; a banner flags that until RESEND_API_KEY is set.
// Daily-digest config card (Settings → Notifications). A morning recap email of
// yesterday's performance with charts; sent by the hourly cron at the chosen time.
const DIGEST_TZS = [
  ["America/New_York","Eastern"],["America/Chicago","Central"],["America/Denver","Mountain"],
  ["America/Phoenix","Arizona"],["America/Los_Angeles","Pacific"],["America/Anchorage","Alaska"],["Pacific/Honolulu","Hawaii"],
];
function hourLabel12(h){ const ap=h<12?"AM":"PM"; const hr=h%12===0?12:h%12; return `${hr}:00 ${ap}`; }
function DigestSettings({activeId, site=null}){
  const [cfg,setCfg]=useState(null);
  const [loading,setLoading]=useState(true);
  const [enabled,setEnabled]=useState(false);
  const [hour,setHour]=useState(7);
  const [tz,setTz]=useState("America/New_York");
  const [scope,setScope]=useState("all");          // "all" | "site"
  const [emailOk,setEmailOk]=useState(true);
  const [busy,setBusy]=useState(false); const [testing,setTesting]=useState(false);
  const [err,setErr]=useState(null); const [msg,setMsg]=useState(null);

  useEffect(()=>{(async()=>{
    setLoading(true);
    try{
      const d=await api("digest_get");
      setEmailOk(d.emailConfigured!==false);
      if(d.digest){
        setCfg(d.digest); setEnabled(!!d.digest.enabled);
        setHour(Number.isFinite(d.digest.send_hour)?d.digest.send_hour:7);
        setTz(d.digest.timezone||"America/New_York");
        setScope(d.digest.site_name?"site":"all");
      }else{
        // First run — preselect the browser's timezone if we recognize it.
        try{ const bz=Intl.DateTimeFormat().resolvedOptions().timeZone; if(DIGEST_TZS.some(([z])=>z===bz)) setTz(bz); }catch{}
      }
    }catch(e){ setErr(e.message); } finally{ setLoading(false); }
  })();},[]);

  const save=async(nextEnabled)=>{
    setErr(null); setMsg(null); setBusy(true);
    const willEnable = nextEnabled===undefined ? enabled : nextEnabled;
    try{
      await api("digest_save",{ account_id:activeId, enabled:willEnable, send_hour:hour, timezone:tz,
        site_name: scope==="site" ? (site?.name||null) : null });
      setEnabled(willEnable);
      setMsg(willEnable?"Daily digest saved.":"Daily digest turned off.");
    }catch(e){ setErr(e.message); } finally{ setBusy(false); }
  };
  const sendTest=async()=>{
    setErr(null); setMsg(null); setTesting(true);
    try{ const r=await api("digest_test",{ account_id:activeId, timezone:tz, site_name: scope==="site"?(site?.name||null):null });
      setMsg(r.empty?`Test sent to ${r.to} — no data for yesterday yet, but delivery works.`:`Test digest sent to ${r.to}.`);
    }catch(e){ setErr(e.message); } finally{ setTesting(false); }
  };

  const selS={...authInput,padding:"9px 12px",fontSize:FS.subhead,cursor:"pointer",width:"auto"};
  if(loading) return <div style={{fontSize:FS.subhead,color:MUTED,padding:"4px 0 14px"}}>Loading digest…</div>;
  return (
    <div style={{border:`1px solid ${BORDER}`,borderRadius:12,padding:"14px 16px",marginBottom:18,background:"#FFFDF8"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10,marginBottom:10}}>
        <div>
          <div style={{fontSize:FS.body,fontWeight:800,color:TEXT,display:"flex",alignItems:"center",gap:7}}><Icon name="sun"/>Daily digest</div>
          <div style={{fontSize:FS.footnote,color:MUTED,marginTop:3,lineHeight:1.5,maxWidth:380}}>A morning recap email of yesterday’s production, consumption, battery, and a 7-day trend — with charts.</div>
        </div>
        <Switch checked={enabled} disabled={busy} label="Daily digest" onChange={(v)=>save(v)}/>
      </div>
      {err&&<div role="alert" style={errBox}>{err}</div>}
      {msg&&<div style={okBox}>{msg}</div>}
      {!emailOk &&
        <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:"8px 12px",marginBottom:10,fontSize:FS.caption,color:"#92400E"}}>
          Email delivery isn’t configured yet (<code style={{fontFamily:"monospace"}}>RESEND_API_KEY</code>). You can still save settings — they’ll send once it’s set.
        </div>}
      <div style={{display:"flex",flexWrap:"wrap",gap:14,alignItems:"flex-end"}}>
        <div>
          <label style={lblS}>Send at</label>
          <select value={hour} onChange={e=>setHour(Number(e.target.value))} style={selS}>
            {Array.from({length:24},(_,h)=><option key={h} value={h}>{hourLabel12(h)}</option>)}
          </select>
        </div>
        <div>
          <label style={lblS}>Timezone</label>
          <select value={tz} onChange={e=>setTz(e.target.value)} style={selS}>
            {DIGEST_TZS.map(([z,lbl])=><option key={z} value={z}>{lbl}</option>)}
          </select>
        </div>
        {site && (
          <div>
            <label style={lblS}>Coverage</label>
            <select value={scope} onChange={e=>setScope(e.target.value)} style={selS}>
              <option value="all">All sites</option>
              <option value="site">{site.name}</option>
            </select>
          </div>
        )}
      </div>
      <div style={{display:"flex",gap:10,marginTop:14,flexWrap:"wrap"}}>
        <button onClick={()=>save()} disabled={busy} style={{padding:"8px 16px",borderRadius:9,border:"none",background:"linear-gradient(135deg,#FCD34D,#D97706)",color:"#7C2D12",fontSize:FS.subhead,fontWeight:700,fontFamily:SANS,cursor:busy?"wait":"pointer"}}>{busy?"Saving…":"Save"}</button>
        <button onClick={sendTest} disabled={testing||!emailOk} style={{padding:"8px 16px",borderRadius:9,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:FS.subhead,fontWeight:600,fontFamily:SANS,cursor:testing?"wait":"pointer"}}>{testing?"Sending…":"Send test digest"}</button>
      </div>
      {enabled && <div style={{fontSize:FS.caption,color:MUTED,marginTop:10}}>Next digest ~{hourLabel12(hour)} {DIGEST_TZS.find(([z])=>z===tz)?.[1]||tz}{cfg?.last_sent_at?` · last sent ${new Date(cfg.last_sent_at).toLocaleDateString()}`:""}</div>}
    </div>
  );
}
function NotificationsSettings({activeId, site=null}){
  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [err,setErr]=useState(null); const [msg,setMsg]=useState(null);
  const [addingFor,setAddingFor]=useState(null);   // device sn currently showing the add-form
  const [testing,setTesting]=useState(null);
  const load=useCallback(async()=>{ setLoading(true); try{ const d=await api("alertrules"); setData(d); }catch(e){ setErr(e.message); } finally{ setLoading(false); } },[]);
  useEffect(()=>{ load(); },[load]);

  // Only the currently selected system's inverters (not every site in the account).
  const devices = (site?.inverters||[]).map(inv=>({ siteName:site.name, sn:inv.sn, label:inv.label||inv.sn }));
  const rulesFor = (sn)=> (data?.rules||[]).filter(r=>r.device_id===sn);

  const saveRule = async (dev, form)=>{
    setErr(null); setMsg(null);
    try{
      await api("alertrule_save",{ account_id:activeId, site_name:dev.siteName, device_id:dev.sn, device_label:dev.label,
        trigger_type:form.trigger_type, threshold_value:Number(form.threshold),
        cooldown_minutes:Number(form.cooldown), trigger_after_time:form.afterTime||null, enabled:true });
      setAddingFor(null); toast("Alert added"); await load();
    }catch(e){ setErr(e.message); }
  };
  const toggleRule = async (rule)=>{ setErr(null); try{ await api("alertrule_save",{ ...rule, enabled:!rule.enabled }); await load(); }catch(e){ setErr(e.message); } };
  const delRule = async (id)=>{ if(!await confirmAlert("Delete this alert?", {message:"You’ll stop getting emails for it.", action:"Delete", destructive:true})) return; try{ await api("alertrule_delete",{id}); toast("Alert deleted"); await load(); }catch(e){ setErr(e.message); } };
  const sendTest = async (dev)=>{ setErr(null); setMsg(null); setTesting(dev.sn); try{ const r=await api("alerttest",{ site_name:dev.siteName, device_label:dev.label, device_id:dev.sn }); toast(r?.to?`Test email sent to ${r.to}`:"Test email sent", {icon:"mail"}); }catch(e){ setErr(e.message); } finally{ setTesting(null); } };

  if(loading) return <div><div className="ui-skel" style={{height:120,borderRadius:14,marginBottom:12}}/><div className="ui-skel" style={{height:160,borderRadius:14}}/></div>;
  return (
    <>
      <DigestSettings activeId={activeId} site={site}/>
      <h3 style={{fontSize:FS.headline,fontWeight:800,color:TEXT,margin:"8px 0 10px",display:"flex",alignItems:"center",gap:8}}><Icon name="bell" style={{color:SOLAR}}/>Threshold alerts</h3>
      {err&&<div role="alert" style={errBox}>{err}</div>}
      {msg&&<div style={okBox}>{msg}</div>}
      {data && !data.emailConfigured &&
        <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:FS.footnote,color:"#92400E"}}>
          Email delivery isn’t configured yet. Rules still save and evaluate every cycle — they just can’t send until <code style={{fontFamily:"monospace"}}>RESEND_API_KEY</code> is set in the environment.
        </div>}
      {data &&
        <div style={{fontSize:FS.caption,color:MUTED,marginBottom:12}}>
          Alerts for <strong style={{color:MUTED}}>{site?.name||"this system"}</strong> go to your account email. Today: <strong style={{color:MUTED}}>{data.dailyUsed}</strong> / {data.dailyCap} sent.
        </div>}
      {!site && <div style={{fontSize:FS.subhead,color:MUTED}}>Select a system to manage its alerts.</div>}
      {site && devices.length===0 && <div style={{fontSize:FS.subhead,color:MUTED}}>No devices on this system.</div>}
      {devices.map(dev=>(
        <div key={dev.sn} className="ui-group" style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,padding:"10px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
              <span style={{color:MUTED,fontSize:20,display:"inline-flex"}}><Icon name="inverter"/></span>
              <div style={{minWidth:0}}>
                <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>{dev.label}</div>
                <div style={{fontSize:FS.footnote,color:MUTED,fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{dev.sn}</div>
              </div>
            </div>
            <Button size="sm" variant="plain" icon="mail" onClick={()=>sendTest(dev)} disabled={testing===dev.sn}>{testing===dev.sn?"Sending…":"Send test"}</Button>
          </div>
          {rulesFor(dev.sn).length===0 && addingFor!==dev.sn && <div className="ui-row" style={{fontSize:FS.subhead,color:MUTED}}>No alerts on this inverter yet.</div>}
          {rulesFor(dev.sn).map(rule=>{
            const t=getTrigger(rule.trigger_type);
            return (
              <div key={rule.id} className="ui-row">
                <Switch checked={rule.enabled} label={rule.enabled?"Alert on":"Alert off"} onChange={()=>toggleRule(rule)}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:FS.subhead,fontWeight:600,color:rule.enabled?TEXT:MUTED}}>{summarizeRule(rule)}{t?.group&&<span style={{marginLeft:6,fontSize:FS.footnote,color:MUTED,fontWeight:500}}>{t.group}</span>}</div>
                  <div style={{fontSize:FS.footnote,color:MUTED}}>
                    Cooldown {rule.cooldown_minutes} min{rule.trigger_after_time?` · after ${rule.trigger_after_time}`:""}
                    {rule.last_triggered_at?` · last sent ${new Date(rule.last_triggered_at).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}`:""}
                  </div>
                </div>
                <MoreMenu label="Alert options" items={[
                  {label:rule.enabled?"Turn off":"Turn on", icon:rule.enabled?"stop":"play", onClick:()=>toggleRule(rule)},
                  {sep:true},
                  {label:"Delete alert", icon:"trash", destructive:true, onClick:()=>delRule(rule.id)},
                ]}/>
              </div>
            );
          })}
          {addingFor===dev.sn
            ? <RuleForm onCancel={()=>setAddingFor(null)} onSave={(form)=>saveRule(dev,form)}/>
            : <div className="ui-row"><Button size="sm" variant="plain" icon="plus" onClick={()=>{setAddingFor(dev.sn);setErr(null);setMsg(null);}}>Add alert</Button></div>}
        </div>
      ))}
    </>
  );
}

// Add-rule form, generated from the trigger taxonomy.
function RuleForm({onSave,onCancel}){
  const groups=triggerGroups();
  const first=groups[0].triggers[0];
  const [type,setType]=useState(first.type);
  const t=getTrigger(type);
  const [threshold,setThreshold]=useState(String(first.defaultThreshold));
  const [cooldown,setCooldown]=useState("60");
  const [afterTime,setAfterTime]=useState(first.defaultAfterTime||"18:00");
  const onType=(v)=>{ const nt=getTrigger(v); setType(v); setThreshold(String(nt.defaultThreshold)); if(nt.timeGate) setAfterTime(nt.defaultAfterTime||"18:00"); };
  const selStyle={...authInput,padding:"9px 12px",fontSize:FS.subhead,cursor:"pointer"};
  const numStyle={...authInput,padding:"9px 12px",fontSize:FS.subhead};
  return (
    <div style={{margin:"0 14px 12px",padding:12,background:BG,borderRadius:10,border:`1px solid ${BORDER}`}}>
      <div style={{marginBottom:10}}>
        <label style={lblS}>When</label>
        <select value={type} onChange={e=>onType(e.target.value)} style={selStyle}>
          {groups.map(g=>(
            <optgroup key={g.group} label={g.group}>
              {g.triggers.map(tr=><option key={tr.type} value={tr.type}>{tr.label}</option>)}
            </optgroup>
          ))}
        </select>
      </div>
      <div style={{display:"flex",gap:10,marginBottom:10,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 120px"}}>
          <label style={lblS}>{t.op==="gap"?"Minutes":"Threshold"} ({t.unit})</label>
          <input type="number" value={threshold} min={t.min} max={t.max} step={t.step||1} onChange={e=>setThreshold(e.target.value)} style={numStyle}/>
        </div>
        <div style={{flex:"1 1 120px"}}>
          <label style={lblS}>Cooldown (min)</label>
          <input type="number" value={cooldown} min={0} step={5} onChange={e=>setCooldown(e.target.value)} style={numStyle}/>
        </div>
        {t.timeGate &&
          <div style={{flex:"1 1 120px"}}>
            <label style={lblS}>Only check after</label>
            <input type="time" value={afterTime} onChange={e=>setAfterTime(e.target.value)} style={numStyle}/>
          </div>}
      </div>
      <div style={{display:"flex",gap:8}}>
        <Button variant="primary" onClick={()=>onSave({trigger_type:type,threshold,cooldown,afterTime:t.timeGate?afterTime:null})} disabled={threshold===""}>Add alert</Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// Share a site (view-only) with someone by email. Existing users see it immediately; others get an
// invite to sign up with that address. Owner-only; recipients never get credentials or equipment control.
function ShareModal({ site, accountId, onClose }){
  const [email,setEmail]=useState("");
  const [shares,setShares]=useState(null);
  const [busy,setBusy]=useState(false); const [err,setErr]=useState(null); const [msg,setMsg]=useState(null);
  const load=useCallback(()=>{ api("share_list",{accountId}).then(r=>setShares((r.outgoing||[]).filter(s=>s.site_name===site.name))).catch(()=>setShares([])); },[accountId,site.name]);
  useEffect(()=>{ load(); },[load]);
  const submit=async(e)=>{ e.preventDefault(); setBusy(true);setErr(null);setMsg(null);
    try{ const r=await api("share_create",{accountId,site:site.name,email}); setMsg(r.pending?`Invite emailed to ${email} — they'll see it after signing up with that address.`:`Shared with ${email}.${r.emailed?"":" (Email isn't configured, so no notification was sent.)"}`); setEmail(""); load(); }
    catch(e){ setErr(e.message); } finally{ setBusy(false); } };
  const revoke=async(id)=>{ if(!await confirmAlert("Stop sharing this site?", {message:"They lose access right away. You can share it again later.", action:"Revoke", destructive:true})) return; try{ await api("share_revoke",{id}); toast("Access revoked"); load(); }catch(e){ setErr(e.message); } };
  return (
    <Sheet title="Share site" subtitle={site.name} onClose={onClose} maxWidth={480}>
        <div>
          {err&&<div role="alert" style={errBox}>{err}</div>}
          {msg&&<div style={okBox}>{msg}</div>}
          <div style={{fontSize:FS.footnote,color:MUTED,marginBottom:12,lineHeight:1.5}}>Give someone <strong>view-only</strong> access to this site. They'll get an email; if they don't have an account yet, they'll be invited to create one with that address and the site appears automatically. No equipment control — viewing only. Revoke anytime.</div>
          <form onSubmit={submit} style={{display:"flex",gap:8,marginBottom:18}}>
            <input type="email" required placeholder="person@email.com" aria-label="Email address" autoComplete="email" data-autofocus value={email} onChange={e=>setEmail(e.target.value)} style={{...authInput,flex:1}}/>
            <Button type="submit" variant="primary" icon="share" disabled={busy||!email}>{busy?"Sharing…":"Share"}</Button>
          </form>
          <div className="ui-section-label">Shared with</div>
          <div className="ui-group">
            {shares===null&&<div className="ui-row"><div className="ui-skel" style={{height:20,borderRadius:6,flex:1}}/></div>}
            {shares&&shares.length===0&&<div className="ui-row" style={{fontSize:FS.subhead,color:MUTED}}>Not shared with anyone yet.</div>}
            {shares&&shares.map(s=><ShareRow key={s.id} title={s.shared_with_email} status={s.status} onRevoke={()=>revoke(s.id)}/>)}
          </div>
        </div>
    </Sheet>
  );
}

// Central sharing manager (Settings → Sharing): share any site, see all outgoing shares with status +
// revoke, and the sites others have shared with you.
function SharingSettings({ activeId, sites=[] }){
  const [data,setData]=useState(null);
  const [site,setSite]=useState("");
  const [email,setEmail]=useState("");
  const [busy,setBusy]=useState(false); const [err,setErr]=useState(null); const [msg,setMsg]=useState(null);
  useEffect(()=>{ if(!site&&sites[0]) setSite(sites[0].name); },[sites,site]);
  const load=useCallback(()=>{ api("share_list").then(setData).catch(e=>setData({outgoing:[],incoming:[],error:e.message})); },[]);
  useEffect(()=>{ load(); },[load]);
  const share=async(e)=>{ e.preventDefault(); if(!site||!email)return; setBusy(true);setErr(null);setMsg(null);
    try{ const r=await api("share_create",{accountId:activeId,site,email}); setMsg(r.pending?`Invite emailed to ${email} for ${site}.`:`Shared ${site} with ${email}.${r.emailed?"":" (Email isn't configured — no notification sent.)"}`); setEmail(""); load(); }
    catch(e){ setErr(e.message); } finally{ setBusy(false); } };
  const revoke=async(id)=>{ if(!await confirmAlert("Stop sharing this site?", {message:"They lose access right away. You can share it again later.", action:"Revoke", destructive:true})) return; try{ await api("share_revoke",{id}); toast("Access revoked"); load(); }catch(e){ setErr(e.message); } };
  const out = data?.outgoing||[]; const inc = data?.incoming||[];
  const selStyle={...authInput,padding:"9px 12px",fontSize:FS.subhead,cursor:"pointer"};
  return (
    <>
      {err&&<div role="alert" style={errBox}>{err}</div>}
      {msg&&<div style={okBox}>{msg}</div>}
      {data?.error&&<div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:FS.footnote,color:"#92400E"}}>Sharing isn’t set up on the database yet (run <code style={{fontFamily:"monospace"}}>supabase/schema.sql</code>).</div>}
      <div style={{fontSize:FS.footnote,color:MUTED,marginBottom:12,lineHeight:1.5}}>Share <strong>view-only</strong> access to a site. Recipients get an email; if they don’t have an account, they’re invited to make one with that address and the site appears automatically. No equipment control. Revoke anytime.</div>
      <form onSubmit={share} style={{padding:12,background:BG,borderRadius:10,border:`1px solid ${BORDER}`,marginBottom:16}}>
        <div style={{marginBottom:10}}><label style={lblS}>Site</label>
          <select value={site} onChange={e=>setSite(e.target.value)} style={selStyle}>
            {sites.length===0&&<option value="">No sites on this account</option>}
            {sites.map(s=><option key={s.name} value={s.name}>{s.name}</option>)}
          </select>
        </div>
        <div style={{marginBottom:12}}><label style={lblS}>Recipient email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="person@email.com" style={authInput}/></div>
        <Button type="submit" variant="primary" icon="share" disabled={busy||!site||!email}>{busy?"Sharing…":"Share site"}</Button>
      </form>
      <div className="ui-section-label">Shared by you</div>
      <div className="ui-group" style={{marginBottom:16}}>
        {data===null&&<div className="ui-row"><div className="ui-skel" style={{height:20,borderRadius:6,flex:1}}/></div>}
        {data&&out.length===0&&<div className="ui-row" style={{fontSize:FS.subhead,color:MUTED}}>You haven’t shared any sites yet.</div>}
        {out.map(s=><ShareRow key={s.id} title={s.site_name} sub={s.shared_with_email} status={s.status} onRevoke={()=>revoke(s.id)}/>)}
      </div>
      {inc.length>0&&<>
        <div className="ui-section-label">Shared with you</div>
        <div className="ui-group">
          {inc.map(s=>(
            <div key={s.id} className="ui-row">
              <span style={{color:MUTED,fontSize:20,display:"inline-flex"}}><Icon name="users"/></span>
              <div style={{flex:1,minWidth:0}}><div style={{fontSize:FS.body,fontWeight:600,color:TEXT}}>{s.site_name}</div><div style={{fontSize:FS.footnote,color:MUTED}}>View only · switch to it from the account menu</div></div>
              <span className="ui-pill" style={{background:"#DCFCE7",color:BATTERY_TEXT}}>Active</span>
            </div>
          ))}
        </div>
      </>}
    </>
  );
}

function AccountSettings({email,role,accounts,activeId,profile={},sites=[],selectedSite=null,sitePhotos={},onSetActive,onChanged,onClose,onLogout,readOnly=false}){
  const [sec,setSec]=useState("accounts");
  const [err,setErr]=useState(null); const [msg,setMsg]=useState(null); const [busy,setBusy]=useState(false);
  const isAdmin=role==="admin"; const canAdd=isAdmin||accounts.length===0;
  // Linked Midnite accounts
  const [u,setU]=useState(""); const [p,setP]=useState(""); const [adding,setAdding]=useState(false);
  const addAcct=async(e)=>{ e.preventDefault(); setBusy(true); setErr(null);
    try{ const r=await api("linkaccount",{username:u,password:p}); setU("");setP("");setAdding(false); if(!activeId) onSetActive(r.account.id); onChanged(); }
    catch(e){ setErr(e.message); } finally{ setBusy(false); } };
  const unlink=async(id)=>{ if(!await confirmAlert("Unlink this Midnite account?", {message:"Its sites disappear from Sentinel until you link it again.", action:"Unlink", destructive:true})) return; try{ await api("unlinkaccount",{id}); toast("Account unlinked"); onChanged(); }catch(e){ setErr(e.message); } };
  // Profile
  const [name,setName]=useState(profile.display_name||"");
  const saveName=async()=>{ setBusy(true);setErr(null);setMsg(null); try{ await api("updateprofile",{display_name:name}); toast("Profile saved"); onChanged(); }catch(e){setErr(e.message);} finally{setBusy(false);} };
  const ext=(f)=> (f.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"")||"jpg";
  const onAvatar=async(e)=>{ const f=e.target.files?.[0]; if(!f) return; setBusy(true);setErr(null);setMsg(null);
    try{ const { data:{user} }=await supabase.auth.getUser(); const url=await uploadMedia("avatars",`${user.id}/avatar.${ext(f)}`,f); await api("updateprofile",{avatar_url:`${url}?t=${Date.now()}`}); toast("Photo updated"); onChanged(); }
    catch(e){setErr(e.message);} finally{setBusy(false);} };
  // Security
  const [newEmail,setNewEmail]=useState(""); const [newPw,setNewPw]=useState("");
  const changeEmail=async(e)=>{ e.preventDefault(); setBusy(true);setErr(null);setMsg(null); try{ const {error}=await supabase.auth.updateUser({email:newEmail}); if(error)throw error; setMsg("Email change requested — you may need to confirm it."); setNewEmail(""); }catch(e){setErr(e.message);} finally{setBusy(false);} };
  const changePw=async(e)=>{ e.preventDefault(); setBusy(true);setErr(null);setMsg(null); try{ const {error}=await supabase.auth.updateUser({password:newPw}); if(error)throw error; toast("Password updated", {icon:"lock"}); setNewPw(""); }catch(e){setErr(e.message);} finally{setBusy(false);} };
  // Site photos
  const onSitePhoto=async(siteName,e)=>{ const f=e.target.files?.[0]; if(!f) return; setBusy(true);setErr(null);setMsg(null);
    try{ const { data:{user} }=await supabase.auth.getUser(); const safe=encodeURIComponent(siteName).replace(/[^A-Za-z0-9]/g,"_").slice(0,60); const url=await uploadMedia("sites",`${user.id}/${safe}.${ext(f)}`,f); await api("setsitephoto",{site:siteName,url:`${url}?t=${Date.now()}`}); onChanged(); }
    catch(e){setErr(e.message);} finally{setBusy(false);} };
  const removeSitePhoto=async(siteName)=>{ if(!await confirmAlert("Remove this site photo?", {action:"Remove", destructive:true})) return; setBusy(true); try{ await api("setsitephoto",{site:siteName,url:null}); toast("Photo removed"); onChanged(); }catch(e){ setErr(e.message); }finally{setBusy(false);} };

  const goSec=(id)=>{ setSec(id); setErr(null); setMsg(null); };
  const fileBtn=(label,onChange)=>(<label className="ui-btn ui-btn--secondary ui-btn--sm" style={{flexShrink:0}}><Icon name="upload"/>{label}<input type="file" accept="image/*" onChange={onChange} style={{display:"none"}}/></label>);

  return (
    <Sheet maxWidth={560} onClose={onClose}
      title={profile.display_name||"Settings"}
      subtitle={<span style={{display:"inline-flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>{email}{isAdmin&&<span className="ui-pill" style={{background:"#FEF3C7",color:SOLAR_TEXT}}>Admin</span>}</span>}
      leading={profile.avatar_url
        ? <img src={profile.avatar_url} alt="" style={{width:40,height:40,borderRadius:"50%",objectFit:"cover",border:`1px solid ${BORDER}`,flexShrink:0}}/>
        : <div style={{width:40,height:40,borderRadius:"50%",background:BG,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:FS.callout,fontWeight:700,color:MUTED,flexShrink:0}}>{(profile.display_name||email||"?").slice(0,1).toUpperCase()}</div>}
      toolbar={<div className="seg-scroll"><Segmented label="Settings sections" value={sec} onChange={goSec} options={[{value:"accounts",label:"Midnite"},{value:"profile",label:"Profile"},{value:"security",label:"Security"},{value:"sites",label:"Photos"},{value:"alerts",label:"Alerts"},{value:"sharing",label:"Sharing"}]}/></div>}
      footer={<>
        <a href="/faq" target="_blank" rel="noopener" className="ui-btn ui-btn--plain"><Icon name="help"/>Help &amp; FAQ</a>
        {onLogout && <Button variant="destructive" icon="logout" onClick={onLogout}>Sign out</Button>}
      </>}>
        <div>
          {err&&<div role="alert" style={errBox}>{err}</div>}
          {msg&&<div style={okBox}>{msg}</div>}

          {sec==="accounts" && <>
            <div className="ui-section-label">Linked Midnite accounts</div>
            <div className="ui-group">
              {accounts.length===0 && <div className="ui-row" style={{fontSize:FS.subhead,color:MUTED}}>None linked yet.</div>}
              {accounts.map(a=>(
                <div key={a.id} className="ui-row">
                  <span style={{color:activeId===a.id?BATTERY:MUTED,fontSize:20,display:"inline-flex"}}><Icon name={activeId===a.id?"check":"user"}/></span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:FS.body,fontWeight:600,color:TEXT,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>{a.label||a.midnite_username}{activeId===a.id&&<span className="ui-pill" style={{background:"#DCFCE7",color:BATTERY_TEXT}}>Active</span>}</div>
                    <div style={{fontSize:FS.footnote,color:MUTED,fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>{a.midnite_username}{a.account_type?` · ${a.account_type}`:""}</div>
                  </div>
                  <MoreMenu label="Account options" items={[
                    ...(isAdmin&&activeId!==a.id?[{label:"Use this account", icon:"check", onClick:()=>onSetActive(a.id)},{sep:true}]:[]),
                    {label:"Unlink account", icon:"link", destructive:true, onClick:()=>unlink(a.id)},
                  ]}/>
                </div>
              ))}
            </div>
            {canAdd && !adding && <div style={{marginTop:12}}><Button icon="plus" onClick={()=>setAdding(true)}>{accounts.length===0?"Link a Midnite account":"Add Midnite account"}</Button></div>}
            {!canAdd && accounts.length>0 && <div style={{marginTop:12,fontSize:FS.caption,color:MUTED}}>Your plan allows one linked Midnite account. Unlink the current one to connect a different system.</div>}
            {adding && (
              <form onSubmit={addAcct} style={{marginTop:14,padding:14,background:BG,borderRadius:10,border:`1px solid ${BORDER}`}}>
                <div style={{marginBottom:10}}><label style={lblS}>Midnite username</label><input value={u} onChange={e=>setU(e.target.value)} autoFocus autoComplete="username" style={authInput}/></div>
                <div style={{marginBottom:14}}><label style={lblS}>Midnite password</label><input type="password" value={p} onChange={e=>setP(e.target.value)} autoComplete="current-password" style={authInput}/></div>
                <div style={{display:"flex",gap:8}}>
                  <Button type="submit" variant="primary" disabled={busy||!u||!p}>{busy?"Linking…":"Link account"}</Button>
                  <Button onClick={()=>{setAdding(false);setErr(null);}}>Cancel</Button>
                </div>
              </form>
            )}
          </>}

          {sec==="profile" && <>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
              {profile.avatar_url
                ? <img src={profile.avatar_url} alt="" style={{width:64,height:64,borderRadius:"50%",objectFit:"cover",border:`1px solid ${BORDER}`}}/>
                : <div style={{width:64,height:64,borderRadius:"50%",background:BG,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:FS.title2,fontWeight:700,color:MUTED}}>{(name||email||"?").slice(0,1).toUpperCase()}</div>}
              {fileBtn(busy?"Uploading…":"Upload photo", onAvatar)}
            </div>
            <div style={{marginBottom:14}}><label style={lblS}>Display Name</label><input value={name} onChange={e=>setName(e.target.value)} style={authInput}/></div>
            <button onClick={saveName} disabled={busy} style={{...authBtn(busy),width:"auto",padding:"10px 20px"}}>Save</button>
          </>}

          {sec==="security" && <>
            <form onSubmit={changeEmail} style={{marginBottom:20}}>
              <div style={{marginBottom:10}}><label style={lblS}>Change email (current: {email})</label><input type="email" value={newEmail} onChange={e=>setNewEmail(e.target.value)} placeholder="new@email.com" style={authInput}/></div>
              <button type="submit" disabled={busy||!newEmail} style={{...authBtn(busy||!newEmail),width:"auto",padding:"10px 20px"}}>Update email</button>
            </form>
            <form onSubmit={changePw} style={{borderTop:`1px solid ${BORDER}`,paddingTop:18}}>
              <div style={{marginBottom:10}}><label style={lblS}>New password</label><input type="password" value={newPw} onChange={e=>setNewPw(e.target.value)} autoComplete="new-password" style={authInput}/></div>
              <button type="submit" disabled={busy||newPw.length<6} style={{...authBtn(busy||newPw.length<6),width:"auto",padding:"10px 20px"}}>Update password</button>
            </form>
          </>}

          {sec==="sites" && <>
            <div style={{fontSize:FS.caption,color:MUTED,marginBottom:12}}>{readOnly?"These sites are shared with you view-only — photos are set by the owner.":"Add a photo for each site. These show here and may be used elsewhere later."}</div>
            {sites.length===0 && <div style={{fontSize:FS.subhead,color:MUTED}}>No sites yet — link a Midnite account first.</div>}
            <div className="ui-group">
            {sites.map(s=>(
              <div key={s.name} className="ui-row">
                {sitePhotos[s.name]
                  ? <img src={sitePhotos[s.name]} alt="" style={{width:52,height:52,borderRadius:10,objectFit:"cover",border:`1px solid ${BORDER}`,flexShrink:0}}/>
                  : <div style={{width:52,height:52,borderRadius:10,background:BG,border:`1px dashed ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22,color:MUTED,flexShrink:0}}><Icon name="home"/></div>}
                <div style={{flex:1,minWidth:0,fontSize:FS.body,fontWeight:600,color:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</div>
                {!readOnly && fileBtn(sitePhotos[s.name]?"Replace":"Upload", e=>onSitePhoto(s.name,e))}
                {!readOnly && sitePhotos[s.name] && <MoreMenu label="Photo options" items={[{label:"Remove photo", icon:"trash", destructive:true, onClick:()=>removeSitePhoto(s.name)}]}/>}
              </div>
            ))}
            </div>
          </>}

          {sec==="alerts" && <NotificationsSettings activeId={activeId} site={selectedSite}/>}
          {sec==="sharing" && <SharingSettings activeId={activeId} sites={sites}/>}
        </div>
    </Sheet>
  );
}

function SiteSelector({sites, onSelect, onLogout, onFleet}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = q ? sites.filter(s=>s.name.toLowerCase().includes(q)||(s.installer||"").toLowerCase().includes(q)) : sites;
  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:BG}}>
        <div style={{borderBottom:`1px solid ${BORDER}`,padding:"14px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",background:CARD,position:"sticky",top:0,zIndex:100}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <Logo size={32}/>
            <div>
              <div style={{fontSize:FS.callout,fontWeight:700,color:TEXT}}>Select a Site</div>
              <div style={{fontSize:FS.caption,color:MUTED}}>{filtered.length} of {sites.length} site{sites.length!==1?"s":""}</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {onFleet&&<button onClick={onFleet} style={{padding:"7px 14px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#FCD34D,#D97706)",color:"#7C2D12",fontSize:FS.footnote,fontWeight:700,fontFamily:SANS,cursor:"pointer",boxShadow:"0 2px 8px rgba(217,119,6,0.25)"}}>⊞ Fleet View</button>}
            <button onClick={onLogout} style={{padding:"7px 14px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:FS.footnote,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Sign out</button>
          </div>
        </div>
        <div style={{maxWidth:900,margin:"0 auto",padding:"20px 16px",animation:"fadeUp 0.4s ease"}}>
          <div style={{position:"relative",marginBottom:16}}>
            <svg style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={FAINT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              autoFocus
              type="text"
              placeholder="Search sites…"
              value={query}
              onChange={e=>setQuery(e.target.value)}
              style={{width:"100%",padding:"11px 14px 11px 38px",background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,color:TEXT,fontSize:FS.body,fontFamily:SANS,boxShadow:SHADOW_SM,boxSizing:"border-box"}}
            />
            {query&&<button onClick={()=>setQuery("")} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",border:"none",background:"transparent",color:MUTED,cursor:"pointer",fontSize:FS.headline,lineHeight:1,padding:0}}>×</button>}
          </div>
          {filtered.length===0&&<div style={{textAlign:"center",color:MUTED,fontSize:FS.subhead,padding:"48px 0"}}>No sites match "{query}"</div>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
            {filtered.map(s=>{
              const [on,alarm,off,disc]=s.statusCounts;
              const total=s.inverters.length;
              return (
                <button key={s.name} onClick={()=>onSelect(s)} className="site-card" style={{textAlign:"left",padding:"20px",background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,cursor:"pointer",display:"flex",flexDirection:"column",gap:10,boxShadow:SHADOW_SM}}>
                  <div>
                    <div style={{fontSize:FS.callout,fontWeight:700,color:TEXT}}>{s.name}</div>
                    <div style={{fontSize:FS.footnote,color:MUTED,marginTop:2}}>{total} inverter{total!==1?"s":""}</div>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {on>0&&<span style={{fontSize:FS.caption,color:BATTERY,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:BATTERY,display:"inline-block"}}/>{on} online</span>}
                    {alarm>0&&<span style={{fontSize:FS.caption,color:SOLAR,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:SOLAR,display:"inline-block"}}/>{alarm} alarm</span>}
                    {off>0&&<span style={{fontSize:FS.caption,color:GRID_IN,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:GRID_IN,display:"inline-block"}}/>{off} offline</span>}
                    {disc>0&&<span style={{fontSize:FS.caption,color:MUTED,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:FAINT,display:"inline-block"}}/>{disc} disconnected</span>}
                    {total===0&&<span style={{fontSize:FS.caption,color:MUTED}}>No inverters</span>}
                  </div>
                  {s.installer&&<div style={{fontSize:FS.caption,color:MUTED}}>{s.installer}</div>}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",color:SOLAR,fontSize:FS.footnote,fontWeight:700,gap:4,marginTop:2}}>View →</div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Fleet View — sortable status + metrics table for multi-site (installer/admin) accounts ──────────
function FleetView({ sites, onPick, onBack, onLogout, sitePhotos={}, onPhotoChanged, readOnly=false }){
  const [data, setData] = useState({});        // site.name -> { loading, results, error }
  const [sortKey, setSortKey] = useState("status");
  const [sortDir, setSortDir] = useState(1);   // 1 asc, -1 desc
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all"); // all | online | issues
  const [busy, setBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [preview, setPreview] = useState(null); // {url,x,y} — hover-expanded site photo (desktop)
  const [photoModal, setPhotoModal] = useState(null); // {site,url} — tap-to-view / upload popup (mobile-friendly)
  const [localPhotos, setLocalPhotos] = useState({}); // optimistic overrides after an upload
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState(null);
  const photoFor = (name)=> (name in localPhotos ? localPhotos[name] : sitePhotos[name]) || null;
  // Position the expanded preview next to the hovered thumb, clamped on-screen (escapes the table's overflow).
  const showPreview = (e, url)=>{ const r=e.currentTarget.getBoundingClientRect(); const pw=210, ph=210;
    let x=r.right+12; if(x+pw>window.innerWidth) x=r.left-pw-12; if(x<8) x=8;
    let y=r.top-(ph-r.height)/2; y=Math.max(8,Math.min(y,window.innerHeight-ph-8));
    setPreview({url,x,y}); };
  const openPhoto = (e, siteName)=>{ e.stopPropagation(); const url=photoFor(siteName); if(readOnly && !url) return; setPreview(null); setUploadErr(null); setPhotoModal({ site: siteName, url }); };
  // Upload a site photo (camera or file) → Supabase Storage → save URL via the proxy. Mirrors AccountSettings.
  const uploadPhoto = async (siteName, file)=>{ if(!file) return; setUploading(true); setUploadErr(null);
    try {
      const { data:{ user } } = await supabase.auth.getUser();
      const e = (file.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"")||"jpg";
      const safe = encodeURIComponent(siteName).replace(/[^A-Za-z0-9]/g,"_").slice(0,60);
      const url = await uploadMedia("sites", `${user.id}/${safe}.${e}`, file);
      const finalUrl = `${url}?t=${Date.now()}`;
      await api("setsitephoto", { site: siteName, url: finalUrl });
      setLocalPhotos(p=>({ ...p, [siteName]: finalUrl }));
      setPhotoModal(m=> m && m.site===siteName ? { ...m, url: finalUrl } : m);
      onPhotoChanged && onPhotoChanged();
    } catch(err){ setUploadErr(err.message); } finally { setUploading(false); }
  };

  const load = useCallback(()=>{
    if(!sites.length) return;
    setBusy(true); let done=0;
    sites.forEach(site=>{
      const serials=site.inverters.map(i=>i.sn);
      // status = 5-min (SOC, energy-today, freshness, online); flow = live 5s power (EPS-aware load —
      // the only source that captures generator pass-through / EPS house load).
      Promise.all([
        api("status", { serials, autoIds: site.inverters.map(i=>i.autoId), memberAutoId: site.memberAutoId }).then(r=>r.results).catch(()=>null),
        api("flow", { serials }).then(r=>r.results).catch(()=>null),
      ]).then(([results,flow])=> setData(d=>({ ...d, [site.name]: { loading:false, results, flow, error:(!results&&!flow)?"fetch failed":null } })))
        .finally(()=>{ done++; if(done===sites.length){ setBusy(false); setLastRefresh(new Date()); } });
    });
  }, [sites]);
  usePolling(load, POLL.SITE_MS, [load]); // 2-min (data is 5-min), paused while hidden

  // House load per inverter: the direct (EPS-detected) load reading OR the balance, whichever is larger —
  // balanceLoad alone nets to ~0 on some AIO/EPS units even when the house is clearly drawing.
  const loadOf = (d)=> Math.max((d?.load?.lines||[]).reduce((s,l)=>s+(l.power>0?l.power:0),0), balanceLoad(d)||0);
  const metricsOf = (site)=>{
    const row = data[site.name];
    const total = site.inverters.length;
    const v = row?.results ? row.results.filter(r=>r?.ok && r?.data) : null;  // 5-min status (may be STALE/cached)
    const fl = row?.flow ? row.flow.filter(f=>f && f.ok!==false) : null;      // live flow
    const flUp = fl ? fl.filter(f=>f.online) : null;                          // inverters the dongle reports ONLINE
    // Online from the live dongle flag (the API returns stale cached data for offline sites, so
    // "returned data" isn't enough). No flow → fall back to status-returned. Rank asc = problems first.
    const onlineN = fl ? flUp.length : (v ? v.length : 0);
    let status;
    if(v||fl) status = onlineN===0 ? {label:"Offline",color:GRID_IN,rank:0} : onlineN<total ? {label:"Partial",color:SOLAR,rank:2} : {label:"Online",color:BATTERY,rank:3};
    else if(row?.error) status={label:"Offline",color:GRID_IN,rank:0};
    else status={label:"Checking…",color:MUTED,rank:5};
    const m={ site, status, total, invOnline: onlineN, error: row?.error, loading: !v && !fl && !row?.error };
    if(fl){                        // flow feed present → trust it; power only from ONLINE inverters (offline → blank)
      if(flUp.length){
        m.pv=flUp.reduce((s,f)=>s+(f.pv||0),0);
        m.load=flUp.reduce((s,f)=>s+(f.load>0?f.load:(f.eps||0)),0);  // EPS-aware home (captures gen pass-through)
        m.gridNet=flUp.reduce((s,f)=>s+(f.grid||0),0);
        const gen=flUp.reduce((s,f)=>s+(f.gen||0),0);
        m.batNet=m.pv+m.gridNet+gen-m.load;                          // balance-derived (live Pbat sign unreliable)
      }
    } else if(v){                  // no flow → fall back to 5-min status power
      m.pv=v.reduce((s,i)=>s+(i.data.photovoltaic?.power?.totalDc||0),0);
      m.load=v.reduce((s,i)=>s+loadOf(i.data),0);
      m.gridNet=v.reduce((s,i)=>s+(i.data.grid?.netW||0),0);
      m.batNet=v.reduce((s,i)=>s+((i.data.battery?.charge||0)-(i.data.battery?.discharge||0)),0);
    }
    if(v){                         // SOC / energy-today / freshness from the reliable 5-min status
      const socA=v.filter(i=>(i.data.battery?.soc||0)>0);
      m.soc=socA.length? socA.reduce((s,i)=>s+i.data.battery.soc,0)/socA.length : null;
      m.pvToday=v.reduce((s,i)=>s+(i.data.photovoltaic?.production?.today||0),0);
      m.expToday=v.reduce((s,i)=>s+(i.data.grid?.sold?.today||0),0);
      m.updated=v.map(i=>i.data.inverter?.lastUpdateTime).filter(Boolean).sort().slice(-1)[0]||null;
    }
    return m;
  };

  const baseM = sites.map(metricsOf);
  const totalPv = baseM.reduce((s,m)=>s+(m.pv||0),0);
  const totalPvToday = baseM.reduce((s,m)=>s+(m.pvToday||0),0);
  const onlineCount = baseM.filter(m=>m.status.rank===3).length;
  const issueCount = baseM.filter(m=>m.status.rank<=2).length;

  let rows = baseM;
  const q=query.trim().toLowerCase();
  if(q) rows=rows.filter(m=>m.site.name.toLowerCase().includes(q)||(m.site.installer||"").toLowerCase().includes(q));
  if(filter==="online") rows=rows.filter(m=>m.status.rank===3);
  else if(filter==="issues") rows=rows.filter(m=>m.status.rank<=2);
  const sortVal=(m)=>{ switch(sortKey){
    case "name": return m.site.name.toLowerCase();
    case "status": return m.status.rank;
    case "pv": return m.pv??-1; case "load": return m.load??-1; case "soc": return m.soc??-1;
    case "grid": return m.gridNet??0; case "pvToday": return m.pvToday??-1; case "expToday": return m.expToday??-1;
    default: return m.site.name.toLowerCase(); } };
  rows=[...rows].sort((a,b)=>{ const av=sortVal(a),bv=sortVal(b); if(av<bv)return -sortDir; if(av>bv)return sortDir; return a.site.name.localeCompare(b.site.name); });
  const setSort=(k)=>{ if(sortKey===k) setSortDir(d=>-d); else { setSortKey(k); setSortDir((k==="name"||k==="status")?1:-1); } };
  const exportCsv=()=>{
    const esc=(v)=>`"${String(v==null?"":v).replace(/"/g,'""')}"`;
    const head=["Site","Installer","Status","Inverters Online","Inverters Total","PV Now (W)","Load (W)","Battery SOC (%)","Grid Net W (+import/-export)","PV Today (Wh)","Exported Today (Wh)","Last Report"];
    const lines=[head.map(esc).join(",")];
    for(const m of rows) lines.push([m.site.name,m.site.installer||"",m.status.label,m.invOnline??m.on,m.total,Math.round(m.pv||0),Math.round(m.load||0),m.soc!=null?Math.round(m.soc):"",Math.round(m.gridNet||0),Math.round(m.pvToday||0),Math.round(m.expToday||0),m.updated||""].map(esc).join(","));
    const blob=new Blob(["﻿"+lines.join("\r\n")],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob); const a=document.createElement("a");
    a.href=url; a.download=`fleet-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };

  // Rows glide to their new places when the sort or filter changes (GSAP Flip; skipped under Reduce Motion).
  const tbodyRef = useRef(null), flipState = useRef(null), kpiRef = useRef(null), largeTitleRef = useRef(null);
  const titlePast = useScrolledPast(largeTitleRef, []);
  const captureFlip = ()=>{ if(!prefersReducedMotion() && tbodyRef.current) flipState.current = Flip.getState(tbodyRef.current.querySelectorAll("tr[data-flip-id]")); };
  const sortBy = (k)=>{ captureFlip(); setSort(k); };
  const switchFilter = (f)=>{ captureFlip(); setFilter(f); };
  useIsoLayoutEffect(()=>{
    const st = flipState.current; flipState.current = null;
    if(!st || !tbodyRef.current) return;
    Flip.from(st, { targets: tbodyRef.current.querySelectorAll("tr[data-flip-id]"), duration:0.38, ease:"power2.inOut",
      onEnter: els=>gsap.fromTo(els,{autoAlpha:0},{autoAlpha:1,duration:0.25}) });
  }, [sortKey, sortDir, filter]);
  useStaggerIn(kpiRef, [], {y:6});

  const cols=[
    {k:"photo",label:"",a:"left",nosort:true},
    {k:"name",label:"Site",a:"left"},{k:"status",label:"Status",a:"left"},
    {k:"pv",label:"PV now",a:"right"},{k:"load",label:"Home",a:"right"},
    {k:"soc",label:"Battery",a:"right"},{k:"grid",label:"Grid",a:"right"},
    {k:"pvToday",label:"PV today",a:"right"},{k:"expToday",label:"Exported",a:"right"},
    {k:"updated",label:"Updated",a:"right",nosort:true},
  ];
  const Sk=()=> <span className="ui-skel" style={{display:"inline-block",width:52,height:12,borderRadius:4,verticalAlign:"middle"}}/>;
  const th={padding:"10px 12px",fontSize:FS.footnote,color:MUTED,fontWeight:600,whiteSpace:"nowrap",userSelect:"none",position:"sticky",top:0,background:CARD,borderBottom:`1px solid ${BORDER}`,zIndex:2};
  const td={padding:"10px 12px",height:56,fontSize:FS.subhead,color:TEXT,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",borderBottom:`1px solid ${BORDER}`};
  const kpi=(label,value,num,format,color,filterId)=>{
    const active = filterId && filter===filterId;
    const inner = (<>
      <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600}}>{label}</div>
      <div style={{fontSize:FS.title2,fontWeight:800,color:textTone(color||TEXT),marginTop:2}}>{format?<CountUp value={num} format={format}/>:value}</div>
    </>);
    const style={background:active?"#FFFBEB":CARD,border:`1px solid ${active?SOLAR:BORDER}`,borderRadius:14,padding:"12px 14px",boxShadow:SHADOW_SM,textAlign:"left",fontFamily:SANS,width:"100%"};
    return filterId
      ? <button key={label} type="button" aria-pressed={active} className="ui-press" onClick={()=>switchFilter(filterId)} style={{...style,cursor:"pointer"}}>{inner}</button>
      : <div key={label} style={style}>{inner}</div>;
  };
  const sortIcon=(k)=> sortKey===k ? <Icon name={sortDir>0?"chevron-up":"chevron-down"} style={{marginLeft:2}}/> : null;
  const subtitle = <>{sites.length} sites · <span style={{color:BATTERY_TEXT,fontWeight:600}}>{onlineCount} online</span>{issueCount>0&&<> · <span style={{color:SOLAR_TEXT,fontWeight:600}}>{issueCount} need{issueCount===1?"s":""} attention</span></>}</>;
  const menu=[
    {label:"Export CSV", icon:"download", onClick:exportCsv},
    {label:"Help & FAQ", icon:"help", onClick:()=>window.open("/faq","_blank","noopener")},
    {sep:true},
    {label:"Sign out", icon:"logout", destructive:true, onClick:onLogout},
  ];

  return (
    <>
      <PageHead title="Fleet · Midnite Sentinel"/>
      <div style={{minHeight:"100vh",background:BG,fontFamily:SANS}}>
        <header className="ui-navbar">
          {onBack
            ? <button type="button" className="ui-backlink" onClick={onBack}><Icon name="back"/>Site</button>
            : <span style={{display:"inline-flex",flexShrink:0}}><Logo size={28}/></span>}
          <div className="hide-desktop" style={{flex:1,minWidth:0,textAlign:"center"}}>
            <div className={`ui-navtitle${titlePast?" is-shown":""}`} aria-hidden={!titlePast}>Fleet</div>
          </div>
          <div className="hide-phone" style={{flex:1}}/>
          <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
            <span className="hide-phone"><Button size="sm" icon="download" onClick={exportCsv}>Export CSV</Button></span>
            <IconButton icon="refresh" label={busy?"Refreshing":"Refresh"} onClick={load} disabled={busy} className={busy?"spin":""}/>
            <MoreMenu label="More" items={menu}/>
          </div>
        </header>

        <main style={{maxWidth:1180,margin:"0 auto",padding:"16px 16px 32px"}}>
          <div ref={largeTitleRef} style={{margin:"2px 0 16px"}}>
            <h1 className="ui-largetitle">Fleet</h1>
            <div style={{fontSize:FS.subhead,color:MUTED,marginTop:4}}>{subtitle}</div>
          </div>
          <div ref={kpiRef} style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:10,marginBottom:16}}>
            {kpi("Sites",null,sites.length,v=>String(Math.round(v)),TEXT,"all")}
            {kpi("Online",null,onlineCount,v=>String(Math.round(v)),BATTERY,"online")}
            {kpi("Need attention",null,issueCount,v=>String(Math.round(v)),issueCount>0?SOLAR:MUTED,"issues")}
            {kpi("Fleet PV now",null,totalPv,v=>fmt(v,1),SOLAR)}
            {kpi("Fleet PV today",null,totalPvToday,v=>fmtE(v),TEXT)}
          </div>

          <div className="fleet-tools">
            <label className="ui-search">
              <Icon name="search"/>
              <input type="search" placeholder="Search sites" aria-label="Search sites" value={query} onChange={e=>setQuery(e.target.value)}/>
            </label>
            <Segmented label="Filter" value={filter} onChange={switchFilter} options={[{value:"all",label:`All ${sites.length}`},{value:"online",label:`Online ${onlineCount}`},{value:"issues",label:`Issues ${issueCount}`}]}/>
            {lastRefresh&&<span className="hide-phone" style={{fontSize:FS.footnote,color:MUTED,marginLeft:"auto"}}>Updated {lastRefresh.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}</span>}
          </div>

          <div className="ui-card" style={{overflow:"hidden"}}>
            <div style={{overflow:"auto",maxHeight:"min(72vh,720px)"}}>
              <table className="fleet-table" style={{borderCollapse:"separate",borderSpacing:0,width:"100%",minWidth:820}}>
                <thead><tr>
                  {cols.filter(c=>c.k!=="photo").map(c=>(
                    <th key={c.k} aria-sort={sortKey===c.k?(sortDir>0?"ascending":"descending"):undefined} className={c.k==="name"?"sticky-col":undefined} style={{...th,textAlign:c.a,color:sortKey===c.k?TEXT:MUTED,...(c.k==="name"?{zIndex:3}:{})}}>
                      {c.nosort ? c.label : (
                        <button type="button" data-compact onClick={()=>sortBy(c.k)} style={{display:"inline-flex",alignItems:"center",gap:2,border:"none",background:"none",padding:"4px 0",font:"inherit",color:"inherit",cursor:"pointer"}}>
                          {c.label}{sortIcon(c.k)}
                        </button>
                      )}
                    </th>
                  ))}
                </tr></thead>
                <tbody ref={tbodyRef}>
                  {rows.length===0&&<tr><td colSpan={cols.length-1} style={{...td,whiteSpace:"normal",height:"auto"}}><EmptyState icon="search" title="No sites match" hint="Try a different search or filter."/></td></tr>}
                  {rows.map(m=>{
                    const imp=m.gridNet>50, exp=m.gridNet<-50;
                    const chg=m.batNet>20, dis=m.batNet<-20;
                    const ph=photoFor(m.site.name);
                    return (
                      <tr key={m.site.name} data-flip-id={m.site.name} onClick={()=>onPick(m.site)} onKeyDown={e=>{if(e.key==="Enter")onPick(m.site);}} tabIndex={0} className="fleet-row" style={{cursor:"pointer"}}>
                        <td className="sticky-col" style={{...td,maxWidth:260,paddingLeft:10}}>
                          <div style={{display:"flex",alignItems:"center",gap:10}}>
                            {ph
                              ? <img src={ph} alt="" onClick={e=>openPhoto(e,m.site.name)} onMouseEnter={e=>showPreview(e,ph)} onMouseLeave={()=>setPreview(null)} style={{width:36,height:36,borderRadius:9,objectFit:"cover",border:`1px solid ${BORDER}`,display:"block",cursor:"pointer",flexShrink:0}}/>
                              : <button type="button" data-compact aria-label={readOnly?"No photo":`Add a photo for ${m.site.name}`} onClick={readOnly?(e=>e.stopPropagation()):e=>openPhoto(e,m.site.name)} style={{width:36,height:36,borderRadius:9,background:"#F1ECE4",border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:readOnly?"default":"pointer",color:MUTED,fontSize:17,flexShrink:0,padding:0}}><Icon name="image"/></button>}
                            <div style={{minWidth:0}}>
                              <div style={{fontWeight:700,color:TEXT,whiteSpace:"normal"}}>{m.site.name}</div>
                              <div style={{fontSize:FS.footnote,color:MUTED}}>{m.site.installer||`${m.total} inverter${m.total!==1?"s":""}`}</div>
                            </div>
                          </div>
                        </td>
                        <td style={td}>
                          <div style={{display:"flex",alignItems:"center",gap:7}}>
                            <span className="ui-dot" style={{background:m.status.color,width:8,height:8}}/>
                            <div>
                              <div style={{fontWeight:600,color:textTone(m.status.color)}}>{m.status.label}</div>
                              <div style={{fontSize:FS.footnote,color:MUTED}}>{(m.invOnline??m.on)}/{m.total} online</div>
                            </div>
                          </div>
                        </td>
                        <td style={{...td,textAlign:"right",fontWeight:600,color:m.pv>0?SOLAR_TEXT:TEXT}}>{m.loading?<Sk/>:<CountUp value={m.pv} format={v=>fmt(v,1)}/>}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:<CountUp value={m.load} format={v=>fmt(v,1)}/>}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(m.soc==null?<span style={{color:MUTED}}>—</span>:<span style={{fontWeight:600,color:textTone(m.soc>60?BATTERY:m.soc>30?SOLAR:GRID_IN),display:"inline-flex",alignItems:"center",gap:3}}>{Math.round(m.soc)}%{chg?<Icon name="arrow-up" label="Charging" style={{color:BATTERY}}/>:dis?<Icon name="arrow-down" label="Discharging" style={{color:SOLAR}}/>:null}</span>)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(exp?<span style={{color:GRID_OUT_TEXT,fontWeight:600,display:"inline-flex",alignItems:"center",gap:3}}><Icon name="arrow-up" label="Exporting"/>{fmt(-m.gridNet,1)}</span>:imp?<span style={{color:GRID_IN_TEXT,fontWeight:600,display:"inline-flex",alignItems:"center",gap:3}}><Icon name="arrow-down" label="Importing"/>{fmt(m.gridNet,1)}</span>:<span style={{color:MUTED}}>—</span>)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:fmtE(m.pvToday)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(m.expToday>0?fmtE(m.expToday):<span style={{color:MUTED}}>—</span>)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(m.error?<span style={{color:GRID_IN_TEXT,fontSize:FS.footnote}}>Error</span>:(m.updated?<UpdatedChip time={m.updated}/>:<span style={{color:MUTED}}>—</span>))}</td>
                      </tr>
                    );
                  })}
                  {rows.length>1&&(()=>{ const t=rows.reduce((a,m)=>({pv:a.pv+(m.pv||0),load:a.load+(m.load||0),pvToday:a.pvToday+(m.pvToday||0),exp:a.exp+(m.expToday||0)}),{pv:0,load:0,pvToday:0,exp:0}); const ft={...td,background:"#FBF8F3",borderTop:`2px solid ${BORDER}`,position:"sticky",bottom:0,zIndex:1}; return (
                    <tr>
                      <td className="sticky-col" style={{...ft,fontWeight:800,zIndex:2}}>{rows.length} sites</td>
                      <td style={ft}/>
                      <td style={{...ft,textAlign:"right",fontWeight:800,color:SOLAR_TEXT}}>{fmt(t.pv,1)}</td>
                      <td style={{...ft,textAlign:"right",fontWeight:700}}>{fmt(t.load,1)}</td>
                      <td style={ft}/>
                      <td style={ft}/>
                      <td style={{...ft,textAlign:"right",fontWeight:700}}>{fmtE(t.pvToday)}</td>
                      <td style={{...ft,textAlign:"right",fontWeight:700}}>{t.exp>0?fmtE(t.exp):"—"}</td>
                      <td style={ft}/>
                    </tr>
                  ); })()}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{fontSize:FS.footnote,color:MUTED,marginTop:10,textAlign:"center"}}>Tap a row to open that site. Status comes from the live feed; the other numbers are the latest 5-minute report. Refreshes every 2 minutes.</div>
        </main>
      </div>
      {preview && (
        <div style={{position:"fixed",left:preview.x,top:preview.y,zIndex:150,pointerEvents:"none",animation:"fadeUp 0.12s ease"}}>
          <img src={preview.url} alt="" style={{width:200,height:200,objectFit:"cover",borderRadius:12,border:`3px solid ${CARD}`,boxShadow:"0 16px 44px rgba(0,0,0,0.34)"}}/>
        </div>
      )}
      {photoModal && (
        <Sheet title={photoModal.site} subtitle={readOnly?"Shared with you · view only":"Site photo"} onClose={()=>setPhotoModal(null)} closeDisabled={uploading} maxWidth={460}>
          {uploadErr&&<div role="alert" style={errBox}>{uploadErr}</div>}
          {photoModal.url
            ? <img src={photoModal.url} alt={`${photoModal.site} site photo`} style={{width:"100%",maxHeight:"56vh",objectFit:"contain",borderRadius:12,background:"#000",display:"block"}}/>
            : <EmptyState icon="image" title="No photo yet" hint={readOnly?"The site owner hasn’t added one.":"Add one so you can spot this site at a glance."}/>}
          {!readOnly && (
            <div style={{display:"flex",gap:10,marginTop:14,justifyContent:"center",flexWrap:"wrap"}}>
              <label className={`ui-btn ui-btn--secondary${uploading?" is-busy":""}`} aria-disabled={uploading}><Icon name="camera"/>{uploading?"Uploading…":"Take photo"}<input type="file" accept="image/*" capture="environment" disabled={uploading} onChange={e=>uploadPhoto(photoModal.site,e.target.files?.[0])} style={{display:"none"}}/></label>
              <label className={`ui-btn ui-btn--secondary${uploading?" is-busy":""}`} aria-disabled={uploading}><Icon name="image"/>{uploading?"Uploading…":(photoModal.url?"Replace":"Choose file")}<input type="file" accept="image/*" disabled={uploading} onChange={e=>uploadPhoto(photoModal.site,e.target.files?.[0])} style={{display:"none"}}/></label>
            </div>
          )}
        </Sheet>
      )}
    </>
  );
}

function SOCBar({value}) {
  const color = value>60 ? BATTERY : value>30 ? SOLAR : GRID_IN;
  return (
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      <div style={{flex:1}}><Meter value={value} color={color} height={8} label="Battery state of charge"/></div>
      <span style={{fontSize:FS.footnote,color:textTone(color),fontWeight:700,minWidth:36,textAlign:"right"}}><CountUp value={value} format={v=>`${Math.round(v)}%`}/></span>
    </div>
  );
}

// Small label + value tile. Pass `num` + `format` instead of `value` to get an animated number.
function StatTile({label, value, color=MUTED, sub=null, icon=null, num, format, tint=BG}) {
  const tone = textTone(color);
  return (
    <div style={{background:tint,borderRadius:12,padding:"10px 12px",minWidth:0}}>
      <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,marginBottom:3,display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
        {icon&&<Icon name={icon} style={{color}}/>}{label}
      </div>
      <div style={{fontSize:FS.callout,fontWeight:700,color:tone,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>
        {format ? <CountUp value={num} format={format}/> : value}
      </div>
      {sub&&<div style={{fontSize:FS.caption,color:MUTED,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function SummaryStrip({produced, consumed, imported, exported, charged, discharged, netExported}) {
  const [openTip, setOpenTip] = useState(null);
  const items = [
    {label:"Produced", num:produced, color:CHART_PROD},
    {label:"Consumed", num:consumed, color:CHART_CONS},
    {label:"Imported", num:imported, color:GRID_IN},
    {label:"Exported", num:exported, color:GRID_OUT},
    ...(netExported!=null?[{label: netExported>=0?"Net exported":"Net imported", num:Math.abs(netExported), color: netExported>=0?GRID_OUT:GRID_IN, tip:`Exported ${fmtE(exported)} − Imported ${fmtE(imported)} = ${netExported<0?"−":""}${fmtE(Math.abs(netExported))}`}]:[]),
    // Show the battery pair together whenever there's any battery activity, so Discharged never
    // silently drops out when its (often under-reported) energy register rounds to 0.
    ...((charged>0||discharged>0)?[
      {label:"Charged", num:charged, color:BATTERY},
      {label:"Discharged", num:discharged, color:SOLAR},
    ]:[]),
  ];
  return (
    <div className="ui-card" style={{padding:"14px 16px",marginBottom:16}}>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(112px,1fr))",gap:"12px 16px"}}>
        {items.map(it=>(
          <div key={it.label} style={{minWidth:0}}>
            <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,marginBottom:2,display:"flex",alignItems:"center",gap:4}}>
              {it.label}
              {it.tip&&<button type="button" data-compact aria-label={`How ${it.label.toLowerCase()} is calculated`} aria-expanded={openTip===it.label} onClick={()=>setOpenTip(t=>t===it.label?null:it.label)}
                style={{border:"none",background:"none",padding:2,margin:-2,color:MUTED,cursor:"pointer",display:"inline-flex"}}><Icon name="info"/></button>}
            </div>
            <div style={{fontSize:FS.headline,fontWeight:700,color:textTone(it.color),fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}><CountUp value={it.num} format={fmtE}/></div>
            {it.tip&&openTip===it.label&&<div style={{fontSize:FS.caption,color:MUTED,fontWeight:500,marginTop:3}}>{it.tip}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SiteHero({statuses, live=null, liveAt=null}) {
  const v = statuses.filter(s=>s?.ok&&s?.data);
  const updated = v.map(i=>i.data.inverter?.lastUpdateTime).filter(Boolean).sort().slice(-1)[0] || null;
  // Power "now" comes from the live 5s feed when available; energy-today tiles stay on the 5-min status.
  const totalPv = live ? live.pv : v.reduce((s,i)=>s+(i.data.photovoltaic?.power?.totalDc||0),0);
  const totalLoad = live ? live.load : v.reduce((s,i)=>s+(balanceLoad(i.data)||0),0);
  const totalGrid = live ? live.grid : v.reduce((s,i)=>s+(i.data.grid?.netW||0),0);
  const totalBat = live ? live.battery : v.reduce((s,i)=>s+(i.data.battery?.charge||0)-(i.data.battery?.discharge||0),0);
  const statusSoc = v.length ? v.reduce((s,i)=>s+(i.data.battery?.soc||0),0)/v.length : null;
  const avgSoc = (live && live.soc!=null) ? live.soc : statusSoc;
  const totalToday = v.reduce((s,i)=>s+(i.data.photovoltaic?.production?.today||0),0);
  const totalImpToday = v.reduce((s,i)=>s+(i.data.grid?.consumption?.today||0),0);
  const totalExpToday = v.reduce((s,i)=>s+(i.data.grid?.sold?.today||0),0);
  const gridFreq = v.find(i=>i.data.grid?.lines?.[0]?.frequency>0)?.data.grid.lines[0].frequency||null;
  const selfSuffArr = v.filter(i=>i.data.inverter?.selfSufficiencyPercent!=null);
  const avgSelfSuff = selfSuffArr.length ? selfSuffArr.reduce((s,i)=>s+i.data.inverter.selfSufficiencyPercent,0)/selfSuffArr.length : null;
  const isExporting = totalGrid < -50;
  const isImporting = totalGrid > 50;
  const gridColor = isExporting ? GRID_OUT : isImporting ? GRID_IN : MUTED;
  const gridLabel = isExporting ? "Exporting" : isImporting ? "Importing" : "Grid balanced";
  const tint = "rgba(255,255,255,0.72)";
  return (
    <div className="hero-card" style={{background:`linear-gradient(135deg,#FFFBEB,#FEF3C7)`,borderRadius:18,padding:"18px 18px 16px",marginBottom:16,border:`1px solid #FDE68A`,boxShadow:"0 2px 10px rgba(217,119,6,0.10)"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:10}}>
        <div style={{minWidth:0}}>
          <div style={{fontSize:FS.subhead,color:"#92400E",fontWeight:700,marginBottom:6,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
            <Icon name="sun" style={{color:SOLAR,fontSize:18}}/>Solar now
            {live&&<LiveBadge/>}
            {live ? <LiveChip atMs={liveAt}/> : <UpdatedChip time={updated}/>}
          </div>
          <div style={{fontSize:40,fontWeight:800,color:"#7C2D12",lineHeight:1,letterSpacing:"-1.2px"}}><CountUp value={totalPv} format={v=>fmt(v,2)} fromZero duration={0.9}/></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span className="ui-pill" style={{fontSize:FS.footnote,padding:"6px 12px",background:isExporting?"#DCFCE7":isImporting?"#FEE2E2":"#F1F5F9",border:`1px solid ${isExporting?"#86EFAC":isImporting?"#FECACA":"#E2E8F0"}`,color:textTone(gridColor)}}>
            <Icon name="pylon"/>{gridLabel}{(isExporting||isImporting)&&<CountUp value={Math.abs(totalGrid)} format={v=>fmt(v)}/>}
          </span>
          {gridFreq&&<span style={{fontSize:FS.caption,color:MUTED,fontWeight:500}}>{gridFreq.toFixed(2)} Hz</span>}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8}}>
        <StatTile tint={tint} icon="home" label="Home" num={totalLoad} format={v=>fmt(v,2)} color={LOAD_C}/>
        <StatTile tint={tint} icon={totalBat>10?"battery-charging":"battery"} label={totalBat>10?"Charging":totalBat<-10?"Discharging":"Battery"}
          value={Math.abs(totalBat)>10?null:"Idle"} num={Math.abs(totalBat)>10?Math.abs(totalBat):undefined} format={Math.abs(totalBat)>10?(v=>fmt(v)):undefined}
          color={totalBat>10?BATTERY:totalBat<-10?SOLAR:MUTED} sub={avgSoc!=null?`${avgSoc.toFixed(0)}% charged`:null}/>
        <StatTile tint={tint} icon="sun" label="Solar today" value={fmtE(totalToday)} color={TEXT}/>
        {totalImpToday>0&&<StatTile tint={tint} icon="arrow-down" label="Imported today" value={fmtE(totalImpToday)} color={GRID_IN}/>}
        {totalExpToday>0&&<StatTile tint={tint} icon="arrow-up" label="Exported today" value={fmtE(totalExpToday)} color={GRID_OUT}/>}
        {avgSelfSuff!=null&&<StatTile tint={tint} icon="shield" label="Self-sufficient" value={`${avgSelfSuff.toFixed(0)}%`} color={MUTED}/>}
      </div>
    </div>
  );
}

function BatteryPanel({statuses}) {
  const valid = statuses.filter(s => s?.ok && s?.data?.battery?.voltage > 0);
  if (!valid.length) return null;

  const n = valid.length;
  // Summed across inverters (each inverter has its own battery current/power)
  const totalCharge    = valid.reduce((s,i) => s + (i.data.battery.charge    || 0), 0);
  const totalDischarge = valid.reduce((s,i) => s + (i.data.battery.discharge || 0), 0);
  const totalCurrent   = valid.reduce((s,i) => s + (i.data.battery.current   || 0), 0);
  const totalChargeIn  = valid.reduce((s,i) => s + (i.data.battery.chargeIn?.total  || 0), 0);
  const totalDischargeOut = valid.reduce((s,i) => s + (i.data.battery.dischargeOut?.total || 0), 0);

  // Averaged (physical bank readings — same value reported by each inverter)
  const avgSoc     = valid.reduce((s,i) => s + (i.data.battery.soc           || 0), 0) / n;
  const avgVoltage = valid.reduce((s,i) => s + (i.data.battery.voltage        || 0), 0) / n;
  const avgHealth  = valid.reduce((s,i) => s + (i.data.battery.healthPercent  || 0), 0) / n;
  const avgTemp    = valid.reduce((s,i) => s + (i.data.battery.temperature    || 0), 0) / n;

  // Capacity: use first inverter (each reports its own bank; topology varies per site).
  // kWh is based on NOMINAL pack voltage (51.2 V), not the live voltage, so the rated capacity
  // is stable instead of drifting with state of charge.
  const firstBat = valid[0].data.battery;
  const capacityAh = firstBat.capacityAh;
  const NOMINAL_V = 51.2;
  const capacityKwhNum = capacityAh > 0 ? (capacityAh * NOMINAL_V) / 1000 : null;
  const capacityKwh = capacityKwhNum != null ? capacityKwhNum.toFixed(1) : null;

  // Live charge/discharge rate (% of rated capacity per hour) and time to full / time remaining.
  const netW = totalCharge - totalDischarge; // + = charging
  const energyNowKwh = capacityKwhNum != null ? capacityKwhNum * (avgSoc/100) : null;
  let rate = null;
  if (capacityKwhNum && Math.abs(netW) > 20) {
    const pctHr = (Math.abs(netW)/1000) / capacityKwhNum * 100;
    rate = netW > 0
      ? { sign:"+", pct:pctHr, hrs:(capacityKwhNum - energyNowKwh)/(netW/1000), label:"to full", color:BATTERY }
      : { sign:"−", pct:pctHr, hrs:energyNowKwh/(Math.abs(netW)/1000), label:"remaining", color:SOLAR };
  }

  // Open loop = no BMS brand on any inverter
  const closedLoop = valid.some(s => !!s.data.battery.brand);
  const brand = valid.find(s => s.data.battery.brand)?.data.battery.brand || "";
  // Freshest 5-min sample time across inverters (for the "Updated N ago" staleness chip).
  const updated = valid.map(s=>s.data.inverter?.lastUpdateTime).filter(Boolean).sort().slice(-1)[0] || null;

  const isCharging    = totalCharge    > 20;
  const isDischarging = totalDischarge > 20;
  const socColor = avgSoc > 60 ? BATTERY : avgSoc > 30 ? SOLAR : GRID_IN;

  return (
    <div className="ui-card" style={{padding:"16px 18px",marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:14,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}>
          <div style={{width:36,height:36,borderRadius:10,background:closedLoop?"#DCFCE7":"#F1F5F9",color:closedLoop?BATTERY_TEXT:MUTED,display:"flex",alignItems:"center",justifyContent:"center",fontSize:FS.title3,flexShrink:0}}><Icon name={isCharging?"battery-charging":"battery"}/></div>
          <div style={{minWidth:0}}>
            <div style={{fontSize:FS.callout,fontWeight:700,color:TEXT}}>{closedLoop ? brand : "Battery bank"}</div>
            <div style={{fontSize:FS.footnote,color:MUTED}}>
              {capacityAh > 0 && `${capacityAh} Ah`}
              {capacityKwh && ` · ~${capacityKwh} kWh`}
              {!closedLoop && <span style={{color:SOLAR_TEXT,fontWeight:600}}> · Open loop (no BMS)</span>}
            </div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <UpdatedChip time={updated}/>
          {isCharging    && <span className="ui-pill" style={{color:BATTERY_TEXT,background:"#DCFCE7"}}><Icon name="arrow-up"/>{fmt(totalCharge)}</span>}
          {isDischarging && <span className="ui-pill" style={{color:SOLAR_TEXT,background:"#FEF3C7"}}><Icon name="arrow-down"/>{fmt(totalDischarge)}</span>}
          {!isCharging && !isDischarging && <span className="ui-pill" style={{color:MUTED,background:"#F1F5F9"}}>Idle</span>}
        </div>
      </div>

      <div style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:8}}>
          <span style={{fontSize:FS.subhead,fontWeight:600,color:MUTED}}>Charge{!closedLoop && " (estimated)"}</span>
          <span style={{fontSize:FS.title1,fontWeight:800,color:textTone(socColor),letterSpacing:"-0.5px"}}><CountUp value={avgSoc} format={v=>`${Math.round(v)}%`}/></span>
        </div>
        <Meter value={avgSoc} color={`linear-gradient(90deg,${socColor},${socColor}CC)`} height={12} label="Battery state of charge"/>
        {rate
          ? <div style={{marginTop:8,fontSize:FS.subhead,fontWeight:600,color:textTone(rate.color)}}>{rate.sign}{rate.pct.toFixed(1)}%/hr · {fmtHrs(rate.hrs)} {rate.label}</div>
          : capacityKwhNum && <div style={{marginTop:8,fontSize:FS.subhead,fontWeight:500,color:MUTED}}>Idle</div>}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:8}}>
        <StatTile label="Voltage"  value={`${avgVoltage.toFixed(1)} V`} color={TEXT}/>
        <StatTile label="Current"  value={`${totalCurrent.toFixed(1)} A`} color={TEXT}/>
        {closedLoop && <StatTile label="Health" value={`${Math.round(avgHealth)}%`} color={avgHealth>80?BATTERY:avgHealth>60?SOLAR:GRID_IN}/>}
        {closedLoop && avgTemp > 0 && <StatTile icon="thermometer" label="Temperature" value={`${avgTemp.toFixed(0)}°C`} color={avgTemp>45?GRID_IN:avgTemp>35?SOLAR:TEXT}/>}
        {totalChargeIn    > 0 && <StatTile label="Lifetime in"  value={fmtE(totalChargeIn)}    color={MUTED}/>}
        {totalDischargeOut > 0 && <StatTile label="Lifetime out" value={fmtE(totalDischargeOut)} color={MUTED}/>}
      </div>
    </div>
  );
}

function LifetimePanel({statuses}) {
  const v = statuses.filter(s=>s?.ok&&s?.data);
  if(!v.length) return null;
  const pvTotal  = v.reduce((s,i)=>s+(i.data.photovoltaic?.production?.total||0),0);
  const expTotal = v.reduce((s,i)=>s+(i.data.grid?.sold?.total||0),0);
  const impTotal = v.reduce((s,i)=>s+(i.data.grid?.consumption?.total||0),0);
  const loadTotal= v.reduce((s,i)=>s+(i.data.load?.power?.total||0),0);
  if(!pvTotal) return null;
  return (
    <div className="ui-card" style={{padding:"16px 18px",marginBottom:16}}>
      <div className="ui-card-title" style={{marginBottom:12}}><Icon name="clock"/>Lifetime totals</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8}}>
        <StatTile icon="sun" label="Solar produced" value={fmtE(pvTotal)} color={CHART_PROD}/>
        <StatTile icon="arrow-up" label="Exported" value={fmtE(expTotal)} color={GRID_OUT}/>
        <StatTile icon="arrow-down" label="Imported" value={fmtE(impTotal)} color={GRID_IN}/>
        {loadTotal>0&&<StatTile icon="home" label="Home total" value={fmtE(loadTotal)} color={LOAD_C}/>}
      </div>
    </div>
  );
}

const FAULT_DESC = {
  "1":"DC bus over-voltage","2":"DC bus under-voltage","3":"DC bus soft-start failure",
  "4":"PV over-current","5":"PV over-voltage","6":"PV short circuit",
  "7":"Battery over-voltage","8":"Battery under-voltage","9":"Battery over-temperature",
  "10":"Battery under-temperature","11":"Battery over-current",
  "17":"AC output over-current","18":"AC output overload","19":"AC over-frequency",
  "20":"AC under-frequency","21":"Grid over-voltage","22":"Grid under-voltage",
  "23":"Grid over-frequency","24":"Grid under-frequency",
  "25":"Inverter over-temperature","26":"Fan failure","27":"Communication failure",
  "48":"Battery voltage deviation","50":"Grid frequency deviation",
};

function FaultPanel({site}) {
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const thirtyAgo = new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0];
  const [startDate, setStartDate] = useState(thirtyAgo);
  const [endDate, setEndDate] = useState(today);
  // Loads only on demand (Search button) — never auto-fetches on site view.
  const load = useCallback(()=>{
    if(!site||!startDate||!endDate) return;
    setLoading(true); setEvents(null); setExpanded(true);
    api("logsearch",{serials:site.inverters.map(i=>i.sn),startDate,endDate})
      .then(d=>setEvents(d.events||[]))
      .catch(()=>setEvents([]))
      .finally(()=>setLoading(false));
  },[site,startDate,endDate]);
  const activeCount = events?.filter(e=>e.status==="1").length||0;
  return (
    <div className="ui-card" style={{overflow:"hidden",marginBottom:16}}>
      <button type="button" aria-expanded={expanded} onClick={()=>setExpanded(x=>!x)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,minHeight:52,padding:"10px 16px",background:"transparent",border:"none",cursor:"pointer",fontFamily:SANS,textAlign:"left"}}>
        <span style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",minWidth:0}}>
          <span className="ui-card-title"><Icon name="alert"/>Fault log</span>
          {!loading&&events&&<span style={{fontSize:FS.footnote,color:MUTED}}>{events.length} events · {activeCount} active</span>}
          {!loading&&!events&&<span style={{fontSize:FS.footnote,color:MUTED}}>Pick a range and search</span>}
          {loading&&<span style={{fontSize:FS.footnote,color:MUTED}}>Searching…</span>}
        </span>
        <span className="chev" data-open={expanded?"true":"false"} style={{color:MUTED,fontSize:18,display:"inline-flex"}}><Icon name="chevron-down"/></span>
      </button>
      {expanded&&(
        <>
          <div style={{borderTop:`1px solid ${BORDER}`,padding:"10px 16px",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <input type="date" className="ui-field" aria-label="From" value={startDate} onChange={e=>setStartDate(e.target.value)}/>
            <span style={{fontSize:FS.subhead,color:MUTED}}>to</span>
            <input type="date" className="ui-field" aria-label="To" value={endDate} max={today} onChange={e=>setEndDate(e.target.value)}/>
            <Button variant="primary" size="sm" icon="search" onClick={load} disabled={loading||!startDate||!endDate}>{loading?"Searching…":"Search"}</Button>
          </div>
          <div style={{borderTop:`1px solid ${BORDER}`,overflowY:"auto",maxHeight:360,padding:"4px 0"}}>
            {loading&&<div style={{padding:"12px 16px"}}><div className="ui-skel" style={{height:44,borderRadius:10,marginBottom:8}}/><div className="ui-skel" style={{height:44,borderRadius:10}}/></div>}
            {!loading&&!events&&<EmptyState icon="search" title="No search yet" hint="Pick a date range and press Search."/>}
            {!loading&&events?.length===0&&<EmptyState icon="check" title="No faults in this range" hint="Nothing was logged between these dates."/>}
            {!loading&&events?.map((e,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"auto 1fr auto",gap:10,padding:"10px 16px",borderBottom:i<events.length-1?`1px solid ${BORDER}`:"none",alignItems:"start"}}>
                <span className="ui-pill" style={{color:e.status==="1"?GRID_IN_TEXT:BATTERY_TEXT,background:e.status==="1"?"#FEF2F2":"#DCFCE7"}}>{e.status==="1"?"Active":"Cleared"}</span>
                <div>
                  <div style={{fontSize:FS.footnote,fontWeight:600,color:TEXT}}>Code {e.ErrorCode}: {FAULT_DESC[e.ErrorCode]||"Unrecognized code"}</div>
                  <div style={{fontSize:FS.caption,color:MUTED}}>{e.GoodsID}</div>
                </div>
                <span style={{fontSize:FS.caption,color:MUTED,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{(e.Time||"").slice(5,16)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Inverter settings map (device-shadow config registers → plain-English names). ONLY registers we're
// CERTAIN of are included — labels captured directly from the Remote-Setting form (bound to the register
// code), not value-guessed. Raw register scaling: voltages ×10 (scale 0.1), frequencies ×100 (scale 0.01),
// power/percent/time/etc ×1. Enum/dropdown and 32-bit protection-time fields are omitted (not certain).
const SETTINGS_MAP = [
  // Power Control
  { code:"30BA", label:"Maximum Feed-In Grid Power",        group:"Power Control", unit:"W" },
  { code:"308E", label:"Maximum Consumption From Grid",     group:"Power Control", unit:"W" },
  // Dropdown registers hold sparse value codes (NOT option positions) — only value↔label pairs
  // confirmed on a real inverter are mapped; unknown values render as "(raw)".
  { code:"2100", label:"Work Mode",            group:"Power Control", enum:{0:"Self Consumption",3:"Off Grid"} },
  { code:"2141", label:"Support Normal Load",  group:"Power Control", bool:true },
  { code:"215B", label:"Zero Export",          group:"Power Control", bool:true },
  { code:"214C", label:"TimeBase Control",     group:"Power Control", bool:true },
  { code:"30B5", label:"Sensor Location",      group:"Power Control", enum:{0:"Grid Side",1:"Load Side"} },
  { code:"30B2", label:"Energy Flow Direction",group:"Power Control", enum:{0:"From Grid To Inverter",1:"From Inverter To Grid"} },
  { code:"30B3", label:"Power Control",         group:"Power Control", enum:{0:"Disable",3:"Smart Meter"} },
  { code:"30B0", label:"Meter Modbus Address",  group:"Power Control" },
  { code:"3089", label:"Power Derating Control Method", group:"Power Control", enum:{0:"Minimum Phase Power",1:"Independent Phase Power",2:"Total Power"} },
  { code:"30B1", label:"Meter Type",            group:"Power Control", enum:{1:"Unknown",2:"CHINT/DTSU666",3:"CHINT/DDSU666"} },
  // Generator
  { code:"2127", label:"Maximum Input Power From Generator", group:"Generator", unit:"W" },
  { code:"2126", label:"Maximum Generator Charge Power",     group:"Generator", unit:"W" },
  { code:"2134", label:"Generator Start Voltage",           group:"Generator", unit:"V", scale:0.1 },
  { code:"2135", label:"Generator End Voltage",             group:"Generator", unit:"V", scale:0.1 },
  { code:"2137", label:"Generator Standby Time",            group:"Generator", unit:"min" },
  { code:"2136", label:"Generator Max Run Time",            group:"Generator", unit:"min" },
  { code:"213F", label:"Generator Input Location (Grid Side)", group:"Generator", bool:true },
  // Battery
  { code:"2110", label:"Battery Brand", group:"Battery", enum:{17:"MidNite Battery",33:"Lithium Battery (No BMS)"} },
  // Capacity Mode (0 = SOC %, 1 = Voltage) selects whether the charge/discharge setpoints below are
  // percentages or volts. The Settings + Compare views show only the matching set (mode:"soc"/"voltage").
  { code:"2124", label:"Capacity Mode", group:"Battery", enum:{0:"SOC (%)",1:"Voltage (V)"} },
  { code:"2115", label:"Charge By Grid",  group:"Battery", bool:true },
  { code:"218C", label:"Force Charging",  group:"Battery", bool:true },
  { code:"21B4", label:"Battery Charge Efficiency",         group:"Battery", unit:"%" },
  { code:"21B5", label:"Battery Rated Temperature",         group:"Battery", unit:"°C" },
  { code:"214F", label:"Lead-Acid Battery Impedance",       group:"Battery", unit:"mΩ" },
  { code:"2118", label:"Maximum Charge Power",              group:"Battery", unit:"W" },
  { code:"211A", label:"Maximum Discharge Power",           group:"Battery", unit:"W" },
  { code:"2116", label:"Maximum Allowed Charging Power",    group:"Battery", unit:"W" },
  { code:"2150", label:"Maximum Grid Recovery Charge Power",group:"Battery", unit:"W" },
  // SOC-mode setpoints (shown when Capacity Mode = SOC). Raw integer percent (no scale).
  { code:"211B", label:"Discharge To",                     group:"Battery", unit:"%", mode:"soc" },
  { code:"2119", label:"Charge To",                        group:"Battery", unit:"%", mode:"soc" },
  { code:"2144", label:"Start Recovery Charging At",       group:"Battery", unit:"%", mode:"soc" },
  { code:"2145", label:"Stop Recovery Charging At",        group:"Battery", unit:"%", mode:"soc" },
  { code:"214A", label:"Discharge End SOC (On-Grid)",      group:"Battery", unit:"%", mode:"soc" },
  // Voltage-mode setpoints (shown when Capacity Mode = Voltage) — twins of the SOC rows above.
  { code:"2113", label:"Stop Discharge Voltage",           group:"Battery", unit:"V", scale:0.1, mode:"voltage" },
  { code:"2114", label:"Floating Charge Voltage",          group:"Battery", unit:"V", scale:0.1, mode:"voltage" },
  { code:"2180", label:"Absorb Voltage Setpoint",          group:"Battery", unit:"V", scale:0.1, mode:"voltage" },
  { code:"2146", label:"Start Recovery Charge Voltage",    group:"Battery", unit:"V", scale:0.1, mode:"voltage" },
  { code:"2147", label:"Stop Recovery Charge Voltage",     group:"Battery", unit:"V", scale:0.1, mode:"voltage" },
  { code:"214B", label:"Discharge End Voltage (On-Grid)",  group:"Battery", unit:"V", scale:0.1, mode:"voltage" },
  // Always shown (protection / maintenance — independent of Capacity Mode)
  { code:"2148", label:"Stop Charging Voltage",            group:"Battery", unit:"V", scale:0.1 },
  { code:"212F", label:"Stop Discharge Reconnect Voltage (Off-Grid)", group:"Battery", unit:"V", scale:0.1 },
  { code:"2181", label:"Equalize Voltage",                  group:"Battery", unit:"V", scale:0.1 },
  { code:"2182", label:"Equalize Time",                     group:"Battery", unit:"min" },
  { code:"2183", label:"Max Time To Attempt Equalize",      group:"Battery", unit:"min" },
  { code:"2184", label:"Days Between Auto Equalize",        group:"Battery", unit:"days" },
  { code:"2186", label:"Absorb Time",                       group:"Battery", unit:"min" },
  // General
  { code:"2143", label:"Parallel Mode",                  group:"General", bool:true },
  { code:"5112", label:"Low Voltage Ride Through",       group:"General", bool:true },
  { code:"510E", label:"Anti-Islanding",                 group:"General", bool:true },
  { code:"3088", label:"DRM Function",                   group:"General", bool:true },
  { code:"2140", label:"Buzzer",                         group:"General", bool:true },
  { code:"5104", label:"Derating Setting",                  group:"General", unit:"%" },
  { code:"501B", label:"PV Insulation Resistance Protection",group:"General", unit:"kΩ" },
  { code:"5110", label:"PV Leakage Current Protection",     group:"General", unit:"mA" },
  // Grid
  { code:"5101", label:"Grid Standard Code", group:"Grid", enum:{18:"US (IEEE1547)"} },
  { code:"2125", label:"Maximum Input Power From Grid",     group:"Grid", unit:"W" },
  { code:"5000", label:"First Boot Delay Time",             group:"Grid", unit:"s" },
  { code:"5029", label:"First Boot Power Gradient",         group:"Grid", unit:"%" },
  { code:"5001", label:"Reconnect Delay Time",              group:"Grid", unit:"s" },
  { code:"5019", label:"Reconnect Power Gradient",          group:"Grid", unit:"%" },
  { code:"507A", label:"Grid First High Voltage",           group:"Grid", unit:"V", scale:0.1 },
  { code:"507B", label:"Grid First Low Voltage",            group:"Grid", unit:"V", scale:0.1 },
  { code:"5078", label:"Grid First High Frequency",         group:"Grid", unit:"Hz", scale:0.01 },
  { code:"5079", label:"Grid First Low Frequency",          group:"Grid", unit:"Hz", scale:0.01 },
  { code:"5027", label:"Grid Reconnect High Voltage",       group:"Grid", unit:"V", scale:0.1 },
  { code:"5028", label:"Grid Reconnect Low Voltage",        group:"Grid", unit:"V", scale:0.1 },
  { code:"5012", label:"Grid Reconnect High Frequency",     group:"Grid", unit:"Hz", scale:0.01 },
  { code:"5013", label:"Grid Reconnect Low Frequency",      group:"Grid", unit:"Hz", scale:0.01 },
  { code:"5004", label:"Over-Voltage Trip 1",              group:"Grid", unit:"V", scale:0.1 },
  { code:"500C", label:"Over-Voltage Trip 2",              group:"Grid", unit:"V", scale:0.1 },
  { code:"5005", label:"Under-Voltage Trip 1",             group:"Grid", unit:"V", scale:0.1 },
  { code:"500D", label:"Under-Voltage Trip 2",             group:"Grid", unit:"V", scale:0.1 },
  { code:"5002", label:"Over-Frequency Trip 1",            group:"Grid", unit:"Hz", scale:0.01 },
  { code:"500A", label:"Over-Frequency Trip 2",            group:"Grid", unit:"Hz", scale:0.01 },
  { code:"5003", label:"Under-Frequency Trip 1",           group:"Grid", unit:"Hz", scale:0.01 },
  { code:"500B", label:"Under-Frequency Trip 2",           group:"Grid", unit:"Hz", scale:0.01 },
];
function fmtSetting(s, raw){
  if(raw===undefined||raw===null||raw==="") return "—";
  const n = parseFloat(raw);
  if(s.enum) return s.enum[n] ?? `(${raw})`;
  if(s.bool) return Number(n)?"On":"Off";
  if(!isFinite(n)) return String(raw);
  const v = s.scale ? n*s.scale : n;
  const out = Number.isInteger(v) ? v : parseFloat(v.toFixed(2));
  return `${out}${s.unit?` ${s.unit}`:""}`;
}
function SettingsModal({inv, onClose}){
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(()=>{
    if(!inv.autoId){ setErr("No AutoId for this inverter (settings need installer access)."); return; }
    let alive = true;
    api("readsettings", { autoId: inv.autoId, sn: inv.sn, codes: SETTINGS_MAP.map(s=>s.code) })
      .then(r=>{ if(alive) setData(r?.data || {}); })
      .catch(e=>{ if(alive) setErr(String(e)); });
    return ()=>{ alive=false; };
  }, [inv.autoId]);
  const groups = [...new Set(SETTINGS_MAP.map(s=>s.group))];
  // Capacity Mode (2124): 0 = SOC %, 1 = Voltage. Show only the matching setpoint set; absent → voltage
  // (legacy default). Rows without a `mode` (power limits, protection, etc.) always show.
  const isSoc = !!data && String(data["2124"]) === "0";
  const modeOk = (s)=> !s.mode || s.mode === (isSoc ? "soc" : "voltage");
  const shown = (g)=> SETTINGS_MAP.filter(s=>s.group===g && data && (s.code in data) && modeOk(s));
  return (
    <Sheet title={`${inv.label} settings`} subtitle={<span style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>{inv.sn}</span>} onClose={onClose} maxWidth={560}
      leading={<span style={{width:40,height:40,borderRadius:10,background:"#F5F1EB",color:MUTED,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}><Icon name="sliders"/></span>}>
        <div>
          {err && <div role="alert" style={{...errBox,display:"flex",gap:6,alignItems:"center"}}><Icon name="alert"/>{err}</div>}
          {!err && !data && <div role="status" aria-label="Reading settings"><div style={{fontSize:FS.subhead,color:MUTED,marginBottom:12}}>Reading live settings from the inverter…</div>{[0,1,2,3,4,5].map(i=><div key={i} className="ui-skel" style={{height:40,borderRadius:8,marginBottom:6}}/>)}</div>}
          {!err && data && groups.map(g=>{
            const rows = shown(g);
            if(!rows.length) return null;
            return (
              <div key={g} style={{marginBottom:16}}>
                <div className="ui-section-label">{toSentence(g)}</div>
                <div className="ui-group">
                  {rows.map(s=>(
                    <div key={s.code} className="ui-row" style={{minHeight:48,justifyContent:"space-between"}}>
                      <span style={{fontSize:FS.body,color:TEXT}}>{toSentence(s.label)}</span>
                      <span style={{fontSize:FS.body,fontWeight:700,color:TEXT,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{fmtSetting(s, data[s.code])}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          {!err && data && (
            <div style={{fontSize:FS.footnote,color:MUTED,marginTop:8,lineHeight:1.5}}>Read only. Only settings we’ve mapped with certainty are shown ({SETTINGS_MAP.length} so far); the list grows as more registers are matched to the inverter’s setting screens.</div>
          )}
        </div>
    </Sheet>
  );
}
// Vendor setting names arrive in Title Case ("Maximum Feed-In Grid Power"); show them in sentence case,
// keeping acronyms (SOC, EPS), words with digits, mixed-case names (TimeBase) and proper nouns.
const KEEP_CASE = new Set(["Modbus","MidNite","Midnite","Wi-Fi","Li-ion"]);
const toSentence = (label="") => String(label).split(" ").map((w,i)=>{
  if(i===0 || KEEP_CASE.has(w) || /\d/.test(w) || /[A-Z].*[A-Z]/.test(w.replace(/-[A-Z]/g,"-x"))) return w;
  return w.toLowerCase();
}).join(" ");
// Fleet settings comparison — settings as rows, inverters as columns; rows that differ are highlighted.
function SettingsCompareModal({inverters, onClose}){
  const cols = inverters.filter(i=>i.autoId);
  const [data, setData] = useState(null);   // sn -> {code:value}
  const [done, setDone] = useState(0);
  const [diffOnly, setDiffOnly] = useState(false);
  useEffect(()=>{
    let alive = true;
    const map = {};
    Promise.all(cols.map(inv=>
      api("readsettings", { autoId: inv.autoId, sn: inv.sn, codes: SETTINGS_MAP.map(s=>s.code) })
        .then(r=>{ map[inv.sn]=r?.data||{}; })
        .catch(()=>{ map[inv.sn]={}; })
        .finally(()=>{ if(alive) setDone(d=>d+1); })
    )).then(()=>{ if(alive) setData(map); });
    return ()=>{ alive=false; };
  }, []);
  const groups = [...new Set(SETTINGS_MAP.map(s=>s.group))];
  // Each inverter shows its own Capacity Mode's setpoints (2124: 0=SOC, 1=Voltage); the off-mode twin
  // is blanked so a SOC-mode unit shows % and a Voltage-mode unit shows V in the same comparison.
  const isSocInv = (sn)=> String(data?.[sn]?.["2124"]) === "0";
  const valsOf = (s)=> cols.map(inv=> {
    const raw = data?.[inv.sn]?.[s.code];
    if(raw===undefined||raw==="") return null;
    if(s.mode && s.mode !== (isSocInv(inv.sn) ? "soc" : "voltage")) return null;
    return fmtSetting(s, raw);
  });
  const isDiff = (vals)=>{ const p = vals.filter(v=>v!=null); return p.length>1 && new Set(p).size>1; };
  const rows = SETTINGS_MAP.map(s=>({ s, vals: valsOf(s) })).filter(r=> r.vals.some(v=>v!=null) && (!diffOnly || isDiff(r.vals)));
  const diffCount = SETTINGS_MAP.map(s=>valsOf(s)).filter(isDiff).length;
  const exportCsv = () => {
    const esc = (v)=>`"${String(v==null?"":v).replace(/"/g,'""')}"`;
    const lines = [["Section","Setting",...cols.map(c=>c.label),"Differs"].map(esc).join(",")];
    for(const {s,vals} of rows) lines.push([s.group, s.label, ...vals.map(v=>v==null?"":v), isDiff(vals)?"Yes":""].map(esc).join(","));
    const blob = new Blob(["﻿"+lines.join("\r\n")], {type:"text/csv;charset=utf-8"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `inverter-settings-${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  };
  return (
    <Sheet maxWidth={1100} flush onClose={onClose} title="Compare inverter settings"
      subtitle={data ? `${cols.length} inverters · ${diffCount} setting${diffCount===1?"":"s"} differ` : `Reading ${done} of ${cols.length}…`}
      toolbar={data && <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
        <Segmented size="sm" label="Show" value={diffOnly?"diff":"all"} onChange={v=>setDiffOnly(v==="diff")} options={[{value:"all",label:"All settings"},{value:"diff",label:`Differences (${diffCount})`}]}/>
        {rows.length>0 && <Button size="sm" icon="download" onClick={exportCsv}>Export CSV</Button>}
      </div>}>
        <div>
          {!data && <div style={{padding:16}} role="status" aria-label="Reading settings">{[0,1,2,3,4,5,6].map(i=><div key={i} className="ui-skel" style={{height:36,borderRadius:8,marginBottom:6}}/>)}</div>}
          {data && cols.length===0 && <EmptyState icon="lock" title="No inverters with installer access" hint="Settings can be read only through an installer account."/>}
          {data && cols.length>0 && (
            <table style={{borderCollapse:"collapse",width:"100%",fontSize:FS.footnote}}>
              <thead><tr>
                <th style={{textAlign:"left",padding:"10px 14px",fontSize:FS.footnote,color:MUTED,fontWeight:600,position:"sticky",left:0,top:0,zIndex:3,background:CARD,minWidth:200,boxShadow:`inset 0 -1px 0 ${BORDER}`}}>Setting</th>
                {cols.map(inv=><th key={inv.sn} style={{textAlign:"right",padding:"10px 14px",fontSize:FS.footnote,color:TEXT,fontWeight:700,whiteSpace:"nowrap",position:"sticky",top:0,zIndex:2,background:CARD,boxShadow:`inset 0 -1px 0 ${BORDER}`}}>{inv.label}</th>)}
              </tr></thead>
              <tbody>
                {groups.flatMap(g=>{
                  const grows = rows.filter(r=>r.s.group===g);
                  if(!grows.length) return [];
                  return [
                    <tr key={"h-"+g}><td colSpan={cols.length+1} style={{padding:"14px 14px 6px",fontSize:FS.footnote,color:MUTED,fontWeight:600}}><span style={{position:"sticky",left:14}}>{toSentence(g)}</span></td></tr>,
                    ...grows.map(({s,vals})=>{
                      const diff = isDiff(vals);
                      return (
                        <tr key={s.code} style={{background:diff?"#FEF3C7":"transparent",borderTop:`1px solid ${BORDER}`}}>
                          <td style={{textAlign:"left",padding:"10px 14px",color:TEXT,position:"sticky",left:0,background:diff?"#FEF3C7":CARD,whiteSpace:"nowrap"}}>{diff&&<Icon name="alert" label="Differs" style={{color:SOLAR_TEXT,marginRight:6}}/>}{toSentence(s.label)}</td>
                          {vals.map((v,i)=><td key={i} style={{textAlign:"right",padding:"10px 14px",color:v==null?MUTED:TEXT,fontWeight:diff?700:500,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{v==null?"—":v}</td>)}
                        </tr>
                      );
                    })
                  ];
                })}
              </tbody>
            </table>
          )}
        </div>
    </Sheet>
  );
}
function InverterCard({inv, status, live}) {
  const [showSettings, setShowSettings] = useState(false);
  const d = status?.data;
  // Prefer live flowrt values (5s) for solar and home load — the 5-min snapshot can be stale by several
  // minutes (or capture a 0W moment) while the inverter is actively producing. live.pv = TotalDCpower;
  // load from EPS port (AIO serves house through smart/EPS port, so loadCurrpac=0, epsCurrpac=real load).
  const pvStatus = d?.photovoltaic?.power?.totalDc ?? null;
  const pvLive = (live && !live.noData && live.pv > 0) ? live.pv : null;
  const pv = pvLive ?? pvStatus;
  const loadStatus = balanceLoad(d);
  const loadLive = (live && !live.noData) ? (live.load > 0 ? live.load : (live.eps || 0)) : 0;
  const load = loadLive > 0 ? loadLive : loadStatus;
  const gridNet = d?.grid?.netW ?? null;
  const soc = d?.battery?.soc ?? null;
  const batChg = d?.battery?.charge ?? null;
  const batDis = d?.battery?.discharge ?? null;
  const temp = d?.inverter?.temperature ?? null;
  // The older status call always reports online; treat 30+ minutes without a report as offline.
  const reportAge = ageMin(d?.inverter?.lastUpdateTime);
  const online = (d?.inverter?.online ?? false) && !(reportAge!=null && reportAge>30);
  const eToday = d?.photovoltaic?.production?.today ?? null;
  const gridColor = gridNet!=null ? (gridNet<0?GRID_OUT:GRID_IN) : FAINT;
  const gridLabel = gridNet!=null ? (gridNet<0?"Exporting":"Importing") : "Grid";
  const model = d?.inverter?.model||null;
  const gridFreq = d?.grid?.lines?.[0]?.frequency>0 ? d.grid.lines[0].frequency : null;
  const l1Volt = d?.grid?.lines?.[0]?.voltage>0 ? d.grid.lines[0].voltage : null;
  const l2Volt = d?.grid?.lines?.[1]?.voltage>0 ? d.grid.lines[1].voltage : null;
  const gridInToday = d?.grid?.consumption?.today||0;
  const gridOutToday = d?.grid?.sold?.today||0;
  const mppts = d?.photovoltaic?.mppts||[];
  // Only show the PV Strings section when at least one MPPT has panel voltage — voltage > 0 indicates
  // a connected string even when a stale snapshot captured 0W current. All-zero (voltage AND power)
  // means no data at all: either no strings or the rich endpoint isn't available.
  const hasAnyMpptData = mppts.some(m => (m.voltage||0) > 0 || (m.power||0) > 0);
  const activePorts = d?.smartPorts ? Object.entries(d.smartPorts).filter(([,p])=>p&&(p.lines||[]).reduce((s,l)=>s+(l.power||0),0)>0) : [];
  return (
    <div className="inv-card ui-card" style={{overflow:"hidden",display:"flex",flexDirection:"column"}}>
      <div style={{height:3,background:online?`linear-gradient(90deg,${SOLAR},${BATTERY})`:"#E5E7EB"}}/>
      <div style={{padding:"14px 16px 12px",flex:1}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10,marginBottom:12}}>
          <div style={{display:"flex",gap:10,minWidth:0}}>
            <div style={{width:36,height:36,borderRadius:10,background:"#F5F1EB",color:MUTED,display:"flex",alignItems:"center",justifyContent:"center",fontSize:FS.title3,flexShrink:0}}><Icon name="inverter"/></div>
            <div style={{minWidth:0}}>
              <div style={{fontSize:FS.headline,fontWeight:700,color:TEXT,lineHeight:1.2}}>{inv.label}</div>
              {model&&<div style={{fontSize:FS.footnote,color:MUTED,marginTop:1}}>{model}</div>}
              <div style={{fontSize:FS.caption,color:MUTED,marginTop:1,fontVariantNumeric:"tabular-nums",fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace"}}>{inv.sn}</div>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4,flexShrink:0}}>
            <span className="ui-pill" style={{background:online?"#DCFCE7":"#FEE2E2",color:online?BATTERY_TEXT:GRID_IN_TEXT}}>
              <span className="ui-dot" style={{background:online?BATTERY:GRID_IN}}/>{online?"Online":"Offline"}
            </span>
            {gridFreq&&<span style={{fontSize:FS.caption,color:MUTED,fontWeight:500}}>{gridFreq.toFixed(2)} Hz</span>}
            <UpdatedChip time={d?.inverter?.lastUpdateTime}/>
          </div>
        </div>
        {status?.ok===false&&<div style={{fontSize:FS.subhead,color:GRID_IN_TEXT,padding:"8px 10px",background:"#FEF2F2",borderRadius:8,marginBottom:8,display:"flex",gap:6,alignItems:"center"}}><Icon name="alert"/>{status.error||"No data"}</div>}
        {d&&(
          <>
            {/* Main stats */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              <StatTile icon="sun" label="Solar" num={pv} format={v=>fmt(v)} color={SOLAR}/>
              <StatTile icon="home" label="Home" num={load} format={v=>fmt(v)} color={LOAD_C}/>
              <StatTile icon="pylon" label={gridLabel} num={gridNet!=null?Math.abs(gridNet):null} format={v=>fmt(v)} color={gridColor}/>
              <StatTile icon={batChg>10?"battery-charging":"battery"} label={batChg>10?"Charging":batDis>10?"Discharging":"Battery"} num={batChg>10?batChg:batDis>10?batDis:0} format={v=>fmt(v)} color={batChg>10?BATTERY:batDis>10?SOLAR:MUTED}/>
            </div>
            {/* MPPT strings */}
            {hasAnyMpptData&&(
              <div style={{marginBottom:10,padding:"10px 12px",background:BG,borderRadius:12}}>
                <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,marginBottom:6}}>Solar strings</div>
                {mppts.map((m,i)=>{
                  const v=m.voltage||0, a=m.current||0, w=m.power||0;
                  return (
                    <div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:FS.footnote,marginBottom:i<mppts.length-1?4:0}}>
                      <span style={{color:MUTED,fontWeight:600}}>MPPT {i+1}</span>
                      {v>0||w>0
                        ? <span style={{color:w>0?SOLAR_TEXT:MUTED,fontVariantNumeric:"tabular-nums"}}>{v.toFixed(0)} V · {a.toFixed(2)} A · {fmt(w)}</span>
                        : <span style={{color:MUTED}}>Off</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Smart Ports */}
            {activePorts.length>0&&(
              <div style={{marginBottom:10,padding:"10px 12px",background:"#F0FDF4",borderRadius:12,border:`1px solid #DCFCE7`}}>
                <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,marginBottom:6}}>Smart ports</div>
                {activePorts.map(([key,port])=>{
                  const w=(port.lines||[]).reduce((s,l)=>s+(l.power||0),0);
                  return (
                    <div key={key} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:FS.footnote,marginBottom:2}}>
                      <span style={{color:MUTED,fontWeight:600}}>Port {key}</span>
                      <span style={{color:BATTERY_TEXT,fontVariantNumeric:"tabular-nums"}}>{fmt(w)} · {fmtE(port.power?.today||0)} today</span>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Battery SOC */}
            <div style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <span style={{fontSize:FS.footnote,color:MUTED,fontWeight:600}}>Battery</span>
                {temp!=null&&<span style={{fontSize:FS.footnote,color:MUTED,display:"inline-flex",alignItems:"center",gap:3}}><Icon name="thermometer"/>{temp}°C</span>}
              </div>
              {soc!=null&&<SOCBar value={soc}/>}
            </div>
            {/* L1/L2 voltage pills */}
            {(l1Volt||l2Volt)&&(
              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                {l1Volt&&<span style={{fontSize:FS.caption,color:MUTED,background:BG,padding:"3px 8px",borderRadius:6,fontVariantNumeric:"tabular-nums"}}>L1 {l1Volt.toFixed(1)} V</span>}
                {l2Volt&&<span style={{fontSize:FS.caption,color:MUTED,background:BG,padding:"3px 8px",borderRadius:6,fontVariantNumeric:"tabular-nums"}}>L2 {l2Volt.toFixed(1)} V</span>}
              </div>
            )}
            {/* Today summary */}
            <div style={{paddingTop:10,borderTop:`1px solid ${BORDER}`,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(80px,1fr))",gap:6}}>
              <div>
                <div style={{fontSize:FS.caption,color:MUTED,fontWeight:600,marginBottom:2}}>Solar today</div>
                <div style={{fontSize:FS.subhead,fontWeight:700,color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmtE(eToday)}</div>
              </div>
              {gridInToday>0&&<div>
                <div style={{fontSize:FS.caption,color:MUTED,fontWeight:600,marginBottom:2}}>Imported</div>
                <div style={{fontSize:FS.subhead,fontWeight:700,color:GRID_IN_TEXT,fontVariantNumeric:"tabular-nums"}}>{fmtE(gridInToday)}</div>
              </div>}
              {gridOutToday>0&&<div>
                <div style={{fontSize:FS.caption,color:MUTED,fontWeight:600,marginBottom:2}}>Exported</div>
                <div style={{fontSize:FS.subhead,fontWeight:700,color:GRID_OUT_TEXT,fontVariantNumeric:"tabular-nums"}}>{fmtE(gridOutToday)}</div>
              </div>}
            </div>
          </>
        )}
        {!d&&!status&&<div style={{fontSize:FS.subhead,color:MUTED,textAlign:"center",padding:"12px 0"}}>Connecting…</div>}
      </div>
      {inv.autoId&&<div style={{borderTop:`1px solid ${BORDER}`,padding:"2px 8px"}}>
        <button type="button" className="ui-rowlink" onClick={()=>setShowSettings(true)}><span style={{display:"inline-flex",alignItems:"center",gap:8}}><Icon name="sliders"/>Inverter settings</span><Icon name="chevron"/></button>
      </div>}
      {showSettings&&<SettingsModal inv={inv} onClose={()=>setShowSettings(false)}/>}
    </div>
  );
}

function SectionCard({title, icon, children, fullWidth}) {
  return (
    <div className="ui-card" style={{padding:"16px 18px",...(fullWidth?{gridColumn:"1/-1"}:{})}}>
      <div className="ui-card-title" style={{marginBottom:12}}>{icon&&<Icon name={icon}/>}{title}</div>
      {children}
    </div>
  );
}

function PhaseRow({label, line, exportWhenNegative}) {
  if(!line||(!(line.voltage>0)&&!(line.power>0))) return null;
  const exporting = exportWhenNegative && (line.current||0) < 0;
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${BORDER}`}}>
      <span style={{fontSize:FS.footnote,fontWeight:600,color:MUTED,minWidth:22}}>{label}</span>
      <div style={{display:"flex",gap:14,fontSize:FS.footnote,fontVariantNumeric:"tabular-nums"}}>
        <span style={{color:MUTED}}>{(line.voltage||0).toFixed(1)} V</span>
        <span style={{color:MUTED}}>{Math.abs(line.current||0).toFixed(1)} A</span>
        <span style={{fontWeight:700,color:exporting?GRID_OUT_TEXT:LOAD_C}}>{fmt(Math.abs(line.power||0))}</span>
      </div>
    </div>
  );
}

function InverterDetailPanel({inv, status}) {
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const d = status?.data;
  if(!d) return <div className="ui-card"><EmptyState icon="refresh" title="Connecting to this inverter…" hint="Waiting for its first report."/></div>;

  const stateLabel   = d.inverter?.state  != null ? (INV_STATE_LABELS[d.inverter.state]  || `State ${d.inverter.state}`)  : null;
  const workLabel    = d.inverter?.workMode != null ? (WORK_MODE_LABELS[d.inverter.workMode] || `Mode ${d.inverter.workMode}`) : null;
  const stateColor   = d.inverter?.state === 3 ? BATTERY : d.inverter?.state === 5 ? GRID_IN : MUTED;
  const pvTotal      = d.photovoltaic?.power?.totalDc || 0;
  const pvPeak       = d.photovoltaic?.power?.peak    || 0;
  const pvToday      = d.photovoltaic?.production?.today  || 0;
  const pvLifetime   = d.photovoltaic?.production?.total  || 0;
  const mppts        = d.photovoltaic?.mppts || [];
  const bat          = d.battery || {};
  const gridLines    = d.grid?.lines || [];
  const gridNetW     = d.grid?.netW  || 0;
  const isExporting  = gridNetW < -50;
  const isImporting  = gridNetW > 50;
  const gridFreq     = gridLines.find(l=>l.frequency>0)?.frequency || 0;
  const loadLines    = d.load?.lines || [];
  const loadW        = balanceLoad(d) || 0;
  const loadFreq     = loadLines.find(l=>l.frequency>0)?.frequency || 0;
  const smartPorts   = d.smartPorts ? Object.entries(d.smartPorts).filter(([,p])=>p&&((p.lines||[]).some(l=>l.power>0)||(p.power?.total||0)>0)) : [];
  const hasGen       = d.gen && (d.gen.lines||[]).some(l=>(l.power||0)>0);

  return (
    <div style={{display:"grid",gap:12,gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))"}}>

      {/* Summary hero — full width */}
      <div style={{gridColumn:"1/-1",background:`linear-gradient(135deg,#FFFBEB,#FEF3C7)`,borderRadius:16,padding:"18px 20px",border:`1px solid #FDE68A`,boxShadow:"0 2px 8px rgba(217,119,6,0.08)"}}>
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
          <div>
            <div style={{fontSize:FS.subhead,color:"#92400E",fontWeight:700,marginBottom:6,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
              <Icon name="sun" style={{color:SOLAR,fontSize:18}}/>{inv.label} solar now <span style={{fontFamily:"ui-monospace,SFMono-Regular,Menlo,monospace",fontWeight:500,color:MUTED}}>{d.inverter?.model?`${d.inverter.model} · `:""}{inv.sn}</span>
            </div>
            <div style={{fontSize:36,fontWeight:800,color:"#7C2D12",lineHeight:1,letterSpacing:"-1px"}}><CountUp value={pvTotal} format={v=>fmt(v,2)}/></div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            {stateLabel&&<span className="ui-pill" style={{color:textTone(stateColor),background:stateColor===BATTERY?"#DCFCE7":stateColor===GRID_IN?"#FEE2E2":"#F1F5F9"}}><span className="ui-dot" style={{background:stateColor}}/>{stateLabel}</span>}
            {workLabel&&<span style={{fontSize:FS.caption,color:MUTED,fontWeight:500}}>{workLabel}</span>}
            <UpdatedChip time={d.inverter?.lastUpdateTime}/>
            {inv.autoId&&<Button size="sm" icon="sliders" iconRight="chevron" onClick={()=>setShowSettings(true)}>Inverter settings</Button>}
          </div>
        </div>
        {showSettings&&<SettingsModal inv={inv} onClose={()=>setShowSettings(false)}/>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:8}}>
          <StatTile tint="rgba(255,255,255,0.72)" label="PV today"       value={fmtE(pvToday)}   color={TEXT}/>
          <StatTile tint="rgba(255,255,255,0.72)" label="PV lifetime"    value={fmtE(pvLifetime)} color={TEXT}/>
          {pvPeak>0&&<StatTile tint="rgba(255,255,255,0.72)" label="Peak today"    value={fmt(pvPeak)}    color={SOLAR}/>}
          {d.inverter?.selfConsumptionPercent!=null&&<StatTile tint="rgba(255,255,255,0.72)" label="Self-consumed"  value={`${d.inverter.selfConsumptionPercent}%`} color={MUTED}/>}
          {d.inverter?.selfSufficiencyPercent!=null&&<StatTile tint="rgba(255,255,255,0.72)" label="Self-sufficient" value={`${d.inverter.selfSufficiencyPercent}%`} color={MUTED}/>}
          <StatTile tint="rgba(255,255,255,0.72)" icon="thermometer" label="Inverter temperature"  value={`${d.inverter?.temperature||0}°C`} color={TEXT}/>
        </div>
      </div>

      {/* Solar / PV */}
      <SectionCard icon="sun" title="Solar">
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:mppts.length?12:0}}>
          <StatTile label="Total DC"   num={pvTotal} format={v=>fmt(v,2)}  color={SOLAR}/>
          {pvPeak>0&&<StatTile label="Peak today" value={fmt(pvPeak)}     color={SOLAR}/>}
          <StatTile label="Today"      value={fmtE(pvToday)}   color={TEXT}/>
          <StatTile label="Lifetime"   value={fmtE(pvLifetime)} color={TEXT}/>
        </div>
        {mppts.length>0&&(
          <div>
            <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,marginBottom:6}}>Strings</div>
            {mppts.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:i<mppts.length-1?`1px solid ${BORDER}`:"none"}}>
                <span style={{fontSize:FS.footnote,fontWeight:600,color:MUTED}}>MPPT {i+1}</span>
                {m.power>0
                  ? <span style={{fontSize:FS.footnote,color:SOLAR_TEXT,fontVariantNumeric:"tabular-nums"}}>{(m.voltage||0).toFixed(0)} V · {(m.current||0).toFixed(2)} A · {fmt(m.power)}</span>
                  : <span style={{fontSize:FS.footnote,color:MUTED}}>Off</span>}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Battery */}
      <SectionCard icon="battery" title="Battery">
        <div style={{marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
            <span style={{fontSize:FS.subhead,fontWeight:600,color:MUTED}}>Charge{!bat.brand&&" (estimated)"}</span>
            <span style={{fontSize:FS.title2,fontWeight:800,color:textTone(bat.soc>60?BATTERY:bat.soc>30?SOLAR:GRID_IN)}}><CountUp value={bat.soc||0} format={v=>`${Math.round(v)}%`}/></span>
          </div>
          <div style={{marginBottom:10}}><Meter value={bat.soc||0} color={bat.soc>60?BATTERY:bat.soc>30?SOLAR:GRID_IN} height={10} label="Battery state of charge"/></div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <StatTile label="Voltage"     value={`${(bat.voltage||0).toFixed(1)} V`} color={TEXT}/>
            <StatTile label="Current"     value={`${(bat.current||0).toFixed(1)} A`} color={TEXT}/>
            <StatTile label="Charging"    value={fmt(bat.charge||0)}    color={(bat.charge||0)>20?BATTERY:MUTED}/>
            <StatTile label="Discharging" value={fmt(bat.discharge||0)} color={(bat.discharge||0)>20?SOLAR:MUTED}/>
            {bat.healthPercent>0&&<StatTile label="Health (SOH)" value={`${bat.healthPercent}%`} color={bat.healthPercent>80?BATTERY:bat.healthPercent>60?SOLAR:GRID_IN}/>}
            {bat.temperature>0&&<StatTile icon="thermometer" label="Temperature" value={`${bat.temperature}°C`} color={bat.temperature>45?GRID_IN:bat.temperature>35?SOLAR:TEXT}/>}
          </div>
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,marginBottom:6}}>Energy</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <StatTile label="Charged today"    value={fmtE(bat.chargeIn?.today||0)}    color={BATTERY}/>
            <StatTile label="Discharged today" value={fmtE(bat.dischargeOut?.today||0)} color={SOLAR}/>
            {(bat.chargeIn?.total||0)>0&&<StatTile label="Total charged"    value={fmtE(bat.chargeIn.total)}    color={MUTED}/>}
            {(bat.dischargeOut?.total||0)>0&&<StatTile label="Total discharged" value={fmtE(bat.dischargeOut.total)} color={MUTED}/>}
          </div>
        </div>
        {(bat.brand||bat.capacityAh>0)&&(
          <div style={{paddingTop:10,borderTop:`1px solid ${BORDER}`,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            {bat.brand&&<span style={{fontSize:FS.caption,color:MUTED,fontWeight:600}}>{bat.brand}</span>}
            {bat.capacityAh>0&&<span style={{fontSize:FS.caption,color:MUTED}}>{bat.capacityAh} Ah</span>}
            {bat.bmsFWVer&&bat.bmsFWVer!=="0"&&<span style={{fontSize:FS.caption,color:MUTED}}>BMS v{bat.bmsFWVer}</span>}
          </div>
        )}
      </SectionCard>

      {/* Grid */}
      <SectionCard icon="pylon" title="Grid">
        <div style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:FS.callout,fontWeight:700,color:textTone(isExporting?GRID_OUT:isImporting?GRID_IN:MUTED),fontVariantNumeric:"tabular-nums"}}>
              {isExporting?"Exporting":isImporting?"Importing":"Balanced"} <CountUp value={Math.abs(gridNetW)} format={v=>fmt(v)}/>
            </span>
            {gridFreq>0&&<span style={{fontSize:FS.caption,color:MUTED,marginLeft:"auto"}}>{gridFreq.toFixed(2)} Hz</span>}
          </div>
          {gridLines.filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
            <PhaseRow key={i} label={`L${i+1}`} line={l} exportWhenNegative/>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <StatTile label="Exported today" value={fmtE(d.grid?.sold?.today||0)}        color={GRID_OUT}/>
          <StatTile label="Total exported" value={fmtE(d.grid?.sold?.total||0)}        color={GRID_OUT}/>
          <StatTile label="Imported today" value={fmtE(d.grid?.consumption?.today||0)} color={GRID_IN}/>
          <StatTile label="Total imported" value={fmtE(d.grid?.consumption?.total||0)} color={GRID_IN}/>
        </div>
      </SectionCard>

      {/* Normal Load */}
      <SectionCard icon="home" title="Home load">
        <div style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:FS.callout,fontWeight:700,color:LOAD_C,fontVariantNumeric:"tabular-nums"}}><CountUp value={loadW} format={v=>fmt(v)}/></span>
            {loadFreq>0&&<span style={{fontSize:FS.caption,color:MUTED,marginLeft:"auto"}}>{loadFreq.toFixed(2)} Hz</span>}
          </div>
          {loadLines.filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
            <PhaseRow key={i} label={`L${i+1}`} line={l}/>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <StatTile label="Consumed today" value={fmtE(d.load?.power?.today||0)}    color={LOAD_C}/>
          <StatTile label="Total consumed" value={fmtE(d.load?.power?.total||0)}    color={MUTED}/>
        </div>
      </SectionCard>

      {/* Smart Ports — full width if any active */}
      {smartPorts.length>0&&(
        <SectionCard icon="plug" title="Smart ports" fullWidth>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:16}}>
            {smartPorts.map(([key,port])=>{
              const portW=(port.lines||[]).reduce((s,l)=>s+(l.power||0),0);
              return (
                <div key={key}>
                  <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,marginBottom:6}}>Port {key}</div>
                  {(port.lines||[]).filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
                    <PhaseRow key={i} label={`L${i+1}`} line={l}/>
                  ))}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:8}}>
                    <StatTile label="Live"  value={fmt(portW)}                     color={portW>0?BATTERY:MUTED}/>
                    <StatTile label="Today" value={fmtE(port.power?.today||0)}     color={MUTED}/>
                    {(port.power?.total||0)>0&&<StatTile label="Lifetime" value={fmtE(port.power.total)} color={MUTED}/>}
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {/* Generator — full width if active */}
      {hasGen&&(
        <SectionCard icon="cog" title="Generator" fullWidth>
          <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"center"}}>
            {(d.gen.lines||[]).filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
              <PhaseRow key={i} label={`L${i+1}`} line={l}/>
            ))}
            {d.gen.frequency>0&&<span style={{fontSize:FS.caption,color:MUTED}}>{d.gen.frequency.toFixed(1)} Hz</span>}
          </div>
        </SectionCard>
      )}

      {/* Inverter details / firmware — collapsible, full width */}
      <div className="ui-card" style={{gridColumn:"1/-1",overflow:"hidden"}}>
        <button type="button" aria-expanded={showInfo} onClick={()=>setShowInfo(x=>!x)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",minHeight:52,padding:"10px 16px",background:"transparent",border:"none",cursor:"pointer",fontFamily:SANS,textAlign:"left"}}>
          <span className="ui-card-title"><Icon name="info"/>Inverter details and firmware</span>
          <span className="chev" data-open={showInfo?"true":"false"} style={{color:MUTED,fontSize:18,display:"inline-flex"}}><Icon name="chevron-down"/></span>
        </button>
        {showInfo&&(
          <div style={{borderTop:`1px solid ${BORDER}`,padding:"12px 16px"}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
              {d.inverter?.model&&<StatTile label="Model"        value={d.inverter.model}       color={TEXT}/>}
              {stateLabel        &&<StatTile label="Status"       value={stateLabel}              color={stateColor}/>}
              {workLabel         &&<StatTile label="Work mode"    value={workLabel}               color={MUTED}/>}
              {d.inverter?.dspVer     &&<StatTile label="DSP"        value={d.inverter.dspVer}      color={MUTED}/>}
              {d.inverter?.slaveDspVer&&<StatTile label="Slave DSP"  value={d.inverter.slaveDspVer} color={MUTED}/>}
              {d.inverter?.csbVer     &&<StatTile label="CSB"         value={d.inverter.csbVer}      color={MUTED}/>}
              {d.inverter?.wifiSignal!=null&&<StatTile label="Wi-Fi signal" value={`${d.inverter.wifiSignal}`} color={MUTED}/>}
              {bat.bmsFWVer&&bat.bmsFWVer!=="0"&&<StatTile label="BMS firmware"     value={bat.bmsFWVer}           color={MUTED}/>}
              {d.inverter?.lastUpdateTime&&<StatTile label="Last update" value={fmtAge(ageMin(d.inverter.lastUpdateTime))||d.inverter.lastUpdateTime.slice(11,16)} sub={d.inverter.lastUpdateTime.slice(0,16)} color={MUTED}/>}
            </div>
          </div>
        )}
      </div>

    </div>
  );
}

function FlowEdge({d, active, reverse, value=0, color="#16A34A"}) {
  // Dot speed ∝ power: animation period is inversely proportional to watts (10kW flows 2× faster
  // than 5kW), clamped so it never crawls or strobes. Period moves one dash cycle (16px keyframe).
  const dur = Math.max(0.3, Math.min(3, 4000/Math.max(Math.abs(value),1)));
  return <path d={d} fill="none" stroke={active?color:"#E6E3DE"} strokeWidth={active?2.5:2}
    strokeDasharray="2 6" strokeLinecap="round" strokeLinejoin="round"
    className={active?(reverse?"flow-rev":"flow-anim"):""}
    style={active?{animationDuration:`${dur}s`}:undefined}/>;
}
function FlowNode({x, y, r=22, color, icon, label, watts, sub, sub2, sub2Color, place="below", optional=false}) {
  // All text sits on the side AWAY from the inverter (above for top nodes, below for bottom ones)
  // so the connector line, which exits the icon toward the center, never crosses the labels.
  const above = place==="above";
  const lift = above && !sub ? 15 : 0; // no sub line: pull label + value down toward the node
  const labelY = above ? y-r-40+lift : y+r+17;
  const valueY = above ? y-r-22+lift : y+r+35;
  const subY   = above ? y-r-7  : y+r+51;
  const sub2Y  = above ? subY-14 : subY+14;
  return (
    <g className={optional?"flow-node-opt":undefined}>
      <circle cx={x} cy={y} r={r+4} fill={color} opacity="0.14"/>
      <circle cx={x} cy={y} r={r} fill={color}/>
      {svgIcon(icon, x, y, r*1.05, "#fff", 2)}
      <text x={x} y={labelY} textAnchor="middle" fontSize="12" fontWeight="600" fill={MUTED} fontFamily={SANS}>{label}</text>
      <text x={x} y={valueY} textAnchor="middle" fontSize="15.5" fontWeight="800" fill={TEXT} fontFamily={SANS}><CountUp as="tspan" value={watts} format={v=>fmt(v)}/></text>
      {sub&&<text x={x} y={subY} textAnchor="middle" fontSize="11.5" fill={MUTED} fontFamily={SANS}>{sub}</text>}
      {sub2&&<text x={x} y={sub2Y} textAnchor="middle" fontSize="11.5" fontWeight="700" fill={sub2Color||MUTED} fontFamily={SANS}>{sub2}</text>}
    </g>
  );
}
// Stylised white inverter cabinet (matches the hardware) used as the diagram's center hub.
// Swap for a photo later by dropping a <image href="/inverter.png"/> in place of this group.
function InverterGraphic({count}) {
  const x=170, y=130, w=60, h=104;
  return (
    <g>
      <rect x={x-4} y={y+24} width="4" height="12" rx="1.5" fill="#CBD5E1"/>
      <rect x={x-4} y={y+h-36} width="4" height="12" rx="1.5" fill="#CBD5E1"/>
      <rect x={x+w} y={y+24} width="4" height="12" rx="1.5" fill="#CBD5E1"/>
      <rect x={x+w} y={y+h-36} width="4" height="12" rx="1.5" fill="#CBD5E1"/>
      <rect x={x} y={y} width={w} height={h} rx="9" fill="#FCFCFD" stroke="#CBD5E1" strokeWidth="1.5"/>
      {[0,1,2,3,4,5].map(i=><circle key={i} cx={x+12+i*7.2} cy={y+11} r="1.7" fill={i<2?"#22C55E":i<4?"#F59E0B":"#CBD5E1"}/>)}
      <rect x={x+15} y={y+19} width={w-30} height="15" rx="2.5" fill="#111827"/>
      <line x1={x} y1={y+h*0.5} x2={x+w} y2={y+h*0.5} stroke="#E2E8F0" strokeWidth="1.5"/>
      {count>1&&<g>
        <circle cx={x+w-1} cy={y+1} r="12" fill="#0D1F33"/>
        <text x={x+w-1} y={y+5} textAnchor="middle" fontSize="11" fontWeight="800" fill="#fff" fontFamily={SANS}>×{count}</text>
      </g>}
    </g>
  );
}
function FlowDiagram({flow}) {
  if(!flow) return null;
  const A = 20;
  const L=170, R=230, T=130, B=234, fy1=158, fy2=206;
  // A smart-port reading that ≈ the whole house load IS the house (AIO inverters serve the house
  // through a smart port), not a separate controllable load. Only show Smart Load when it's
  // genuinely distinct from Home — otherwise it's just Home shown twice.
  const showSmart = flow.smartLoad>A && Math.abs(flow.smartLoad-flow.load) > Math.max(80, flow.load*0.1);
  const edges = [
    { d:`M56,92 L56,${fy1} L${L},${fy1}`, active:flow.pv>A, reverse:false, value:flow.pv },
    { d:`M344,92 L344,${fy1} L${R},${fy1}`, active:Math.abs(flow.grid)>A, reverse:flow.grid<0, value:flow.grid },
    { d:`M56,300 L56,${fy2} L${L},${fy2}`, active:Math.abs(flow.battery)>A, reverse:flow.battery>0, value:flow.battery },
    { d:`M344,300 L344,${fy2} L${R},${fy2}`, active:flow.load>A, reverse:true, value:flow.load },
  ];
  if(flow.gen>A)  edges.push({ d:`M200,81 L200,${T}`, active:true, reverse:false, value:flow.gen });
  if(showSmart)   edges.push({ d:`M200,305 L200,${B}`, active:true, reverse:true, value:flow.smartLoad });
  if(flow.couple>A) edges.push({ d:`M56,182 L${L},182`, active:true, reverse:flow.couple<0, value:flow.couple });
  return (
    <div className="ui-card" style={{padding:"12px 8px 6px",marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,flexWrap:"wrap",padding:"2px 8px 0"}}>
        <span className="ui-card-title"><Icon name="activity"/>Power flow{flow.live&&<LiveBadge/>}</span>
        {flow.live ? <LiveChip atMs={flow.liveAt}/> : (flow.updated&&<UpdatedChip time={flow.updated}/>)}
      </div>
      <svg viewBox="0 0 400 400" style={{width:"100%",maxWidth:520,height:"auto",display:"block",margin:"0 auto"}} role="img" aria-label={`Power flow: solar ${fmt(flow.pv)}, home ${fmt(flow.load)}, grid ${flow.grid<0?"exporting":"importing"} ${fmt(Math.abs(flow.grid))}, battery ${flow.battery>0?"charging":"discharging"} ${fmt(Math.abs(flow.battery))}`}>
        {edges.map((e,i)=><FlowEdge key={i} {...e}/>)}
        <InverterGraphic count={flow.count}/>
        <FlowNode x={56} y={92} place="above" color={SOLAR} icon="sun" label="Solar" watts={flow.pv}/>
        <FlowNode x={344} y={92} place="above" color={flow.grid<0?GRID_OUT:GRID_IN} icon="pylon" label="Grid" watts={Math.abs(flow.grid)} sub={Math.abs(flow.grid)<=A?"idle":flow.grid<0?"exporting":"importing"}/>
        <FlowNode x={56} y={300} place="below" color={BATTERY} icon={flow.battery>A?"battery-charging":"battery"} label="Battery" watts={Math.abs(flow.battery)}
          sub={flow.remainKwh!=null ? `${flow.soc.toFixed(0)}% · ~${flow.remainKwh.toFixed(1)} kWh`
            : flow.soc!=null ? `${flow.soc.toFixed(0)}% charged`
            : flow.voltage!=null ? `${flow.voltage.toFixed(1)} V` : null}
          sub2={flow.ratePctHr!=null ? `${flow.rateSign}${flow.ratePctHr.toFixed(1)}%/hr` : null}
          sub2Color={flow.battery>0?BATTERY_TEXT:SOLAR_TEXT}/>
        <FlowNode x={344} y={300} place="below" color={LOAD_C} icon="home" label="Home" watts={flow.load}/>
        {flow.gen>A      && <FlowNode optional x={200} y={64} r={17} place="above" color="#57534E" icon="cog" label="Generator" watts={flow.gen}/>}
        {showSmart      && <FlowNode optional x={200} y={322} r={17} place="below" color="#7C3AED" icon="plug" label="Smart load" watts={flow.smartLoad}/>}
        {flow.couple>A   && <FlowNode optional x={40} y={182} r={16} place="below" color="#0891B2" icon="link" label="AC couple" watts={Math.abs(flow.couple)}/>}
      </svg>
    </div>
  );
}

function InverterSelector({selectedSns, onToggle, onAll, allSelected, statuses, inverters, single, value, onPick}) {
  const pill = (active, onClick, key, label, sub, power, mono=true) => (
    <button key={key} type="button" onClick={onClick} aria-pressed={active} className="ui-press" style={{
      flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:1,
      padding:"6px 14px", minHeight:48, borderRadius:12,
      border:`1.5px solid ${active?SOLAR:BORDER}`,
      background:active?"#FFFBEB":CARD,
      cursor:"pointer", fontFamily:SANS,
      boxShadow: active ? `0 0 0 3px rgba(217,119,6,0.12)` : SHADOW_SM,
      minWidth:64,
    }}>
      <span style={{fontSize:FS.subhead,fontWeight:700,color:active?SOLAR_TEXT:TEXT,whiteSpace:"nowrap"}}>{label}{power&&<span style={{fontWeight:500,color:active?SOLAR_TEXT:MUTED}}>{" · "}{power}</span>}</span>
      <span style={{fontSize:FS.caption,fontWeight:500,color:active?SOLAR_TEXT:MUTED,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",fontFamily:mono?"ui-monospace,SFMono-Regular,Menlo,monospace":SANS}}>{sub}</span>
    </button>
  );
  // Single-select mode (Explorer): no "All" pill; picking an inverter replaces the current one.
  return (
    <div className="inv-scroll" style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch"}}>
      {!single && pill(allSelected, onAll, "all", "All", `${inverters.length} inverters`, null, false)}
      {inverters.map(inv=>{
        const s = statuses.find(x=>x.sn===inv.sn);
        const pv = s?.data?.photovoltaic?.power?.totalDc;
        const active = single ? value===inv.sn : (!allSelected && selectedSns.includes(inv.sn));
        const onClick = single ? ()=>onPick(inv.sn) : ()=>onToggle(inv.sn);
        return pill(active, onClick, inv.sn, inv.label, inv.sn.slice(-8), pv!=null?fmt(pv):null);
      })}
    </div>
  );
}

function ChartCard({children, loading, minHeight=300}) {
  return (
    <div className="ui-card" style={{padding:"16px 12px 12px",minHeight,display:"flex",flexDirection:"column"}} aria-busy={loading||undefined}>
      {loading
        ? <div className="ui-skel" role="status" aria-label="Loading chart" style={{flex:1,minHeight:minHeight-40,borderRadius:12}}/>
        : children}
    </div>
  );
}

// Header for the period views (Day, Month, Year, Explorer): a title and subtitle, then the period controls.
// On phones the controls take the full width under the title.
function PeriodHeader({title, subtitle, children, range=false}) {
  return (
    <div className="period-head">
      <div style={{minWidth:0}}>
        <h2 style={{fontSize:FS.title3,fontWeight:800,color:TEXT,letterSpacing:"-0.3px"}}>{title}</h2>
        {subtitle&&<div style={{fontSize:FS.subhead,color:MUTED,marginTop:2}}>{subtitle}</div>}
      </div>
      <div className={`period-ctrls${range?" period-ctrls--range":""}`}>{children}</div>
    </div>
  );
}
const StepButton = ({dir, label, disabled, onClick}) => <IconButton icon={dir<0?"back":"chevron"} label={label} disabled={disabled} onClick={onClick} className="ui-iconbtn--bordered"/>;
// Axis numbers: 950, 1.5k, 12k (one decimal below 10k so steps never repeat as "2k, 2k"). Signed values keep their sign.
const kFmt = (v) => { const a=Math.abs(v); if(a<1000) return `${Math.round(v)}`; return `${parseFloat((v/1000).toFixed(a<10000?1:0))}k`; };
// Round an axis extent up to a "nice" number (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 x 10^n) so ticks land on round values.
const niceCeil = (x) => { if(!(x>0)) return 0; const p=Math.pow(10,Math.floor(Math.log10(x))); for(const m of [1,1.2,1.5,2,2.5,3,4,5,6,8,10]) if(m*p>=x) return m*p; return 10*p; };

const PROD_SHADES = ["#3B82F6","#60A5FA","#2563EB","#93C5FD","#1D4ED8","#BFDBFE"];
const CONS_SHADES = ["#F97316","#FB923C","#EA580C","#FDBA74","#C2410C","#FED7AA"];
const GRID_LINE = "#94A3B8";
const BAT_LINE = "#22C55E";
const SOC_LINE = "#16A34A";

function DayTooltip({active, payload, label}) {
  if(!active||!payload||!payload.length) return null;
  const prod = payload.filter(p=>p.dataKey&&p.dataKey.startsWith("pv"));
  const cons = payload.filter(p=>p.dataKey&&p.dataKey.startsWith("loadNeg"));
  const grid = payload.find(p=>p.dataKey==="gridNet");
  const bat  = payload.find(p=>p.dataKey==="batNet");
  const soc  = payload.find(p=>p.dataKey==="soc");
  const prodTot = prod.reduce((s,p)=>s+(p.value||0),0);
  const consTot = cons.reduce((s,p)=>s+Math.abs(p.value||0),0);
  const Row = ({c,l,v,bold}) => (
    <div style={{display:"flex",justifyContent:"space-between",gap:16,fontSize:FS.caption,fontWeight:bold?700:500,padding:"1px 0"}}>
      <span style={{color:bold?TEXT:MUTED,display:"flex",alignItems:"center",gap:5}}>{c&&<span style={{width:8,height:8,borderRadius:2,background:c,display:"inline-block"}}/>}{l}</span>
      <span style={{color:bold?TEXT:MUTED,fontVariantNumeric:"tabular-nums"}}>{v}</span>
    </div>
  );
  return (
    <div style={{...TOOLTIP_S, padding:"8px 10px", minWidth:150}}>
      <div style={{color:MUTED,fontSize:FS.caption,marginBottom:5}}>{label}</div>
      {prod.length>0&&<>
        {prod.map(p=><Row key={p.dataKey} c={p.color} l={p.name} v={fmt(p.value||0)}/>)}
        {prod.length>1&&<Row l="Total solar" v={fmt(prodTot)} bold/>}
      </>}
      {cons.length>0&&<div style={{marginTop:prod.length?4:0}}>
        {cons.map(p=><Row key={p.dataKey} c={p.color} l={p.name} v={fmt(Math.abs(p.value||0))}/>)}
        {cons.length>1&&<Row l="Total load" v={fmt(consTot)} bold/>}
      </div>}
      {(grid||bat||soc)&&<div style={{marginTop:4,borderTop:`1px solid ${BORDER}`,paddingTop:4}}>
        {grid&&grid.value!=null&&<Row c={GRID_LINE} l={grid.value>=0?"Grid import":"Grid export"} v={fmt(Math.abs(grid.value))}/>}
        {bat&&bat.value!=null&&<Row c={BAT_LINE} l={bat.value>=0?"Battery charge":"Battery discharge"} v={fmt(Math.abs(bat.value))}/>}
        {soc&&soc.value!=null&&<Row c={SOC_LINE} l="SOC" v={`${Number(soc.value).toFixed(0)}%`}/>}
      </div>}
    </div>
  );
}

function DayChart({date, onDateChange, data, loading, summary, prodSeries=[], consSeries=[], mpptHint, mpptActive}) {
  const [showProduced, setShowProduced] = useState(true);
  const [showConsumed, setShowConsumed] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [showBattery, setShowBattery] = useState(false);
  const [showSoc, setShowSoc] = useState(true);
  // Summary totals come from the month rollup for this day (energy registers) so the Day tab
  // matches the Month tab exactly. Fall back to integrating the intraday power if unavailable.
  const produced   = summary ? summary.produced   : data.reduce((s,d)=>s+((d.pv||0)*(5/60)),0);
  const consumed   = summary ? summary.consumed   : data.reduce((s,d)=>s+((d.load||0)*(5/60)),0);
  const imported   = summary ? summary.imported   : data.reduce((s,d)=>s+((d.gridImport||0)*(5/60)),0);
  const exported   = summary ? summary.exported   : data.reduce((s,d)=>s+((d.gridExport||0)*(5/60)),0);
  const charged    = summary ? summary.charged    : data.reduce((s,d)=>s+((d.batCharge||0)*(5/60)),0);
  const discharged = summary ? summary.discharged : data.reduce((s,d)=>s+((d.batDischarge||0)*(5/60)),0);
  // Always render a full 24h x-axis (00:00–23:55 at 5-min) — pad the data onto the complete grid so
  // today stops at "now" with empty space after, instead of the axis ending early.
  const _byTime = {};
  for(const d of data) _byTime[(d.time||"").slice(0,5)] = d;
  const chartData = [];
  for(let h=0;h<24;h++) for(let m=0;m<60;m+=5){
    const key = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
    const d = _byTime[key];
    chartData.push(d ? { ...d, batNet: d.batNet!=null ? d.batNet : ((d.batCharge||0)-(d.batDischarge||0)) } : { time: key+":00" });
  }
  // Y-axis: positive (production) extent must always be >= negative (consumption) extent, so the
  // zero line never sits above the vertical midpoint. Compute the stacked extents (incl. grid/battery
  // line spikes) and force domain = [-N, max(P,N)].
  let P=0, N=0;
  for(const d of chartData){
    let p=0; for(const s of prodSeries) p+=(d[s.key]||0);
    let n=0; for(const s of consSeries) n+=-(d[s.key]||0);
    const g=d.gridNet||0, b=d.batNet||0;
    p=Math.max(p,g,b,0); n=Math.max(n,-g,-b,0);
    if(p>P)P=p; if(n>N)N=n;
  }
  const yTop=niceCeil(Math.max(P,N,100)*1.05);
  const powerDomain=[-niceCeil(N*1.05), yTop];
  const toggleSeries = [
    {key:"produced", label:"Produced", color:CHART_PROD, active:showProduced, onToggle:setShowProduced},
    {key:"consumed", label:"Consumed", color:CHART_CONS, active:showConsumed, onToggle:setShowConsumed},
    {key:"grid", label:"Grid", color:GRID_LINE, active:showGrid, onToggle:setShowGrid},
    {key:"battery", label:"Battery", color:BAT_LINE, active:showBattery, onToggle:setShowBattery},
    {key:"soc", label:"SOC", color:SOC_LINE, active:showSoc, onToggle:setShowSoc},
  ];
  const dayAtMax = date >= today;
  const dayPrev = () => { const d=new Date(date+'T12:00:00'); d.setDate(d.getDate()-1); onDateChange(d.toISOString().split('T')[0]); };
  const dayNext = () => { if(!dayAtMax){const d=new Date(date+'T12:00:00'); d.setDate(d.getDate()+1); onDateChange(d.toISOString().split('T')[0]);} };
  return (
    <div style={{marginBottom:24}}>
      <PeriodHeader title="Day" subtitle={mpptActive?"Production per MPPT string · drag the bar to zoom":"Power through the day · drag the bar to zoom"}>
        <StepButton dir={-1} label="Previous day" onClick={dayPrev}/>
        <input type="date" className="ui-field" aria-label="Date" value={date} max={today} onChange={e=>e.target.value&&onDateChange(e.target.value)}/>
        <StepButton dir={1} label="Next day" disabled={dayAtMax} onClick={dayNext}/>
        {date!==today&&<Button size="sm" variant="plain" onClick={()=>onDateChange(today)}>Today</Button>}
      </PeriodHeader>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged}/>}
      <ChartCard loading={loading} minHeight={360}>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={{top:4,right:8,left:0,bottom:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="time" tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={44} tickFormatter={t=>typeof t==="string"?t.slice(0,5):t}/>
            <YAxis yAxisId="power" domain={powerDomain} tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} tickFormatter={kFmt} width={38}/>
            <YAxis yAxisId="soc" orientation="right" domain={[0,100]} tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} width={30} tickFormatter={v=>`${v}`}/>
            <ReferenceLine yAxisId="power" y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip content={<DayTooltip/>} cursor={{stroke:FAINT,strokeDasharray:"3 3"}}/>
            {showProduced&&prodSeries.map((s)=>(
              <Area key={s.key} yAxisId="power" type="monotone" dataKey={s.key} stackId="prod" stroke={s.color} strokeWidth={prodSeries.length===1?1.5:0.5} fill={s.color} fillOpacity={0.55} name={s.name} isAnimationActive={false} dot={false}/>
            ))}
            {showConsumed&&consSeries.map((s)=>(
              <Area key={s.key} yAxisId="power" type="monotone" dataKey={s.key} stackId="cons" stroke={s.color} strokeWidth={consSeries.length===1?1.5:0.5} fill={s.color} fillOpacity={0.5} name={s.name} isAnimationActive={false} dot={false}/>
            ))}
            {showGrid&&<Line yAxisId="power" type="monotone" dataKey="gridNet" stroke={GRID_LINE} strokeWidth={1.5} dot={false} name="Grid (− export)" isAnimationActive={false}/>}
            {showBattery&&<Line yAxisId="power" type="monotone" dataKey="batNet" stroke={BAT_LINE} strokeWidth={1.5} dot={false} name="Battery (+ charge)" isAnimationActive={false}/>}
            {showSoc&&<Line yAxisId="soc" type="monotone" dataKey="soc" stroke={SOC_LINE} strokeWidth={1.5} dot={false} name="SOC" isAnimationActive={false} connectNulls/>}
            <Brush dataKey="time" height={22} stroke={FAINT} fill={BG} travellerWidth={10} tickFormatter={()=>""}/>
          </ComposedChart>
        </ResponsiveContainer>
        <SeriesToggle series={toggleSeries}/>
      </ChartCard>
      {mpptHint&&(
        <div style={{display:"flex",justifyContent:"center",marginTop:10}}>
          <div style={{fontSize:FS.footnote,fontWeight:500,color:MUTED,background:CARD,border:`1px solid ${BORDER}`,borderRadius:20,padding:"6px 14px",display:"inline-flex",alignItems:"center",gap:6}}>
            <Icon name={mpptActive?"chart":"bulb"} style={{color:SOLAR}}/>
            {mpptActive ? "Showing production per MPPT string for this inverter" : "Pick a single inverter to see production per MPPT string"}
          </div>
        </div>
      )}
    </div>
  );
}

function LegendSwatch({color,label}){
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:FS.caption,fontWeight:600,color:MUTED}}><span style={{width:14,height:3,borderRadius:2,background:color}}/>{label}</span>;
}

// Explorer — chart any raw inverter parameter(s) over a date range (up to a week) at 5-min
// resolution, from the dayexcel CSV. Each chart holds up to two distinct units (left + right axis);
// selecting parameters in a third/fourth unit spawns additional charts below. Single inverter only
// (the CSV is per-inverter).
const EXPLORER_COLORS = ["#D97706","#2563EB","#16A34A","#DC2626","#7C3AED","#0891B2","#DB2777","#65A30D","#EA580C","#0D9488","#9333EA","#0EA5E9","#F59E0B","#10B981"];
const METRIC_DEC = (unit) => unit==="W"?0 : unit==="A"?2 : unit==="Hz"?2 : unit==="kWh"?2 : (unit==="V"||unit==="°C")?1 : 0;
function fmtMetric(v, unit){
  if(v==null||!isFinite(v)) return "—";
  if(unit==="W" && Math.abs(v)>=1000) return `${(v/1000).toFixed(2)} kW`;
  return `${Number(v).toFixed(METRIC_DEC(unit))}${unit==="%"?"":" "}${unit}`;
}
function axisFmt(unit){
  if(unit==="W") return kFmt;
  return (v)=>`${Math.round(v*100)/100}`;
}
function ExplorerTooltip({active, payload, label, byKey}){
  if(!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_S}>
      <div style={{fontWeight:700,color:TEXT,marginBottom:6,display:"flex",alignItems:"center",gap:5}}><Icon name="clock" style={{color:MUTED}}/>{label}</div>
      {payload.map(p=>{ const m=byKey[p.dataKey]; return (
        <div key={p.dataKey} style={{display:"flex",justifyContent:"space-between",gap:16,fontSize:FS.footnote,marginBottom:2}}>
          <span style={{color:p.color,fontWeight:600}}>{m?.label||p.dataKey}</span>
          <span style={{color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmtMetric(p.value, m?.unit||"")}</span>
        </div>
      ); })}
    </div>
  );
}
function ExplorerChart({start, end, onStart, onEnd, onPrev, onNext, nextDisabled, rows, metrics, multi, loading, label}){
  const [sel, setSel] = useState([]);
  const byKey = Object.fromEntries(metrics.map(m=>[m.key,m]));
  const colorOf = (key)=> EXPLORER_COLORS[Math.max(0,metrics.findIndex(m=>m.key===key)) % EXPLORER_COLORS.length];
  // Seed a sensible default and prune the selection whenever the available metrics change.
  useEffect(()=>{
    setSel(prev=>{
      const avail = metrics.map(m=>m.key);
      const kept = prev.filter(k=>avail.includes(k));
      if(kept.length || prev.length) return kept; // keep a deliberate empty selection
      const def = metrics.find(m=>m.key==="pvW") || metrics[0];
      return def ? [def.key] : [];
    });
  }, [metrics]);
  const toggle = (k)=> setSel(p=> p.includes(k) ? p.filter(x=>x!==k) : [...p,k]);
  const groups = [...new Set(metrics.map(m=>m.group))];
  // Build the (optionally multi-day) full 5-min grid so each day spans 00:00–23:55.
  const pad = (n)=>String(n).padStart(2,"0");
  const dates = [...new Set(rows.map(r=>r._date).filter(Boolean))].sort();
  const rowByKey = {}; for(const r of rows){ rowByKey[(r._date||"")+" "+(r.t||(r.time||"").slice(0,5))] = r; }
  const useDates = dates.length ? dates : [null];
  const data = [];
  for(const dt of useDates){
    const md = dt ? `${+dt.slice(5,7)}/${+dt.slice(8,10)}` : "";
    for(let h=0;h<24;h++) for(let m=0;m<60;m+=5){
      const t = `${pad(h)}:${pad(m)}`;
      const r = rowByKey[(dt||"")+" "+t];
      const lbl = multi ? `${md} ${t}` : t;
      data.push(r ? {...r, lbl} : {lbl});
    }
  }
  // Group the selected metrics into charts of two units each (left + right axis), in selection order.
  const unitsOrdered = [];
  for(const k of sel){ const u=byKey[k]?.unit; if(u && !unitsOrdered.includes(u)) unitsOrdered.push(u); }
  const pairs = []; for(let i=0;i<unitsOrdered.length;i+=2) pairs.push(unitsOrdered.slice(i,i+2));
  return (
    <div style={{marginBottom:24}}>
      <PeriodHeader range title="Explorer" subtitle={`${label?`${label} · `:""}Any inverter reading at 5-minute resolution, up to 7 days`}>
        <StepButton dir={-1} label="Earlier" onClick={onPrev}/>
        <input type="date" className="ui-field" aria-label="From" value={start} max={today} onChange={e=>e.target.value&&onStart(e.target.value)}/>
        <span style={{fontSize:FS.subhead,color:MUTED}}>to</span>
        <input type="date" className="ui-field" aria-label="To" value={end} max={today} onChange={e=>e.target.value&&onEnd(e.target.value)}/>
        <StepButton dir={1} label="Later" disabled={nextDisabled} onClick={onNext}/>
      </PeriodHeader>
      {/* Parameter picker — grouped chips */}
      {!loading && metrics.length>0 && (
        <div className="ui-card" style={{padding:"12px 14px",marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,marginBottom:8}}>
            <span className="ui-card-title"><Icon name="sliders"/>Readings <span style={{fontWeight:500,color:MUTED}}>· {sel.length} selected</span></span>
            <span style={{display:"flex",gap:4}}>
              <Button size="sm" variant="plain" onClick={()=>setSel(metrics.map(m=>m.key))}>Select all</Button>
              <Button size="sm" variant="plain" onClick={()=>setSel([])} disabled={!sel.length}>Clear</Button>
            </span>
          </div>
          {groups.map(g=>(
            <div key={g} className="chip-group">
              <span className="chip-group-label">{g}</span>
              <div className="chip-scroll">
                {metrics.filter(m=>m.group===g).map(m=>{
                  const on = sel.includes(m.key); const c = colorOf(m.key);
                  return (
                    <button key={m.key} type="button" aria-pressed={on} className="ui-chip" onClick={()=>toggle(m.key)}
                      style={on?{background:c,borderColor:c,color:"#fff"}:undefined}>
                      <span style={{width:8,height:8,borderRadius:"50%",background:on?"#fff":c,flexShrink:0}}/>
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {loading
        ? <ChartCard loading minHeight={340}/>
        : metrics.length===0
          ? <ChartCard loading={false} minHeight={200}><EmptyState icon="calendar" title="No 5-minute data for these dates" hint="Try an earlier range; the inverter may not have reported."/></ChartCard>
          : pairs.length===0
            ? <ChartCard loading={false} minHeight={160}><EmptyState icon="chart" title="Nothing selected" hint="Pick one or more readings above to chart them."/></ChartCard>
            : pairs.map((pair, pi)=>{
                const [lu, ru] = pair;
                const keys = sel.filter(k=>{ const u=byKey[k]?.unit; return u===lu || u===ru; });
                return (
                  <div key={pi} style={{marginBottom:14}}>
                    <ChartCard loading={false} minHeight={300}>
                      <div style={{fontSize:FS.footnote,color:MUTED,fontWeight:600,padding:"0 4px 6px"}}>{lu}{ru?` · ${ru}`:""}</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={data} margin={{top:4,right:8,left:0,bottom:0}}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
                          <XAxis dataKey="lbl" tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={multi?70:44}/>
                          <YAxis yAxisId="L" tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} width={40} tickFormatter={axisFmt(lu)} domain={["auto","auto"]} label={{value:lu,angle:-90,position:"insideLeft",fill:MUTED,fontSize:11}}/>
                          {ru && <YAxis yAxisId="R" orientation="right" tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} width={40} tickFormatter={axisFmt(ru)} domain={["auto","auto"]} label={{value:ru,angle:90,position:"insideRight",fill:MUTED,fontSize:11}}/>}
                          <Tooltip content={(props)=><ExplorerTooltip {...props} byKey={byKey}/>} cursor={{stroke:FAINT,strokeDasharray:"3 3"}}/>
                          {keys.map(k=>(
                            <Line key={k} yAxisId={byKey[k].unit===lu?"L":"R"} type="monotone" dataKey={k} stroke={colorOf(k)} strokeWidth={1.6} dot={false} name={k} isAnimationActive={false} connectNulls/>
                          ))}
                          <Brush dataKey="lbl" height={20} stroke={FAINT} fill={BG} travellerWidth={10} tickFormatter={()=>""}/>
                        </ComposedChart>
                      </ResponsiveContainer>
                      <div style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"center",padding:"10px 4px 2px",borderTop:`1px solid ${BORDER}`,marginTop:8}}>
                        {keys.map(k=><LegendSwatch key={k} color={colorOf(k)} label={`${byKey[k].label} (${byKey[k].unit})`}/>)}
                      </div>
                    </ChartCard>
                  </div>
                );
              })}
    </div>
  );
}

function MonthChart({month, onMonthChange, data, loading, mode="month", onModeChange, rangeStart, rangeEnd, onRangeStart, onRangeEnd}) {
  const rangeMode = mode==="range";
  const motionOK = !usePrefersReducedMotion();
  const [showProduced, setShowProduced] = useState(true);
  const [showConsumed, setShowConsumed] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [showBattery, setShowBattery] = useState(true);
  const produced = data.reduce((s,d)=>s+(d.production||0),0)*1000;
  const consumed = data.reduce((s,d)=>s+(d.consumption||0),0)*1000;
  const imported = data.reduce((s,d)=>s+(d.fromGrid||0),0)*1000;
  const exported = data.reduce((s,d)=>s+(d.toGrid||0),0)*1000;
  const charged = data.reduce((s,d)=>s+(d.batCharge||0),0)*1000;
  const discharged = data.reduce((s,d)=>s+(d.batDischarge||0),0)*1000;
  const chartData = data.map(d=>({
    ...d,
    productionPos: d.production||0,
    batDischargePos: d.batDischarge||0,
    fromGridPos: d.fromGrid||0,
    consumptionNeg: -(d.consumption||0),
    batChargeNeg: -(d.batCharge||0),
    toGridNeg: -(d.toGrid||0),
  }));
  const toggleSeries = [
    {key:"produced", label:"Produced", color:CHART_PROD, active:showProduced, onToggle:setShowProduced},
    {key:"consumed", label:"Consumed", color:CHART_CONS, active:showConsumed, onToggle:setShowConsumed},
    {key:"grid", label:"Grid", color:CHART_GRID, active:showGrid, onToggle:setShowGrid},
    {key:"battery", label:"Battery", color:CHART_BAT, active:showBattery, onToggle:setShowBattery},
  ];
  const moAtMax = month >= thisMonth;
  const moPrev = () => { const [y,m]=month.split('-').map(Number); onMonthChange(`${m===1?y-1:y}-${String(m===1?12:m-1).padStart(2,'0')}`); };
  const moNext = () => { if(!moAtMax){const [y,m]=month.split('-').map(Number); onMonthChange(`${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}`);} };
  return (
    <div style={{marginBottom:24}}>
      <PeriodHeader range={rangeMode} title={rangeMode?"Custom range":"Month"} subtitle={rangeMode?"Totals for any date range, like a billing period":"Daily totals"}>
        {onModeChange&&<Segmented size="sm" label="Period" value={rangeMode?"range":"month"} onChange={(v)=>onModeChange(v)} options={[{value:"month",label:"Month"},{value:"range",label:"Custom"}]}/>}
        {rangeMode ? (
          <>
            <input type="date" className="ui-field" aria-label="From" value={rangeStart} max={rangeEnd} onChange={e=>e.target.value&&onRangeStart(e.target.value)}/>
            <span style={{fontSize:FS.subhead,color:MUTED}}>to</span>
            <input type="date" className="ui-field" aria-label="To" value={rangeEnd} max={today} onChange={e=>e.target.value&&onRangeEnd(e.target.value)}/>
          </>
        ) : (
          <>
            <StepButton dir={-1} label="Previous month" onClick={moPrev}/>
            <input type="month" className="ui-field" aria-label="Month" value={month} max={thisMonth} onChange={e=>e.target.value&&onMonthChange(e.target.value)}/>
            <StepButton dir={1} label="Next month" disabled={moAtMax} onClick={moNext}/>
          </>
        )}
      </PeriodHeader>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged} netExported={exported-imported}/>}
      <ChartCard loading={loading} minHeight={340}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} stackOffset="sign" margin={{top:4,right:4,left:0,bottom:0}} {...BAR_MONTH}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="day" tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={rangeMode?22:6}/>
            <YAxis tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} width={38} tickFormatter={kFmt}/>
            <ReferenceLine y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip contentStyle={TOOLTIP_S} formatter={(v,n)=>[`${Math.abs(v).toFixed(1)} kWh`,n]} labelFormatter={l=>rangeMode?l:`Day ${l}`} labelStyle={{color:MUTED,marginBottom:4}} cursor={false}/>
            {showProduced&&<Bar dataKey="productionPos" fill={CHART_PROD} fillOpacity={0.85} name="Solar" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showGrid&&<Bar dataKey="fromGridPos" fill={CHART_GRID} fillOpacity={0.85} name="Grid Import" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showBattery&&<Bar dataKey="batDischargePos" fill={CHART_BAT} fillOpacity={0.85} name="Bat Discharge" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showConsumed&&<Bar dataKey="consumptionNeg" fill={CHART_CONS} fillOpacity={0.85} name="Load" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showGrid&&<Bar dataKey="toGridNeg" fill={CHART_GRID} fillOpacity={0.85} name="Grid Export" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showBattery&&<Bar dataKey="batChargeNeg" fill={CHART_BAT} fillOpacity={0.85} name="Bat Charge" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
          </BarChart>
        </ResponsiveContainer>
        <SeriesToggle series={toggleSeries}/>
      </ChartCard>
    </div>
  );
}

function YearChart({year, onYearChange, data, loading}) {
  const motionOK = !usePrefersReducedMotion();
  const [showProduced, setShowProduced] = useState(true);
  const [showConsumed, setShowConsumed] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [showBattery, setShowBattery] = useState(true);
  const produced = data.reduce((s,d)=>s+(d.production||0),0)*1000;
  const consumed = data.reduce((s,d)=>s+(d.consumption||0),0)*1000;
  const imported = data.reduce((s,d)=>s+(d.fromGrid||0),0)*1000;
  const exported = data.reduce((s,d)=>s+(d.toGrid||0),0)*1000;
  const charged = data.reduce((s,d)=>s+(d.batCharge||0),0)*1000;
  const discharged = data.reduce((s,d)=>s+(d.batDischarge||0),0)*1000;
  const chartData = data.map(d=>({
    ...d,
    productionPos: d.production||0,
    batDischargePos: d.batDischarge||0,
    fromGridPos: d.fromGrid||0,
    consumptionNeg: -(d.consumption||0),
    batChargeNeg: -(d.batCharge||0),
    toGridNeg: -(d.toGrid||0),
  }));
  const toggleSeries = [
    {key:"produced", label:"Produced", color:CHART_PROD, active:showProduced, onToggle:setShowProduced},
    {key:"consumed", label:"Consumed", color:CHART_CONS, active:showConsumed, onToggle:setShowConsumed},
    {key:"grid", label:"Grid", color:CHART_GRID, active:showGrid, onToggle:setShowGrid},
    {key:"battery", label:"Battery", color:CHART_BAT, active:showBattery, onToggle:setShowBattery},
  ];
  const yrAtMax = year >= thisYear;
  const yrPrev = () => onYearChange(String(Number(year)-1));
  const yrNext = () => { if(!yrAtMax) onYearChange(String(Number(year)+1)); };
  return (
    <div style={{marginBottom:24}}>
      <PeriodHeader title="Year" subtitle="Monthly totals">
        <StepButton dir={-1} label="Previous year" onClick={yrPrev}/>
        <select className="ui-field" aria-label="Year" value={year} onChange={e=>onYearChange(e.target.value)}>
          {Array.from({length:Number(thisYear)-2021},(_,i)=>String(2022+i)).map(y=><option key={y} value={y}>{y}</option>)}
        </select>
        <StepButton dir={1} label="Next year" disabled={yrAtMax} onClick={yrNext}/>
      </PeriodHeader>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged} netExported={exported-imported}/>}
      <ChartCard loading={loading} minHeight={320}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} stackOffset="sign" margin={{top:4,right:4,left:0,bottom:0}} {...BAR_YEAR}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="month" tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false}/>
            <YAxis tick={{fill:MUTED,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false} width={42} tickFormatter={kFmt}/>
            <ReferenceLine y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip contentStyle={TOOLTIP_S} formatter={(v,n)=>[`${Math.abs(v).toLocaleString()} kWh`,n]} labelStyle={{color:MUTED,marginBottom:4}} cursor={false}/>
            {showProduced&&<Bar dataKey="productionPos" fill={CHART_PROD} fillOpacity={0.85} name="Solar" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showGrid&&<Bar dataKey="fromGridPos" fill={CHART_GRID} fillOpacity={0.85} name="Grid Import" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showBattery&&<Bar dataKey="batDischargePos" fill={CHART_BAT} fillOpacity={0.85} name="Bat Discharge" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showConsumed&&<Bar dataKey="consumptionNeg" fill={CHART_CONS} fillOpacity={0.85} name="Load" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showGrid&&<Bar dataKey="toGridNeg" fill={CHART_GRID} fillOpacity={0.85} name="Grid Export" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
            {showBattery&&<Bar dataKey="batChargeNeg" fill={CHART_BAT} fillOpacity={0.85} name="Bat Charge" stackId="a" activeBar={false} isAnimationActive={motionOK} animationDuration={450} animationEasing="ease-out"/>}
          </BarChart>
        </ResponsiveContainer>
        <SeriesToggle series={toggleSeries}/>
      </ChartCard>
    </div>
  );
}


// Series on/off chips under a chart (multi-select). Each keeps its series color.
function SeriesToggle({series}) {
  return (
    <div role="group" aria-label="Show series" style={{display:"flex",justifyContent:"center",gap:8,flexWrap:"wrap",paddingTop:12,borderTop:`1px solid ${BORDER}`,marginTop:10}}>
      {series.map(s=>(
        <button key={s.key} type="button" aria-pressed={s.active} className="ui-chip" onClick={()=>s.onToggle(!s.active)}
          style={s.active?{background:`color-mix(in srgb, ${s.color} 13%, white)`,borderColor:`color-mix(in srgb, ${s.color} 45%, white)`,color:TEXT}:undefined}>
          <span style={{width:10,height:10,borderRadius:3,background:s.active?s.color:"transparent",border:`2px solid ${s.color}`,flexShrink:0,transition:"background-color .15s"}}/>
          {s.label}
        </button>
      ))}
    </div>
  );
}

// One share in a list: who/what, its status pill, and a "…" menu with the destructive Revoke.
function ShareRow({title, sub, status, onRevoke}){
  const active = status==="active";
  return (
    <div className="ui-row">
      <span style={{color:MUTED,fontSize:20,display:"inline-flex"}}><Icon name="user"/></span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:FS.body,fontWeight:600,color:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{title}</div>
        <div style={{fontSize:FS.footnote,color:MUTED,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          {sub&&<span>{sub}</span>}
          <span className="ui-pill" style={{background:active?"#DCFCE7":"#FEF3C7",color:active?BATTERY_TEXT:SOLAR_TEXT}}>{active?"Active":"Pending signup"}</span>
        </div>
      </div>
      <MoreMenu label="Share options" items={[{label:"Revoke access", icon:"lock", destructive:true, onClick:onRevoke}]}/>
    </div>
  );
}

// Empty state: an icon, a short title, and what to do next (HIG Writing: clear next steps on blank screens).
function EmptyState({icon="info", title, hint, action=null}){
  return (
    <div style={{textAlign:"center",padding:"32px 16px",display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
      <span style={{fontSize:28,color:FAINT}}><Icon name={icon}/></span>
      <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>{title}</div>
      {hint&&<div style={{fontSize:FS.subhead,color:MUTED,maxWidth:360}}>{hint}</div>}
      {action}
    </div>
  );
}

const TABS = [
  { id:"live", label:"Live", iconName:"bolt" },
  { id:"day",  label:"Day",  iconName:"sun" },
  { id:"month",label:"Month",iconName:"calendar" },
  { id:"year", label:"Year", iconName:"chart" },
  { id:"explorer",label:"Explorer",iconName:"activity" },
];
const ADMIN_TAB = { id:"admin", label:"Admin", iconName:"shield" };

// Top navigation bar. Desktop: back to Fleet, site name, the section tabs, Share, Settings and a "…"
// menu. Phone: back (or logo), a compact title that fades in once the large title scrolls away, Share,
// and a "…" menu that also carries Settings and Admin (the phone tab bar holds the 5 sections only).
function AppHeader({site, multiSite, tabs, tab, onTab, onFleet, onShare, onSettings, onLogout, accounts, activeAccountId, onSwitchAccount, isShared, isAdmin, subtitle, titleShown}){
  const acctItems = accounts.length>1 ? [{header:"Account"}, ...accounts.map(a=>({label:a.label, icon:"user", checked:a.id===activeAccountId, onClick:()=>{ if(a.id!==activeAccountId) onSwitchAccount(a.id); }})), {sep:true}] : [];
  const help = {label:"Help & FAQ", icon:"help", onClick:()=>window.open("/faq","_blank","noopener")};
  const desktopMenu = [...acctItems, help, {sep:true}, {label:"Sign out", icon:"logout", destructive:true, onClick:onLogout}];
  const phoneMenu = [
    {label:"Settings…", icon:"sliders", onClick:onSettings},
    ...(isAdmin&&!isShared ? [{label:"Admin", icon:"shield", checked: tab==="admin" ? true : undefined, onClick:()=>onTab("admin")}] : []),
    help,
    ...(acctItems.length?[{sep:true}, ...acctItems.filter(i=>!i.sep)]:[]),
    {sep:true}, {label:"Sign out", icon:"logout", destructive:true, onClick:onLogout},
  ];
  return (
    <header className="ui-navbar">
      {/* Leading */}
      {multiSite
        ? <button type="button" className="ui-backlink" onClick={onFleet}><Icon name="back"/>Fleet</button>
        : <span style={{display:"inline-flex",flexShrink:0}}><Logo size={28}/></span>}
      <div className="hide-phone" style={{display:"flex",alignItems:"center",gap:10,minWidth:0,flexShrink:1}}>
        {multiSite&&<span style={{display:"inline-flex",flexShrink:0}}><Logo size={28}/></span>}
        <div style={{minWidth:0}}>
          <div style={{fontSize:FS.callout,fontWeight:700,color:TEXT,lineHeight:1.2,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:260}}>{site.name}</div>
          <div style={{fontSize:FS.caption,color:MUTED,whiteSpace:"nowrap"}}>{subtitle}</div>
        </div>
        {isShared&&<span className="ui-pill" style={{background:"#FFFBEB",border:"1px solid #FDE68A",color:SOLAR_TEXT}}>Shared · view only</span>}
      </div>
      {/* Phone compact title */}
      <div className="hide-desktop" style={{flex:1,minWidth:0,textAlign:"center"}}>
        <div className={`ui-navtitle${titleShown?" is-shown":""}`} aria-hidden={!titleShown}>{site.name}</div>
      </div>
      {/* Desktop tabs */}
      <div className="hide-phone" style={{flex:1,display:"flex",justifyContent:"center",minWidth:0}}>
        <Segmented label="Sections" options={tabs.map(t=>({value:t.id,label:t.label}))} value={tab} onChange={onTab}/>
      </div>
      {/* Trailing */}
      <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
        {onShare&&<span className="hide-phone"><Button size="sm" icon="share" onClick={onShare}>Share</Button></span>}
        {onShare&&<span className="hide-desktop"><IconButton icon="share" label="Share site" onClick={onShare}/></span>}
        <span className="hide-phone"><Button size="sm" icon="sliders" onClick={onSettings}>Settings</Button></span>
        <span className="hide-phone"><MoreMenu label="More" items={desktopMenu}/></span>
        <span className="hide-desktop"><MoreMenu label="More" items={phoneMenu}/></span>
      </div>
    </header>
  );
}

// Phone tab bar: the five sections, icon over a one-word label; the selection pill glides between tabs.
function TabBar({tabs, tab, onTab}){
  const box = useRef(null), ind = useRef(null);
  useSlidingIndicator(box, ind, tab, {inset:10});
  return (
    <nav ref={box} className="ui-tabbar" aria-label="Sections">
      <span ref={ind} className="ui-tab-ind" aria-hidden="true"/>
      {tabs.map(t=>(
        <button key={t.id} type="button" className="ui-tab" data-active={tab===t.id?"true":"false"} aria-current={tab===t.id?"page":undefined} onClick={()=>onTab(t.id)}>
          <Icon name={t.iconName} strokeWidth={tab===t.id?2.1:1.8}/>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}

// Large title (phone only). Reports whether it has scrolled under the nav bar.
function useScrolledPast(ref, deps=[]){
  const [past, setPast] = useState(false);
  useEffect(()=>{
    const el = ref.current;
    if(!el || typeof IntersectionObserver==="undefined") return;
    const io = new IntersectionObserver(([e])=>setPast(!e.isIntersecting && e.boundingClientRect.top < 80), {rootMargin:"-56px 0px 0px 0px", threshold:0});
    io.observe(el);
    return ()=>io.disconnect();
  }, deps);
  return past;
}

// Known device-shadow CONFIG/setting codes (the readsettings register set) — excluded from the
// Live Register Probe's "match to live" so coincidental setting values don't drown out real telemetry.
const CONFIG_CODES = new Set([
  "1A18","5101","5000","5001","5019","5029","5002","5003","5004","5005","5006","5007","5008","5009","500A","500B","500C","500D","500E","500F","5010","5011","501A","5021","507F","5017","511D","2125","501F","5020","5025","5026","506C","506D","5033","5030","5031","5121","5059","5034","5035","5036","5037","5038","5039","503A","503B","503C","503D","503E","503F","5040","5041","5042","5043","505A","505B","505C","505D","505E","505F","5060","5061","5027","5028","5012","5013","507A","507B","5078","5079",
  "30B0","30B1","30B2","30B3","30B4","30B5","30B9","30BA","308E","3089","2100","2141","215B","214C","1A48","1A5A","2124","2110","2101","2102","2103","2104","2105","2106","2107","2108","2109","210A","210B","210C","210D","210E","210F","2168","2169","216C","216D","2170","2171","2174","2175","2178","2179","217C","217D","216A","216B","216E","216F","2172","2173","2176","2177","217A","217B","217E","217F","2122","2520","2540","256E","256F","2570","2571","2568","2569","256A","256B","2138","2139","213A","213B","213C","212A","2129","2134","2135","2127","2126","2136","2137","2151","2156","2152","2153","2154","2155","212C","212D","2130","2131","213F","219B",
]);
// Focused live-watch register set for the Live Register Probe: the 0x3000 power block + the
// known live Hz/temp/battery-V codes. Polled every 10s so values can be correlated against the
// live power-flow screen (which register tracks PV vs grid vs load vs battery).
const WATCH_CODES = (()=>{ const a=[]; for(let i=0x3000;i<=0x301F;i++) a.push(i.toString(16).toUpperCase()); a.push("2562","2563","212F"); return a; })();
function AdminPanel({site, inverters, statuses=[], userEmail=""}) {
  // ── Fleet Overview (new) ────────────────────────────────────────────────────
  const [fleetData, setFleetData] = useState(null);      // null = not loaded yet
  const [fleetErr, setFleetErr] = useState(null);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [fleetAllUsers, setFleetAllUsers] = useState(false);
  const [fleetLastRefresh, setFleetLastRefresh] = useState(null);
  const [fleetSort, setFleetSort] = useState({key:"name", dir:1});

  const loadFleet = async (allUsers) => {
    setFleetBusy(true); setFleetErr(null);
    try {
      const r = await api("admin_fleet", { allUsers: !!allUsers });
      setFleetData(r.sites || []);
      setFleetLastRefresh(new Date());
    } catch(e) { setFleetErr(String(e)); }
    setFleetBusy(false);
  };
  useEffect(()=>{ loadFleet(false); }, []);
  // Auto-refresh every 2 minutes, paused while the tab is hidden.
  usePolling(()=>loadFleet(fleetAllUsers), POLL.FLEET_MS, [fleetAllUsers], { leading:false });

  const toggleFleetSort = (key) => setFleetSort(s => s.key===key ? {key, dir:-s.dir} : {key, dir:1});
  const sortIcon = (key) => fleetSort.key===key ? <Icon name={fleetSort.dir===1?"chevron-up":"chevron-down"} style={{marginLeft:2}}/> : null;

  const STATUS_META = { online:{label:"Online",bg:"#D1FAE5",c:BATTERY}, partial:{label:"Partial",bg:"#FEF3C7",c:SOLAR}, offline:{label:"Offline",bg:"#FEE2E2",c:GRID_IN}, error:{label:"Error",bg:"#FEE2E2",c:GRID_IN} };
  const statusRank = {online:3,partial:2,offline:1,error:0};

  const fleetRows = fleetData ? [...fleetData].sort((a,b)=>{
    const k = fleetSort.key, d = fleetSort.dir;
    const v = (m)=>{
      switch(k){
        case "name":   return (m.name||"").toLowerCase();
        case "status": return statusRank[m.status]??-1;
        case "pv":     return m.pv??-1;
        case "load":   return m.load??-1;
        case "soc":    return m.soc??-1;
        case "grid":   return m.gridNet??0;
        case "pvToday":      return m.pvToday??-1;
        case "consumed":     return m.consumedToday??-1;
        case "expToday":     return m.expToday??-1;
        default: return (m.name||"").toLowerCase();
      }
    };
    const av=v(a), bv=v(b);
    if(av<bv) return -d; if(av>bv) return d; return (a.name||"").localeCompare(b.name||"");
  }) : [];

  const [log, setLog] = useState(null);
  const [logErr, setLogErr] = useState(null);
  const [persistent, setPersistent] = useState(false);
  const [hideSelf, setHideSelf] = useState(true); // suppress the admin's own log events by default
  const myUser = (userEmail||"").trim().toLowerCase();
  const shownLog = log && hideSelf ? log.filter(e=>(e.user||"").trim().toLowerCase()!==myUser) : log;
  const [action, setAction] = useState("status");
  const [bodyText, setBodyText] = useState("{}");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  // Live register probe (real-time data discovery) — one "Read all" sweep across the attribute space,
  // orchestrated client-side in windows so no single request is huge. Δ vs the previous full read.
  const [swAutoId, setSwAutoId] = useState(inverters[0]?.autoId || "");
  const [swRes, setSwRes] = useState(null);
  const [swPrev, setSwPrev] = useState(null);
  const [swBusy, setSwBusy] = useState(false);
  const [swErr, setSwErr] = useState(null);
  const [swProg, setSwProg] = useState("");
  const [swChangedOnly, setSwChangedOnly] = useState(false);
  const [swWatch, setSwWatch] = useState(false);
  const [swWatchData, setSwWatchData] = useState({});
  const [swWatchTs, setSwWatchTs] = useState(null);
  const swWatchPrevRef = useRef({});
  // Realtime-flow freshness test (getHybridFlowgraphRealTimeData) — polls every 1s and logs each
  // sample (client time + endpoint SystemTime + values) to a copyable text box, to measure how
  // often the data actually changes and pick a real-time polling interval.
  const [rtfOn, setRtfOn] = useState(false);
  const [rtfData, setRtfData] = useState(null);
  const [rtfTs, setRtfTs] = useState(null);
  const [rtfRaw, setRtfRaw] = useState(false);
  const [rtfLog, setRtfLog] = useState([]);
  const rtfPrevRef = useRef(null);
  const rtfBusyRef = useRef(false);
  const rtfSn = inverters.find(i=>String(i.autoId)===String(swAutoId))?.sn || inverters[0]?.sn || "";
  const [users, setUsers] = useState(null);
  const [usersErr, setUsersErr] = useState(null);
  const [resetSent, setResetSent] = useState({});
  const [linkTarget, setLinkTarget] = useState(null); // userId of the row with link form open
  const [linkUser, setLinkUser] = useState("");
  const [linkPw, setLinkPw] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkErr, setLinkErr] = useState(null);
  const [unlinkBusy, setUnlinkBusy] = useState({}); // { [email]: true } while unlinking
  useEffect(()=>{
    if(!rtfOn || !rtfSn) return;
    let alive = true;
    const poll = async ()=>{
      if(rtfBusyRef.current) return;              // skip if the previous request is still in flight
      if(document.visibilityState==="hidden") return;  // never poll a hidden tab (1s is brutal)
      rtfBusyRef.current = true;
      try {
        const r = await api("flowrt", { serial: rtfSn });
        if(!alive) return;
        setRtfData(cur=>{ rtfPrevRef.current = cur; return r; });
        setRtfTs(new Date());
        const line = `${new Date().toISOString()} | st=${r?.time||"-"} | pv=${r?.pv} grid=${r?.grid} load=${r?.load} bat=${r?.battery} soc=${r?.soc}`;
        setRtfLog(log=>{ const n=[...log, line]; return n.length>1500?n.slice(-1500):n; });
      } catch(e){
        if(alive) setRtfLog(log=>[...log, `${new Date().toISOString()} | ERROR ${String(e)}`]);
      } finally { rtfBusyRef.current = false; }
    };
    poll();
    const id = setInterval(poll, 1000);
    return ()=>{ alive=false; clearInterval(id); };
  }, [rtfOn, rtfSn]);
  useEffect(()=>{ if(!swAutoId && inverters[0]?.autoId) setSwAutoId(inverters[0].autoId); }, [inverters]);
  // Live watch: poll the focused register set every 10s so values can be read off next to a live
  // power-flow screen (resolves the "snapshots taken at different times" ambiguity).
  useEffect(()=>{
    if(!swWatch || !swAutoId) return;
    let alive = true;
    const poll = async ()=>{
      if(document.visibilityState==="hidden") return;  // never poll a hidden tab
      try {
        const r = await api("readsettings", { autoId: swAutoId, codes: WATCH_CODES });
        if(!alive) return;
        setSwWatchData(cur=>{ swWatchPrevRef.current = cur; return r?.data || {}; });
        setSwWatchTs(new Date());
      } catch(e){ /* keep polling */ }
    };
    poll();
    const id = setInterval(poll, 10000);
    return ()=>{ alive=false; clearInterval(id); };
  }, [swWatch, swAutoId]);
  // 0x7000–0xFFFF is confirmed empty. Sweep the full populated range 0x0000–0x6FFF — this includes
  // 0x2xxx (live batV/temp/Hz) which a narrowed sweep had been skipping. Needed to catch the
  // battery-power register on an actively-cycling (off-grid) site.
  const SWEEP_WINDOWS = [
    ["0000","07FF"],["0800","0FFF"],["1000","17FF"],["1800","1FFF"],["2000","27FF"],["2800","2FFF"],
    ["3000","37FF"],["3800","3FFF"],["4000","47FF"],["4800","4FFF"],["5000","57FF"],["5800","5FFF"],
    ["6000","67FF"],["6800","6FFF"],
  ];
  const runSweep = async () => {
    if(!swAutoId) return;
    setSwErr(null); setSwBusy(true); setSwProg("");
    const merged = {}; let requested = 0;
    try {
      for(let i=0;i<SWEEP_WINDOWS.length;i++){
        const [a,b] = SWEEP_WINDOWS[i];
        setSwProg(`Reading 0x${a}–0x${b} (${i+1}/${SWEEP_WINDOWS.length})…`);
        const r = await api("shadowsweep", { autoId: swAutoId, from: a, to: b, chunk: 512 });
        Object.assign(merged, r?.data || {}); requested += r?.requested || 0;
      }
      setSwPrev(swRes?.data || null);
      setSwRes({ data: merged, found: Object.keys(merged).length, requested });
      setSwProg("");
    } catch(e){ setSwErr(String(e)); setSwProg(""); }
    setSwBusy(false);
  };
  const sn = inverters[0]?.sn || "";
  const darkInput = {background:"#292524",border:"1px solid #44403C",borderRadius:6,color:"#FAFAF9",padding:"6px 8px",fontFamily:SANS,fontSize:FS.footnote};
  const inputS = {background:CARD,border:`1px solid ${BORDER}`,borderRadius:6,color:TEXT,padding:"6px 8px",fontFamily:SANS,fontSize:FS.footnote};

  // Per-inverter energy registers for the CURRENT site (from the live status feed). A "stuck" feed-in
  // register = exporting power right now (grid net < 0) but Export Today ≈ 0 — the Dotsikas symptom.
  const regs = statuses.filter(s=>s?.ok&&s?.data).map(s=>{
    const d=s.data, netW=d.grid?.netW||0, expToday=d.grid?.sold?.today||0;
    return { sn:s.sn, label:s.label, netW,
      pvToday:d.photovoltaic?.production?.today, pvTotal:d.photovoltaic?.production?.total,
      expToday, expTotal:d.grid?.sold?.total, impToday:d.grid?.consumption?.today,
      stuck: netW < -100 && expToday < 50 };
  });

  // Sweep every managed site and flag ones exporting power but logging ~0 feed-in (run midday).
  const runScan = async () => {
    setScanning(true); setScan(null);
    try {
      const sr = await api("sites", {});
      const sites = (sr.sites || (Array.isArray(sr)?sr:[])).filter(s=>s.GoodsID?.length);
      const out=[];
      for(const s of sites){
        const serials = s.GoodsID.map(g=>typeof g==="string"?g:g.GoodsID);
        const autoIds = s.GoodsID.map(g=>typeof g==="object"?g.AutoID:null);
        try {
          const r = await api("status", { serials, autoIds, memberAutoId: s.MemberAutoID });
          const inv = (r.results||[]).filter(x=>x.ok&&x.data);
          const exportingNow = inv.some(x=>(x.data.grid?.netW||0) < -100);
          const expTodayWh = inv.reduce((a,x)=>a+(x.data.grid?.sold?.today||0),0);
          out.push({ name:s.MemberID, n:inv.length, exportingNow, expTodayKwh:expTodayWh/1000, stuck: exportingNow && expTodayWh<50 });
        } catch(e){ out.push({ name:s.MemberID, err:String(e).slice(0,60) }); }
        setScan([...out]);
      }
    } catch(e){ setScan([{name:"ERROR: "+String(e)}]); }
    setScanning(false);
  };

  const loadLog = async () => {
    setLogErr(null);
    try { const r = await api("adminlog", {}); setLog(r.log||[]); setPersistent(!!r.persistent); }
    catch(e){ setLogErr(String(e)); setLog([]); }
  };
  useEffect(()=>{ loadLog(); }, []);

  const loadUsers = async () => {
    setUsersErr(null);
    try { const r = await api("admin_users", {}); setUsers(r.users||[]); }
    catch(e){ setUsersErr(String(e)); setUsers([]); }
  };
  useEffect(()=>{ loadUsers(); }, []);

  const sendReset = async (email) => {
    setResetSent(s=>({...s,[email]:"sending"}));
    try { await api("admin_reset_password",{email}); setResetSent(s=>({...s,[email]:"ok"})); }
    catch(e){ setResetSent(s=>({...s,[email]:"err:"+String(e).slice(0,50)})); }
  };
  const openLink = (userId) => { setLinkTarget(userId); setLinkUser(""); setLinkPw(""); setLinkErr(null); };
  const doUnlink = async (targetEmail) => {
    if(!await confirmAlert(`Unlink ${targetEmail}’s Midnite account?`, {message:"They’ll need to link it again to see their data.", action:"Unlink", destructive:true})) return;
    setUnlinkBusy(s=>({...s,[targetEmail]:true}));
    try { await api("admin_unlink_account",{targetEmail}); await loadUsers(); }
    catch(e){ toast("Unlink failed: "+String(e.message||e), {tone:"error", ms:4000}); }
    setUnlinkBusy(s=>({...s,[targetEmail]:false}));
  };
  const doLink = async (targetEmail) => {
    if(!linkUser||!linkPw){setLinkErr("Username and password required");return;}
    setLinkBusy(true); setLinkErr(null);
    try { await api("admin_link_account",{targetEmail,username:linkUser,password:linkPw}); setLinkTarget(null); await loadUsers(); }
    catch(e){ setLinkErr(String(e)); }
    setLinkBusy(false);
  };

  const run = async (a, b) => {
    const act = a || action;
    let body = b;
    if(!body){ try { body = JSON.parse(bodyText||"{}"); } catch { setOut("Invalid JSON body"); return; } }
    if(a){ setAction(a); setBodyText(JSON.stringify(body)); }
    setBusy(true); setOut("Running…");
    try { const r = await api(act, body); setOut(JSON.stringify(r, null, 2)); }
    catch(e){ setOut("ERROR: "+String(e)); }
    setBusy(false);
  };

  const presets = [
    {label:"Raw status", action:"rawstatus", body:{serials:[sn]}},
    {label:"Probe month", action:"probemonth", body:{sn, date:thisMonth}},
    {label:"Probe MPPT", action:"probemppt", body:{sn, date:`${thisMonth}-08`}},
    {label:"Service vs View", action:"viewtest", body:{}},
    {label:"Installer test", action:"installertest", body:{sn, memberAutoId:site?.memberAutoId, date:thisMonth}},
    {label:"Vendor JS", action:"vendorsrc", body:{}},
    {label:"Day excel", action:"dayexcel", body:{sn, date:today, memberId:site?.name}},
    {label:"Device shadow", action:"shadow", body:{sn, autoId:inverters[0]?.autoId, memberAutoId:site?.memberAutoId}},
    {label:"Lookup codes", action:"codelookup", body:{codes:["1A18","1A44"]}},
    {label:"Read settings", action:"readsettings", body:{autoId:inverters[0]?.autoId, sn, memberAutoId:site?.memberAutoId}},
  ];
  const fmtTs = (iso) => { try { return new Date(iso).toLocaleString(); } catch { return iso; } };

  const Th = ({children, a="right"}) => <th style={{textAlign:a,padding:"4px 8px",fontSize:FS.caption,color:MUTED,fontWeight:700,whiteSpace:"nowrap"}}>{children}</th>;
  const Td = ({children, a="right", c=TEXT, b=false}) => <td style={{textAlign:a,padding:"4px 8px",fontSize:FS.footnote,color:c,fontWeight:b?700:500,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{children}</td>;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16,marginBottom:24}}>
      <div style={{fontSize:FS.caption,color:MUTED,fontFamily:"monospace",textAlign:"right"}}>build {BUILD}</div>

      {/* ── Fleet Overview ────────────────────────────────────────────────── */}
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:8,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>Fleet Overview</div>
            <div style={{fontSize:FS.caption,color:MUTED}}>
              {fleetLastRefresh ? `Updated ${fleetLastRefresh.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}` : "Loading…"}
              {fleetBusy && " · refreshing…"}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            <label style={{display:"flex",alignItems:"center",gap:5,fontSize:FS.caption,color:MUTED,fontWeight:600,cursor:"pointer",userSelect:"none"}}>
              <input type="checkbox" checked={fleetAllUsers} onChange={e=>{setFleetAllUsers(e.target.checked);loadFleet(e.target.checked);}} style={{cursor:"pointer"}}/>
              Include all users' sites
            </label>
            <button onClick={()=>loadFleet(fleetAllUsers)} disabled={fleetBusy}
              style={{padding:"4px 10px",borderRadius:8,border:"none",background:BORDER,color:TEXT,fontSize:FS.caption,fontWeight:700,fontFamily:SANS,cursor:fleetBusy?"default":"pointer"}}>
              <Icon name="refresh"/>Refresh
            </button>
          </div>
        </div>
        {fleetErr && <div style={{color:GRID_IN,fontSize:FS.footnote,marginBottom:8}}>{fleetErr}</div>}
        {!fleetData && !fleetErr && <div style={{fontSize:FS.footnote,color:MUTED}}>Loading fleet data…</div>}
        {fleetData && fleetData.length===0 && <div style={{fontSize:FS.footnote,color:MUTED}}>No sites found.</div>}
        {fleetData && fleetData.length>0 && (() => {
          const totalPvNow   = fleetRows.reduce((s,m)=>s+(m.pv||0),0);
          const totalPvToday = fleetRows.reduce((s,m)=>s+(m.pvToday||0),0);
          const totalLoad    = fleetRows.reduce((s,m)=>s+(m.load||0),0);
          const onlineCnt    = fleetRows.filter(m=>m.status==="online").length;
          const thStyle={textAlign:"right",padding:"5px 8px",fontSize:FS.caption,color:MUTED,fontWeight:700,whiteSpace:"nowrap",cursor:"pointer",userSelect:"none"};
          const tdStyle=(a="right",c=TEXT,b=false)=>({textAlign:a,padding:"5px 8px",fontSize:FS.footnote,color:c,fontWeight:b?700:500,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"});
          return <div style={{overflowX:"auto"}}>
            {/* KPI summary row */}
            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:10}}>
              {[
                {label:"Sites", val:fleetRows.length, c:TEXT},
                {label:"Online", val:`${onlineCnt}/${fleetRows.length}`, c:BATTERY},
                {label:"Fleet PV now", val:fmt(totalPvNow), c:SOLAR},
                {label:"Fleet load", val:fmt(totalLoad), c:LOAD_C},
                {label:"PV today", val:fmtE(totalPvToday), c:CHART_PROD},
              ].map(({label,val,c})=>(
                <div key={label} style={{background:BG,borderRadius:10,padding:"6px 12px",minWidth:90}}>
                  <div style={{fontSize:FS.caption,fontWeight:700,color:MUTED,marginBottom:2}}>{label}</div>
                  <div style={{fontSize:FS.body,fontWeight:700,color:c}}>{val}</div>
                </div>
              ))}
            </div>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead><tr style={{borderBottom:`2px solid ${BORDER}`}}>
                <th style={{...thStyle,textAlign:"left"}} onClick={()=>toggleFleetSort("name")}>Site{sortIcon("name")}</th>
                <th style={{...thStyle,textAlign:"center"}} onClick={()=>toggleFleetSort("status")}>Status{sortIcon("status")}</th>
                <th style={thStyle} onClick={()=>toggleFleetSort("pv")}>PV Now{sortIcon("pv")}</th>
                <th style={thStyle} onClick={()=>toggleFleetSort("load")}>Home{sortIcon("load")}</th>
                <th style={thStyle} onClick={()=>toggleFleetSort("soc")}>SOC{sortIcon("soc")}</th>
                <th style={thStyle} onClick={()=>toggleFleetSort("grid")}>Grid{sortIcon("grid")}</th>
                <th style={thStyle} onClick={()=>toggleFleetSort("pvToday")}>PV Today{sortIcon("pvToday")}</th>
                <th style={thStyle} onClick={()=>toggleFleetSort("consumed")}>Consumed{sortIcon("consumed")}</th>
                <th style={thStyle} onClick={()=>toggleFleetSort("expToday")}>Exported{sortIcon("expToday")}</th>
                <th style={thStyle}>Updated</th>
                {fleetAllUsers && <th style={{...thStyle,textAlign:"left"}}>Account</th>}
              </tr></thead>
              <tbody>
                {fleetRows.map((m,i)=>{
                  const sm = STATUS_META[m.status] || STATUS_META.offline;
                  const gridC = (m.gridNet||0)<-50?GRID_OUT:(m.gridNet||0)>50?GRID_IN:MUTED;
                  const socC  = (m.soc||0)<20?GRID_IN:(m.soc||0)<50?SOLAR:BATTERY;
                  const fmtUpdated=(iso)=>{if(!iso) return "—"; try{const d=new Date(iso);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});}catch{return iso;}};
                  return <tr key={i} style={{borderTop:`1px solid ${BORDER}`}}>
                    <td style={tdStyle("left",TEXT,true)}>{m.name}</td>
                    <td style={{...tdStyle("center"),padding:"5px 8px"}}>
                      <span style={{display:"inline-block",padding:"2px 8px",borderRadius:10,fontSize:FS.caption,fontWeight:700,background:sm.bg,color:sm.c}}>{sm.label}</span>
                      {m.total>1&&<span style={{fontSize:FS.caption,color:MUTED,marginLeft:4}}>{m.invOnline??0}/{m.total}</span>}
                    </td>
                    <td style={tdStyle("right",SOLAR)}>{m.pv!=null?fmt(m.pv):"—"}</td>
                    <td style={tdStyle("right",LOAD_C)}>{m.load!=null?fmt(m.load):"—"}</td>
                    <td style={tdStyle("right",socC)}>{m.soc!=null?`${Math.round(m.soc)}%`:"—"}</td>
                    <td style={tdStyle("right",gridC)}>{m.gridNet!=null?(Math.abs(m.gridNet)>50?<span style={{display:"inline-flex",alignItems:"center",gap:3}}>{fmt(Math.abs(m.gridNet))}<Icon name={m.gridNet<0?"arrow-up":"arrow-down"} label={m.gridNet<0?"Exporting":"Importing"}/></span>:"~0"):"—"}</td>
                    <td style={tdStyle("right",CHART_PROD)}>{m.pvToday!=null?fmtE(m.pvToday):"—"}</td>
                    <td style={tdStyle("right",CHART_CONS)}>{m.consumedToday!=null?fmtE(m.consumedToday):"—"}</td>
                    <td style={tdStyle("right",GRID_OUT)}>{m.expToday!=null?fmtE(m.expToday):"—"}</td>
                    <td style={tdStyle("right",FAINT)}>{fmtUpdated(m.updated)}</td>
                    {fleetAllUsers&&<td style={tdStyle("left",MUTED)}>{m.ownerEmail||<span style={{color:MUTED}}>you</span>}</td>}
                  </tr>;
                })}
              </tbody>
            </table>
            <div style={{fontSize:FS.caption,color:MUTED,marginTop:8}}>PV Now / Home from live flow (≤5s); SOC / PV Today / Consumed / Exported from 5-min report. Auto-refreshes every 2 min. Click a column header to sort.</div>
          </div>;
        })()}
      </div>

      {/* Users — all app accounts + linked Midnite handles + password reset */}
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:8,flexWrap:"wrap"}}>
          <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>Users</div>
          <button onClick={loadUsers} style={{padding:"4px 10px",borderRadius:8,border:"none",background:BORDER,color:TEXT,fontSize:FS.caption,fontWeight:700,fontFamily:SANS,cursor:"pointer"}}><Icon name="refresh"/>Refresh</button>
        </div>
        {usersErr && <div style={{color:GRID_IN,fontSize:FS.footnote,marginBottom:8}}>{usersErr}</div>}
        {!users&&!usersErr && <div style={{fontSize:FS.footnote,color:MUTED}}>Loading…</div>}
        {users?.length===0 && <div style={{fontSize:FS.footnote,color:MUTED}}>No users yet.</div>}
        {users?.length>0 && <div style={{overflowX:"auto"}}>
          <table style={{width:"100%",borderCollapse:"collapse"}}>
            <thead><tr>
              <Th a="left">Email</Th>
              <Th a="left">Name</Th>
              <Th a="center">Role</Th>
              <Th a="left">Midnite account</Th>
              <Th>Last sign-in</Th>
              <Th a="center"><span className="sr-only">Actions</span></Th>
            </tr></thead>
            <tbody>
              {(users||[]).flatMap(u=>{
                const rs=resetSent[u.email];
                const isLinking=linkTarget===u.id;
                const rows=[<tr key={u.id} style={{borderTop:`1px solid ${BORDER}`}}>
                  <Td a="left">{u.email}</Td>
                  <Td a="left">{u.profile?.display_name||<span style={{color:MUTED}}>—</span>}</Td>
                  <Td a="center"><span className="ui-pill" style={{background:u.profile?.role==="admin"?"#FEF3C7":"#F1F5F9",color:u.profile?.role==="admin"?SOLAR_TEXT:MUTED}}>{u.profile?.role==="admin"?"Admin":"User"}</span></Td>
                  <Td a="left">{u.accounts.length
                    ? <span>{u.accounts.map(a=>a.midnite_username).join(", ")}{unlinkBusy[u.email]&&<span style={{color:MUTED}}> · unlinking…</span>}</span>
                    : isLinking
                      ? <span style={{color:SOLAR_TEXT,fontWeight:700}}>Linking…</span>
                      : <span style={{color:MUTED}}>Not linked</span>}</Td>
                  <Td>{u.last_sign_in_at?new Date(u.last_sign_in_at).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}):<span style={{color:MUTED}}>Never</span>}
                    {rs==="ok"&&<div style={{color:BATTERY_TEXT,fontSize:FS.footnote}}>Reset email sent</div>}
                    {rs?.startsWith("err")&&<div style={{color:GRID_IN_TEXT,fontSize:FS.footnote}}>Reset failed</div>}</Td>
                  <Td a="center"><MoreMenu label={`Actions for ${u.email}`} items={[
                    {label:rs==="sending"?"Sending reset…":"Send password reset", icon:"mail", disabled:rs==="sending", onClick:()=>sendReset(u.email)},
                    ...(!u.accounts.length?[{label:"Link Midnite account…", icon:"link", onClick:()=>openLink(u.id)}]:[]),
                    ...(u.accounts.length?[{sep:true},{label:"Unlink Midnite account", icon:"link", destructive:true, disabled:!!unlinkBusy[u.email], onClick:()=>doUnlink(u.email)}]:[]),
                  ]}/></Td>
                </tr>];
                if(isLinking) rows.push(<tr key={`link-${u.id}`} style={{borderTop:`1px solid ${BORDER}`}}>
                  <td colSpan={6} style={{padding:"10px 12px",background:"#FAFAF9"}}>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <input className="ui-field" aria-label="Midnite username" value={linkUser} onChange={e=>setLinkUser(e.target.value)} placeholder="Midnite username" autoFocus autoComplete="off" style={{width:180,cursor:"text"}}/>
                      <input className="ui-field" aria-label="Midnite password" type="password" value={linkPw} onChange={e=>setLinkPw(e.target.value)} placeholder="Midnite password" autoComplete="new-password" style={{width:180,cursor:"text"}}/>
                      <Button size="sm" variant="primary" onClick={()=>doLink(u.email)} disabled={linkBusy}>{linkBusy?"Linking…":"Link account"}</Button>
                      <Button size="sm" onClick={()=>setLinkTarget(null)}>Cancel</Button>
                      {linkErr&&<span style={{color:GRID_IN,fontSize:FS.caption}}>{linkErr}</span>}
                    </div>
                  </td>
                </tr>);
                return rows;
              })}
            </tbody>
          </table>
        </div>}
      </div>

      {/* Energy registers — spot stuck feed-in counters */}
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:8,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>Energy Registers — {site?.name||"site"}</div>
            <div style={{fontSize:FS.caption,color:MUTED}}><Icon name="alert"/>= exporting now but Export-Today ≈ 0 (stuck feed-in counter)</div>
          </div>
          <button onClick={runScan} disabled={scanning} style={{padding:"6px 12px",borderRadius:8,border:"none",background:"#0EA5E9",color:"#fff",fontSize:FS.caption,fontWeight:700,fontFamily:SANS,cursor:scanning?"default":"pointer"}}>{scanning?"Scanning…":"Scan all sites"}</button>
        </div>
        {regs.length===0
          ? <div style={{fontSize:FS.footnote,color:MUTED}}>No live inverter data yet (open the Live tab once).</div>
          : <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>
              <Th a="left">Inverter</Th><Th>Grid now</Th><Th>Export today</Th><Th>Export total</Th><Th>Import today</Th><Th>PV today</Th><Th>PV total</Th><Th a="center">Flag</Th>
            </tr></thead><tbody>
              {regs.map(r=>(<tr key={r.sn} style={{borderTop:`1px solid ${BORDER}`}}>
                <Td a="left" b>{r.label} <span style={{color:MUTED,fontWeight:400,fontFamily:"monospace",fontSize:FS.caption}}>{r.sn.slice(-8)}</span></Td>
                <Td c={r.netW<-50?GRID_OUT:r.netW>50?GRID_IN:MUTED}>{fmt(Math.abs(r.netW))}{r.netW<-50?<><Icon name="arrow-up"/></>:r.netW>50?<><Icon name="arrow-down"/></>:""}</Td>
                <Td c={r.stuck?GRID_IN:TEXT} b={r.stuck}>{fmtE(r.expToday)}</Td>
                <Td c={MUTED}>{fmtE(r.expTotal)}</Td>
                <Td>{fmtE(r.impToday)}</Td>
                <Td>{fmtE(r.pvToday)}</Td>
                <Td c={MUTED}>{fmtE(r.pvTotal)}</Td>
                <Td a="center">{r.stuck?<span style={{color:GRID_IN,fontWeight:800}}><Icon name="alert"/></span>:<span style={{color:BATTERY}}><Icon name="check"/></span>}</Td>
              </tr>))}
            </tbody></table></div>}
        {scan && <div style={{marginTop:12,borderTop:`1px solid ${BORDER}`,paddingTop:10}}>
          <div style={{fontSize:FS.caption,fontWeight:700,color:MUTED,marginBottom:6}}>FLEET SCAN ({scan.length} sites){scanning?" …":""}</div>
          {scan.map((s,i)=>(<div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:FS.footnote,padding:"3px 0"}}>
            <span style={{color:s.stuck?GRID_IN:TEXT,fontWeight:s.stuck?700:500}}>{s.stuck?<><Icon name="alert"/></>:s.err?<><Icon name="stop"/></>:<><Icon name="check"/></>}{s.name}</span>
            <span style={{color:MUTED,fontVariantNumeric:"tabular-nums"}}>{s.err?s.err:`${s.exportingNow?"exporting":"idle"} · today ${(s.expTodayKwh||0).toFixed(1)} kWh`}</span>
          </div>))}
        </div>}
      </div>
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:8}}>
          <div>
            <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>Access Log</div>
            <div style={{fontSize:FS.caption,color:MUTED}}>{persistent? "Persistent (Vercel KV)" : "In-memory — recent activity only; add a KV store to persist across restarts"}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <label style={{display:"flex",alignItems:"center",gap:5,fontSize:FS.caption,color:MUTED,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",userSelect:"none"}}>
              <input type="checkbox" checked={hideSelf} onChange={e=>setHideSelf(e.target.checked)} style={{cursor:"pointer"}}/>
              Hide my own events
            </label>
            <button onClick={loadLog} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:FS.caption,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Refresh</button>
          </div>
        </div>
        {logErr && <div style={{color:GRID_IN,fontSize:FS.footnote}}>{logErr}</div>}
        {shownLog && shownLog.length===0 && !logErr && <div style={{fontSize:FS.footnote,color:MUTED}}>{log&&log.length>0&&hideSelf?"No events (your own are hidden).":"No events yet."}</div>}
        {shownLog && shownLog.length>0 && (
          <div style={{maxHeight:300,overflow:"auto"}}>
            {shownLog.map((e,i)=>(
              <div key={i} style={{display:"flex",gap:10,fontSize:FS.footnote,padding:"5px 0",borderBottom:`1px solid ${BORDER}`,alignItems:"baseline"}}>
                <span style={{color:MUTED,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{fmtTs(e.ts)}</span>
                <span style={{fontWeight:700,color:e.type==="login"?BATTERY:LOAD_C,fontSize:FS.caption}}>{e.type}</span>
                <span style={{color:TEXT,fontWeight:600}}>{e.user}</span>
                {e.site && <span style={{color:MUTED}}>· {e.site}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      {/* Live Register Probe — discover real-time data registers via the device-shadow live read */}
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{marginBottom:8}}>
          <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>Live Register Probe</div>
          <div style={{fontSize:FS.caption,color:MUTED,lineHeight:1.5}}>On-demand live read of the inverter via device-shadow (<code>Force:1</code>) — sweeps the whole attribute space. <b>Run it twice ~10s apart</b>: values that <b>changed (Δ, highlighted)</b> are live measurements. Loose tags: ~60→Hz, ~100–300→V, 0–100→%, large→W. Read-only.</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:10}}>
          <input value={swAutoId} onChange={e=>setSwAutoId(e.target.value)} placeholder="AutoId" style={{...inputS,width:100}}/>
          <button onClick={runSweep} disabled={swBusy||!swAutoId} style={{padding:"6px 16px",borderRadius:8,border:"none",background:swBusy?MUTED:"#0EA5E9",color:"#fff",fontSize:FS.footnote,fontWeight:700,fontFamily:SANS,cursor:swBusy?"default":"pointer"}}>{swBusy?"Reading…":"Read all"}</button>
          {swBusy && swProg && <span style={{fontSize:FS.caption,color:MUTED}}>{swProg}</span>}
          {swPrev && !swBusy && (
            <label style={{display:"flex",alignItems:"center",gap:5,fontSize:FS.caption,color:MUTED,fontWeight:600,cursor:"pointer",userSelect:"none",marginLeft:"auto"}}>
              <input type="checkbox" checked={swChangedOnly} onChange={e=>setSwChangedOnly(e.target.checked)} style={{cursor:"pointer"}}/>
              Show changed only
            </label>
          )}
        </div>
        {swErr && <div style={{color:GRID_IN,fontSize:FS.footnote,marginBottom:6}}>{swErr}</div>}
        {/* Live watch — poll the power block every 10s for real-time correlation */}
        <div style={{borderTop:`1px solid ${BORDER}`,marginTop:10,paddingTop:10,marginBottom:6}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <button onClick={()=>setSwWatch(w=>!w)} disabled={!swAutoId} style={{padding:"6px 14px",borderRadius:8,border:"none",background:swWatch?GRID_IN:BATTERY,color:"#fff",fontSize:FS.footnote,fontWeight:700,fontFamily:SANS,cursor:swAutoId?"pointer":"default"}}>{swWatch?<><Icon name="stop"/>Stop watch</>:<><Icon name="play"/>Watch power block (10s)</>}</button>
            <span style={{fontSize:FS.caption,color:MUTED}}>0x3000–0x301F + Hz/temp/batV{swWatchTs?` · updated ${swWatchTs.toLocaleTimeString()}`:""}</span>
          </div>
          {swWatch && (
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(120px,1fr))",gap:6,marginTop:8}}>
              {WATCH_CODES.map(code=>{
                const v = swWatchData[code]; const prev = swWatchPrevRef.current[code];
                if(v===undefined) return null;
                const changed = prev!==undefined && String(prev)!==String(v);
                const zero = parseFloat(v)===0;
                return (
                  <div key={code} style={{display:"flex",alignItems:"baseline",gap:6,padding:"4px 8px",borderRadius:8,border:`1px solid ${changed?"#0EA5E9":BORDER}`,background:changed?"#E0F2FE":(zero?CARD:BG),opacity:zero?0.5:1}}>
                    <span style={{fontFamily:"monospace",fontSize:FS.caption,color:MUTED,fontWeight:700}}>{code}</span>
                    <span style={{fontSize:FS.footnote,color:TEXT,fontWeight:600,fontVariantNumeric:"tabular-nums",marginLeft:"auto"}}>{String(v)}</span>
                    {changed&&<span style={{fontSize:FS.caption,color:"#0369A1",fontWeight:800}}>Δ</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {swRes && !swBusy && (()=>{
          const data = swRes.data;
          const isChanged = (c)=> swPrev && (c in swPrev) && String(swPrev[c])!==String(data[c]);
          const numOf = (c)=> parseFloat(data[c]);
          const nonZero = Object.keys(data).filter(c=>{ const n=numOf(c); return isFinite(n) && n!==0; }).sort();
          const changedCount = Object.keys(data).filter(isChanged).length;
          const shown = swChangedOnly ? Object.keys(data).filter(isChanged).sort() : nonZero;
          // Auto-label: match each live reading from the inverter's status feed against the swept
          // registers at common scale factors (×1/10/100/0.1/0.01; 16-bit two's-complement for negatives).
          const swInv = inverters.find(i=>String(i.autoId)===String(swAutoId));
          const d = swInv ? statuses.find(s=>s.sn===swInv.sn)?.data : null;
          // Exclude known config codes so coincidental setting values don't bury the real telemetry.
          const entries = Object.keys(data).map(c=>[c,numOf(c)]).filter(([c,n])=>isFinite(n)&&n!==0&&!CONFIG_CODES.has(c));
          const targets = d ? [
            ["PV power", d.photovoltaic?.power?.totalDc, "W"],
            ["Grid net", d.grid?.netW, "W"],
            ["Load", balanceLoad(d), "W"],
            ["Battery power", (d.battery?.charge||0)-(d.battery?.discharge||0), "W"],
            ["SOC", d.battery?.soc, "%"],
            ["SOH", d.battery?.healthPercent, "%"],
            ["Battery V", d.battery?.voltage, "V"],
            ["Battery A", d.battery?.current, "A"],
            ["Grid L1 V", d.grid?.lines?.[0]?.voltage, "V"],
            ["Grid L2 V", d.grid?.lines?.[1]?.voltage, "V"],
            ["Grid Hz", d.grid?.lines?.find(l=>l.frequency>0)?.frequency, "Hz"],
            ["Inverter temp", d.inverter?.temperature, "°C"],
          ] : [];
          // Sensible scales per unit (no ×0.01/×0.1 noise that matches any tiny raw value).
          const SCALES = { W:[1], A:[1,10,100], V:[1,10], "%":[1], Hz:[1,10,100], "°C":[1,10] };
          const matchRows = targets.filter(([,v])=>v!=null&&Math.abs(v)>=0.5).map(([label,val,unit])=>{
            const hits=[]; const seen={};
            for(const s of (SCALES[unit]||[1])){ const t=val*s; const tol=Math.max(0.6,Math.abs(t)*0.012);
              for(const [c,n] of entries){
                if(seen[c]) continue;
                if(Math.abs(n)<5 && unit!=="%" && unit!=="°C") continue; // drop tiny-raw coincidences
                if(Math.abs(n-t)<=tol || (val<0 && Math.abs(n-(65536+t))<=tol)){ hits.push({c,s,n}); seen[c]=true; }
              } }
            return {label,val,unit,hits:hits.slice(0,8)};
          });
          return (
            <div>
              <div style={{fontSize:FS.caption,color:MUTED,marginBottom:8}}>requested {swRes.requested} · <b style={{color:TEXT}}>{nonZero.length}</b> non-zero{swPrev?` · ${changedCount} changed since last read`:" · run again to spot live (changing) values"}</div>
              {/* Auto-label table: live reading → candidate register codes */}
              {matchRows.length>0 && (
                <div style={{border:`1px solid ${BORDER}`,borderRadius:10,padding:"8px 10px",marginBottom:10,background:BG}}>
                  <div style={{fontSize:FS.caption,color:MUTED,fontWeight:700,marginBottom:6}}>Match to live status ({swInv?.label})</div>
                  {matchRows.map(r=>(
                    <div key={r.label} style={{display:"flex",gap:8,fontSize:FS.caption,padding:"3px 0",borderBottom:`1px solid ${BORDER}`,alignItems:"baseline",flexWrap:"wrap"}}>
                      <span style={{color:MUTED,fontWeight:600,minWidth:90}}>{r.label}</span>
                      <span style={{color:TEXT,fontWeight:700,fontVariantNumeric:"tabular-nums",minWidth:70}}>{Number(r.val).toFixed(2)} {r.unit}</span>
                      <span style={{fontFamily:"monospace",fontSize:FS.caption,display:"flex",gap:8,flexWrap:"wrap"}}>
                        {r.hits.length
                          ? r.hits.map(h=>{ const live=isChanged(h.c); return <span key={h.c} style={{color:live?"#0369A1":MUTED,fontWeight:live?800:500}}>{h.c}={h.n}{h.s!==1?`(×${h.s})`:""}{live?" Δ":""}</span>; })
                          : <span style={{color:MUTED}}>— no match</span>}
                      </span>
                    </div>
                  ))}
                  <div style={{fontSize:FS.caption,color:MUTED,marginTop:6}}>Config codes excluded. Δ = also changed since last read (live). Power drifts vs the cached status; V/SOC/Hz/temp are the reliable matches.</div>
                </div>
              )}
              {!d && <div style={{fontSize:FS.caption,color:SOLAR,marginBottom:8}}>Open the Live tab once so the matcher has a status snapshot to compare against.</div>}
              {shown.length===0
                ? <div style={{fontSize:FS.footnote,color:MUTED}}>{swChangedOnly?"No values changed since the last read.":"No non-zero registers."}</div>
                : <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:6,maxHeight:360,overflow:"auto"}}>
                    {shown.map(code=>{
                      const v = data[code]; const n = parseFloat(v);
                      const changed = isChanged(code);
                      let tag=null;
                      if(isFinite(n)){ if(n>=59&&n<=61)tag="Hz"; else if(n>=95&&n<=300)tag="V"; else if(n>=0&&n<=100&&Number.isInteger(n))tag="%"; else if(Math.abs(n)>=300)tag="W"; }
                      return (
                        <div key={code} style={{display:"flex",alignItems:"baseline",gap:6,padding:"4px 8px",borderRadius:8,border:`1px solid ${changed?"#0EA5E9":BORDER}`,background:changed?"#E0F2FE":BG}}>
                          <span style={{fontFamily:"monospace",fontSize:FS.caption,color:MUTED,fontWeight:700}}>{code}</span>
                          <span style={{fontSize:FS.footnote,color:TEXT,fontWeight:600,fontVariantNumeric:"tabular-nums",marginLeft:"auto"}}>{String(v)}</span>
                          {tag&&<span style={{fontSize:FS.caption,color:MUTED,fontWeight:700}}>{tag}</span>}
                          {changed&&<span style={{fontSize:FS.caption,color:"#0369A1",fontWeight:800}}>Δ</span>}
                        </div>
                      );
                    })}
                  </div>}
            </div>
          );
        })()}
      </div>
      {/* Realtime Flow Test — is getHybridFlowgraphRealTimeData fresher than the 5-min cache? */}
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{marginBottom:8}}>
          <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>Realtime Flow Test</div>
          <div style={{fontSize:FS.caption,color:MUTED,lineHeight:1.5}}>Polls <code>getHybridFlowgraphRealTimeData</code> <b>every 1s</b> and logs each sample (client time + endpoint SystemTime + values) below so you can copy it back to determine how often the data actually changes. Inverter: <span style={{fontFamily:"monospace"}}>{rtfSn||"—"}</span></div>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:10}}>
          <button onClick={()=>setRtfOn(o=>!o)} disabled={!rtfSn} style={{padding:"6px 14px",borderRadius:8,border:"none",background:rtfOn?GRID_IN:BATTERY,color:"#fff",fontSize:FS.footnote,fontWeight:700,fontFamily:SANS,cursor:rtfSn?"pointer":"default"}}>{rtfOn?<><Icon name="stop"/>Stop</>:<><Icon name="play"/>Log realtime flow (1s)</>}</button>
          {rtfTs && <span style={{fontSize:FS.caption,color:MUTED}}>polled {rtfTs.toLocaleTimeString()} · {rtfLog.length} samples</span>}
          {rtfLog.length>0 && <button onClick={()=>setRtfLog([])} style={{padding:"4px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:FS.caption,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Clear log</button>}
          {rtfData && <button onClick={()=>setRtfRaw(r=>!r)} style={{padding:"4px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:FS.caption,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>{rtfRaw?"Hide raw":"Raw"}</button>}
        </div>
        {rtfData && rtfData.ok===false && <div style={{color:GRID_IN,fontSize:FS.footnote}}>{rtfData.error||"error"}</div>}
        {rtfData && rtfData.ok!==false && (()=>{
          const prev = rtfPrevRef.current;
          const ch = (k)=> prev && String(prev[k])!==String(rtfData[k]);
          const tile = (label,val,changed,color)=>(
            <div style={{padding:"8px 10px",borderRadius:10,border:`1px solid ${changed?"#0EA5E9":BORDER}`,background:changed?"#E0F2FE":BG}}>
              <div style={{fontSize:FS.caption,color:MUTED,fontWeight:700}}>{label}{changed?" Δ":""}</div>
              <div style={{fontSize:FS.callout,fontWeight:700,color:color||TEXT,fontVariantNumeric:"tabular-nums"}}>{val}</div>
            </div>
          );
          return (
            <div>
              <div style={{fontSize:FS.footnote,color:MUTED,marginBottom:8}}>SystemTime: <b style={{color:TEXT}}>{rtfData.time||"—"}</b></div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:8}}>
                {tile("PV",fmt(rtfData.pv),ch("pv"),SOLAR)}
                {tile("Grid",fmt(rtfData.grid),ch("grid"),rtfData.grid<0?GRID_OUT:GRID_IN)}
                {tile("Load",fmt(rtfData.load),ch("load"),LOAD_C)}
                {tile("Battery",fmt(rtfData.battery),ch("battery"),BATTERY)}
                {tile("SOC",`${rtfData.soc}%`,ch("soc"),TEXT)}
              </div>
              {rtfRaw && <pre style={{marginTop:10,maxHeight:220,overflow:"auto",fontSize:FS.caption,background:BG,padding:10,borderRadius:8,border:`1px solid ${BORDER}`,whiteSpace:"pre-wrap"}}>{JSON.stringify(rtfData.raw,null,2)}</pre>}
            </div>
          );
        })()}
        {rtfLog.length>0 && (
          <div style={{marginTop:12}}>
            <div style={{fontSize:FS.caption,color:MUTED,fontWeight:700,marginBottom:4}}>Sample log — select all &amp; copy</div>
            <textarea readOnly value={rtfLog.join("\n")} onFocus={e=>e.target.select()} style={{width:"100%",height:200,fontFamily:"monospace",fontSize:FS.caption,lineHeight:1.5,color:TEXT,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:10,resize:"vertical",whiteSpace:"pre"}}/>
          </div>
        )}
      </div>
      <div style={{background:"#1C1917",borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{color:"#F59E0B",fontWeight:700,fontSize:FS.subhead,marginBottom:10,fontFamily:SANS}}><Icon name="wrench"/>API Debug</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
          {presets.map(p=>(
            <button key={p.label} onClick={()=>run(p.action, p.body)} disabled={busy} style={{background:"#0EA5E9",border:"none",borderRadius:8,color:"#fff",fontWeight:600,padding:"5px 10px",fontSize:FS.caption,cursor:"pointer",fontFamily:SANS}}>{p.label}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
          <input value={action} onChange={e=>setAction(e.target.value)} placeholder="action" style={{...darkInput,width:130}}/>
          <input value={bodyText} onChange={e=>setBodyText(e.target.value)} placeholder='{"sn":"…"}' style={{...darkInput,flex:1,minWidth:160,fontFamily:"ui-monospace,monospace"}}/>
          <button onClick={()=>run()} disabled={busy} style={{background:"#F59E0B",border:"none",borderRadius:8,color:"#1C1917",fontWeight:700,padding:"6px 14px",cursor:"pointer",fontFamily:SANS,fontSize:FS.footnote}}>{busy?"…":"Run"}</button>
        </div>
        {out && <pre style={{whiteSpace:"pre-wrap",wordBreak:"break-word",color:"#E7E5E4",fontSize:FS.caption,lineHeight:1.5,margin:0,fontFamily:"ui-monospace,monospace",maxHeight:420,overflow:"auto"}}>{out}</pre>}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [authState, setAuthState] = useState("loading");
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState(null);

  const [tab, setTab] = useState("live");
  const [isAdmin, setIsAdmin] = useState(false);
  const [role, setRole] = useState("user");
  const [userEmail, setUserEmail] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [sharedAccounts, setSharedAccounts] = useState([]); // accounts shared TO me (view-only)
  const [showShare, setShowShare] = useState(false);
  const [profile, setProfile] = useState({});
  const [sitePhotos, setSitePhotos] = useState({});
  const [activeAccountId, setActiveAccountId] = useState(typeof localStorage!=="undefined" ? localStorage.getItem("midnite_account_id")||null : null);
  const [showAccountSettings, setShowAccountSettings] = useState(false);
  const [statuses, setStatuses] = useState([]);
  const [liveFlow, setLiveFlow] = useState({}); // sn -> live {pv,grid,load,battery,soc,time} from flowrt (~5s)
  const lastLiveAggRef = useRef({ key:null, agg:null }); // last COMPLETE live snapshot (all inverters), per selection
  const [liveUpdatedAt, setLiveUpdatedAt] = useState(null); // browser time the last FRESH flowrt sample arrived (its report time, not our fetch time)
  const lastFlowTimesRef = useRef({}); // sn -> last seen flowrt SystemTime, to detect a genuinely NEW sample (not a duplicate poll)
  const [showCompare, setShowCompare] = useState(false);
  const [liveLoading, setLiveLoading] = useState(true);
  const [liveError, setLiveError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [selectedSns, setSelectedSns] = useState([]);

  const [dayDate, setDayDate] = useState(today);
  const [dayData, setDayData] = useState([]);
  const [daySummary, setDaySummary] = useState(null);
  const [dayMode, setDayMode] = useState({type:"inverter"});
  const [dayLoading, setDayLoading] = useState(false);
  const [monthDate, setMonthDate] = useState(thisMonth);
  const [monthData, setMonthData] = useState([]);
  const [monthLoading, setMonthLoading] = useState(false);
  const [monthMode, setMonthMode] = useState("month"); // "month" | "range" (custom billing period)
  const [rangeStart, setRangeStart] = useState(thisMonth+"-01");
  const [rangeEnd, setRangeEnd] = useState(today);
  const [yearVal, setYearVal] = useState(thisYear);
  const [yearData, setYearData] = useState([]);
  const [yearLoading, setYearLoading] = useState(false);
  const [expStart, setExpStart] = useState(today);
  const [expEnd, setExpEnd] = useState(today);
  const [explorerSn, setExplorerSn] = useState(null);
  const [explorerRows, setExplorerRows] = useState([]);
  const [explorerMetrics, setExplorerMetrics] = useState([]);
  const [explorerMulti, setExplorerMulti] = useState(false);
  const [explorerLoading, setExplorerLoading] = useState(false);

  function handleSitesResponse(data) {
    const raw = data.sites || (Array.isArray(data) ? data : []);
    const normalized = raw.filter(s=>s.GoodsID&&s.GoodsID.length>0).map(s=>({
      name: s.MemberID || "Unknown",
      memberAutoId: s.MemberAutoID ? String(s.MemberAutoID) : null,
      inverters: s.GoodsID.map((g,j)=>({
        sn: typeof g==="string"?g:g.GoodsID,
        autoId: (typeof g==="object"&&g.AutoID) ? String(g.AutoID) : null,
        label: `INV-${j+1}`,
      })),
      statusCounts: s.MemberStateCount || [0,0,0,0],
      installer: s.op_member?.installer || "",
    }));
    setSites(normalized);
    if(normalized.length===0) { setLoginError("No sites found for this account"); setAuthState("link"); return; }
    // Deep-link: email digest links contain ?site=SiteName — auto-navigate there.
    const dlParam = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("site") : null;
    const dlMatch = dlParam && normalized.find(s=>s.name===dlParam);
    if(dlMatch){
      window.history.replaceState({}, "", window.location.pathname); // clean up URL
      setSite(dlMatch); setAuthState("dashboard"); return;
    }
    if(normalized.length===1) { setSite(normalized[0]); setAuthState("dashboard"); }
    else {
      const savedName = localStorage.getItem("midnite_selected_site");
      const saved = savedName && normalized.find(s=>s.name===savedName);
      if(saved) { setSite(saved); setAuthState("dashboard"); }
      else setAuthState("fleet"); // multi-site accounts land on the Fleet view (replaces the Sites picker)
    }
  }

  const setActive = (id) => { if(typeof localStorage!=="undefined"){ if(id) localStorage.setItem("midnite_account_id", id); else localStorage.removeItem("midnite_account_id"); } setActiveAccountId(id); };

  // Load app-account context (role, email, linked Midnite accounts) and route into the app.
  async function loadContext() {
    const acc = await api("accounts"); // { role, email, accounts, profile, sitePhotos }
    setRole(acc.role); setIsAdmin(acc.role==="admin"); setUserEmail(acc.email||""); setAccounts(acc.accounts||[]); setSharedAccounts(acc.sharedAccounts||[]);
    setProfile(acc.profile||{}); setSitePhotos(acc.sitePhotos||{});
    const all = [...(acc.accounts||[]), ...(acc.sharedAccounts||[])]; // own + shared-to-me (view-only)
    if(all.length===0){ setActive(null); setAuthState("link"); return; } // nothing linked or shared → link screen
    let aid = localStorage.getItem("midnite_account_id");
    if(!aid || !all.find(a=>a.id===aid)) aid = all[0].id;
    setActive(aid);
    const sitesData = await api("sites");
    handleSitesResponse(sitesData);
  }

  async function handleLogout() {
    try { await supabase?.auth.signOut(); } catch {}
    localStorage.removeItem("midnite_account_id");
    localStorage.removeItem("midnite_selected_site");
    _apiCache.clear();
    setIsAdmin(false); setRole("user"); setAccounts([]); setActiveAccountId(null);
    if(tab==="admin") setTab("live");
    setSite(null); setSites([]); setStatuses([]); setAuthState("appauth");
  }

  function handleLinked(account){
    setAccounts(a=>[...a, account]); setActive(account.id); _apiCache.clear();
    setAuthState("loading");
    api("sites").then(handleSitesResponse).catch(e=>{ setLoginError(e.message); setAuthState("link"); });
  }
  function switchAccount(id){
    setActive(id); _apiCache.clear(); setSite(null); setStatuses([]); setLiveFlow({}); setAuthState("loading");
    localStorage.removeItem("midnite_selected_site");
    api("sites").then(handleSitesResponse).catch(e=>{ setLoginError(e.message); });
  }
  async function reloadAccounts(){ // after link/unlink/profile/site-photo changes from settings
    const acc = await api("accounts"); setRole(acc.role); setIsAdmin(acc.role==="admin"); setAccounts(acc.accounts||[]); setSharedAccounts(acc.sharedAccounts||[]);
    setProfile(acc.profile||{}); setSitePhotos(acc.sitePhotos||{});
    const all = [...(acc.accounts||[]), ...(acc.sharedAccounts||[])];
    if(all.length){ if(!all.find(a=>a.id===activeAccountId)) switchAccount(all[0].id); }
    else { setActive(null); setShowAccountSettings(false); setSite(null); setSites([]); setAuthState("link"); }
  }

  function handleSelectSite(s) {
    setSite(s); setStatuses([]); setLiveFlow({}); setLiveLoading(true);
    localStorage.setItem("midnite_selected_site", s.name);
    setAuthState("dashboard");
  }
  // Fleet view (multi-site only) is the all-sites landing — replaces the old Sites picker.
  const openFleet = () => setAuthState("fleet");

  useEffect(() => {
    if(!supabaseReady){ setAuthState("appauth"); return; }
    let active = true;
    const route = async (session)=>{
      if(!active) return;
      if(!session){ setAuthState("appauth"); return; }
      try { await loadContext(); }
      catch(e){ if(active){ if(e.status===401){ setAuthState("appauth"); } else { setLoginError(e.message); setAuthState("appauth"); } } }
    };
    supabase.auth.getSession().then(({data})=>route(data.session));
    const { data:sub } = supabase.auth.onAuthStateChange((event, session)=>{
      if(event==="SIGNED_OUT"){ setAuthState("appauth"); return; }
      if(event==="PASSWORD_RECOVERY"){ setAuthState("reset_password"); return; }
      if(event==="SIGNED_IN" || event==="INITIAL_SESSION"){ route(session); }
    });
    return ()=>{ active=false; sub?.subscription?.unsubscribe(); };
  }, []);

  // Log site views (admin access log). Fires once per site selection.
  useEffect(() => { if(site) api("logview", { site: site.name }).catch(()=>{}); }, [site]);

  const fetchLive = useCallback(async () => {
    if(!site) return;
    try {
      const {results} = await api("status", {
        serials: site.inverters.map(i=>i.sn),
        autoIds: site.inverters.map(i=>i.autoId),
        memberAutoId: site.memberAutoId,
      });
      setStatuses(results.map((r,idx)=>({...r,label:site.inverters[idx]?.label})));
      setLastUpdate(new Date()); setLiveError(null);
    } catch(e) { setLiveError(e.message); }
    finally { setLiveLoading(false); }
  }, [site]);

  useEffect(() => { if(site) setLiveLoading(true); }, [site]);
  usePolling(fetchLive, POLL.LIVE_STATUS_MS, [fetchLive], { enabled: !!site });

  // Multi-select: selectedSns holds the serials currently shown. Default to all when a site loads.
  useEffect(() => { if(site){ setSelectedSns(site.inverters.map(i=>i.sn)); setExplorerSn(site.inverters[0]?.sn||null); } }, [site]);
  // Explorer date-range handlers — clamp to ≤7 days and not into the future.
  const onExpStart = (v) => { if(v>today)v=today; let e=expEnd; if(e<v)e=v; if(dayDiff(v,e)>6)e=addDays(v,6); if(e>today)e=today; setExpStart(v); setExpEnd(e); };
  const onExpEnd = (v) => { if(v>today)v=today; let s=expStart; if(v<s)s=v; if(dayDiff(s,v)>6)s=addDays(v,-6); setExpStart(s); setExpEnd(v); };
  const expShift = (delta) => { const span=dayDiff(expStart,expEnd); let s=addDays(expStart,delta), e=addDays(expEnd,delta); if(e>today){ e=today; s=addDays(e,-span); } setExpStart(s); setExpEnd(e); };
  const chartInverters = site ? site.inverters.filter(i=>selectedSns.includes(i.sn)) : [];
  const allSelected = site ? selectedSns.length===site.inverters.length && selectedSns.length>0 : false;
  // Tap behavior: when ALL are selected (the default aggregate), the first tap FOCUSES to just that
  // inverter; once narrowed to a subset, taps add/remove to build a custom set (can't remove the last).
  const toggleInv = (sn) => setSelectedSns(prev=>{
    const total = site ? site.inverters.length : 0;
    if(total && prev.length===total) return [sn];                     // focus from "all" → only this one
    if(prev.includes(sn)){ const next=prev.filter(x=>x!==sn); return next.length?next:prev; } // remove (keep ≥1)
    return [...prev,sn];                                              // add to the subset
  });
  const selectAllInv = () => site && setSelectedSns(site.inverters.map(i=>i.sn));
  const snKey = selectedSns.join(",");

  // Real-time power flow: getHybridFlowgraphRealTimeData refreshes ~every 5s (verified), so poll it
  // every 5s for the selected inverters while on the Live tab and overlay it on the flow/hero.
  // Reset freshness whenever the site or the selected inverters change.
  useEffect(() => {
    if(tab!=="live" || !site) return;
    lastFlowTimesRef.current = {}; setLiveUpdatedAt(null);
  }, [tab, site, snKey]);

  // Caps on the expensive real-time feed: pause after 10 min untouched, and after
  // 1 hour of continuous use. The cheaper 60s status poll keeps running, so the
  // page still shows real (if slower) numbers while the live overlay is paused.
  const liveGate = useLiveGate({
    idleMs: POLL.IDLE_PAUSE_MS,
    sessionMs: POLL.SESSION_MAX_MS,
    enabled: tab==="live" && !!site,
  });
  const liveOn = tab==="live" && !!site && !liveGate.paused;

  // Live real-time overlay. Paused while the tab is hidden: a forgotten Live tab
  // used to fire one request per inverter every 5s forever, which made this the
  // single biggest consumer of the Vercel plan credit.
  usePolling(async () => {
    const sns = snKey ? snKey.split(",") : [];
    if(!sns.length) return;
    const res = await Promise.all(sns.map(sn=>api("flowrt",{serial:sn}).then(r=>({sn,r})).catch(()=>({sn,r:null}))));
    setLiveFlow(prev=>{ const next={...prev}; for(const {sn,r} of res){ if(r && r.ok!==false){ const hasData=!!(r.pv||r.grid||r.load||r.eps||r.battery); next[sn]={pv:r.pv,grid:r.grid,load:r.load,eps:r.eps,gen:r.gen,battery:r.battery,soc:r.soc,time:r.time,noData:!hasData}; } } return next; });
    // Stamp freshness only when a sample genuinely ADVANCED (its SystemTime changed) — so the age
    // reflects the inverter's report time, and duplicate polls let the "X ago" honestly grow.
    let fresh=false;
    for(const {sn,r} of res){ if(r && r.ok!==false && r.time && lastFlowTimesRef.current[sn]!==r.time){ lastFlowTimesRef.current[sn]=r.time; fresh=true; } }
    if(fresh) setLiveUpdatedAt(Date.now());
  }, POLL.LIVE_FLOW_MS, [tab, site, snKey], { enabled: liveOn });

  useEffect(() => {
    if(tab!=="day"||!site) return;
    setDayLoading(true); setDaySummary(null);
    const dayNum = Number(dayDate.slice(8,10));
    const monthStr = dayDate.slice(0,7);
    const single = chartInverters.length===1;
    // Day curve (shape) + month rollup (summary totals, so Day matches Month). When exactly one
    // inverter is selected, also pull the per-MPPT CSV export to break production out by string.
    Promise.all([
      Promise.all(chartInverters.map(inv=>api("day",{sn:inv.sn,date:dayDate}).catch(()=>null))),
      Promise.all(chartInverters.map(inv=>api("month",{sn:inv.sn,date:monthStr}).catch(()=>null))),
      single ? api("dayexcel",{sn:chartInverters[0].sn,date:dayDate,memberId:site.name}).catch(()=>null) : Promise.resolve(null),
    ]).then(([dayAll, monthAll, excel])=>{
      if(single && excel?.rows?.length){
        setDayData(aggregateDayMppt(dayAll[0], excel.rows));
        setDayMode({type:"mppt", active: excel.activeMppts?.length?excel.activeMppts:[0]});
      } else {
        setDayData(aggregateDayData(dayAll));
        setDayMode({type:"inverter"});
      }
      // Day summary tiles read straight from the month rollup so Day == Month == Year for every
      // field (export included). If a site's rollup reports 0 export (stuck feed-in register on the
      // inverter), Day shows 0 too — consistent, and the Admin register read-out surfaces the cause.
      const md = aggregateMonthData(monthAll).find(r=>Number(r.day)===dayNum);
      setDaySummary(md ? {
        produced: md.production*1000, consumed: md.consumption*1000,
        imported: md.fromGrid*1000, exported: md.toGrid*1000,
        charged: md.batCharge*1000, discharged: md.batDischarge*1000,
      } : null);
      setDayLoading(false);
    });
  }, [tab,dayDate,snKey,site]);
  useEffect(() => {
    if(tab!=="month"||!site) return;
    setMonthLoading(true);
    if(monthMode==="range" && rangeStart && rangeEnd && rangeStart<=rangeEnd){
      const months = monthsInRange(rangeStart.slice(0,7), rangeEnd.slice(0,7));
      Promise.all(months.map(m =>
        Promise.all(chartInverters.map(inv=>api("month",{sn:inv.sn,date:m}).catch(()=>null))).then(all=>({m, days:aggregateMonthData(all)}))
      )).then(perMonth=>{ setMonthData(aggregateRange(perMonth, rangeStart, rangeEnd)); setMonthLoading(false); });
    } else {
      Promise.all(chartInverters.map(inv=>api("month",{sn:inv.sn,date:monthDate}).catch(()=>null))).then(all=>{setMonthData(aggregateMonthData(all));setMonthLoading(false);});
    }
  }, [tab,monthDate,monthMode,rangeStart,rangeEnd,snKey,site]);
  useEffect(() => { if(tab!=="year"||!site) return; setYearLoading(true); Promise.all(chartInverters.map(inv=>api("year",{sn:inv.sn,date:yearVal}).catch(()=>null))).then(all=>{setYearData(aggregateYearData(all));setYearLoading(false);}); }, [tab,yearVal,snKey,site]);
  // Explorer: raw per-parameter 5-min series from the dayexcel CSV, for one inverter over a date
  // range (up to 7 days). Each day's rows are tagged with _date and concatenated; the metric catalog
  // is the union across the range.
  useEffect(() => {
    if(tab!=="explorer"||!site||!explorerSn) return;
    setExplorerLoading(true);
    const dates = datesInRange(expStart, expEnd);
    const multi = dates.length>1;
    Promise.all(dates.map(d=>api("dayexcel",{sn:explorerSn,date:d,memberId:site.name}).then(r=>({d,r})).catch(()=>({d,r:null}))))
      .then(results=>{
        const rows=[]; const metricMap={};
        for(const {d,r} of results){
          for(const m of (r?.metrics||[])) if(!metricMap[m.key]) metricMap[m.key]=m;
          for(const row of (r?.rows||[])) rows.push({...row, _date:d, t:(row.time||"").slice(0,5)});
        }
        setExplorerRows(rows); setExplorerMetrics(Object.values(metricMap));
        setExplorerMulti(multi); setExplorerLoading(false);
      });
  }, [tab,expStart,expEnd,explorerSn,site]);

  const visibleStatuses = statuses.filter(s=>selectedSns.includes(s.sn));

  // Flow diagram is built from the SAME detail data as the cards/site card, so every node matches
  // exactly (no second endpoint sampled a moment apart). grid.netW is +import/−export; battery is
  // net (+charge/−discharge); Home comes from the balance to handle smart/EPS-port AIO inverters.
  const selStatus = statuses.filter(s=>s&&s.ok&&s.data&&selectedSns.includes(s.sn));
  let flowAgg = selStatus.length ? (()=>{
    const sum = (fn)=>selStatus.reduce((s,x)=>s+(fn(x.data)||0),0);
    const portW = (p)=> (p?.lines||[]).reduce((b,l)=>b+(l.power||0),0);
    const pv = sum(d=>d.photovoltaic?.power?.totalDc);
    const grid = sum(d=>d.grid?.netW);
    const battery = sum(d=>(d.battery?.charge||0)-(d.battery?.discharge||0));
    const load = sum(d=>balanceLoad(d));
    const gen = sum(d=>portW(d.gen));
    const smartLoad = sum(d=>{const sp=d.smartPorts||{}; return portW(sp.A)+portW(sp.B)+portW(sp.C);});
    const couple = sum(d=>d.couple?.netW||d.couple?.power||0); // provision — shows when the API exposes it
    const w = selStatus.filter(x=>(x.data.battery?.soc||0)>0);
    const times = selStatus.map(x=>x.data.inverter?.lastUpdateTime).filter(Boolean).sort();
    const soc = w.length? w.reduce((s,x)=>s+x.data.battery.soc,0)/w.length : null;
    // Battery capacity readout: rated kWh from the reported Ah rating × nominal 51.2 V, the
    // SOC-derived remaining kWh, and the live charge/discharge rate as %-of-rated-capacity per hour.
    const batsV = selStatus.filter(x=>(x.data.battery?.voltage||0)>0);
    const capAh = batsV.length ? (batsV[0].data.battery.capacityAh||0) : 0;
    const capKwh = capAh>0 ? capAh*51.2/1000 : null;
    const voltage = batsV.length ? batsV.reduce((s,x)=>s+x.data.battery.voltage,0)/batsV.length : null;
    const remainKwh = (capKwh!=null && soc!=null) ? capKwh*soc/100 : null;
    const ratePctHr = (capKwh && Math.abs(battery)>20) ? Math.abs(battery)/1000/capKwh*100 : null; // battery is net watts (+charge)
    return { pv, grid, battery, load, gen, smartLoad, couple, count: selStatus.length,
      updated: times.length ? times[times.length-1] : null,
      soc, capKwh, voltage, remainKwh, ratePctHr, rateSign: battery>0?"+":"−" };
  })() : null;

  // Live overlay from the 5s flowrt feed. We only trust a "complete" poll — one where EVERY selected
  // inverter reported. When the current poll is incomplete, we keep showing the LAST complete snapshot
  // for this selection (old-but-correct beats new-but-partial/invalid), and only fall back to the 5-min
  // status before the first complete live snapshot has ever arrived.
  const liveSel = selectedSns.map(sn=>liveFlow[sn]).filter(Boolean);
  // Slave inverters return all-zero flowrt responses (no independent telemetry). Filter them out before
  // computing aggregates so selecting a slave alone falls back to the 5-min status rather than showing
  // 0W everywhere. Completeness still requires every selected inverter to have responded (liveSel check),
  // but sums use only inverters that actually reported data (liveWithData) — so an all-zero slave adds
  // nothing but doesn't block the live overlay when the master is reporting.
  const liveWithData = liveSel.filter(x=>!x.noData);
  const liveAgg = (liveSel.length && liveSel.length===selectedSns.length && liveWithData.length) ? (()=>{
    // AIO/EPS units serve the house through the EPS port, so loadCurrpac reads 0 — use epsCurrpac.
    const homeOf = (x) => (x.load>0 ? x.load : (x.eps||0));
    const pv = liveWithData.reduce((s,x)=>s+(x.pv||0),0);
    const grid = liveWithData.reduce((s,x)=>s+(x.grid||0),0);
    // Generator from the live genCurrpac. A smart port designated as "generator input" is reported here
    // by the real-time flow feed, so a running gen shows live and reads 0 when off. This is the only live
    // gen signal — the 5-min smart-port gen value was phantom (e.g. 25.8 kW on an idle gen) and is dropped.
    // gen is part of the balance below, so when it runs the battery figure stays correct (not double-fed).
    const gen = liveWithData.reduce((s,x)=>s+(x.gen||0),0);
    const load = liveWithData.reduce((s,x)=>s+homeOf(x),0);
    // Smart load: only a genuine SEPARATE EPS/backup load (load>0 AND eps>0). On AIO units the EPS port
    // IS the house (load=0 → home=eps), so there's no separate smart load; flowrt carries no other
    // smart-load signal, so this keeps a phantom value from ever showing.
    const smartLoad = liveWithData.reduce((s,x)=>s+(((x.load||0)>0 && (x.eps||0)>0) ? x.eps : 0),0);
    // Battery net (+charge/−discharge) from the energy balance — the live Pbat sign is unreliable.
    const battery = pv + grid + gen - load;
    const socs = liveWithData.map(x=>x.soc).filter(v=>v>0); // live SOC can come back 0; fall back to status
    const soc = socs.length ? socs.reduce((a,b)=>a+b,0)/socs.length : null;
    const time = liveWithData.map(x=>x.time).filter(Boolean).sort().slice(-1)[0]||null;
    return { pv, grid, load, battery, gen, smartLoad, soc, time };
  })() : null;
  // Cache the last complete snapshot (keyed to this exact selection) and reuse it when a poll is
  // incomplete — so a missing inverter never drops us back to partial or stale 5-min values.
  if(liveAgg) lastLiveAggRef.current = { key: snKey, agg: liveAgg };
  const effLive = liveAgg || (lastLiveAggRef.current.key===snKey ? lastLiveAggRef.current.agg : null);
  // Merge the complete live snapshot into the flow diagram (gen + smart-load included, so they can't
  // sit stale next to live values); only battery capacity/ratings stay from the 5-min status.
  if(flowAgg && effLive){
    const soc = effLive.soc!=null ? effLive.soc : flowAgg.soc;
    flowAgg = { ...flowAgg, pv:effLive.pv, grid:effLive.grid, battery:effLive.battery, load:effLive.load,
      gen:effLive.gen, smartLoad:effLive.smartLoad, soc,
      updated: effLive.time || flowAgg.updated, live: true, liveAt: liveUpdatedAt,
      remainKwh: (flowAgg.capKwh!=null && soc!=null) ? flowAgg.capKwh*soc/100 : flowAgg.remainKwh,
      ratePctHr: (flowAgg.capKwh && Math.abs(effLive.battery)>20) ? Math.abs(effLive.battery)/1000/flowAgg.capKwh*100 : null,
      rateSign: effLive.battery>0?"+":"−" };
  }

  // Own + shared-to-me accounts for the switcher; whether the active one is a shared (view-only) account.
  const switchAccts = [...accounts.map(a=>({id:a.id,label:a.label||a.midnite_username})), ...sharedAccounts.map(a=>({id:a.id,label:`${a.label} · shared`}))];
  const activeIsShared = sharedAccounts.some(a=>a.id===activeAccountId);
  const largeTitleRef = useRef(null);
  const liveRef = useRef(null);
  const titlePast = useScrolledPast(largeTitleRef, [authState, site?.name]);
  useStaggerIn(liveRef, [authState, tab, site?.name, liveLoading]);
  const tabRef = useRef(null);
  useStaggerIn(tabRef, [authState, tab, site?.name], {y:6, stagger:0.03, duration:0.28});

  if(authState==="loading") return (<><PageHead/><div role="status" aria-label="Loading" style={{minHeight:"100vh",background:BG,display:"flex",flexDirection:"column",gap:14,alignItems:"center",justifyContent:"center",color:MUTED,fontSize:FS.subhead,fontFamily:SANS}}><span className="splash-logo"><Logo size={56}/></span>Loading your sites…</div></>);
  if(authState==="appauth") return <LandingPage/>;
  if(authState==="reset_password") return <ResetPasswordPage onDone={async()=>{ setAuthState("loading"); try{await loadContext();}catch{setAuthState("appauth");} }}/>;
  if(authState==="link") return <LinkMidnite email={userEmail} onLinked={handleLinked} onSignOut={handleLogout} initErr={loginError}/>;
  if(authState==="fleet"||authState==="sites") return <FleetView sites={sites} onPick={handleSelectSite} onBack={site?()=>setAuthState("dashboard"):null} onLogout={handleLogout} sitePhotos={sitePhotos} onPhotoChanged={reloadAccounts} readOnly={sharedAccounts.some(a=>a.id===activeAccountId)}/>;
  // Safety net: if site is null for any reason (e.g. no sites found for a linked account), fall back to link screen.
  if(!site) return <LinkMidnite email={userEmail} onLinked={handleLinked} onSignOut={handleLogout} initErr={loginError}/>;

  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:BG,fontFamily:SANS}}>
        <AppHeader site={site} multiSite={sites.length>1} tabs={isAdmin&&!activeIsShared?[...TABS,ADMIN_TAB]:TABS} tab={tab} onTab={setTab}
          onFleet={openFleet} onShare={!activeIsShared?()=>setShowShare(true):null} onSettings={()=>setShowAccountSettings(true)} onLogout={handleLogout}
          accounts={switchAccts} activeAccountId={activeAccountId} onSwitchAccount={switchAccount} isShared={activeIsShared} isAdmin={isAdmin}
          subtitle={`${site.inverters.length} inverter${site.inverters.length!==1?"s":""}${lastUpdate?` · ${lastUpdate.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}`:""}`}
          titleShown={titlePast}/>

        {/* Content */}
        <main className="page-pad" style={{maxWidth:1120,margin:"0 auto",padding:"16px 16px 32px"}}>
          <div ref={largeTitleRef} className="hide-desktop" style={{margin:"2px 0 14px"}}>
            <h1 className="ui-largetitle">{site.name}</h1>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginTop:4,fontSize:FS.subhead,color:MUTED}}>
              <span>{site.inverters.length} inverter{site.inverters.length!==1?"s":""}{lastUpdate?` · ${lastUpdate.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}`:""}</span>
              {activeIsShared&&<span className="ui-pill" style={{background:"#FFFBEB",border:"1px solid #FDE68A",color:SOLAR_TEXT}}>Shared · view only</span>}
            </div>
          </div>
          {tab==="explorer"
            ? <InverterSelector single value={explorerSn} onPick={setExplorerSn} statuses={statuses} inverters={site.inverters}/>
            : <InverterSelector selectedSns={selectedSns} onToggle={toggleInv} onAll={selectAllInv} allSelected={allSelected} statuses={statuses} inverters={site.inverters}/>}
          {showCompare && <SettingsCompareModal inverters={site.inverters} onClose={()=>setShowCompare(false)}/>}

          {tab==="live"&&(
            <>
              {liveError&&<div role="alert" style={{background:"#FEF2F2",border:`1px solid #FECACA`,borderRadius:12,padding:"12px 16px",marginBottom:12,fontSize:FS.subhead,color:GRID_IN_TEXT,display:"flex",gap:8,alignItems:"center"}}><Icon name="alert"/>Couldn’t load live data: {liveError}</div>}
              {liveLoading
                ? <LiveSkeleton/>
                : <div ref={liveRef}>
                  {liveGate.paused&&(
                    <div className="ui-card" style={{padding:"14px 16px",marginBottom:12,display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,flexWrap:"wrap"}}>
                      <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                        <span style={{color:SOLAR_TEXT,fontSize:FS.title3,marginTop:1}}><Icon name="clock"/></span>
                        <div>
                          <div style={{fontSize:FS.body,fontWeight:700,color:TEXT}}>
                            {liveGate.reason==="session" ? "Live view paused after 1 hour" : "Live view paused"}
                          </div>
                          <div style={{fontSize:FS.subhead,color:MUTED,marginTop:2}}>
                            {liveGate.reason==="session"
                              ? "Still here? Resume to keep the real-time feed running."
                              : "Paused after 10 minutes with no activity. Numbers below still refresh every minute."}
                          </div>
                        </div>
                      </div>
                      <Button variant="primary" size="lg" icon="play" onClick={liveGate.resume}>Resume live</Button>
                    </div>
                  )}
                  <div className={allSelected?"live-top":undefined}>
                    {flowAgg&&<FlowDiagram flow={flowAgg}/>}
                    {allSelected&&<div>
                      <SiteHero statuses={statuses} live={liveAgg} liveAt={liveUpdatedAt}/>
                      <BatteryPanel statuses={statuses}/>
                    </div>}
                  </div>
                  {allSelected&&<LifetimePanel statuses={statuses}/>}
                  {selectedSns.length!==1&&(
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,margin:"6px 2px 10px"}}>
                      <h2 style={{fontSize:FS.title3,fontWeight:800,color:TEXT,letterSpacing:"-0.3px"}}>Inverters</h2>
                      {site.inverters.some(i=>i.autoId)&&<Button size="sm" icon="sliders" onClick={()=>setShowCompare(true)}>Compare settings</Button>}
                    </div>
                  )}
                  {selectedSns.length===1 ? (
                    visibleStatuses.map(s=>{
                      const inv = site.inverters.find(i=>i.sn===s.sn)||{sn:s.sn,label:s.label};
                      return <InverterDetailPanel key={s.sn} inv={inv} status={s}/>;
                    })
                  ) : (
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:16}}>
                      {visibleStatuses.map(s=>{
                        const inv = site.inverters.find(i=>i.sn===s.sn)||{sn:s.sn,label:s.label};
                        return <InverterCard key={s.sn} inv={inv} status={s} live={liveFlow[s.sn]}/>;
                      })}
                    </div>
                  )}
                  {allSelected&&<FaultPanel site={site}/>}
                </div>
              }
            </>
          )}
          <div ref={tabRef}>
          {tab==="day"&&(()=>{
            let prodSeries, consSeries;
            if(dayMode.type==="mppt"){
              prodSeries = dayMode.active.map((mi,idx)=>({key:`pv${mi}`, name:`MPPT${mi+1}`, color:PROD_SHADES[idx%PROD_SHADES.length]}));
              consSeries = [{key:"loadNeg0", name:"Load", color:CONS_SHADES[0]}];
            } else {
              const single = chartInverters.length===1;
              prodSeries = chartInverters.map((inv,i)=>({key:`pv${i}`, name:single?"Solar":`${inv.label} Solar`, color:PROD_SHADES[i%PROD_SHADES.length]}));
              consSeries = chartInverters.map((inv,i)=>({key:`loadNeg${i}`, name:single?"Load":`${inv.label} Load`, color:CONS_SHADES[i%CONS_SHADES.length]}));
            }
            return <DayChart date={dayDate} onDateChange={setDayDate} data={dayData} loading={dayLoading} summary={daySummary} prodSeries={prodSeries} consSeries={consSeries} mpptActive={dayMode.type==="mppt"} mpptHint={site.inverters.length>1}/>;
          })()}
          {tab==="month"&&<MonthChart mode={monthMode} onModeChange={setMonthMode} month={monthDate} onMonthChange={setMonthDate} rangeStart={rangeStart} rangeEnd={rangeEnd} onRangeStart={setRangeStart} onRangeEnd={setRangeEnd} data={monthData} loading={monthLoading}/>}
          {tab==="year"&&<YearChart year={yearVal} onYearChange={setYearVal} data={yearData} loading={yearLoading}/>}
          {tab==="explorer"&&(
            explorerSn
              ? <ExplorerChart start={expStart} end={expEnd} onStart={onExpStart} onEnd={onExpEnd} onPrev={()=>expShift(-1)} onNext={()=>expShift(1)} nextDisabled={expEnd>=today} rows={explorerRows} metrics={explorerMetrics} multi={explorerMulti} loading={explorerLoading} label={site.inverters.find(i=>i.sn===explorerSn)?.label}/>
              : <div style={{textAlign:"center",color:MUTED,padding:48,fontSize:FS.subhead}}>No inverter selected.</div>
          )}
          {tab==="admin"&&isAdmin&&<AdminPanel site={site} inverters={chartInverters} statuses={statuses} userEmail={userEmail}/>}
          </div>
        </main>

        {showAccountSettings && <AccountSettings email={userEmail} role={role} accounts={accounts} activeId={activeAccountId} profile={profile} sites={sites} selectedSite={site} sitePhotos={sitePhotos} onSetActive={switchAccount} onChanged={reloadAccounts} onClose={()=>setShowAccountSettings(false)} onLogout={handleLogout} readOnly={activeIsShared}/>}
        {showShare && site && <ShareModal site={site} accountId={activeAccountId} onClose={()=>setShowShare(false)}/>}

        <TabBar tabs={TABS} tab={tab} onTab={setTab}/>
      </div>
    </>
  );
}
