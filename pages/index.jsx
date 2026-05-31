import { useState, useEffect, useCallback } from "react";
import Head from "next/head";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

const today = new Date().toISOString().split("T")[0];
const thisMonth = today.slice(0,7);
const thisYear = today.slice(0,4);

const fmt = (w,d=1) => { if(w==null) return "--"; if(Math.abs(w)>=1000) return `${(w/1000).toFixed(d)} kW`; return `${Math.round(w)} W`; };
const fmtE = (wh) => { if(wh==null) return "--"; if(wh>=1000000) return `${(wh/1000000).toFixed(2)} MWh`; if(wh>=1000) return `${(wh/1000).toFixed(1)} kWh`; return `${Math.round(wh)} Wh`; };

async function api(action, body=null) {
  const creds = JSON.parse(localStorage.getItem("midnite_creds") || "{}");
  const merged = { ...body, username: creds.username, password: creds.password };
  const res = await fetch(`/api/midnite?action=${action}`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(merged) });
  if(!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function aggregateDayData(all) {
  const map = {};
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.inTime; if(!map[k]) map[k]={time:k,pv:0,load:0,gridImport:0,gridExport:0,soc:0,n:0}; map[k].pv+=parseFloat(r.Production||0); map[k].load+=parseFloat(r.Consumption||0); map[k].gridImport+=parseFloat(r.powerFromGrid||0); map[k].gridExport+=parseFloat(r.powerToGrid||0); map[k].soc+=parseFloat(r.SOC||0); map[k].n+=1; } }
  return Object.values(map).sort((a,b)=>a.time.localeCompare(b.time)).map(r=>{const avg=r.n?r.soc/r.n:0; const batNet=r.pv-r.load-r.gridExport+r.gridImport; return {...r,soc:avg,batCharge:Math.max(0,batNet),batDischarge:Math.max(0,-batNet)};});
}
function aggregateMonthData(all) {
  const map = {};
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.day; if(!map[k]) map[k]={day:k,production:0,consumption:0,fromGrid:0,toGrid:0}; map[k].production+=r.Production||0; map[k].consumption+=r.Consumption||0; map[k].fromGrid+=r.powerFromGrid||0; map[k].toGrid+=r.powerToGrid||0; } }
  return Object.values(map).sort((a,b)=>a.day-b.day).map(r=>{const batNet=r.production-r.consumption-r.toGrid+r.fromGrid; return {...r,batCharge:Math.max(0,batNet),batDischarge:Math.max(0,-batNet)};});
}
function aggregateYearData(all) {
  const M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const map = {};
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.month; if(!map[k]) map[k]={month:M[k-1]||k,production:0,consumption:0,fromGrid:0,toGrid:0}; map[k].production+=r.Production||0; map[k].consumption+=r.Consumption||0; map[k].fromGrid+=r.powerFromGrid||0; map[k].toGrid+=r.powerToGrid||0; } }
  return Object.values(map).sort((a,b)=>a.month-b.month).map(r=>{const batNet=r.production-r.consumption-r.toGrid+r.fromGrid; return {...r,batCharge:Math.max(0,batNet),batDischarge:Math.max(0,-batNet)};});
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
const TOOLTIP_S = { background:CARD, border:`1px solid ${BORDER}`, borderRadius:10, padding:"10px 14px", fontSize:12, color:TEXT, boxShadow:"0 4px 20px rgba(0,0,0,0.12)", fontFamily:SANS };

const Logo = ({size=32}) => (
  <svg width={size} height={size} viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <filter id="mgS">
        <feGaussianBlur stdDeviation="1" result="coloredBlur"/>
        <feMerge><feMergeNode in="coloredBlur"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <circle cx="128" cy="128" r="95" fill="none" stroke="#1a3a52" strokeWidth="2" opacity="0.4"/>
    <circle cx="128" cy="128" r="70" fill="none" stroke="#1a3a52" strokeWidth="2" opacity="0.5"/>
    <circle cx="128" cy="128" r="45" fill="none" stroke="#1a3a52" strokeWidth="2.5" opacity="0.7"/>
    <circle cx="128" cy="128" r="24" fill="none" stroke="#00d9ff" strokeWidth="3"/>
    <line x1="128" y1="104" x2="128" y2="72" stroke="#00d9ff" strokeWidth="3.5" strokeLinecap="round" opacity="0.9"/>
    <circle cx="128" cy="128" r="10" fill="#00d9ff" filter="url(#mgS)"/>
    <circle cx="128" cy="128" r="6" fill="#2d6a4f"/>
    <circle cx="128" cy="128" r="3" fill="#00d9ff"/>
    <path d="M 128 104 L 128 65 M 118 85 L 128 65 L 138 85" stroke="#1a3a52" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.8"/>
    <line x1="80" y1="128" x2="176" y2="128" stroke="#1a3a52" strokeWidth="1.5" opacity="0.25" strokeDasharray="4,3"/>
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
      .tab-btn{transition:all 0.15s ease}
      .site-card{transition:box-shadow 0.2s,transform 0.2s}
      .site-card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.1)!important}
      .inv-card{transition:box-shadow 0.2s}
      .inv-card:hover{box-shadow:0 4px 20px rgba(0,0,0,0.1)!important}
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

function LoginForm({onLogin, error, loading}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e) => { e.preventDefault(); if(username&&password) onLogin(username, password); };
  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
        <form onSubmit={submit} style={{width:"100%",maxWidth:360,animation:"fadeUp 0.4s ease"}}>
          <div style={{textAlign:"center",marginBottom:32}}>
            <div style={{marginBottom:16,display:"inline-block"}}><Logo size={64}/></div>
            <div style={{fontSize:22,fontWeight:800,color:TEXT,letterSpacing:"-0.3px"}}>Midnite Sentinel</div>
            <div style={{fontSize:13,color:MUTED,marginTop:4}}>Sign in to your monitoring portal</div>
          </div>
          <div style={{background:CARD,borderRadius:20,padding:28,boxShadow:SHADOW}}>
            {error&&<div style={{background:"#FEF2F2",border:"1px solid #FECACA",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:13,color:GRID_IN}}>{error}</div>}
            <div style={{marginBottom:16}}>
              <label style={{fontSize:12,color:MUTED,fontWeight:600,display:"block",marginBottom:6}}>Username</label>
              <input type="text" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" autoFocus style={{width:"100%",padding:"11px 14px",background:BG,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,fontSize:14,fontFamily:SANS,outline:"none"}}/>
            </div>
            <div style={{marginBottom:24}}>
              <label style={{fontSize:12,color:MUTED,fontWeight:600,display:"block",marginBottom:6}}>Password</label>
              <input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" style={{width:"100%",padding:"11px 14px",background:BG,border:`1px solid ${BORDER}`,borderRadius:10,color:TEXT,fontSize:14,fontFamily:SANS,outline:"none"}}/>
            </div>
            <button type="submit" disabled={loading||!username||!password} style={{width:"100%",padding:"13px 0",borderRadius:10,border:"none",background:loading||!username||!password?"#E5E7EB":"linear-gradient(135deg,#FCD34D,#D97706)",color:loading||!username||!password?FAINT:"#7C2D12",fontSize:14,fontWeight:700,fontFamily:SANS,cursor:loading?"wait":"pointer",letterSpacing:"0.01em",boxShadow:loading?"none":"0 4px 16px rgba(217,119,6,0.3)",transition:"all 0.15s"}}>{loading?"Signing in…":"Sign In"}</button>
          </div>
        </form>
      </div>
    </>
  );
}

function SiteSelector({sites, onSelect, onLogout}) {
  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:BG}}>
        <div style={{borderBottom:`1px solid ${BORDER}`,padding:"14px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",background:CARD,position:"sticky",top:0,zIndex:100}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <Logo size={32}/>
            <div>
              <div style={{fontSize:15,fontWeight:700,color:TEXT}}>Select a Site</div>
              <div style={{fontSize:11,color:FAINT}}>{sites.length} site{sites.length!==1?"s":""} available</div>
            </div>
          </div>
          <button onClick={onLogout} style={{padding:"7px 14px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:12,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Sign out</button>
        </div>
        <div style={{maxWidth:900,margin:"0 auto",padding:"24px 16px",animation:"fadeUp 0.4s ease"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
            {sites.map(s=>{
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
                  {s.installer&&<div style={{fontSize:11,color:FAINT}}>Installer: {s.installer}</div>}
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

function SummaryStrip({produced, consumed, imported, exported, charged, discharged}) {
  const items = [
    {label:"Produced", value:fmtE(produced), color:CHART_PROD},
    {label:"Consumed", value:fmtE(consumed), color:CHART_CONS},
    {label:"Imported", value:fmtE(imported), color:GRID_IN},
    {label:"Exported", value:fmtE(exported), color:GRID_OUT},
    ...(charged>0?[{label:"Charged", value:fmtE(charged), color:BATTERY}]:[]),
    ...(discharged>0?[{label:"Discharged", value:fmtE(discharged), color:SOLAR}]:[]),
  ];
  return (
    <div style={{background:CARD,borderRadius:14,padding:"16px 20px",marginBottom:16,boxShadow:SHADOW_SM,border:`1px solid ${BORDER}`}}>
      <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
        {items.map(it=>(
          <div key={it.label}>
            <div style={{fontSize:11,color:FAINT,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:2}}>{it.label}</div>
            <div style={{fontSize:15,fontWeight:700,color:it.color,fontVariantNumeric:"tabular-nums"}}>{it.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SiteHero({statuses}) {
  const v = statuses.filter(s=>s?.ok&&s?.data);
  const totalPv = v.reduce((s,i)=>s+(i.data.photovoltaic?.power?.totalDc||0),0);
  const totalLoad = v.reduce((s,i)=>s+i.data.load.lines.reduce((a,l)=>a+(l.power||0),0),0);
  const totalGrid = v.reduce((s,i)=>s+(i.data.grid?.netW||0),0);
  const totalBat = v.reduce((s,i)=>s+(i.data.battery?.charge||0)-(i.data.battery?.discharge||0),0);
  const avgSoc = v.length ? v.reduce((s,i)=>s+(i.data.battery?.soc||0),0)/v.length : null;
  const totalToday = v.reduce((s,i)=>s+(i.data.photovoltaic?.production?.today||0),0);
  const isExporting = totalGrid < -50;
  const isImporting = totalGrid > 50;
  const gridColor = isExporting ? GRID_OUT : isImporting ? GRID_IN : MUTED;
  const gridLabel = isExporting ? `Exporting ${fmt(Math.abs(totalGrid))}` : isImporting ? `Importing ${fmt(totalGrid)}` : "Grid balanced";
  return (
    <div style={{background:`linear-gradient(135deg,#FFFBEB,#FEF3C7)`,borderRadius:16,padding:"20px 20px",marginBottom:16,border:`1px solid #FDE68A`,boxShadow:"0 2px 8px rgba(217,119,6,0.08)"}}>
      <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <div>
          <div style={{fontSize:11,color:"#92400E",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:2}}>Site Production Now</div>
          <div style={{fontSize:36,fontWeight:800,color:"#92400E",lineHeight:1,letterSpacing:"-1px",fontVariantNumeric:"tabular-nums"}}>{fmt(totalPv,2)}</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",borderRadius:20,background:isExporting?"#DCFCE7":isImporting?"#FEE2E2":"#F1F5F9",border:`1px solid ${isExporting?"#86EFAC":isImporting?"#FECACA":"#E2E8F0"}`}}>
          <span style={{width:7,height:7,borderRadius:"50%",background:gridColor,display:"inline-block"}}/>
          <span style={{fontSize:12,fontWeight:700,color:gridColor}}>{gridLabel}</span>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
        <StatTile label="Load" value={fmt(totalLoad,2)} color={LOAD_C}/>
        <StatTile label="Battery" value={totalBat>10?`+${fmt(totalBat)}`:totalBat<-10?fmt(totalBat):"Idle"} color={totalBat>10?BATTERY:totalBat<-10?SOLAR:MUTED} sub={avgSoc!=null?`SOC ${avgSoc.toFixed(0)}%`:null}/>
        <StatTile label="Today" value={fmtE(totalToday)} color={TEXT}/>
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

  // Capacity: use first inverter (each reports its own bank; topology varies per site)
  const firstBat = valid[0].data.battery;
  const capacityAh = firstBat.capacityAh;
  const capacityKwh = capacityAh > 0 ? ((capacityAh * avgVoltage) / 1000).toFixed(1) : null;

  // Open loop = no BMS brand on any inverter
  const closedLoop = valid.some(s => !!s.data.battery.brand);
  const brand = valid.find(s => s.data.battery.brand)?.data.battery.brand || "";

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

function InverterCard({inv, status}) {
  const d = status?.data;
  const pv = d?.photovoltaic?.power?.totalDc ?? null;
  const load = d ? d.load.lines.reduce((s,l)=>s+(l.power||0),0) : null;
  const gridNet = d?.grid?.netW ?? null;
  const soc = d?.battery?.soc ?? null;
  const batChg = d?.battery?.charge ?? null;
  const batDis = d?.battery?.discharge ?? null;
  const temp = d?.inverter?.temperature ?? null;
  const online = d?.inverter?.online ?? false;
  const eToday = d?.photovoltaic?.production?.today ?? null;
  const gridColor = gridNet!=null ? (gridNet<0?GRID_OUT:GRID_IN) : FAINT;
  const gridLabel = gridNet!=null ? (gridNet<0?"Exporting":"Importing") : "Grid";
  return (
    <div className="inv-card" style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:16,overflow:"hidden",boxShadow:SHADOW_SM}}>
      <div style={{height:3,background:online?`linear-gradient(90deg,${SOLAR},${BATTERY})`:"#E5E7EB"}}/>
      <div style={{padding:"16px 16px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
          <div>
            <div style={{fontSize:16,fontWeight:700,color:TEXT}}>{inv.label}</div>
            <div style={{fontSize:10,color:FAINT,marginTop:1,fontVariantNumeric:"tabular-nums"}}>{inv.sn}</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:12,background:online?"#DCFCE7":"#FEE2E2",border:`1px solid ${online?"#86EFAC":"#FECACA"}`}}>
            <span style={{width:5,height:5,borderRadius:"50%",background:online?BATTERY:GRID_IN,display:"inline-block",animation:online?"pulse 2s infinite":"none"}}/>
            <span style={{fontSize:10,fontWeight:700,color:online?BATTERY:GRID_IN}}>{online?"LIVE":"OFFLINE"}</span>
          </div>
        </div>
        {status?.ok===false&&<div style={{fontSize:12,color:GRID_IN,padding:"8px 10px",background:"#FEF2F2",borderRadius:8,marginBottom:8}}>{status.error||"No data"}</div>}
        {d&&(
          <>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
              <StatTile label="Solar" value={fmt(pv)} color={SOLAR}/>
              <StatTile label="Load" value={fmt(load)} color={LOAD_C}/>
              <StatTile label={gridLabel} value={fmt(gridNet!=null?Math.abs(gridNet):null)} color={gridColor}/>
              <StatTile label={batChg>10?"Charging":batDis>10?"Discharging":"Battery"} value={fmt(batChg>10?batChg:batDis>10?-batDis:0)} color={batChg>10?BATTERY:batDis>10?SOLAR:MUTED}/>
            </div>
            <div style={{marginBottom:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <span style={{fontSize:11,color:MUTED,fontWeight:600}}>Battery SOC</span>
                {temp!=null&&<span style={{fontSize:11,color:FAINT}}>{temp}°C</span>}
              </div>
              {soc!=null&&<SOCBar value={soc}/>}
            </div>
            <div style={{paddingTop:10,borderTop:`1px solid ${BORDER}`,display:"flex",justifyContent:"space-between"}}>
              <span style={{fontSize:11,color:MUTED}}>Today</span>
              <span style={{fontSize:11,fontWeight:700,color:TEXT,fontVariantNumeric:"tabular-nums"}}>{fmtE(eToday)}</span>
            </div>
          </>
        )}
        {!d&&!status&&<div style={{fontSize:12,color:FAINT,textAlign:"center",padding:"12px 0"}}>Connecting…</div>}
      </div>
    </div>
  );
}

function InverterSelector({selected, onChange, statuses, inverters}) {
  const options = [
    { value:"all", label:"All", sub: `${inverters.length} inverters` },
    ...inverters.map((inv,i) => {
      const s = statuses[i];
      const pv = s?.data?.photovoltaic?.power?.totalDc;
      // Show short SN (last 8 chars) + live power
      const snShort = inv.sn.slice(-8);
      return { value:inv.sn, label:inv.label, sub: snShort, power: pv!=null ? fmt(pv) : null };
    })
  ];
  return (
    <div className="inv-scroll" style={{display:"flex",gap:8,marginBottom:16,overflowX:"auto",paddingBottom:2,WebkitOverflowScrolling:"touch"}}>
      {options.map(opt=>{
        const active = selected===opt.value;
        return (
          <button key={opt.value} onClick={()=>onChange(opt.value)} style={{
            flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:1,
            padding:"8px 14px", borderRadius:12,
            border:`1.5px solid ${active?SOLAR:BORDER}`,
            background:active?"#FFFBEB":CARD,
            cursor:"pointer", fontFamily:SANS,
            boxShadow: active ? `0 0 0 3px rgba(217,119,6,0.1)` : SHADOW_SM,
            minWidth:56,
          }}>
            <span style={{fontSize:12,fontWeight:700,color:active?SOLAR:TEXT,whiteSpace:"nowrap"}}>{opt.label}{opt.power&&<span style={{fontWeight:500,color:active?SOLAR:MUTED}}>{" · "}{opt.power}</span>}</span>
            <span style={{fontSize:10,fontWeight:500,color:active?"#B45309":FAINT,whiteSpace:"nowrap",fontVariantNumeric:"tabular-nums",fontFamily:"monospace"}}>{opt.sub}</span>
          </button>
        );
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

function DayChart({date, onDateChange, data, loading}) {
  const produced = data.reduce((s,d)=>s+((d.pv||0)*(5/60)),0);
  const consumed = data.reduce((s,d)=>s+((d.load||0)*(5/60)),0);
  const imported = data.reduce((s,d)=>s+((d.gridImport||0)*(5/60)),0);
  const exported = data.reduce((s,d)=>s+((d.gridExport||0)*(5/60)),0);
  const charged = data.reduce((s,d)=>s+((d.batCharge||0)*(5/60)),0);
  const discharged = data.reduce((s,d)=>s+((d.batDischarge||0)*(5/60)),0);
  const chartData = data.map(d=>({...d,consumptionNeg:-(d.load||0),batDischargeNeg:-(d.batDischarge||0)}));
  return (
    <div style={{marginBottom:24}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <h2 style={{margin:0,fontSize:16,fontWeight:700,color:TEXT}}>Day</h2>
          <div style={{fontSize:11,color:FAINT}}>5-min intervals</div>
        </div>
        <input type="date" value={date} onChange={e=>onDateChange(e.target.value)} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 10px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}/>
      </div>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged}/>}
      <ChartCard loading={loading} minHeight={320}>
        <div style={{marginBottom:8,display:"flex",gap:16,paddingLeft:8}}>
          <Legend color={CHART_PROD} label="Solar"/>
          <Legend color={CHART_CONS} label="Load"/>
          <Legend color={CHART_BAT} label="Battery"/>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{top:4,right:4,left:0,bottom:0}} barCategoryGap={-100} barSize={12} barGap={-12}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="time" tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} interval={23}/>
            <YAxis tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} tickFormatter={v=>v===0?"0":v>0?`${(v/1000).toFixed(0)}k`:`${(v/1000).toFixed(0)}k`} width={32}/>
            <ReferenceLine y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip contentStyle={TOOLTIP_S} formatter={(v,n)=>[fmt(Math.abs(v)),n]} labelStyle={{color:MUTED,marginBottom:4}} cursor={false}/>
            <Bar dataKey="pv" fill={CHART_PROD} fillOpacity={0.85} name="Solar" stackId="pos"/>
            <Bar dataKey="batCharge" fill={CHART_BAT} fillOpacity={0.85} radius={[2,2,0,0]} name="Bat Charge" stackId="pos"/>
            <Bar dataKey="consumptionNeg" fill={CHART_CONS} fillOpacity={0.85} name="Load" stackId="neg"/>
            <Bar dataKey="batDischargeNeg" fill={CHART_BAT} fillOpacity={0.85} radius={[0,0,2,2]} name="Bat Discharge" stackId="neg"/>
          </BarChart>
        </ResponsiveContainer>
        <div style={{marginTop:4}}>
          <div style={{fontSize:10,color:FAINT,fontWeight:600,marginBottom:4,paddingLeft:4}}>Battery SOC</div>
          <ResponsiveContainer width="100%" height={50}>
            <AreaChart data={chartData} margin={{top:0,right:4,left:0,bottom:0}}>
              <defs>
                <linearGradient id="socG" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={CHART_BAT} stopOpacity={0.3}/>
                  <stop offset="95%" stopColor={CHART_BAT} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <XAxis dataKey="time" hide/>
              <YAxis domain={[0,100]} hide/>
              <Area type="monotone" dataKey="soc" stroke={CHART_BAT} strokeWidth={1.5} fill="url(#socG)" dot={false} isAnimationActive={false}/>
              <Tooltip contentStyle={TOOLTIP_S} formatter={v=>[`${Number(v).toFixed(0)}%`,"SOC"]} labelStyle={{color:MUTED}}/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>
    </div>
  );
}

function MonthChart({month, onMonthChange, data, loading}) {
  const produced = data.reduce((s,d)=>s+(d.production||0),0)*1000;
  const consumed = data.reduce((s,d)=>s+(d.consumption||0),0)*1000;
  const imported = data.reduce((s,d)=>s+(d.fromGrid||0),0)*1000;
  const exported = data.reduce((s,d)=>s+(d.toGrid||0),0)*1000;
  const charged = data.reduce((s,d)=>s+(d.batCharge||0),0)*1000;
  const discharged = data.reduce((s,d)=>s+(d.batDischarge||0),0)*1000;
  const chartData = data.map(d=>({...d,consumptionNeg:-(d.consumption||0),batDischargeNeg:-(d.batDischarge||0)}));
  return (
    <div style={{marginBottom:24}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <h2 style={{margin:0,fontSize:16,fontWeight:700,color:TEXT}}>Month</h2>
          <div style={{fontSize:11,color:FAINT}}>Daily totals</div>
        </div>
        <input type="month" value={month} onChange={e=>onMonthChange(e.target.value)} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 10px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}/>
      </div>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged}/>}
      <ChartCard loading={loading} minHeight={300}>
        <div style={{marginBottom:8,display:"flex",gap:16,paddingLeft:8}}>
          <Legend color={CHART_PROD} label="Solar"/>
          <Legend color={CHART_CONS} label="Load"/>
          <Legend color={CHART_BAT} label="Battery"/>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{top:4,right:4,left:0,bottom:0}} barCategoryGap="20%" barSize={20} barGap={-20}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="day" tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false}/>
            <YAxis tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} width={32}/>
            <ReferenceLine y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip contentStyle={TOOLTIP_S} formatter={(v,n)=>[`${Math.abs(v).toFixed(1)} kWh`,n]} labelFormatter={l=>`Day ${l}`} labelStyle={{color:MUTED,marginBottom:4}} cursor={false}/>
            <Bar dataKey="production" fill={CHART_PROD} fillOpacity={0.85} name="Solar" stackId="pos"/>
            <Bar dataKey="batCharge" fill={CHART_BAT} fillOpacity={0.85} radius={[2,2,0,0]} name="Bat Charge" stackId="pos"/>
            <Bar dataKey="consumptionNeg" fill={CHART_CONS} fillOpacity={0.85} name="Load" stackId="neg"/>
            <Bar dataKey="batDischargeNeg" fill={CHART_BAT} fillOpacity={0.85} radius={[0,0,2,2]} name="Bat Discharge" stackId="neg"/>
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}

function YearChart({year, onYearChange, data, loading}) {
  const produced = data.reduce((s,d)=>s+(d.production||0),0)*1000;
  const consumed = data.reduce((s,d)=>s+(d.consumption||0),0)*1000;
  const imported = data.reduce((s,d)=>s+(d.fromGrid||0),0)*1000;
  const exported = data.reduce((s,d)=>s+(d.toGrid||0),0)*1000;
  const charged = data.reduce((s,d)=>s+(d.batCharge||0),0)*1000;
  const discharged = data.reduce((s,d)=>s+(d.batDischarge||0),0)*1000;
  const chartData = data.map(d=>({...d,consumptionNeg:-(d.consumption||0),batDischargeNeg:-(d.batDischarge||0)}));
  return (
    <div style={{marginBottom:24}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div>
          <h2 style={{margin:0,fontSize:16,fontWeight:700,color:TEXT}}>Year</h2>
          <div style={{fontSize:11,color:FAINT}}>Monthly totals</div>
        </div>
        <select value={year} onChange={e=>onYearChange(e.target.value)} style={{background:CARD,border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT,padding:"7px 10px",fontSize:12,fontFamily:SANS,cursor:"pointer",boxShadow:SHADOW_SM}}>
          {["2024","2025","2026","2027"].map(y=><option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {!loading&&<SummaryStrip produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged}/>}
      <ChartCard loading={loading} minHeight={280}>
        <div style={{marginBottom:8,display:"flex",gap:16,paddingLeft:8}}>
          <Legend color={CHART_PROD} label="Solar"/>
          <Legend color={CHART_CONS} label="Load"/>
          <Legend color={CHART_BAT} label="Battery"/>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chartData} margin={{top:4,right:4,left:0,bottom:0}} barCategoryGap="20%" barSize={40} barGap={-40}>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false}/>
            <XAxis dataKey="month" tick={{fill:FAINT,fontSize:11,fontFamily:SANS}} tickLine={false} axisLine={false}/>
            <YAxis tick={{fill:FAINT,fontSize:10,fontFamily:SANS}} tickLine={false} axisLine={false} width={32} tickFormatter={v=>v>=1000?`${(v/1000).toFixed(0)}k`:v}/>
            <ReferenceLine y={0} stroke={BORDER} strokeWidth={1}/>
            <Tooltip contentStyle={TOOLTIP_S} formatter={(v,n)=>[`${Math.abs(v).toLocaleString()} kWh`,n]} labelStyle={{color:MUTED,marginBottom:4}} cursor={false}/>
            <Bar dataKey="production" fill={CHART_PROD} fillOpacity={0.85} name="Solar" stackId="pos"/>
            <Bar dataKey="batCharge" fill={CHART_BAT} fillOpacity={0.85} radius={[2,2,0,0]} name="Bat Charge" stackId="pos"/>
            <Bar dataKey="consumptionNeg" fill={CHART_CONS} fillOpacity={0.85} name="Load" stackId="neg"/>
            <Bar dataKey="batDischargeNeg" fill={CHART_BAT} fillOpacity={0.85} radius={[0,0,2,2]} name="Bat Discharge" stackId="neg"/>
          </BarChart>
        </ResponsiveContainer>
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

const TABS = [
  { id:"live", label:"Live", icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> },
  { id:"day",  label:"Day",  icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg> },
  { id:"month",label:"Month",icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg> },
  { id:"year", label:"Year", icon:<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg> },
];

export default function Dashboard() {
  const [authState, setAuthState] = useState("loading");
  const [loginError, setLoginError] = useState(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState(null);

  const [tab, setTab] = useState("live");
  const [statuses, setStatuses] = useState([]);
  const [liveLoading, setLiveLoading] = useState(true);
  const [liveError, setLiveError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [selectedInv, setSelectedInv] = useState("all");

  const [dayDate, setDayDate] = useState(today);
  const [dayData, setDayData] = useState([]);
  const [dayLoading, setDayLoading] = useState(false);
  const [monthDate, setMonthDate] = useState(thisMonth);
  const [monthData, setMonthData] = useState([]);
  const [monthLoading, setMonthLoading] = useState(false);
  const [yearVal, setYearVal] = useState(thisYear);
  const [yearData, setYearData] = useState([]);
  const [yearLoading, setYearLoading] = useState(false);

  function handleSitesResponse(data) {
    const raw = data.sites || (Array.isArray(data) ? data : []);
    const normalized = raw.filter(s=>s.GoodsID&&s.GoodsID.length>0).map(s=>({
      name: s.MemberID || "Unknown",
      inverters: s.GoodsID.map((g,j)=>({ sn:typeof g==="string"?g:g.GoodsID, label:`INV-${j+1}` })),
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
      else setAuthState("sites");
    }
  }

  async function handleLogin(username, password) {
    setLoginLoading(true); setLoginError(null);
    try {
      localStorage.setItem("midnite_creds", JSON.stringify({username, password}));
      await api("login");
      const sitesData = await api("sites");
      handleSitesResponse(sitesData);
    } catch(e) {
      localStorage.removeItem("midnite_creds");
      setLoginError(e.message.includes("Login failed") ? "Invalid username or password" : e.message);
      setAuthState("login");
    } finally { setLoginLoading(false); }
  }

  function handleLogout() {
    localStorage.removeItem("midnite_creds");
    localStorage.removeItem("midnite_selected_site");
    setSite(null); setSites([]); setStatuses([]); setAuthState("login");
  }

  function handleSelectSite(s) {
    setSite(s); setStatuses([]); setLiveLoading(true); setSelectedInv("all");
    localStorage.setItem("midnite_selected_site", s.name);
    setAuthState("dashboard");
  }

  useEffect(() => {
    const creds = JSON.parse(localStorage.getItem("midnite_creds") || "null");
    if(!creds) { setAuthState("login"); return; }
    api("sites").then(data=>handleSitesResponse(data)).catch(()=>{ localStorage.removeItem("midnite_creds"); setAuthState("login"); });
  }, []);

  const fetchLive = useCallback(async () => {
    if(!site) return;
    try {
      const {results} = await api("status", {serials:site.inverters.map(i=>i.sn)});
      setStatuses(results.map((r,idx)=>({...r,label:site.inverters[idx]?.label})));
      setLastUpdate(new Date()); setLiveError(null);
    } catch(e) { setLiveError(e.message); }
    finally { setLiveLoading(false); }
  }, [site]);

  useEffect(() => { if(!site) return; setLiveLoading(true); fetchLive(); const t=setInterval(fetchLive,60000); return()=>clearInterval(t); }, [fetchLive]);

  const chartInverters = site ? (selectedInv==="all" ? site.inverters : site.inverters.filter(i=>i.sn===selectedInv)) : [];

  useEffect(() => { if(tab!=="day"||!site) return; setDayLoading(true); Promise.all(chartInverters.map(inv=>api("day",{sn:inv.sn,date:dayDate}).catch(()=>null))).then(all=>{setDayData(aggregateDayData(all));setDayLoading(false);}); }, [tab,dayDate,selectedInv,site]);
  useEffect(() => { if(tab!=="month"||!site) return; setMonthLoading(true); Promise.all(chartInverters.map(inv=>api("month",{sn:inv.sn,date:monthDate}).catch(()=>null))).then(all=>{setMonthData(aggregateMonthData(all));setMonthLoading(false);}); }, [tab,monthDate,selectedInv,site]);
  useEffect(() => { if(tab!=="year"||!site) return; setYearLoading(true); Promise.all(chartInverters.map(inv=>api("year",{sn:inv.sn,date:yearVal}).catch(()=>null))).then(all=>{setYearData(aggregateYearData(all));setYearLoading(false);}); }, [tab,yearVal,selectedInv,site]);

  const visibleStatuses = selectedInv==="all" ? statuses : statuses.filter(s=>s.sn===selectedInv);

  if(authState==="loading") return (<><PageHead/><div style={{minHeight:"100vh",background:BG,display:"flex",alignItems:"center",justifyContent:"center",color:FAINT,fontSize:13,fontFamily:SANS}}>Loading…</div></>);
  if(authState==="login") return <LoginForm onLogin={handleLogin} error={loginError} loading={loginLoading}/>;
  if(authState==="sites") return <SiteSelector sites={sites} onSelect={handleSelectSite} onLogout={handleLogout}/>;

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
              {TABS.map(t=>(
                <button key={t.id} onClick={()=>setTab(t.id)} className="tab-btn" style={{
                  padding:"6px 14px",borderRadius:8,border:"none",cursor:"pointer",fontFamily:SANS,
                  background:tab===t.id?CARD:"transparent",
                  color:tab===t.id?TEXT:MUTED,
                  fontSize:12,fontWeight:tab===t.id?700:500,
                  boxShadow:tab===t.id?SHADOW_SM:"none",
                }}>{t.label}</button>
              ))}
            </div>
            {sites.length>1&&<button onClick={()=>{setAuthState("sites");setSite(null);setStatuses([]);}} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Sites</button>}
            <button onClick={handleLogout} style={{padding:"6px 12px",borderRadius:8,border:`1px solid ${BORDER}`,background:"transparent",color:MUTED,fontSize:11,fontWeight:600,fontFamily:SANS,cursor:"pointer"}}>Sign out</button>
          </div>
        </div>

        {/* Content */}
        <div className="page-pad" style={{maxWidth:960,margin:"0 auto",padding:"16px 16px 24px",animation:"fadeUp 0.35s ease"}}>
          <InverterSelector selected={selectedInv} onChange={setSelectedInv} statuses={statuses} inverters={site.inverters}/>

          {tab==="live"&&(
            <>
              {liveError&&<div style={{background:"#FEF2F2",border:`1px solid #FECACA`,borderRadius:12,padding:"12px 16px",marginBottom:12,fontSize:13,color:GRID_IN}}>Error: {liveError}</div>}
              {liveLoading
                ? <div style={{textAlign:"center",color:FAINT,padding:48,fontSize:13}}>Connecting to Midnite portal…</div>
                : <>
                  {selectedInv==="all"&&<SiteHero statuses={statuses}/>}
                  {selectedInv==="all"&&<BatteryPanel statuses={statuses}/>}
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12}}>
                    {visibleStatuses.map(s=>{
                      const inv = site.inverters.find(inv=>inv.sn===s.sn)||{sn:s.sn,label:s.label};
                      return <InverterCard key={s.sn} inv={inv} status={s}/>;
                    })}
                  </div>
                </>
              }
            </>
          )}
          {tab==="day"&&<DayChart date={dayDate} onDateChange={setDayDate} data={dayData} loading={dayLoading}/>}
          {tab==="month"&&<MonthChart month={monthDate} onMonthChange={setMonthDate} data={monthData} loading={monthLoading}/>}
          {tab==="year"&&<YearChart year={yearVal} onYearChange={setYearVal} data={yearData} loading={yearLoading}/>}
        </div>

        {/* Mobile bottom nav */}
        <div className="bottom-nav" style={{position:"fixed",bottom:0,left:0,right:0,zIndex:100,background:CARD,borderTop:`1px solid ${BORDER}`,padding:"8px 0 max(8px, env(safe-area-inset-bottom))",justifyContent:"space-around",alignItems:"center"}}>
          {TABS.map(t=>(
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
