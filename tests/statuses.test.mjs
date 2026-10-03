import { test } from "node:test";
import assert from "node:assert/strict";
import { ST, ALL_STATUSES, WORKFLOW_STEPS, normaliseStatus, isLegacyStatus, isClosed, isLive, isInReview,
  isAmuaReview, isVendorQueued, reachedVendorQueue, stepOf } from "../src/statuses.js";

test("legacy keys normalise to their current names", () => {
  assert.equal(normaliseStatus("pending"), ST.AMUA_REVIEW);
  assert.equal(normaliseStatus("amua_submit"), ST.VENDOR_QUEUED);
  assert.equal(normaliseStatus("approved"), "approved");
  assert.ok(isLegacyStatus("pending") && !isLegacyStatus("pending_amua"));
});

test("legacy keys belong to the same groups as their current names", () => {
  assert.ok(isAmuaReview("pending") && isInReview("pending") && isLive("pending"));
  assert.ok(isVendorQueued("amua_submit") && reachedVendorQueue("amua_submit"));
});

test("groups", () => {
  assert.ok(isClosed("rejected") && isClosed("cancelled") && !isClosed("approved"));
  assert.ok(!isLive("clash") && !isLive("cancelled") && isLive("cpsa_confirmed"));
  assert.ok(!reachedVendorQueue("pending_amua") && reachedVendorQueue("approved"));
  assert.ok(!isInReview("approved") && isInReview("council_pending"));
});

test("every workflow step is a known status, and every workflow ends approved", () => {
  for (const [wf, steps] of Object.entries(WORKFLOW_STEPS)) {
    for (const s of steps) assert.ok(ALL_STATUSES.includes(s), `${wf}: ${s}`);
    assert.equal(steps[0], ST.AMUA_REVIEW); assert.equal(steps.at(-1), ST.APPROVED);
  }
});

test("stepOf", () => {
  assert.deepEqual(stepOf("pending_cpsa", "gtec"), { n: 3, of: 4 });
  assert.deepEqual(stepOf("pending", "gtec"), { n: 1, of: 4 });
  assert.equal(stepOf("council_apply", "gtec"), null);
  assert.equal(stepOf("approved", "nope"), null);
});

test("stepTag gives the step in each workflow of a group", async () => {
  const { stepTag } = await import("../src/statuses.js");
  assert.equal(stepTag("pending_cpsa", ["gtec"]), "3/4");
  assert.equal(stepTag("council_apply", ["council"]), "2/6");
  assert.equal(stepTag("council_apply", ["council", "council_private"]), "2/6 · 3/8");
  assert.equal(stepTag("pending", ["community"]), "1/4");
  assert.equal(stepTag("pending_amua", ["gtec", "council", "council_private"]), "1/…");
  assert.equal(stepTag("approved", ["gtec", "council", "council_private"]), "✓");
  assert.equal(stepTag("cpsa_confirmed", ["gtec"]), "");
});
