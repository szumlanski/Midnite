import { useState, useEffect, useCallback } from "react";
import Head from "next/head";
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

const today = new Date().toISOString().split("T")[0];
const thisMonth = today.slice(0,7);
const thisYear = today.slice(0,4);
const MONO = "'JetBrains Mono', monospace";
const SANS = "'Space Grotesk', sans-serif";
const TOOLTIP = { background:"rgba(8,15,30,0.97)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"10px 14px", fontSize:12, fontFamily:MONO, color:"#e2e8f0" };
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
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.day; if(!map[k]) map[k]={day:k,production:0,consumption:0,fromGrid:0}; map[k].production+=r.Production||0; map[k].consumption+=r.Consumption||0; map[k].fromGrid+=r.powerFromGrid||0; } }
  return Object.values(map).sort((a,b)=>a.day-b.day);
}
function aggregateYearData(all) {
  const M=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const map = {};
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.month; if(!map[k]) map[k]={month:M[k-1]||k,production:0,consumption:0}; map[k].production+=r.Production||0; map[k].consumption+=r.Consumption||0; } }
  return Object.values(map).sort((a,b)=>a.month-b.month);
}

const PageHead = () => (
  <Head>
    <title>Midnite Solar</title>
    <link rel="preconnect" href="https://fonts.googleapis.com"/>
    <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
    <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
    <style>{`*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{background:#080f1e;color:#e2e8f0}input[type=date]::-webkit-calendar-picker-indicator,input[type=month]::-webkit-calendar-picker-indicator{filter:invert(0.5);cursor:pointer}@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>
  </Head>
);

function LoginForm({onLogin, error, loading}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const submit = (e) => { e.preventDefault(); if(username&&password) onLogin(username, password); };
  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:"#080f1e",backgroundImage:"radial-gradient(ellipse 80% 50% at 50% -20%,rgba(251,191,36,0.06),transparent 60%)",fontFamily:SANS,display:"flex",alignItems:"center",justifyContent:"center"}}>
        <form onSubmit={submit} style={{width:"100%",maxWidth:360,padding:32,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:20,animation:"fadeUp 0.4s ease"}}>
          <div style={{textAlign:"center",marginBottom:28}}>
            <div style={{width:48,height:48,borderRadius:12,background:"linear-gradient(135deg,#fbbf24,#f59e0b)",display:"inline-flex",alignItems:"center",justifyContent:"center",fontSize:24,boxShadow:"0 0 24px rgba(251,191,36,0.4)",marginBottom:12}}>⚡</div>
            <div style={{fontSize:20,fontWeight:700,color:"#e2e8f0"}}>Midnite Solar</div>
            <div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO,marginTop:4}}>Sign in to your portal</div>
          </div>
          {error&&<div style={{background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:10,padding:"10px 14px",marginBottom:16,fontSize:12,color:"#f87171",fontFamily:MONO}}>{error}</div>}
          <div style={{marginBottom:14}}>
            <label style={{fontSize:11,color:"rgba(255,255,255,0.4)",fontFamily:MONO,textTransform:"uppercase",letterSpacing:"0.08em",display:"block",marginBottom:6}}>Username</label>
            <input type="text" value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" autoFocus style={{width:"100%",padding:"10px 14px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#e2e8f0",fontSize:14,fontFamily:MONO,outline:"none"}}/>
          </div>
          <div style={{marginBottom:24}}>
            <label style={{fontSize:11,color:"rgba(255,255,255,0.4)",fontFamily:MONO,textTransform:"uppercase",letterSpacing:"0.08em",display:"block",marginBottom:6}}>Password</label>
            <input type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" style={{width:"100%",padding:"10px 14px",background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:10,color:"#e2e8f0",fontSize:14,fontFamily:MONO,outline:"none"}}/>
          </div>
          <button type="submit" disabled={loading||!username||!password} style={{width:"100%",padding:"12px 0",borderRadius:10,border:"none",background:loading?"rgba(251,191,36,0.3)":"linear-gradient(135deg,#fbbf24,#f59e0b)",color:"#080f1e",fontSize:14,fontWeight:700,fontFamily:SANS,cursor:loading?"wait":"pointer",letterSpacing:"0.02em",boxShadow:loading?"none":"0 0 20px rgba(251,191,36,0.3)",transition:"all 0.15s"}}>{loading?"Signing in...":"Sign In"}</button>
        </form>
      </div>
    </>
  );
}

function SiteSelector({sites, onSelect, onLogout}) {
  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:"#080f1e",backgroundImage:"radial-gradient(ellipse 80% 50% at 50% -20%,rgba(251,191,36,0.06),transparent 60%)",fontFamily:SANS,paddingBottom:48}}>
        <div style={{borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"16px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(0,0,0,0.3)",backdropFilter:"blur(12px)"}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#fbbf24,#f59e0b)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,boxShadow:"0 0 16px rgba(251,191,36,0.4)"}}>⚡</div>
            <div><div style={{fontSize:15,fontWeight:700}}>Select Site</div><div style={{fontSize:10,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>{sites.length} sites available</div></div>
          </div>
          <button onClick={onLogout} style={{padding:"6px 14px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.03)",color:"rgba(255,255,255,0.4)",fontSize:11,fontFamily:MONO,cursor:"pointer",transition:"all 0.15s"}}>Logout</button>
        </div>
        <div style={{maxWidth:900,margin:"0 auto",padding:"32px 20px",animation:"fadeUp 0.4s ease"}}>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:16}}>
            {sites.map(s=>{
              const [on,alarm,off,disc]=s.statusCounts;
              const total=s.inverters.length;
              return (
                <button key={s.name} onClick={()=>onSelect(s)} style={{textAlign:"left",padding:"20px 22px",background:"linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))",border:"1px solid rgba(255,255,255,0.09)",borderRadius:16,cursor:"pointer",transition:"transform 0.2s, border-color 0.2s",display:"flex",flexDirection:"column",gap:10}} onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.borderColor="rgba(251,191,36,0.4)";}} onMouseLeave={e=>{e.currentTarget.style.transform="";e.currentTarget.style.borderColor="rgba(255,255,255,0.09)";}}>
                  <div style={{fontSize:16,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>{s.name}</div>
                  <div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>{total} inverter{total!==1?"s":""}</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {on>0&&<span style={{fontSize:10,fontFamily:MONO,color:"#4ade80",display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:"#4ade80",boxShadow:"0 0 6px #4ade8080",display:"inline-block"}}/>{on} online</span>}
                    {alarm>0&&<span style={{fontSize:10,fontFamily:MONO,color:"#fbbf24",display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:"#fbbf24",display:"inline-block"}}/>{alarm} alarm</span>}
                    {off>0&&<span style={{fontSize:10,fontFamily:MONO,color:"#f87171",display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:"#f87171",display:"inline-block"}}/>{off} offline</span>}
                    {disc>0&&<span style={{fontSize:10,fontFamily:MONO,color:"rgba(255,255,255,0.3)",display:"flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:"50%",background:"rgba(255,255,255,0.3)",display:"inline-block"}}/>{disc} disconnected</span>}
                    {total===0&&<span style={{fontSize:10,fontFamily:MONO,color:"rgba(255,255,255,0.2)"}}>No inverters</span>}
                  </div>
                  {s.installer&&<div style={{fontSize:10,color:"rgba(255,255,255,0.2)",fontFamily:MONO}}>Installer: {s.installer}</div>}
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
  const color=value>60?"#4ade80":value>30?"#fbbf24":"#f87171";
  return <div style={{display:"flex",alignItems:"center",gap:8}}><div style={{flex:1,height:6,background:"rgba(255,255,255,0.08)",borderRadius:3,overflow:"hidden"}}><div style={{width:`${value}%`,height:"100%",background:color,borderRadius:3,boxShadow:`0 0 8px ${color}80`}}/></div><span style={{fontSize:12,color,fontFamily:MONO,minWidth:32}}>{value}%</span></div>;
}

function StatPill({label,value,color="#94a3b8",glow=false}) {
  return <div style={{display:"flex",flexDirection:"column",gap:2,padding:"10px 14px",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:10,boxShadow:glow?`0 0 20px ${color}30`:"none"}}><span style={{fontSize:10,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:MONO}}>{label}</span><span style={{fontSize:15,fontWeight:600,color,fontFamily:MONO}}>{value}</span></div>;
}

function EnphaseSummaryCard({produced,consumed,imported,exported,charged,discharged}) {
  return (
    <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.05)",borderRadius:14,padding:"20px 24px",marginBottom:20}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:16}}>
        <div style={{display:"flex",gap:20,flexWrap:"wrap",flex:1}}>
          <div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:MONO,marginBottom:3}}>Produced</div>
            <div style={{fontSize:16,fontWeight:700,color:"#60a5fa",fontFamily:MONO}}>{fmtE(produced)}</div>
          </div>
          <div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:MONO,marginBottom:3}}>Consumed</div>
            <div style={{fontSize:16,fontWeight:700,color:"#f97316",fontFamily:MONO}}>{fmtE(consumed)}</div>
          </div>
          <div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:MONO,marginBottom:3}}>Imported</div>
            <div style={{fontSize:16,fontWeight:700,color:"#f87171",fontFamily:MONO}}>{fmtE(imported)}</div>
          </div>
          <div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:MONO,marginBottom:3}}>Exported</div>
            <div style={{fontSize:16,fontWeight:700,color:"#4ade80",fontFamily:MONO}}>{fmtE(exported)}</div>
          </div>
          {charged>0&&<div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:MONO,marginBottom:3}}>Charged</div>
            <div style={{fontSize:16,fontWeight:700,color:"#22c55e",fontFamily:MONO}}>{fmtE(charged)}</div>
          </div>}
          {discharged>0&&<div>
            <div style={{fontSize:10,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.08em",fontFamily:MONO,marginBottom:3}}>Discharged</div>
            <div style={{fontSize:16,fontWeight:700,color:"#fbbf24",fontFamily:MONO}}>{fmtE(discharged)}</div>
          </div>}
        </div>
      </div>
    </div>
  );
}

function InverterCard({inv,status}) {
  const d=status?.data;
  const pv=d?.photovoltaic?.power?.totalDc??null;
  const load=d?d.load.lines.reduce((s,l)=>s+(l.power||0),0):null;
  const gridNet=d?.grid?.netW??null;
  const soc=d?.battery?.soc??null;
  const batChg=d?.battery?.charge??null;
  const temp=d?.inverter?.temperature??null;
  const online=d?.inverter?.online??false;
  const eToday=d?.photovoltaic?.production?.today??null;
  const eTotal=d?.photovoltaic?.production?.total??null;
  const gridColor=gridNet!=null?(gridNet<0?"#4ade80":"#f87171"):"#94a3b8";
  const gridLabel=gridNet!=null?(gridNet<0?"Exporting":"Importing"):"Grid";
  return (
    <div style={{background:"linear-gradient(135deg,rgba(255,255,255,0.06),rgba(255,255,255,0.02))",border:"1px solid rgba(255,255,255,0.09)",borderRadius:16,padding:"18px 20px",display:"flex",flexDirection:"column",gap:12,position:"relative",transition:"transform 0.2s"}} onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)"}} onMouseLeave={e=>{e.currentTarget.style.transform=""}}>
      <div style={{position:"absolute",top:14,right:14,display:"flex",alignItems:"center",gap:5}}><div style={{width:7,height:7,borderRadius:"50%",background:online?"#4ade80":"#f87171",boxShadow:online?"0 0 8px #4ade8080":"none"}}/><span style={{fontSize:10,color:"rgba(255,255,255,0.35)",fontFamily:MONO}}>{online?"LIVE":"OFFLINE"}</span></div>
      <div><div style={{fontSize:18,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>{inv.label}</div><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO,marginTop:2}}>{inv.sn}</div></div>
      {status?.ok===false&&<div style={{fontSize:12,color:"#f87171",fontFamily:MONO}}>{status.error||"No data"}</div>}
      {d&&<><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}><StatPill label="PV" value={fmt(pv)} color="#fbbf24" glow/><StatPill label="Load" value={fmt(load)} color="#60a5fa"/><StatPill label={gridLabel} value={fmt(gridNet!=null?Math.abs(gridNet):null)} color={gridColor} glow={gridNet!=null&&gridNet<0}/><StatPill label="Bat Chg" value={fmt(batChg)} color="#c084fc"/></div><div><div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}><span style={{fontSize:11,color:"rgba(255,255,255,0.4)",fontFamily:MONO}}>BATTERY SOC</span>{temp!=null&&<span style={{fontSize:11,color:"rgba(255,255,255,0.25)",fontFamily:MONO}}>{temp}°C</span>}</div>{soc!=null&&<SOCBar value={soc}/>}</div><div style={{display:"flex",justifyContent:"space-between",paddingTop:6,borderTop:"1px solid rgba(255,255,255,0.05)"}}><span style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>Today: {fmtE(eToday)}</span><span style={{fontSize:11,color:"rgba(255,255,255,0.2)",fontFamily:MONO}}>Total: {fmtE(eTotal)}</span></div></>}
      {!d&&!status&&<div style={{fontSize:12,color:"rgba(255,255,255,0.2)",fontFamily:MONO}}>Loading...</div>}
    </div>
  );
}

function AggregateBar({statuses}) {
  const v=statuses.filter(s=>s?.ok&&s?.data);
  const totalPv=v.reduce((s,i)=>s+(i.data.photovoltaic?.power?.totalDc||0),0);
  const totalLoad=v.reduce((s,i)=>s+i.data.load.lines.reduce((a,l)=>a+(l.power||0),0),0);
  const totalGrid=v.reduce((s,i)=>s+(i.data.grid?.netW||0),0);
  const totalBat=v.reduce((s,i)=>s+(i.data.battery?.charge||0)-(i.data.battery?.discharge||0),0);
  const avgSoc=v.length?v.reduce((s,i)=>s+(i.data.battery?.soc||0),0)/v.length:null;
  const totalToday=v.reduce((s,i)=>s+(i.data.photovoltaic?.production?.today||0),0);
  const totalAll=v.reduce((s,i)=>s+(i.data.photovoltaic?.production?.total||0),0);
  return (
    <div style={{background:"linear-gradient(90deg,rgba(251,191,36,0.08),rgba(96,165,250,0.06),rgba(74,222,128,0.08))",border:"1px solid rgba(251,191,36,0.15)",borderRadius:16,padding:"20px 24px",display:"flex",flexWrap:"wrap",gap:12,alignItems:"center",marginBottom:24}}>
      <div style={{flex:"0 0 auto"}}><div style={{fontSize:11,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.12em",fontFamily:MONO}}>Site Total</div><div style={{fontSize:22,fontWeight:800,color:"#fbbf24",fontFamily:SANS,lineHeight:1.1}}>{fmt(totalPv,2)}</div><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>PV NOW</div></div>
      <div style={{width:1,height:44,background:"rgba(255,255,255,0.08)",flexShrink:0}}/>
      <StatPill label="Total Load" value={fmt(totalLoad,2)} color="#60a5fa"/>
      <StatPill label={totalGrid<0?"Grid Export":"Grid Import"} value={fmt(Math.abs(totalGrid),2)} color={totalGrid<0?"#4ade80":"#f87171"} glow={totalGrid<0}/>
      <StatPill label="Bat Net" value={fmt(totalBat)} color="#c084fc"/>
      {avgSoc!=null&&<StatPill label="Avg SOC" value={`${avgSoc.toFixed(0)}%`} color="#4ade80"/>}
      <StatPill label="Today" value={fmtE(totalToday)} color="#e2e8f0"/>
      <StatPill label="All Time" value={fmtE(totalAll)} color="rgba(255,255,255,0.4)"/>
    </div>
  );
}

function InverterSelector({selected, onChange, statuses, inverters}) {
  const options = [
    { value: "all", label: "All Inverters" },
    ...inverters.map((inv, i) => {
      const s = statuses[i];
      const pv = s?.data?.photovoltaic?.power?.totalDc;
      const soc = s?.data?.battery?.soc;
      return { value: inv.sn, label: `${inv.label} · ${pv != null ? fmt(pv) : "--"} · SOC ${soc != null ? soc+"%" : "--"}` };
    })
  ];
  return (
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:20}}>
      {options.map(opt=>(
        <button key={opt.value} onClick={()=>onChange(opt.value)} style={{
          padding:"8px 16px", borderRadius:10, border:"1px solid",
          borderColor: selected===opt.value ? "rgba(251,191,36,0.6)" : "rgba(255,255,255,0.1)",
          background: selected===opt.value ? "rgba(251,191,36,0.12)" : "rgba(255,255,255,0.03)",
          color: selected===opt.value ? "#fbbf24" : "rgba(255,255,255,0.5)",
          fontSize:12, cursor:"pointer", fontFamily:MONO,
          fontWeight: selected===opt.value ? 600 : 400,
          transition:"all 0.15s",
          boxShadow: selected===opt.value ? "0 0 16px rgba(251,191,36,0.15)" : "none",
        }}>{opt.label}</button>
      ))}
    </div>
  );
}

function DayChart({date,onDateChange,data,loading}) {
  const produced = data.reduce((s,d) => s + ((d.pv||0) * (5/60)), 0);
  const consumed = data.reduce((s,d) => s + ((d.load||0) * (5/60)), 0);
  const imported = data.reduce((s,d) => s + ((d.gridImport||0) * (5/60)), 0);
  const exported = data.reduce((s,d) => s + ((d.gridExport||0) * (5/60)), 0);
  const charged = data.reduce((s,d) => s + ((d.batCharge||0) * (5/60)), 0);
  const discharged = data.reduce((s,d) => s + ((d.batDischarge||0) * (5/60)), 0);
  const chartData = data.map(d => ({...d, consumptionNeg: -(d.load||0), batDischargeNeg: -(d.batDischarge||0)}));
  return (
    <div style={{marginBottom:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{margin:0,fontSize:16,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>Day View</h2><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>5-min intervals</div></div>
        <input type="date" value={date} onChange={e=>onDateChange(e.target.value)} style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"#e2e8f0",padding:"6px 10px",fontSize:12,fontFamily:MONO,cursor:"pointer"}}/>
      </div>
      {!loading&&<EnphaseSummaryCard produced={produced} consumed={consumed} imported={imported} exported={exported} charged={charged} discharged={discharged}/>}
      <div style={{background:"rgba(255,255,255,0.02)",borderRadius:14,padding:"16px 8px 8px",border:"1px solid rgba(255,255,255,0.05)",minHeight:320,display:"flex",flexDirection:"column",justifyContent:loading?"center":"flex-start",alignItems:loading?"center":"stretch"}}>
        {loading?<div style={{color:"rgba(255,255,255,0.3)",fontFamily:MONO,fontSize:12}}>Loading...</div>:(<>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{top:20,right:8,left:0,bottom:0}} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
              <XAxis dataKey="time" tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={{stroke:"rgba(255,255,255,0.1)"}} interval={23}/>
              <YAxis tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={{stroke:"rgba(255,255,255,0.1)"}} tickFormatter={v=>v===0?"0":v>0?`${(v/1000).toFixed(0)}k`:`${(v/1000).toFixed(0)}k`} width={40}/>
              <Tooltip contentStyle={TOOLTIP} formatter={(v,n)=>[fmt(Math.abs(v)),n]} labelStyle={{color:"rgba(255,255,255,0.5)"}} cursor={false}/>
              <Bar dataKey="pv" fill="#60a5fa" fillOpacity={0.8} name="Produced" stackId="pos"/>
              <Bar dataKey="batCharge" fill="#22c55e" fillOpacity={0.8} radius={[2,2,0,0]} name="Bat Charge" stackId="pos"/>
              <Bar dataKey="consumptionNeg" fill="#f97316" fillOpacity={0.8} name="Consumed" stackId="neg"/>
              <Bar dataKey="batDischargeNeg" fill="#22c55e" fillOpacity={0.8} radius={[0,0,2,2]} name="Bat Discharge" stackId="neg"/>
            </BarChart>
          </ResponsiveContainer>
          <div style={{padding:"0 8px",marginTop:8}}>
            <ResponsiveContainer width="100%" height={60}><AreaChart data={chartData} margin={{top:0,right:8,left:0,bottom:0}}>
              <defs>
                <linearGradient id="socG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/><stop offset="95%" stopColor="#22c55e" stopOpacity={0}/></linearGradient>
              </defs>
              <XAxis dataKey="time" hide/>
              <YAxis domain={[0,100]} hide/>
              <Area type="monotone" dataKey="soc" stroke="#22c55e" strokeWidth={2} fill="url(#socG)" dot={false} isAnimationActive={false}/>
              <Tooltip contentStyle={TOOLTIP} formatter={v=>[`${Number(v).toFixed(0)}%`,"Battery SOC"]} labelStyle={{color:"rgba(255,255,255,0.5)"}}/>
            </AreaChart></ResponsiveContainer>
            <div style={{fontSize:10,color:"rgba(34,197,94,0.5)",fontFamily:MONO,textAlign:"right"}}>Battery SOC</div>
          </div>
        </>)}
      </div>
    </div>
  );
}

function MonthChart({month,onMonthChange,data,loading}) {
  const produced = data.reduce((s,d) => s + (d.production||0), 0) * 1000;
  const consumed = data.reduce((s,d) => s + (d.consumption||0), 0) * 1000;
  const imported = data.reduce((s,d) => s + (d.fromGrid||0), 0) * 1000;
  const chartData = data.map(d => ({...d, consumptionNeg: -(d.consumption||0)}));
  return (
    <div style={{marginBottom:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{margin:0,fontSize:16,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>Month View</h2><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>Daily totals</div></div>
        <input type="month" value={month} onChange={e=>onMonthChange(e.target.value)} style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"#e2e8f0",padding:"6px 10px",fontSize:12,fontFamily:MONO,cursor:"pointer"}}/>
      </div>
      {!loading&&<EnphaseSummaryCard produced={produced} consumed={consumed} imported={imported} exported={0} charged={0} discharged={0}/>}
      <div style={{background:"rgba(255,255,255,0.02)",borderRadius:14,padding:"16px 8px 8px",border:"1px solid rgba(255,255,255,0.05)",minHeight:300,display:"flex",flexDirection:"column",justifyContent:loading?"center":"flex-start",alignItems:loading?"center":"stretch"}}>
        {loading?<div style={{color:"rgba(255,255,255,0.3)",fontFamily:MONO,fontSize:12}}>Loading...</div>:(
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartData} margin={{top:20,right:8,left:0,bottom:0}} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
              <XAxis dataKey="day" tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={{stroke:"rgba(255,255,255,0.1)"}}/>
              <YAxis tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={{stroke:"rgba(255,255,255,0.1)"}} width={40}/>
              <Tooltip contentStyle={TOOLTIP} formatter={(v,n)=>[`${Math.abs(v)} kWh`,n]} labelFormatter={l=>`Day ${l}`} labelStyle={{color:"rgba(255,255,255,0.5)"}} cursor={false}/>
              <Bar dataKey="production" fill="#60a5fa" fillOpacity={0.8} radius={[2,2,0,0]} name="Produced" stackId="pos"/>
              <Bar dataKey="consumptionNeg" fill="#f97316" fillOpacity={0.8} radius={[0,0,2,2]} name="Consumed" stackId="neg"/>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function YearChart({year,onYearChange,data,loading}) {
  const produced = data.reduce((s,d) => s + (d.production||0), 0) * 1000;
  const consumed = data.reduce((s,d) => s + (d.consumption||0), 0) * 1000;
  const chartData = data.map(d => ({...d, consumptionNeg: -(d.consumption||0)}));
  return (
    <div style={{marginBottom:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{margin:0,fontSize:16,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>Year View</h2><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>Monthly totals</div></div>
        <select value={year} onChange={e=>onYearChange(e.target.value)} style={{background:"rgba(15,23,42,0.9)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"#e2e8f0",padding:"6px 10px",fontSize:12,fontFamily:MONO,cursor:"pointer"}}>
          {["2025","2026","2027"].map(y=><option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      {!loading&&<EnphaseSummaryCard produced={produced} consumed={consumed} imported={0} exported={0} charged={0} discharged={0}/>}
      <div style={{background:"rgba(255,255,255,0.02)",borderRadius:14,padding:"16px 8px 8px",border:"1px solid rgba(255,255,255,0.05)",minHeight:280,display:"flex",flexDirection:"column",justifyContent:loading?"center":"flex-start",alignItems:loading?"center":"stretch"}}>
        {loading?<div style={{color:"rgba(255,255,255,0.3)",fontFamily:MONO,fontSize:12}}>Loading...</div>:(
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{top:20,right:8,left:0,bottom:0}} barCategoryGap="20%">
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
              <XAxis dataKey="month" tick={{fill:"rgba(255,255,255,0.3)",fontSize:11,fontFamily:MONO}} tickLine={false} axisLine={{stroke:"rgba(255,255,255,0.1)"}}/>
              <YAxis tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={{stroke:"rgba(255,255,255,0.1)"}} width={40} tickFormatter={v=>v>=1000?`${(v/1000).toFixed(1)}k`:v}/>
              <Tooltip contentStyle={TOOLTIP} formatter={(v,n)=>[`${Math.abs(v).toLocaleString()} kWh`,n]} labelStyle={{color:"rgba(255,255,255,0.5)"}} cursor={false}/>
              <Bar dataKey="production" fill="#60a5fa" fillOpacity={0.8} radius={[2,2,0,0]} name="Produced" stackId="pos"/>
              <Bar dataKey="consumptionNeg" fill="#f97316" fillOpacity={0.8} radius={[0,0,2,2]} name="Consumed" stackId="neg"/>
            </BarChart>
          </ResponsiveContainer>
        )}
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

  const [tab,setTab]=useState("live");
  const [statuses,setStatuses]=useState([]);
  const [liveLoading,setLiveLoading]=useState(true);
  const [liveError,setLiveError]=useState(null);
  const [lastUpdate,setLastUpdate]=useState(null);
  const [selectedInv,setSelectedInv]=useState("all");

  const [dayDate,setDayDate]=useState(today);
  const [dayData,setDayData]=useState([]);
  const [dayLoading,setDayLoading]=useState(false);
  const [monthDate,setMonthDate]=useState(thisMonth);
  const [monthData,setMonthData]=useState([]);
  const [monthLoading,setMonthLoading]=useState(false);
  const [yearVal,setYearVal]=useState(thisYear);
  const [yearData,setYearData]=useState([]);
  const [yearLoading,setYearLoading]=useState(false);

  function handleSitesResponse(data) {
    const raw = data.sites || (Array.isArray(data) ? data : []);
    const normalized = raw.filter(s => s.GoodsID && s.GoodsID.length > 0).map(s => ({
      name: s.MemberID || "Unknown",
      inverters: s.GoodsID.map((g, j) => ({ sn: typeof g === "string" ? g : g.GoodsID, label: `INV-${j + 1}` })),
      statusCounts: s.MemberStateCount || [0,0,0,0],
      installer: s.op_member?.installer || "",
    }));

    // End-user accounts won't have inverter lists from terminaluserinfo
    // If no sites with inverters found, create a placeholder site that will discover inverters via status
    if (normalized.length === 0 && data.accountType === "enduser") {
      const creds = JSON.parse(localStorage.getItem("midnite_creds") || "{}");
      const endUserSite = { name: creds.username || "My Site", inverters: [], statusCounts: [0,0,0,0], installer: "", needsDiscovery: true };
      setSites([endUserSite]);
      setSite(endUserSite);
      setAuthState("dashboard");
      return;
    }

    setSites(normalized);
    if (normalized.length === 0) {
      setLoginError("No sites found for this account");
      setAuthState("login");
    } else if (normalized.length === 1) {
      setSite(normalized[0]);
      setAuthState("dashboard");
    } else {
      const savedName = localStorage.getItem("midnite_selected_site");
      const saved = savedName && normalized.find(s => s.name === savedName);
      if (saved) { setSite(saved); setAuthState("dashboard"); }
      else setAuthState("sites");
    }
  }

  async function handleLogin(username, password) {
    setLoginLoading(true);
    setLoginError(null);
    try {
      localStorage.setItem("midnite_creds", JSON.stringify({ username, password }));
      await api("login");
      const sitesData = await api("sites");
      handleSitesResponse(sitesData);
    } catch (e) {
      localStorage.removeItem("midnite_creds");
      setLoginError(e.message.includes("Login failed") ? "Invalid username or password" : e.message);
      setAuthState("login");
    } finally {
      setLoginLoading(false);
    }
  }

  function handleLogout() {
    localStorage.removeItem("midnite_creds");
    localStorage.removeItem("midnite_selected_site");
    setSite(null);
    setSites([]);
    setStatuses([]);
    setAuthState("login");
  }

  function handleSelectSite(s) {
    setSite(s);
    setStatuses([]);
    setLiveLoading(true);
    setSelectedInv("all");
    localStorage.setItem("midnite_selected_site", s.name);
    setAuthState("dashboard");
  }

  useEffect(() => {
    const creds = JSON.parse(localStorage.getItem("midnite_creds") || "null");
    if (!creds) { setAuthState("login"); return; }
    api("sites")
      .then(data => handleSitesResponse(data))
      .catch(() => { localStorage.removeItem("midnite_creds"); setAuthState("login"); });
  }, []);

  const fetchLive=useCallback(async()=>{
    if(!site) return;
    try { const {results}=await api("status",{serials:site.inverters.map(i=>i.sn)}); setStatuses(results.map((r,idx)=>({...r,label:site.inverters[idx]?.label}))); setLastUpdate(new Date()); setLiveError(null); }
    catch(e){setLiveError(e.message);}
    finally{setLiveLoading(false);}
  },[site]);

  useEffect(()=>{if(!site) return; setLiveLoading(true); fetchLive();const t=setInterval(fetchLive,60000);return()=>clearInterval(t);},[fetchLive]);

  const chartInverters = site ? (selectedInv==="all" ? site.inverters : site.inverters.filter(i=>i.sn===selectedInv)) : [];

  useEffect(()=>{ if(tab!=="day"||!site) return; setDayLoading(true); Promise.all(chartInverters.map(inv=>api("day",{sn:inv.sn,date:dayDate}).catch(()=>null))).then(all=>{setDayData(aggregateDayData(all));setDayLoading(false);}); },[tab,dayDate,selectedInv,site]);
  useEffect(()=>{ if(tab!=="month"||!site) return; setMonthLoading(true); Promise.all(chartInverters.map(inv=>api("month",{sn:inv.sn,date:monthDate}).catch(()=>null))).then(all=>{setMonthData(aggregateMonthData(all));setMonthLoading(false);}); },[tab,monthDate,selectedInv,site]);
  useEffect(()=>{ if(tab!=="year"||!site) return; setYearLoading(true); Promise.all(chartInverters.map(inv=>api("year",{sn:inv.sn,date:yearVal}).catch(()=>null))).then(all=>{setYearData(aggregateYearData(all));setYearLoading(false);}); },[tab,yearVal,selectedInv,site]);

  const visibleStatuses = selectedInv==="all" ? statuses : statuses.filter(s=>s.sn===selectedInv);

  if (authState==="loading") return (<><PageHead/><div style={{minHeight:"100vh",background:"#080f1e",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:MONO,color:"rgba(255,255,255,0.3)",fontSize:13}}>Loading...</div></>);
  if (authState==="login") return <LoginForm onLogin={handleLogin} error={loginError} loading={loginLoading}/>;
  if (authState==="sites") return <SiteSelector sites={sites} onSelect={handleSelectSite} onLogout={handleLogout}/>;

  return (
    <>
      <PageHead/>
      <div style={{minHeight:"100vh",background:"#080f1e",backgroundImage:"radial-gradient(ellipse 80% 50% at 50% -20%,rgba(251,191,36,0.06),transparent 60%)",fontFamily:SANS,paddingBottom:48}}>
        <div style={{borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"16px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(0,0,0,0.3)",backdropFilter:"blur(12px)",position:"sticky",top:0,zIndex:100,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#fbbf24,#f59e0b)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,boxShadow:"0 0 16px rgba(251,191,36,0.4)"}}>⚡</div>
            <div><div style={{fontSize:15,fontWeight:700}}>{site.name}</div><div style={{fontSize:10,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>{site.inverters.length} inverter{site.inverters.length!==1?"s":""}{site.installer?` · ${site.installer}`:""}</div></div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
            {lastUpdate&&<div style={{fontSize:10,color:"rgba(255,255,255,0.25)",fontFamily:MONO}}>Updated {lastUpdate.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>}
            <div style={{display:"flex",gap:4,background:"rgba(255,255,255,0.05)",borderRadius:10,padding:4}}>
              {["live","day","month","year"].map(t=><button key={t} onClick={()=>setTab(t)} style={{padding:"6px 14px",borderRadius:7,border:"none",background:tab===t?"rgba(255,255,255,0.1)":"transparent",color:tab===t?"#e2e8f0":"rgba(255,255,255,0.35)",fontSize:12,cursor:"pointer",fontFamily:MONO,fontWeight:tab===t?600:400,textTransform:"capitalize",transition:"all 0.15s"}}>{t}</button>)}
            </div>
            {sites.length>1&&<button onClick={()=>{setAuthState("sites");setSite(null);setStatuses([]);}} style={{padding:"6px 12px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.03)",color:"rgba(255,255,255,0.4)",fontSize:11,fontFamily:MONO,cursor:"pointer"}}>Sites</button>}
            <button onClick={handleLogout} style={{padding:"6px 12px",borderRadius:8,border:"1px solid rgba(255,255,255,0.1)",background:"rgba(255,255,255,0.03)",color:"rgba(255,255,255,0.4)",fontSize:11,fontFamily:MONO,cursor:"pointer"}}>Logout</button>
          </div>
        </div>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 20px",animation:"fadeUp 0.4s ease"}}>

          <InverterSelector selected={selectedInv} onChange={setSelectedInv} statuses={statuses} inverters={site.inverters}/>

          {tab==="live"&&(<>
            {liveError&&<div style={{background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:13,color:"#f87171",fontFamily:MONO}}>Error: {liveError}</div>}
            {liveLoading?<div style={{textAlign:"center",color:"rgba(255,255,255,0.3)",fontFamily:MONO,padding:48}}>Connecting to Midnite portal...</div>:<>
              {selectedInv==="all"&&<AggregateBar statuses={statuses}/>}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:16}}>
                {visibleStatuses.map((s,i)=>{
                  const inv = site.inverters.find(inv=>inv.sn===s.sn)||{sn:s.sn,label:s.label};
                  return <InverterCard key={s.sn} inv={inv} status={s}/>;
                })}
              </div>
            </>}
          </>)}
          {tab==="day"&&<DayChart date={dayDate} onDateChange={setDayDate} data={dayData} loading={dayLoading}/>}
          {tab==="month"&&<MonthChart month={monthDate} onMonthChange={setMonthDate} data={monthData} loading={monthLoading}/>}
          {tab==="year"&&<YearChart year={yearVal} onYearChange={setYearVal} data={yearData} loading={yearLoading}/>}
        </div>
        <div style={{textAlign:"center",fontSize:10,color:"rgba(255,255,255,0.12)",fontFamily:MONO,paddingTop:8}}>FSDG · {site.name} · Midnite Solar Monitoring</div>
      </div>
    </>
  );
}
