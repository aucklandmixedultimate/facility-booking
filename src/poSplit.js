// Splitting a saved vendor purchase order (GTEC) into component POs, so the vendor can be
// asked to invoice parts of it separately. Pure module (no React), unit-tested.
//
// A PO record (summary.jsx buildProviderPoRecords) has:
//   lines            one per booker: { desc: "<name> · <invoice id>", detail: <invoice id>, hours, cost }
//                    where cost is the booker's pre-GST amount
//   individualLines  one per booking: { desc: "<booker name> · <facility> · <time>", date, cost, … }
//                    where cost is on the invoice's own basis (gstMode)
//   linkedInvoiceIds, bookingIds, gstMode
// Records saved before linkedInvoiceIds existed still split: the invoice id comes from the
// line's detail, or the end of its description.

const GST = 0.15;
// Pre-GST amount of a raw line total, on the PO's GST basis (as summary.jsx gstAmounts).
export const preOf = (raw, gstMode) => gstMode === "exclusive" ? raw : raw / (1 + GST);
export const totalsOf = pre => ({ subtotal: pre, gst: pre * GST, total: pre * (1 + GST) });

const lineInvoiceId = l => (l.detail || "").trim() || ((l.desc || "").match(/·\s*(\S+)\s*$/) || [])[1] || "";
const lineName = l => (l.desc || "").replace(/\s*·\s*\S+\s*$/, "").trim();

// The PO's bookers: [{ key, name, invoiceId, bookerEmail, line, lineIndex, items: [{ key, line }] }].
// Item keys are positions in po.individualLines ("i3"), stable for the saved record.
export function poBookers(po, invoices = []) {
  const items = (po.individualLines || []).map((line, i) => ({ key: `i${i}`, line }));
  const used = new Set();
  return (po.lines || []).map((line, lineIndex) => {
    const invoiceId = lineInvoiceId(line);
    const inv = invoices.find(r => r.id === invoiceId);
    const name = inv?.bookerName || lineName(line) || invoiceId || `Booker ${lineIndex + 1}`;
    const prefix = `${name} · `;
    const mine = items.filter(it => !used.has(it.key) && (it.line.desc || "").startsWith(prefix));
    mine.forEach(it => used.add(it.key));
    return { key: invoiceId || `b${lineIndex}`, name, invoiceId, bookerEmail: inv?.bookerEmail || "", line, lineIndex, items: mine };
  });
}

// A selection is { [bookerKey]: true (the whole booker) | [itemKey, …] (some bookings) }.
// Normalises it against the bookers: an item list covering every item becomes true; empty → dropped.
export function normaliseSelection(bookers, sel = {}) {
  const out = {};
  for (const b of bookers) {
    const s = sel[b.key];
    if (s === true) out[b.key] = true;
    else if (Array.isArray(s)) {
      const keys = b.items.map(i => i.key).filter(k => s.includes(k));
      if (keys.length && keys.length === b.items.length) out[b.key] = true;
      else if (keys.length) out[b.key] = keys;
    }
  }
  return out;
}
export const selectionCovers = (bookers, sel) => bookers.length > 0 && bookers.every(b => sel[b.key] === true);
export const selectionEmpty = sel => Object.keys(sel).length === 0;
const sameSelection = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());

// The suffix a component carries after the PO number: the booker's name when it's one
// booker, OTHER when it's every booker but one, otherwise the next free letter (A, B, …).
// A suffix already used by another component gets a number (RORY2).
export function componentSuffix(bookers, sel, taken = []) {
  const keys = Object.keys(sel);
  const free = s => { if (!taken.includes(s)) return s; for (let n = 2; ; n++) if (!taken.includes(`${s}${n}`)) return `${s}${n}`; };
  if (keys.length === 1) {
    const b = bookers.find(x => x.key === keys[0]);
    const slug = (b?.name || "").split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    if (slug) return free(slug);
  }
  if (bookers.length > 2 && keys.length === bookers.length - 1 && keys.every(k => sel[k] === true)) return free("OTHER");
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") if (!taken.includes(ch)) return ch;
  return free("Z");
}

// Items (bookings) already in a saved component of this PO: { itemKey: componentId }, and
// whole bookers with no itemised lines: { bookerKey: componentId }.
export function claimed(po, components, bookers) {
  const out = {};
  for (const c of components) {
    for (const [bk, s] of Object.entries(c.splitSelection || {})) {
      const b = bookers.find(x => x.key === bk); if (!b) continue;
      if (s === true) { if (b.items.length) b.items.forEach(i => { out[i.key] = c.id; }); else out[bk] = c.id; }
      else s.forEach(k => { out[k] = c.id; });
    }
  }
  return out;
}

// The component PO record for a selection (or the saved one for the same selection).
export function buildComponent(po, bookers, sel, { components = [], invoices = [], now = new Date().toISOString() } = {}) {
  const existing = components.find(c => sameSelection(c.splitSelection, sel));
  if (existing) return existing;
  const lines = [], individualLines = [], linkedInvoiceIds = [], bookingIds = [];
  let pre = 0;
  for (const b of bookers) {
    const s = sel[b.key]; if (!s) continue;
    const picked = s === true ? b.items : b.items.filter(i => s.includes(i.key));
    // A whole booker keeps the PO's own figure for them; part of one is summed from its bookings.
    const bPre = s === true ? (b.line.cost || 0) : preOf(picked.reduce((t, i) => t + (i.line.cost || 0), 0), po.gstMode);
    pre += bPre;
    const hours = s === true ? b.line.hours : picked.reduce((t, i) => t + (i.line.hours || 0), 0) || null;
    lines.push({ ...b.line, cost: bPre, hours,
      ...(s === true ? {} : { desc: `${b.name}${b.invoiceId ? ` · ${b.invoiceId}` : ""} (${picked.length} of ${b.items.length} bookings)` }) });
    individualLines.push(...picked.map(i => i.line));
    if (b.invoiceId) linkedInvoiceIds.push(b.invoiceId);
    // Bookings are known per invoice, so a whole booker carries theirs; part of one doesn't.
    const inv = invoices.find(r => r.id === b.invoiceId);
    if (s === true && inv) bookingIds.push(...(inv.bookingIds || []).filter(id => (po.bookingIds || []).includes(id)));
  }
  const suffix = componentSuffix(bookers, sel, components.map(c => c.splitSuffix));
  const id = `${po.id}-${suffix}`;
  return {
    ...po, id, bankRef: id, parentPoId: po.id, splitSuffix: suffix, splitSelection: sel,
    splitBookers: bookers.filter(b => sel[b.key]).map(b => b.name),
    lines, individualLines, linkedInvoiceIds, bookingIds, ...totalsOf(pre),
    createdAt: now, status: "draft", gtecInvoiceNumber: "", notes: "", drive: undefined,
  };
}
