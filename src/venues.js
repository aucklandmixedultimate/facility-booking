// Venue rules shared by All Auckland fields (src/vetting/main.js) and the booking site:
// how a park or private venue is scored, who owns it, which vendor books it, and the
// facility entries a venue offers. Pure functions over the data in public/council-maps
// (parks.json, private-managed.json) and the field_reviews / field_ratings tables.

export const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Private ownership (a school, club or trust's own ground) vs private operation (a council
// park a club runs).
export const ownedPriv = o => o.ownership === "private" || o.category === "community";

// Overall suitability, 0 (unusable) … 1 (ideal); null when not rated yet. `quality` is the
// crowd average of 1–5 stars when there is one, else the reviewer's own quality. Rejecting is
// a per-profile choice, so a reviewer's Reject doesn't zero it.
export function suitScore(r, quality = r?.quality || null) {
  if (!r || r.decision === "rating") return null;
  if (r.fit === "no") return 0;
  let s = quality ? quality / 5 : 0.5;
  s += { multi: 0.2, full: 0.1, reduced: -0.15, no: -0.3 }[r.fit] || 0;
  if (r.lights === "full" || r.lights === "training") s += 0.1;
  if (r.decision === "top") s += 0.15;
  return Math.max(0.05, Math.min(1, s));
}
export const suitWord = s => s === null ? "Not rated" : s === 0 ? "Unusable" : s >= 0.85 ? "Excellent" : s >= 0.65 ? "Good" : s >= 0.45 ? "Fair" : "Poor";

// The operator that runs a council park (a club, trust or CCO), if any: not an ultimate
// club that only plays there, unless bookings must go through it. `ops` = the park's
// operators that apply (none when the park is marked council-only).
const managerOf = ops => ops.find(o => o.code !== "ultimate") || ops.find(o => o.booking_only);

// Who owns or runs a venue:
//   council         a council park the council books
//   club_council    a council park a club, trust or CCO runs (ask them first)
//   school          a school's own ground
//   private_ground  a club's or trust's own ground (not council land)
// `p.venue` is set on venues that aren't council parks (see opVenues).
export const OWNER_TYPES = [
  { id: "council", icon: "🏛", label: "Council-run", title: "Council parks the council books" },
  { id: "club_council", icon: "◆", label: "Club-run park", title: "Council parks a club, trust or CCO runs (ask them first)" },
  { id: "school", icon: "🏫", label: "School", title: "Schools' own grounds" },
  { id: "private_ground", icon: "🏟", label: "Club / trust ground", title: "Grounds a club or trust owns (not council land)" },
];
export function ownerType(p, ops = []) {
  if (p.venue) return p.venue.type === "school" ? "school" : "private_ground";
  return managerOf(ops) ? "club_council" : "council";
}
export const ownerTypeMeta = id => OWNER_TYPES.find(t => t.id === id) || OWNER_TYPES[0];

// Who a venue is booked with, as the booking site's vendor: a privately owned venue is a
// community facility ("cm_<id>"), a club-run council park is council + operator ("op_<id>"),
// anything else Auckland Council ("akl_council").
export function parkWorkflow(p, ops = []) {
  if (p.venue && ownedPriv(p.venue)) { const o = p.venue;
    return { kind: "community", provider: "cm_" + o.id, operator: { id: o.id, name: o.operator, short: o.short, email: o.contact?.email || "", phone: o.contact?.phone || "" } }; }
  const manager = managerOf(ops);
  const contact = ops.find(o => o.booking_only) || manager;
  return manager ? { kind: "council_private", provider: "op_" + manager.id, operator: { id: manager.id, name: manager.operator, short: manager.short,
      contact_name: contact.operator, email: contact.contact?.email || "", phone: contact.contact?.phone || "", url: contact.contact?.url || "" } }
    : { kind: "council", provider: "akl_council", operator: null };
}

// Venues that aren't council parks (schools, club grounds, trusts…) as park-like entries
// "op-<id>", each in the region of the nearest council park. They have no council map.
export function opVenues(operators = [], parks = []) {
  const byId = new Set(parks.map(p => p.id));
  return operators.filter(o => (!o.park_id || !byId.has(o.park_id)) && o.lat != null).map(o => {
    let near = null, best = Infinity;
    parks.forEach(x => { if (x.lat == null) return; const d = (x.lat - o.lat) ** 2 + (x.lon - o.lon) ** 2; if (d < best) { best = d; near = x; } });
    return { id: "op-" + o.id, region: near?.region || "Central", name: o.park, maps: [], fields: [], lat: o.lat, lon: o.lon, venue: o };
  });
}

// The id of one bookable field at a venue, as saved in a booker's My fields.
export const fieldEntryId = (p, key) => `cf-${p.id}--${slug(key)}`;

// The facilities a rated venue offers, as My fields entries (the shape the booking site's
// applyCouncilFacilities reads): its saved field groups, else the whole park.
export function venueFieldEntries(p, review, ops = []) {
  const wf = parkWorkflow(p, ops), base = { park_id: p.id, park: p.name, region: p.region, kind: wf.kind, operator: wf.operator };
  const groups = review?.placement?.groups || [];
  if (groups.length) return groups.map(g => ({ ...base, id: fieldEntryId(p, g.key), field: g.name, council_fields: g.council, frisbee: g.cap, fit: g.fit, lat: g.c?.[0], lon: g.c?.[1] }));
  return [{ ...base, id: fieldEntryId(p, "Whole park"), field: "Whole park", lat: p.lat, lon: p.lon }];
}

// The best-rated venues of every type: [{ park, score, owner }], best first. `ratings` maps
// park id → crowd average (1–5).
export function topRatedVenues(venues, reviews, ratings = {}, opsOf = () => [], n = 10) {
  return venues.map(p => {
    const r = reviews[p.id], score = suitScore(r, ratings[p.id] ?? r?.quality ?? null);
    return { park: p, score, owner: ownerType(p, opsOf(p)) };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.park.name.localeCompare(b.park.name)).slice(0, n);
}
