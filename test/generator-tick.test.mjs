// Run with: node --test
// Tick cron decisions (pure planTick), run detection, push server and generator alert message (mocks only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planTick, detectRunning, MISSED_MIN } from "../lib/generator/tick.js";
import { computeNextRun } from "../lib/generator/core.js";
import { getVapidKeys, pushToUser, parseSubscription, _resetVapidCache } from "../lib/push/server.js";
import { buildGeneratorMessage, fmtRunDuration } from "../lib/generator/alerts.js";
import { applyControl, SYSTEM_ACTOR } from "../lib/generator/server.js";

const TZ = "America/New_York";
const NOW = new Date("2026-11-11T17:00:00Z"); // 12:00 EST, Wednesday
const base = (over = {}) => ({
  config: { enabled: true, auto_enabled: true, default_start_pct: 20, default_stop_pct: 80, applied_start_pct: 20, applied_stop_pct: 80, observed_running: false, observed_at: "2026-11-11T16:59:00Z", ...over.config },
  windows: over.windows || [], schedules: over.schedules || [],
  live: { ok: true, soc: 50, genW: 0, genV: 0, gridW: 0, gridV: 0, ...over.live },
  wiring: over.wiring || { genLocation: "gen_port", offGrid: true, capacityMode: 0 },
  openRun: over.openRun ?? null, now: over.now || NOW, tz: TZ,
  canWrite: over.canWrite, computeNext: (s, from) => computeNextRun(s, TZ, from),
});
const types = (p) => p.actions.map(a => a.type);

test("detectRunning: gen port uses gen W/V, grid side uses grid only on Off-Grid sites", () => {
  assert.equal(detectRunning({ ok: true, genW: 250 }, { genLocation: "gen_port" }), true);
  assert.equal(detectRunning({ ok: true, genW: 0, genV: 120 }, {}), true);
  assert.equal(detectRunning({ ok: true, genW: 150, genV: 0 }, {}), false);
  assert.equal(detectRunning({ ok: true, genW: null, genV: null }, {}), null);
  assert.equal(detectRunning({ ok: false, genW: 5000 }, {}), null);
  assert.equal(detectRunning({ ok: true, gridV: 240, gridW: 0 }, { genLocation: "grid", offGrid: true }), true);
  assert.equal(detectRunning({ ok: true, gridV: 0, gridW: -300 }, { genLocation: "grid", offGrid: true }), true);
  assert.equal(detectRunning({ ok: true, gridV: 0, gridW: 0, genW: 900 }, { genLocation: "grid", offGrid: true }), false);
  assert.equal(detectRunning({ ok: true, gridV: 240 }, { genLocation: "grid", offGrid: false }), null);
});

test("nothing to do: observe only", () => {
  const p = planTick(base());
  assert.deepEqual(types(p), ["observe"]);
  assert.equal(p.running, false);
});

test("run opens on the running edge with source auto, and alerts", () => {
  const p = planTick(base({ live: { genW: 3000, genV: 240, genHz: 60 } }));
  assert.deepEqual(types(p), ["run_open", "notify", "observe"]);
  assert.equal(p.actions[0].source, "auto");
  assert.equal(p.actions[0].soc, 50);
  assert.deepEqual(p.actions[0].peak, { w: 3000, v: 240, hz: 60 });
  assert.equal(p.actions[1].event, "start");
});

test("run source: schedule fired in the last 10 min beats force; force beats auto", () => {
  const sched = { id: "s1", kind: "oneoff", fired: true, enabled: true, last_run_at: "2026-11-11T16:55:00Z" };
  let p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T18:00:00Z", saved_max_run_min: 0 }, live: { genW: 3000 }, schedules: [sched] }));
  assert.equal(p.actions[0].source, "schedule");
  p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T18:00:00Z", force_max_run_min: 60 }, live: { genW: 3000 }, schedules: [{ ...sched, last_run_at: "2026-11-11T16:40:00Z" }] }));
  assert.equal(p.actions[0].source, "force");
  assert.equal(p.actions[0].cap_min, 60);
});

test("run close is debounced: first not-running tick only observes, second closes at the first time", () => {
  const openRun = { id: "r1", started_at: "2026-11-11T16:00:00Z", source: "auto", peak_w: 3000 };
  let p = planTick(base({ config: { observed_running: true, observed_at: "2026-11-11T16:59:00Z" }, openRun }));
  assert.deepEqual(types(p), ["observe"]);
  p = planTick(base({ config: { observed_running: false, observed_at: "2026-11-11T16:59:00Z" }, openRun }));
  assert.deepEqual(types(p), ["run_close", "notify", "observe"]);
  assert.equal(p.actions[0].ended_at, "2026-11-11T16:59:00.000Z");
  assert.equal(p.actions[0].duration_sec, 59 * 60);
  assert.equal(p.actions[1].event, "stop");
  assert.equal(p.actions[1].durationSec, 59 * 60);
});

test("open run keeps peaks; unknown live state leaves runs alone", () => {
  const openRun = { id: "r1", started_at: "2026-11-11T16:00:00Z", peak_w: 3000, peak_v: 240, peak_hz: 60 };
  let p = planTick(base({ live: { genW: 3500, genV: 239, genHz: 60.2 }, openRun }));
  assert.deepEqual(p.actions[0], { type: "run_update", id: "r1", peak_w: 3500, peak_hz: 60.2 });
  p = planTick(base({ live: { ok: false }, openRun, config: { observed_running: false } }));
  assert.deepEqual(types(p), []);
});

test("forced run past its deadline -> op end (2 writes when 2136 was saved), no thresholds", () => {
  const p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T16:59:00Z", saved_max_run_min: 0, applied_start_pct: 10 }, live: { genW: 3000 }, openRun: { id: "r1", started_at: "2026-11-11T16:00:00Z" } }));
  const c = p.actions.find(a => a.type === "control");
  assert.deepEqual(c, { type: "control", op: "end", reason: "force_deadline", writes: 2 });
  assert.ok(!p.actions.some(a => a.type === "thresholds"));
});

test("forced run at its target % -> op auto; still before deadline and below target -> nothing", () => {
  let p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T18:00:00Z", force_target_pct: 50 }, live: { soc: 51 } }));
  assert.equal(p.actions.find(a => a.type === "control")?.reason, "force_target");
  assert.equal(p.actions.find(a => a.type === "control")?.writes, 1);
  p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T18:00:00Z", force_target_pct: 90, applied_start_pct: 10 }, live: { soc: 51 } }));
  assert.ok(!p.actions.some(a => a.type === "control" || a.type === "thresholds"));
});

test("forced run end waits when there is no write time", () => {
  const p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T16:59:00Z" }, canWrite: { control: false } }));
  assert.ok(!p.actions.some(a => a.type === "control"));
  assert.ok(p.actions.some(a => a.type === "defer" && a.what === "force_end"));
});

test("one-off schedule due -> start with its duration and target, marked fired", () => {
  const s = { id: "s1", kind: "oneoff", enabled: true, fired: false, starts_at: "2026-11-11T16:59:30Z", duration_min: 30, target_pct: 90 };
  const p = planTick(base({ schedules: [s] }));
  const c = p.actions.find(a => a.type === "control");
  assert.deepEqual(c, { type: "control", op: "start", scheduleId: "s1", runMin: 30, targetPct: 90, writes: 2 });
  const m = p.actions.find(a => a.type === "schedule_mark");
  assert.equal(m.fired, true);
  assert.equal(m.skipped, null);
  assert.equal(m.last_run_at, NOW.toISOString());
  // Write budget used: no threshold write in the same tick.
  assert.ok(!p.actions.some(a => a.type === "thresholds"));
});

test("exercise schedule due -> start and next_run_at moves a week on", () => {
  const s = { id: "e1", kind: "exercise", enabled: true, days_mask: 1 << 3, time_local: "12:00", next_run_at: "2026-11-11T17:00:00Z", duration_min: 15, target_pct: null };
  const p = planTick(base({ schedules: [s] }));
  assert.equal(p.actions.find(a => a.type === "control").runMin, 15);
  const m = p.actions.find(a => a.type === "schedule_mark");
  assert.equal(m.next_run_at, "2026-11-18T17:00:00.000Z");
  assert.equal(m.fired, false);
});

test("schedules: run with Automatic off; forced run active or missed -> skipped and marked, no write", () => {
  const s = { id: "s1", kind: "oneoff", enabled: true, fired: false, starts_at: "2026-11-11T16:59:00Z", duration_min: 30 };
  let p = planTick(base({ config: { enabled: false }, schedules: [s] }));
  assert.equal(p.actions.find(a => a.type === "control").op, "start");
  p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T18:00:00Z" }, schedules: [s] }));
  assert.equal(p.actions.find(a => a.type === "schedule_mark").skipped, "force_active");
  p = planTick(base({ schedules: [{ ...s, starts_at: new Date(NOW.getTime() - (MISSED_MIN + 1) * 60000).toISOString() }] }));
  assert.equal(p.actions.find(a => a.type === "schedule_mark").skipped, "missed");
  // Already fired or disabled: ignored.
  p = planTick(base({ schedules: [{ ...s, fired: true }, { ...s, id: "s2", enabled: false }] }));
  assert.ok(!p.actions.some(a => a.type === "schedule_mark"));
});

test("schedule due while a forced run ends this tick: deferred, not marked (fires next tick)", () => {
  const s = { id: "s1", kind: "oneoff", enabled: true, fired: false, starts_at: "2026-11-11T16:59:00Z", duration_min: 30 };
  const p = planTick(base({ config: { force_on: true, force_until: "2026-11-11T16:58:00Z" }, schedules: [s] }));
  assert.equal(p.actions.filter(a => a.type === "control").length, 1);
  assert.ok(!p.actions.some(a => a.type === "schedule_mark"));
  assert.ok(p.actions.some(a => a.type === "defer" && a.what === "schedule"));
});

test("windows -> thresholds write only when the active setpoint changed", () => {
  const w = { id: "w1", start_min: 600, end_min: 840, start_pct: 40, stop_pct: 90, priority: 10, days_mask: 127, enabled: true }; // 10:00-14:00
  let p = planTick(base({ windows: [w] }));
  assert.deepEqual(p.actions.find(a => a.type === "thresholds"), { type: "thresholds", start_pct: 40, stop_pct: 90, from: "window", window_id: "w1", writes: 1 });
  p = planTick(base({ windows: [w], config: { applied_start_pct: 40, applied_stop_pct: 90 } }));
  assert.ok(!p.actions.some(a => a.type === "thresholds"));
  // Outside the window the defaults come back.
  p = planTick(base({ windows: [w], config: { applied_start_pct: 40, applied_stop_pct: 90 }, now: new Date("2026-11-11T21:00:00Z") }));
  assert.deepEqual(p.actions.find(a => a.type === "thresholds")?.start_pct, 20);
});

test("thresholds: not with automatic off, master off, forced run, voltage mode or no write time", () => {
  const cfg = { applied_start_pct: 10 };
  assert.ok(!planTick(base({ config: { ...cfg, auto_enabled: false } })).actions.some(a => a.type === "thresholds"));
  assert.ok(!planTick(base({ config: { ...cfg, enabled: false } })).actions.some(a => a.type === "thresholds"));
  assert.ok(!planTick(base({ config: { ...cfg, force_on: true, force_until: "2026-11-11T18:00:00Z" } })).actions.some(a => a.type === "thresholds"));
  let p = planTick(base({ config: cfg, wiring: { genLocation: "gen_port", capacityMode: 1 } }));
  assert.ok(p.actions.some(a => a.type === "defer" && a.what === "thresholds"));
  p = planTick(base({ config: cfg, canWrite: { thresholds: false } }));
  assert.ok(!p.actions.some(a => a.type === "thresholds"));
  assert.ok(planTick(base({ config: cfg })).actions.some(a => a.type === "thresholds"));
});

test("write budget: never more than 2 writes planned per tick", () => {
  const s = { id: "s1", kind: "oneoff", enabled: true, fired: false, starts_at: "2026-11-11T16:59:00Z", duration_min: 30 };
  const cases = [
    base({ schedules: [s, { ...s, id: "s2" }], config: { applied_start_pct: 1 } }),
    base({ config: { force_on: true, force_until: "2026-11-11T16:00:00Z", saved_max_run_min: 5, applied_start_pct: 1 }, schedules: [s] }),
  ];
  for (const c of cases) {
    const w = planTick(c).actions.reduce((t, a) => t + (a.writes || 0), 0);
    assert.ok(w <= 2, `planned ${w} writes`);
  }
});

// ── Push server (mocked Supabase + web-push) ──
function mockSb(tables = {}) {
  const from = (t) => {
    const q = { op: "select", filters: [], payload: null };
    const rows = () => (tables[t] || []).filter(r => q.filters.every(([k, v]) => r[k] === v));
    function run(many) {
      if (q.op === "insert") {
        if (q.payload.id != null && (tables[t] || []).some(r => r.id === q.payload.id)) return { data: null, error: { message: "duplicate key" } };
        (tables[t] = tables[t] || []).push(q.payload); return { data: q.payload, error: null };
      }
      if (q.op === "update") { const rs = rows(); rs.forEach(r => Object.assign(r, q.payload)); return { data: many ? rs : rs[0] || null, error: null }; }
      if (q.op === "delete") { const gone = rows(); tables[t] = (tables[t] || []).filter(r => !gone.includes(r)); return { data: null, error: null }; }
      const r = rows();
      return { data: many ? r : r[0] || null, error: null };
    }
    const api = {
      select() { return api; }, eq(k, v) { q.filters.push([k, v]); return api; },
      insert(p) { q.op = "insert"; q.payload = p; return api; },
      update(p) { q.op = "update"; q.payload = p; return api; },
      delete() { q.op = "delete"; return api; },
      async maybeSingle() { return run(); }, async single() { return run(); },
      then(res, rej) { return Promise.resolve(run(true)).then(res, rej); },
    };
    return api;
  };
  return { from, tables };
}

test("getVapidKeys: env wins; else generated once and reused; a lost insert race reads the winner", async () => {
  _resetVapidCache();
  let k = await getVapidKeys({ env: { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" } });
  assert.equal(k.publicKey, "pub");
  _resetVapidCache();
  let gens = 0;
  const webpush = { generateVAPIDKeys: () => { gens++; return { publicKey: "P" + gens, privateKey: "K" + gens }; } };
  const sb = mockSb({ vapid_keys: [] });
  k = await getVapidKeys({ env: {}, sb, webpush });
  assert.equal(k.publicKey, "P1");
  _resetVapidCache();
  k = await getVapidKeys({ env: {}, sb, webpush });
  assert.equal(k.publicKey, "P1");
  assert.equal(gens, 1);
  // Race: our first read sees nothing, then another caller writes the row before our insert.
  _resetVapidCache();
  const raced = mockSb({ vapid_keys: [] });
  const realFrom = raced.from;
  let first = true;
  raced.from = (t) => {
    const api = realFrom(t);
    if (t === "vapid_keys" && first) {
      first = false;
      const ms = api.maybeSingle;
      api.maybeSingle = async () => { const r = await ms(); raced.tables.vapid_keys.push({ id: 1, public_key: "WIN", private_key: "WK", subject: "mailto:x" }); return r; };
    }
    return api;
  };
  k = await getVapidKeys({ env: {}, sb: raced, webpush });
  assert.equal(k.publicKey, "WIN");
  _resetVapidCache();
});

test("pushToUser: sends to every device, deletes 404/410, counts other failures", async () => {
  _resetVapidCache();
  const sb = mockSb({
    vapid_keys: [{ id: 1, public_key: "P", private_key: "K", subject: "mailto:x" }],
    push_subscriptions: [
      { id: "a", user_id: "u1", endpoint: "https://push/a", p256dh: "x", auth: "y", failure_count: 0 },
      { id: "b", user_id: "u1", endpoint: "https://push/b", p256dh: "x", auth: "y", failure_count: 2 },
      { id: "c", user_id: "u1", endpoint: "https://push/c", p256dh: "x", auth: "y", failure_count: 0 },
      { id: "d", user_id: "u2", endpoint: "https://push/d", p256dh: "x", auth: "y", failure_count: 0 },
    ],
  });
  const sent = [];
  const webpush = {
    setVapidDetails() {},
    async sendNotification(sub, payload) {
      sent.push(sub.endpoint);
      if (sub.endpoint.endsWith("/b")) { const e = new Error("gone"); e.statusCode = 410; throw e; }
      if (sub.endpoint.endsWith("/c")) { const e = new Error("busy"); e.statusCode = 500; throw e; }
      assert.deepEqual(JSON.parse(payload), { title: "T", body: "B", url: "/x", tag: "t" });
    },
  };
  const r = await pushToUser("u1", { title: "T", body: "B", url: "/x", tag: "t" }, { sb, webpush, env: {} });
  assert.deepEqual(r, { sent: 1, gone: 1, failed: 1, total: 3 });
  assert.equal(sent.length, 3);
  assert.ok(!sb.tables.push_subscriptions.some(s => s.id === "b"));
  assert.equal(sb.tables.push_subscriptions.find(s => s.id === "c").failure_count, 1);
  _resetVapidCache();
});

test("parseSubscription accepts PushSubscription JSON only", () => {
  assert.deepEqual(parseSubscription({ endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "a", auth: "b" } }), { endpoint: "https://fcm.googleapis.com/x", p256dh: "a", auth: "b" });
  assert.equal(parseSubscription({ endpoint: "http://x", keys: { p256dh: "a", auth: "b" } }), null);
  assert.equal(parseSubscription({ endpoint: "https://x" }), null);
  assert.equal(parseSubscription(null), null);
});

test("generator alert message: start/stop wording, no SVG, no long dash", () => {
  const LONG_DASH = String.fromCharCode(0x2014);
  const s = buildGeneratorMessage("OffTheHook", "start", { source: "schedule", socPct: 41.6 });
  assert.equal(s.email.subject, "OffTheHook generator started");
  assert.match(s.email.html, /Scheduled run/);
  assert.match(s.email.html, /42%/);
  assert.equal(s.push.title, "OffTheHook generator started");
  const t = buildGeneratorMessage("OffTheHook", "stop", { durationSec: 3900 });
  assert.match(t.email.text, /Ran for 1 h 5 min/);
  for (const m of [s, t]) {
    assert.ok(!/<svg/i.test(m.email.html));
    assert.ok(!(m.email.html + m.email.text + m.push.body).includes(LONG_DASH));
  }
  assert.equal(fmtRunDuration(30), "1 min");
  assert.equal(fmtRunDuration(7200), "2 h");
});

test("applyControl (shared by the route and the cron): end puts 2156 back to the pre-run AGS, restores 2136, logs a cron event", async () => {
  const sb = mockSb({ gen_config: [{ site_key: "A,B", force_on: true, force_until: "2026-11-11T16:00:00Z", saved_max_run_min: 0, saved_ags: 2, applied_ags: 1 }], gen_events: [] });
  const writes = [];
  const r = await applyControl({
    sb, auth: {}, autoId: "51400", site_key: "A,B", cfg: sb.tables.gen_config[0], op: "end",
    actor: SYSTEM_ACTOR, source: "cron", action: "cron_force_end", extra: { reason: "force_deadline" },
  }, {
    readShadow: async () => ({ "2136": "60", "2156": "1" }),
    writeShadow: async (_a, { writes: w }) => { writes.push(w); return { verified: true, before: {}, after: w }; },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(writes, [{ "2156": 2 }, { "2136": 0 }]);
  const cfg = sb.tables.gen_config[0];
  assert.equal(cfg.force_on, false);
  assert.equal(cfg.saved_max_run_min, null);
  assert.equal(cfg.saved_ags, null);
  assert.equal(cfg.applied_ags, 2);
  const ev = sb.tables.gen_events[0];
  assert.equal(ev.action, "cron_force_end");
  assert.equal(ev.source, "cron");
  assert.equal(ev.actor_role, "system");
  assert.equal(ev.after.reason, "force_deadline");
});

test("applyControl start: saves the original 2136 and 2156 first, no user id for the scheduler", async () => {
  const sb = mockSb({ gen_config: [{ site_key: "A", saved_max_run_min: null, saved_ags: null }], gen_events: [] });
  const writes = [];
  const r = await applyControl({ sb, auth: {}, autoId: "1", site_key: "A", cfg: { ...sb.tables.gen_config[0] }, op: "start", runMin: 30, targetPct: 90, actor: SYSTEM_ACTOR, source: "cron", startedBy: null }, {
    readShadow: async () => ({ "2136": "0", "2156": "0" }),
    writeShadow: async (_a, { writes: w }) => { writes.push(w); return { verified: true }; },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(writes, [{ "2136": 30 }, { "2156": 1 }]);
  const cfg = sb.tables.gen_config[0];
  assert.equal(cfg.saved_max_run_min, 0);
  assert.equal(cfg.saved_ags, 0);
  assert.equal(cfg.force_on, true);
  assert.equal(cfg.force_target_pct, 90);
  assert.equal(cfg.force_started_by, null);
});

test("applyControl start refuses when 2156 can't be read (nothing written)", async () => {
  const sb = mockSb({ gen_config: [{ site_key: "A" }], gen_events: [] });
  let wrote = 0;
  const r = await applyControl({ sb, auth: {}, autoId: "1", site_key: "A", cfg: { site_key: "A" }, op: "start", runMin: 30, actor: SYSTEM_ACTOR, source: "cron" }, {
    readShadow: async () => ({ "2136": "0" }),
    writeShadow: async () => { wrote++; return { verified: true }; },
  });
  assert.equal(r.status, 502);
  assert.equal(wrote, 0);
});

import { agsForAutomatic, automaticFromAgs } from "../lib/generator/control.js";
test("Automatic switch <-> AGS: on = Auto (0), off = Off (2); On (1) shows as not automatic", () => {
  assert.equal(agsForAutomatic(true), 0);
  assert.equal(agsForAutomatic(false), 2);
  assert.equal(automaticFromAgs(0), true);
  assert.equal(automaticFromAgs("2"), false);
  assert.equal(automaticFromAgs(1), false);
  assert.equal(automaticFromAgs(null), null);
});

test("applyControl start: accepted but unconfirmed writes are pending, the run is still tracked (labeled Run now)", async () => {
  const sb = mockSb({ gen_config: [{ site_key: "A", saved_max_run_min: null, saved_ags: null }], gen_events: [] });
  const writes = [];
  const r = await applyControl({ sb, auth: {}, autoId: "1", site_key: "A", cfg: { ...sb.tables.gen_config[0] }, op: "start", runMin: 2, actor: SYSTEM_ACTOR, source: "user", startedBy: "u1" }, {
    readShadow: async () => ({ "2136": "0", "2156": "0" }),
    writeShadow: async (_a, { writes: w }) => { writes.push(w); return { verified: false, write: { RequestId: "x" }, err: "no confirmation" }; },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.pending, true);
  assert.deepEqual(writes, [{ "2136": 2 }, { "2156": 1 }]);
  assert.equal(sb.tables.gen_config[0].force_on, true);
});

test("applyControl start: a refused write fails, and a user start puts 2136 back", async () => {
  const sb = mockSb({ gen_config: [{ site_key: "A", saved_max_run_min: null, saved_ags: null }], gen_events: [] });
  const writes = [];
  const r = await applyControl({ sb, auth: {}, autoId: "1", site_key: "A", cfg: { ...sb.tables.gen_config[0] }, op: "start", runMin: 2, actor: SYSTEM_ACTOR, source: "user" }, {
    readShadow: async () => ({ "2136": "0", "2156": "0" }),
    writeShadow: async (_a, { writes: w }) => { writes.push(w); return { verified: false, err: "the inverter did not accept the write" }; },
  });
  assert.equal(r.status, 502);
  assert.deepEqual(writes, [{ "2136": 2 }, { "2136": 0 }]);
  assert.notEqual(sb.tables.gen_config[0].force_on, true);
});

import { writeAll, siteAutoIds } from "../lib/generator/server.js";
test("writeAll: one write to every inverter; verified only when all are; siteAutoIds puts the master first", async () => {
  const calls = [];
  const w = async (_a, { autoId, writes }) => { calls.push([autoId, writes]); return autoId === "3" ? { verified: false, write: { RequestId: "r3" }, err: "slow" } : { verified: true, write: { RequestId: "r" + autoId }, after: writes }; };
  const r = await writeAll(w, {}, ["1", "2", "3"], { "2156": 1 });
  assert.equal(calls.length, 3);
  assert.equal(r.verified, false);
  assert.ok(r.write?.RequestId); // all accepted -> pending, not refused
  const ids = siteAutoIds({ site_key: "A,B,C", master_sn: "B" }, { GoodsID: [{ GoodsID: "A", AutoID: 1 }, { GoodsID: "B", AutoID: 2 }, { GoodsID: "C", AutoID: 3 }] });
  assert.deepEqual(ids, ["2", "1", "3"]);
  assert.throws(() => siteAutoIds({ site_key: "A,B", master_sn: "A" }, { GoodsID: [{ GoodsID: "A", AutoID: 1 }] }), /B not found/);
});
