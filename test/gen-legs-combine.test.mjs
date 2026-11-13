import test from "node:test";
import assert from "node:assert/strict";
import { combineGenLegs } from "../lib/midniteServer.js";

test("combineGenLegs: V/Hz from master, A/W summed", () => {
  const m = { l1: { v: 116.7, a: 37.6, w: 4281 }, l2: { v: 116.8, a: 36.9, w: 4224 }, hz: 60.1, at: "t" };
  const s1 = { l1: { v: 117.5, a: 38, w: 4300 }, l2: { v: 117, a: 37, w: 4250 }, hz: 60.0 };
  const r = combineGenLegs([m, s1, null]);
  assert.equal(r.count, 2);
  assert.equal(r.l1.v, 116.7); assert.equal(r.hz, 60.1);
  assert.equal(r.l1.w, 8581); assert.ok(Math.abs(r.l2.a - 73.9) < 1e-9);
});
test("combineGenLegs: nothing answered", () => { assert.equal(combineGenLegs([null, null]), null); });
