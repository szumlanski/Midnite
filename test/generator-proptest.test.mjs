import test from "node:test";
import assert from "node:assert/strict";
import { nextValue, summarizeTrials } from "../lib/generator/proptest.js";

test("nextValue avoids current and previous values", () => {
  const v = nextValue(3, [1, 1, 22], 22);
  assert.ok(v >= 1 && v <= 28 && ![1, 22].includes(v));
});

test("summarizeTrials: source x target reach, latency, late, never", () => {
  const sns = ["M", "B", "C"];
  const tr = (source, value, reads, late = {}) => ({ closed: true, source, value, write: { accepted: true }, reads, late, pre: [{ vals: { M: 1, B: 1, C: 1 } }, { vals: { M: 1, B: 1, C: 1 } }] });
  const s = summarizeTrials([
    tr("M", 5, [{ s: 10, vals: { M: 5, B: 1, C: 5 } }, { s: 30, vals: { M: 5, B: 5, C: 5 } }]),
    tr("M", 6, [{ s: 10, vals: { M: 6, B: 5, C: 6 } }], { B: true }),
    tr("M", 7, [{ s: 10, vals: { M: 7, B: 6, C: 7 } }]),
  ], sns);
  const m = s.sources[0];
  assert.equal(m.n, 3); assert.equal(m.acceptedPct, 100);
  const b = m.targets.find(t => t.target === "B");
  assert.deepEqual([b.reached, b.late, b.never, b.medianSec], [1, 1, 1, 30]);
  assert.equal(m.targets.find(t => t.target === "C").pct, 100);
  assert.deepEqual(s.readNoise, { trials: 3, disagreements: 0 });
});
