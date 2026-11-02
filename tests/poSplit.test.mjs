import { test } from "node:test";
import assert from "node:assert/strict";
import { poBookers, normaliseSelection, selectionCovers, componentSuffix, buildComponent, claimed } from "../src/poSplit.js";

// A saved GTEC PO the way summary.jsx builds it (GST inclusive: line costs are pre-GST,
// itemised costs include GST).
const invoices = [
  { id: "I261111ROR02", bookerName: "Rory Holmes", bookerEmail: "rory@x.nz", bookingIds: ["b1", "b2"] },
  { id: "I261111MAT02", bookerName: "Matchbox", bookerEmail: "mb@x.nz", bookingIds: ["b3"] },
  { id: "I261111EUP02", bookerName: "Euphoria", bookerEmail: "eu@x.nz", bookingIds: ["b4"] },
];
const po = {
  id: "P261111GTE02", type: "purchase_order", gstMode: "inclusive", bookingIds: ["b1", "b2", "b3", "b4"],
  lines: [
    { desc: "Rory Holmes · I261111ROR02", detail: "I261111ROR02", hours: 3, cost: 100 },
    { desc: "Matchbox · I261111MAT02", detail: "I261111MAT02", hours: 2, cost: 40 },
    { desc: "Euphoria · I261111EUP02", detail: "I261111EUP02", hours: 1, cost: 20 },
  ],
  individualLines: [
    { desc: "Rory Holmes · Field #1 · 6:00 PM–8:00 PM", date: "2026-11-03", hours: 2, cost: 76.67 },
    { desc: "Rory Holmes · Field #2 · 6:00 PM–7:00 PM", date: "2026-11-10", hours: 1, cost: 38.33 },
    { desc: "Matchbox · Field #3 · 6:00 PM–8:00 PM", date: "2026-11-04", hours: 2, cost: 46 },
    { desc: "Euphoria · Field #3 · 8:00 PM–9:00 PM", date: "2026-11-04", hours: 1, cost: 23 },
  ],
  subtotal: 160, gst: 24, total: 184,
};
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

test("poBookers: one per PO line, with their itemised bookings", () => {
  const bs = poBookers(po, invoices);
  assert.deepEqual(bs.map(b => [b.key, b.name, b.items.map(i => i.key)]), [
    ["I261111ROR02", "Rory Holmes", ["i0", "i1"]], ["I261111MAT02", "Matchbox", ["i2"]], ["I261111EUP02", "Euphoria", ["i3"]]]);
});

test("poBookers: old records (no detail, no invoices, no itemised lines) still split by booker", () => {
  const old = { ...po, lines: po.lines.map(l => ({ desc: l.desc, hours: l.hours, cost: l.cost })), individualLines: undefined };
  const bs = poBookers(old, []);
  assert.deepEqual(bs.map(b => [b.key, b.name, b.items.length]), [["I261111ROR02", "Rory Holmes", 0], ["I261111MAT02", "Matchbox", 0], ["I261111EUP02", "Euphoria", 0]]);
  const c = buildComponent(old, bs, { "I261111MAT02": true }, { invoices: [] });
  assert.equal(c.id, "P261111GTE02-MATCHBOX"); near(c.subtotal, 40); near(c.total, 46);
});

test("normaliseSelection / selectionCovers", () => {
  const bs = poBookers(po, invoices);
  assert.deepEqual(normaliseSelection(bs, { "I261111ROR02": ["i0", "i1"], "I261111MAT02": [], x: true }), { "I261111ROR02": true });
  assert.equal(selectionCovers(bs, normaliseSelection(bs, { "I261111ROR02": true, "I261111MAT02": true, "I261111EUP02": ["i3"] })), true);
});

test("componentSuffix: booker name, OTHER, then letters; taken suffixes get a number", () => {
  const bs = poBookers(po, invoices);
  assert.equal(componentSuffix(bs, { "I261111ROR02": true }), "RORY");
  assert.equal(componentSuffix(bs, { "I261111ROR02": ["i0"] }), "RORY");
  assert.equal(componentSuffix(bs, { "I261111ROR02": true }, ["RORY"]), "RORY2");
  // The booking site names the booker by their alias.
  const alias = b => ({ "rory@x.nz": "Rorz Crew" })[b.bookerEmail] || b.name;
  assert.equal(componentSuffix(bs, { "I261111ROR02": true }, [], alias), "RORZ");
  assert.equal(buildComponent(po, bs, { "I261111ROR02": true }, { invoices, nameOf: alias }).id, "P261111GTE02-RORZ");
  assert.equal(componentSuffix(bs, { "I261111MAT02": true, "I261111EUP02": true }), "OTHER");
  assert.equal(componentSuffix(bs, { "I261111MAT02": true, "I261111EUP02": ["i3"], "I261111ROR02": ["i0"] }), "A");
  assert.equal(componentSuffix(bs, { "I261111MAT02": true, "I261111EUP02": true }, ["OTHER"]), "OTHER2");
});

test("buildComponent: whole bookers keep the PO's figures; part of one is summed from its bookings", () => {
  const bs = poBookers(po, invoices);
  const whole = buildComponent(po, bs, { "I261111ROR02": true }, { invoices });
  assert.equal(whole.id, "P261111GTE02-RORY"); assert.equal(whole.parentPoId, po.id);
  near(whole.subtotal, 100); near(whole.gst, 15); near(whole.total, 115);
  assert.deepEqual(whole.bookingIds, ["b1", "b2"]); assert.deepEqual(whole.linkedInvoiceIds, ["I261111ROR02"]);
  assert.equal(whole.individualLines.length, 2); assert.equal(whole.status, "draft");

  const part = buildComponent(po, bs, { "I261111ROR02": ["i1"], "I261111EUP02": true }, { invoices, components: [whole] });
  near(part.subtotal, 38.33 / 1.15 + 20);
  assert.match(part.lines[0].desc, /1 of 2 bookings/);
  assert.equal(part.id, "P261111GTE02-A");
  // The same selection again returns the saved component, not a new one.
  assert.equal(buildComponent(po, bs, { "I261111ROR02": true }, { invoices, components: [whole, part] }), whole);
});

test("claimed: bookings already in a component", () => {
  const bs = poBookers(po, invoices);
  const a = buildComponent(po, bs, { "I261111ROR02": ["i0"] }, { invoices });
  assert.deepEqual(claimed(po, [a], bs), { i0: a.id });
});
