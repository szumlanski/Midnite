import { useState, useEffect, useCallback } from "react";
import Head from "next/head";
import { AreaChart, Area, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const SITE = { name: "Wise Naples", groupId: "47031", inverters: [{ sn: "2426-90190114PH", label: "INV-1" },{ sn: "2426-90190151PH", label: "INV-2" },{ sn: "2426-90190186PH", label: "INV-3" },{ sn: "2426-90190187PH", label: "INV-4" }] };
const today = new Date().toISOString().split("T")[0];
const thisMonth = today.slice(0,7);
const thisYear = today.slice(0,4);
const MONO = "'JetBrains Mono', monospace";
const SANS = "'Space Grotesk', sans-serif";
const TOOLTIP = { background:"rgba(8,15,30,0.97)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:10, padding:"10px 14px", fontSize:12, fontFamily:MONO, color:"#e2e8f0" };
const fmt = (w,d=1) => { if(w==null) return "--"; if(Math.abs(w)>=1000) return `${(w/1000).toFixed(d)} kW`; return `${Math.round(w)} W`; };
const fmtE = (wh) => { if(wh==null) return "--"; if(wh>=1000000) return `${(wh/1000000).toFixed(2)} MWh`; if(wh>=1000) return `${(wh/1000).toFixed(1)} kWh`; return `${Math.round(wh)} Wh`; };

async function api(action, body=null) {
  const res = await fetch(`/api/midnite?action=${action}`, { method:body?"POST":"GET", headers:{"Content-Type":"application/json"}, ...(body?{body:JSON.stringify(body)}:{}) });
  if(!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

function aggregateDayData(all) {
  const map = {};
  for(const inv of all) { if(!inv||!inv.Data) continue; for(const r of inv.Data) { const k=r.inTime; if(!map[k]) map[k]={time:k,pv:0,load:0,gridImport:0,gridExport:0,soc:0,n:0}; map[k].pv+=parseFloat(r.Production||0); map[k].load+=parseFloat(r.Consumption||0); map[k].gridImport+=parseFloat(r.powerFromGrid||0); map[k].gridExport+=parseFloat(r.powerToGrid||0); map[k].soc+=parseFloat(r.SOC||0); map[k].n+=1; } }
  return Object.values(map).sort((a,b)=>a.time.localeCompare(b.time)).map(r=>({...r,soc:r.n?r.soc/r.n:0}));
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

function SOCBar({value}) {
  const color=value>60?"#4ade80":value>30?"#fbbf24":"#f87171";
  return <div style={{display:"flex",alignItems:"center",gap:8}}><div style={{flex:1,height:6,background:"rgba(255,255,255,0.08)",borderRadius:3,overflow:"hidden"}}><div style={{width:`${value}%`,height:"100%",background:color,borderRadius:3,boxShadow:`0 0 8px ${color}80`}}/></div><span style={{fontSize:12,color,fontFamily:MONO,minWidth:32}}>{value}%</span></div>;
}

function StatPill({label,value,color="#94a3b8",glow=false}) {
  return <div style={{display:"flex",flexDirection:"column",gap:2,padding:"10px 14px",background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.07)",borderRadius:10,boxShadow:glow?`0 0 20px ${color}30`:"none"}}><span style={{fontSize:10,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.1em",fontFamily:MONO}}>{label}</span><span style={{fontSize:15,fontWeight:600,color,fontFamily:MONO}}>{value}</span></div>;
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

function InverterSelector({selected, onChange, statuses}) {
  const options = [
    { value: "all", label: "All Inverters" },
    ...SITE.inverters.map((inv, i) => {
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
  const [view,setView]=useState("all");
  return (
    <div style={{marginBottom:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{margin:0,fontSize:16,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>Day View</h2><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>5-min intervals · W</div></div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input type="date" value={date} onChange={e=>onDateChange(e.target.value)} style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"#e2e8f0",padding:"6px 10px",fontSize:12,fontFamily:MONO,cursor:"pointer"}}/>
          {["all","pv","grid"].map(v=><button key={v} onClick={()=>setView(v)} style={{padding:"5px 10px",borderRadius:7,border:"1px solid",borderColor:view===v?"rgba(251,191,36,0.5)":"rgba(255,255,255,0.1)",background:view===v?"rgba(251,191,36,0.1)":"transparent",color:view===v?"#fbbf24":"rgba(255,255,255,0.4)",fontSize:11,cursor:"pointer",fontFamily:MONO,textTransform:"uppercase"}}>{v}</button>)}
        </div>
      </div>
      <div style={{background:"rgba(255,255,255,0.02)",borderRadius:14,padding:"16px 8px 8px",border:"1px solid rgba(255,255,255,0.05)",minHeight:320,display:"flex",flexDirection:"column",justifyContent:loading?"center":"flex-start",alignItems:loading?"center":"stretch"}}>
        {loading?<div style={{color:"rgba(255,255,255,0.3)",fontFamily:MONO,fontSize:12}}>Loading...</div>:(<>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={data} margin={{top:0,right:8,left:0,bottom:0}}>
              <defs>
                <linearGradient id="pvG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#fbbf24" stopOpacity={0.3}/><stop offset="95%" stopColor="#fbbf24" stopOpacity={0}/></linearGradient>
                <linearGradient id="ldG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#60a5fa" stopOpacity={0.2}/><stop offset="95%" stopColor="#60a5fa" stopOpacity={0}/></linearGradient>
                <linearGradient id="exG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#4ade80" stopOpacity={0.25}/><stop offset="95%" stopColor="#4ade80" stopOpacity={0}/></linearGradient>
                <linearGradient id="imG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f87171" stopOpacity={0.25}/><stop offset="95%" stopColor="#f87171" stopOpacity={0}/></linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)"/>
              <XAxis dataKey="time" tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={false} interval={23}/>
              <YAxis tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={false} tickFormatter={v=>v>=1000?`${(v/1000).toFixed(0)}k`:v} width={36}/>
              <Tooltip contentStyle={TOOLTIP} formatter={(v,n)=>[fmt(v),n]} labelStyle={{color:"rgba(255,255,255,0.5)"}}/>
              {(view==="all"||view==="pv")&&<Area type="monotone" dataKey="pv" stroke="#fbbf24" strokeWidth={2} fill="url(#pvG)" name="PV" dot={false}/>}
              {(view==="all"||view==="pv")&&<Area type="monotone" dataKey="load" stroke="#60a5fa" strokeWidth={1.5} fill="url(#ldG)" name="Load" dot={false}/>}
              {(view==="all"||view==="grid")&&<Area type="monotone" dataKey="gridExport" stroke="#4ade80" strokeWidth={1.5} fill="url(#exG)" name="Grid Export" dot={false}/>}
              {(view==="all"||view==="grid")&&<Area type="monotone" dataKey="gridImport" stroke="#f87171" strokeWidth={1.5} fill="url(#imG)" name="Grid Import" dot={false}/>}
            </AreaChart>
          </ResponsiveContainer>
          <div style={{padding:"0 8px",marginTop:4}}>
            <ResponsiveContainer width="100%" height={44}><LineChart data={data} margin={{top:0,right:8,left:0,bottom:0}}><XAxis dataKey="time" hide/><YAxis domain={[0,100]} hide/><Line type="monotone" dataKey="soc" stroke="#c084fc" strokeWidth={1.5} dot={false} name="SOC %"/><Tooltip contentStyle={TOOLTIP} formatter={v=>[`${Number(v).toFixed(0)}%`,"Battery SOC"]} labelStyle={{color:"rgba(255,255,255,0.5)"}}/></LineChart></ResponsiveContainer>
            <div style={{fontSize:10,color:"rgba(192,132,252,0.5)",fontFamily:MONO,textAlign:"right"}}>SOC %</div>
          </div>
        </>)}
      </div>
    </div>
  );
}

function MonthChart({month,onMonthChange,data,loading}) {
  return (
    <div style={{marginBottom:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{margin:0,fontSize:16,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>Month View</h2><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>Daily totals · kWh</div></div>
        <input type="month" value={month} onChange={e=>onMonthChange(e.target.value)} style={{background:"rgba(255,255,255,0.05)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"#e2e8f0",padding:"6px 10px",fontSize:12,fontFamily:MONO,cursor:"pointer"}}/>
      </div>
      <div style={{background:"rgba(255,255,255,0.02)",borderRadius:14,padding:"16px 8px 8px",border:"1px solid rgba(255,255,255,0.05)",minHeight:300,display:"flex",flexDirection:"column",justifyContent:loading?"center":"flex-start",alignItems:loading?"center":"stretch"}}>
        {loading?<div style={{color:"rgba(255,255,255,0.3)",fontFamily:MONO,fontSize:12}}>Loading...</div>:(
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data} margin={{top:0,right:8,left:0,bottom:0}} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false}/>
              <XAxis dataKey="day" tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={false}/>
              <YAxis tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={false} width={36}/>
              <Tooltip contentStyle={TOOLTIP} formatter={(v,n)=>[`${v} kWh`,n]} labelFormatter={l=>`Day ${l}`} labelStyle={{color:"rgba(255,255,255,0.5)"}}/>
              <Legend wrapperStyle={{fontSize:11,fontFamily:MONO,paddingTop:8}}/>
              <Bar dataKey="production" fill="#fbbf24" fillOpacity={0.85} radius={[3,3,0,0]} name="Production"/>
              <Bar dataKey="consumption" fill="#60a5fa" fillOpacity={0.6} radius={[3,3,0,0]} name="Consumption"/>
              <Bar dataKey="fromGrid" fill="#f87171" fillOpacity={0.5} radius={[3,3,0,0]} name="From Grid"/>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function YearChart({year,onYearChange,data,loading}) {
  return (
    <div style={{marginBottom:32}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:10}}>
        <div><h2 style={{margin:0,fontSize:16,fontWeight:700,color:"#e2e8f0",fontFamily:SANS}}>Year View</h2><div style={{fontSize:11,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>Monthly totals · kWh</div></div>
        <select value={year} onChange={e=>onYearChange(e.target.value)} style={{background:"rgba(15,23,42,0.9)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:8,color:"#e2e8f0",padding:"6px 10px",fontSize:12,fontFamily:MONO,cursor:"pointer"}}>
          {["2025","2026","2027"].map(y=><option key={y} value={y}>{y}</option>)}
        </select>
      </div>
      <div style={{background:"rgba(255,255,255,0.02)",borderRadius:14,padding:"16px 8px 8px",border:"1px solid rgba(255,255,255,0.05)",minHeight:280,display:"flex",flexDirection:"column",justifyContent:loading?"center":"flex-start",alignItems:loading?"center":"stretch"}}>
        {loading?<div style={{color:"rgba(255,255,255,0.3)",fontFamily:MONO,fontSize:12}}>Loading...</div>:(
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data} margin={{top:0,right:8,left:0,bottom:0}} barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false}/>
              <XAxis dataKey="month" tick={{fill:"rgba(255,255,255,0.3)",fontSize:11,fontFamily:MONO}} tickLine={false} axisLine={false}/>
              <YAxis tick={{fill:"rgba(255,255,255,0.3)",fontSize:10,fontFamily:MONO}} tickLine={false} axisLine={false} width={40} tickFormatter={v=>v>=1000?`${(v/1000).toFixed(1)}k`:v}/>
              <Tooltip contentStyle={TOOLTIP} formatter={(v,n)=>[`${Number(v).toLocaleString()} kWh`,n]} labelStyle={{color:"rgba(255,255,255,0.5)"}}/>
              <Legend wrapperStyle={{fontSize:11,fontFamily:MONO,paddingTop:8}}/>
              <Bar dataKey="production" fill="#fbbf24" fillOpacity={0.85} radius={[4,4,0,0]} name="Production"/>
              <Bar dataKey="consumption" fill="#60a5fa" fillOpacity={0.6} radius={[4,4,0,0]} name="Consumption"/>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
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

  const fetchLive=useCallback(async()=>{
    try { const {results}=await api("status",{serials:SITE.inverters.map(i=>i.sn)}); setStatuses(results.map((r,idx)=>({...r,label:SITE.inverters[idx]?.label}))); setLastUpdate(new Date()); setLiveError(null); }
    catch(e){setLiveError(e.message);}
    finally{setLiveLoading(false);}
  },[]);

  useEffect(()=>{fetchLive();const t=setInterval(fetchLive,60000);return()=>clearInterval(t);},[fetchLive]);

  // Which inverters to show/fetch for charts
  const chartInverters = selectedInv==="all" ? SITE.inverters : SITE.inverters.filter(i=>i.sn===selectedInv);

  useEffect(()=>{ if(tab!=="day") return; setDayLoading(true); Promise.all(chartInverters.map(inv=>api("day",{sn:inv.sn,date:dayDate}).catch(()=>null))).then(all=>{setDayData(aggregateDayData(all));setDayLoading(false);}); },[tab,dayDate,selectedInv]);
  useEffect(()=>{ if(tab!=="month") return; setMonthLoading(true); Promise.all(chartInverters.map(inv=>api("month",{sn:inv.sn,date:monthDate}).catch(()=>null))).then(all=>{setMonthData(aggregateMonthData(all));setMonthLoading(false);}); },[tab,monthDate,selectedInv]);
  useEffect(()=>{ if(tab!=="year") return; setYearLoading(true); Promise.all(chartInverters.map(inv=>api("year",{sn:inv.sn,date:yearVal}).catch(()=>null))).then(all=>{setYearData(aggregateYearData(all));setYearLoading(false);}); },[tab,yearVal,selectedInv]);

  // Filtered statuses for live view
  const visibleStatuses = selectedInv==="all" ? statuses : statuses.filter(s=>s.sn===selectedInv);

  return (
    <>
      <Head>
        <title>Midnite · {SITE.name}</title>
        <link rel="preconnect" href="https://fonts.googleapis.com"/>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous"/>
        <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet"/>
        <style>{`*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}body{background:#080f1e;color:#e2e8f0}input[type=date]::-webkit-calendar-picker-indicator,input[type=month]::-webkit-calendar-picker-indicator{filter:invert(0.5);cursor:pointer}@keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>
      </Head>
      <div style={{minHeight:"100vh",background:"#080f1e",backgroundImage:"radial-gradient(ellipse 80% 50% at 50% -20%,rgba(251,191,36,0.06),transparent 60%)",fontFamily:SANS,paddingBottom:48}}>
        <div style={{borderBottom:"1px solid rgba(255,255,255,0.06)",padding:"16px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",background:"rgba(0,0,0,0.3)",backdropFilter:"blur(12px)",position:"sticky",top:0,zIndex:100,flexWrap:"wrap",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#fbbf24,#f59e0b)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,boxShadow:"0 0 16px rgba(251,191,36,0.4)"}}>⚡</div>
            <div><div style={{fontSize:15,fontWeight:700}}>{SITE.name}</div><div style={{fontSize:10,color:"rgba(255,255,255,0.3)",fontFamily:MONO}}>{SITE.inverters.length} inverters · Group {SITE.groupId}</div></div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
            {lastUpdate&&<div style={{fontSize:10,color:"rgba(255,255,255,0.25)",fontFamily:MONO}}>Updated {lastUpdate.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>}
            <div style={{display:"flex",gap:4,background:"rgba(255,255,255,0.05)",borderRadius:10,padding:4}}>
              {["live","day","month","year"].map(t=><button key={t} onClick={()=>setTab(t)} style={{padding:"6px 14px",borderRadius:7,border:"none",background:tab===t?"rgba(255,255,255,0.1)":"transparent",color:tab===t?"#e2e8f0":"rgba(255,255,255,0.35)",fontSize:12,cursor:"pointer",fontFamily:MONO,fontWeight:tab===t?600:400,textTransform:"capitalize",transition:"all 0.15s"}}>{t}</button>)}
            </div>
          </div>
        </div>
        <div style={{maxWidth:1200,margin:"0 auto",padding:"24px 20px",animation:"fadeUp 0.4s ease"}}>

          <InverterSelector selected={selectedInv} onChange={setSelectedInv} statuses={statuses}/>

          {tab==="live"&&(<>
            {liveError&&<div style={{background:"rgba(248,113,113,0.1)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:13,color:"#f87171",fontFamily:MONO}}>Error: {liveError}</div>}
            {liveLoading?<div style={{textAlign:"center",color:"rgba(255,255,255,0.3)",fontFamily:MONO,padding:48}}>Connecting to Midnite portal...</div>:<>
              {selectedInv==="all"&&<AggregateBar statuses={statuses}/>}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:16}}>
                {visibleStatuses.map((s,i)=>{
                  const inv = SITE.inverters.find(inv=>inv.sn===s.sn)||{sn:s.sn,label:s.label};
                  return <InverterCard key={s.sn} inv={inv} status={s}/>;
                })}
              </div>
            </>}
          </>)}
          {tab==="day"&&<DayChart date={dayDate} onDateChange={setDayDate} data={dayData} loading={dayLoading}/>}
          {tab==="month"&&<MonthChart month={monthDate} onMonthChange={setMonthDate} data={monthData} loading={monthLoading}/>}
          {tab==="year"&&<YearChart year={yearVal} onYearChange={setYearVal} data={yearData} loading={yearLoading}/>}
        </div>
        <div style={{textAlign:"center",fontSize:10,color:"rgba(255,255,255,0.12)",fontFamily:MONO,paddingTop:8}}>FSDG · {SITE.name} · Midnite Solar Monitoring</div>
      </div>
    </>
  );
}
