import { useState, useEffect } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ComposedChart
} from 'recharts';

const fmtE = (wh) => {
  if (wh >= 1e6) return (wh / 1e6).toFixed(2) + ' MWh';
  if (wh >= 1e3) return (wh / 1e3).toFixed(2) + ' kWh';
  return wh.toFixed(0) + ' Wh';
};

const aggregateDayData = (records) => {
  const byTime = {};
  records.forEach(r => {
    const key = r.recordTime;
    if (!byTime[key]) byTime[key] = { time: key, pv: 0, load: 0, charge: 0, discharge: 0 };
    byTime[key].pv += r.pvArray?.power || 0;
    byTime[key].load += r.loads?.power || 0;
    byTime[key].charge += r.battery?.chargeRate || 0;
    byTime[key].discharge += r.battery?.dischargeRate || 0;
  });
  return Object.values(byTime).map(d => ({
    ...d,
    pvWh: d.pv * (5/60),
    loadWh: d.load * (5/60),
    chargeWh: d.charge * (5/60),
    dischargeWh: d.discharge * (5/60)
  }));
};

const aggregateMonthData = (days) => {
  return days.map(d => ({
    date: d.date,
    produced: (d.pvArray?.energyProduced || 0) * 1000,
    consumed: (d.loads?.energyConsumed || 0) * 1000,
    imported: (d.grid?.energyImported || 0) * 1000,
    exported: (d.grid?.energyExported || 0) * 1000,
    charged: (d.battery?.energyCharged || 0) * 1000,
    discharged: (d.battery?.energyDischarged || 0) * 1000
  }));
};

const aggregateYearData = (months) => {
  return months.map(m => ({
    date: m.date,
    produced: m.pvArray?.energyProduced * 1000 || 0,
    consumed: m.loads?.energyConsumed * 1000 || 0,
    imported: m.grid?.energyImported * 1000 || 0,
    exported: m.grid?.energyExported * 1000 || 0,
    charged: m.battery?.energyCharged * 1000 || 0,
    discharged: m.battery?.energyDischarged * 1000 || 0
  }));
};

const EnphaseSummaryCard = ({ produced, consumed, imported, exported, charged, discharged }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: '1rem',
    marginBottom: '1.5rem', padding: '1rem', background: '#0f172a', borderRadius: '0.5rem'
  }}>
    <div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', textTransform: 'uppercase' }}>PRODUCED</div>
      <div style={{ fontSize: '1.5rem', color: '#60a5fa', fontWeight: 'bold' }}>{fmtE(produced)}</div>
    </div>
    <div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', textTransform: 'uppercase' }}>CONSUMED</div>
      <div style={{ fontSize: '1.5rem', color: '#f97316', fontWeight: 'bold' }}>{fmtE(consumed)}</div>
    </div>
    <div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', textTransform: 'uppercase' }}>IMPORTED</div>
      <div style={{ fontSize: '1.5rem', color: '#ec4899', fontWeight: 'bold' }}>{fmtE(imported)}</div>
    </div>
    <div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', textTransform: 'uppercase' }}>EXPORTED</div>
      <div style={{ fontSize: '1.5rem', color: '#eab308', fontWeight: 'bold' }}>{fmtE(exported)}</div>
    </div>
    <div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', textTransform: 'uppercase' }}>CHARGED</div>
      <div style={{ fontSize: '1.5rem', color: '#22c55e', fontWeight: 'bold' }}>{fmtE(charged)}</div>
    </div>
    <div>
      <div style={{ fontSize: '0.875rem', color: '#94a3b8', textTransform: 'uppercase' }}>DISCHARGED</div>
      <div style={{ fontSize: '1.5rem', color: '#f43f5e', fontWeight: 'bold' }}>{fmtE(discharged)}</div>
    </div>
  </div>
);

const DayChart = ({ data }) => {
  if (!data || data.length === 0) return <div style={{color: '#e2e8f0'}}>No day data</div>;
  
  const totals = data.reduce((acc, d) => ({
    pv: acc.pv + (d.pvWh || 0),
    load: acc.load + (d.loadWh || 0),
    charge: acc.charge + (d.chargeWh || 0),
    discharge: acc.discharge + (d.dischargeWh || 0)
  }), { pv: 0, load: 0, charge: 0, discharge: 0 });

  return (
    <div>
      <EnphaseSummaryCard produced={totals.pv} consumed={totals.load} imported={0} exported={0} charged={totals.charge} discharged={totals.discharge} />
      <ResponsiveContainer width="100%" height={400}>
        <ComposedChart data={data} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="time" stroke="#64748b" />
          <YAxis stroke="#64748b" />
          <Tooltip 
            contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.5rem' }}
            labelStyle={{ color: '#e2e8f0' }}
            cursor={false}
          />
          <Bar dataKey="pvWh" fill="#60a5fa" stackId="positive" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="chargeWh" fill="#22c55e" stackId="positive" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="loadWh" fill="#f97316" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="dischargeWh" fill="#f43f5e" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

const MonthChart = ({ data }) => {
  if (!data || data.length === 0) return <div style={{color: '#e2e8f0'}}>No month data</div>;
  
  const totals = data.reduce((acc, d) => ({
    produced: acc.produced + (d.produced || 0),
    consumed: acc.consumed + (d.consumed || 0),
    imported: acc.imported + (d.imported || 0),
    exported: acc.exported + (d.exported || 0),
    charged: acc.charged + (d.charged || 0),
    discharged: acc.discharged + (d.discharged || 0)
  }), { produced: 0, consumed: 0, imported: 0, exported: 0, charged: 0, discharged: 0 });

  return (
    <div>
      <EnphaseSummaryCard produced={totals.produced} consumed={totals.consumed} imported={totals.imported} exported={totals.exported} charged={totals.charged} discharged={totals.discharged} />
      <ResponsiveContainer width="100%" height={400}>
        <ComposedChart data={data} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="date" stroke="#64748b" />
          <YAxis stroke="#64748b" />
          <Tooltip 
            contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.5rem' }}
            labelStyle={{ color: '#e2e8f0' }}
            cursor={false}
          />
          <Bar dataKey="produced" fill="#60a5fa" stackId="positive" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="charged" fill="#22c55e" stackId="positive" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="consumed" fill="#f97316" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="discharged" fill="#f43f5e" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

const YearChart = ({ data }) => {
  if (!data || data.length === 0) return <div style={{color: '#e2e8f0'}}>No year data</div>;
  
  const totals = data.reduce((acc, d) => ({
    produced: acc.produced + (d.produced || 0),
    consumed: acc.consumed + (d.consumed || 0),
    imported: acc.imported + (d.imported || 0),
    exported: acc.exported + (d.exported || 0),
    charged: acc.charged + (d.charged || 0),
    discharged: acc.discharged + (d.discharged || 0)
  }), { produced: 0, consumed: 0, imported: 0, exported: 0, charged: 0, discharged: 0 });

  return (
    <div>
      <EnphaseSummaryCard produced={totals.produced} consumed={totals.consumed} imported={totals.imported} exported={totals.exported} charged={totals.charged} discharged={totals.discharged} />
      <ResponsiveContainer width="100%" height={400}>
        <ComposedChart data={data} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="date" stroke="#64748b" />
          <YAxis stroke="#64748b" />
          <Tooltip 
            contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.5rem' }}
            labelStyle={{ color: '#e2e8f0' }}
            cursor={false}
          />
          <Bar dataKey="produced" fill="#60a5fa" stackId="positive" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="charged" fill="#22c55e" stackId="positive" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="consumed" fill="#f97316" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="discharged" fill="#f43f5e" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

const BatterySOCChart = ({ data }) => {
  if (!data || data.length === 0) return <div style={{color: '#e2e8f0'}}>No SOC data</div>;

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="date" stroke="#64748b" />
        <YAxis stroke="#64748b" domain={[0, 100]} />
        <Tooltip 
          contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '0.5rem' }}
          labelStyle={{ color: '#e2e8f0' }}
        />
        <Area type="monotone" dataKey="soc" fill="#22c55e" stroke="#16a34a" isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
};

export default function Dashboard() {
  const [view, setView] = useState('day');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [inverters, setInverters] = useState([]);
  const [dayData, setDayData] = useState([]);
  const [monthData, setMonthData] = useState([]);
  const [yearData, setYearData] = useState([]);
  const [socData, setSocData] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        setError(null);

        const overviewResp = await fetch('/api/midnite?action=overview', { method: 'POST' });
        if (!overviewResp.ok) throw new Error(`Overview failed: ${overviewResp.status}`);
        const overview = await overviewResp.json();
        setInverters(overview.inverters || []);

        const dayResp = await fetch('/api/midnite?action=day', { method: 'POST' });
        if (!dayResp.ok) throw new Error(`Day failed: ${dayResp.status}`);
        const dayJson = await dayResp.json();
        setDayData(aggregateDayData(dayJson.records || []));

        const monthResp = await fetch('/api/midnite?action=month', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: month })
        });
        if (!monthResp.ok) throw new Error(`Month failed: ${monthResp.status}`);
        const monthJson = await monthResp.json();
        setMonthData(aggregateMonthData(monthJson.data || []));

        const yearResp = await fetch('/api/midnite?action=year', { method: 'POST' });
        if (!yearResp.ok) throw new Error(`Year failed: ${yearResp.status}`);
        const yearJson = await yearResp.json();
        setYearData(aggregateYearData(yearJson.data || []));

        setSocData((monthJson.data || []).map(d => ({ date: d.date, soc: d.battery?.soc || 0 })));
      } catch (err) {
        console.error('Error loading data:', err);
        setError(err.message);
      }
    };

    load();
    const interval = setInterval(load, 300000);
    return () => clearInterval(interval);
  }, [month]);

  return (
    <div style={{ background: '#020617', color: '#e2e8f0', minHeight: '100vh', padding: '2rem', fontFamily: 'system-ui' }}>
      {error && <div style={{color: '#f87171', marginBottom: '1rem', padding: '1rem', background: '#7f1d1d', borderRadius: '0.5rem'}}>Error: {error}</div>}
      <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem', overflowX: 'auto' }}>
          <button 
            onClick={() => setView('day')} 
            style={{ 
              padding: '0.75rem 1.5rem', 
              background: view === 'day' ? '#ca8a04' : 'transparent', 
              color: view === 'day' ? '#000' : '#e2e8f0',
              border: '1px solid #ca8a04', 
              borderRadius: '0.5rem', 
              cursor: 'pointer',
              fontWeight: 'bold'
            }}
          >
            All Inverters
          </button>
          {inverters.map(inv => (
            <button key={inv.id} style={{
              padding: '0.75rem 1rem',
              background: '#1e293b',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}>
              {inv.name} - {(inv.power / 1000).toFixed(1)} kW - SOC {inv.soc || 0}%
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '2rem', marginBottom: '2rem', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.875rem', fontWeight: 'bold' }}>{view === 'day' ? 'Day View' : view === 'month' ? 'Month View' : 'Year View'}</h2>
            <p style={{ margin: '0.25rem 0 0 0', color: '#94a3b8', fontSize: '0.875rem' }}>
              {view === 'day' && 'Today, 5-minute intervals'}
              {view === 'month' && 'Daily totals'}
              {view === 'year' && 'Monthly totals'}
            </p>
          </div>
          {view === 'month' && (
            <input 
              type="month" 
              value={month} 
              onChange={(e) => setMonth(e.target.value)}
              style={{
                padding: '0.5rem 1rem',
                background: '#1e293b',
                color: '#e2e8f0',
                border: '1px solid #334155',
                borderRadius: '0.375rem',
                cursor: 'pointer'
              }}
            />
          )}
        </div>

        <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
          {['day', 'month', 'year'].map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '0.5rem 1rem',
                background: view === v ? '#0ea5e9' : '#1e293b',
                color: '#e2e8f0',
                border: 'none',
                borderRadius: '0.375rem',
                cursor: 'pointer',
                textTransform: 'capitalize',
                fontWeight: view === v ? 'bold' : 'normal'
              }}
            >
              {v}
            </button>
          ))}
        </div>

        {view === 'day' && <DayChart data={dayData} />}
        {view === 'month' && <MonthChart data={monthData} />}
        {view === 'year' && <YearChart data={yearData} />}

        <div style={{ marginTop: '2rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>Battery SOC</h3>
          <BatterySOCChart data={socData} />
        </div>
      </div>
    </div>
  );
}
