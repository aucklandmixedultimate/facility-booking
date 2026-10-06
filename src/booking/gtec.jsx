import { COUNCIL_STAGE_STATUSES, facShort, fmtTimeShort } from "./core.jsx";
import { isLive } from "../statuses.js";
// ─── Main App ─────────────────────────────────────────────────────────────────
// ─── CARLTON JUNIORS RUGBY SYNC ──────────────────────────────────────────────
// (sync bookings use empty email/name and are deduped by date+facility+time+purpose)
export const CJR_ORG_ID = "14520";
export const CJR_ICAL   = "https://ics.teamup.com/feed/ksooqhdi7ua5ucp58j/15068031.ics";

// Extract team identifier from CPSA EventName ("AU Ultimate Club (Field 3)" → "AU Ultimate Club")
export function extractCPSATeam(eventName) {
  const m = (eventName||"").match(/^(.+?)\s*\(/);
  return (m ? m[1] : eventName||"").trim();
}

export function normalizeId(s) { return (s||"").toLowerCase().replace(/[^a-z0-9]/g,""); }

export function tokenize(s) { return (s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

// Does a CPSA team/event name look like our own organisation (AMUA)?
// When it does, the name is NOT an inconsistency even if the matched booking is
// under an individual member's name.
export function resemblesAMUA(name) {
  const t = tokenize(name);
  if (t.includes("amua")) return true;
  const hasUltimate = t.includes("ultimate");
  return (hasUltimate && t.includes("mixed")) || (hasUltimate && t.includes("auckland"));
}

// Token-overlap (Jaccard) similarity between two names, 0..1, with acronym handling.
export function nameSimilarity(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const acr = toks => toks.map(w => w[0]).join("");
  if (ta.length === 1 && ta[0] === acr(tb)) return 1;
  if (tb.length === 1 && tb[0] === acr(ta)) return 1;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0; sa.forEach(w => { if (sb.has(w)) inter++; });
  return inter / (sa.size + sb.size - inter);
}

// Activity/booking-type words that describe WHAT a slot is for, not WHO booked it.
// Stripped before identity comparison so "Euphoria Training" reads as "Euphoria".
export const GTEC_ACTIVITY_WORDS = new Set(["training","train","trainings","trials","trial","game","games","practice","practise","session","sessions","scrim","scrimmage","scrimmages","match","matches","fixture","fixtures","league","tournament","tourney","hat","social","dev","development","clinic","camp","mixed","womens","mens","open"]);
export function stripActivityTokens(name) { return tokenize(name).filter(t => !GTEC_ACTIVITY_WORDS.has(t)); }
// Place and filler words that appear in half the organisation names in Auckland and
// identify nobody on their own. "Auckland Lacrosse Summer League" and a booking under
// aucklandmixedultimate@gmail.com share only "auckland" — enough for the fuzzy tier to
// link two unrelated tenants, which then surfaced as a mismatch where it should have
// been a clash. Skipped as the SOLE basis for a fuzzy match; a whole-name match on the
// stripped org string is a much stronger signal and is left alone.
export const GTEC_GENERIC_TOKENS = new Set([
  "auckland","newzealand","zealand","city","central","north","south","east","west",
  "club","clubs","association","assoc","incorporated","team","teams",
  "senior","seniors","junior","juniors","youth","summer","winter","spring","autumn",
  "park","sports","sport",
]);

// Bounded Levenshtein (early-exit beyond max) for typo tolerance on org tokens.
export function editDistance(a, b, max=2) {
  if (a === b) return 0;
  const la=a.length, lb=b.length;
  if (Math.abs(la-lb) > max) return max+1;
  let prev = Array.from({length: lb+1}, (_,i)=>i);
  for (let i=1;i<=la;i++) {
    const cur=[i]; let best=i;
    for (let j=1;j<=lb;j++) {
      const cost = a[i-1]===b[j-1]?0:1;
      const v = Math.min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost);
      cur[j]=v; if (v<best) best=v;
    }
    if (best>max) return max+1;
    prev=cur;
  }
  return prev[lb];
}

// The booker's email is embedded in the scraped EventDetails, e.g.
//   "...scheduled by Liang-Shou Wei (aucklandeuphoria@gmail.com), and has been
//    submitted on their behalf by the Auckland Mixed Ultimate Association."
// This is the single most reliable matching key — exact identity, immune to the
// name typos/abbreviations that appear in EventName ("Euhporia", "AUTUC", …).
export function extractEventDetailsEmail(details) {
  const m = (details||"").match(/scheduled by[^(]*\(\s*([^)\s]+@[^)\s]+)\s*\)/i);
  if (m) return m[1].trim().toLowerCase();
  const any = (details||"").match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return any ? any[0].toLowerCase() : "";
}

// 0..4 identity confidence that GTEC event `team` refers to booking `b`.
// 4 = definitive (email from EventDetails, or a previously-taught manual link).
export function gtecIdentityScore(team, b, { detailEmail, gtecLinks, canon }) {
  const bEmail = canon(b.email);
  // 1. Email straight from EventDetails — definitive, beats every other signal.
  if (detailEmail && canon(detailEmail) === bEmail) return 4;
  const coreTokens = stripActivityTokens(team);
  const coreNorm = coreTokens.join("");
  // 2. A previously-taught manual link (org token → email) — definitive.
  if (coreNorm && gtecLinks[coreNorm] && canon(gtecLinks[coreNorm]) === bEmail) return 4;
  // 3. Org identity carried by the email prefix / name (activity words stripped).
  const emailPrefix = normalizeId((b.email||"").split("@")[0]);
  const nameNorm = normalizeId(b.name);
  const purposeNorm = stripActivityTokens(b.purpose).join("");
  if (coreNorm && (emailPrefix === coreNorm || nameNorm === coreNorm)) return 4;
  if (coreNorm.length>=4 && emailPrefix && (emailPrefix.includes(coreNorm) || coreNorm.includes(emailPrefix))) return 3;
  if (coreNorm.length>=4 && nameNorm && (nameNorm.includes(coreNorm) || coreNorm.includes(nameNorm))) return 3;
  // 4. Fuzzy (typo) match of org tokens against any candidate identity token.
  const candTokens = [...tokenize((b.email||"").split("@")[0]), ...tokenize(b.name), ...tokenize(b.purpose)];
  for (const ct of coreTokens) {
    if (ct.length < 4) continue;
    if (GTEC_GENERIC_TOKENS.has(ct)) continue; // a shared place name is not an identity
    const thr = ct.length>=7 ? 2 : 1;
    for (const dt of candTokens) {
      if (dt.length < 4) continue;
      if (dt.includes(ct) || ct.includes(dt)) return 3;
      if (editDistance(ct, dt, thr) <= thr) return 3;
    }
  }
  // 5. Loose: name-similarity or purpose containment.
  if (nameSimilarity(team, b.name) >= 0.5) return 2;
  if (coreNorm && purposeNorm && (purposeNorm.includes(coreNorm) || coreNorm.includes(purposeNorm))) return 1;
  return 0;
}

// Normalised org-token key used both to teach (manual link) and recall (gtecLinks).
export function gtecTeamKey(eventName) { return stripActivityTokens(extractCPSATeam(eventName)).join(""); }

// Find a user booking that this CJR event likely represents.
// Returns { booking, exact } where exact=true means tight match (auto-confirm),
// exact=false means fuzzy/dimension-drift match (flag for AMUA review).
// gtecLinks: { orgTokenKey: email } taught by manual clash-linking.
export function findMatchingUserBooking(allBookings, ev, facilityIds, gtecLinks={}, emailAliases={}) {
  const date = parseCJRDate(ev.EventStartDate);
  if (!date) return null;
  const { start_hour, duration, allDay } = parseCJRDateTime(ev.EventDateTime);
  const team = extractCPSATeam(ev.EventName);
  const teamNorm = normalizeId(team);
  const detailEmail = extractEventDetailsEmail(ev.EventDetails);
  if (!teamNorm && !detailEmail) return null;
  const canon = e => ((emailAliases[(e||"").toLowerCase()] || e || "").toLowerCase());

  // Eligible bookings: same date, time-overlap, non-admin, in an approvable state.
  // Facility is NOT required — any time overlap on the same date is a potential link.
  const candidates = allBookings.filter(b => {
    if (b.email === "admin") return false;
    if (!(isLive(b.status) || b.status === "clash") && !b.invoiced) return false;
    if (b.date !== date) return false;
    if (b.start_hour + b.duration <= start_hour) return false;
    if (start_hour + duration <= b.start_hour) return false;
    return true;
  });
  if (!candidates.length) return null;

  // Identity dominates (×10) over the time/duration/facility tie-breakers.
  const scored = candidates.map(b => {
    const identityScore = gtecIdentityScore(team, b, { detailEmail, gtecLinks, canon });
    const timeExact = b.start_hour === start_hour ? 2 : 0;
    const durExact  = b.duration === duration ? 1 : 0;
    const facExact  = facilityIds.includes(b.facility_id) ? 1 : 0;
    return { booking: b, score: identityScore*10 + timeExact + durExact + facExact, identityScore };
  }).sort((a,b)=>b.score-a.score);

  const best = scored[0];
  const teamIsOurs = resemblesAMUA(team);
  const emailLinked = best.identityScore >= 4 && !!detailEmail;
  // A CPSA event that is neither our own org (AMUA), nor email-linked, nor a plausible
  // identity match is a *different tenant* sharing the field — do NOT link it.
  if (!teamIsOurs && best.identityScore < 2) return null;

  // Capture specific inconsistencies (booked → CPSA) so the admin sees what differs.
  const b = best.booking;
  // An entry with no time holds the field all day, so a booking inside it isn't a time difference.
  const dimReasons = bk => {
    const rs = [];
    if (!allDay && bk.start_hour !== start_hour) rs.push(`Time: ${fmtTimeShort(bk.start_hour)} → ${fmtTimeShort(start_hour)}`);
    if (!allDay && bk.duration !== duration)     rs.push(`Dur: ${bk.duration}h → ${duration}h`);
    if (!facilityIds.includes(bk.facility_id)) rs.push(`Field: ${facShort(bk.facility_id)} → ${facilityIds.map(facShort).join("/")}`);
    return rs;
  };
  const reasons = dimReasons(b);
  // Name is only an inconsistency for loosely-identified events — not when the email
  // (or a strong org link) already confirms identity, even if the booking is under an
  // individual member's name.
  //
  // The threshold is the same >= 3 that identityOk uses below. It previously demanded 4,
  // which contradicted both this comment and identityOk: score 3 IS the strong-org-link
  // tier (the org token matches the booking's email prefix, name or purpose, exactly or
  // within an edit distance). So a club booking made under a member's own name —
  // "Euphoria Training (Field 2)" against a booking by Shou Wei — was linked confidently
  // enough to sync, then flagged purely because the names differed, with every other
  // dimension identical. Below 3 the link is loose (name similarity or a purpose
  // substring) and the name really is worth an admin's eye.
  if (!teamIsOurs && !emailLinked && best.identityScore < 3) reasons.push(`Name: ${b.name} → ${team}`);

  const identityOk = teamIsOurs || emailLinked || best.identityScore >= 3;
  const exact = reasons.length === 0 && identityOk;
  // The same booker's OTHER bookings this event overlaps (e.g. a 6:30–8:00 and an 8:00–9:15
  // booking against one 6:30–8:30 GTEC entry). The event is matched to the best one; the
  // rest aren't what GTEC holds either, so they're returned as mismatches too (the sync
  // keeps an exact match from another event over these).
  const sameBooker = x => x.identityScore >= 3 || (detailEmail && canon(detailEmail) === canon(x.booking.email));
  // An entry covering several fields ("Field 2 & 3") matches one of the booker's bookings on
  // EACH of those fields — each is a match in its own right (exact or with its own
  // differences), not a booking left over because the entry went to another.
  const siblingFacs = new Set([b.facility_id]);
  const siblings = [];
  for (const x of scored.slice(1)) {
    const fid = x.booking.facility_id;
    if (!sameBooker(x) || !facilityIds.includes(fid) || siblingFacs.has(fid)) continue;
    siblingFacs.add(fid);
    const rs = dimReasons(x.booking);
    siblings.push({ booking: x.booking, exact: rs.length === 0 && identityOk, reasons: rs });
  }
  const sibIds = new Set(siblings.map(x => x.booking.id));
  const also = scored.slice(1).filter(x => sameBooker(x) && !sibIds.has(x.booking.id)).map(x => {
    const rs = dimReasons(x.booking);
    rs.push(`GTEC entry ${fmtTimeShort(start_hour)}–${fmtTimeShort(start_hour + duration)} is matched to another of your bookings`);
    return { booking: x.booking, exact: false, reasons: rs };
  });
  return { booking: b, exact, reasons, also, siblings };
}

// Maps facility mentions in EventName to internal facility IDs
// Internal ids for the three playing fields, by the number GTEC writes.
export const FIELD_ID_BY_NUM = { 1:"f3", 2:"f4", 3:"f5" };
// Every field referenced in a fragment of text, in the order written:
//   "Field 2"            → ["f4"]
//   "Field 1 & 2"        → ["f3","f4"]
//   "Fields 1, 2 and 3"  → ["f3","f4","f5"]
//   "Carlton Park - Fld #2" → ["f4"]
// A keyword must precede the number, so times/dates elsewhere in the string can't be
// mistaken for field references. Digits only chain through an explicit separator.
export function fieldIdsFromText(s) {
  // Names arrive HTML-escaped ("Fields 1, 2 &amp; 3"), which would otherwise break the
  // digit chain at the entity and drop every field after the first "&".
  const txt = (s || "").toLowerCase().replace(/&amp;/g, "&").replace(/&#(?:38|x26);/g, "&");
  if (!txt) return [];
  const out = [];
  const re = /\b(?:field|fld|turf|pitch)s?\b[\s#:.-]*(\d(?:\s*(?:&|\+|,|and|\/)\s*\d)*)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    for (const d of m[1].match(/\d/g) || []) {
      const id = FIELD_ID_BY_NUM[parseInt(d, 10)];
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}
// Fields named by an event's location/venue ("Location: Field 2" on the GTEC calendar).
// The payload isn't consistent about which key carries this, so try the usual spellings and
// then any location-ish key name. Returns the first key that actually names a field, so an
// unrelated key that merely matches the name pattern can't shadow the real one. Key names
// only — free text such as EventDetails is never scanned, since it can mention a field other
// than the one booked.
export function locationFieldIds(ev) {
  if (!ev) return [];
  const firstNaming = keys => {
    for (const k of keys) {
      const v = ev[k];
      if (typeof v !== "string" || !v.trim()) continue;
      const ids = fieldIdsFromText(v);
      if (ids.length) return ids;
    }
    return [];
  };
  // "Who" is included because GTEC's calendar puts the field there on some events — the
  // event popup shows "Who: Field 2" where others show "Location: Field 2". It is only
  // ever consulted when its value actually names a field, so a Who holding a person's
  // name is simply skipped.
  const known = firstNaming(["EventLocation","Location","EventVenue","Venue","EventPlace","Place","EventField","Field","EventWho","Who"]);
  if (known.length) return known;
  return firstNaming(Object.keys(ev).filter(k => /location|venue|place|field|ground|who/i.test(k)));
}
// Maps a GTEC event to internal facility ids. The location names the field actually booked,
// so it wins over the event name — the name often carries only a team or activity label
// ("Leulumoega Tuai", "U12 Open"). Consulting the name alone meant any event whose name
// omitted a field number silently fell back to Field #1 even when its location said Field #2.
export function mapCJRFacility(eventName, ev = null) {
  const fromLocation = locationFieldIds(ev);
  if (fromLocation.length) return fromLocation;
  const fromName = fieldIdsFromText(eventName);
  if (fromName.length) return fromName;
  // All-facilities events (mowing, refs, etc.) default to Field 1
  return ["f3"];
}

// Parse "08/06/2026" → "2026-06-08"
export function parseCJRDate(s) {
  const [d,m,y] = (s||"").split("/");
  if (!d||!m||!y) return null;
  return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
}

// Parse "6:30 pm" → 18.5
export function parseCJRTime(t) {
  const m = (t||"").trim().match(/^(\d+):(\d+)\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2]), ampm = m[3].toLowerCase();
  if (ampm==="pm" && h!==12) h+=12;
  if (ampm==="am" && h===12) h=0;
  return h + min/60;
}

// A GTEC entry with no time on it blocks the field for the day rather than a slot.
// Treated as 8am–8pm: it previously ended at 4pm, which left the evening looking free
// even though the field was taken, so evening bookings were neither clashed nor matched
// against it. 8pm sits inside the calendar grid (which runs to CAL_END, 10pm).
export const CJR_ALLDAY_START = 8, CJR_ALLDAY_END = 20;
// allDay marks the stand-in so the matcher doesn't report its 8am–8pm as a time difference.
export const cjrAllDay = () => ({ start_hour: CJR_ALLDAY_START, duration: CJR_ALLDAY_END - CJR_ALLDAY_START, allDay: true });

// Parse EventDateTime string for start_hour and duration
// e.g. "08/06/2026, 6:30 pm to 8:30 pm"  or  "08/06/2026" (no time = all day)
export function parseCJRDateTime(dt) {
  if (!dt) return cjrAllDay();
  const timeRange = dt.replace(/^\d+\/\d+\/\d+,?\s*/,"").trim();
  const parts = timeRange.split(/\s+to\s+/i);
  if (parts.length < 2) return cjrAllDay();
  const start = parseCJRTime(parts[0]);
  const end   = parseCJRTime(parts[1]);
  if (start === null || end === null) return cjrAllDay();
  const dur = end - start;
  return { start_hour: start, duration: dur > 0 ? dur : 1 };
}

export async function fetchCJREvents(year, month) {
  // month is 0-based
  const dateStr = `${year}-${String(month+1).padStart(2,"0")}-01`;
  // The `_` parameter changes every call: some public proxies cache responses, which made a
  // sync miss entries GTEC had added since (the feed ignores the unknown parameter).
  const target = `https://www.carltonjuniorsrugby.co.nz/api/v1/calendar/MonthCalendarEvents?organisationId=%2014520&sportId=0&ical=${encodeURIComponent(CJR_ICAL)}&date=${dateStr}&_=${Date.now()}`;
  // Free public CORS proxies time out now and then (HTTP 408), so each attempt is capped at
  // 20 s and the whole list is tried twice, with a short pause, before giving up.
  const proxies = [
    `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(target)}`,
  ];
  const errs = [];
  for (let round = 0; round < 2; round++) {
    if (round) await new Promise(res => setTimeout(res, 2000));
    for (const url of proxies) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
      try {
        const r = await fetch(url, { signal: ctl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch(e) { errs.push(`${new URL(url).hostname}: ${e.name === "AbortError" ? "timed out" : e.message}`); }
      finally { clearTimeout(timer); }
    }
  }
  throw new Error("All proxies failed: " + errs.slice(-proxies.length).join("; "));
}