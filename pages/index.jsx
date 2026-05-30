import { useState, useEffect } from 'react';
import {
  BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ComposedChart
} from 'recharts';

const fmtE = (wh) => {
  if (wh >= 1e6) return (wh / 1e6).toFixed(2) + ' MWh';
  if (wh >= 1e3) return (wh / 1e3).toFixed(2) + ' kWh';
  return wh.toFixed(0) + ' Wh';
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
    produced: acc.produced + (d.produced || 0),
    consumed: acc.consumed + (d.consumed || 0)
  }), { produced: 0, consumed: 0 });

  return (
    <div>
      <EnphaseSummaryCard produced={totals.produced} consumed={totals.consumed} imported={0} exported={0} charged={0} discharged={0} />
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
          <Bar dataKey="produced" fill="#60a5fa" stackId="positive" radius={[4, 4, 0, 0]} activeBar={null} />
          <Bar dataKey="consumed" fill="#f97316" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
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
    exported: acc.exported + (d.exported || 0)
  }), { produced: 0, consumed: 0, imported: 0, exported: 0 });

  return (
    <div>
      <EnphaseSummaryCard produced={totals.produced} consumed={totals.consumed} imported={totals.imported} exported={totals.exported} charged={0} discharged={0} />
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
          <Bar dataKey="consumed" fill="#f97316" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
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
    exported: acc.exported + (d.exported || 0)
  }), { produced: 0, consumed: 0, imported: 0, exported: 0 });

  return (
    <div>
      <EnphaseSummaryCard produced={totals.produced} consumed={totals.consumed} imported={totals.imported} exported={totals.exported} charged={0} discharged={0} />
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
          <Bar dataKey="consumed" fill="#f97316" stackId="negative" radius={[4, 4, 0, 0]} activeBar={null} />
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

const INVERTER_SERIALS = ['2426-90190114PH', '2426-90190151PH', '2426-90190186PH', '2426-90190187PH'];

export default function Dashboard() {
  const [view, setView] = useState('day');
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [dayData, setDayData] = useState([]);
  const [monthData, setMonthData] = useState([]);
  const [yearData, setYearData] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        setError(null);

        // Load day data
        const dayPromises = INVERTER_SERIALS.map(sn =>
          fetch('/api/midnite?action=day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sn, date: new Date().toISOString().slice(0, 10) })
          }).then(r => r.json()).catch(e => ({ error: e.message }))
        );
        const dayResults = await Promise.all(dayPromises);
        const dayRecords = dayResults.flatMap(r => r.areaDataList || []).map(d => ({
          time: d.area_time,
          produced: (d.day_electric_produce || 0) * 1000,
          consumed: (d.day_electric_consumption || 0) * 1000
        }));
        setDayData(dayRecords);

        // Load month data
        const monthPromises = INVERTER_SERIALS.map(sn =>
          fetch('/api/midnite?action=month', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sn, date: month })
          }).then(r => r.json()).catch(e => ({ error: e.message }))
        );
        const monthResults = await Promise.all(monthPromises);
        const monthRecords = monthResults.flatMap(r => r.areaDataList || []).map(d => ({
          date: d.area_time,
          produced: (d.month_electric_produce || 0) * 1000,
          consumed: (d.month_electric_consumption || 0) * 1000
        }));
        setMonthData(monthRecords);

        // Load year data
        const yearPromises = INVERTER_SERIALS.map(sn =>
          fetch('/api/midnite?action=year', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sn })
          }).then(r => r.json()).catch(e => ({ error: e.message }))
        );
        const yearResults = await Promise.all(yearPromises);
        const yearRecords = yearResults.flatMap(r => r.areaDataList || []).map(d => ({
          date: d.area_time,
          produced: (d.year_electric_produce || 0) * 1000,
          consumed: (d.year_electric_consumption || 0) * 1000
        }));
        setYearData(yearRecords);
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
          {INVERTER_SERIALS.map(sn => (
            <button key={sn} style={{
              padding: '0.75rem 1rem',
              background: '#1e293b',
              color: '#e2e8f0',
              border: '1px solid #334155',
              borderRadius: '0.5rem',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}>
              {sn}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '2rem', marginBottom: '2rem', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '1.875rem', fontWeight: 'bold' }}>{view === 'day' ? 'Day View' : view === 'month' ? 'Month View' : 'Year View'}</h2>
            <p style={{ margin: '0.25rem 0 0 0', color: '#94a3b8', fontSize: '0.875rem' }}>
              {view === 'day' && 'Today'}
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
          <BatterySOCChart data={[]} />
        </div>
      </div>
    </div>
  );
}
