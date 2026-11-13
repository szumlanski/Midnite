// ─────────────────────────────────────────────────────────────────────────────
// Parallel-settings propagation test: PURE helpers (Jason, 2026-11-13). Writes the inert exercise "run date" (2153,
// only used when the exercise cycle 2151 is on; it is off at OffTheHook) to ONE inverter at a time, rotating the
// source, then reads it on every inverter at ~10 s, 30 s, 45 s, 75 s and 120 s to see whether and when it reached
// the others. Results feed a source x target table. State lives in gen_events rows (prop_run / prop_trial).
// ─────────────────────────────────────────────────────────────────────────────

export const TEST_CODE = "2153";
export const TRIAL_SEC = 110;          // a trial is closed after its read at about 2 minutes
export const RUN_HOURS_DEFAULT = 8;

// A value 1..28 that differs from every value now on the inverters and from the last trial's value.
export function nextValue(n, current = [], prev = null) {
  const taken = new Set([...current, prev].filter(v => v != null).map(Number));
  for (let k = 0; k < 28; k++) { const v = ((n * 7 + k) % 28) + 1; if (!taken.has(v)) return v; }
  return 1;
}

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// trials: prop_trial `after` objects { source, value, write:{accepted, verified}, reads:[{s, vals:{sn:v}}], late:{sn:true},
// pre:[{vals},{vals}], gen_running }. sns: serials (master first). Returns per source: n, write accepted %, and per
// target: reached by 2 min (count / %), median seconds, late (after 2 min, seen at the next trial), never.
export function summarizeTrials(trials = [], sns = [], { filter = null } = {}) {
  const rows = {};
  let noise = 0, noiseN = 0;
  for (const sn of sns) rows[sn] = { source: sn, n: 0, accepted: 0, targets: Object.fromEntries(sns.map(t => [t, { reached: 0, late: 0, never: 0, secs: [] }])) };
  for (const tr of trials) {
    if (!tr?.closed || !rows[tr.source] || (filter && !filter(tr))) continue;
    const r = rows[tr.source]; r.n++;
    if (tr.write?.accepted || tr.write?.verified) r.accepted++;
    for (const t of sns) {
      const hit = (tr.reads || []).find(x => Number(x?.vals?.[t]) === Number(tr.value));
      const cell = r.targets[t];
      if (hit) { cell.reached++; cell.secs.push(hit.s); } else if (tr.late?.[t]) cell.late++; else cell.never++;
    }
    if (tr.pre?.length >= 2) { noiseN++; if (sns.some(t => tr.pre[0]?.vals?.[t] !== tr.pre[1]?.vals?.[t])) noise++; }
  }
  const out = sns.map(sn => {
    const r = rows[sn];
    return {
      source: sn, n: r.n, acceptedPct: r.n ? Math.round(100 * r.accepted / r.n) : null,
      targets: sns.map(t => { const c = r.targets[t]; return { target: t, reached: c.reached, late: c.late, never: c.never, pct: r.n ? Math.round(100 * c.reached / r.n) : null, medianSec: median(c.secs) }; }),
    };
  });
  return { sources: out, readNoise: { trials: noiseN, disagreements: noise } };
}
