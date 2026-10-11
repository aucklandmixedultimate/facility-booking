import { test } from "node:test";
import assert from "node:assert/strict";
import { suitScore, suitWord, ownerType, parkWorkflow, opVenues, venueFieldEntries, topRatedVenues, fieldEntryId } from "../src/venues.js";

test("suitScore: unrated, unusable, bonuses and clamp", () => {
  assert.equal(suitScore(null), null);
  assert.equal(suitScore({ decision: "rating" }), null);
  assert.equal(suitScore({ decision: "yes", fit: "no", quality: 5 }), 0);
  assert.equal(suitScore({ decision: "yes" }), 0.5);                         // no quality → 0.5
  assert.equal(suitScore({ decision: "yes", fit: "full" }, 4), 0.9);        // 0.8 + 0.1
  assert.equal(suitScore({ decision: "top", fit: "multi", lights: "full" }, 5), 1); // clamped
  assert.ok(Math.abs(suitScore({ decision: "yes", fit: "reduced" }, 1) - 0.05) < 1e-9); // 0.2 − 0.15 → floor
  assert.equal(suitWord(0.9), "Excellent");
  assert.equal(suitWord(null), "Not rated");
});

const club = { id: "c1", operator: "Club One", code: "rugby", type: "club" };
const ultimate = { id: "u1", operator: "Ultimate Club", code: "ultimate", type: "club" };
const school = { id: "s1", operator: "A School", park: "A School", type: "school", category: "community", ownership: "private", lat: -36.9, lon: 174.8 };
const trust = { id: "t1", operator: "A Trust", park: "Trust Park", type: "trust", lat: -36.8, lon: 174.7 };

test("ownerType: council, club-run, school, private ground", () => {
  assert.equal(ownerType({ id: "p" }, []), "council");
  assert.equal(ownerType({ id: "p" }, [ultimate]), "council");      // an ultimate club only plays there
  assert.equal(ownerType({ id: "p" }, [club]), "club_council");
  assert.equal(ownerType({ id: "op-s1", venue: school }, [school]), "school");
  assert.equal(ownerType({ id: "op-t1", venue: trust }, [trust]), "private_ground");
});

test("parkWorkflow: vendor ids", () => {
  assert.equal(parkWorkflow({ id: "p" }, []).provider, "akl_council");
  assert.equal(parkWorkflow({ id: "p" }, [club]).provider, "op_c1");
  assert.equal(parkWorkflow({ id: "op-s1", venue: school }, [school]).provider, "cm_s1");
});

test("opVenues: private venues off the council map, in the nearest park's region", () => {
  const parks = [{ id: "a", region: "North", lat: -36.7, lon: 174.7 }, { id: "b", region: "Central", lat: -36.9, lon: 174.8 }];
  const v = opVenues([school, trust, { ...club, park_id: "a", lat: -36.7, lon: 174.7 }], parks);
  assert.deepEqual(v.map(x => [x.id, x.region]), [["op-s1", "Central"], ["op-t1", "North"]]);
});

test("venueFieldEntries: saved groups, else the whole park", () => {
  const p = { id: "p1", name: "Park One", region: "Central", lat: 1, lon: 2 };
  assert.deepEqual(venueFieldEntries(p, null).map(e => [e.id, e.field, e.kind]), [[fieldEntryId(p, "Whole park"), "Whole park", "council"]]);
  const r = { placement: { groups: [{ key: "Field 1", name: "Field 1", council: ["1"], cap: 1, fit: "full", c: [3, 4] }] } };
  assert.deepEqual(venueFieldEntries(p, r).map(e => [e.id, e.lat]), [["cf-p1--field-1", 3]]);
});

test("topRatedVenues: best first, unrated and unusable left out, capped", () => {
  const ps = ["a", "b", "c", "d"].map(id => ({ id, name: id.toUpperCase() }));
  const reviews = { a: { decision: "yes", quality: 3 }, b: { decision: "top", quality: 5 }, c: { decision: "yes", fit: "no" } };
  const top = topRatedVenues(ps, reviews, { a: 4 }, () => [], 2);
  assert.deepEqual(top.map(x => x.park.id), ["b", "a"]);
});
