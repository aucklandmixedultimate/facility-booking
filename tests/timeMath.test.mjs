import { test } from "node:test";
import assert from "node:assert/strict";
import { startTimes, DURATION_MINUTES, spansOverlap, fromMinutes, toMinutes, snapMinute, atMost } from "../src/timeMath.js";

test("start times: quarter hours and 20-minute marks", () => {
  const t = startTimes(18, 19).map(h => toMinutes(h) % 60);
  assert.deepEqual(t, [0, 15, 20, 30, 40, 45, 0]);
  assert.equal(startTimes(7, 22).length, 15 * 6 + 1);
});

test("durations: 15- and 20-minute steps to 3 hrs, then long hires", () => {
  assert.deepEqual(DURATION_MINUTES.slice(0, 8), [15, 20, 30, 40, 45, 60, 75, 80]);
  assert.ok(DURATION_MINUTES.includes(160) && DURATION_MINUTES.includes(180) && !DURATION_MINUTES.includes(190));
  assert.deepEqual(DURATION_MINUTES.slice(-5), [210, 240, 300, 360, 480]);
});

test("touching bookings never overlap, whatever the rounding", () => {
  for (let s = 7 * 60; s < 21 * 60; s += 5) for (const d of DURATION_MINUTES) {
    const a = fromMinutes(s), da = d / 60, next = fromMinutes(s + d);
    assert.equal(spansOverlap(a, da, next, 1), false, `${s}+${d}`);
    assert.equal(spansOverlap(next, 1, a, da), false, `${s}+${d} reversed`);
  }
  assert.equal(spansOverlap(fromMinutes(18 * 60 + 20), 1, fromMinutes(19 * 60), 1), true);
});

test("minutes round-trip and atMost", () => {
  assert.equal(fromMinutes(18 * 60 + 20), 18 + 20 / 60);
  assert.equal(toMinutes(fromMinutes(18 * 60 + 20) + 40 / 60), 19 * 60);
  assert.equal(snapMinute(18.999999999999996), 19);
  assert.equal(atMost(fromMinutes(17 * 60 + 10) + 20 / 60, 17.5), true);
});
