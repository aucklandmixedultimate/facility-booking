import { test } from "node:test";
import assert from "node:assert/strict";
import { daylightMoves, isWeekend } from "../src/fieldPrefs.js";

const CUT = 17.5;
// 2026-10-31 is a Saturday, 2026-11-01 a Sunday, 2026-11-02 a Monday.
const d = (id, facility_id, date, start_hour, duration = 2) => ({ id, facility_id, date, start_hour, duration });

test("isWeekend", () => {
  assert.equal(isWeekend("2026-10-31"), true);
  assert.equal(isWeekend("2026-11-01"), true);
  assert.equal(isWeekend("2026-11-02"), false);
});

test("weekend daylight bookings on Field #1 or #2 move when Field #3 is free", () => {
  assert.deepEqual(daylightMoves([d("a", "f3", "2026-10-31", 10), d("b", "f4", "2026-11-01", 14)], [], CUT), ["a", "b"]);
});

test("weekdays, evenings, Field #3 itself and other facilities stay", () => {
  const drafts = [
    d("wk", "f3", "2026-11-02", 10),          // Monday
    d("eve", "f3", "2026-10-31", 18),         // evening
    d("span", "f4", "2026-10-31", 16.5, 2),   // runs past 5:30pm: needs the evening field
    d("edge", "f4", "2026-10-31", 15.5, 2),   // ends exactly at 5:30pm: daylight
    d("three", "f5", "2026-11-01", 9),
    d("room", "f1", "2026-10-31", 10),
  ];
  assert.deepEqual(daylightMoves(drafts, [], CUT), ["edge"]);
});

test("Field #3 taken by a booking or vendor block: no move; a closed booking doesn't count", () => {
  const bookings = [
    { ...d("gtec", "f5", "2026-10-31", 9, 3), status: "approved", email: "admin" },
    { ...d("old", "f5", "2026-11-01", 9, 3), status: "cancelled" },
  ];
  assert.deepEqual(daylightMoves([d("a", "f3", "2026-10-31", 11), d("b", "f3", "2026-11-01", 10)], bookings, CUT), ["b"]);
});

test("drafts in one batch can't both take Field #3 at the same time", () => {
  const drafts = [d("a", "f3", "2026-10-31", 10), d("b", "f4", "2026-10-31", 11), d("c", "f4", "2026-10-31", 13)];
  assert.deepEqual(daylightMoves(drafts, [], CUT), ["a", "c"]);
  // A draft already on Field #3 holds it too.
  assert.deepEqual(daylightMoves([d("x", "f5", "2026-10-31", 10), d("a", "f3", "2026-10-31", 11)], [], CUT), []);
});

test("an edit doesn't clash with the booking it replaces", () => {
  const bookings = [{ ...d("a", "f5", "2026-10-31", 10), status: "pending_amua" }];
  assert.deepEqual(daylightMoves([d("a", "f3", "2026-10-31", 10)], bookings, CUT), ["a"]);
});
