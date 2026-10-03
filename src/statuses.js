// The booking status model — the one place the stages, their groups and their order live.
//
// Stored keys stay as they are (the browser extension and existing rows use them); "cpsa"
// in a key means "the facility's vendor" (GTEC, CPSA, a school…) — labels name the vendor.
// Two legacy keys are aliases, converted by supabase-setup.sql v3 and on load:
//   pending → pending_amua,  amua_submit → queued_cpsa.

export const LEGACY_STATUSES = { pending: "pending_amua", amua_submit: "queued_cpsa" };
export const normaliseStatus = s => LEGACY_STATUSES[s] || s;
export const isLegacyStatus = s => s in LEGACY_STATUSES;

// The stages. Each workflow walks its own subset, in order (WORKFLOW_STEPS).
export const ST = Object.freeze({
  AMUA_REVIEW: "pending_amua",          // requested; AMUA is checking it
  VENDOR_QUEUED: "queued_cpsa",         // AMUA accepted; to be sent to the vendor
  VENDOR_PENDING: "pending_cpsa",       // sent to the vendor, awaiting their answer
  APPROVED: "approved",
  VENDOR_CONFIRMED: "cpsa_confirmed",   // the vendor's published schedule matches
  VENDOR_MISMATCH: "cpsa_review_needed",// the vendor's schedule differs; AMUA reviewing
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  CLASH: "clash",                       // overlaps another booking / a vendor block
  OP_PERMISSION: "op_permission",       // council + operator: asking the operator
  COUNCIL_APPLY: "council_apply",
  COUNCIL_PENDING: "council_pending",
  COUNCIL_ACTION: "council_action",     // council offer, AMUA confirming
  COUNCIL_GRANTED: "council_granted",
  OP_CONFIRM: "op_confirm",
  CONTACT_REVIEW: "contact_review",     // community: first request, checking the contact
  COMMUNITY_REQUEST: "community_request",
});
export const ALL_STATUSES = Object.values(ST);

export const COUNCIL_STAGE_STATUSES = [ST.OP_PERMISSION, ST.COUNCIL_APPLY, ST.COUNCIL_PENDING, ST.COUNCIL_ACTION, ST.COUNCIL_GRANTED, ST.OP_CONFIRM, ST.CONTACT_REVIEW, ST.COMMUNITY_REQUEST];

// Steps per workflow (kind of vendor), in order.
export const WORKFLOW_STEPS = {
  gtec:            [ST.AMUA_REVIEW, ST.VENDOR_QUEUED, ST.VENDOR_PENDING, ST.APPROVED],
  council:         [ST.AMUA_REVIEW, ST.COUNCIL_APPLY, ST.COUNCIL_PENDING, ST.COUNCIL_ACTION, ST.COUNCIL_GRANTED, ST.APPROVED],
  council_private: [ST.AMUA_REVIEW, ST.OP_PERMISSION, ST.COUNCIL_APPLY, ST.COUNCIL_PENDING, ST.COUNCIL_ACTION, ST.COUNCIL_GRANTED, ST.OP_CONFIRM, ST.APPROVED],
  direct:          [ST.AMUA_REVIEW, ST.APPROVED],
  community:       [ST.AMUA_REVIEW, ST.CONTACT_REVIEW, ST.COMMUNITY_REQUEST, ST.APPROVED],
};

// Groups.
const set = (...xs) => new Set(xs.flatMap(x => [x, ...Object.keys(LEGACY_STATUSES).filter(k => LEGACY_STATUSES[k] === x)]));
export const CLOSED_STATUSES = set(ST.REJECTED, ST.CANCELLED);
// Still being worked on (needs AMUA or a vendor / the council to act).
export const REVIEW_STATUSES = set(ST.AMUA_REVIEW, ST.VENDOR_QUEUED, ST.VENDOR_PENDING, ST.VENDOR_MISMATCH, ...COUNCIL_STAGE_STATUSES);
// Sent to (or held by) the GTEC / CPSA vendor's schedule: a later cancellation must be
// requested from the vendor, not just removed here.
export const VENDOR_QUEUE_STATUSES = set(ST.VENDOR_QUEUED, ST.VENDOR_PENDING, ST.APPROVED, ST.VENDOR_CONFIRMED, ST.VENDOR_MISMATCH);
// Booked or on its way (everything but closed and clash).
export const LIVE_STATUSES = set(ST.AMUA_REVIEW, ST.VENDOR_QUEUED, ST.VENDOR_PENDING, ST.APPROVED, ST.VENDOR_CONFIRMED, ST.VENDOR_MISMATCH, ...COUNCIL_STAGE_STATUSES);

export const isClosed = s => CLOSED_STATUSES.has(s);
export const isLive = s => LIVE_STATUSES.has(s);
export const isInReview = s => REVIEW_STATUSES.has(s);
export const isAmuaReview = s => normaliseStatus(s) === ST.AMUA_REVIEW;
export const isVendorQueued = s => normaliseStatus(s) === ST.VENDOR_QUEUED;
export const reachedVendorQueue = s => VENDOR_QUEUE_STATUSES.has(s);

// Position of a status in its workflow ("2/4"), or null.
export function stepOf(status, workflow) {
  const steps = WORKFLOW_STEPS[workflow]; if (!steps) return null;
  const i = steps.indexOf(normaliseStatus(status));
  return i < 0 ? null : { n: i + 1, of: steps.length };
}

// The step tag for a status across the workflows of a set of bookings: "2/4", or each distinct
// position ("3/6 · 4/8") when they differ; "" when the status isn't a step of any of them.
// Three or more positions shorten: the same step number → "1/…", the last step everywhere → "✓".
export function stepTag(status, workflows) {
  const pos = [...new Map([...new Set(workflows)].map(w => stepOf(status, w)).filter(Boolean)
    .map(p => [`${p.n}/${p.of}`, p])).values()];
  if (!pos.length) return "";
  if (pos.length <= 2) return pos.map(p => `${p.n}/${p.of}`).join(" · ");
  if (pos.every(p => p.n === pos[0].n)) return `${pos[0].n}/…`;
  if (pos.every(p => p.n === p.of)) return "✓";
  return "";
}
