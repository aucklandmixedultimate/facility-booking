import { test } from "node:test";
import assert from "node:assert/strict";
import { CASUAL_MAX, councilBookingType, financialYear, participantText, seasonalAppsOpen } from "../src/councilBooking.js";

test("financial year runs 1 July – 30 June", () => {
  assert.equal(financialYear("2026-07-01"), 2026);
  assert.equal(financialYear("2026-06-30"), 2025);
  assert.equal(financialYear("2027-03-15"), 2026);
});

test("seasonal applications are open during an *_apps phase", () => {
  assert.equal(seasonalAppsOpen([{ key: "summer_apps" }]), true);
  assert.equal(seasonalAppsOpen([{ key: "summer_casual" }, { key: "summer_season" }]), false);
  assert.equal(seasonalAppsOpen([]), false);
});

const bk = (id, date, email = "a@x.com") => ({ id, date, email });

test("while seasonal applications are open, everything is seasonal", () => {
  assert.equal(councilBookingType(bk("1", "2026-10-20"), [], { appsOpen: true }), "seasonal");
});

test("otherwise: fewer than 10 bookings in the financial year is casual", () => {
  const nine = Array.from({ length: CASUAL_MAX - 1 }, (_, i) => bk("b" + i, `2026-10-${String(i + 1).padStart(2, "0")}`));
  assert.equal(councilBookingType(nine[0], nine), "casual");
  const ten = [...nine, bk("b9", "2027-02-01")];
  assert.equal(councilBookingType(ten[0], ten), "seasonal");
  // Another financial year's bookings and another booker's don't count.
  const mixed = [...nine, bk("x1", "2026-05-01"), bk("y1", "2026-10-30", "b@x.com")];
  assert.equal(councilBookingType(nine[0], mixed), "casual");
  // The booking itself counts once even when it's also in the list.
  assert.equal(councilBookingType(bk("new", "2026-11-01"), nine), "seasonal");
});

test("aliases fold onto one booker", () => {
  const canon = e => ({ "alt@x.com": "a@x.com" })[e] || e;
  const list = Array.from({ length: 10 }, (_, i) => bk("b" + i, "2026-10-01", i % 2 ? "alt@x.com" : "a@x.com"));
  assert.equal(councilBookingType(list[0], list, { canon }), "seasonal");
});

test("participant line", () => {
  assert.equal(participantText({ level: "junior", grade: "high", teams: 1, players: 25, teamNames: "Matchbox" }),
    "Junior (high school) mixed ultimate frisbee: 1 team, 25 players. Teams: Matchbox.");
  assert.equal(participantText({ level: "senior" }, 14), "Senior mixed ultimate frisbee: 14 players.");
  assert.equal(participantText({}, null), "Senior mixed ultimate frisbee.");
  assert.equal(participantText({ level: "junior", teams: 2, players: 30 }), "Junior mixed ultimate frisbee: 2 teams, 30 players.");
});
