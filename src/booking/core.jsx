import logoUrl from "../assets/logo.jpg";
import { createClient } from "@supabase/supabase-js";
import { getActor } from "../actor.js";
import { useState, useRef, useEffect } from "react";
// ─── LOGO ─────────────────────────────────────────────────────────────────────
export const LOGO_SRC = logoUrl;
// ─── SUPABASE ─────────────────────────────────────────────────────────────────
export const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON;
export const supabase = SUPABASE_URL && SUPABASE_ANON
  ? createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    })
  : null;
export let _accessToken = null;
export let _currentUser = null; // { id, email } — kept in sync by onAuthStateChange
// { secondaryEmail: primaryEmail } — kept in sync from the component's emailAliases
// state so module-level sendEmail can CC a booker's primary address on mail sent
// to one of their linked secondary addresses.
export let _emailAliases = {};
export function primaryEmailFor(em) {
  if (!em) return null;
  return _emailAliases[em.toLowerCase()] || null;
}
export const _sessionId = (crypto?.randomUUID?.() || `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`);
// Timestamp of this page load. Used to scope "new" sync-result highlighting to the
// current session, so changes from a previous session read as old/seen on reload.
export const _sessionStartIso = new Date().toISOString();
export function authHeaders(extra = {}) {
  return { apikey: SUPABASE_ANON, Authorization: `Bearer ${_accessToken || SUPABASE_ANON}`, ...extra };
}

// Best-effort audit trail. Never throws — a missing table or RLS denial must not
// break the app flow. Captures auth events, booking changes, syncs and emails.
export async function logActivity(action, detail = {}) {
  if (!supabase || !_currentUser?.id) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({
        user_id: _currentUser.id,
        user_email: _currentUser.email || null,
        session_id: _sessionId,
        action,
        // Stamp the actor's role so the log can be filtered by admin vs booker activity.
        // Lives inside detail (jsonb) so no schema migration is needed.
        // actor: who on a shared login (first name, last initial), picked after sign-in.
        detail: { ...detail, by: _currentUser.role === "admin" ? "admin" : "booker", ...(getActor(_currentUser.email) ? { actor: getActor(_currentUser.email) } : {}) },
      }),
    });
  } catch { /* silent */ }
}

// Uncaught errors in the browser go to the activity log (admins only, "App error"), at most
// five per page load, so problems people hit are visible without a monitoring service.
export let _errorsLogged = 0;
export function logClientError(message, where) {
  if (_errorsLogged >= 5 || !message) return;
  _errorsLogged++;
  logActivity("client_error", { message: String(message).slice(0, 300), where: String(where || "").slice(0, 200), page: location.pathname });
}
if (typeof window !== "undefined") {
  window.addEventListener("error", e => logClientError(e.message, e.filename ? `${e.filename.split("/").pop()}:${e.lineno}` : ""));
  window.addEventListener("unhandledrejection", e => logClientError(e.reason?.message || e.reason, "promise"));
}

export const sb = {
  async select(table, query="") {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&order=created_at.desc`,
      { headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async insert(table, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method:"POST",
      headers: authHeaders({ "Content-Type":"application/json", Prefer:"return=representation" }),
      body:JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async update(table, id, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:"PATCH",
      headers: authHeaders({ "Content-Type":"application/json", Prefer:"return=representation" }),
      body:JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async remove(table, id) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:"DELETE",
      headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text());
  },
  // Delete rows matching a raw PostgREST filter query (e.g. "created_at=lt.2025-01-01").
  async removeWhere(table, query) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { method:"DELETE",
      headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text());
  },
  async upsert(table, data, onConflict="key") {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, { method:"POST",
      headers: authHeaders({ "Content-Type":"application/json", Prefer:"return=representation,resolution=merge-duplicates" }),
      body:JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async selectAll(table) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`,
      { headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
};

// ─── Facilities ───────────────────────────────────────────────────────────────
// site       which ground this belongs to; Cornwall Park is the default and stays implicit
// adminOnly  hidden from every picker, filter and calendar column for non-admins, so it
//            can be neither seen nor booked by them. Use for a ground we manage but do
//            not own — it is not part of the GTEC/CPSA feed, so the sync never touches it
//            (mapCJRFacility only ever returns f3/f4/f5, and CPSA_FIELD_IDS excludes it).
// defaultRate  $/hr used for both day and evening until an admin sets a rate explicitly.
// provider   who AMUA hires the facility from (a key of PROVIDERS). Official invoicing
//            raises one purchase order per provider, and only "gtec" facilities take part
//            in the GTEC/CPSA workflow.
export const FACILITIES = [
  { id:"f1", name:"Meeting Room – Ground Floor", capacity:20,  color:"#a78bfa", kind:"social", provider:"gtec", vendor:"CPSA" }, // light purple — rooms are requested from CPSA
  { id:"f2", name:"Function Room – Upstairs",    capacity:100, color:"#7c3aed", kind:"social", provider:"gtec", vendor:"CPSA" }, // deep purple
  { id:"f3", name:"Field #1",                    capacity:50,  color:"#166534", kind:"field", provider:"gtec" }, // darkest green
  { id:"f4", name:"Field #2",                    capacity:50,  color:"#22c55e", kind:"field", provider:"gtec" }, // mid green
  { id:"f5", name:"Field #3",                    capacity:50,  color:"#86efac", kind:"field", provider:"gtec" }, // light green
  // GTEC Orakei (Reihana St) — managed by GTEC but not a CPSA ground, so it sits outside
  // the sync entirely and is hidden from bookers until AMUA decides to open it up.
  { id:"g1", name:"GTEC Orakei – Field 1",       capacity:50,  color:"#0e7490", kind:"field",
    site:"GTEC Orakei", provider:"gtec", adminOnly:true, defaultRate:45 },   // dark cyan
  { id:"g2", name:"GTEC Orakei – Field 2",       capacity:50,  color:"#0891b2", kind:"field",
    site:"GTEC Orakei", provider:"gtec", adminOnly:true, defaultRate:45 },   // mid cyan
  { id:"g3", name:"GTEC Orakei – Field 3",       capacity:50,  color:"#22d3ee", kind:"field",
    site:"GTEC Orakei", provider:"gtec", adminOnly:true, defaultRate:45 },   // light cyan
  // St Cuthbert's College (Epsom) — hired directly from the school, not through GTEC, so
  // it has its own purchase order and never enters the GTEC queue or sync. Admin-only
  // until AMUA opens it to bookers; set its rate under Pricing. Listed at the Cornwall
  // Park location.
  { id:"s1", name:"St Cuthberts – Field #1",     capacity:50,  color:"#c2410c", kind:"field",
    site:"Cornwall Park", provider:"stcuthberts", adminOnly:true },   // burnt orange
  // ARL — a privately run area at the lower CPSA fields. Placeholder until AMUA has the
  // details (contact, rates); admin-only.
  { id:"a1", name:"ARL – Lower CPSA field area", capacity:50,  color:"#be123c", kind:"field",
    site:"Cornwall Park", provider:"arl", adminOnly:true },   // rose
  // Auckland Normal Intermediate (Epsom) — school field hired directly by AMUA. No booking
  // form yet: AMUA books by email to the school. $20/hr. Admin-only until opened to bookers.
  { id:"n1", name:"ANI – School Field",          capacity:50,  color:"#1d4ed8", kind:"field",
    site:"Auckland Normal Intermediate", provider:"ani", adminOnly:true, defaultRate:20 },   // blue
];
// Facilities the current viewer may see. Lookups by id are deliberately NOT filtered — a
// booking on an admin-only facility must still render its name wherever it appears.
// Mirrored at module level in the same way as the alias/colour maps, so the 13 pickers
// and calendar columns don't each need the admin flag threaded through them.
export let _isAdminView = false;
// Booker contact details for council applications (table booker_contacts, keyed by
// lowercase email). null until loaded — or if the table isn't set up — so nothing is gated.
export let _bookerContacts = null;
export function councilContactOk(email) {
  if (!_bookerContacts) return true;
  const e = (email || "").toLowerCase(), c = _bookerContacts[e] || _bookerContacts[_emailAliases[e] || e];
  return !!(c?.full_name?.trim() && c?.phone?.trim());
}
export function visibleFacilities() { return FACILITIES.filter(f => !f.inactive && (!f.adminOnly || _isAdminView) && (!f.council || _isAdminView || ownsCouncilFacility(f))); }
// Council fields are added per booker (Council fields page → Book), so a booker sees only
// the ones added for them (any of their linked emails); admins see all.
export function ownsCouncilFacility(f) {
  const me = (_currentUser?.email || "").toLowerCase(); if (!me) return false;
  const prim = _emailAliases[me] || me;
  return (f.owners || []).some(o => o === me || o === prim || (_emailAliases[o] || o) === prim);
}
// Light tint of each facility colour for day-view column backgrounds.
export const FACILITY_TINT = { f1:"#f5f3ff", f2:"#ede9fe", f3:"#dcfce7", f4:"#ecfdf5", f5:"#f0fdf4", g1:"#cffafe", g2:"#ecfeff", g3:"#f0fdff", s1:"#ffedd5", a1:"#fff1f2", n1:"#eff6ff" };
export function isSocialFac(id) { return FACILITIES.find(f=>f.id===id)?.kind==="social"; }
export const EMAIL_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#84cc16","#f97316","#14b8a6","#e879f9","#fb7185","#34d399","#60a5fa","#fbbf24"];
export const _ecc = {}; export let _eci = 0;
// { primaryEmail: "#hex" } — admin-set colour overrides, kept in sync from the
// component's aliasColors state. Colour is resolved per canonical booker so linked
// secondaries share their primary's colour (and override).
export let _emailColorOverrides = {};
export function emailColor(email) {
  const raw = (email||"").toLowerCase().trim();
  const k = (_emailAliases[raw] || raw); // canonical primary
  if (_emailColorOverrides[k]) return _emailColorOverrides[k];
  if (!_ecc[k]) { _ecc[k] = EMAIL_COLORS[_eci % EMAIL_COLORS.length]; _eci++; }
  return _ecc[k];
}

export const CAL_START=7, CAL_END=22, CAL_TOTAL=CAL_END-CAL_START, HOUR_H=56;
// Booking granularity. Every grid drag, start-time list and duration option derives from
// this, so the whole app moves together — 4 = quarter-hour (:00/:15/:30/:45) intervals.
export const SLOTS_PER_HOUR = 4;
export const SLOT_HOURS = 1/SLOTS_PER_HOUR;          // one slot expressed in hours (0.25)
export const SLOT_H = HOUR_H*SLOT_HOURS;             // …and in pixels on the hour grids (14px)
export const CAL_SLOTS = CAL_TOTAL*SLOTS_PER_HOUR;   // selectable slots in a day column
// Every selectable start time, CAL_START…CAL_END inclusive.
export const START_TIMES = Array.from({length:CAL_SLOTS+1},(_,i)=>CAL_START+i*SLOT_HOURS).filter(h=>h<=CAL_END);
// Boundary between the "day" and "evening" pricing bands (5:30pm). Also used to mark
// the floodlit Field #1 (f3) as a last resort during daylight: anything that starts
// and ends before this cutoff is daytime, when an unlit field should be used instead.
export const DAY_EVENING_CUTOFF = 17.5;
// Field #1 (f3) is the only floodlit field, so daytime use should be avoided to keep
// it free for evening (post-cutoff) play that genuinely needs the lights.
export const FLOODLIT_FIELD_ID = "f3";
// "45 min", "1 hr", "2 hrs 15 min" — one spelling for every duration, so the quarter-hour
// options read consistently alongside the whole-hour ones.
export function fmtDuration(h) {
  const hh = Math.floor(h), m = Math.round((h-hh)*60);
  if (!hh) return `${m} min`;
  return `${hh} hr${hh!==1?"s":""}${m?` ${m} min`:""}`;
}
// Quarter-hour steps up to 3 hrs (where bookings actually vary), then coarser for the
// long all-day hires. Any other value still shows: the pickers fall back to the raw hours.
export const DURATIONS = [
  ...Array.from({length:12},(_,i)=>(i+1)*SLOT_HOURS), // 15 min … 3 hrs
  3.5, 4, 5, 6, 8,
].map(value=>({ value, label: fmtDuration(value) }));
export const STATUS_META = {
  // Vendor stages name the provider of the booking's facility ({vendor}: GTEC for Cornwall
  // Park, St Cuthbert's, a school…); without a facility they read "vendor". desc = meaning.
  pending_amua: {bg:"#fff8e1",border:"#f59e0b",text:"#92400e",dot:"#f59e0b",label:"(1/4) Pending AMUA Review", desc:"Requested; AMUA is checking it"},
  queued_cpsa:  {bg:"#dbeafe",border:"#93c5fd",text:"#1e40af",dot:"#3b82f6",label:"(2/4) Queued for vendor", tpl:"(2/4) Queued for {vendor}", desc:"AMUA accepted it and will send it to the facility's vendor"},
  pending_cpsa: {bg:"#e0f2fe",border:"#7dd3fc",text:"#075985",dot:"#0ea5e9",label:"(3/4) Pending vendor review", tpl:"(3/4) Pending {vendor} review", desc:"Sent to the facility's vendor (GTEC, St Cuthbert's, a school…), awaiting their answer"},
  approved:      {bg:"#f0fdf4",border:"#22c55e",text:"#14532d",dot:"#22c55e",label:"(4/4) Approved", desc:"Confirmed — the field is yours at that time"},
  cpsa_confirmed:{bg:"#ecfeff",border:"#0891b2",text:"#155e75",dot:"#0891b2",label:"🌐 Vendor confirmed", tpl:"🌐 {vendor} confirmed", desc:"The vendor's published schedule matches the booking"},
  cpsa_review_needed: {bg:"#fef9c3",border:"#a16207",text:"#713f12",dot:"#a16207",label:"⚠ Vendor mismatch — AMUA review", tpl:"⚠ {vendor} mismatch — AMUA review", desc:"The vendor's schedule differs from the booking; AMUA is sorting it out"},
  rejected:     {bg:"#fff1f2",border:"#f43f5e",text:"#881337",dot:"#f43f5e",label:"Rejected", desc:"Declined by AMUA or the vendor"},
  cancelled:    {bg:"#f8f8f8",border:"#94a3b8",text:"#475569",dot:"#94a3b8",label:"Cancelled", desc:"Withdrawn"},
  clash:        {bg:"#fef3c7",border:"#d97706",text:"#92400e",dot:"#d97706",label:"Clash", desc:"Overlaps another booking or a vendor block"},
  amua_submit:  {bg:"#dbeafe",border:"#93c5fd",text:"#1e40af",dot:"#3b82f6",label:"(2/4) Queued for vendor", tpl:"(2/4) Queued for {vendor}"},
  pending:      {bg:"#fff8e1",border:"#f59e0b",text:"#92400e",dot:"#f59e0b",label:"(1/4) Pending AMUA Review"},
  // Council workflows (see WORKFLOW_STEPS): AMUA review → [ask the private operator] →
  // apply to council → council decision → [confirm with the operator] → approved.
  op_permission:  {bg:"#f3e8ff",border:"#a855f7",text:"#6b21a8",dot:"#a855f7",label:"🤝 Asking operator permission", desc:"AMUA is asking the club or trust that runs the field"},
  council_apply:  {bg:"#e0f2f1",border:"#14b8a6",text:"#115e59",dot:"#14b8a6",label:"🏛 Applying to council", desc:"Going into AMUA's next council application"},
  council_pending:{bg:"#ccfbf1",border:"#0d9488",text:"#134e4a",dot:"#0d9488",label:"⏳ Awaiting council decision", desc:"Application lodged; the council is deciding"},
  // From the council's emails (🏛 Allocation tab): an offer AMUA must confirm, then the
  // council's confirmation, after which AMUA allocates the fields to the bookers.
  council_action: {bg:"#ffedd5",border:"#ea580c",text:"#7c2d12",dot:"#ea580c",label:"📨 Council offer — AMUA confirming", desc:"The council offered the fields; AMUA is confirming"},
  council_granted:{bg:"#ecfccb",border:"#65a30d",text:"#365314",dot:"#65a30d",label:"🏛 Council granted — allocating", desc:"The council granted it; AMUA is allocating fields"},
  op_confirm:     {bg:"#ede9fe",border:"#7c3aed",text:"#4c1d95",dot:"#7c3aed",label:"🤝 Confirming with operator", desc:"Confirming keys, lights and access with the operator"},
  // Community facilities (schools, trusts): AMUA review → [review the contact, first time
  // only] → request drafted to AMUA's inbox (sent by AMUA from Gmail) → approved.
  contact_review:    {bg:"#fef9c3",border:"#ca8a04",text:"#713f12",dot:"#ca8a04",label:"🔎 Reviewing facility contact", desc:"First request to this facility: AMUA checks the contact"},
  community_request: {bg:"#dbeafe",border:"#2563eb",text:"#1e3a8a",dot:"#2563eb",label:"✉ Requested from facility", desc:"AMUA has asked the facility by email"},
};
// Each provider kind walks its own steps. Stored statuses stay provider-neutral keys.
export const COUNCIL_STAGE_STATUSES = ["op_permission","council_apply","council_pending","council_action","council_granted","op_confirm","contact_review","community_request"];
export const WORKFLOW_STEPS = {
  gtec:            ["pending_amua","queued_cpsa","pending_cpsa","approved"],
  council:         ["pending_amua","council_apply","council_pending","council_action","council_granted","approved"],
  council_private: ["pending_amua","op_permission","council_apply","council_pending","council_action","council_granted","op_confirm","approved"],
  direct:          ["pending_amua","approved"],
  community:       ["pending_amua","contact_review","community_request","approved"],
};
// Community facility rates ($/hr) by operator id; the rest are set in Facility Rates.
export const COMMUNITY_RATES = { "ani-epsom": 20, "ani-lower": 20 };
// Contact details AMUA has reviewed before its first request to a community facility
// (settings "provider_contact_reviews": { providerId: {email, phone, contact_name, by, at} }).
export let _contactReviews = {};
export const isContactReviewed = pid => !!_contactReviews[pid];
// invoiced is an orthogonal billing flag (booking.invoiced boolean), not a workflow status.
export const INVOICED_META = {bg:"#f5f3ff",border:"#7c3aed",text:"#5b21b6",dot:"#7c3aed",label:"🧾 Invoiced"};
export const REVIEW_STATUSES = new Set(["pending_amua","queued_cpsa","amua_submit","pending_cpsa","pending","cpsa_review_needed",...COUNCIL_STAGE_STATUSES]);
// Solid status colours used as the primary background in week/month calendar blocks.
// Field colour becomes the left-border accent; booker email colour appears as a small dot.
// Matches STATUS_META.dot exactly so calendar chips and status badges use the same palette.
export const STATUS_CAL_COLOR = {
  pending_amua:"#f59e0b", queued_cpsa:"#3b82f6", amua_submit:"#3b82f6",
  op_permission:"#a855f7", council_apply:"#14b8a6", council_pending:"#0d9488", council_action:"#ea580c", council_granted:"#65a30d", op_confirm:"#7c3aed",
  contact_review:"#ca8a04", community_request:"#2563eb",
  pending_cpsa:"#0ea5e9", pending:"#f59e0b",     approved:"#22c55e",
  cpsa_confirmed:"#0891b2", cpsa_review_needed:"#fef9c3",
  clash:"#d97706", rejected:"#f43f5e", cancelled:"#94a3b8",
};
// Per-status text colour override for calendar chips (default white). Light backgrounds need dark text.
export const STATUS_CAL_TEXT = { cpsa_review_needed: "#713f12" };
// Fields that participate in CPSA sync (f1/f2 are meeting/function rooms and stay "approved").
export const CPSA_FIELD_IDS = new Set(["f3","f4","f5"]);
// AMUA's own details: printed on every billing document, and used to pre-fill provider
// forms such as the council's sports-park application. These are defaults only; the
// live values are the admin-editable `amua_org` setting (User menu → AMUA details),
// applied by applyAmuaOrg so they can change without a deploy.
export const AMUA_DEFAULT_NAME = "Auckland Mixed Ultimate Association (AMUA)";
export const AMUA_INFO = {
  name:      AMUA_DEFAULT_NAME,
  address:   "",
  gstNumber: "",
  bank:      "",
  contacts:  {},   // { operations|secondary|keyHolder: { name, position, email, phone } }
  council:   {},   // { rso, orgType, postalAddressSearch, keyCodes, playersPerTeam } — council application answers
};
export const AMUA_CONTACT_ROLES = [
  { key:"operations", label:"Operations contact", hint:"Main contact for facility vendors, printed on invoices, and AMUA's point of contact in the CPSA and council extensions." },
  { key:"secondary",  label:"Secondary contact",  hint:"Backup contact on vendor applications." },
  { key:"keyHolder",  label:"Key / access-code holder", hint:"Holds gate, door or floodlight keys and codes." },
];
export function applyAmuaOrg(org) {
  const o = org || {};
  AMUA_INFO.name      = (o.name || "").trim() || AMUA_DEFAULT_NAME;
  AMUA_INFO.address   = o.address   || "";
  AMUA_INFO.gstNumber = o.gstNumber || "";
  AMUA_INFO.bank      = o.bank      || "";
  AMUA_INFO.contacts  = o.contacts  || {};
  AMUA_INFO.council   = o.council   || {};
}
// "Jane Smith · ops@amua.nz · 021 123 4567" for the operations contact, or "".
export function amuaContactLine() {
  const c = AMUA_INFO.contacts?.operations || {};
  return [c.name, c.email, c.phone].filter(Boolean).join(" · ");
}

// Pre-configured vendor: Grammar TEC Rugby Club (the facility owner / invoice recipient for POs).
export const VENDOR_GTEC = {
  id:        "gtec",
  name:      "Grammar TEC Rugby Club Inc",
  address:   "PO BOX 42 210\nOrakei\nAuckland\nNEW ZEALAND",
  gstNumber: "113-246-812",
};

// fb_profiles schema (localStorage):
// { [primaryEmail]: { fullName, officialName, address, gstNumber, accountNumber, accountName, profileType } }
// profileType: "user" | "admin" | "vendor"
export const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];

// ── 12-char document ID / bank reference ────────────────────────────────────
// One compact code that doubles as an NZ bank reference (fits a single 12-char field):
//   T  YY  MMfrom  MMto  RRR  DD
//   │   │     │      │    │    └ day issued (01–31; +31 on a same-day duplicate → 32–62)
//   │   │     │      │    └────── 3-char recipient code (booker / vendor / AMUA)
//   │   │     │      └─────────── period end month
//   │   │     └────────────────── period start month
//   │   └──────────────────────── period start year (2 digits)
//   └──────────────────────────── type: P=PO, I=Invoice, R=Receipt
// e.g. P260607GTE10 — PO, Jun→Jul 2026, recipient GTE, issued the 10th.
export const RECIPIENT_CODE_AMUA = "AMU";
export const RECIPIENT_CODE_GTEC = "GTE";

// Facility providers — who AMUA hires from and raises purchase orders to. Keyed by the
// `provider` on each facility. `short` names the provider in Drive folder names.
// (Interim: see docs/multi-provider-design.md for moving this into Supabase.)
export const PROVIDERS = {
  gtec:        { ...VENDOR_GTEC, short:"GTEC", label:"GTEC / CPSA", recipientCode: RECIPIENT_CODE_GTEC,
                 isDefault:true, defaultSite:"Cornwall Park" },
  stcuthberts: { id:"stcuthberts", name:"St Cuthbert's College", short:"St Cuthberts",
                 address:"", gstNumber:"", recipientCode:"STC", defaultSite:"Cornwall Park" },
  arl:         { id:"arl", name:"ARL", short:"ARL", address:"", gstNumber:"", recipientCode:"ARL",
                 defaultSite:"Cornwall Park", placeholder:true },   // details to come
  ani:         { id:"ani", name:"Auckland Normal Intermediate", short:"ANI", address:"Poronui Street, Epsom, Auckland",
                 gstNumber:"", recipientCode:"ANI", defaultSite:"Auckland Normal Intermediate",
                 bookBy:"email", email:"ani@ani.school.nz" },   // booked by email; no form yet
};
// Council fields added per booker on the Council fields page (settings "council_facilities"):
// { "<booker email>": [ {id, park_id, park, region, field, lat, lon, kind, operator, …} ] }.
// Each becomes a facility at the "<provider>|<park>" venue. Plain council parks use the
// Auckland Council provider; a council ground run by a club/trust/CCO gets that operator as
// its provider (kind council_private), so the booking walks the operator + council steps.
// The council's booking portal lists its sports-field permit (SSPPERMITBK) at $10 per field
// per application, paid later. The fee stays "pending" while bookings wait with AMUA; it's
// fixed when AMUA sends a batch of applications to the council (handleSendToCouncil).
// Auckland Council's online sports-field application (the form the council extension fills).
export const COUNCIL_APPLICATION_URL = "https://onlineservices.aucklandcouncil.govt.nz/councilonline/application/sportapplication?bookingApplicationType=SEASONAL_ALL_SPORTS_PARKS&productCode=SSPPERMITBK";
export const COUNCIL_APPLICATION_FEE = 10;
// Stamped in system_notes when a booking is sent: [COUNCIL_APP <app id> <sent at> fee=<share>].
export const COUNCIL_APP_RE = /\[COUNCIL_APP (\S+) (\S+) fee=([\d.]+)\]/;
export function parseCouncilApp(sysNotes) {
  const m = COUNCIL_APP_RE.exec(sysNotes || "");
  return m ? { id: m[1], at: m[2], fee: parseFloat(m[3]) } : null;
}
// Field areas are a property of the booking slot: council fields the Council fields page
// grouped because they overlap more than one frisbee field make one slot holding N field
// areas, and a booking of that slot books all of them. Bookings at overlapping times on the
// same slot share it; while fewer bookings share it than it has field areas, the council
// batch shows extra occupancy available (CouncilOccupancyNotes).
export const councilCap = b => FACILITIES.find(f => f.id === b.facility_id)?.council?.frisbee || 1;
export function councilOverlaps(bookings) {
  const live = (bookings || []).filter(b => !["cancelled", "rejected"].includes(b.status) && FACILITIES.find(f => f.id === b.facility_id)?.council);
  const byKey = {};
  live.forEach(b => (byKey[b.facility_id + "|" + b.date] ||= []).push(b));
  const out = [];
  Object.values(byKey).forEach(list => {
    list.sort((a, b) => a.start_hour - b.start_hour);
    let cur = null;
    list.forEach(b => { const end = b.start_hour + b.duration;
      if (cur && b.start_hour < cur.end) { cur.bookings.push(b); cur.end = Math.max(cur.end, end); }
      else { cur = { facility_id: b.facility_id, date: b.date, start: b.start_hour, end, bookings: [b] }; out.push(cur); } });
  });
  out.forEach(c => { c.cap = councilCap(c.bookings[0]); c.used = c.bookings.length; });
  return out;
}
// New council bookings that overlap another booker's booking on the same slot become its
// child (see handleSave). Mutates each draft's system_notes; returns patches for existing
// members (the parent's role, everyone's even share).
export function linkCouncilChildren(newDrafts, existing, canon) {
  const patches = {};
  newDrafts.forEach(d => {
    if (!FACILITIES.find(f => f.id === d.facility_id)?.council || parseSlotLink(d.system_notes)) return;
    const who = canon((d.email || "").toLowerCase()), end = d.start_hour + d.duration;
    const over = (existing || []).filter(b => b.facility_id === d.facility_id && b.date === d.date && !["cancelled", "rejected"].includes(b.status)
      && b.start_hour < end && d.start_hour < b.start_hour + b.duration && canon((b.email || "").toLowerCase()) !== who);
    if (!over.length) return;
    const notesOf = b => patches[b.id] ?? b.system_notes ?? "";
    const linked = over.find(b => parseSlotLink(notesOf(b)));
    const id = linked ? parseSlotLink(notesOf(linked)).id : newSlotRef();
    const members = linked ? existing.filter(b => parseSlotLink(notesOf(b))?.id === id) : [[...over].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""))[0]];
    const shares = evenSlotShares(members.length + 1);
    members.forEach((b, i) => { const role = parseSlotLink(notesOf(b))?.role || (i === 0 ? "parent" : "child");
      patches[b.id] = setSlotLink(notesOf(b), id, role, shares[i]); });
    d.system_notes = setSlotLink(d.system_notes, id, "child", shares[members.length]);
  });
  return Object.entries(patches).map(([id, system_notes]) => ({ id, system_notes }));
}
export function isCouncilBooking(b) { const wf = workflowOf(b.facility_id); return wf === "council" || wf === "council_private"; }
// Ready to go to the council: a plain council booking once AMUA has it, or a council +
// operator booking once the operator has given permission (it's then at council_apply).
export function canSendToCouncil(b) {
  const wf = workflowOf(b.facility_id);
  return (wf === "council" && ["pending_amua", "pending", "council_apply"].includes(b.status))
      || (wf === "council_private" && b.status === "council_apply");
}
// The batch as the council form wants it, for the AMUA Council Application extension
// ("📋 Copy for council form"): one Park details block per park with its fields, date
// range and per-weekday times, plus AMUA's organisation and contacts (AMUA details).
export function buildCouncilPayload(bkgs, approxPlayers = {}) {
  const hh = h => `${String(Math.floor(h)).padStart(2,"0")}:${String(Math.round((h % 1) * 60)).padStart(2,"0")}`;
  const DAYS = ["sun","mon","tue","wed","thu","fri","sat"];
  const parks = {};
  bkgs.forEach(b => {
    const c = FACILITIES.find(f => f.id === b.facility_id)?.council; if (!c) return;
    const p = parks[c.park_id] ||= { region: c.region || "", park: c.park, fields: [], dates: [], days: {}, bookingIds: [], bookers: new Set() };
    // A grouped venue field lists each council field it covers.
    (c.council_fields?.length ? c.council_fields : [c.field]).forEach(fl => { if (!p.fields.includes(fl)) p.fields.push(fl); });
    if (!p.dates.includes(b.date)) p.dates.push(b.date);
    p.bookingIds.push(b.id); p.bookers.add((b.email || "").toLowerCase());
    const d = DAYS[new Date(b.date + "T12:00").getDay()], t = p.days[d] ||= { start: b.start_hour, end: b.start_hour + b.duration };
    t.start = Math.min(t.start, b.start_hour); t.end = Math.max(t.end, b.start_hour + b.duration);
  });
  const list = Object.values(parks).map(p => {
    p.dates.sort();
    const players = [...p.bookers].reduce((n, e) => n + (parseInt(approxPlayers[e], 10) || parseInt(AMUA_INFO.council?.playersPerTeam, 10) || 0), 0);
    return { region: p.region, park: p.park, fields: p.fields, firstDate: p.dates[0], lastDate: p.dates[p.dates.length - 1], dates: p.dates,
      days: Object.fromEntries(Object.entries(p.days).map(([d, t]) => [d, { start: hh(t.start), end: hh(t.end) }])),
      teams: p.bookers.size, players: players || null, bookingIds: p.bookingIds };
  });
  const ct = AMUA_INFO.contacts || {};
  return { v: 1, source: "amua-facility-booking", createdAt: new Date().toISOString(),
    feeEstimate: councilFeeSplit(bkgs).total,
    bookingType: list.every(p => p.dates.length === 1) ? "casual" : "seasonal",
    purpose: "training", sport: "Other",
    activityName: `Training - ${AMUA_INFO.name}`,
    org: { name: AMUA_INFO.name, orgType: AMUA_INFO.council?.orgType || "Club/Team", rso: AMUA_INFO.council?.rso || "",
      postalAddressSearch: (AMUA_INFO.council?.postalAddressSearch || "").trim() || String(AMUA_INFO.address || "").split(/\n+/).map(x => x.trim()).filter(Boolean).join(" "), keyCodes: (AMUA_INFO.council?.keyCodes || "").trim() || "N/A",
      primary: ct.operations || {}, secondary: ct.secondary || {}, keyHolder: ct.keyHolder || {} },
    parks: list };
}
// Split a batch's fee: each field applied for costs COUNCIL_APPLICATION_FEE, shared equally
// by the bookers applying for it; a booker's share is spread over their bookings on it.
export function councilFeeSplit(bkgs) {
  const canon = e => { const x = (e || "").toLowerCase(); return _emailAliases[x] || x; };
  const byField = {};
  bkgs.forEach(b => (byField[b.facility_id] ||= []).push(b));
  const fees = {}, byBooker = {};
  Object.values(byField).forEach(list => {
    const groups = {};
    list.forEach(b => (groups[canon(b.email)] ||= []).push(b));
    const per = COUNCIL_APPLICATION_FEE / Object.keys(groups).length;
    Object.entries(groups).forEach(([who, bs]) => {
      byBooker[who] = (byBooker[who] || 0) + per;
      bs.forEach(b => { fees[b.id] = Math.round(per / bs.length * 10000) / 10000; });
    });
  });
  const fields = Object.keys(byField).length;
  return { fees, byBooker, fields, total: fields * COUNCIL_APPLICATION_FEE };
}
export const COUNCIL_COLORS = ["#0d9488","#0891b2","#7c3aed","#be185d","#b45309","#15803d","#4338ca","#9f1239"];
export function applyCouncilFacilities(map) {
  for (let i = FACILITIES.length - 1; i >= 0; i--) if (FACILITIES[i].council) FACILITIES.splice(i, 1);
  Object.keys(PROVIDERS).forEach(k => { if (PROVIDERS[k].dynamic) delete PROVIDERS[k]; });
  const byId = new Map();
  // Only fields saved as active bookings are offered; cart ("still choosing") ones are kept
  // as inactive facilities so bookings already on them still show their name.
  Object.entries(map || {}).forEach(([email, list]) => (Array.isArray(list) ? list : []).forEach(e => {
    if (!e?.id || !e.park) return;
    const owner = email.toLowerCase(), have = byId.get(e.id), active = e.status === "active";
    if (have) { if (active) { have.inactive = false; if (!have.owners.includes(owner)) have.owners.push(owner); } return; }
    let pid = "akl_council";
    if (e.kind === "community" && e.operator?.id) {
      pid = "cm_" + e.operator.id;
      if (!PROVIDERS[pid]) PROVIDERS[pid] = { id: pid, name: e.operator.name, short: e.operator.short || e.operator.name, kind: "community",
        dynamic: true, contact: e.operator, address: "", gstNumber: "",
        recipientCode: deriveRecipientCode(e.operator.short || e.operator.name, Object.values(PROVIDERS).map(p => p.recipientCode)) };
    } else if (e.kind === "council_private" && e.operator?.id) {
      pid = "op_" + e.operator.id;
      if (!PROVIDERS[pid]) PROVIDERS[pid] = { id: pid, name: e.operator.name, short: e.operator.short || e.operator.name, kind: "council_private",
        dynamic: true, contact: e.operator, address: "", gstNumber: "",
        recipientCode: deriveRecipientCode(e.operator.short || e.operator.name, Object.values(PROVIDERS).map(p => p.recipientCode)) };
    } else if (!PROVIDERS.akl_council) {
      PROVIDERS.akl_council = { id: "akl_council", name: "Auckland Council", short: "Council", kind: "council", dynamic: true,
        address: "", gstNumber: "", recipientCode: "AKC" };
    }
    byId.set(e.id, { id: e.id, name: `${e.park} – ${e.field}${e.frisbee > 1 ? ` (${e.frisbee} field areas)` : ""}`, capacity: 50, color: COUNCIL_COLORS[byId.size % COUNCIL_COLORS.length],
      kind: "field", site: e.park, provider: pid, defaultRate: e.kind === "community" ? (COMMUNITY_RATES[e.operator?.id] || 0) : 0, council: e, owners: active ? [owner] : [], inactive: !active });
  }));
  FACILITIES.push(...byId.values());
}
export function workflowOf(facilityId) {
  const pid = providerOfFacility(facilityId);
  return pid === "gtec" ? "gtec" : (PROVIDERS[pid]?.kind || "direct");
}
export function nextWorkflowStatus(b) {
  const steps = WORKFLOW_STEPS[workflowOf(b.facility_id)] || WORKFLOW_STEPS.direct;
  const i = steps.indexOf(b.status === "pending" ? "pending_amua" : b.status);
  const nxt = i >= 0 && i < steps.length - 1 ? steps[i + 1] : null;
  // The contact review only happens before the first request to that facility.
  return nxt === "contact_review" && isContactReviewed(providerOfFacility(b.facility_id)) ? "community_request" : nxt;
}
// "Step 2 of 6" for council workflows, shown beside the status.
export function workflowStep(b) {
  const wf = workflowOf(b.facility_id); if (wf !== "council" && wf !== "council_private" && wf !== "community") return "";
  const steps = WORKFLOW_STEPS[wf], i = steps.indexOf(b.status === "pending" ? "pending_amua" : b.status);
  return i >= 0 ? `${i + 1}/${steps.length}` : "";
}
export function defaultProviderId() {
  return Object.keys(PROVIDERS).find(k => PROVIDERS[k].isDefault) || Object.keys(PROVIDERS)[0];
}

// ─── Venues: provider → site ─────────────────────────────────────────────────
// The calendars, day grids and new-booking pickers show one venue at a time: the
// facilities of one provider at one site. The default provider's default site (Cornwall
// Park) is shown unless the viewer picks another from the venue dropdown. A facility
// without a `site` belongs to its provider's defaultSite. Summaries, rates, pricing rules
// and billing still see every facility.
// _activeVenue mirrors the App's venue state, like _isAdminView; null = the default.
export let _activeVenue = null;
export const ALL_VENUES = "all";
export function venueKeyOf(f) {
  const pid = f.provider || defaultProviderId();
  return `${pid}|${f.site || PROVIDERS[pid]?.defaultSite || ""}`;
}
// Venues the current viewer can see, default venue first, then grouped by provider.
export function listVenues() {
  const byKey = new Map();
  visibleFacilities().forEach(f => {
    const key = venueKeyOf(f);
    if (!byKey.has(key)) {
      const pid = f.provider || defaultProviderId();
      byKey.set(key, { key, providerId: pid, providerName: PROVIDERS[pid]?.name || pid,
                       site: key.split("|")[1] || PROVIDERS[pid]?.short || pid });
    }
  });
  const dflt = defaultVenueKey();
  return [...byKey.values()].sort((a,b) => (b.key===dflt) - (a.key===dflt)
    || (b.providerId===defaultProviderId()) - (a.providerId===defaultProviderId())
    || a.providerName.localeCompare(b.providerName) || a.site.localeCompare(b.site));
}
export function defaultVenueKey() {
  const pid = defaultProviderId();
  return `${pid}|${PROVIDERS[pid]?.defaultSite || ""}`;
}
// The calendars show one or more venues together (e.g. GTEC Cornwall Park alongside a
// council park): _activeVenue holds their keys joined by newlines, or ALL_VENUES (admins).
export const VENUE_SEP = "\n";
export function activeVenueKeys() {
  if (_activeVenue === ALL_VENUES && _isAdminView) return ALL_VENUES;
  const vs = listVenues(), picked = String(_activeVenue || "").split(VENUE_SEP).filter(k => vs.some(v => v.key === k));
  if (picked.length) return picked;
  const d = vs.find(v => v.key === defaultVenueKey())?.key || vs[0]?.key;
  return d ? [d] : ALL_VENUES;
}
export function activeVenueKey() { const ks = activeVenueKeys(); return ks === ALL_VENUES ? ALL_VENUES : ks[0]; }
// Facilities the viewer removed from the calendars' options (✕ on a facility pill).
export let _hiddenFacs = new Set();
export function inActiveVenue(facilityId) {
  if (_hiddenFacs.has(facilityId)) return false;
  const ks = activeVenueKeys();
  if (ks === ALL_VENUES) return true;
  const f = FACILITIES.find(x => x.id === facilityId);
  return !f || ks.includes(venueKeyOf(f));
}
// Facilities for venue-scoped views. `keepId` keeps a booking's current facility listed
// even when it belongs to another venue, so editing never silently drops it.
export function venueFacilities(keepId) {
  const ks = activeVenueKeys();
  return visibleFacilities().filter(f => f.id === keepId || (!_hiddenFacs.has(f.id) && (ks === ALL_VENUES || ks.includes(venueKeyOf(f)))));
}
// The calendars' default options: the default venue (GTEC Cornwall Park) plus the venues of
// the viewer's own active council / community fields.
export function defaultVenueSelection() {
  const ks = [defaultVenueKey()];
  visibleFacilities().filter(f => f.council && ownsCouncilFacility(f)).forEach(f => { const k = venueKeyOf(f); if (!ks.includes(k)) ks.push(k); });
  return ks;
}
// The booking form picks a facility in three steps: provider → venue (a provider's site) →
// facility. Every facility the viewer can book is offered (council fields added on the
// Council fields page included), not just the calendar's current venue. `keepId` keeps a
// booking's current facility listed even if the viewer can no longer see it.
export function bookableFacilities(keepId) {
  const vis = visibleFacilities();
  const keep = keepId && !vis.some(f => f.id === keepId) ? FACILITIES.find(f => f.id === keepId) : null;
  return keep ? [...vis, keep] : vis;
}
export function bookableVenues(keepId) {
  const cur = activeVenueKey(), facs = bookableFacilities(keepId), order = listVenues().map(v => v.key);
  const byKey = new Map();
  facs.forEach(f => { const k = venueKeyOf(f), [pid, site] = k.split("|");
    if (!byKey.has(k)) byKey.set(k, { key: k, pid, site: site || PROVIDERS[pid]?.short || pid, facs: [] });
    byKey.get(k).facs.push(f); });
  const rank = k => k === cur ? -1 : order.indexOf(k) < 0 ? 999 : order.indexOf(k);
  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key));
}
export const providerLabel = pid => PROVIDERS[pid]?.label || PROVIDERS[pid]?.name || pid;
// Provider groups for the pickers: Auckland Council (council-run fields and each private
// operator of council fields, e.g. Mt Albert-Ponsonby AFC) and Community / Schools fold
// their providers into one top-level entry; GTEC, St Cuthbert's (beside CPSA) and any
// other provider stand alone.
export const PROVIDER_GROUPS = {
  council:   { label: "🏛 Auckland Council", hint: "Council-run fields, or a club or trust that operates council fields" },
  community: { label: "🏫 Community / Schools", hint: "Schools and trusts that hire their fields to AMUA" },
};
export function providerGroupOf(pid) {
  const k = PROVIDERS[pid]?.kind;
  if (k === "council" || k === "council_private") return "council";
  if (pid !== "stcuthberts" && (k === "community" || pid === "ani")) return "community";
  return pid;
}
export const providerMemberLabel = pid => pid === "akl_council" ? "Council-operated" : PROVIDERS[pid]?.kind === "council_private" ? `◆ ${providerLabel(pid)}` : providerLabel(pid);
// A cascading provider menu: groups first; hovering (or clicking) a group shows its
// providers, each with the venues it runs (all of them in the tooltip). `sites(pid)` lists a
// provider's venues; `extra` adds rows at the end (e.g. All providers).
// `facilitiesOf(pid)` (optional) adds a third level for council providers: the specific
// fields (the booker's shortlisted / active council fields), picked with `onPickFacility`.
// `label` overrides the button text.
export function ProviderMenu({ pids, value, onPick, sites, style, extra = [], facilitiesOf, onPickFacility, label }) {
  const [open, setOpen] = useState(null), [hover, setHover] = useState(null), [hover2, setHover2] = useState(null), ref = useRef(null), btnRef = useRef(null);
  useEffect(() => { if (!open) return;
    const off = e => { if (ref.current && !ref.current.contains(e.target)) { setOpen(null); setHover(null); } };
    document.addEventListener("mousedown", off); document.addEventListener("touchstart", off);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("touchstart", off); }; }, [open]);
  const groups = [];
  pids.forEach(pid => { const g = providerGroupOf(pid); let e = groups.find(x => x.id === g);
    if (!e) groups.push(e = { id: g, pids: [] }); e.pids.push(pid); });
  // GTEC first with St Cuthbert's (its neighbour at Cornwall Park) beside it, then the
  // council and community groups, then anything else.
  const grank = g => ({ gtec: 0, stcuthberts: 1, council: 2, community: 3 })[g.id] ?? 4;
  groups.sort((a, b) => grank(a) - grank(b));
  const isGroup = g => !!PROVIDER_GROUPS[g.id];
  const order = pid => pid === "akl_council" ? 0 : 1;
  groups.forEach(g => g.pids.sort((a, b) => order(a) - order(b) || providerLabel(a).localeCompare(providerLabel(b))));
  const curExtra = extra.find(x => x.value === value), curGroup = PROVIDER_GROUPS[providerGroupOf(value)];
  const shown = label || (curExtra ? curExtra.label : curGroup ? `${curGroup.label} › ${providerMemberLabel(value)}` : providerLabel(value));
  const pick = v => { setOpen(null); setHover(null); setHover2(null); onPick(v); };
  const pickFac = id => { setOpen(null); setHover(null); setHover2(null); onPickFacility(id); };
  const facsOf = pid => facilitiesOf && PROVIDER_GROUPS[providerGroupOf(pid)] ? facilitiesOf(pid) : [];
  // Fixed to the button so a scrolling row can't clip it; on a narrow screen the providers
  // of a group open beneath it instead of beside it.
  const toggleOpen = () => { if (open) { setOpen(null); setHover(null); return; }
    const r = btnRef.current.getBoundingClientRect(); setOpen({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - 240)), narrow: window.innerWidth < 640 }); };
  const siteLine = pid => { const ss = sites(pid); return ss.length ? `${ss.slice(0, 3).join(" · ")}${ss.length > 3 ? ` +${ss.length - 3}` : ""}` : ""; };
  const row = (active) => ({ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, width: "100%", textAlign: "left", padding: "7px 12px", border: "none",
    background: active ? "#f1f5f9" : "#fff", cursor: "pointer", fontFamily: "inherit", fontSize: 13, color: "#0f172a", whiteSpace: "nowrap" });
  const menu = { position: "absolute", zIndex: 1200, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 10px 30px rgba(15,23,42,.15)", padding: "4px 0", minWidth: 220 };
  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button ref={btnRef} type="button" aria-haspopup="menu" aria-expanded={!!open} title="Vendor" onClick={toggleOpen}
        style={{ ...style, display: "inline-flex", alignItems: "center", gap: 6, textAlign: "left", cursor: "pointer" }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{shown}</span><span aria-hidden>▾</span>
      </button>
      {open && <div role="menu" style={{ ...menu, position: "fixed", top: open.top, left: open.left, maxHeight: `calc(100vh - ${open.top + 8}px)`, overflowY: open.narrow ? "auto" : "visible" }}>
        {groups.map(g => isGroup(g) ? (
          <div key={g.id} style={{ position: "relative" }} onMouseEnter={() => setHover(g.id)}>
            <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={hover === g.id} title={`${PROVIDER_GROUPS[g.id].hint}: ${g.pids.map(providerMemberLabel).join(", ")}`}
              onClick={() => setHover(g.id)} style={row(hover === g.id || providerGroupOf(value) === g.id)}>
              <span style={{ display: "flex", width: "100%", gap: 8 }}><b style={{ flex: 1 }}>{PROVIDER_GROUPS[g.id].label}</b><span style={{ color: "#94a3b8" }}>{g.pids.length} ▸</span></span>
              <span style={{ fontSize: 11, color: "#64748b" }}>{g.pids.map(providerMemberLabel).slice(0, 3).join(" · ")}{g.pids.length > 3 ? ` +${g.pids.length - 3}` : ""}</span>
            </button>
            {hover === g.id && <div role="menu" style={open.narrow ? { borderLeft: "3px solid #e2e8f0", marginLeft: 12 } : { ...menu, top: -4, left: "100%", maxHeight: 360, overflowY: "auto" }}>
              {g.pids.map(pid => { const fs = facsOf(pid); return (
                <div key={pid} style={{ position: "relative" }} onMouseEnter={() => setHover2(fs.length ? pid : null)}>
                <button type="button" role="menuitem" title={`${providerLabel(pid)} — venues: ${sites(pid).join(", ") || "none yet"}`} onClick={() => pick(pid)} style={row(pid === value)}>
                  <span style={{ display: "flex", width: "100%", gap: 8 }}><b style={{ flex: 1 }}>{providerMemberLabel(pid)}{pid === value ? " ✓" : ""}</b>{fs.length > 0 && <span style={{ color: "#94a3b8" }}>{fs.length} ▸</span>}</span>
                  {siteLine(pid) && <span style={{ fontSize: 11, color: "#64748b" }}>📍 {siteLine(pid)}</span>}
                </button>
                {/* Third level: the specific fields */}
                {hover2 === pid && fs.length > 0 && <div role="menu" style={open.narrow ? { borderLeft: "3px solid #e2e8f0", marginLeft: 12 } : { ...menu, top: -4, left: "100%", maxHeight: 360, overflowY: "auto" }}>
                  {fs.map(f => (
                    <button key={f.id} type="button" role="menuitem" title={f.name} onClick={() => pickFac(f.id)} style={row(false)}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: f.color, flexShrink: 0 }}/><b style={{ fontWeight: 600 }}>{f.name}</b></span>
                    </button>))}
                </div>}
                </div>); })}
            </div>}
          </div>
        ) : (
          <button key={g.id} type="button" role="menuitem" onMouseEnter={() => setHover(null)} title={`${providerLabel(g.pids[0])} — venues: ${sites(g.pids[0]).join(", ")}`} onClick={() => pick(g.pids[0])} style={row(g.pids[0] === value)}>
            <b>{providerLabel(g.pids[0])}{g.pids[0] === value ? " ✓" : ""}</b>
            {siteLine(g.pids[0]) && <span style={{ fontSize: 11, color: "#64748b" }}>📍 {siteLine(g.pids[0])}</span>}
          </button>))}
        {extra.map(x => <button key={x.value} type="button" role="menuitem" onMouseEnter={() => setHover(null)} onClick={() => pick(x.value)} style={{ ...row(x.value === value), borderTop: "1px solid #f1f5f9" }}><b>{x.label}</b></button>)}
      </div>}
    </div>
  );
}
export function ProviderVenuePicker({ facilityId, onPick, small }) {
  const venues = bookableVenues(facilityId);
  if (venues.length <= 1) return null;
  const f = FACILITIES.find(x => x.id === facilityId), curKey = f ? venueKeyOf(f) : venues[0].key, curPid = curKey.split("|")[0];
  const pids = [...new Set(venues.map(v => v.pid))];
  const st = small ? { ...S.inp, fontSize: 12 } : S.inp;
  const pickVenue = k => { const v = venues.find(x => x.key === k); if (v?.facs[0]) onPick(v.facs[0].id); };
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
      <div>
        <label style={S.lbl}>Vendor</label>
        <ProviderMenu pids={pids} value={curPid} onPick={pid => pickVenue(venues.find(v => v.pid === pid)?.key)}
          sites={pid => venues.filter(v => v.pid === pid).map(v => v.site)} style={{ ...st, width: "100%" }}
          facilitiesOf={pid => venues.filter(v => v.pid === pid).flatMap(v => v.facs)} onPickFacility={onPick}/>
      </div>
      <div>
        <label style={S.lbl}>Location</label>
        <select style={st} value={curKey} onChange={e => pickVenue(e.target.value)}>
          {venues.filter(v => v.pid === curPid).map(v => <option key={v.key} value={v.key}>📍 {v.site}</option>)}
        </select>
      </div>
    </div>
  );
}
// The facility <option>s at the chosen facility's venue.
export function FacilityOptions({ keepId }) {
  const f = FACILITIES.find(x => x.id === keepId), k = f ? venueKeyOf(f) : null;
  const facs = bookableFacilities(keepId).filter(x => !k || venueKeyOf(x) === k);
  return facs.map(x => <option key={x.id} value={x.id}>{x.name}</option>);
}
export function providerOfFacility(facilityId) {
  return FACILITIES.find(f => f.id === facilityId)?.provider || "gtec";
}
export function cleanRecipientCode(code) {
  return (code||"").toUpperCase().replace(/[^A-Z0-9]/g,"").padEnd(3,"X").slice(0,3);
}
// Derive a 3-char recipient code from a name, avoiding any code already in `taken`.
export function deriveRecipientCode(name, taken=[]) {
  const clean = (name||"").toUpperCase().replace(/[^A-Z0-9 ]/g," ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  let base;
  if (words.length >= 3)       base = words.slice(0,3).map(w=>w[0]).join("");
  else if (words.length === 2) base = words[0][0] + words[1].slice(0,2);
  else                         base = (words[0]||"XXX").slice(0,3);
  base = cleanRecipientCode(base);
  const takenSet = new Set((taken||[]).map(cleanRecipientCode));
  if (!takenSet.has(base)) return base;
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
    const cand = base.slice(0,2) + ch;
    if (!takenSet.has(cand)) return cand;
  }
  return base;
}
export function genBankRef({ type, dateFrom, dateTo, recipientCode, existingRefs=[] }) {
  const T  = (type||"I").toUpperCase().slice(0,1);
  const df = dateFrom ? new Date(dateFrom+"T00:00:00") : new Date();
  const dt = dateTo   ? new Date(dateTo  +"T00:00:00") : df;
  const yy  = String(df.getFullYear()).slice(-2);
  const mmF = String(df.getMonth()+1).padStart(2,"0");
  const mmT = String(dt.getMonth()+1).padStart(2,"0");
  const base = `${T}${yy}${mmF}${mmT}${cleanRecipientCode(recipientCode)}`;
  const taken = new Set(existingRefs||[]);
  let day = new Date().getDate();
  let ref = base + String(day).padStart(2,"0");
  // Rare same-day duplicate (same type/period/recipient): add 31 → 32–62, still 2 digits.
  if (taken.has(ref)) { day += 31; ref = base + String(day).padStart(2,"0"); }
  return ref;
}

export function fmtTime(h) {
  const hh=Math.floor(h), m=Math.round((h%1)*60), dh=hh>12?hh-12:hh===0?12:hh;
  return `${dh}:${m===0?"00":String(m).padStart(2,"0")} ${hh>=12?"PM":"AM"}`;
}
export function fmt24(h) {
  const hh=Math.floor(h), m=Math.round((h%1)*60);
  return `${String(hh).padStart(2,"0")}:${m===0?"00":String(m).padStart(2,"0")}`;
}
export function fmtDateShort(s) {
  const d=new Date(s+"T00:00:00"); return `${d.getDate()} ${d.toLocaleDateString("en-NZ",{month:"short"})}`;
}
// "Thu 3 Sep" — fmtDateShort plus the weekday. Its own helper rather than a change to
// fmtDateShort, which is used in eleven places where the extra word would just add width.
export function fmtDateShortDow(s) {
  const d = new Date(s+"T00:00:00");
  if (Number.isNaN(d.getTime())) return s || "";
  return `${d.toLocaleDateString("en-NZ",{weekday:"short"})} ${d.getDate()} ${d.toLocaleDateString("en-NZ",{month:"short"})}`;
}
export function fmtDate(s) { return new Date(s+"T00:00:00").toLocaleDateString("en-NZ",{weekday:"short",day:"numeric",month:"short",year:"numeric"}); }
// Normalise a free-text date (e.g. an extension-written GTEC submission marker that
// may be in ambiguous US m/d/yyyy form) to the app's unambiguous "5 Jun 2026" style.
// ISO yyyy-mm-dd is reformatted directly; numeric slash/dash dates are parsed (US
// interpretation, matching the extension's locale) and reformatted; anything we
// can't parse is returned untouched so we never show a misleading date.
export function fmtRefDate(raw) {
  if (!raw) return raw;
  const s = String(raw).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00`).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"});
  const d = new Date(s); // handles "6/5/2026" as US m/d; dd/mm with day>12 → Invalid
  return isNaN(d.getTime()) ? s : d.toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"});
}
// Format a CPSA-RES "logged at" stamp — a full ISO datetime (new) or a legacy date-only key.
export function fmtLoggedAt(s) {
  if (!s) return "";
  const hasTime = /T\d/.test(s);
  const d = new Date(hasTime ? s : s + "T00:00:00");
  if (isNaN(d.getTime())) return s;
  return hasTime
    ? d.toLocaleString("en-NZ", { day:"numeric", month:"short", year:"numeric", hour:"numeric", minute:"2-digit" })
    : d.toLocaleDateString("en-NZ", { day:"numeric", month:"short", year:"numeric" });
}
export function fmtCost(n) { return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,","); }
export function fmtTimeShort(h) {
  const hh=Math.floor(h), m=Math.round((h%1)*60), dh=hh>12?hh-12:hh===0?12:hh;
  return `${dh}${m?":"+String(m).padStart(2,"0"):""}${hh>=12?"p":"a"}`;
}
export const FAC_SHORT = { f1:"Mtg", f2:"Fn", f3:"Fld1", f4:"Fld2", f5:"Fld3", g1:"Ork1", g2:"Ork2", g3:"Ork3" };
export function facShort(id) { return FAC_SHORT[id] || (FACILITIES.find(x=>x.id===id)?.name) || id; }
// Which ground a facility belongs to. Cornwall Park facilities carry no `site`, so they
// share the empty default and still compare equal to each other.
export function facSite(id) { return FACILITIES.find(f => f.id === id)?.site || ""; }
export function sameSite(a, b) { return facSite(a) === facSite(b); }
// Labels for tight spaces. A facility at a named site uses its short code — spelling out
// "GTEC Orakei – Field 1" in a 96px calendar column or a table cell doesn't fit — while
// the unqualified Cornwall Park facilities keep the wording they already had.
export function facColLabel(fac) {
  if (!fac) return "—";
  if (fac.site) return facShort(fac.id);
  return fac.name.includes("Field") ? fac.name.replace("Field ","Fld ") : fac.name.split("–")[0].trim().slice(0,10);
}
export function facCellLabel(fac) {
  if (!fac) return "—";
  if (fac.site) return facShort(fac.id);
  return fac.name.includes("Field") ? fac.name.replace("Field ","F") : fac.name.split(" ")[0];
}
// Global mobile styles
export const MOBILE_STYLE = `
  .modal-backdrop > div { border-radius: 16px 16px 0 0; }
  @media (min-width: 768px) {
    .modal-backdrop { align-items: center !important; }
    .modal-backdrop > div { border-radius: 16px !important; max-height: 90vh !important; }
    /* Side panel: full height on the right, lighter backdrop, no blur */
    .modal-backdrop.side { justify-content: flex-end !important; align-items: stretch !important; background: rgba(15,23,42,0.18) !important; backdrop-filter: none !important; }
    .modal-backdrop.side > div { border-radius: 0 !important; max-height: 100vh !important; height: 100vh; box-shadow: -8px 0 32px rgba(15,23,42,0.18) !important; }
  }
  ::-webkit-scrollbar { display: none; }
  /* Diagonal stripe overlay distinguishes social-space chips in week/month calendar */
  .fac-social-tex {
    background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.20) 0 4px, rgba(255,255,255,0) 4px 9px);
  }
  /* Facility pills on desktop: all one width, names cut with … and shown in full on hover. */
  @media (min-width: 768px) {
    .facpills .facpill { width: 150px; transition: width .15s ease; }
    .facpills .facpill .facpill-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .facpills .facpill:hover { width: auto; max-width: 420px; }
  }
  .facpills .facpill .facpill-n { white-space: nowrap; }
  .fac-social-tex-dark {
    background-image: repeating-linear-gradient(45deg, rgba(0,0,0,0.10) 0 4px, rgba(0,0,0,0) 4px 9px);
  }
  /* Admin bookings table → one card per booking on phones (cells: select, date, booker,
     facility, status, time · purpose, actions). The column filters become a two-column grid. */
  @media (max-width: 767px) {
    .admin-bk, .admin-bk thead, .admin-bk tbody { display: block; width: 100%; }
    .admin-bk thead tr:first-child { display: flex; align-items: center; gap: 4px; overflow-x: auto; padding: 4px 6px; }
    .admin-bk thead tr:first-child th { padding: 2px 6px !important; width: auto !important; border: 0 !important; }
    .admin-bk thead tr:first-child th:nth-child(6), .admin-bk thead tr:first-child th:nth-child(7) { display: none; }
    .admin-bk thead tr:nth-child(2) { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 6px; }
    .admin-bk thead tr:nth-child(2) th { display: block; padding: 0 !important; min-width: 0; }
    .admin-bk thead tr:nth-child(2) th:empty { display: none; }
    .admin-bk tbody tr { display: grid; grid-template-columns: 26px minmax(0,1fr) minmax(0,1fr);
      grid-template-areas: "cb date time" "cb fac booker" "cb status status" "cb act act"; gap: 3px 6px; padding: 8px 6px; }
    .admin-bk tbody td { display: block; padding: 0 !important; min-width: 0; }
    .admin-bk tbody td:nth-child(1) { grid-area: cb; padding-top: 2px !important; }
    .admin-bk tbody td:nth-child(2) { grid-area: date; font-weight: 700; color: #334155 !important; }
    .admin-bk tbody td:nth-child(3) { grid-area: booker; justify-self: end; max-width: 100%; overflow: hidden; }
    .admin-bk tbody td:nth-child(4) { grid-area: fac; }
    .admin-bk tbody td:nth-child(5) { grid-area: status; }
    .admin-bk tbody td:nth-child(6) { grid-area: time; justify-self: end; text-align: right; max-width: 100%; }
    .admin-bk tbody td:nth-child(6) div { max-width: 100% !important; }
    .admin-bk tbody td:nth-child(7) { grid-area: act; }
    .admin-bk tbody td:nth-child(7) > div { justify-content: flex-start !important; }
    .admin-bk tbody td:nth-child(7) button { padding: 5px 10px !important; font-size: 11px !important; }
  }
`;
export function useMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mobile;
}

export function todayKey() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
export function dateKey(d)  { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
export function newId()     { return crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)+Date.now().toString(36); }
export function addDays(dateStr, n) {
  // Use UTC to avoid daylight-saving / timezone shifts causing off-by-one
  const [y,m,d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d+n));
  return dt.toISOString().split("T")[0];
}
export function getWeekDates(base) {
  const d=new Date(base), day=d.getDay(), mon=new Date(d);
  mon.setDate(d.getDate()-(day===0?6:day-1));
  return Array.from({length:7},(_,i)=>{const dd=new Date(mon);dd.setDate(mon.getDate()+i);return dd;});
}
export function getDaysInMonth(y,m) {
  const f=new Date(y,m,1),days=[];
  while(f.getMonth()===m){days.push(new Date(f));f.setDate(f.getDate()+1);}
  return days;
}
export function timeOverlaps(a,b) {
  if(a.date!==b.date||a.id===b.id) return false;
  if(["cancelled","rejected"].includes(a.status)||["cancelled","rejected"].includes(b.status)) return false;
  return a.start_hour<b.start_hour+b.duration && a.start_hour+a.duration>b.start_hour;
}
export function isAdminBooking(b)  { return b.email === "admin"; }
// Lay overlapping bookings out in side-by-side lanes so none is hidden behind another —
// drawing them all full-width means whichever renders last wins and the rest are invisible.
// Bookings are grouped into clusters of mutually-overlapping runs; within a cluster each
// takes the first lane free at its start time, and every member of a cluster is drawn at
// the same width so the column reads as an even grid. Non-overlapping bookings keep the
// full width. Returns [{ booking, lane, lanes }].
export function layoutOverlapLanes(items) {
  const sorted = [...items].sort((a,b)=>
    a.start_hour-b.start_hour || b.duration-a.duration || String(a.id).localeCompare(String(b.id)));
  const out = [];
  let cluster = [], laneEnds = [], clusterEnd = -Infinity;
  const flush = () => {
    for (const e of cluster) e.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = []; laneEnds = []; clusterEnd = -Infinity;
  };
  for (const b of sorted) {
    const end = b.start_hour + b.duration;
    if (cluster.length && b.start_hour >= clusterEnd) flush(); // gap → start a new cluster
    let lane = laneEnds.findIndex(e => e <= b.start_hour);     // reuse a lane that has ended
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(end); }
    else laneEnds[lane] = end;
    cluster.push({ booking: b, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) flush();
  return out;
}

// ─── Copy any rendered table to the clipboard ────────────────────────────────
// Serialises a live <table> DOM node to clean HTML + tab-separated text so it
// pastes as a real table into Sheets/Excel/Docs/email (same idea as the mismatch
// "copy" action, but generic). <CopyableTable> wraps a table and adds the button.
export function escTableText(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
export function serializeTableEl(table){
  if(!table) return { html:"", text:"" };
  const rows = [...table.rows];
  const cellText = c => (c.innerText||c.textContent||"").replace(/\s+/g," ").trim();
  // Cells/columns flagged data-nocopy (e.g. per-row action buttons) are excluded so the
  // clipboard table holds only the meaningful data.
  const copyCells = r => [...r.cells].filter(c => !c.hasAttribute("data-nocopy"));
  const text = rows.map(r => copyCells(r).map(cellText).join("\t")).join("\n");
  const htmlRows = rows.map(r => {
    const head = r.parentElement && r.parentElement.tagName === "THEAD";
    return "<tr>" + copyCells(r).map(c => {
      const th = c.tagName === "TH" || head;
      return `<${th?"th":"td"} style="border:1px solid #cbd5e1;padding:4px 8px;text-align:left;font-size:12px;${th?"background:#f1f5f9;font-weight:700":""}">${escTableText(cellText(c))}</${th?"th":"td"}>`;
    }).join("") + "</tr>";
  }).join("");
  return { html:`<table style="border-collapse:collapse;font-family:sans-serif">${htmlRows}</table>`, text };
}
export function CopyableTable({ children, style, align="left" }){
  const [done, setDone] = useState(false);
  async function copy(e){
    const table = e.currentTarget.closest("[data-copytable]")?.querySelector("table");
    const { html, text } = serializeTableEl(table);
    if(!text) return;
    try { await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html],{type:"text/html"}), "text/plain": new Blob([text],{type:"text/plain"}) })]); }
    catch { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } }
    setDone(true); setTimeout(()=>setDone(false), 1500);
  }
  return (
    <div data-copytable="" style={style}>
      <div style={{display:"flex",justifyContent:align==="right"?"flex-end":"flex-start",marginBottom:4}}>
        <button type="button" onClick={copy} title="Copy this table to the clipboard — paste into Sheets, Docs or email"
          style={{fontFamily:"inherit",fontSize:10,fontWeight:700,cursor:"pointer",border:"1px solid #cbd5e1",borderRadius:6,padding:"2px 8px",background:done?"#dcfce7":"#fff",color:done?"#166534":"#475569",lineHeight:1.4}}>
          {done?"✓ Copied":"📋 Copy table"}</button>
      </div>
      {children}
    </div>
  );
}
// System markers (CPSA mismatch, billing snapshot, CPSA submission refs) live in
// booking.system_notes — separate from user-editable booking.notes. All read helpers
// fall back to booking.notes for rows that pre-date the system_notes column migration.
export const CPSA_MISMATCH_RE = /\[CPSA-MISMATCH\][^\n]*/g;
export const CPSA_GTEC_RE = /\[CPSA-GTEC\][^\n]*/g;
export function setMismatchNote(sysNotes, reasons) {
  const base = (sysNotes||"").replace(CPSA_MISMATCH_RE,"").trim();
  if (!reasons || !reasons.length) return base;
  const marker = `[CPSA-MISMATCH] ${reasons.join(" | ")}`;
  return base ? `${base}\n${marker}` : marker;
}
// Read from system_notes; fall back to notes for pre-migration rows.
export function parseMismatchNote(sysNotes, notesLegacy) {
  const src = sysNotes || notesLegacy || "";
  const m = src.match(/\[CPSA-MISMATCH\]\s*([^\n]*)/);
  return m ? m[1].split("|").map(s=>s.trim()).filter(Boolean) : [];
}
// Stripping the mismatch flag also clears the incoming-event snapshot below, so
// every confirm/resolve/reset path that already calls this keeps notes clean.
export function stripMismatchNote(sysNotes) { return (sysNotes||"").replace(CPSA_MISMATCH_RE,"").replace(CPSA_GTEC_RE,"").trim(); }
// Full snapshot of the incoming GTEC/CPSA event a booking was matched against —
// name + parsed dimensions — so mismatch views can show everything known from the
// sync pull, not just the fields that differ. Stored as name|date|start|dur|facs.
export function setGtecSnapshot(sysNotes, gtec) {
  const base = (sysNotes||"").replace(CPSA_GTEC_RE,"").trim();
  if (!gtec) return base;
  const enc = v => String(v==null?"":v).replace(/[|\n]/g," ").trim();
  const marker = `[CPSA-GTEC] ${[enc(gtec.name),enc(gtec.date),enc(gtec.start_hour),enc(gtec.duration),enc((gtec.facilityIds||[]).join(","))].join("|")}`;
  return base ? `${base}\n${marker}` : marker;
}
export function parseGtecSnapshot(sysNotes) {
  const m = (sysNotes||"").match(/\[CPSA-GTEC\]\s*([^\n]*)/);
  if (!m) return null;
  const [name,date,start,dur,facs] = m[1].split("|").map(s=>s.trim());
  return { name, date, start_hour: start!==""?parseFloat(start):null, duration: dur!==""?parseFloat(dur):null, facilityIds: facs?facs.split(",").filter(Boolean):[] };
}
// One-line summary of an incoming GTEC event snapshot (name + facility + date + time).
export function fmtGtecEvent(g) {
  if (!g) return "";
  const facs = (g.facilityIds||[]).map(facShort).filter(Boolean).join("/");
  const time = (g.start_hour!=null && !Number.isNaN(g.start_hour))
    ? `${fmtTimeShort(g.start_hour)}–${fmtTimeShort(g.start_hour+(g.duration||0))}` : "";
  return [g.name||"(unnamed)", facs, g.date?fmtDateShort(g.date):"", time].filter(Boolean).join(" · ");
}
// Both-sides view of a clash: the incoming GTEC event and the AMUA booking with
// every dimension, so the admin can judge whether they are the same booking (and
// why matching didn't link them). Field/time/duration are green when they agree,
// red when they differ — leaving identity/name as the usual reason they diverge.
export function ClashPair({ admin, user }) {
  const facName = id => FACILITIES.find(x=>x.id===id)?.name || id;
  const dim = same => ({ color: same?"#16a34a":"#dc2626", fontWeight:700 });
  const sameFac=admin.facility_id===user.facility_id, sameTime=admin.start_hour===user.start_hour, sameDur=admin.duration===user.duration;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:3,minWidth:0,flex:1}}>
      <div style={{display:"flex",gap:6,alignItems:"baseline",flexWrap:"wrap"}}>
        <span style={{fontWeight:700,color:"#9f1239",whiteSpace:"nowrap"}}>🔒 GTEC</span>
        <span style={{fontWeight:600}}>{admin.purpose||"Admin booking"}</span>
        <span style={{color:"#64748b"}}>· {facName(admin.facility_id)} · {fmtDate(admin.date)} · {fmtTime(admin.start_hour)}–{fmtTime(admin.start_hour+admin.duration)} · {admin.duration}h</span>
      </div>
      <div style={{display:"flex",gap:6,alignItems:"baseline",flexWrap:"wrap"}}>
        <span style={{fontWeight:700,color:"#0369a1",whiteSpace:"nowrap"}}>👤 AMUA</span>
        <EmailChip email={user.email}/>
        {user.name&&<span style={{color:"#475569"}}>{user.name}</span>}
        <span style={{color:"#475569"}}>&ldquo;{user.purpose||"—"}&rdquo;</span>
        <span style={dim(sameFac)}>{facName(user.facility_id)}</span>
        <span style={{color:"#cbd5e1"}}>·</span>
        <span style={dim(sameTime)}>{fmtTime(user.start_hour)}–{fmtTime(user.start_hour+user.duration)}</span>
        <span style={dim(sameDur)}>{user.duration}h</span>
      </div>
      {sameFac&&sameTime&&sameDur&&<span style={{fontSize:10,color:"#16a34a",fontWeight:700}}>↳ field, time &amp; duration identical — likely the same booking; only name/identity differs</span>}
    </div>
  );
}
// Split a succinct reason "Label: old → new" into structured parts for old/new columns.
export function splitReason(r) {
  const m = (r||"").match(/^(.+?):\s*(.*?)\s*→\s*(.*)$/);
  return m ? { label: m[1], old: m[2], next: m[3] } : { label: r, old: "", next: "" };
}
// Billed snapshot stored in system_notes.
export const BILLED_RE = /\[BILLED\][^\n]*/g;
export function setBilledSnapshot(sysNotes, b) {
  const base = (sysNotes||"").replace(BILLED_RE,"").trim();
  const marker = `[BILLED] ${b.facility_id}|${b.start_hour}|${b.duration}`;
  return base ? `${base}\n${marker}` : marker;
}
export function parseBilledSnapshot(sysNotes, notesLegacy) {
  const src = sysNotes || notesLegacy || "";
  const m = src.match(/\[BILLED\]\s*([^|]+)\|([^|]+)\|([^\n|]+)/);
  if (!m) return null;
  return { facility_id: m[1].trim(), start_hour: parseFloat(m[2]), duration: parseFloat(m[3]) };
}
// CPSA mismatch resolution state stored in system_notes as [CPSA-RES] resolution|billingState|loggedAtISO.
// Billing states: none | credit_pending | invoice_pending | credited | invoiced
export const CPSA_RES_RE_G = /\[CPSA-RES\][^\n]*/g;
export const CPSA_ORIG_RE_G = /\[CPSA-ORIG\][^\n]*/g;
export function parseCpsaResolution(sysNotes) {
  const m = (sysNotes||"").match(/\[CPSA-RES\]\s*([^\n]*)/);
  if (!m) return null;
  const [res, billing, date] = m[1].split("|").map(s=>s.trim());
  return { resolution: res||"pending", billingState: billing||"none", date: date||"" };
}
export function setCpsaResolution(sysNotes, resolution, billingState="none") {
  const base = (sysNotes||"").replace(CPSA_RES_RE_G,"").trim();
  // Stamp the full date+time the resolution/update was logged (ISO; legacy rows are date-only).
  const marker = `[CPSA-RES] ${resolution}|${billingState}|${new Date().toISOString()}`;
  return base ? `${base}\n${marker}` : marker;
}
// Original booking values before CPSA amendment — stored so the change can be tracked/reversed.
export function parseCpsaOrig(sysNotes) {
  const m = (sysNotes||"").match(/\[CPSA-ORIG\]\s*([^\n]*)/);
  if (!m) return null;
  const [fac, sh, dur] = m[1].split("|").map(s=>s.trim());
  return { facility_id: fac, start_hour: parseFloat(sh), duration: parseFloat(dur) };
}
export function setCpsaOrig(sysNotes, b) {
  const base = (sysNotes||"").replace(CPSA_ORIG_RE_G,"").trim();
  const marker = `[CPSA-ORIG] ${b.facility_id}|${b.start_hour}|${b.duration}`;
  return base ? `${base}\n${marker}` : marker;
}
// Pre-clash workflow status, stored in system_notes when a sync flags a booking as
// "clash". A later sync that finds the clash resolved restores this prior stage
// (e.g. pending_amua, queued_cpsa) instead of leaving the booking stuck on "clash".
export const CLASH_PREV_RE = /\[CLASH-PREV\][^\n]*/g;
export function setClashPrevStatus(sysNotes, status) {
  const base = (sysNotes||"").replace(CLASH_PREV_RE,"").trim();
  const marker = `[CLASH-PREV] ${status}`;
  return base ? `${base}\n${marker}` : marker;
}
export function parseClashPrevStatus(sysNotes) {
  const m = (sysNotes||"").match(/\[CLASH-PREV\]\s*([^\n]*)/);
  return m ? m[1].trim() : null;
}
export function stripClashPrevStatus(sysNotes) { return (sysNotes||"").replace(CLASH_PREV_RE,"").trim(); }
// Statuses meaning a booking has been submitted to GTEC's schedule (queued for GTEC
// and beyond). Once here, GTEC holds the slot, so a later cancellation must be
// requested from GTEC for purging — not just removed from our records. A booking
// flagged "clash" hides its real stage in [CLASH-PREV]; resolve through to that.
export const GTEC_QUEUE_STATUSES = new Set(["queued_cpsa","amua_submit","pending_cpsa","approved","cpsa_confirmed","cpsa_review_needed"]);
export function reachedGtecQueue(b) {
  let s = b?.status;
  if (s === "clash") s = parseClashPrevStatus(b?.system_notes) || s;
  return GTEC_QUEUE_STATUSES.has(s);
}
// Parse the compact time strings produced by fmtTimeShort, e.g. "6p" → 18, "6:30p" → 18.5.
export function parseFmtTimeShort(s) {
  const m = (s||"").trim().toLowerCase().match(/^(\d+)(?::(\d+))?([ap])$/);
  if (!m) return NaN;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3]==="p" && h!==12) h += 12;
  if (m[3]==="a" && h===12) h = 0;
  return h + min/60;
}
// Extract the CPSA-intended values from parsed mismatch reasons (the "new" side of each reason).
export function extractCpsaAmendValues(reasons, booking) {
  let { facility_id, start_hour, duration } = booking;
  for (const r of reasons) {
    const p = splitReason(r);
    if (!p.next) continue;
    if (p.label === "Time") { const h=parseFmtTimeShort(p.next.trim()); if(!isNaN(h)) start_hour=h; }
    else if (p.label === "Dur") { const d=parseFloat(p.next); if(!isNaN(d)) duration=d; }
    else if (p.label === "Field") {
      const first = p.next.split("/")[0].trim();
      const fac = FACILITIES.find(f=>facShort(f.id)===first);
      if (fac) facility_id = fac.id;
    }
  }
  return { facility_id, start_hour, duration };
}
// Parse CPSA submission markers "[CPSA <date>] Ref <ref> · <url>" out of
// system_notes (falls back to notes for pre-migration rows). Returns one
// { date, ref, url } per marker — the link to CPSA's record of the booking.
export function parseCpsaRefs(sysNotes, notesLegacy) {
  const src = sysNotes || notesLegacy || "";
  const re = /\[CPSA ([^\]]+)\]\s*Ref\s+(\S+)\s*·\s*(https?:\/\/\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ date: m[1], ref: m[2], url: m[3] });
  return out;
}

// ── Cost splitting & manual (function) pricing ──────────────────────────────
// Co-booker cost split, stored as [SPLIT] email:weight|email:weight in system_notes.
// The primary booker is always one of the participants. Each booker is invoiced their
// weight / total-weight share of the booking's cost. Absent ⇒ no split (primary pays all).
export const SPLIT_RE = /\[SPLIT\][^\n]*/g;
export function parseSplit(sysNotes) {
  const m = (sysNotes||"").match(/\[SPLIT\]\s*([^\n]*)/);
  if (!m) return null;
  const parts = m[1].split("|").map(s=>s.trim()).filter(Boolean).map(p=>{
    const i = p.lastIndexOf(":");
    const email = (i>=0 ? p.slice(0,i) : p).trim().toLowerCase();
    const w = i>=0 ? parseFloat(p.slice(i+1)) : 1;
    return { email, weight: (Number.isNaN(w)||w<=0) ? 1 : w };
  }).filter(p=>p.email);
  return parts.length ? parts : null;
}
export function setSplit(sysNotes, parts) {
  const base = (sysNotes||"").replace(SPLIT_RE,"").trim();
  // A split needs at least two participants to be meaningful.
  if (!parts || parts.length < 2) return base;
  const marker = `[SPLIT] ${parts.map(p=>`${p.email}:${(+p.weight||1)}`).join("|")}`;
  return base ? `${base}\n${marker}` : marker;
}
// Fixed total cost that overrides the hourly calc, stored as [FNCOST] amount.
// Used for function-room bookings AMUA prices by hand. Absent ⇒ use hourly rates.
export const FNCOST_RE = /\[FNCOST\][^\n]*/g;
export function parseFunctionCost(sysNotes) {
  const m = (sysNotes||"").match(/\[FNCOST\]\s*(-?[\d.]+)/);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Number.isNaN(v) ? null : v;
}
export function setFunctionCost(sysNotes, amount) {
  const base = (sysNotes||"").replace(FNCOST_RE,"").trim();
  if (amount===null || amount===undefined || amount==="") return base;
  const v = parseFloat(amount);
  if (Number.isNaN(v)) return base;
  const marker = `[FNCOST] ${v}`;
  return base ? `${base}\n${marker}` : marker;
}

// ── Shared slots (retroactive split / merge) ────────────────────────────────
// One physical slot used by more than one team is held as one booking per team, linked
// by a shared id so the group can be costed and named as a unit. [SLOT] id|role|share.
//   parent  the booking a slot was split from — GTEC booked that name, so it keeps it
//   child   a team added to that slot afterwards
//   peer    two bookings made independently and merged later; neither owns the name, so
//           the GTEC-facing name carries both
// share is this member's fraction of the slot's cost. Shares sum to 1 across the group,
// so the slot is billed once between the teams rather than once per team.
export const SLOT_RE = /\[SLOT\][^\n]*/g;
export function parseSlotLink(sysNotes) {
  const m = (sysNotes||"").match(/\[SLOT\]\s*([^\n]*)/);
  if (!m) return null;
  const [id, role, share] = m[1].split("|").map(x=>(x||"").trim());
  if (!id) return null;
  const f = parseFloat(share);
  return { id, role: role || "peer", share: Number.isFinite(f) && f > 0 ? f : 1 };
}
export function setSlotLink(sysNotes, id, role, share) {
  const base = (sysNotes||"").replace(SLOT_RE,"").trim();
  if (!id) return base;
  const marker = `[SLOT] ${id}|${role||"peer"}|${+(Number(share)||1).toFixed(4)}`;
  return base ? `${base}\n${marker}` : marker;
}
export function clearSlotLink(sysNotes) { return (sysNotes||"").replace(SLOT_RE,"").trim(); }
export function newSlotRef() { return "S"+Date.now().toString(36)+Math.random().toString(36).slice(2,5); }
// Everyone sharing a slot, parent first then oldest-first, so the group reads in the
// order it was built.
export function slotGroupMembers(bookings, id) {
  if (!id) return [];
  return (bookings||[]).filter(b => parseSlotLink(b.system_notes)?.id === id)
    .sort((a,b) => {
      const ra = parseSlotLink(a.system_notes)?.role === "parent";
      const rb = parseSlotLink(b.system_notes)?.role === "parent";
      if (ra !== rb) return ra ? -1 : 1;
      return (a.created_at||"").localeCompare(b.created_at||"");
    });
}
// The name GTEC should see for a shared slot. A split keeps the parent's name — GTEC
// booked that and the field allocation never changed. A merge of two bookings made
// separately has no parent, so both names are carried.
export function slotGroupName(members) {
  if (!members || !members.length) return "";
  const parent = members.find(b => parseSlotLink(b.system_notes)?.role === "parent");
  if (parent) return parent.purpose || "";
  return [...new Set(members.map(b => (b.purpose||"").trim()).filter(Boolean))].join(" / ");
}
// Even shares across n members, with the rounding remainder given to the first so they
// still total exactly 1.
export function evenSlotShares(n) {
  if (n <= 0) return [];
  const each = +(1/n).toFixed(4);
  const shares = Array(n).fill(each);
  shares[0] = +(1 - each*(n-1)).toFixed(4);
  return shares;
}

// Bookings created together — a recurrence, a multi-day span, a multi-facility pick or
// any grouped variant — share a group id so the cart and summary present them as one
// group (the same treatment weekly recurrences already get). Stored as [GRP] id.
export const GRP_RE = /\[GRP\][^\n]*/g;
export function parseGroupRef(sysNotes) { const m=(sysNotes||"").match(/\[GRP\]\s*(\S+)/); return m?m[1]:null; }
export function setGroupRef(sysNotes, id) {
  const base=(sysNotes||"").replace(GRP_RE,"").trim();
  if(!id) return base;
  const marker=`[GRP] ${id}`;
  return base?`${base}\n${marker}`:marker;
}
// Council application details a booker gives with a council booking, stored in
// system_notes as [COUNCIL_INFO] {"players":14,"use":"training","grade":"…","notes":"…"}.
// The council widget reads them for player numbers, training/competition and the
// participant details.
export const CINFO_RE = /\[COUNCIL_INFO\][^\n]*/g;
export function parseCouncilInfo(sysNotes) { const m=(sysNotes||"").match(/\[COUNCIL_INFO\]\s*(\{.*\})/); if(!m) return null; try{ return JSON.parse(m[1]); }catch{ return null; } }
export function setCouncilInfo(sysNotes, info) {
  const base=(sysNotes||"").replace(CINFO_RE,"").trim();
  if(!info) return base;
  const marker=`[COUNCIL_INFO] ${JSON.stringify(info)}`;
  return base?`${base}\n${marker}`:marker;
}
export function newGroupRef() { return "G"+Date.now().toString(36)+Math.random().toString(36).slice(2,5); }

// Compare the billed snapshot to a booking's current dimensions. Returns the
// Day/evening-split cost of a booking-like {start_hour,duration,facility_id} at the
// given facility rates (5:30pm cutoff). Shared by the mismatch view and billed-change
// tracking so both frame credit/deficit identically.
export function bookingCost(v, facilityRates) {
  const CUTOFF=DAY_EVENING_CUTOFF, end=v.start_hour+v.duration;
  const day = v.start_hour>=CUTOFF ? 0 : end>CUTOFF ? CUTOFF-v.start_hour : v.duration;
  const evening = v.duration-day;
  const r=(facilityRates||{})[v.facility_id];
  const rates = !r ? {day:0,evening:0} : typeof r==="object" ? {day:parseFloat(r.day)||0,evening:parseFloat(r.evening)||0} : {day:parseFloat(r)||0,evening:0};
  return day*rates.day + evening*rates.evening;
}
// structured discrepancies (old → new) plus the net hours delta and, when rates are
// supplied, the cost delta vs the billed snapshot (>0 ⇒ deficit owed by the booker,
// <0 ⇒ credit owed to them). Returns null when there is no snapshot / no drift.
export function getBillingDrift(booking, facilityRates) {
  const snap = parseBilledSnapshot(booking.system_notes, booking.notes);
  if (!snap) return null;
  const rows = [];
  if (snap.facility_id !== booking.facility_id)
    rows.push({ label:"Field", old: facShort(snap.facility_id), next: facShort(booking.facility_id) });
  if (snap.start_hour !== booking.start_hour)
    rows.push({ label:"Time", old: fmtTimeShort(snap.start_hour), next: fmtTimeShort(booking.start_hour) });
  if (snap.duration !== booking.duration)
    rows.push({ label:"Dur", old: `${snap.duration}h`, next: `${booking.duration}h` });
  if (!rows.length) return null;
  const out = { rows, hoursDelta: +(booking.duration - snap.duration).toFixed(2), snap, costDelta: null, billedCost: null, currentCost: null };
  if (facilityRates) {
    out.billedCost  = bookingCost(snap, facilityRates);
    out.currentCost = bookingCost(booking, facilityRates);
    out.costDelta   = +(out.currentCost - out.billedCost).toFixed(2);
  }
  return out;
}
export function getSameFacilityOverlaps(draft, others) {
  return others.filter(o => o.facility_id === draft.facility_id && timeOverlaps(draft, o));
}
export function getCrossFacilityOverlaps(draft, others) {
  // Same ground only. This warning says "other parts of this venue are also in use", so a
  // booking at GTEC Orakei tells you nothing about Cornwall Park being busy — listing it
  // was pure noise, and worse on a repeating booking where it multiplied across dates.
  return others.filter(o => o.facility_id !== draft.facility_id
    && sameSite(o.facility_id, draft.facility_id)
    && timeOverlaps(draft, o));
}
export function getClashes(allBookings) {
  // Returns pairs: admin booking overlapping a non-admin booking on same facility (future dates only)
  const today = todayKey();
  const clashes = [];
  const adminBks = allBookings.filter(b => isAdminBooking(b) && b.date >= today);
  const userBks  = allBookings.filter(b => !isAdminBooking(b) && b.date >= today);
  adminBks.forEach(ab => {
    userBks.forEach(ub => {
      if (ab.facility_id === ub.facility_id && timeOverlaps(ab, ub)) {
        // Avoid duplicate pairs
        if (!clashes.find(c => c.admin.id === ab.id && c.user.id === ub.id)) {
          clashes.push({ admin: ab, user: ub });
        }
      }
    });
  });
  return clashes;
}


// ─── EmailJS ──────────────────────────────────────────────────────────────────
// Email is sent server-side by the `send-email` Supabase Edge Function, so NO
// EmailJS credentials ship in the browser bundle. The function authenticates the
// caller's Supabase session (JWT) and holds the EmailJS keys as Supabase secrets.
// If the function isn't reachable/deployed, sending is skipped (never throws).
// The EmailJS template inserts the subject with {{subject}}, which HTML-escapes it, so
// characters like / & ' arrive as codes ("(2&#x2F;4) Queued for GTEC"). Drop the
// "(2/4)" pipeline-step prefix from status labels and swap the rest for characters that
// survive escaping.
export function cleanEmailSubject(subject) {
  return String(subject || "")
    .replace(/\(\d+\s*\/\s*\d+\)\s*/g, "")
    .replace(/\s*\/\s*/g, " - ")
    .replace(/&/g, "and")
    .replace(/'/g, "’")
    .replace(/"/g, "”")
    .replace(/`/g, "’")
    .replace(/=/g, "-")
    .replace(/[<>]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Hard rule: the app emails bookers only ──────────────────────────────────
// Never email vendors, private operators or the council directly. Anything addressed to
// someone who isn't a booker is turned into a draft sent to AMUA's own inbox, with the
// intended recipients listed above the draft, and AMUA follows it up from Gmail. The
// send-email Edge Function applies the same rule server-side as a backstop.
export const AMUA_INBOX = "aucklandmixedultimate@gmail.com";
export let _bookerEmails = new Set();   // every booking's email (and its alias primary), kept in sync by the App
export let _vendorEmails = new Set();   // vendor profile emails: never bookers, even if they appear in bookings
export function isBookerAddress(email) {
  const e = (email || "").trim().toLowerCase(); if (!e) return false;
  if (e === AMUA_INBOX) return true;
  if (_vendorEmails.has(e)) return false;
  return _bookerEmails.has(e) || _bookerEmails.has(_emailAliases[e] || e);
}
export function toAmuaDraft({ to, cc, subject, html }) {
  const list = [to, cc].filter(Boolean).join(", ");
  return { to: AMUA_INBOX, cc: undefined, subject: `[DRAFT for ${list}] ${subject}`,
    html: `<div style="font-family:sans-serif;border:2px dashed #b45309;background:#fffbeb;padding:10px 14px;margin-bottom:14px;border-radius:8px">
      <b>Draft — not sent.</b> AMUA doesn't email vendors, operators or the council from the booking app.<br>
      <b>Intended recipients:</b> ${String(to || "").replace(/</g, "&lt;")}${cc ? `<br><b>Cc:</b> ${String(cc).replace(/</g, "&lt;")}` : ""}<br>
      Review it, then send it from Gmail.</div><hr>${html}` };
}
export async function sendEmail({ to, subject: rawSubject, html, kind = "order", cc }) {
  let subject = cleanEmailSubject(rawSubject);
  // Any non-booker recipient → the whole message becomes a draft to AMUA's inbox.
  const ccIn = cc ?? primaryEmailFor(to);
  if (!isBookerAddress(to) || (cc && !isBookerAddress(cc))) {
    const d = toAmuaDraft({ to, cc, subject, html });
    logActivity("email_redirected_to_amua", { intended: to, cc: cc || null, subject });
    ({ to, html } = d); subject = cleanEmailSubject(d.subject); cc = null;
  } else if (ccIn && !isBookerAddress(ccIn)) cc = null;
  if (!supabase || !_accessToken) {
    console.warn("Email skipped: no Supabase session for", to);
    logActivity("email_failed", { to, subject, error: "no_session" });
    return;
  }
  // When `to` is a linked secondary address, CC the booker's primary email so the
  // main account is kept in the loop. Caller can pass an explicit `cc` to override.
  const ccResolved = cc === null ? undefined : cc ?? primaryEmailFor(to);
  const ccFinal = ccResolved && ccResolved.toLowerCase() !== (to||"").toLowerCase() ? ccResolved : undefined;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${_accessToken}` },
      body: JSON.stringify({ to, subject, html, kind, ...(ccFinal ? { cc: ccFinal } : {}) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      console.warn(`send-email ${res.status}:`, body);
      logActivity("email_failed", { to, subject, status: res.status });
    } else {
      logActivity("email_sent", { to, subject, ...(ccFinal ? { cc: ccFinal } : {}) });
    }
  } catch (e) {
    console.error("Email network error:", e);
    logActivity("email_failed", { to, subject, error: String(e?.message || e) });
  }
}
export async function sendApprovalEmail({ to, subject, html }) {
  return sendEmail({ to, subject, html, kind: "approval" });
}

// Public links surfaced to bookers (the live GTEC field calendar and the GTEC field
// hire request form). Also shown in the in-app Help tab.
export const GTEC_CALENDAR_URL = "https://www.carltonjuniorsrugby.co.nz/venue-hire-fields-1/field-calendar";
export const GTEC_FORM_URL = "https://www.grammartec.co.nz/viewform/499414";
// Reusable "useful links" block for booker-facing emails — links the GTEC calendar
// and the field hire request form so bookers can cross-check and self-serve.
export function emailLinksBlock() {
  return `<div style="margin-top:20px;padding:14px 16px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px">
    <div style="font-size:10px;font-weight:700;color:#0369a1;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">Useful links</div>
    <div style="font-size:13px;line-height:2">
      <a href="${GTEC_CALENDAR_URL}" target="_blank" style="color:#0369a1;font-weight:600;text-decoration:none">📅 GTEC field calendar ↗</a><br/>
      <a href="${GTEC_FORM_URL}" target="_blank" style="color:#0369a1;font-weight:600;text-decoration:none">📝 GTEC field hire request form ↗</a>
    </div>
  </div>`;
}

// Build HTML for booking confirmation email
export function buildOrderEmailHtml({ name, email, bookings: bkgs=[], deletedBookings=[], orderRef=null, isDeletionOnly=false }) {
  const hasAdded   = bkgs.length > 0;
  const hasDeleted = deletedBookings.length > 0;

  function tableRows(items, textColor="#0f172a", borderColor="#f1f5f9") {
    return items.map(b => {
      const f = FACILITIES.find(x=>x.id===b.facility_id);
      return `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor};font-weight:600">${f?.name||b.facility_id}</td>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor}">${fmtDate(b.date)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor};white-space:nowrap">${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor}">${b.purpose||""}</td>
      </tr>`;
    }).join("");
  }

  function tableBlock(items, headerBg, headerText, borderColor, textColor) {
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${borderColor};border-radius:10px;overflow:hidden;margin-bottom:0">
      <thead><tr style="background:${headerBg}">
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Facility</th>
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Date</th>
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Time</th>
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Purpose</th>
      </tr></thead>
      <tbody>${tableRows(items, textColor, borderColor)}</tbody>
    </table>`;
  }

  const headerBg   = isDeletionOnly ? "linear-gradient(135deg,#5c0a0a 0%,#7f1d1d 100%)" : "linear-gradient(135deg,#1e3a1e 0%,#2d5a2d 100%)";
  const headerIcon = isDeletionOnly ? "🗑" : "📋";
  const headerTitle= isDeletionOnly ? `Booking${deletedBookings.length>1?"s":""} Removed` : "Booking Request Received";
  const headerSub  = isDeletionOnly
    ? `${deletedBookings.length} booking${deletedBookings.length>1?"s have":" has"} been permanently removed.`
    : "Your request has been submitted and is awaiting admin review.";
  const refBlock   = orderRef ? `<div style="background:rgba(255,255,255,0.15);border-radius:8px;padding:9px 14px;text-align:center;white-space:nowrap"><div style="font-size:9px;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">Ref</div><div style="font-size:12px;font-weight:800;color:#fff;font-family:monospace">${orderRef}</div></div>` : "";

  const addedSection = hasAdded ? `
    <div style="font-size:10px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:0.1em;margin:24px 0 10px">✅ Added Bookings (${bkgs.length})</div>
    ${tableBlock(bkgs,"#f0fdf4","#166534","#bbf7d0","#14532d")}
    <div style="margin-top:14px;padding:13px 16px;background:#fefce8;border:1px solid #fde68a;border-radius:8px;font-size:13px;color:#92400e">
      ⏳ Your bookings are <strong>pending approval</strong>. You'll receive a follow-up email once reviewed.
    </div>` : "";

  const deletedSection = hasDeleted ? `
    <div style="font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:0.1em;margin:${hasAdded?"20px":"24px"} 0 10px">🗑 Removed Bookings (${deletedBookings.length})</div>
    ${tableBlock(deletedBookings,"#fef2f2","#991b1b","#fecaca","#7f1d1d")}
    <div style="margin-top:14px;padding:13px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#991b1b">
      These bookings have been <strong>permanently removed</strong>. If you believe this was an error, please contact the facility administrator.
    </div>` : "";

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px"><tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.10)">
  <tr><td style="background:${headerBg};padding:32px 36px 28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.14em;margin-bottom:8px">FacilityBook</div>
        <div style="font-size:24px;font-weight:800;color:#fff;line-height:1.25">${headerIcon} ${headerTitle}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:6px;line-height:1.5">${headerSub}</div>
      </td>
      ${refBlock ? `<td align="right" valign="top" style="padding-left:16px">${refBlock}</td>` : ""}
    </tr></table>
  </td></tr>
  <tr><td style="padding:28px 36px">
    <p style="margin:0 0 4px;font-size:15px;color:#334155">Hi <strong style="color:#0f172a">${name}</strong>,</p>
    ${addedSection}
    ${deletedSection}
    ${hasAdded?emailLinksBlock():""}
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">If you have questions, please contact the facility administrator directly.</p>
  </td></tr>
  <tr><td style="padding:14px 36px 20px;background:#f8fafc;font-size:11px;color:#94a3b8;text-align:center">FacilityBook · Automated notification · ${email}</td></tr>
</table>
</td></tr></table></body></html>`;
}

// Build HTML for approval/rejection/status notification
export function buildApprovalEmailHtml({ name, email, bookings: bkgs, newStatus, adminNote }) {
  const isApproved = newStatus === "approved";
  const isQueued = newStatus === "queued_cpsa" || newStatus === "amua_submit";
  const isCpsaConfirmed = newStatus === "cpsa_confirmed";
  const isCpsaReview = newStatus === "cpsa_review_needed";
  const color = isApproved ? "#22c55e" : isCpsaConfirmed ? "#0891b2" : isQueued ? "#3b82f6" : isCpsaReview ? "#d97706" : "#f43f5e";
  const vendor = vendorShortFor(bkgs[0]?.facility_id);
  const label = isApproved ? "Approved ✓" : isCpsaConfirmed ? `Confirmed by ${vendor} ✓` : isQueued ? `Queued for ${vendor} review` : isCpsaReview ? `Needs review — ${vendor} mismatch` : "Rejected ✗";
  const bodyText = isApproved
    ? "Great news — your booking request has been approved!"
    : isCpsaConfirmed
    ? `Good news — ${vendor} has confirmed your booking. The details on ${vendor}'s schedule match what you booked, so nothing further is needed.`
    : isQueued
    ? `Your booking request has been reviewed by AMUA and is now queued to be submitted to ${vendor} for final approval. We'll notify you once a decision has been made.`
    : isCpsaReview
    ? `The details ${vendor} holds for your booking currently differ from your original request. AMUA is clarifying this with ${vendor} — nothing is final yet, and we'll do our best to align it to your original request.`
    : "We're sorry — your booking request could not be approved.";
  const rows = bkgs.map(b => {
    const f = FACILITIES.find(x=>x.id===b.facility_id);
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${f?.name||b.facility_id}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${fmtDate(b.date)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${b.purpose}</td>
    </tr>`;
  }).join("");
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <tr><td style="background:${color};padding:28px 32px">
    <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.02em">Booking ${label}</div>
  </td></tr>
  <tr><td style="padding:28px 32px">
    <p style="margin:0 0 6px;font-size:15px;color:#0f172a">Hi <strong>${name}</strong>,</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6">${bodyText}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f1f5f9;border-radius:10px;overflow:hidden">
      <thead><tr style="background:#f8fafc">
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Facility</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Date</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Time</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Purpose</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${adminNote?`<div style="margin-top:16px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#475569"><strong>Note from admin:</strong> ${adminNote}</div>`:""}
    ${emailLinksBlock()}
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">If you have questions, please contact the facility manager.</p>
  </td></tr>
  <tr><td style="padding:16px 32px 24px;background:#f8fafc;font-size:11px;color:#94a3b8;text-align:center">FacilityBook · Sent to ${email}</td></tr>
</table></td></tr></table></body></html>`;
}

// Rich CPSA-mismatch email shown to the booker: each booking's booked → CPSA
// diff plus reassurance that AMUA is clarifying with CPSA. Single source of truth
// shared by the manual "Notify affected users" action and the automatic sync
// notification, so both read identically.
export function buildMismatchEmailHtml({ name, email, bookings: bkgs }) {
  const rows = bkgs.map(b => {
    const fac = FACILITIES.find(x => x.id === b.facility_id);
    const reasons = parseMismatchNote(b.system_notes, b.notes);
    const cv = extractCpsaAmendValues(reasons, b);
    const cfac = FACILITIES.find(x => x.id === cv.facility_id);
    const facNote = b.facility_id !== cv.facility_id ? " (" + (cfac?.name || cv.facility_id) + ")" : "";
    return "<tr>"
      + "<td style='padding:6px 8px'>" + (b.purpose || "Booking") + "</td>"
      + "<td style='padding:6px 8px'>" + (fac?.name || b.facility_id) + "</td>"
      + "<td style='padding:6px 8px'>" + fmtDate(b.date) + "</td>"
      + "<td style='padding:6px 8px'><span style='text-decoration:line-through;color:#94a3b8'>" + fmtTime(b.start_hour) + "–" + fmtTime(b.start_hour + b.duration) + "</span> → <span style='color:#a16207;font-weight:700'>" + fmtTime(cv.start_hour) + "–" + fmtTime(cv.start_hour + cv.duration) + facNote + "</span></td>"
      + "<td style='padding:6px 8px;color:#64748b'>" + reasons.join("; ") + "</td>"
      + "</tr>";
  }).join("");
  return "<div style='font-family:sans-serif;max-width:640px'>"
    + "<h2 style='color:#b45309'>⚡ GTEC Booking Mismatch — Please Review</h2>"
    + "<p>Hi " + (name || email) + ",</p>"
    + "<p>The details GTEC holds for the following booking(s) currently differ from your original request. We're clarifying these with GTEC, so nothing is final yet.</p>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;border:1px solid #fde68a'><thead><tr style='background:#fef3c7'><th style='padding:8px;text-align:left'>Booking</th><th style='padding:8px'>Field</th><th style='padding:8px'>Date</th><th style='padding:8px'>Booked → GTEC</th><th style='padding:8px'>Changes</th></tr></thead><tbody>" + rows + "</tbody></table>"
    + "<p>AMUA will do its best to align each booking to your original request as closely as it can. If the booked time ends up reduced, the difference will be credited against a future invoice. If you have any questions, just reply to this email and we'll follow up.</p>"
    + "<p style='color:#64748b;font-size:12px'>Automated notification from FacilityBook – AMUA.</p></div>";
}

// Email to a vendor (e.g. a CPSA contact) asking them to correct CPSA's schedule
// so it matches AMUA's record. Carries the booking's CPSA submission link(s) and
// a notification reference. Sent by the "Inform CPSA" action; does not change the
// booking.
export function buildInformCpsaEmailHtml({ vendorName, booking, refs = [], submissionId }) {
  const fac = FACILITIES.find(x => x.id === booking.facility_id);
  const reasons = parseMismatchNote(booking.system_notes, booking.notes);
  const cv = extractCpsaAmendValues(reasons, booking);
  const cfac = FACILITIES.find(x => x.id === cv.facility_id);
  const facNote = booking.facility_id !== cv.facility_id ? " — GTEC shows " + (cfac?.name || cv.facility_id) : "";
  const reasonRows = reasons.length
    ? reasons.map(r => { const p = splitReason(r); return "<tr><td style='padding:4px 8px;font-weight:600;color:#0f172a'>" + p.label + "</td><td style='padding:4px 8px;color:#15803d;font-weight:700'>AMUA: " + (p.old || "—") + "</td><td style='padding:4px 8px;color:#b45309'>GTEC now: " + (p.next || "—") + "</td></tr>"; }).join("")
    : "<tr><td colspan='3' style='padding:4px 8px;color:#64748b'>See booking details above.</td></tr>";
  const linkRows = refs.length
    ? refs.map(r => "<div style='margin:4px 0'><a href='" + r.url + "' style='color:#0369a1;font-weight:600'>" + (r.ref || "View on Sporty") + " ↗</a> <span style='color:#94a3b8;font-size:12px'>" + fmtRefDate(r.date || "") + "</span></div>").join("")
    : "<div style='color:#64748b;font-size:13px'>No GTEC submission link is on file for this booking.</div>";
  return "<div style='font-family:sans-serif;max-width:640px'>"
    + "<h2 style='color:#0369a1'>GTEC Booking Discrepancy — Correction Requested</h2>"
    + "<p>Hi " + (vendorName || "there") + ",</p>"
    + "<p>AMUA's record for the booking below differs from what GTEC currently holds. Please review and correct GTEC's schedule to match our record (the <strong>AMUA</strong> values).</p>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;border:1px solid #e2e8f0'><tbody>"
    + "<tr><td style='padding:6px 8px;color:#64748b;width:96px'>Booker</td><td style='padding:6px 8px;color:#0f172a'>" + (booking.name || "") + "</td></tr>"
    + "<tr><td style='padding:6px 8px;color:#64748b'>Field</td><td style='padding:6px 8px;color:#0f172a'>" + (fac?.name || booking.facility_id) + facNote + "</td></tr>"
    + "<tr><td style='padding:6px 8px;color:#64748b'>Date</td><td style='padding:6px 8px;color:#0f172a'>" + fmtDate(booking.date) + "</td></tr>"
    + "<tr><td style='padding:6px 8px;color:#64748b'>Time (AMUA)</td><td style='padding:6px 8px;color:#0f172a;font-weight:700'>" + fmtTime(booking.start_hour) + "–" + fmtTime(booking.start_hour + booking.duration) + " (" + booking.duration + "h)</td></tr>"
    + "</tbody></table>"
    + "<div style='font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin:14px 0 4px'>Discrepancies</div>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0'><tbody>" + reasonRows + "</tbody></table>"
    + "<div style='font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin:14px 0 4px'>GTEC record</div>"
    + linkRows
    + (submissionId ? "<p style='color:#94a3b8;font-size:12px;margin-top:14px'>Reference: " + submissionId + "</p>" : "")
    + "<p style='color:#64748b;font-size:12px'>Sent from FacilityBook – AMUA.</p></div>";
}

// Room request to CPSA / GTEC for the Meeting Room or Function Room (vendor mail: sendEmail
// turns it into a draft in AMUA's inbox with the recipients listed, per the email rule).
export function buildRoomRequestEmailHtml({ vendorName, bookings, ref, players = {} }) {
  const rows = bookings.map(b => {
    const fac = FACILITIES.find(x => x.id === b.facility_id);
    const n = players[(b.email || "").toLowerCase()];
    return "<tr>"
      + "<td style='padding:6px 8px;border-top:1px solid #e2e8f0;font-weight:600;color:#0f172a'>" + (fac?.name || b.facility_id) + "</td>"
      + "<td style='padding:6px 8px;border-top:1px solid #e2e8f0'>" + fmtDate(b.date) + "</td>"
      + "<td style='padding:6px 8px;border-top:1px solid #e2e8f0'>" + fmtTime(b.start_hour) + "–" + fmtTime(b.start_hour + b.duration) + "</td>"
      + "<td style='padding:6px 8px;border-top:1px solid #e2e8f0'>" + (b.purpose || "") + (n ? " · about " + n + " people" : "") + "</td>"
      + "</tr>";
  }).join("");
  return "<div style='font-family:sans-serif;max-width:640px'>"
    + "<h2 style='color:#7c3aed'>Room booking request</h2>"
    + "<p>Hi " + (vendorName || "there") + ",</p>"
    + "<p>AMUA would like to book the following at Cornwall Park. Could you please confirm availability, and let us know of any setup or access requirements?</p>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;border:1px solid #e2e8f0'>"
    + "<thead><tr style='background:#f8fafc;color:#64748b;text-align:left'><th style='padding:6px 8px'>Room</th><th style='padding:6px 8px'>Date</th><th style='padding:6px 8px'>Time</th><th style='padding:6px 8px'>For</th></tr></thead>"
    + "<tbody>" + rows + "</tbody></table>"
    + "<p>" + amuaContactLine() + "</p>"
    + (ref ? "<p style='color:#94a3b8;font-size:12px'>Reference: " + ref + "</p>" : "")
    + "<p style='color:#64748b;font-size:12px'>Sent from FacilityBook – AMUA.</p></div>";
}

// Scheduling-clash email shown to a booker whose booking overlaps an admin/field
// reservation. Top-level so the cart outbox can send it on submit.
export function buildClashEmailHtml({ name, email, clashes }) {
  const rows = (clashes || []).map(c => {
    const f = FACILITIES.find(x => x.id === c.admin.facility_id);
    return "<tr><td style='padding:6px 8px'>" + (c.admin.purpose || "Admin booking") + "</td><td style='padding:6px 8px'>" + (f?.name || "") + "</td><td style='padding:6px 8px'>" + fmtDate(c.admin.date) + "</td><td style='padding:6px 8px'>" + fmtTime(c.admin.start_hour) + "–" + fmtTime(c.admin.start_hour + c.admin.duration) + "</td><td style='padding:6px 8px'>" + (c.user.purpose || "Your booking") + "</td></tr>";
  }).join("");
  return "<div style='font-family:sans-serif;max-width:600px'>"
    + "<h2 style='color:#9f1239'>⚠️ Scheduling Clash Notice</h2>"
    + "<p>Hi " + (name || email) + ",</p>"
    + "<p>One or more of your bookings at Cornwall Park clash with scheduled field bookings on the same facility at the same time.</p>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;border:1px solid #f1f5f9'><thead><tr style='background:#f8fafc'><th style='padding:8px;text-align:left'>Field Booking</th><th style='padding:8px'>Facility</th><th style='padding:8px'>Date</th><th style='padding:8px'>Time</th><th style='padding:8px'>Your Booking</th></tr></thead><tbody>" + rows + "</tbody></table>"
    + "<p>Please contact AMUA to discuss rescheduling.</p>"
    + "<p style='color:#64748b;font-size:12px'>Automated notification from FacilityBook – AMUA.</p></div>";
}

export const S = {
  inp:  {width:"100%",padding:"9px 12px",borderRadius:8,border:"1.5px solid #e2e8f0",fontSize:14,color:"#0f172a",background:"#f8fafc",outline:"none",boxSizing:"border-box",fontFamily:"inherit"},
  lbl:  {display:"block",fontSize:12,fontWeight:600,color:"#64748b",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"},
  btn:  (x={})=>({padding:"8px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:13,fontWeight:600,fontFamily:"inherit",...x}),
  card: {background:"#fff",borderRadius:16,border:"1px solid #f1f5f9",padding:24,boxShadow:"0 1px 8px rgba(0,0,0,0.04)"},
};

// ─── Google Sign-In ───────────────────────────────────────────────────────────
export function EmailLoginScreen() {
  const [busy, setBusy] = useState(false);
  async function signIn() {
    if (!supabase) return;
    setBusy(true);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
    });
  }
  return (
    <div style={{minHeight:"100vh",background:"#f8fafc",display:"flex",alignItems:"center",justifyContent:"center",padding:16,fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif"}}>
      <div style={{background:"#fff",borderRadius:20,padding:40,maxWidth:400,width:"100%",boxShadow:"0 8px 40px rgba(0,0,0,0.10)",border:"1px solid #f1f5f9"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:28}}>
          <img src={LOGO_SRC} alt="AMUA" style={{width:48,height:48,borderRadius:10,objectFit:"cover"}}/>
          <div>
            <div style={{fontSize:20,fontWeight:800,color:"#0f172a",letterSpacing:"-0.02em"}}>FacilityBook</div>
            <div style={{fontSize:13,color:"#64748b"}}>Sign in to manage bookings</div>
          </div>
        </div>
        <button onClick={signIn} disabled={busy} style={S.btn({width:"100%",padding:"11px",background:"#2d4a1e",color:"#fff",fontSize:14,opacity:busy?0.7:1,cursor:busy?"wait":"pointer"})}>
          {busy ? "Redirecting…" : "Sign in with Google"}
        </button>
        <p style={{marginTop:16,fontSize:12,color:"#94a3b8",textAlign:"center",lineHeight:1.5}}>Only authorised Google accounts can access this system.</p>
      </div>
    </div>
  );
}

// ─── Small UI atoms ───────────────────────────────────────────────────────────
// Status pill. With the booking's workflow (`wf`), the label carries its step in that
// workflow, e.g. "(3/6)" at a privately operated council ground; the operator-only steps are
// numbered in the council + operator workflow even without it.
// The provider named in a facility's vendor stages: "GTEC", "St Cuthbert's", a school…
export function vendorShortFor(facilityId) {
  const f = FACILITIES.find(x => x.id === facilityId); if (f?.vendor) return f.vendor;   // e.g. the rooms: CPSA
  const p = PROVIDERS[providerOfFacility(facilityId)];
  return p?.short || p?.label || p?.name || "vendor";
}
// A status label for a booking: vendor stages name its facility's provider.
export function statusLabelFor(status, facilityId, vendor) {
  const m = STATUS_META[status] || STATUS_META.pending_amua;
  const v = vendor || (facilityId ? vendorShortFor(facilityId) : null);
  return m.tpl && v ? m.tpl.replace("{vendor}", v) : m.label;
}
export function stepLabel(status, wf, facilityId, vendor) {
  const label = statusLabelFor(status, facilityId, vendor), bare = label.replace(/^\(\d+\/\d+\)\s*/, "");
  const w = wf && WORKFLOW_STEPS[wf]?.includes(status === "pending" ? "pending_amua" : status) ? wf
    : ["op_permission","op_confirm"].includes(status) ? "council_private" : null;
  if (!w || (w === "gtec" && !wf)) return label;
  const steps = WORKFLOW_STEPS[w], i = steps.indexOf(status === "pending" ? "pending_amua" : status);
  return `(${i + 1}/${steps.length}) ${bare}`;
}
export function Badge({status, wf, fid, vendor}) {
  const m={...(STATUS_META[status]||STATUS_META.pending_amua), label: stepLabel(status, wf, fid, vendor)};
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"2px 10px",borderRadius:999,background:m.bg,border:`1px solid ${m.border}`,color:m.text,fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}><span style={{width:6,height:6,borderRadius:"50%",background:m.dot,display:"inline-block"}}/>{m.label}</span>;
}
// Grouped (the schedule summary) / Itemised (one row per booking) — the same switch on the
// Bookings and Admin tables, styled like Billing's view switch. Remembered per table.
export function useTableView(key) {
  const [v, setV] = useState(() => { try { return localStorage.getItem(key) || "grouped"; } catch { return "grouped"; } });
  return [v, nv => { setV(nv); try { localStorage.setItem(key, nv); } catch { /* ignore */ } }];
}
export function TableViewToggle({ value, onChange, children }) {
  const opt = (k, l, t) => (
    <button key={k} onClick={() => onChange(k)} title={t} aria-pressed={value === k}
      style={{padding:"3px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",
        borderColor:value===k?"#0f172a":"#e2e8f0",background:value===k?"#0f172a":"#fff",color:value===k?"#fff":"#475569"}}>{l}</button>);
  return (
    <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 10px",background:"#f8fafc",borderRadius:8,fontSize:11,flexWrap:"wrap",marginBottom:10}}>
      <span style={{color:"#64748b",fontWeight:600,whiteSpace:"nowrap"}}>View:</span>
      {opt("grouped", "Grouped", "Bookings grouped by booker and recurring pattern (the schedule summary)")}
      {opt("itemised", "Itemised", "Every booking as its own row")}
      {children}
    </div>
  );
}
// Vendors present in a set of bookings (for a vendor filter), most common first.
export function vendorsIn(bookings) {
  const n = {}; bookings.forEach(b => { const v = vendorShortFor(b.facility_id); n[v] = (n[v] || 0) + 1; });
  return Object.keys(n).sort((a, b) => n[b] - n[a] || a.localeCompare(b));
}
export function EmailChip({email}) {
  const c=emailColor(email);
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:999,background:c+"18",border:`1px solid ${c}44`,color:c,fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{email||"unknown"}</span>;
}
// side: on desktop, open as a panel on the right (the list behind stays visible).
export function Modal({title,onClose,children,width=560,side=false}) {
  const isMobile = useMobile();
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape"){ e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[onClose]);
  return (
    <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1000,padding:"0",backdropFilter:"blur(2px)"}}
      className={side?"modal-backdrop side":"modal-backdrop"} onMouseDown={e=>{ if(side&&e.target===e.currentTarget) onClose(); }}>
      <div style={{background:"#fff",borderRadius:"16px 16px 0 0",width:"100%",maxWidth:width,maxHeight:"92vh",display:"flex",flexDirection:"column",boxShadow:"0 -8px 40px rgba(0,0,0,0.2)"}}
        onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:isMobile?"12px 14px 10px":"20px 24px 16px",borderBottom:"1px solid #f1f5f9",flexShrink:0}}>
          <h2 style={{margin:0,fontSize:isMobile?16:18,fontWeight:700,color:"#0f172a"}}>{title}</h2>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"#94a3b8",lineHeight:1,padding:4}}>✕</button>
        </div>
        <div style={{padding:isMobile?14:24,flex:1,minHeight:0,display:"flex",flexDirection:"column",overflowY:"auto",overflowX:"hidden"}}>{children}</div>
      </div>
    </div>
  );
}
// ─── Activity-log presentation helpers ───────────────────────────────────────
// Friendly action names + a human-readable summary, so the log reads as plain
// English instead of raw JSON like {"ids":[...],"count":1}.
export const ACTIVITY_ADMIN_ACTIONS = new Set([
  "cpsa_sync_start","cpsa_sync_complete","cpsa_confirm","cpsa_review_flag",
  "cpsa_admin_booking_add","cpsa_admin_booking_remove","cpsa_admin_convert","mismatch_resolution",
  "mismatch_billing_settled","status_change","invoiced","official_invoice_created",
  "invoice_preview_emailed","official_invoice_emailed","slot_shared","slot_merged","slot_unlinked","drive_upload","drive_attach",
  "settings_change","council_mail_sync","council_application_linked",
]);
export const ACTIVITY_LABELS = {
  booking_create:"Booking created", booking_edit:"Booking edited", booking_delete:"Booking deleted",
  status_change:"Status changed", cpsa_sync_start:"Sync started", cpsa_sync_complete:"Sync completed",
  council_mail_sync:"Council emails synced", council_application_linked:"Council application linked",
  cpsa_confirm:"GTEC confirmed", cpsa_review_flag:"Mismatch flagged",
  cpsa_admin_booking_add:"GTEC block added", cpsa_admin_booking_remove:"GTEC block removed",
  cpsa_admin_convert:"GTEC block converted",
  mismatch_resolution:"Mismatch resolved", mismatch_billing_settled:"Billing settled",
  invoiced:"Invoiced", official_invoice_created:"Invoice created",
  invoice_preview_emailed:"Invoice preview emailed", official_invoice_emailed:"Invoice emailed",
  slot_shared:"Slot shared with a team", slot_merged:"Bookings merged into one slot", slot_unlinked:"Removed from a shared slot",
  drive_upload:"Saved to Drive", drive_attach:"GTEC invoice attached",
  email_sent:"Email sent", email_failed:"Email failed", sign_in:"Signed in", sign_out:"Signed out",
  settings_change:"Settings changed", council_fields:"Council fields", council_application_sent:"Sent to council",
  vetting_change:"Vetting change", client_error:"App error", backup_downloaded:"Backup taken",
};
// What non-admins see of the log: bookers' own activity (the activity_log select policy in
// supabase-setup.sql allows the same), not sign-ins, emails or admin work.
export const ACTIVITY_PUBLIC_ACTIONS = new Set(["booking_create","booking_edit","booking_delete","slot_shared","slot_merged","slot_unlinked","council_fields"]);
// Who performed the action: explicit stamp from logActivity, else best-effort by action.
export function activityActor(r) {
  const by = r.detail?.by;
  if (by === "admin" || by === "booker") return by;
  return ACTIVITY_ADMIN_ACTIONS.has(r.action) ? "admin" : "booker";
}
export function activityFacName(fid) { const f = FACILITIES.find(x=>x.id===fid); return f ? f.name : (fid||"?"); }
export function activitySlot(it) {
  if (!it || !it.date) return "";
  const t = (typeof it.start_hour==="number") ? ` ${fmtTime(it.start_hour)}–${fmtTime(it.start_hour+(it.duration||0))}` : "";
  return `${fmtDateShort(it.date)}${t} · ${activityFacName(it.facility_id)}`;
}
export function activityItemsSummary(items, count) {
  const n = count || (items?items.length:0);
  if (!items || !items.length) return n ? `${n} booking${n!==1?"s":""}` : "";
  const head = items.slice(0,3).map(activitySlot).filter(Boolean).join("; ");
  const extra = n - Math.min(3, items.length);
  return head + (extra>0 ? ` +${extra} more` : "");
}
export function describeActivity(r) {
  const d = r.detail || {};
  const statusLabel = s => (STATUS_META[s]?.label || s || "").replace(/^\(\d\/\d\)\s*/,"");
  switch (r.action) {
    case "booking_create": return `Created ${activityItemsSummary(d.items,d.count)}${d.gtecQueued?` · ${d.gtecQueued} already queued for GTEC`:""}`;
    case "booking_edit":   return `Edited ${activityItemsSummary(d.items,d.count)}${d.gtecQueued?` · ${d.gtecQueued} queued for GTEC — may need GTEC notice`:""}`;
    case "booking_delete": return `Deleted ${activityItemsSummary(d.items,d.count)}${d.gtecPurge?` · ${d.gtecPurge} need GTEC purge`:""}`;
    case "status_change":  return `Set ${d.count||d.ids?.length||0} booking${(d.count||d.ids?.length)!==1?"s":""} → ${statusLabel(d.to)}`;
    case "cpsa_sync_start":    return `Started GTEC sync${d.months?` · ${d.months} month${d.months!==1?"s":""}`:""}`;
    case "cpsa_sync_complete": return `Completed GTEC sync${d.months?` · ${d.months} month${d.months!==1?"s":""}`:""}`;
    case "cpsa_confirm":     return "Confirmed a booking against GTEC";
    case "cpsa_review_flag": return `Flagged a GTEC mismatch${d.reasons?.length?` · ${d.reasons.join(", ")}`:""}`;
    case "cpsa_admin_booking_add":    return `Added GTEC block · ${activitySlot(d)}${d.purpose?` · ${d.purpose}`:""}`;
    case "cpsa_admin_booking_remove": return `Removed GTEC block · ${d.date?fmtDateShort(d.date):""} · ${activityFacName(d.facility_id)}${d.purpose?` · ${d.purpose}`:""}`;
    case "cpsa_admin_convert": return `Converted GTEC block → AMUA booking · ${d.to||""} · ${activitySlot(d)}`;
    case "mismatch_resolution":     return d.resolution==="swapped"&&d.swap_to ? `Reassigned mismatch · ${d.swap_from||"?"} → ${d.swap_to}` : `Resolved mismatch · ${d.resolution||""}${d.billing_state&&d.billing_state!=="none"?` (${d.billing_state})`:""}`;
    case "mismatch_billing_settled":return `Settled mismatch billing${d.billing_state?` · ${d.billing_state}`:""}`;
    case "invoiced":                return `Marked ${d.count||d.ids?.length||0} booking${(d.count||d.ids?.length)!==1?"s":""} invoiced`;
    case "official_invoice_created":return `Created official invoice · ${d.count||0} item${d.count!==1?"s":""}`;
    case "invoice_preview_emailed": return `Emailed ${d.count||0} unofficial invoice preview${d.count!==1?"s":""}${d.recipients?.length?` · ${d.recipients.join(", ")}`:""}`;
    case "slot_shared":   return `Shared a slot with ${d.added||"a team"} · ${activitySlot(d)} · now ${d.members||2} teams`;
    case "slot_merged":   return `Merged ${d.members||2} bookings into one shared slot · ${activitySlot(d)}`;
    case "slot_unlinked": return `Removed a booking from a shared slot · ${d.remaining||0} team${d.remaining!==1?"s":""} remain`;
    case "official_invoice_emailed": return `Emailed ${d.documents||0} official invoice${d.documents!==1?"s":""} in ${d.emails||0} email${d.emails!==1?"s":""}${d.recipients?.length?` · ${d.recipients.join(", ")}`:""}`;
    case "drive_upload": return `Saved ${d.doc||"document"} to Drive${d.reason==="status_change"?" · status update":d.reason==="manual"?" · manual sync":""}`;
    case "drive_attach": return `Attached ${d.file||"file"} · Invoice (from GTEC)`;
    case "email_sent":   return `→ ${d.to||""}${d.subject?` · ${d.subject}`:""}`;
    case "email_failed": return `→ ${d.to||""}${d.subject?` · ${d.subject}`:""}`;
    case "council_fields": return [d.added?.length&&`Added ${d.added.join("; ")}`, d.activated?.length&&`Made active ${d.activated.join("; ")}`,
      d.removed?.length&&`Removed ${d.removed.join("; ")}`, d.retired?.length&&`Retired ${d.retired.join("; ")}`].filter(Boolean).join(" · ")
      + (d.booker&&d.booker!==r.user_email?.toLowerCase()?` · for ${d.booker}`:"");
    case "vetting_change": return `${{review:"Fields",flag:"Vendor",rating:"Quality"}[d.kind]||d.kind} · ${d.park||""}${d.status==="rejected"?" · ✕ rejected":""}`;
    case "client_error": return `${d.message||"Error"}${d.where?` · ${d.where}`:""}`;
    case "sign_in":  return d.email ? `${d.email}` : "Signed in";
    case "sign_out": return "Signed out";
    default: { const { by, ...rest } = d; void by; return Object.keys(rest).length ? JSON.stringify(rest) : ""; }
  }
}

// Module state the App keeps in sync. Other modules can't assign these variables directly
// (imports are read-only), so they pass changes here.
export function setModuleState(patch) {
  if ("_accessToken" in patch) _accessToken = patch._accessToken;
  if ("_currentUser" in patch) _currentUser = patch._currentUser;
  if ("_emailAliases" in patch) _emailAliases = patch._emailAliases;
  if ("_errorsLogged" in patch) _errorsLogged = patch._errorsLogged;
  if ("_isAdminView" in patch) _isAdminView = patch._isAdminView;
  if ("_bookerContacts" in patch) _bookerContacts = patch._bookerContacts;
  if ("_eci" in patch) _eci = patch._eci;
  if ("_emailColorOverrides" in patch) _emailColorOverrides = patch._emailColorOverrides;
  if ("_contactReviews" in patch) _contactReviews = patch._contactReviews;
  if ("_activeVenue" in patch) _activeVenue = patch._activeVenue;
  if ("_bookerEmails" in patch) _bookerEmails = patch._bookerEmails;
  if ("_vendorEmails" in patch) _vendorEmails = patch._vendorEmails;
  if ("_hiddenFacs" in patch) _hiddenFacs = patch._hiddenFacs;
}
