// The 📍 Fields menu's "All venues (top rated)" list: the best-rated venues of every type
// from All Auckland fields (council parks, club-run parks, schools, club and trust grounds),
// whether or not a booker has made them bookable. Loaded once per page, on first open.
import { supabase } from "./core.jsx";
import { opVenues, parkWorkflow, topRatedVenues, venueFieldEntries } from "../venues.js";

let cache = null;

// → [{ park, score, owner, provider, entries }] best first; [] when nothing is rated (or the
// tables / data can't be read, e.g. before supabase-setup.sql has run).
export function loadTopVenues(n = 10) {
  if (!cache) cache = (async () => {
    const base = import.meta.env.BASE_URL + "council-maps/";
    const [parksRes, privRes, revRes, ratRes] = await Promise.all([
      fetch(base + "parks.json").then(r => r.ok ? r.json() : { parks: [] }).catch(() => ({ parks: [] })),
      fetch(base + "private-managed.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
      supabase ? supabase.from("field_reviews").select("park_id,decision,fit,lights,quality,placement") : { data: [] },
      supabase ? supabase.from("field_ratings").select("park_id,stars") : { data: [] },
    ]);
    const parks = parksRes.parks || [], ops = privRes.operators || [];
    const opsByPark = {};
    ops.forEach(o => { if (o.park_id) (opsByPark[o.park_id] ||= []).push(o); });
    const venues = [...parks, ...opVenues(ops, parks)];
    venues.forEach(v => { if (v.venue) opsByPark[v.id] = [v.venue]; });
    const reviews = Object.fromEntries((revRes.data || []).map(r => [r.park_id, r]));
    const sums = {};
    (ratRes.data || []).forEach(r => { const e = sums[r.park_id] ||= { sum: 0, n: 0 }; e.sum += r.stars; e.n++; });
    const ratings = Object.fromEntries(Object.entries(sums).map(([id, e]) => [id, e.sum / e.n]));
    const opsOf = p => opsByPark[p.id] || [];
    return topRatedVenues(venues, reviews, ratings, opsOf, n).map(x => ({
      ...x, provider: parkWorkflow(x.park, opsOf(x.park)).provider, entries: venueFieldEntries(x.park, reviews[x.park.id], opsOf(x.park)),
    }));
  })().catch(() => { cache = null; return []; });
  return cache;
}
