import { test } from "node:test";
import assert from "node:assert/strict";
import { currentLeagueSeason, seasonOfBooker } from "../src/seasons.js";

test("NZMUC runs May–November, NZUC December–April", () => {
  assert.equal(currentLeagueSeason(new Date(2026, 4, 1)), "nzmuc");    // 1 May
  assert.equal(currentLeagueSeason(new Date(2026, 10, 30)), "nzmuc");  // 30 Nov
  assert.equal(currentLeagueSeason(new Date(2026, 11, 1)), "nzuc");    // 1 Dec
  assert.equal(currentLeagueSeason(new Date(2027, 3, 30)), "nzuc");    // 30 Apr
});
test("bookers default to NZMUC, Groot to NZUC, admin settings win", () => {
  assert.equal(seasonOfBooker("someone@x.com"), "nzmuc");
  assert.equal(seasonOfBooker("GrootUltimateClub@gmail.com"), "nzuc");
  assert.equal(seasonOfBooker("someone@x.com", { "someone@x.com": "nzuc" }), "nzuc");
  assert.equal(seasonOfBooker("grootultimateclub@gmail.com", { "grootultimateclub@gmail.com": "nzmuc" }), "nzmuc");
});
test("NZU/AU is a booker category but never the current season", () => {
  for (let m = 0; m < 12; m++) assert.notEqual(currentLeagueSeason(new Date(2026, m, 15)), "nzuau");
  assert.equal(seasonOfBooker("uni@x.com", { "uni@x.com": "nzuau" }), "nzuau");
});
