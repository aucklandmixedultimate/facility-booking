import { test } from "node:test";
import assert from "node:assert/strict";
import { nzHolidayMap, holidayLabel } from "../src/holidays.js";

const h = (date, localName, extra = {}) => ({ date, localName, name: localName, global: true, counties: null, ...extra });

test("weekday holidays stay put; Auckland Anniversary kept, other regions dropped", () => {
  const m = nzHolidayMap([h("2026-10-26", "Labour Day"), h("2026-01-26", "Auckland Anniversary Day", { global: false, counties: ["NZ-AUK", "NZ-NTL"] }),
    h("2026-11-13", "Canterbury Anniversary Day", { global: false, counties: ["NZ-CAN"] })]);
  assert.deepEqual(m["2026-10-26"], { name: "Labour Day", kind: "national", mondayised: false });
  assert.equal(m["2026-01-26"].name, "Auckland Anniversary");
  assert.equal(m["2026-01-26"].kind, "auckland");
  assert.equal(m["2026-11-13"], undefined);
});

test("weekend holidays move to the weekday they're observed (Christmas 2021: Sat/Sun → Mon/Tue)", () => {
  const m = nzHolidayMap([h("2021-12-25", "Christmas Day"), h("2021-12-26", "Boxing Day", { name: "St. Stephen's Day" })]);
  assert.equal(m["2021-12-25"], undefined);
  assert.equal(m["2021-12-26"], undefined);
  assert.equal(holidayLabel(m["2021-12-27"]), "Christmas Day (Mondayised)");
  assert.equal(holidayLabel(m["2021-12-28"]), "Boxing Day (Mondayised)");
});

test("Christmas on a Sunday goes to Tuesday when Boxing Day has the Monday (2022)", () => {
  const m = nzHolidayMap([h("2022-12-25", "Christmas Day"), h("2022-12-26", "Boxing Day")]);
  assert.equal(m["2022-12-26"].name, "Boxing Day");
  assert.equal(m["2022-12-26"].mondayised, false);
  assert.equal(holidayLabel(m["2022-12-27"]), "Christmas Day (Mondayised)");
});

test("New Year on a Sunday: 2 January keeps Monday, New Year's Day goes to Tuesday (2023)", () => {
  const m = nzHolidayMap([h("2023-01-01", "New Year's Day"), h("2023-01-02", "Day after New Year's Day")]);
  assert.equal(m["2023-01-02"].name, "Day after New Year's Day");
  assert.equal(m["2023-01-03"].name, "New Year's Day");
  assert.ok(m["2023-01-03"].mondayised);
});

test("a source that already gives the observed day (or both days) shows it once, Mondayised", () => {
  const observed = nzHolidayMap([h("2027-04-26", "Anzac Day")]);   // 25 April 2027 is a Sunday
  assert.equal(holidayLabel(observed["2027-04-26"]), "Anzac Day (Mondayised)");
  const both = nzHolidayMap([h("2027-04-25", "Anzac Day"), h("2027-04-26", "Anzac Day (observed)")]);
  assert.deepEqual(Object.keys(both), ["2027-04-26"]);
});

test("bad input is ignored", () => {
  assert.deepEqual(nzHolidayMap(null), {});
  assert.deepEqual(nzHolidayMap([{ date: "nope" }, null]), {});
});
