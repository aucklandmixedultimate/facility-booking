import { test } from "node:test";
import assert from "node:assert/strict";
import { shortName, personFromEmail, initialsOf } from "../src/people.js";

test("shortName keeps first name and last initial only", () => {
  assert.equal(shortName("Clare Gibson"), "Clare G.");
  assert.equal(shortName("rory hughes"), "rory H.");
  assert.equal(shortName("Mary Jane Smith"), "Mary S.");
  assert.equal(shortName("Rory"), "Rory");
  assert.equal(shortName("  "), "");
});
test("personFromEmail turns an address into a short name", () => {
  assert.equal(personFromEmail("rory.hughes@example.com"), "Rory H.");
  assert.equal(personFromEmail("auultimateclub@gmail.com"), "Auultimateclub");
  assert.equal(personFromEmail(""), "Someone");
});
test("initialsOf gives two letters", () => {
  assert.equal(initialsOf("pirates.team"), "PT");
  assert.equal(initialsOf("auultimateclub"), "AU");
  assert.equal(initialsOf("Auckland Uni Ultimate"), "AU");
  assert.equal(initialsOf(""), "?");
});
