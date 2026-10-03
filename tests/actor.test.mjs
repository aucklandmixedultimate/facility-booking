import { test } from "node:test";
import assert from "node:assert/strict";
import { actorName } from "../src/actor.js";

test("actorName needs a first name and a last initial", () => {
  assert.equal(actorName("rory", "h"), "Rory H.");
  assert.equal(actorName("  sam  taylor", "T"), "Sam T.");
  assert.equal(actorName("Alex", ""), "");
  assert.equal(actorName("", "B"), "");
  assert.equal(actorName("Jo", "1"), "");
});
