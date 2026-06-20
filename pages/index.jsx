import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import { supabase, supabaseReady } from "../lib/supabaseClient";
import { AreaChart, Area, BarChart, Bar, ComposedChart, Line, Brush, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea } from "recharts";
import { triggerGroups, getTrigger } from "@/lib/notifications/triggers";
import { summarizeRule } from "@/lib/notifications/engine";

const today = new Date().toISOString().split("T")[0];
const thisMonth = today.slice(0,7);
const thisYear = today.slice(0,4);
// Build marker (baked in at build time via next.config env) — lets you confirm a deploy landed.
const BUILD = `${process.env.NEXT_PUBLIC_COMMIT || "local"} · ${(process.env.NEXT_PUBLIC_BUILD_TIME || "").slice(5,16).replace("T"," ")}`;
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
  return <span style={{fontSize:10,fontWeight:600,color:old?"#92400E":FAINT,background:old?"#FDE68A":"transparent",padding:old?"2px 7px":0,borderRadius:10,whiteSpace:"nowrap",textTransform:"none",letterSpacing:0}}>{old?"⚠ ":""}Updated {fmtAge(m)}</span>;
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
  return <span style={{fontSize:10,fontWeight:600,color:old?"#92400E":BATTERY,background:old?"#FDE68A":"transparent",padding:old?"2px 7px":0,borderRadius:10,whiteSpace:"nowrap",textTransform:"none",letterSpacing:0,display:"inline-flex",alignItems:"center",gap:3}}>{!old&&<span style={{width:5,height:5,borderRadius:"50%",background:BATTERY,display:"inline-block",animation:"pulse 1.5s infinite"}}/>}Updated {label}</span>;
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

// Design tokens
const BG = "#F7F4EF";
const CARD = "#FFFFFF";
const BORDER = "#EAE4DC";
const TEXT = "#1C1917";
const MUTED = "#78716C";
const FAINT = "#A8A29E";
const SOLAR = "#D97706";
const BATTERY = "#16A34A";
const GRID_IN = "#DC2626";
const GRID_OUT = "#059669";
const LOAD_C = "#2563EB";
const SHADOW = "0 1px 2px rgba(0,0,0,0.05), 0 4px 16px rgba(0,0,0,0.06)";
const SHADOW_SM = "0 1px 2px rgba(0,0,0,0.06), 0 2px 8px rgba(0,0,0,0.04)";
const SANS = "'Plus Jakarta Sans', system-ui, -apple-system, sans-serif";
const CHART_PROD = "#3B82F6";
const CHART_CONS = "#F97316";
const CHART_BAT = "#22C55E";
const CHART_GRID = "#94A3B8";

// MONTH/YEAR bar alignment — the permanent fix is a SINGLE shared stackId ("a") on every Bar
// (positives and negatives). Recharts stacks positives up and negatives down at the SAME x, so
// pos/neg are always flush over the zero line — no barGap/barSize hacks, robust to any bar width.
// DO NOT split pos/neg into separate stackIds (that puts them in side-by-side groups → misaligned).
const BAR_MONTH = { barCategoryGap: "20%", maxBarSize: 22 };
const BAR_YEAR  = { barCategoryGap: "20%", maxBarSize: 44 };
const TOOLTIP_S = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"10px 14px", fontSize:12, color:TEXT, boxShadow:"0 4px 20px rgba(0,0,0,0.12)", fontFamily:SANS };

const WORK_MODE_LABELS = {0:"Self Consumption",1:"Feed-In Priority",2:"Backup Priority",3:"Time of Use",4:"Peak Shaving",5:"Off Grid"};
const INV_STATE_LABELS  = {0:"Standby",1:"Normal",2:"Checking",3:"On Grid",4:"Off Grid",5:"Fault"};

const Logo = ({size=32}) => (
  <svg width={size} height={size} viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
    <rect width="256" height="256" rx="40" fill="#0D1F33"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(0 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(45 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(90 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(135 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(180 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(225 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(270 128 128)"/>
    <rect x="120" y="12" width="16" height="50" rx="8" fill="#F59E0B" transform="rotate(315 128 128)"/>
    <circle cx="128" cy="128" r="66" fill="#F59E0B"/>
    <circle cx="128" cy="128" r="44" fill="#0D1F33"/>
    <circle cx="128" cy="128" r="28" fill="#00C8E8"/>
    <circle cx="128" cy="128" r="12" fill="#0D1F33"/>
    <circle cx="128" cy="128" r="5" fill="#FFFFFF"/>
  </svg>
);

const PageHead = () => (
  <Head>
    <title>Midnite Sentinel</title>
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg"/>
    <link rel="preconnect" href="https://fonts.googleapis.com"/>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
    <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>
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
      .tab-btn{transition:all 0.15s ease}
      .site-card{transition:box-shadow 0.2s,transform 0.2s}
      .site-card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.1)!important}
      .inv-card{transition:box-shadow 0.2s}
      .inv-card:hover{box-shadow:0 4px 20px rgba(0,0,0,0.1)!important}
      .fleet-row{transition:background 0.12s}
      .fleet-row:hover{background:#FAF7F2}
      .inv-scroll::-webkit-scrollbar{display:none}
      .inv-scroll{-ms-overflow-style:none;scrollbar-width:none}
      @media(max-width:640px){
        .bottom-nav{display:flex!important}
        .top-tabs{display:none!important}
        .page-pad{padding-bottom:80px!important}
      }
      @media(min-width:641px){
        .bottom-nav{display:none!important}
        .top-tabs{display:flex!important}
      }
    `}</style>
  </Head>
);

const authInput = {width:"100%",padding:"11px 14px",background:BG,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,fontSize:14,fontFamily:SANS,outline:"none",boxSizing:"border-box"};
const lblS = {fontSize:12,color:MUTED,fontWeight:600,display:"block",marginBottom:6};
const errBox = {background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:13,color:GRID_IN};
const okBox = {background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:13,color:BATTERY};
const authBtn = (disabled)=>({width:"100%",padding:"13px 0",borderRadius:10,border:"none",background:disabled?"#E5E7EB":"linear-gradient(135deg,#FCD34D,#D97706)",color:disabled?FAINT:"#7C2D12",fontSize:14,fontWeight:700,fontFamily:SANS,cursor:disabled?"wait":"pointer",boxShadow:disabled?"none":"0 4px 16px rgba(217,119,6,0.3)"});
const GOOGLE_ON = process.env.NEXT_PUBLIC_GOOGLE_AUTH === "1" || process.env.NEXT_PUBLIC_GOOGLE_AUTH === "true";
const GoogleG = ()=>(<svg width="16" height="16" viewBox="0 0 48 48"><path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"/><path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"/><path fill="#EA4335" d="M24 9.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 2.97 29.93 1 24 1 15.4 1 7.96 5.93 4.34 14.12l7.35 5.7C13.42 13.62 18.27 9.75 24 9.75z"/></svg>);
function AuthShell({children, subtitle}){
  return (<><PageHead/><div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
    <div style={{width:"100%",maxWidth:380,animation:"fadeUp 0.4s ease"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <div style={{marginBottom:14,display:"inline-block"}}><Logo size={60}/></div>
        <div style={{fontSize:22,fontWeight:800,color:TEXT,letterSpacing:"-0.3px"}}>Midnite Sentinel</div>
        {subtitle&&<div style={{fontSize:13,color:MUTED,marginTop:4}}>{subtitle}</div>}
      </div>
      {children}
    </div>
  </div></>);
}
// App account login (Supabase): Google OAuth + email/password (no email confirmation).
function AppLogin(){
  const [mode,setMode]=useState("signin");
  const [email,setEmail]=useState(""); const [pw,setPw]=useState("");
  const [err,setErr]=useState(null); const [msg,setMsg]=useState(null); const [busy,setBusy]=useState(false);
  if(!supabaseReady) return <AuthShell subtitle="Configuration needed"><div style={{background:CARD,borderRadius:20,padding:28,boxShadow:SHADOW,fontSize:13,color:MUTED,lineHeight:1.7}}>Sign-in isn’t configured yet. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in the environment and redeploy.</div></AuthShell>;
  const submit=async(e)=>{ e.preventDefault(); setBusy(true); setErr(null); setMsg(null);
    try{
      const { data, error } = mode==="signup"
        ? await supabase.auth.signUp({email,password:pw})
        : await supabase.auth.signInWithPassword({email,password:pw});
      if(error) throw error;
      if(mode==="signup" && !data.session) setMsg("Account created — sign in to continue.");
    }catch(e){ setErr(e.message||String(e)); } finally{ setBusy(false); }
  };
  const google=async()=>{ setErr(null); const { error } = await supabase.auth.signInWithOAuth({provider:"google",options:{redirectTo:typeof window!=="undefined"?window.location.origin:undefined}}); if(error) setErr(error.message); };
  return (
    <AuthShell subtitle={mode==="signup"?"Create your account":"Sign in to your portal"}>
      <div style={{background:CARD,borderRadius:20,padding:28,boxShadow:SHADOW}}>
        {err&&<div style={errBox}>{err}</div>}
        {msg&&<div style={okBox}>{msg}</div>}
        {GOOGLE_ON && <>
          <button onClick={google} style={{width:"100%",padding:"11px 0",borderRadius:10,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:14,fontWeight:600,fontFamily:SANS,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,marginBottom:16}}><GoogleG/> Continue with Google</button>
          <div style={{display:"flex",alignItems:"center",gap:10,margin:"4px 0 16px",color:FAINT,fontSize:12}}><div style={{flex:1,height:1,background:BORDER}}/>or<div style={{flex:1,height:1,background:BORDER}}/></div>
        </>}
        <form onSubmit={submit}>
          <div style={{marginBottom:14}}><label style={lblS}>Email</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" style={authInput}/></div>
          <div style={{marginBottom:20}}><label style={lblS}>Password</label><input type="password" value={pw} onChange={e=>setPw(e.target.value)} autoComplete={mode==="signup"?"new-password":"current-password"} style={authInput}/></div>
          <button type="submit" disabled={busy||!email||!pw} style={authBtn(busy||!email||!pw)}>{busy?"Please wait…":mode==="signup"?"Create account":"Sign in"}</button>
        </form>
        <div style={{textAlign:"center",marginTop:16,fontSize:13,color:MUTED}}>
          {mode==="signup"?"Already have an account? ":"New here? "}
          <button onClick={()=>{setMode(mode==="signup"?"signin":"signup");setErr(null);setMsg(null);}} style={{border:"none",background:"none",color:SOLAR,fontWeight:700,cursor:"pointer",fontFamily:SANS,fontSize:13}}>{mode==="signup"?"Sign in":"Create one"}</button>
        </div>
      </div>
    </AuthShell>
  );
}
// First-run: connect a Midnite account to the signed-in app account.
function LinkMidnite({email,onLinked,onSignOut}){
  const [u,setU]=useState(""); const [p,setP]=useState(""); const [err,setErr]=useState(null); const [busy,setBusy]=useState(false);
  const submit=async(e)=>{ e.preventDefault(); setBusy(true); setErr(null);
    try{ const r=await api("linkaccount",{username:u,password:p}); onLinked(r.account); }
    catch(e){ setErr(e.message); setBusy(false); }
  };
  return (
    <AuthShell subtitle="Link your Midnite account">
      <div style={{background:CARD,borderRadius:20,padding:28,boxShadow:SHADOW}}>
        <div style={{fontSize:13,color:MUTED,lineHeight:1.6,marginBottom:18}}>Signed in as <b style={{color:TEXT}}>{email}</b>. Connect your Midnite login to pull in your system’s data — your credentials are encrypted and never shown again.</div>
        {err&&<div style={errBox}>{err}</div>}
        <form onSubmit={submit}>
          <div style={{marginBottom:14}}><label style={lblS}>Midnite Username</label><input value={u} onChange={e=>setU(e.target.value)} autoFocus style={authInput}/></div>
          <div style={{marginBottom:20}}><label style={lblS}>Midnite Password</label><input type="password" value={p} onChange={e=>setP(e.target.value)} style={authInput}/></div>
          <button type="submit" disabled={busy||!u||!p} style={authBtn(busy||!u||!p)}>{busy?"Linking…":"Link account"}</button>
        </form>
        <div style={{textAlign:"center",marginTop:16}}><button onClick={onSignOut} style={{border:"none",background:"none",color:MUTED,fontWeight:600,cursor:"pointer",fontFamily:SANS,fontSize:13}}>Sign out</button></div>
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
      setAddingFor(null); setMsg("Alert added."); await load();
    }catch(e){ setErr(e.message); }
  };
  const toggleRule = async (rule)=>{ setErr(null); try{ await api("alertrule_save",{ ...rule, enabled:!rule.enabled }); await load(); }catch(e){ setErr(e.message); } };
  const delRule = async (id)=>{ if(typeof window!=="undefined"&&!window.confirm("Delete this alert rule?")) return; try{ await api("alertrule_delete",{id}); await load(); }catch(e){ setErr(e.message); } };
  const sendTest = async (dev)=>{ setErr(null); setMsg(null); setTesting(dev.sn); try{ const r=await api("alerttest",{ site_name:dev.siteName, device_label:dev.label, device_id:dev.sn }); setMsg(`Test email sent to ${r.to}.`); }catch(e){ setErr(e.message); } finally{ setTesting(null); } };

  if(loading) return <div style={{fontSize:13,color:FAINT,padding:"8px 0"}}>Loading alerts…</div>;
  return (
    <>
      {err&&<div style={errBox}>{err}</div>}
      {msg&&<div style={okBox}>{msg}</div>}
      {data && !data.emailConfigured &&
        <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:"10px 14px",marginBottom:14,fontSize:12,color:"#92400E"}}>
          Email delivery isn’t configured yet. Rules still save and evaluate every cycle — they just can’t send until <code style={{fontFamily:"monospace"}}>RESEND_API_KEY</code> is set in the environment.
        </div>}
      {data &&
        <div style={{fontSize:11,color:FAINT,marginBottom:12}}>
          Alerts for <strong style={{color:MUTED}}>{site?.name||"this system"}</strong> go to your account email. Today: <strong style={{color:MUTED}}>{data.dailyUsed}</strong> / {data.dailyCap} sent.
        </div>}
      {!site && <div style={{fontSize:13,color:FAINT}}>Select a system to manage its alerts.</div>}
      {site && devices.length===0 && <div style={{fontSize:13,color:FAINT}}>No devices on this system.</div>}
      {devices.map(dev=>(
        <div key={dev.sn} style={{border:`1px solid ${BORDER}`,borderRadius:12,padding:"12px 14px",marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:8}}>
            <div style={{minWidth:0}}>
              <div style={{fontSize:13,fontWeight:700,color:TEXT}}>{dev.label}</div>
              <div style={{fontSize:11,color:FAINT,fontFamily:"monospace",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{dev.siteName} · {dev.sn}</div>
            </div>
            <button onClick={()=>sendTest(dev)} disabled={testing===dev.sn} style={{padding:"5px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer",whiteSpace:"nowrap"}}>{testing===dev.sn?"Sending…":"Send test"}</button>
          </div>
          {rulesFor(dev.sn).length===0 && addingFor!==dev.sn && <div style={{fontSize:12,color:FAINT,marginBottom:8}}>No alerts on this device.</div>}
          {rulesFor(dev.sn).map(rule=>{
            const t=getTrigger(rule.trigger_type);
            return (
              <div key={rule.id} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderTop:`1px solid ${BORDER}`}}>
                <button onClick={()=>toggleRule(rule)} title={rule.enabled?"Enabled — click to disable":"Disabled — click to enable"} style={{width:34,height:20,borderRadius:10,border:"none",background:rule.enabled?BATTERY:"#D6D3D1",position:"relative",cursor:"pointer",flexShrink:0}}>
                  <span style={{position:"absolute",top:2,left:rule.enabled?16:2,width:16,height:16,borderRadius:"50%",background:"#fff",transition:"left .15s"}}/>
                </button>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12.5,fontWeight:600,color:rule.enabled?TEXT:FAINT}}>{summarizeRule(rule)}{t?.group&&<span style={{marginLeft:6,fontSize:10,color:FAINT,fontWeight:500}}>{t.group}</span>}</div>
                  <div style={{fontSize:10.5,color:FAINT}}>
                    cooldown {rule.cooldown_minutes}m{rule.trigger_after_time?` · after ${rule.trigger_after_time}`:""}
                    {rule.last_triggered_at?` · last sent ${new Date(rule.last_triggered_at).toLocaleString()}`:""}
                  </div>
                </div>
                <button onClick={()=>delRule(rule.id)} style={{padding:"3px 8px",borderRadius:7,border:`1px solid ${BORDER}`,background:CARD,color:GRID_IN,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer",flexShrink:0}}>Delete</button>
              </div>
            );
          })}
          {addingFor===dev.sn
            ? <RuleForm onCancel={()=>setAddingFor(null)} onSave={(form)=>saveRule(dev,form)}/>
            : <button onClick={()=>{setAddingFor(dev.sn);setErr(null);setMsg(null);}} style={{marginTop:8,padding:"6px 12px",borderRadius:8,border:`1px dashed ${BORDER}`,background:"transparent",color:MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>+ Add alert</button>}
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
  const selStyle={...authInput,padding:"9px 12px",fontSize:13,cursor:"pointer"};
  const numStyle={...authInput,padding:"9px 12px",fontSize:13};
  return (
    <div style={{marginTop:10,padding:12,background:BG,borderRadius:10,border:`1px solid ${BORDER}`}}>
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
        <button onClick={()=>onSave({trigger_type:type,threshold,cooldown,afterTime:t.timeGate?afterTime:null})} disabled={threshold===""} style={{...authBtn(threshold===""),width:"auto",padding:"8px 18px",fontSize:13}}>Add alert</button>
        <button onClick={onCancel} style={{padding:"8px 16px",borderRadius:10,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:13,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Cancel</button>
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
  const revoke=async(id)=>{ if(typeof window!=="undefined"&&!window.confirm("Stop sharing this site with them?")) return; try{ await api("share_revoke",{id}); load(); }catch(e){ setErr(e.message); } };
  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:16,maxWidth:460,width:"100%",maxHeight:"90vh",overflow:"auto",boxShadow:"0 12px 48px rgba(0,0,0,0.25)",fontFamily:SANS}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 18px",borderBottom:`1px solid ${BORDER}`}}>
          <div><div style={{fontSize:15,fontWeight:700,color:TEXT}}>Share site</div><div style={{fontSize:11,color:FAINT}}>{site.name}</div></div>
          <button onClick={onClose} style={{border:"none",background:"transparent",fontSize:20,lineHeight:1,color:MUTED,cursor:"pointer"}}>×</button>
        </div>
        <div style={{padding:"14px 18px"}}>
          {err&&<div style={errBox}>{err}</div>}
          {msg&&<div style={okBox}>{msg}</div>}
          <div style={{fontSize:12,color:MUTED,marginBottom:12,lineHeight:1.5}}>Give someone <strong>view-only</strong> access to this site. They'll get an email; if they don't have an account yet, they'll be invited to create one with that address and the site appears automatically. No equipment control — viewing only. Revoke anytime.</div>
          <form onSubmit={submit} style={{display:"flex",gap:8,marginBottom:18}}>
            <input type="email" required placeholder="person@email.com" value={email} onChange={e=>setEmail(e.target.value)} style={{...authInput,flex:1}}/>
            <button type="submit" disabled={busy||!email} style={{...authBtn(busy||!email),width:"auto",padding:"0 18px"}}>{busy?"…":"Share"}</button>
          </form>
          <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Shared with</div>
          {shares===null&&<div style={{fontSize:13,color:FAINT}}>Loading…</div>}
          {shares&&shares.length===0&&<div style={{fontSize:13,color:FAINT}}>Not shared with anyone yet.</div>}
          {shares&&shares.map(s=>(
            <div key={s.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${BORDER}`}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:600,color:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.shared_with_email}</div>
                <div style={{fontSize:11,color:s.status==="active"?BATTERY:SOLAR,fontWeight:600}}>{s.status==="active"?"Active":"Pending — awaiting signup"}</div>
              </div>
              <button onClick={()=>revoke(s.id)} style={{padding:"4px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:GRID_IN,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Revoke</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AccountSettings({email,role,accounts,activeId,profile={},sites=[],selectedSite=null,sitePhotos={},onSetActive,onChanged,onClose}){
  const [sec,setSec]=useState("accounts");
  const [err,setErr]=useState(null); const [msg,setMsg]=useState(null); const [busy,setBusy]=useState(false);
  const isAdmin=role==="admin"; const canAdd=isAdmin||accounts.length===0;
  // Linked Midnite accounts
  const [u,setU]=useState(""); const [p,setP]=useState(""); const [adding,setAdding]=useState(false);
  const addAcct=async(e)=>{ e.preventDefault(); setBusy(true); setErr(null);
    try{ const r=await api("linkaccount",{username:u,password:p}); setU("");setP("");setAdding(false); if(!activeId) onSetActive(r.account.id); onChanged(); }
    catch(e){ setErr(e.message); } finally{ setBusy(false); } };
  const unlink=async(id)=>{ if(typeof window!=="undefined"&&!window.confirm("Unlink this Midnite account?")) return; await api("unlinkaccount",{id}); onChanged(); };
  // Profile
  const [name,setName]=useState(profile.display_name||"");
  const saveName=async()=>{ setBusy(true);setErr(null);setMsg(null); try{ await api("updateprofile",{display_name:name}); setMsg("Profile saved."); onChanged(); }catch(e){setErr(e.message);} finally{setBusy(false);} };
  const ext=(f)=> (f.name.split(".").pop()||"jpg").toLowerCase().replace(/[^a-z0-9]/g,"")||"jpg";
  const onAvatar=async(e)=>{ const f=e.target.files?.[0]; if(!f) return; setBusy(true);setErr(null);setMsg(null);
    try{ const { data:{user} }=await supabase.auth.getUser(); const url=await uploadMedia("avatars",`${user.id}/avatar.${ext(f)}`,f); await api("updateprofile",{avatar_url:`${url}?t=${Date.now()}`}); setMsg("Photo updated."); onChanged(); }
    catch(e){setErr(e.message);} finally{setBusy(false);} };
  // Security
  const [newEmail,setNewEmail]=useState(""); const [newPw,setNewPw]=useState("");
  const changeEmail=async(e)=>{ e.preventDefault(); setBusy(true);setErr(null);setMsg(null); try{ const {error}=await supabase.auth.updateUser({email:newEmail}); if(error)throw error; setMsg("Email change requested — you may need to confirm it."); setNewEmail(""); }catch(e){setErr(e.message);} finally{setBusy(false);} };
  const changePw=async(e)=>{ e.preventDefault(); setBusy(true);setErr(null);setMsg(null); try{ const {error}=await supabase.auth.updateUser({password:newPw}); if(error)throw error; setMsg("Password updated."); setNewPw(""); }catch(e){setErr(e.message);} finally{setBusy(false);} };
  // Site photos
  const onSitePhoto=async(siteName,e)=>{ const f=e.target.files?.[0]; if(!f) return; setBusy(true);setErr(null);setMsg(null);
    try{ const { data:{user} }=await supabase.auth.getUser(); const safe=encodeURIComponent(siteName).replace(/[^A-Za-z0-9]/g,"_").slice(0,60); const url=await uploadMedia("sites",`${user.id}/${safe}.${ext(f)}`,f); await api("setsitephoto",{site:siteName,url:`${url}?t=${Date.now()}`}); onChanged(); }
    catch(e){setErr(e.message);} finally{setBusy(false);} };
  const removeSitePhoto=async(siteName)=>{ setBusy(true); try{ await api("setsitephoto",{site:siteName,url:null}); onChanged(); }finally{setBusy(false);} };

  const tabBtn=(id,label)=><button onClick={()=>{setSec(id);setErr(null);setMsg(null);}} style={{padding:"6px 12px",borderRadius:8,border:"none",background:sec===id?BG:"transparent",color:sec===id?TEXT:MUTED,fontSize:12,fontWeight:sec===id?700:500,cursor:"pointer",fontFamily:SANS}}>{label}</button>;
  const fileBtn=(label,onChange)=>(<label style={{display:"inline-block",padding:"8px 14px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:12,fontWeight:600,cursor:"pointer"}}>{label}<input type="file" accept="image/*" onChange={onChange} style={{display:"none"}}/></label>);

  return (
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:16,maxWidth:500,width:"100%",maxHeight:"90vh",overflow:"auto",boxShadow:"0 12px 48px rgba(0,0,0,0.25)",fontFamily:SANS}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"16px 18px",borderBottom:`1px solid ${BORDER}`,position:"sticky",top:0,background:CARD,zIndex:1}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {profile.avatar_url
              ? <img src={profile.avatar_url} alt="" style={{width:34,height:34,borderRadius:"50%",objectFit:"cover",border:`1px solid ${BORDER}`}}/>
              : <div style={{width:34,height:34,borderRadius:"50%",background:BG,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:MUTED}}>{(profile.display_name||email||"?").slice(0,1).toUpperCase()}</div>}
            <div>
              <div style={{fontSize:15,fontWeight:700,color:TEXT}}>{profile.display_name||"Account Settings"}</div>
              <div style={{fontSize:11,color:FAINT}}>{email}{isAdmin&&<span style={{marginLeft:6,color:SOLAR,fontWeight:700}}>ADMIN</span>}</div>
            </div>
          </div>
          <button onClick={onClose} style={{border:"none",background:"transparent",fontSize:20,lineHeight:1,color:MUTED,cursor:"pointer"}}>×</button>
        </div>
        <div style={{display:"flex",gap:4,padding:"10px 14px 0",flexWrap:"wrap"}}>{tabBtn("accounts","Midnite")}{tabBtn("profile","Profile")}{tabBtn("security","Security")}{tabBtn("sites","Site Photos")}{tabBtn("alerts","Notifications")}</div>
        <div style={{padding:"14px 18px"}}>
          {err&&<div style={errBox}>{err}</div>}
          {msg&&<div style={okBox}>{msg}</div>}

          {sec==="accounts" && <>
            <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Linked Midnite accounts</div>
            {accounts.length===0 && <div style={{fontSize:13,color:FAINT,marginBottom:12}}>None linked yet.</div>}
            {accounts.map(a=>(
              <div key={a.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${BORDER}`}}>
                {isAdmin && <input type="radio" name="activeacct" checked={activeId===a.id} onChange={()=>onSetActive(a.id)} style={{cursor:"pointer"}}/>}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:TEXT}}>{a.label||a.midnite_username}{activeId===a.id&&<span style={{marginLeft:6,fontSize:9,color:BATTERY,fontWeight:800}}>ACTIVE</span>}</div>
                  <div style={{fontSize:11,color:FAINT,fontFamily:"monospace"}}>{a.midnite_username}{a.account_type?` · ${a.account_type}`:""}</div>
                </div>
                <button onClick={()=>unlink(a.id)} style={{padding:"4px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:GRID_IN,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Unlink</button>
              </div>
            ))}
            {canAdd && !adding && <button onClick={()=>setAdding(true)} style={{marginTop:14,padding:"8px 14px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>{accounts.length===0?"Link a Midnite account":"+ Add Midnite account"}</button>}
            {!canAdd && accounts.length>0 && <div style={{marginTop:12,fontSize:11,color:FAINT}}>Your plan allows one linked Midnite account. Unlink the current one to connect a different system.</div>}
            {adding && (
              <form onSubmit={addAcct} style={{marginTop:14,padding:14,background:BG,borderRadius:10,border:`1px solid ${BORDER}`}}>
                <div style={{marginBottom:10}}><label style={lblS}>Midnite Username</label><input value={u} onChange={e=>setU(e.target.value)} autoFocus style={authInput}/></div>
                <div style={{marginBottom:14}}><label style={lblS}>Midnite Password</label><input type="password" value={p} onChange={e=>setP(e.target.value)} style={authInput}/></div>
                <div style={{display:"flex",gap:8}}>
                  <button type="submit" disabled={busy||!u||!p} style={{...authBtn(busy||!u||!p),width:"auto",padding:"9px 18px"}}>{busy?"Linking…":"Link"}</button>
                  <button type="button" onClick={()=>{setAdding(false);setErr(null);}} style={{padding:"9px 16px",borderRadius:10,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:13,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Cancel</button>
                </div>
              </form>
            )}
          </>}

          {sec==="profile" && <>
            <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16}}>
              {profile.avatar_url
                ? <img src={profile.avatar_url} alt="" style={{width:64,height:64,borderRadius:"50%",objectFit:"cover",border:`1px solid ${BORDER}`}}/>
                : <div style={{width:64,height:64,borderRadius:"50%",background:BG,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,fontWeight:700,color:MUTED}}>{(name||email||"?").slice(0,1).toUpperCase()}</div>}
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
            <div style={{fontSize:11,color:FAINT,marginBottom:12}}>Add a photo for each site. These show here and may be used elsewhere later.</div>
            {sites.length===0 && <div style={{fontSize:13,color:FAINT}}>No sites yet — link a Midnite account first.</div>}
            {sites.map(s=>(
              <div key={s.name} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:`1px solid ${BORDER}`}}>
                {sitePhotos[s.name]
                  ? <img src={sitePhotos[s.name]} alt="" style={{width:56,height:56,borderRadius:10,objectFit:"cover",border:`1px solid ${BORDER}`}}/>
                  : <div style={{width:56,height:56,borderRadius:10,background:BG,border:`1px dashed ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>🏠</div>}
                <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:600,color:TEXT,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</div>
                {fileBtn(sitePhotos[s.name]?"Replace":"Upload", e=>onSitePhoto(s.name,e))}
                {sitePhotos[s.name] && <button onClick={()=>removeSitePhoto(s.name)} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:GRID_IN,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Remove</button>}
              </div>
            ))}
          </>}

          {sec==="alerts" && <NotificationsSettings activeId={activeId} site={selectedSite}/>}
        </div>
      </div>
    </div>
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
              <div style={{fontSize:15,fontWeight:700,color:TEXT}}>Select a Site</div>
              <div style={{fontSize:11,color:FAINT}}>{filtered.length} of {sites.length} site{sites.length!==1?"s":""}</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {onFleet&&<button onClick={onFleet} style={{padding:"7px 14px",borderRadius:8,border:"none",background:"linear-gradient(135deg,#FCD34D,#D97706)",color:"#7C2D12",fontSize:12,fontWeight:700,fontFamily:SANS,cursor:"pointer",boxShadow:"0 2px 8px rgba(217,119,6,0.25)"}}>⊞ Fleet View</button>}
            <button onClick={onLogout} style={{padding:"7px 14px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Sign out</button>
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
              style={{width:"100%",padding:"11px 14px 11px 38px",background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,color:TEXT,fontSize:14,fontFamily:SANS,outline:"none",boxShadow:SHADOW_SM,boxSizing:"border-box"}}
            />
            {query&&<button onClick={()=>setQuery("")} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",border:"none",background:"transparent",color:FAINT,cursor:"pointer",fontSize:18,lineHeight:1,padding:0}}>×</button>}
          </div>
          {filtered.length===0&&<div style={{textAlign:"center",color:FAINT,fontSize:13,padding:"48px 0"}}>No sites match "{query}"</div>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
            {filtered.map(s=>{
              const [on,alarm,off,disc]=s.statusCounts;
              const total=s.inverters.length;
              return (
                <button key={s.name} onClick={()=>onSelect(s)} className="site-card" style={{textAlign:"left",padding:"20px",background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,cursor:"pointer",display:"flex",flexDirection:"column",gap:10,boxShadow:SHADOW_SM}}>
                  <div>
                    <div style={{fontSize:16,fontWeight:700,color:TEXT}}>{s.name}</div>
                    <div style={{fontSize:12,color:FAINT,marginTop:2}}>{total} inverter{total!==1?"s":""}</div>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {on>0&&<span style={{fontSize:11,color:BATTERY,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:BATTERY,display:"inline-block"}}/>{on} online</span>}
                    {alarm>0&&<span style={{fontSize:11,color:SOLAR,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:SOLAR,display:"inline-block"}}/>{alarm} alarm</span>}
                    {off>0&&<span style={{fontSize:11,color:GRID_IN,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:GRID_IN,display:"inline-block"}}/>{off} offline</span>}
                    {disc>0&&<span style={{fontSize:11,color:FAINT,fontWeight:600,display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:FAINT,display:"inline-block"}}/>{disc} disconnected</span>}
                    {total===0&&<span style={{fontSize:11,color:FAINT}}>No inverters</span>}
                  </div>
                  {s.installer&&<div style={{fontSize:11,color:FAINT}}>{s.installer}</div>}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"flex-end",color:SOLAR,fontSize:12,fontWeight:700,gap:4,marginTop:2}}>View →</div>
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
function FleetView({ sites, onPick, onBack, onLogout }){
  const [data, setData] = useState({});        // site.name -> { loading, results, error }
  const [sortKey, setSortKey] = useState("status");
  const [sortDir, setSortDir] = useState(1);   // 1 asc, -1 desc
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all"); // all | online | issues
  const [busy, setBusy] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);

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
  useEffect(()=>{ load(); const t=setInterval(load,120000); return ()=>clearInterval(t); }, [load]); // 2-min (data is 5-min)

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
    else status={label:"Checking…",color:FAINT,rank:5};
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

  const cols=[
    {k:"name",label:"Site",a:"left"},{k:"status",label:"Status",a:"left"},
    {k:"pv",label:"PV Now",a:"right"},{k:"load",label:"Load",a:"right"},
    {k:"soc",label:"Battery",a:"right"},{k:"grid",label:"Grid",a:"right"},
    {k:"pvToday",label:"PV Today",a:"right"},{k:"expToday",label:"Exported",a:"right"},
    {k:"updated",label:"Updated",a:"right",nosort:true},
  ];
  const Sk=()=> <span style={{display:"inline-block",width:46,height:11,borderRadius:4,background:"#ECE7E0",animation:"pulse 1.4s infinite"}}/>;
  const th={padding:"9px 12px",fontSize:10.5,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.05em",whiteSpace:"nowrap",userSelect:"none",position:"sticky",top:0,background:CARD,borderBottom:`1px solid ${BORDER}`,zIndex:1};
  const td={padding:"11px 12px",fontSize:13,color:TEXT,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",borderBottom:`1px solid ${BORDER}`};
  const kpi=(label,value,color,onClick,active)=>(
    <div onClick={onClick} style={{background:active?"#FFFBEB":CARD,border:`1px solid ${active?SOLAR:BORDER}`,borderRadius:12,padding:"12px 14px",boxShadow:SHADOW_SM,cursor:onClick?"pointer":"default"}}>
      <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em"}}>{label}</div>
      <div style={{fontSize:20,fontWeight:800,color:color||TEXT,marginTop:3,fontVariantNumeric:"tabular-nums"}}>{value}</div>
    </div>
  );
  const fchip=(id,label)=> <button onClick={()=>setFilter(id)} style={{padding:"5px 12px",borderRadius:20,border:`1px solid ${filter===id?SOLAR:BORDER}`,background:filter===id?"#FFFBEB":CARD,color:filter===id?"#92400E":MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>{label}</button>;

  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:BG,fontFamily:SANS}}>
        <div style={{borderBottom:`1px solid ${BORDER}`,padding:"12px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,background:CARD,position:"sticky",top:0,zIndex:100,flexWrap:"wrap"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {onBack&&<button onClick={onBack} title="Back" style={{border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,width:30,height:30,borderRadius:8,cursor:"pointer",fontSize:16,lineHeight:1}}>‹</button>}
            <Logo size={30}/>
            <div>
              <div style={{fontSize:15,fontWeight:700,color:TEXT}}>Fleet View</div>
              <div style={{fontSize:11,color:FAINT}}>{sites.length} sites · <span style={{color:BATTERY,fontWeight:600}}>{onlineCount} online</span>{issueCount>0&&<> · <span style={{color:SOLAR,fontWeight:600}}>{issueCount} need attention</span></>}</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <button onClick={exportCsv} style={{padding:"7px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>⬇ CSV</button>
            <button onClick={load} disabled={busy} style={{padding:"7px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:busy?"default":"pointer"}}>{busy?"Refreshing…":"↻ Refresh"}</button>
            <button onClick={onLogout} style={{padding:"7px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Sign out</button>
          </div>
        </div>

        <div style={{maxWidth:1180,margin:"0 auto",padding:"18px 16px 32px",animation:"fadeUp 0.35s ease"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:16}}>
            {kpi("Sites",sites.length,TEXT,()=>setFilter("all"),filter==="all")}
            {kpi("Online",onlineCount,BATTERY,()=>setFilter("online"),filter==="online")}
            {kpi("Need Attention",issueCount,issueCount>0?SOLAR:FAINT,()=>setFilter("issues"),filter==="issues")}
            {kpi("Fleet PV Now",fmt(totalPv,1),SOLAR)}
            {kpi("Fleet PV Today",fmtE(totalPvToday),TEXT)}
          </div>

          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            <div style={{position:"relative",flex:"1 1 200px",maxWidth:300}}>
              <svg style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",pointerEvents:"none"}} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={FAINT} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" placeholder="Search sites…" value={query} onChange={e=>setQuery(e.target.value)} style={{width:"100%",padding:"9px 12px 9px 34px",background:CARD,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,fontSize:13,fontFamily:SANS,outline:"none",boxSizing:"border-box"}}/>
            </div>
            {fchip("all","All")}{fchip("online","Online")}{fchip("issues","Issues")}
            {lastRefresh&&<span style={{fontSize:11,color:FAINT,marginLeft:"auto"}}>as of {lastRefresh.toLocaleTimeString()}</span>}
          </div>

          <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:14,overflow:"hidden",boxShadow:SHADOW_SM}}>
            <div style={{overflow:"auto",maxHeight:"min(70vh,680px)"}}>
              <table style={{borderCollapse:"collapse",width:"100%",minWidth:820}}>
                <thead><tr>
                  {cols.map(c=>(
                    <th key={c.k} onClick={()=>!c.nosort&&setSort(c.k)} style={{...th,textAlign:c.a,cursor:c.nosort?"default":"pointer",color:sortKey===c.k?TEXT:FAINT}}>
                      {c.label}{sortKey===c.k&&!c.nosort&&<span style={{marginLeft:3}}>{sortDir>0?"▲":"▼"}</span>}
                    </th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.length===0&&<tr><td colSpan={cols.length} style={{...td,textAlign:"center",color:FAINT,padding:"32px 0"}}>No sites match.</td></tr>}
                  {rows.map(m=>{
                    const imp=m.gridNet>50, exp=m.gridNet<-50;
                    const chg=m.batNet>20, dis=m.batNet<-20;
                    return (
                      <tr key={m.site.name} onClick={()=>onPick(m.site)} className="fleet-row" style={{cursor:"pointer"}}>
                        <td style={{...td,maxWidth:240}}>
                          <div style={{fontWeight:700,color:TEXT,whiteSpace:"normal"}}>{m.site.name}</div>
                          <div style={{fontSize:11,color:FAINT}}>{m.site.installer||`${m.total} inverter${m.total!==1?"s":""}`}</div>
                        </td>
                        <td style={td}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{width:8,height:8,borderRadius:"50%",background:m.status.color,flexShrink:0}}/>
                            <div>
                              <div style={{fontWeight:600,color:m.status.color}}>{m.status.label}</div>
                              <div style={{fontSize:10.5,color:FAINT}}>{(m.invOnline??m.on)}/{m.total} online</div>
                            </div>
                          </div>
                        </td>
                        <td style={{...td,textAlign:"right",fontWeight:600,color:m.pv>0?SOLAR:TEXT}}>{m.loading?<Sk/>:fmt(m.pv,1)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:fmt(m.load,1)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(m.soc==null?<span style={{color:FAINT}}>—</span>:<span style={{fontWeight:600,color:m.soc>60?BATTERY:m.soc>30?SOLAR:GRID_IN}}>{Math.round(m.soc)}%{chg?<span style={{color:BATTERY}}> ↑</span>:dis?<span style={{color:SOLAR}}> ↓</span>:""}</span>)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(exp?<span style={{color:GRID_OUT,fontWeight:600}}>↑ {fmt(-m.gridNet,1)}</span>:imp?<span style={{color:GRID_IN,fontWeight:600}}>↓ {fmt(m.gridNet,1)}</span>:<span style={{color:FAINT}}>—</span>)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:fmtE(m.pvToday)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(m.expToday>0?fmtE(m.expToday):<span style={{color:FAINT}}>—</span>)}</td>
                        <td style={{...td,textAlign:"right"}}>{m.loading?<Sk/>:(m.error?<span style={{color:GRID_IN,fontSize:11}}>error</span>:(m.updated?<UpdatedChip time={m.updated}/>:<span style={{color:FAINT}}>—</span>))}</td>
                      </tr>
                    );
                  })}
                  {rows.length>1&&(()=>{ const t=rows.reduce((a,m)=>({pv:a.pv+(m.pv||0),load:a.load+(m.load||0),pvToday:a.pvToday+(m.pvToday||0),exp:a.exp+(m.expToday||0)}),{pv:0,load:0,pvToday:0,exp:0}); return (
                    <tr style={{background:"#FBF8F3",position:"sticky",bottom:0}}>
                      <td style={{...td,fontWeight:800,borderTop:`2px solid ${BORDER}`}}>{rows.length} sites</td>
                      <td style={{...td,borderTop:`2px solid ${BORDER}`}}/>
                      <td style={{...td,textAlign:"right",fontWeight:800,color:SOLAR,borderTop:`2px solid ${BORDER}`}}>{fmt(t.pv,1)}</td>
                      <td style={{...td,textAlign:"right",fontWeight:700,borderTop:`2px solid ${BORDER}`}}>{fmt(t.load,1)}</td>
                      <td style={{...td,borderTop:`2px solid ${BORDER}`}}/>
                      <td style={{...td,borderTop:`2px solid ${BORDER}`}}/>
                      <td style={{...td,textAlign:"right",fontWeight:700,borderTop:`2px solid ${BORDER}`}}>{fmtE(t.pvToday)}</td>
                      <td style={{...td,textAlign:"right",fontWeight:700,borderTop:`2px solid ${BORDER}`}}>{t.exp>0?fmtE(t.exp):"—"}</td>
                      <td style={{...td,borderTop:`2px solid ${BORDER}`}}/>
                    </tr>
                  ); })()}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{fontSize:11,color:FAINT,marginTop:10,textAlign:"center"}}>Tap a row to open that site. Status is the live fleet fetch; metrics are the latest 5-min report, auto-refreshing every 2 minutes.</div>
        </div>
      </div>
    </>
  );
}

function SOCBar({value}) {
  const color = value>60 ? BATTERY : value>30 ? SOLAR : GRID_IN;
  return (
    <div style={{display:"flex",alignItems:"center",gap:8}}>
      <div style={{flex:1,height:6,background:"#F1F5F9",borderRadius:3,overflow:"hidden"}}>
        <div style={{width:`${value}%`,height:"100%",background:color,borderRadius:3,transition:"width 0.5s ease"}}/>
      </div>
      <span style={{fontSize:12,color,fontWeight:700,minWidth:32,fontVariantNumeric:"tabular-nums"}}>{value}%</span>
    </div>
  );
}

function StatTile({label, value, color=MUTED, sub=null}) {
  return (
    <div style={{background:BG,borderRadius:10,padding:"10px 12px"}}>
      <div style={{fontSize:11,color:FAINT,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:3}}>{label}</div>
      <div style={{fontSize:15,fontWeight:700,color,fontVariantNumeric:"tabular-nums"}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:FAINT,marginTop:1}}>{sub}</div>}
    </div>
  );
}

function SummaryStrip({produced, consumed, imported, exported, charged, discharged, netExported}) {
  const [openTip, setOpenTip] = useState(null);
  const items = [
    {label:"Produced", value:fmtE(produced), color:CHART_PROD},
    {label:"Consumed", value:fmtE(consumed), color:CHART_CONS},
    {label:"Imported", value:fmtE(imported), color:GRID_IN},
    {label:"Exported", value:fmtE(exported), color:GRID_OUT},
    ...(netExported!=null?[{label: netExported>=0?"Net Exported":"Net Imported", value:fmtE(Math.abs(netExported)), color: netExported>=0?GRID_OUT:GRID_IN, tip:`Exported ${fmtE(exported)} − Imported ${fmtE(imported)} = ${netExported<0?"−":""}${fmtE(Math.abs(netExported))}`}]:[]),
    // Show the battery pair together whenever there's any battery activity, so Discharged never
    // silently drops out when its (often under-reported) energy register rounds to 0.
    ...((charged>0||discharged>0)?[
      {label:"Charged", value:fmtE(charged), color:BATTERY},
      {label:"Discharged", value:fmtE(discharged), color:SOLAR},
    ]:[]),
  ];
  return (
    <div style={{background:CARD,borderRadius:14,padding:"16px 20px",marginBottom:16,boxShadow:SHADOW_SM,border:`1px solid ${BORDER}`}}>
      <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
        {items.map(it=>(
          <div key={it.label} onClick={it.tip?()=>setOpenTip(t=>t===it.label?null:it.label):undefined} title={it.tip||undefined} style={{cursor:it.tip?"pointer":"default"}}>
            <div style={{fontSize:11,color:FAINT,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>{it.label}{it.tip&&<span style={{marginLeft:4,color:FAINT,fontWeight:700}}>ⓘ</span>}</div>
            <div style={{fontSize:15,fontWeight:700,color:it.color,fontVariantNumeric:"tabular-nums"}}>{it.value}</div>
            {it.tip&&openTip===it.label&&<div style={{fontSize:10,color:MUTED,fontWeight:500,marginTop:3,whiteSpace:"nowrap"}}>{it.tip}</div>}
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
  const gridLabel = isExporting ? `Exporting ${fmt(Math.abs(totalGrid))}` : isImporting ? `Importing ${fmt(totalGrid)}` : "Grid balanced";
  return (
    <div style={{background:`linear-gradient(135deg,#FFFBEB,#FEF3C7)`,borderRadius:16,padding:"20px 20px",marginBottom:16,border:`1px solid #FDE68A`,boxShadow:"0 2px 8px rgba(217,119,6,0.08)"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:11,color:"#92400E",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:2,display:"flex",alignItems:"center",gap:6}}>Site Production Now{live&&<span style={{display:"inline-flex",alignItems:"center",gap:3,padding:"1px 6px",borderRadius:10,background:"#DCFCE7",border:"1px solid #86EFAC"}}><span style={{width:5,height:5,borderRadius:"50%",background:BATTERY,display:"inline-block",animation:"pulse 1.5s infinite"}}/><span style={{fontSize:8,fontWeight:800,color:BATTERY}}>LIVE</span></span>}{live ? <LiveChip atMs={liveAt}/> : <UpdatedChip time={updated}/>}</div>
          <div style={{fontSize:36,fontWeight:800,color:"#92400E",lineHeight:1,letterSpacing:"-1px",fontVariantNumeric:"tabular-nums"}}>{fmt(totalPv,2)}</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5}}>
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:20,background:isExporting?"#DCFCE7":isImporting?"#FEE2E2":"#F1F5F9",border:`1px solid ${isExporting?"#86EFAC":isImporting?"#FECACA":"#E2E8F0"}`}}>
            <span style={{width:7,height:7,borderRadius:"50%",background:gridColor,display:"inline-block"}}/>
            <span style={{fontSize:12,fontWeight:700,color:gridColor}}>{gridLabel}</span>
          </div>
          {gridFreq&&<span style={{fontSize:10,color:MUTED,fontWeight:500}}>{gridFreq.toFixed(2)} Hz</span>}
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(90px,1fr))",gap:8}}>
        <StatTile label="Load" value={fmt(totalLoad,2)} color={LOAD_C}/>
        <StatTile label="Battery" value={totalBat>10?`+${fmt(totalBat)}`:totalBat<-10?fmt(totalBat):"Idle"} color={totalBat>10?BATTERY:totalBat<-10?SOLAR:MUTED} sub={avgSoc!=null?`SOC ${avgSoc.toFixed(0)}%`:null}/>
        <StatTile label="PV Today" value={fmtE(totalToday)} color={TEXT}/>
        {totalImpToday>0&&<StatTile label="Imported" value={fmtE(totalImpToday)} color={GRID_IN}/>}
        {totalExpToday>0&&<StatTile label="Exported" value={fmtE(totalExpToday)} color={GRID_OUT}/>}
        {avgSelfSuff!=null&&<StatTile label="Self-Sufficient" value={`${avgSelfSuff.toFixed(0)}%`} color={MUTED}/>}
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
    <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:"18px 20px",marginBottom:16,boxShadow:SHADOW_SM}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:9,background:closedLoop?"#DCFCE7":"#F1F5F9",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🔋</div>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:TEXT}}>{closedLoop ? brand : "Battery Bank"}</div>
            <div style={{fontSize:11,color:FAINT}}>
              {capacityAh > 0 && `${capacityAh} Ah`}
              {capacityKwh && ` · ~${capacityKwh} kWh`}
              {!closedLoop && <span style={{color:SOLAR,fontWeight:600}}> · Open loop (no BMS)</span>}
            </div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <UpdatedChip time={updated}/>
          {isCharging    && <span style={{fontSize:11,fontWeight:700,color:BATTERY,background:"#DCFCE7",padding:"3px 8px",borderRadius:10}}>↑ {fmt(totalCharge)}</span>}
          {isDischarging && <span style={{fontSize:11,fontWeight:700,color:SOLAR,background:"#FEF3C7",padding:"3px 8px",borderRadius:10}}>↓ {fmt(totalDischarge)}</span>}
          {!isCharging && !isDischarging && <span style={{fontSize:11,fontWeight:600,color:FAINT}}>Idle</span>}
        </div>
      </div>

      <div style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:6}}>
          <span style={{fontSize:12,fontWeight:600,color:MUTED}}>State of Charge{!closedLoop && " (estimated)"}</span>
          <span style={{fontSize:24,fontWeight:800,color:socColor,fontVariantNumeric:"tabular-nums"}}>{Math.round(avgSoc)}%</span>
        </div>
        <div style={{height:10,background:"#F1F5F9",borderRadius:5,overflow:"hidden"}}>
          <div style={{width:`${avgSoc}%`,height:"100%",background:`linear-gradient(90deg,${socColor},${socColor}CC)`,borderRadius:5,transition:"width 0.5s ease"}}/>
        </div>
        {rate
          ? <div style={{marginTop:8,fontSize:12,fontWeight:600,color:rate.color}}>{rate.sign}{rate.pct.toFixed(1)}%/hr · {fmtHrs(rate.hrs)} {rate.label}</div>
          : capacityKwhNum && <div style={{marginTop:8,fontSize:12,fontWeight:500,color:FAINT}}>Idle</div>}
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(100px,1fr))",gap:8}}>
        <StatTile label="Voltage"  value={`${avgVoltage.toFixed(1)} V`} color={TEXT}/>
        <StatTile label="Current"  value={`${totalCurrent.toFixed(1)} A`} color={TEXT}/>
        {closedLoop && <StatTile label="Health" value={`${Math.round(avgHealth)}%`} color={avgHealth>80?BATTERY:avgHealth>60?SOLAR:GRID_IN}/>}
        {closedLoop && avgTemp > 0 && <StatTile label="Temp" value={`${avgTemp.toFixed(0)}°C`} color={avgTemp>45?GRID_IN:avgTemp>35?SOLAR:TEXT}/>}
        {totalChargeIn    > 0 && <StatTile label="Lifetime In"  value={fmtE(totalChargeIn)}    color={MUTED}/>}
        {totalDischargeOut > 0 && <StatTile label="Lifetime Out" value={fmtE(totalDischargeOut)} color={MUTED}/>}
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
    <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:"18px 20px",marginBottom:16,boxShadow:SHADOW_SM}}>
      <div style={{fontSize:11,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>Lifetime Totals</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:8}}>
        <StatTile label="PV Produced"   value={fmtE(pvTotal)}   color={CHART_PROD}/>
        <StatTile label="Grid Exported" value={fmtE(expTotal)}  color={GRID_OUT}/>
        <StatTile label="Grid Imported" value={fmtE(impTotal)}  color={GRID_IN}/>
        {loadTotal>0&&<StatTile label="Load Total" value={fmtE(loadTotal)} color={LOAD_C}/>}
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
  const inputS = {background:CARD,border:`1px solid ${BORDER}`,borderRadius:6,color:TEXT,padding:"4px 8px",fontSize:11,fontFamily:SANS,cursor:"pointer"};
  return (
    <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,overflow:"hidden",boxShadow:SHADOW_SM,marginBottom:16}}>
      <button onClick={()=>setExpanded(x=>!x)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:"transparent",border:"none",cursor:"pointer",fontFamily:SANS,textAlign:"left"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:12,color:FAINT}}>⚡</span>
          <span style={{fontSize:12,fontWeight:600,color:MUTED}}>Fault Log</span>
          {!loading&&events&&<span style={{fontSize:11,color:FAINT}}>— {events.length} events · {activeCount} active</span>}
          {!loading&&!events&&<span style={{fontSize:11,color:FAINT}}>— pick a range & search</span>}
          {loading&&<span style={{fontSize:11,color:FAINT}}>Loading…</span>}
        </div>
        <span style={{fontSize:11,color:FAINT}}>{expanded?"▲":"▼"}</span>
      </button>
      {expanded&&(
        <>
          <div style={{borderTop:`1px solid ${BORDER}`,padding:"10px 16px",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:11,color:FAINT}}>From</span>
            <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={inputS}/>
            <span style={{fontSize:11,color:FAINT}}>to</span>
            <input type="date" value={endDate} max={today} onChange={e=>setEndDate(e.target.value)} style={inputS}/>
            <button onClick={load} disabled={loading||!startDate||!endDate} style={{...inputS,background:SOLAR,color:"#fff",border:"none",fontWeight:700,cursor:loading?"default":"pointer"}}>{loading?"…":"Search"}</button>
          </div>
          <div style={{borderTop:`1px solid ${BORDER}`,overflowY:"auto",maxHeight:320,padding:"4px 0"}}>
            {loading&&<div style={{color:FAINT,fontSize:12,textAlign:"center",padding:"16px 0"}}>Loading…</div>}
            {!loading&&!events&&<div style={{color:FAINT,fontSize:12,textAlign:"center",padding:"16px 0"}}>Pick a date range and press Search.</div>}
            {!loading&&events?.length===0&&<div style={{color:FAINT,fontSize:12,textAlign:"center",padding:"16px 0"}}>No fault events in this range</div>}
            {!loading&&events?.map((e,i)=>(
              <div key={i} style={{display:"grid",gridTemplateColumns:"auto 1fr auto",gap:10,padding:"7px 16px",borderBottom:i<events.length-1?`1px solid ${BORDER}`:"none",alignItems:"start"}}>
                <span style={{fontSize:10,fontWeight:700,color:e.status==="1"?GRID_IN:BATTERY,padding:"2px 6px",borderRadius:4,background:e.status==="1"?"#FEF2F2":"#DCFCE7",whiteSpace:"nowrap"}}>{e.status==="1"?"ACTIVE":"CLEARED"}</span>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:TEXT}}>Code {e.ErrorCode}: {FAULT_DESC[e.ErrorCode]||"Unrecognized code"}</div>
                  <div style={{fontSize:10,color:FAINT}}>{e.GoodsID}</div>
                </div>
                <span style={{fontSize:10,color:FAINT,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums"}}>{(e.Time||"").slice(5,16)}</span>
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
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:16,maxWidth:560,width:"100%",maxHeight:"85vh",overflow:"auto",boxShadow:"0 12px 48px rgba(0,0,0,0.25)",fontFamily:SANS}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"16px 18px",borderBottom:`1px solid ${BORDER}`,position:"sticky",top:0,background:CARD}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:TEXT}}>Inverter Settings</div>
            <div style={{fontSize:11,color:FAINT,fontFamily:"monospace"}}>{inv.label} · {inv.sn}</div>
          </div>
          <button onClick={onClose} style={{border:"none",background:"transparent",fontSize:20,lineHeight:1,color:MUTED,cursor:"pointer"}}>×</button>
        </div>
        <div style={{padding:"14px 18px"}}>
          {err && <div style={{fontSize:12,color:GRID_IN,padding:"8px 10px",background:"#FEF2F2",borderRadius:8}}>{err}</div>}
          {!err && !data && <div style={{fontSize:13,color:FAINT,textAlign:"center",padding:"24px 0"}}>Reading live settings from the inverter…</div>}
          {!err && data && groups.map(g=>{
            const rows = shown(g);
            if(!rows.length) return null;
            return (
              <div key={g} style={{marginBottom:14}}>
                <div style={{fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>{g}</div>
                {rows.map(s=>(
                  <div key={s.code} style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"6px 0",borderBottom:`1px solid ${BORDER}`,gap:12}}>
                    <span style={{fontSize:13,color:TEXT}}>{s.label}</span>
                    <span style={{fontSize:13,fontWeight:700,color:TEXT,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{fmtSetting(s, data[s.code])}</span>
                  </div>
                ))}
              </div>
            );
          })}
          {!err && data && (
            <div style={{fontSize:11,color:FAINT,marginTop:8,lineHeight:1.5}}>Only settings we've confidently mapped from the register set are shown ({SETTINGS_MAP.length} so far). The list grows as more registers are correlated to the Remote-Setting screens.</div>
          )}
        </div>
      </div>
    </div>
  );
}
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
    <div onClick={onClose} style={{position:"fixed",inset:0,zIndex:200,background:"rgba(0,0,0,0.4)",display:"flex",alignItems:"center",justifyContent:"center",padding:12}}>
      <div onClick={e=>e.stopPropagation()} style={{background:CARD,borderRadius:16,maxWidth:1100,width:"100%",maxHeight:"90vh",overflow:"hidden",display:"flex",flexDirection:"column",boxShadow:"0 12px 48px rgba(0,0,0,0.25)",fontFamily:SANS}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"14px 18px",borderBottom:`1px solid ${BORDER}`,gap:8,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:TEXT}}>Compare Inverter Settings</div>
            <div style={{fontSize:11,color:FAINT}}>{data ? `${cols.length} inverters · ${diffCount} setting${diffCount===1?"":"s"} differ` : `Reading… ${done}/${cols.length}`}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
            {data && <label style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:MUTED,fontWeight:600,cursor:"pointer",userSelect:"none"}}><input type="checkbox" checked={diffOnly} onChange={e=>setDiffOnly(e.target.checked)} style={{cursor:"pointer"}}/>Differences only</label>}
            {data && rows.length>0 && <button onClick={exportCsv} style={{padding:"5px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Export CSV</button>}
            <button onClick={onClose} style={{border:"none",background:"transparent",fontSize:20,lineHeight:1,color:MUTED,cursor:"pointer"}}>×</button>
          </div>
        </div>
        <div style={{overflow:"auto",padding:"4px 0"}}>
          {!data && <div style={{fontSize:13,color:FAINT,textAlign:"center",padding:"32px 0"}}>Reading live settings from {cols.length} inverters…</div>}
          {data && cols.length===0 && <div style={{fontSize:13,color:FAINT,textAlign:"center",padding:"32px 0"}}>No inverters with installer access.</div>}
          {data && cols.length>0 && (
            <table style={{borderCollapse:"collapse",width:"100%",fontSize:12}}>
              <thead><tr style={{position:"sticky",top:0,background:CARD,zIndex:1}}>
                <th style={{textAlign:"left",padding:"8px 14px",fontSize:11,color:FAINT,fontWeight:700,position:"sticky",left:0,background:CARD,minWidth:200}}>Setting</th>
                {cols.map(inv=><th key={inv.sn} style={{textAlign:"right",padding:"8px 14px",fontSize:11,color:TEXT,fontWeight:700,whiteSpace:"nowrap"}}>{inv.label}</th>)}
              </tr></thead>
              <tbody>
                {groups.flatMap(g=>{
                  const grows = rows.filter(r=>r.s.group===g);
                  if(!grows.length) return [];
                  return [
                    <tr key={"h-"+g}><td colSpan={cols.length+1} style={{padding:"10px 14px 4px",fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em"}}>{g}</td></tr>,
                    ...grows.map(({s,vals})=>{
                      const diff = isDiff(vals);
                      return (
                        <tr key={s.code} style={{background:diff?"#FEF3C7":"transparent",borderTop:`1px solid ${BORDER}`}}>
                          <td style={{textAlign:"left",padding:"6px 14px",color:TEXT,position:"sticky",left:0,background:diff?"#FEF3C7":CARD,whiteSpace:"nowrap"}}>{diff&&<span style={{color:SOLAR,fontWeight:800,marginRight:4}}>⚠</span>}{s.label}</td>
                          {vals.map((v,i)=><td key={i} style={{textAlign:"right",padding:"6px 14px",color:v==null?FAINT:TEXT,fontWeight:diff?700:500,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{v==null?"—":v}</td>)}
                        </tr>
                      );
                    })
                  ];
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
function InverterCard({inv, status}) {
  const [showSettings, setShowSettings] = useState(false);
  const d = status?.data;
  const pv = d?.photovoltaic?.power?.totalDc ?? null;
  const load = balanceLoad(d);
  const gridNet = d?.grid?.netW ?? null;
  const soc = d?.battery?.soc ?? null;
  const batChg = d?.battery?.charge ?? null;
  const batDis = d?.battery?.discharge ?? null;
  const temp = d?.inverter?.temperature ?? null;
  const online = d?.inverter?.online ?? false;
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
  const activePorts = d?.smartPorts ? Object.entries(d.smartPorts).filter(([,p])=>p&&(p.lines||[]).reduce((s,l)=>s+(l.power||0),0)>0) : [];
  return (
    <div className="inv-card" style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,overflow:"hidden",boxShadow:SHADOW_SM}}>
      <div style={{height:3,background:online?`linear-gradient(90deg,${SOLAR},${BATTERY})`:"#E5E7EB"}}/>
      <div style={{padding:"16px 16px 14px"}}>
        {/* Header */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div>
            <div style={{fontSize:16,fontWeight:700,color:TEXT}}>{inv.label}</div>
            {model&&<div style={{fontSize:10,color:MUTED,marginTop:1}}>{model}</div>}
            <div style={{fontSize:10,color:FAINT,marginTop:1,fontVariantNumeric:"tabular-nums"}}>{inv.sn}</div>
            {inv.autoId&&<button onClick={()=>setShowSettings(true)} style={{marginTop:5,padding:"2px 8px",borderRadius:6,border:`1px solid ${BORDER}`,background:BG,color:MUTED,fontSize:10,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Settings ›</button>}
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:4}}>
            <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:12,background:online?"#DCFCE7":"#FEE2E2",border:`1px solid ${online?"#86EFAC":"#FECACA"}`}}>
              <span style={{width:5,height:5,borderRadius:"50%",background:online?BATTERY:GRID_IN,display:"inline-block",animation:online?"pulse 2s infinite":"none"}}/>
              <span style={{fontSize:10,fontWeight:700,color:online?BATTERY:GRID_IN}}>{online?"LIVE":"OFFLINE"}</span>
            </div>
            {gridFreq&&<span style={{fontSize:10,color:FAINT,fontWeight:500}}>{gridFreq.toFixed(2)} Hz</span>}
            <UpdatedChip time={d?.inverter?.lastUpdateTime}/>
          </div>
        </div>
        {status?.ok===false&&<div style={{fontSize:12,color:GRID_IN,padding:"8px 10px",background:"#FEF2F2",borderRadius:8,marginBottom:8}}>{status.error||"No data"}</div>}
        {d&&(
          <>
            {/* Main stats */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              <StatTile label="Solar" value={fmt(pv)} color={SOLAR}/>
              <StatTile label="Load" value={fmt(load)} color={LOAD_C}/>
              <StatTile label={gridLabel} value={fmt(gridNet!=null?Math.abs(gridNet):null)} color={gridColor}/>
              <StatTile label={batChg>10?"Charging":batDis>10?"Discharging":"Battery"} value={fmt(batChg>10?batChg:batDis>10?-batDis:0)} color={batChg>10?BATTERY:batDis>10?SOLAR:MUTED}/>
            </div>
            {/* MPPT strings */}
            {mppts.length>0&&(
              <div style={{marginBottom:10,padding:"8px 10px",background:BG,borderRadius:10}}>
                <div style={{fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>PV Strings</div>
                {mppts.map((m,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:i<mppts.length-1?4:0}}>
                    <span style={{color:MUTED,fontWeight:600}}>MPPT {i+1}</span>
                    {m.power>0
                      ? <span style={{color:SOLAR,fontVariantNumeric:"tabular-nums"}}>{m.voltage.toFixed(0)}V · {m.current.toFixed(2)}A · {fmt(m.power)}</span>
                      : <span style={{color:FAINT}}>—</span>}
                  </div>
                ))}
              </div>
            )}
            {/* Smart Ports */}
            {activePorts.length>0&&(
              <div style={{marginBottom:10,padding:"8px 10px",background:"#F0FDF4",borderRadius:10,border:`1px solid #DCFCE7`}}>
                <div style={{fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Smart Ports</div>
                {activePorts.map(([key,port])=>{
                  const w=(port.lines||[]).reduce((s,l)=>s+(l.power||0),0);
                  return (
                    <div key={key} style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:2}}>
                      <span style={{color:MUTED,fontWeight:600}}>Port {key}</span>
                      <span style={{color:BATTERY,fontVariantNumeric:"tabular-nums"}}>{fmt(w)} · {fmtE(port.power?.today||0)} today</span>
                    </div>
                  );
                })}
              </div>
            )}
            {/* Battery SOC */}
            <div style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:600}}>Battery SOC</span>
                {temp!=null&&<span style={{fontSize:11,color:FAINT}}>{temp}°C</span>}
              </div>
              {soc!=null&&<SOCBar value={soc}/>}
            </div>
            {/* L1/L2 voltage pills */}
            {(l1Volt||l2Volt)&&(
              <div style={{display:"flex",gap:6,marginBottom:10,flexWrap:"wrap"}}>
                {l1Volt&&<span style={{fontSize:10,color:FAINT,background:BG,padding:"3px 8px",borderRadius:6}}>L1 {l1Volt.toFixed(1)} V</span>}
                {l2Volt&&<span style={{fontSize:10,color:FAINT,background:BG,padding:"3px 8px",borderRadius:6}}>L2 {l2Volt.toFixed(1)} V</span>}
              </div>
            )}
            {/* Today summary */}
            <div style={{paddingTop:10,borderTop:`1px solid ${BORDER}`,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(70px,1fr))",gap:6}}>
              <div>
                <div style={{fontSize:9,color:FAINT,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>PV Today</div>
                <div style={{fontSize:12,fontWeight:700,color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmtE(eToday)}</div>
              </div>
              {gridInToday>0&&<div>
                <div style={{fontSize:9,color:FAINT,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Imported</div>
                <div style={{fontSize:12,fontWeight:700,color:GRID_IN,fontVariantNumeric:"tabular-nums"}}>{fmtE(gridInToday)}</div>
              </div>}
              {gridOutToday>0&&<div>
                <div style={{fontSize:9,color:FAINT,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>Exported</div>
                <div style={{fontSize:12,fontWeight:700,color:GRID_OUT,fontVariantNumeric:"tabular-nums"}}>{fmtE(gridOutToday)}</div>
              </div>}
            </div>
          </>
        )}
        {!d&&!status&&<div style={{fontSize:12,color:FAINT,textAlign:"center",padding:"12px 0"}}>Connecting…</div>}
      </div>
      {showSettings&&<SettingsModal inv={inv} onClose={()=>setShowSettings(false)}/>}
    </div>
  );
}

function SectionCard({title, children, fullWidth}) {
  return (
    <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:"16px 18px",boxShadow:SHADOW_SM,...(fullWidth?{gridColumn:"1/-1"}:{})}}>
      <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:12}}>{title}</div>
      {children}
    </div>
  );
}

function PhaseRow({label, line, exportWhenNegative}) {
  if(!line||(!(line.voltage>0)&&!(line.power>0))) return null;
  const exporting = exportWhenNegative && (line.current||0) < 0;
  return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"5px 0",borderBottom:`1px solid ${BORDER}`}}>
      <span style={{fontSize:11,fontWeight:600,color:MUTED,minWidth:22}}>{label}</span>
      <div style={{display:"flex",gap:14,fontSize:11,fontVariantNumeric:"tabular-nums"}}>
        <span style={{color:FAINT}}>{(line.voltage||0).toFixed(1)} V</span>
        <span style={{color:MUTED}}>{Math.abs(line.current||0).toFixed(1)} A</span>
        <span style={{fontWeight:700,color:exporting?GRID_OUT:LOAD_C}}>{fmt(Math.abs(line.power||0))}</span>
      </div>
    </div>
  );
}

function InverterDetailPanel({inv, status}) {
  const [showInfo, setShowInfo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const d = status?.data;
  if(!d) return <div style={{textAlign:"center",color:FAINT,padding:48,fontSize:13}}>Connecting…</div>;

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
            <div style={{fontSize:11,color:"#92400E",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:2}}>
              {d.inverter?.model||inv.label} · <span style={{fontFamily:"monospace",fontWeight:400}}>{inv.sn}</span>
            </div>
            <div style={{fontSize:32,fontWeight:800,color:"#92400E",lineHeight:1,letterSpacing:"-0.5px",fontVariantNumeric:"tabular-nums"}}>{fmt(pvTotal,2)}</div>
          </div>
          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:5}}>
            {stateLabel&&<span style={{fontSize:11,fontWeight:700,color:stateColor,padding:"3px 10px",borderRadius:12,background:stateColor===BATTERY?"#DCFCE7":"#F1F5F9"}}>{stateLabel}</span>}
            {workLabel&&<span style={{fontSize:10,color:MUTED,fontWeight:500}}>{workLabel}</span>}
            <UpdatedChip time={d.inverter?.lastUpdateTime}/>
            {inv.autoId&&<button onClick={()=>setShowSettings(true)} style={{padding:"3px 10px",borderRadius:8,border:`1px solid #FDE68A`,background:"#FFFBEB",color:"#92400E",fontSize:10,fontWeight:700,fontFamily:SANS,cursor:"pointer"}}>Settings ›</button>}
          </div>
        </div>
        {showSettings&&<SettingsModal inv={inv} onClose={()=>setShowSettings(false)}/>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",gap:8}}>
          <StatTile label="PV Today"       value={fmtE(pvToday)}   color={TEXT}/>
          <StatTile label="PV Lifetime"    value={fmtE(pvLifetime)} color={TEXT}/>
          {pvPeak>0&&<StatTile label="Peak Today"    value={fmt(pvPeak)}    color={SOLAR}/>}
          {d.inverter?.selfConsumptionPercent!=null&&<StatTile label="Self-Consumed"  value={`${d.inverter.selfConsumptionPercent}%`} color={MUTED}/>}
          {d.inverter?.selfSufficiencyPercent!=null&&<StatTile label="Self-Sufficient" value={`${d.inverter.selfSufficiencyPercent}%`} color={MUTED}/>}
          <StatTile label="Inverter Temp"  value={`${d.inverter?.temperature||0}°C`} color={TEXT}/>
        </div>
      </div>

      {/* Solar / PV */}
      <SectionCard title="☀️ Solar">
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:mppts.length?12:0}}>
          <StatTile label="Total DC"   value={fmt(pvTotal,2)}  color={SOLAR}/>
          {pvPeak>0&&<StatTile label="Peak Today" value={fmt(pvPeak)}     color={SOLAR}/>}
          <StatTile label="Today"      value={fmtE(pvToday)}   color={TEXT}/>
          <StatTile label="Lifetime"   value={fmtE(pvLifetime)} color={TEXT}/>
        </div>
        {mppts.length>0&&(
          <div>
            <div style={{fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Strings</div>
            {mppts.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:i<mppts.length-1?`1px solid ${BORDER}`:"none"}}>
                <span style={{fontSize:11,fontWeight:600,color:MUTED}}>MPPT {i+1}</span>
                {m.power>0
                  ? <span style={{fontSize:11,color:SOLAR,fontVariantNumeric:"tabular-nums"}}>{(m.voltage||0).toFixed(0)} V · {(m.current||0).toFixed(2)} A · {fmt(m.power)}</span>
                  : <span style={{fontSize:11,color:FAINT}}>—</span>}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {/* Battery */}
      <SectionCard title="🔋 Battery">
        <div style={{marginBottom:12}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:5}}>
            <span style={{fontSize:12,fontWeight:600,color:MUTED}}>State of Charge{!bat.brand&&" (est.)"}</span>
            <span style={{fontSize:22,fontWeight:800,color:bat.soc>60?BATTERY:bat.soc>30?SOLAR:GRID_IN,fontVariantNumeric:"tabular-nums"}}>{(bat.soc||0).toFixed(0)}%</span>
          </div>
          <div style={{height:8,background:"#F1F5F9",borderRadius:4,overflow:"hidden",marginBottom:10}}>
            <div style={{width:`${bat.soc||0}%`,height:"100%",background:bat.soc>60?BATTERY:bat.soc>30?SOLAR:GRID_IN,borderRadius:4,transition:"width 0.5s"}}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <StatTile label="Voltage"     value={`${(bat.voltage||0).toFixed(1)} V`} color={TEXT}/>
            <StatTile label="Current"     value={`${(bat.current||0).toFixed(1)} A`} color={TEXT}/>
            <StatTile label="Charging"    value={fmt(bat.charge||0)}    color={(bat.charge||0)>20?BATTERY:FAINT}/>
            <StatTile label="Discharging" value={fmt(bat.discharge||0)} color={(bat.discharge||0)>20?SOLAR:FAINT}/>
            {bat.healthPercent>0&&<StatTile label="Health (SOH)" value={`${bat.healthPercent}%`} color={bat.healthPercent>80?BATTERY:bat.healthPercent>60?SOLAR:GRID_IN}/>}
            {bat.temperature>0&&<StatTile label="Temp" value={`${bat.temperature}°C`} color={bat.temperature>45?GRID_IN:bat.temperature>35?SOLAR:TEXT}/>}
          </div>
        </div>
        <div style={{marginBottom:10}}>
          <div style={{fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Energy</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
            <StatTile label="Charged Today"    value={fmtE(bat.chargeIn?.today||0)}    color={BATTERY}/>
            <StatTile label="Discharged Today" value={fmtE(bat.dischargeOut?.today||0)} color={SOLAR}/>
            {(bat.chargeIn?.total||0)>0&&<StatTile label="Total Charged"    value={fmtE(bat.chargeIn.total)}    color={MUTED}/>}
            {(bat.dischargeOut?.total||0)>0&&<StatTile label="Total Discharged" value={fmtE(bat.dischargeOut.total)} color={MUTED}/>}
          </div>
        </div>
        {(bat.brand||bat.capacityAh>0)&&(
          <div style={{paddingTop:10,borderTop:`1px solid ${BORDER}`,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            {bat.brand&&<span style={{fontSize:11,color:MUTED,fontWeight:600}}>{bat.brand}</span>}
            {bat.capacityAh>0&&<span style={{fontSize:11,color:FAINT}}>{bat.capacityAh} Ah</span>}
            {bat.bmsFWVer&&bat.bmsFWVer!=="0"&&<span style={{fontSize:10,color:FAINT}}>BMS v{bat.bmsFWVer}</span>}
          </div>
        )}
      </SectionCard>

      {/* Grid */}
      <SectionCard title="⚡ Grid">
        <div style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:14,fontWeight:700,color:isExporting?GRID_OUT:isImporting?GRID_IN:MUTED,fontVariantNumeric:"tabular-nums"}}>
              {isExporting?"Exporting":isImporting?"Importing":"Balanced"} {fmt(Math.abs(gridNetW))}
            </span>
            {gridFreq>0&&<span style={{fontSize:11,color:FAINT,marginLeft:"auto"}}>{gridFreq.toFixed(2)} Hz</span>}
          </div>
          {gridLines.filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
            <PhaseRow key={i} label={`L${i+1}`} line={l} exportWhenNegative/>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <StatTile label="Feed-In Today"  value={fmtE(d.grid?.sold?.today||0)}        color={GRID_OUT}/>
          <StatTile label="Total Feed-In"  value={fmtE(d.grid?.sold?.total||0)}        color={GRID_OUT}/>
          <StatTile label="Imported Today" value={fmtE(d.grid?.consumption?.today||0)} color={GRID_IN}/>
          <StatTile label="Total Imported" value={fmtE(d.grid?.consumption?.total||0)} color={GRID_IN}/>
        </div>
      </SectionCard>

      {/* Normal Load */}
      <SectionCard title="🏠 Load">
        <div style={{marginBottom:12}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
            <span style={{fontSize:14,fontWeight:700,color:LOAD_C,fontVariantNumeric:"tabular-nums"}}>{fmt(loadW)}</span>
            {loadFreq>0&&<span style={{fontSize:11,color:FAINT,marginLeft:"auto"}}>{loadFreq.toFixed(2)} Hz</span>}
          </div>
          {loadLines.filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
            <PhaseRow key={i} label={`L${i+1}`} line={l}/>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
          <StatTile label="Consumed Today" value={fmtE(d.load?.power?.today||0)}    color={LOAD_C}/>
          <StatTile label="Total Consumed" value={fmtE(d.load?.power?.total||0)}    color={MUTED}/>
        </div>
      </SectionCard>

      {/* Smart Ports — full width if any active */}
      {smartPorts.length>0&&(
        <SectionCard title="🔌 Smart Ports" fullWidth>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:16}}>
            {smartPorts.map(([key,port])=>{
              const portW=(port.lines||[]).reduce((s,l)=>s+(l.power||0),0);
              return (
                <div key={key}>
                  <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Port {key}</div>
                  {(port.lines||[]).filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
                    <PhaseRow key={i} label={`L${i+1}`} line={l}/>
                  ))}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6,marginTop:8}}>
                    <StatTile label="Live"  value={fmt(portW)}                     color={portW>0?BATTERY:FAINT}/>
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
        <SectionCard title="⚙️ Generator" fullWidth>
          <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"center"}}>
            {(d.gen.lines||[]).filter(l=>l.voltage>0||l.power>0).map((l,i)=>(
              <PhaseRow key={i} label={`L${i+1}`} line={l}/>
            ))}
            {d.gen.frequency>0&&<span style={{fontSize:11,color:FAINT}}>{d.gen.frequency.toFixed(1)} Hz</span>}
          </div>
        </SectionCard>
      )}

      {/* Inverter details / firmware — collapsible, full width */}
      <div style={{gridColumn:"1/-1",background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,overflow:"hidden",boxShadow:SHADOW_SM}}>
        <button onClick={()=>setShowInfo(x=>!x)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px",background:"transparent",border:"none",cursor:"pointer",fontFamily:SANS,textAlign:"left"}}>
          <span style={{fontSize:12,fontWeight:600,color:MUTED}}>Inverter Details &amp; Firmware</span>
          <span style={{fontSize:11,color:FAINT}}>{showInfo?"▲":"▼"}</span>
        </button>
        {showInfo&&(
          <div style={{borderTop:`1px solid ${BORDER}`,padding:"12px 16px"}}>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:8}}>
              {d.inverter?.model&&<StatTile label="Model"        value={d.inverter.model}       color={TEXT}/>}
              {stateLabel        &&<StatTile label="Status"       value={stateLabel}              color={stateColor}/>}
              {workLabel         &&<StatTile label="Work Mode"    value={workLabel}               color={MUTED}/>}
              {d.inverter?.dspVer     &&<StatTile label="DSP"        value={d.inverter.dspVer}      color={MUTED}/>}
              {d.inverter?.slaveDspVer&&<StatTile label="Slave DSP"  value={d.inverter.slaveDspVer} color={MUTED}/>}
              {d.inverter?.csbVer     &&<StatTile label="CSB"         value={d.inverter.csbVer}      color={MUTED}/>}
              {d.inverter?.wifiSignal!=null&&<StatTile label="WiFi Signal" value={`${d.inverter.wifiSignal}`} color={MUTED}/>}
              {bat.bmsFWVer&&bat.bmsFWVer!=="0"&&<StatTile label="BMS FW"     value={bat.bmsFWVer}           color={MUTED}/>}
              {d.inverter?.lastUpdateTime&&<StatTile label="Last Update" value={fmtAge(ageMin(d.inverter.lastUpdateTime))||d.inverter.lastUpdateTime.slice(11,16)} sub={d.inverter.lastUpdateTime.slice(0,16)} color={FAINT}/>}
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
// High-tension transmission tower (lattice pylon) drawn in white for the GRID node.
const gridPylon = (cx, cy) => (
  <g stroke="#fff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none">
    <line x1={cx-7} y1={cy+12} x2={cx-2.5} y2={cy-11}/>
    <line x1={cx+7} y1={cy+12} x2={cx+2.5} y2={cy-11}/>
    <line x1={cx-5.4} y1={cy+3.5} x2={cx+5.4} y2={cy+3.5}/>
    <line x1={cx-3.7} y1={cy-4.5} x2={cx+3.7} y2={cy-4.5}/>
    <path d={`M${cx-7},${cy+12} L${cx+5.4},${cy+3.5} M${cx+7},${cy+12} L${cx-5.4},${cy+3.5}`}/>
    <path d={`M${cx-5.4},${cy+3.5} L${cx+3.7},${cy-4.5} M${cx+5.4},${cy+3.5} L${cx-3.7},${cy-4.5}`}/>
    <line x1={cx-10} y1={cy-7} x2={cx+10} y2={cy-7}/>
    <line x1={cx-7} y1={cy-10.5} x2={cx+7} y2={cy-10.5}/>
    <line x1={cx} y1={cy-10.5} x2={cx} y2={cy-13}/>
    <line x1={cx-10} y1={cy-7} x2={cx-10} y2={cy-5}/>
    <line x1={cx+10} y1={cy-7} x2={cx+10} y2={cy-5}/>
    <line x1={cx-7} y1={cy-10.5} x2={cx-7} y2={cy-8.5}/>
    <line x1={cx+7} y1={cy-10.5} x2={cx+7} y2={cy-8.5}/>
  </g>
);
function FlowNode({x, y, r=22, color, icon, iconSvg, label, value, sub, sub2, sub2Color, place="below"}) {
  // All text sits on the side AWAY from the inverter (above for top nodes, below for bottom ones)
  // so the connector line — which exits the icon toward the center — never crosses the labels.
  const above = place==="above";
  const labelY = above ? y-r-38 : y+r+15;
  const valueY = above ? y-r-21 : y+r+31;
  const subY   = above ? y-r-7  : y+r+45;
  const sub2Y  = above ? subY-13 : subY+13;
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={color}/>
      {iconSvg ? iconSvg(x, y) : <text x={x} y={y+r*0.28} textAnchor="middle" fontSize={r-4}>{icon}</text>}
      <text x={x} y={labelY} textAnchor="middle" fontSize="9.5" fontWeight="700" fill={FAINT} fontFamily={SANS} letterSpacing="0.5">{label}</text>
      <text x={x} y={valueY} textAnchor="middle" fontSize="13" fontWeight="700" fill={TEXT} fontFamily={SANS}>{value}</text>
      {sub&&<text x={x} y={subY} textAnchor="middle" fontSize="10" fill={MUTED} fontFamily={SANS}>{sub}</text>}
      {sub2&&<text x={x} y={sub2Y} textAnchor="middle" fontSize="10" fontWeight="700" fill={sub2Color||MUTED} fontFamily={SANS}>{sub2}</text>}
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
    <div style={{background:CARD,borderRadius:16,padding:"10px 8px 6px",border:`1px solid ${BORDER}`,boxShadow:SHADOW_SM,marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",padding:"4px 8px 0"}}>
        <span style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontSize:11,fontWeight:700,color:FAINT,letterSpacing:"0.06em"}}>POWER FLOW</span>
          {flow.live&&<span style={{display:"inline-flex",alignItems:"center",gap:3,padding:"1px 6px",borderRadius:10,background:"#DCFCE7",border:"1px solid #86EFAC"}}><span style={{width:5,height:5,borderRadius:"50%",background:BATTERY,display:"inline-block",animation:"pulse 1.5s infinite"}}/><span style={{fontSize:9,fontWeight:800,color:BATTERY,letterSpacing:"0.04em"}}>LIVE</span></span>}
        </span>
        {flow.live ? <LiveChip atMs={flow.liveAt}/> : (flow.updated&&<UpdatedChip time={flow.updated}/>)}
      </div>
      <svg viewBox="0 0 400 400" style={{width:"100%",height:"auto",display:"block"}}>
        {edges.map((e,i)=><FlowEdge key={i} {...e}/>)}
        <InverterGraphic count={flow.count}/>
        <FlowNode x={56} y={92} place="above" color={SOLAR} icon="☀️" label="SOLAR" value={fmt(flow.pv)}/>
        <FlowNode x={344} y={92} place="above" color={flow.grid<0?GRID_OUT:GRID_IN} iconSvg={gridPylon} label="GRID" value={fmt(Math.abs(flow.grid))} sub={flow.grid<0?"exporting":"importing"}/>
        <FlowNode x={56} y={300} place="below" color={BATTERY} icon="🔋" label="BATTERY" value={fmt(Math.abs(flow.battery))}
          sub={flow.remainKwh!=null ? `${flow.soc.toFixed(0)}% · ~${flow.remainKwh.toFixed(1)} kWh`
            : flow.soc!=null ? `SOC ${flow.soc.toFixed(0)}%`
            : flow.voltage!=null ? `${flow.voltage.toFixed(1)} V` : null}
          sub2={flow.ratePctHr!=null ? `${flow.rateSign}${flow.ratePctHr.toFixed(1)}%/hr` : null}
          sub2Color={flow.battery>0?BATTERY:SOLAR}/>
        <FlowNode x={344} y={300} place="below" color={LOAD_C} icon="🏠" label="HOME" value={fmt(flow.load)}/>
        {flow.gen>A      && <FlowNode x={200} y={64} r={17} place="above" color="#57534E" icon="⚙️" label="GEN" value={fmt(flow.gen)}/>}
        {showSmart      && <FlowNode x={200} y={322} r={17} place="below" color="#7C3AED" icon="🔌" label="SMART LOAD" value={fmt(flow.smartLoad)}/>}
        {flow.couple>A   && <FlowNode x={40} y={182} r={16} place="below" color="#0891B2" icon="🔗" label="AC" value={fmt(Math.abs(flow.couple))}/>}
      </svg>
    </div>
  );
}

function InverterSelector({selectedSns, onToggle, onAll, allSelected, statuses, inverters, single, value, onPick}) {
  const pill = (active, onClick, key, label, sub, power) => (
    <button key={key} onClick={onClick} style={{
      flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:1,
      padding:"8px 14px", borderRadius:12,
      border:`1.5px solid ${active?SOLAR:BORDER}`,
      background:active?"#FFFBEB":CARD,
      cursor:"pointer", fontFamily:SANS,
      boxShadow: active ? `0 0 0 3px rgba(217,119,6,0.1)` : SHADOW_SM,
      minWidth:56, opacity: active?1:0.65,
    }}>
      <span style={{fontSize:12,fontWeight:700,color:active?SOLAR:TEXT,whiteSpace:"nowrap"}}>{label}{power&&<span style={{fontWeight:500,color:active?SOLAR:MUTED}}>{" · "}{power}</span>}</span>
      <span style={{fontSize:10,fontWeight:500,color:active?"#B45309":FAINT,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",fontFamily:"monospace"}}>{sub}</span>
    </button>
  );
  // Single-select mode (Explorer): no "All" pill; picking an inverter replaces the current one.
  return (
    <div className="inv-scroll" style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch"}}>
      {!single && pill(allSelected, onAll, "all", "All", `${inverters.length} inverters`, null)}
      {inverters.map(inv=>{
        const s = statuses.find(x=>x.sn===inv.sn);
        const pv = s?.data?.photovoltaic?.power?.totalDc;
        const active = single ? value===inv.sn : selectedSns.includes(inv.sn);
        const onClick = single ? ()=>onPick(inv.sn) : ()=>onToggle(inv.sn);
        return pill(active, onClick, inv.sn, inv.label, inv.sn.slice(-8), pv!=null?fmt(pv):null);
      })}
    </div>
  );
}

function ChartCard({children, loading, minHeight=300}) {
  return (
    <div style={{background:CARD,borderRadius:16,padding:"16px 12px 12px",border:`1px solid ${BORDER}`,minHeight,display:"flex",flexDirection:"column",justifyContent:loading?"center":"flex-start",alignItems:loading?"center":"stretch",boxShadow:SHADOW_SM}}>
      {loading
        ? <div style={{color:FAINT,fontSize:13,fontWeight:500}}>Loading…</div>
        : children}
    </div>
  );
}

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
    <div style={{display:"flex",justifyContent:"space-between",gap:16,fontSize:11,fontWeight:bold?700:500,padding:"1px 0"}}>
      <span style={{color:bold?TEXT:MUTED,display:"flex",alignItems:"center",gap:5}}>{c&&<span style={{width:8,height:8,borderRadius:2,background:c,display:"inline-block"}}/>}{l}</span>
      <span style={{color:bold?TEXT:MUTED,fontVariantNumeric:"tabular-nums"}}>{v}</span>
    </div>
  );
  return (
    <div style={{...TOOLTIP_S, padding:"8px 10px", minWidth:150}}>
      <div style={{color:MUTED,fontSize:10,marginBottom:5}}>{label}</div>
      {prod.length>0&&<>
        {prod.map(p=><Row key={p.dataKey} c={p.color} l={p.name} v={fmt(p.value||0)}/>)}
        {prod.length>1&&<Row l="Total Solar" v={fmt(prodTot)} bold/>}
      </>}
      {cons.length>0&&<div style={{marginTop:prod.length?4:0}}>
        {cons.map(p=><Row key={p.dataKey} c={p.color} l={p.name} v={fmt(Math.abs(p.value||0))}/>)}
        {cons.length>1&&<Row l="Total Load" v={fmt(consTot)} bold/>}
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
  const yTop=Math.max(P,N,100);
  const powerDomain=[-N*1.05, yTop*1.05];
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
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <h2 style={{margin:0,fontSize:16,fontWeight:700,color:TEXT}}>Day</h2>
          <div style={{fontSize:11,color:FAINT}}>{mpptActive?"Per-MPPT production · drag to zoom":"Power · drag the bar below to zoom"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button onClick={dayPrev} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:16,lineHeight:1,cursor:"pointer",boxShadow:SHADOW_SM,fontFamily:SANS}}>‹</button>
          <input type="date" value={date} onChange={e=>onDateChange(e.target.value)} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 10px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}/>
          <button onClick={dayNext} disabled={dayAtMax} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:dayAtMax?BG:CARD,color:dayAtMax?FAINT:TEXT,fontSize:16,lineHeight:1,cursor:dayAtMax?"default":"pointer",boxShadow:dayAtMax?"none":SHADOW_SM,fontFamily:SANS}}>›</button>
        </div>
      </div>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged}/>}
      <ChartCard loading={loading} minHeight={360}>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={chartData} margin={{top:4,right:8,left:0,bottom:0}}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="time" tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={44} tickFormatter={t=>typeof t==="string"?t.slice(0,5):t}/>
            <YAxis yAxisId="power" domain={powerDomain} tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} tickFormatter={v=>`${(v/1000).toFixed(0)}k`} width={34}/>
            <YAxis yAxisId="soc" orientation="right" domain={[0,100]} tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} width={30} tickFormatter={v=>`${v}`}/>
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
          <div style={{fontSize:11.5,fontWeight:500,color:MUTED,background:BG,border:`1px solid ${BORDER}`,borderRadius:20,padding:"5px 12px"}}>
            {mpptActive ? "📊 Showing per-MPPT (string) production for this inverter" : "💡 Select a single inverter to see production broken out per MPPT string"}
          </div>
        </div>
      )}
    </div>
  );
}

function LegendSwatch({color,label}){
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,color:MUTED}}><span style={{width:14,height:3,borderRadius:2,background:color}}/>{label}</span>;
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
  if(unit==="W") return (v)=> Math.abs(v)>=1000 ? `${(v/1000).toFixed(0)}k` : `${v}`;
  return (v)=>`${v}`;
}
function ExplorerTooltip({active, payload, label, byKey}){
  if(!active || !payload?.length) return null;
  return (
    <div style={TOOLTIP_S}>
      <div style={{fontWeight:700,color:TEXT,marginBottom:6}}>🕐 {label}</div>
      {payload.map(p=>{ const m=byKey[p.dataKey]; return (
        <div key={p.dataKey} style={{display:"flex",justifyContent:"space-between",gap:16,fontSize:12,marginBottom:2}}>
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
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <h2 style={{margin:0,fontSize:16,fontWeight:700,color:TEXT}}>Explorer</h2>
          <div style={{fontSize:11,color:FAINT}}>{label?`${label} · `:""}Raw inverter parameters · 5-min resolution · up to 7 days</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          <button onClick={onPrev} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:16,lineHeight:1,cursor:"pointer",boxShadow:SHADOW_SM,fontFamily:SANS}}>‹</button>
          <input type="date" value={start} max={today} onChange={e=>onStart(e.target.value)} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 10px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}/>
          <span style={{fontSize:12,color:FAINT}}>to</span>
          <input type="date" value={end} max={today} onChange={e=>onEnd(e.target.value)} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 10px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}/>
          <button onClick={onNext} disabled={nextDisabled} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:nextDisabled?BG:CARD,color:nextDisabled?FAINT:TEXT,fontSize:16,lineHeight:1,cursor:nextDisabled?"default":"pointer",boxShadow:nextDisabled?"none":SHADOW_SM,fontFamily:SANS}}>›</button>
        </div>
      </div>
      {/* Parameter picker — grouped chips */}
      {!loading && metrics.length>0 && (
        <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:12,padding:"10px 12px",marginBottom:12,boxShadow:SHADOW_SM}}>
          <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginBottom:6}}>
            <button onClick={()=>setSel(metrics.map(m=>m.key))} style={{padding:"3px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Select all</button>
            <button onClick={()=>setSel([])} style={{padding:"3px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Clear</button>
          </div>
          {groups.map(g=>(
            <div key={g} style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap",marginBottom:6}}>
              <span style={{fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",minWidth:74}}>{g}</span>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {metrics.filter(m=>m.group===g).map(m=>{
                  const on = sel.includes(m.key); const c = colorOf(m.key);
                  return (
                    <button key={m.key} onClick={()=>toggle(m.key)} style={{
                      display:"inline-flex",alignItems:"center",gap:5,padding:"3px 9px",borderRadius:20,cursor:"pointer",
                      border:`1px solid ${on?c:BORDER}`, background:on?c:"transparent", color:on?"#fff":MUTED,
                      fontSize:11,fontWeight:600,fontFamily:SANS,WebkitTapHighlightColor:"transparent",
                    }}>
                      <span style={{width:7,height:7,borderRadius:"50%",background:on?"#fff":c,display:"inline-block"}}/>
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
          ? <ChartCard loading={false} minHeight={200}><div style={{color:FAINT,fontSize:13,textAlign:"center",padding:"40px 0"}}>No 5-minute data for this range.</div></ChartCard>
          : pairs.length===0
            ? <ChartCard loading={false} minHeight={160}><div style={{color:FAINT,fontSize:13,textAlign:"center",padding:"32px 0"}}>Select one or more parameters above to chart.</div></ChartCard>
            : pairs.map((pair, pi)=>{
                const [lu, ru] = pair;
                const keys = sel.filter(k=>{ const u=byKey[k]?.unit; return u===lu || u===ru; });
                return (
                  <div key={pi} style={{marginBottom:14}}>
                    <ChartCard loading={false} minHeight={300}>
                      <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",padding:"0 4px 6px"}}>{lu}{ru?` · ${ru}`:""}</div>
                      <ResponsiveContainer width="100%" height={260}>
                        <ComposedChart data={data} margin={{top:4,right:8,left:0,bottom:0}}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
                          <XAxis dataKey="lbl" tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={multi?70:44}/>
                          <YAxis yAxisId="L" tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} width={40} tickFormatter={axisFmt(lu)} domain={["auto","auto"]} label={{value:lu,angle:-90,position:"insideLeft",fill:FAINT,fontSize:10}}/>
                          {ru && <YAxis yAxisId="R" orientation="right" tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} width={40} tickFormatter={axisFmt(ru)} domain={["auto","auto"]} label={{value:ru,angle:90,position:"insideRight",fill:FAINT,fontSize:10}}/>}
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
    {key:"grid", label:"Imported/\nExported", color:CHART_GRID, active:showGrid, onToggle:setShowGrid},
    {key:"battery", label:"Charged/\nDischarged", color:CHART_BAT, active:showBattery, onToggle:setShowBattery},
  ];
  const moAtMax = month >= thisMonth;
  const moPrev = () => { const [y,m]=month.split('-').map(Number); onMonthChange(`${m===1?y-1:y}-${String(m===1?12:m-1).padStart(2,'0')}`); };
  const moNext = () => { if(!moAtMax){const [y,m]=month.split('-').map(Number); onMonthChange(`${m===12?y+1:y}-${String(m===12?1:m+1).padStart(2,'0')}`);} };
  const navBtn = {padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:16,lineHeight:1,cursor:"pointer",boxShadow:SHADOW_SM,fontFamily:SANS};
  const inputS = {background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 8px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM};
  return (
    <div style={{marginBottom:24}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <h2 style={{margin:0,fontSize:16,fontWeight:700,color:TEXT}}>{rangeMode?"Custom Range":"Month"}</h2>
          <div style={{fontSize:11,color:FAINT}}>{rangeMode?"Billing-period totals":"Daily totals"}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          {rangeMode ? (
            <>
              <input type="date" value={rangeStart} max={rangeEnd} onChange={e=>onRangeStart(e.target.value)} style={inputS}/>
              <span style={{fontSize:12,color:FAINT}}>→</span>
              <input type="date" value={rangeEnd} max={today} onChange={e=>onRangeEnd(e.target.value)} style={inputS}/>
            </>
          ) : (
            <>
              <button onClick={moPrev} style={navBtn}>‹</button>
              <input type="month" value={month} onChange={e=>onMonthChange(e.target.value)} style={inputS}/>
              <button onClick={moNext} disabled={moAtMax} style={{...navBtn,background:moAtMax?BG:CARD,color:moAtMax?FAINT:TEXT,cursor:moAtMax?"default":"pointer",boxShadow:moAtMax?"none":SHADOW_SM}}>›</button>
            </>
          )}
          <button onClick={()=>onModeChange&&onModeChange(rangeMode?"month":"range")} style={{...inputS,fontWeight:700,color:SOLAR,border:`1px solid ${SOLAR}`,background:"#FFFBEB"}}>{rangeMode?"Monthly":"Custom"}</button>
        </div>
      </div>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged} netExported={exported-imported}/>}
      <ChartCard loading={loading} minHeight={340}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} stackOffset="sign" margin={{top:4,right:4,left:0,bottom:0}} {...BAR_MONTH}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="day" tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={rangeMode?22:6}/>
            <YAxis tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} width={32}/>
            <ReferenceLine y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip contentStyle={TOOLTIP_S} formatter={(v,n)=>[`${Math.abs(v).toFixed(1)} kWh`,n]} labelFormatter={l=>rangeMode?l:`Day ${l}`} labelStyle={{color:MUTED,marginBottom:4}} cursor={false}/>
            {showProduced&&<Bar dataKey="productionPos" fill={CHART_PROD} fillOpacity={0.85} name="Solar" stackId="a" activeBar={false}/>}
            {showGrid&&<Bar dataKey="fromGridPos" fill={CHART_GRID} fillOpacity={0.85} name="Grid Import" stackId="a" activeBar={false}/>}
            {showBattery&&<Bar dataKey="batDischargePos" fill={CHART_BAT} fillOpacity={0.85} name="Bat Discharge" stackId="a" activeBar={false}/>}
            {showConsumed&&<Bar dataKey="consumptionNeg" fill={CHART_CONS} fillOpacity={0.85} name="Load" stackId="a" activeBar={false}/>}
            {showGrid&&<Bar dataKey="toGridNeg" fill={CHART_GRID} fillOpacity={0.85} name="Grid Export" stackId="a" activeBar={false}/>}
            {showBattery&&<Bar dataKey="batChargeNeg" fill={CHART_BAT} fillOpacity={0.85} name="Bat Charge" stackId="a" activeBar={false}/>}
          </BarChart>
        </ResponsiveContainer>
        <SeriesToggle series={toggleSeries}/>
      </ChartCard>
    </div>
  );
}

function YearChart({year, onYearChange, data, loading}) {
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
    {key:"grid", label:"Imported/\nExported", color:CHART_GRID, active:showGrid, onToggle:setShowGrid},
    {key:"battery", label:"Charged/\nDischarged", color:CHART_BAT, active:showBattery, onToggle:setShowBattery},
  ];
  const yrAtMax = year >= thisYear;
  const yrPrev = () => onYearChange(String(Number(year)-1));
  const yrNext = () => { if(!yrAtMax) onYearChange(String(Number(year)+1)); };
  return (
    <div style={{marginBottom:24}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <h2 style={{margin:0,fontSize:16,fontWeight:700,color:TEXT}}>Year</h2>
          <div style={{fontSize:11,color:FAINT}}>Monthly totals</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button onClick={yrPrev} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:16,lineHeight:1,cursor:"pointer",boxShadow:SHADOW_SM,fontFamily:SANS}}>‹</button>
          <select value={year} onChange={e=>onYearChange(e.target.value)} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 10px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}>
            {["2024","2025","2026","2027"].map(y=><option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={yrNext} disabled={yrAtMax} style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:yrAtMax?BG:CARD,color:yrAtMax?FAINT:TEXT,fontSize:16,lineHeight:1,cursor:yrAtMax?"default":"pointer",boxShadow:yrAtMax?"none":SHADOW_SM,fontFamily:SANS}}>›</button>
        </div>
      </div>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged} netExported={exported-imported}/>}
      <ChartCard loading={loading} minHeight={320}>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} stackOffset="sign" margin={{top:4,right:4,left:0,bottom:0}} {...BAR_YEAR}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="month" tick={{fill:FAINT,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false}/>
            <YAxis tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} width={32} tickFormatter={v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}/>
            <ReferenceLine y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip contentStyle={TOOLTIP_S} formatter={(v,n)=>[`${Math.abs(v).toLocaleString()} kWh`,n]} labelStyle={{color:MUTED,marginBottom:4}} cursor={false}/>
            {showProduced&&<Bar dataKey="productionPos" fill={CHART_PROD} fillOpacity={0.85} name="Solar" stackId="a" activeBar={false}/>}
            {showGrid&&<Bar dataKey="fromGridPos" fill={CHART_GRID} fillOpacity={0.85} name="Grid Import" stackId="a" activeBar={false}/>}
            {showBattery&&<Bar dataKey="batDischargePos" fill={CHART_BAT} fillOpacity={0.85} name="Bat Discharge" stackId="a" activeBar={false}/>}
            {showConsumed&&<Bar dataKey="consumptionNeg" fill={CHART_CONS} fillOpacity={0.85} name="Load" stackId="a" activeBar={false}/>}
            {showGrid&&<Bar dataKey="toGridNeg" fill={CHART_GRID} fillOpacity={0.85} name="Grid Export" stackId="a" activeBar={false}/>}
            {showBattery&&<Bar dataKey="batChargeNeg" fill={CHART_BAT} fillOpacity={0.85} name="Bat Charge" stackId="a" activeBar={false}/>}
          </BarChart>
        </ResponsiveContainer>
        <SeriesToggle series={toggleSeries}/>
      </ChartCard>
    </div>
  );
}

function Legend({color, label}) {
  return (
    <div style={{display:"flex",alignItems:"center",gap:5}}>
      <span style={{width:10,height:10,borderRadius:2,background:color,display:"inline-block"}}/>
      <span style={{fontSize:11,color:MUTED,fontWeight:500}}>{label}</span>
    </div>
  );
}

function SeriesToggle({series}) {
  return (
    <div style={{display:"flex",justifyContent:"center",gap:16,flexWrap:"wrap",paddingTop:12,borderTop:`1px solid ${BORDER}`,marginTop:10}}>
      {series.map(s=>(
        <button key={s.key} onClick={()=>s.onToggle(!s.active)}
          style={{display:"flex",flexDirection:"column",alignItems:"center",gap:5,border:"none",background:"transparent",cursor:"pointer",padding:"2px 6px",fontFamily:SANS,WebkitTapHighlightColor:"transparent"}}>
          <div style={{position:"relative",width:40,height:22,borderRadius:11,background:s.active?s.color:"#D1D5DB",transition:"background 0.2s",flexShrink:0}}>
            <div style={{position:"absolute",top:2,left:s.active?20:2,width:18,height:18,borderRadius:9,background:"#FFFFFF",boxShadow:"0 1px 3px rgba(0,0,0,0.25)",transition:"left 0.2s"}}/>
          </div>
          <span style={{fontSize:10,color:s.active?MUTED:FAINT,fontWeight:500,textAlign:"center",lineHeight:1.3,whiteSpace:"pre-line"}}>{s.label}</span>
        </button>
      ))}
    </div>
  );
}

const TABS = [
  { id:"live", label:"Live", icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
  { id:"day",  label:"Day",  icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg> },
  { id:"month",label:"Month",icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
  { id:"year", label:"Year", icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg> },
  { id:"explorer",label:"Explorer",icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg> },
];
const ADMIN_TAB = { id:"admin", label:"Admin", icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6l8-4z"/></svg> };

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
  useEffect(()=>{
    if(!rtfOn || !rtfSn) return;
    let alive = true;
    const poll = async ()=>{
      if(rtfBusyRef.current) return;              // skip if the previous request is still in flight
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
  const darkInput = {background:"#292524",border:"1px solid #44403C",borderRadius:6,color:"#FAFAF9",padding:"6px 8px",fontFamily:SANS,fontSize:12};
  const inputS = {background:CARD,border:`1px solid ${BORDER}`,borderRadius:6,color:TEXT,padding:"6px 8px",fontFamily:SANS,fontSize:12};

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

  const Th = ({children, a="right"}) => <th style={{textAlign:a,padding:"4px 8px",fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",whiteSpace:"nowrap"}}>{children}</th>;
  const Td = ({children, a="right", c=TEXT, b=false}) => <td style={{textAlign:a,padding:"4px 8px",fontSize:12,color:c,fontWeight:b?700:500,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{children}</td>;

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16,marginBottom:24}}>
      <div style={{fontSize:11,color:FAINT,fontFamily:"monospace",textAlign:"right"}}>build {BUILD}</div>
      {/* Energy registers — spot stuck feed-in counters */}
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:8,flexWrap:"wrap"}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:TEXT}}>Energy Registers — {site?.name||"site"}</div>
            <div style={{fontSize:11,color:FAINT}}>⚠ = exporting now but Export-Today ≈ 0 (stuck feed-in counter)</div>
          </div>
          <button onClick={runScan} disabled={scanning} style={{padding:"6px 12px",borderRadius:8,border:"none",background:"#0EA5E9",color:"#fff",fontSize:11,fontWeight:700,fontFamily:SANS,cursor:scanning?"default":"pointer"}}>{scanning?"Scanning…":"Scan all sites"}</button>
        </div>
        {regs.length===0
          ? <div style={{fontSize:12,color:FAINT}}>No live inverter data yet (open the Live tab once).</div>
          : <div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse"}}><thead><tr>
              <Th a="left">Inverter</Th><Th>Grid now</Th><Th>Export today</Th><Th>Export total</Th><Th>Import today</Th><Th>PV today</Th><Th>PV total</Th><Th a="center">Flag</Th>
            </tr></thead><tbody>
              {regs.map(r=>(<tr key={r.sn} style={{borderTop:`1px solid ${BORDER}`}}>
                <Td a="left" b>{r.label} <span style={{color:FAINT,fontWeight:400,fontFamily:"monospace",fontSize:10}}>{r.sn.slice(-8)}</span></Td>
                <Td c={r.netW<-50?GRID_OUT:r.netW>50?GRID_IN:MUTED}>{fmt(Math.abs(r.netW))}{r.netW<-50?" ⤴":r.netW>50?" ⤵":""}</Td>
                <Td c={r.stuck?GRID_IN:TEXT} b={r.stuck}>{fmtE(r.expToday)}</Td>
                <Td c={MUTED}>{fmtE(r.expTotal)}</Td>
                <Td>{fmtE(r.impToday)}</Td>
                <Td>{fmtE(r.pvToday)}</Td>
                <Td c={MUTED}>{fmtE(r.pvTotal)}</Td>
                <Td a="center">{r.stuck?<span style={{color:GRID_IN,fontWeight:800}}>⚠</span>:<span style={{color:BATTERY}}>✓</span>}</Td>
              </tr>))}
            </tbody></table></div>}
        {scan && <div style={{marginTop:12,borderTop:`1px solid ${BORDER}`,paddingTop:10}}>
          <div style={{fontSize:11,fontWeight:700,color:MUTED,marginBottom:6}}>FLEET SCAN ({scan.length} sites){scanning?" …":""}</div>
          {scan.map((s,i)=>(<div key={i} style={{display:"flex",justifyContent:"space-between",gap:8,fontSize:12,padding:"3px 0"}}>
            <span style={{color:s.stuck?GRID_IN:TEXT,fontWeight:s.stuck?700:500}}>{s.stuck?"⚠ ":s.err?"⛔ ":"✓ "}{s.name}</span>
            <span style={{color:MUTED,fontVariantNumeric:"tabular-nums"}}>{s.err?s.err:`${s.exportingNow?"exporting":"idle"} · today ${(s.expTodayKwh||0).toFixed(1)} kWh`}</span>
          </div>))}
        </div>}
      </div>
      <div style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10,gap:8}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:TEXT}}>Access Log</div>
            <div style={{fontSize:11,color:FAINT}}>{persistent? "Persistent (Vercel KV)" : "In-memory — recent activity only; add a KV store to persist across restarts"}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <label style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:MUTED,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap",userSelect:"none"}}>
              <input type="checkbox" checked={hideSelf} onChange={e=>setHideSelf(e.target.checked)} style={{cursor:"pointer"}}/>
              Hide my own events
            </label>
            <button onClick={loadLog} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Refresh</button>
          </div>
        </div>
        {logErr && <div style={{color:GRID_IN,fontSize:12}}>{logErr}</div>}
        {shownLog && shownLog.length===0 && !logErr && <div style={{fontSize:12,color:FAINT}}>{log&&log.length>0&&hideSelf?"No events (your own are hidden).":"No events yet."}</div>}
        {shownLog && shownLog.length>0 && (
          <div style={{maxHeight:300,overflow:"auto"}}>
            {shownLog.map((e,i)=>(
              <div key={i} style={{display:"flex",gap:10,fontSize:12,padding:"5px 0",borderBottom:`1px solid ${BORDER}`,alignItems:"baseline"}}>
                <span style={{color:FAINT,fontVariantNumeric:"tabular-nums",whiteSpace:"nowrap"}}>{fmtTs(e.ts)}</span>
                <span style={{fontWeight:700,color:e.type==="login"?BATTERY:LOAD_C,textTransform:"uppercase",fontSize:10}}>{e.type}</span>
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
          <div style={{fontSize:14,fontWeight:700,color:TEXT}}>Live Register Probe</div>
          <div style={{fontSize:11,color:FAINT,lineHeight:1.5}}>On-demand live read of the inverter via device-shadow (<code>Force:1</code>) — sweeps the whole attribute space. <b>Run it twice ~10s apart</b>: values that <b>changed (Δ, highlighted)</b> are live measurements. Loose tags: ~60→Hz, ~100–300→V, 0–100→%, large→W. Read-only.</div>
        </div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:10}}>
          <input value={swAutoId} onChange={e=>setSwAutoId(e.target.value)} placeholder="AutoId" style={{...inputS,width:100}}/>
          <button onClick={runSweep} disabled={swBusy||!swAutoId} style={{padding:"6px 16px",borderRadius:8,border:"none",background:swBusy?MUTED:"#0EA5E9",color:"#fff",fontSize:12,fontWeight:700,fontFamily:SANS,cursor:swBusy?"default":"pointer"}}>{swBusy?"Reading…":"Read all"}</button>
          {swBusy && swProg && <span style={{fontSize:11,color:MUTED}}>{swProg}</span>}
          {swPrev && !swBusy && (
            <label style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:MUTED,fontWeight:600,cursor:"pointer",userSelect:"none",marginLeft:"auto"}}>
              <input type="checkbox" checked={swChangedOnly} onChange={e=>setSwChangedOnly(e.target.checked)} style={{cursor:"pointer"}}/>
              Show changed only
            </label>
          )}
        </div>
        {swErr && <div style={{color:GRID_IN,fontSize:12,marginBottom:6}}>{swErr}</div>}
        {/* Live watch — poll the power block every 10s for real-time correlation */}
        <div style={{borderTop:`1px solid ${BORDER}`,marginTop:10,paddingTop:10,marginBottom:6}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <button onClick={()=>setSwWatch(w=>!w)} disabled={!swAutoId} style={{padding:"6px 14px",borderRadius:8,border:"none",background:swWatch?GRID_IN:BATTERY,color:"#fff",fontSize:12,fontWeight:700,fontFamily:SANS,cursor:swAutoId?"pointer":"default"}}>{swWatch?"■ Stop watch":"▶ Watch power block (10s)"}</button>
            <span style={{fontSize:11,color:FAINT}}>0x3000–0x301F + Hz/temp/batV{swWatchTs?` · updated ${swWatchTs.toLocaleTimeString()}`:""}</span>
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
                    <span style={{fontFamily:"monospace",fontSize:11,color:MUTED,fontWeight:700}}>{code}</span>
                    <span style={{fontSize:12,color:TEXT,fontWeight:600,fontVariantNumeric:"tabular-nums",marginLeft:"auto"}}>{String(v)}</span>
                    {changed&&<span style={{fontSize:9,color:"#0369A1",fontWeight:800}}>Δ</span>}
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
              <div style={{fontSize:11,color:MUTED,marginBottom:8}}>requested {swRes.requested} · <b style={{color:TEXT}}>{nonZero.length}</b> non-zero{swPrev?` · ${changedCount} changed since last read`:" · run again to spot live (changing) values"}</div>
              {/* Auto-label table: live reading → candidate register codes */}
              {matchRows.length>0 && (
                <div style={{border:`1px solid ${BORDER}`,borderRadius:10,padding:"8px 10px",marginBottom:10,background:BG}}>
                  <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:6}}>Match to live status ({swInv?.label})</div>
                  {matchRows.map(r=>(
                    <div key={r.label} style={{display:"flex",gap:8,fontSize:11,padding:"3px 0",borderBottom:`1px solid ${BORDER}`,alignItems:"baseline",flexWrap:"wrap"}}>
                      <span style={{color:MUTED,fontWeight:600,minWidth:90}}>{r.label}</span>
                      <span style={{color:TEXT,fontWeight:700,fontVariantNumeric:"tabular-nums",minWidth:70}}>{Number(r.val).toFixed(2)} {r.unit}</span>
                      <span style={{fontFamily:"monospace",fontSize:10.5,display:"flex",gap:8,flexWrap:"wrap"}}>
                        {r.hits.length
                          ? r.hits.map(h=>{ const live=isChanged(h.c); return <span key={h.c} style={{color:live?"#0369A1":MUTED,fontWeight:live?800:500}}>{h.c}={h.n}{h.s!==1?`(×${h.s})`:""}{live?" Δ":""}</span>; })
                          : <span style={{color:FAINT}}>— no match</span>}
                      </span>
                    </div>
                  ))}
                  <div style={{fontSize:10,color:FAINT,marginTop:6}}>Config codes excluded. Δ = also changed since last read (live). Power drifts vs the cached status; V/SOC/Hz/temp are the reliable matches.</div>
                </div>
              )}
              {!d && <div style={{fontSize:11,color:SOLAR,marginBottom:8}}>Open the Live tab once so the matcher has a status snapshot to compare against.</div>}
              {shown.length===0
                ? <div style={{fontSize:12,color:FAINT}}>{swChangedOnly?"No values changed since the last read.":"No non-zero registers."}</div>
                : <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:6,maxHeight:360,overflow:"auto"}}>
                    {shown.map(code=>{
                      const v = data[code]; const n = parseFloat(v);
                      const changed = isChanged(code);
                      let tag=null;
                      if(isFinite(n)){ if(n>=59&&n<=61)tag="Hz"; else if(n>=95&&n<=300)tag="V"; else if(n>=0&&n<=100&&Number.isInteger(n))tag="%"; else if(Math.abs(n)>=300)tag="W"; }
                      return (
                        <div key={code} style={{display:"flex",alignItems:"baseline",gap:6,padding:"4px 8px",borderRadius:8,border:`1px solid ${changed?"#0EA5E9":BORDER}`,background:changed?"#E0F2FE":BG}}>
                          <span style={{fontFamily:"monospace",fontSize:11,color:MUTED,fontWeight:700}}>{code}</span>
                          <span style={{fontSize:12,color:TEXT,fontWeight:600,fontVariantNumeric:"tabular-nums",marginLeft:"auto"}}>{String(v)}</span>
                          {tag&&<span style={{fontSize:9,color:FAINT,fontWeight:700}}>{tag}</span>}
                          {changed&&<span style={{fontSize:9,color:"#0369A1",fontWeight:800}}>Δ</span>}
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
          <div style={{fontSize:14,fontWeight:700,color:TEXT}}>Realtime Flow Test</div>
          <div style={{fontSize:11,color:FAINT,lineHeight:1.5}}>Polls <code>getHybridFlowgraphRealTimeData</code> <b>every 1s</b> and logs each sample (client time + endpoint SystemTime + values) below so you can copy it back to determine how often the data actually changes. Inverter: <span style={{fontFamily:"monospace"}}>{rtfSn||"—"}</span></div>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",marginBottom:10}}>
          <button onClick={()=>setRtfOn(o=>!o)} disabled={!rtfSn} style={{padding:"6px 14px",borderRadius:8,border:"none",background:rtfOn?GRID_IN:BATTERY,color:"#fff",fontSize:12,fontWeight:700,fontFamily:SANS,cursor:rtfSn?"pointer":"default"}}>{rtfOn?"■ Stop":"▶ Log realtime flow (1s)"}</button>
          {rtfTs && <span style={{fontSize:11,color:FAINT}}>polled {rtfTs.toLocaleTimeString()} · {rtfLog.length} samples</span>}
          {rtfLog.length>0 && <button onClick={()=>setRtfLog([])} style={{padding:"4px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Clear log</button>}
          {rtfData && <button onClick={()=>setRtfRaw(r=>!r)} style={{padding:"4px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>{rtfRaw?"Hide raw":"Raw"}</button>}
        </div>
        {rtfData && rtfData.ok===false && <div style={{color:GRID_IN,fontSize:12}}>{rtfData.error||"error"}</div>}
        {rtfData && rtfData.ok!==false && (()=>{
          const prev = rtfPrevRef.current;
          const ch = (k)=> prev && String(prev[k])!==String(rtfData[k]);
          const tile = (label,val,changed,color)=>(
            <div style={{padding:"8px 10px",borderRadius:10,border:`1px solid ${changed?"#0EA5E9":BORDER}`,background:changed?"#E0F2FE":BG}}>
              <div style={{fontSize:9,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em"}}>{label}{changed?" Δ":""}</div>
              <div style={{fontSize:15,fontWeight:700,color:color||TEXT,fontVariantNumeric:"tabular-nums"}}>{val}</div>
            </div>
          );
          return (
            <div>
              <div style={{fontSize:12,color:MUTED,marginBottom:8}}>SystemTime: <b style={{color:TEXT}}>{rtfData.time||"—"}</b></div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:8}}>
                {tile("PV",fmt(rtfData.pv),ch("pv"),SOLAR)}
                {tile("Grid",fmt(rtfData.grid),ch("grid"),rtfData.grid<0?GRID_OUT:GRID_IN)}
                {tile("Load",fmt(rtfData.load),ch("load"),LOAD_C)}
                {tile("Battery",fmt(rtfData.battery),ch("battery"),BATTERY)}
                {tile("SOC",`${rtfData.soc}%`,ch("soc"),TEXT)}
              </div>
              {rtfRaw && <pre style={{marginTop:10,maxHeight:220,overflow:"auto",fontSize:10,background:BG,padding:10,borderRadius:8,border:`1px solid ${BORDER}`,whiteSpace:"pre-wrap"}}>{JSON.stringify(rtfData.raw,null,2)}</pre>}
            </div>
          );
        })()}
        {rtfLog.length>0 && (
          <div style={{marginTop:12}}>
            <div style={{fontSize:10,color:FAINT,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:4}}>Sample log — select all &amp; copy</div>
            <textarea readOnly value={rtfLog.join("\n")} onFocus={e=>e.target.select()} style={{width:"100%",height:200,fontFamily:"monospace",fontSize:10.5,lineHeight:1.5,color:TEXT,background:BG,border:`1px solid ${BORDER}`,borderRadius:8,padding:10,resize:"vertical",whiteSpace:"pre"}}/>
          </div>
        )}
      </div>
      <div style={{background:"#1C1917",borderRadius:16,padding:16,boxShadow:SHADOW_SM}}>
        <div style={{color:"#F59E0B",fontWeight:700,fontSize:13,marginBottom:10,fontFamily:SANS}}>🔧 API Debug</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10}}>
          {presets.map(p=>(
            <button key={p.label} onClick={()=>run(p.action, p.body)} disabled={busy} style={{background:"#0EA5E9",border:"none",borderRadius:8,color:"#fff",fontWeight:600,padding:"5px 10px",fontSize:11,cursor:"pointer",fontFamily:SANS}}>{p.label}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:6,marginBottom:8,flexWrap:"wrap"}}>
          <input value={action} onChange={e=>setAction(e.target.value)} placeholder="action" style={{...darkInput,width:130}}/>
          <input value={bodyText} onChange={e=>setBodyText(e.target.value)} placeholder='{"sn":"…"}' style={{...darkInput,flex:1,minWidth:160,fontFamily:"ui-monospace,monospace"}}/>
          <button onClick={()=>run()} disabled={busy} style={{background:"#F59E0B",border:"none",borderRadius:8,color:"#1C1917",fontWeight:700,padding:"6px 14px",cursor:"pointer",fontFamily:SANS,fontSize:12}}>{busy?"…":"Run"}</button>
        </div>
        {out && <pre style={{whiteSpace:"pre-wrap",wordBreak:"break-word",color:"#E7E5E4",fontSize:11,lineHeight:1.5,margin:0,fontFamily:"ui-monospace,monospace",maxHeight:420,overflow:"auto"}}>{out}</pre>}
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
    if(normalized.length===0) { setLoginError("No sites found for this account"); setAuthState("login"); }
    else if(normalized.length===1) { setSite(normalized[0]); setAuthState("dashboard"); }
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

  useEffect(() => { if(!site) return; setLiveLoading(true); fetchLive(); const t=setInterval(fetchLive,60000); return()=>clearInterval(t); }, [fetchLive]);

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
  useEffect(() => {
    if(tab!=="live" || !site) return;
    lastFlowTimesRef.current = {}; setLiveUpdatedAt(null); // reset freshness for the new selection/site
    let alive = true, busy = false;
    const sns = snKey ? snKey.split(",") : [];
    const poll = async () => {
      if(busy || !sns.length) return; busy = true;
      try {
        const res = await Promise.all(sns.map(sn=>api("flowrt",{serial:sn}).then(r=>({sn,r})).catch(()=>({sn,r:null}))));
        if(!alive) return;
        setLiveFlow(prev=>{ const next={...prev}; for(const {sn,r} of res){ if(r && r.ok!==false) next[sn]={pv:r.pv,grid:r.grid,load:r.load,eps:r.eps,gen:r.gen,battery:r.battery,soc:r.soc,time:r.time}; } return next; });
        // Stamp freshness only when a sample genuinely ADVANCED (its SystemTime changed) — so the age
        // reflects the inverter's report time, and duplicate polls let the "X ago" honestly grow.
        let fresh=false;
        for(const {sn,r} of res){ if(r && r.ok!==false && r.time && lastFlowTimesRef.current[sn]!==r.time){ lastFlowTimesRef.current[sn]=r.time; fresh=true; } }
        if(fresh) setLiveUpdatedAt(Date.now());
      } catch(e){ /* keep polling */ } finally { busy = false; }
    };
    poll();
    const id = setInterval(poll, 5000);
    return ()=>{ alive=false; clearInterval(id); };
  }, [tab, site, snKey]);

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
  const liveAgg = (liveSel.length && liveSel.length===selectedSns.length) ? (()=>{
    // AIO/EPS units serve the house through the EPS port, so loadCurrpac reads 0 — use epsCurrpac.
    const homeOf = (x) => (x.load>0 ? x.load : (x.eps||0));
    const pv = liveSel.reduce((s,x)=>s+(x.pv||0),0);
    const grid = liveSel.reduce((s,x)=>s+(x.grid||0),0);
    // Generator from the live genCurrpac. A smart port designated as "generator input" is reported here
    // by the real-time flow feed, so a running gen shows live and reads 0 when off. This is the only live
    // gen signal — the 5-min smart-port gen value was phantom (e.g. 25.8 kW on an idle gen) and is dropped.
    // gen is part of the balance below, so when it runs the battery figure stays correct (not double-fed).
    const gen = liveSel.reduce((s,x)=>s+(x.gen||0),0);
    const load = liveSel.reduce((s,x)=>s+homeOf(x),0);
    // Smart load: only a genuine SEPARATE EPS/backup load (load>0 AND eps>0). On AIO units the EPS port
    // IS the house (load=0 → home=eps), so there's no separate smart load; flowrt carries no other
    // smart-load signal, so this keeps a phantom value from ever showing.
    const smartLoad = liveSel.reduce((s,x)=>s+(((x.load||0)>0 && (x.eps||0)>0) ? x.eps : 0),0);
    // Battery net (+charge/−discharge) from the energy balance — the live Pbat sign is unreliable.
    const battery = pv + grid + gen - load;
    const socs = liveSel.map(x=>x.soc).filter(v=>v>0); // live SOC can come back 0; fall back to status
    const soc = socs.length ? socs.reduce((a,b)=>a+b,0)/socs.length : null;
    const time = liveSel.map(x=>x.time).filter(Boolean).sort().slice(-1)[0]||null;
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

  if(authState==="loading") return (<><PageHead/><div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",color:FAINT,fontSize:13,fontFamily:SANS}}>Loading…</div></>);
  if(authState==="appauth") return <AppLogin/>;
  if(authState==="link") return <LinkMidnite email={userEmail} onLinked={handleLinked} onSignOut={handleLogout}/>;
  if(authState==="fleet"||authState==="sites") return <FleetView sites={sites} onPick={handleSelectSite} onBack={site?()=>setAuthState("dashboard"):null} onLogout={handleLogout}/>;

  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:BG,fontFamily:SANS}}>
        {/* Header */}
        <div style={{borderBottom:`1px solid ${BORDER}`,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",background:CARD,position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 0 rgba(0,0,0,0.04)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <Logo size={30}/>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:TEXT,lineHeight:1.2}}>{site.name}</div>
              <div style={{fontSize:10,color:FAINT}}>{site.inverters.length} inverter{site.inverters.length!==1?"s":""}
                {lastUpdate&&<span> · {lastUpdate.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>}
              </div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            {/* Desktop tabs */}
            <div className="top-tabs" style={{gap:2,background:"#F1F5F9",borderRadius:10,padding:3}}>
              {(isAdmin&&!activeIsShared?[...TABS,ADMIN_TAB]:TABS).map(t=>(
                <button key={t.id} onClick={()=>setTab(t.id)} className="tab-btn" style={{
                  padding:"6px 14px",borderRadius:8,border:"none",cursor:"pointer",fontFamily:SANS,
                  background:tab===t.id?CARD:"transparent",
                  color:tab===t.id?TEXT:MUTED,
                  fontSize:12,fontWeight:tab===t.id?700:500,
                  boxShadow:tab===t.id?SHADOW_SM:"none",
                }}>{t.label}</button>
              ))}
            </div>
            {switchAccts.length>1 && (
              <select value={activeAccountId||""} onChange={e=>switchAccount(e.target.value)} title="Active account" style={{padding:"6px 10px",borderRadius:8,border:`1px solid ${BORDER}`,background:CARD,color:TEXT,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer",maxWidth:170}}>
                {switchAccts.map(a=><option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            )}
            {activeIsShared&&<span style={{fontSize:10,fontWeight:700,color:SOLAR,background:"#FFFBEB",border:"1px solid #FDE68A",padding:"3px 8px",borderRadius:10,whiteSpace:"nowrap"}}>SHARED · view-only</span>}
            {site&&!activeIsShared&&<button onClick={()=>setShowShare(true)} title="Share this site" style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>↗ Share</button>}
            {sites.length>1&&<button onClick={openFleet} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>⊞ Fleet</button>}
            <button onClick={()=>setShowAccountSettings(true)} title="Account settings" style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Settings</button>
            <button onClick={handleLogout} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Sign out</button>
          </div>
        </div>

        {/* Content */}
        <div className="page-pad" style={{maxWidth:960,margin:"0 auto",padding:"16px 16px 24px",animation:"fadeUp 0.35s ease"}}>
          {tab==="explorer"
            ? <InverterSelector single value={explorerSn} onPick={setExplorerSn} statuses={statuses} inverters={site.inverters}/>
            : <InverterSelector selectedSns={selectedSns} onToggle={toggleInv} onAll={selectAllInv} allSelected={allSelected} statuses={statuses} inverters={site.inverters}/>}
          {showCompare && <SettingsCompareModal inverters={site.inverters} onClose={()=>setShowCompare(false)}/>}

          {tab==="live"&&(
            <>
              {liveError&&<div style={{background:"#FEF2F2",border:`1px solid #FECACA`,borderRadius:12,padding:"12px 16px",marginBottom:12,fontSize:13,color:GRID_IN}}>Error: {liveError}</div>}
              {liveLoading
                ? <div style={{textAlign:"center",color:FAINT,padding:48,fontSize:13}}>Connecting to Midnite portal…</div>
                : <>
                  {flowAgg&&<FlowDiagram flow={flowAgg}/>}
                  {allSelected&&<SiteHero statuses={statuses} live={liveAgg} liveAt={liveUpdatedAt}/>}
                  {allSelected&&<BatteryPanel statuses={statuses}/>}
                  {allSelected&&<LifetimePanel statuses={statuses}/>}
                  {site.inverters.some(i=>i.autoId) && (
                    <div style={{marginBottom:12}}>
                      <button onClick={()=>setShowCompare(true)} style={{display:"inline-flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:10,border:`1px solid ${BORDER}`,background:CARD,color:MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}>⚙ Compare all inverter settings</button>
                    </div>
                  )}
                  {selectedSns.length===1 ? (
                    visibleStatuses.map(s=>{
                      const inv = site.inverters.find(i=>i.sn===s.sn)||{sn:s.sn,label:s.label};
                      return <InverterDetailPanel key={s.sn} inv={inv} status={s}/>;
                    })
                  ) : (
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
                      {visibleStatuses.map(s=>{
                        const inv = site.inverters.find(i=>i.sn===s.sn)||{sn:s.sn,label:s.label};
                        return <InverterCard key={s.sn} inv={inv} status={s}/>;
                      })}
                    </div>
                  )}
                  {allSelected&&<FaultPanel site={site}/>}
                </>
              }
            </>
          )}
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
              : <div style={{textAlign:"center",color:MUTED,padding:48,fontSize:13}}>No inverter selected.</div>
          )}
          {tab==="admin"&&isAdmin&&<AdminPanel site={site} inverters={chartInverters} statuses={statuses} userEmail={userEmail}/>}
        </div>

        {showAccountSettings && <AccountSettings email={userEmail} role={role} accounts={accounts} activeId={activeAccountId} profile={profile} sites={sites} selectedSite={site} sitePhotos={sitePhotos} onSetActive={switchAccount} onChanged={reloadAccounts} onClose={()=>setShowAccountSettings(false)}/>}
        {showShare && site && <ShareModal site={site} accountId={activeAccountId} onClose={()=>setShowShare(false)}/>}

        {/* Mobile bottom nav */}
        <div className="bottom-nav" style={{position:"fixed",bottom:0,left:0,right:0,zIndex:100,background:CARD,borderTop:`1px solid ${BORDER}`,padding:"8px 0 max(8px, env(safe-area-inset-bottom))",justifyContent:"space-around",alignItems:"center"}}>
          {(isAdmin&&!activeIsShared?[...TABS,ADMIN_TAB]:TABS).map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{
              display:"flex",flexDirection:"column",alignItems:"center",gap:3,
              padding:"4px 16px",border:"none",background:"transparent",cursor:"pointer",fontFamily:SANS,
              color:tab===t.id?SOLAR:FAINT,
              minWidth:56,
            }}>
              {t.icon}
              <span style={{fontSize:10,fontWeight:tab===t.id?700:500}}>{t.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
