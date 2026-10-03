import { test } from "node:test";
import assert from "node:assert/strict";
import { councilState, allPhases } from "../src/councilSeasons.js";

test("council phases are in order and don't overlap", () => {
  const ps = allPhases();
  assert.ok(ps.length > 0);
  for (let i = 1; i < ps.length; i++) assert.ok(ps[i].from >= ps[i - 1].from, "phases sorted by start");
});
test("councilState names a map season", () => {
  const st = councilState(new Date(2026, 9, 3));
  assert.ok(["summer", "winter"].includes(st.mapSeason));
  assert.ok(Array.isArray(st.now) && Array.isArray(st.next));
});
