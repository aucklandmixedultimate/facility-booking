// Weekend daylight field preference at Cornwall Park. Field #1 (f3) is the only floodlit field,
// and Fields #1 and #2 (f4) are kept for evening play, so on Saturdays and Sundays a booking
// that sits entirely in daylight goes on Field #3 (f5) whenever Field #3 is free. The booking
// form offers the move; a booker who keeps #1/#2 has to acknowledge it again when submitting
// the cart. Pure module (no React), unit-tested.
import { isClosed } from "./statuses.js";

export const DAYLIGHT_AVOID_FIELDS = ["f3", "f4"];   // Field #1, Field #2
export const DAYLIGHT_FIELD = "f5";                  // Field #3

// Saturday or Sunday ("YYYY-MM-DD", read at local noon so no timezone can shift the day).
export const isWeekend = date => { const d = new Date(`${date}T12:00:00`).getDay(); return d === 0 || d === 6; };

const overlaps = (a, b) => a.date === b.date && a.start_hour < b.start_hour + b.duration && b.start_hour < a.start_hour + a.duration;

// The drafts that should move to Field #3: on a weekend, on Field #1 or #2, ending by `cutoff`
// (the day/evening boundary, 5:30pm), with Field #3 free at that time. Free means no live
// booking or vendor block on it (closed bookings and the drafts' own originals don't count),
// and no other draft in this batch already on it or moving to it. Returns their ids, in order.
export function daylightMoves(drafts, bookings, cutoff) {
  const draftIds = new Set(drafts.map(d => d.id));
  const taken = [
    ...bookings.filter(b => b.facility_id === DAYLIGHT_FIELD && !isClosed(b.status) && !draftIds.has(b.id)),
    ...drafts.filter(d => d.facility_id === DAYLIGHT_FIELD),
  ];
  const moves = [];
  for (const d of drafts) {
    if (!DAYLIGHT_AVOID_FIELDS.includes(d.facility_id) || !isWeekend(d.date) || d.start_hour + d.duration > cutoff) continue;
    if (taken.some(b => overlaps(b, d))) continue;
    moves.push(d.id);
    taken.push({ ...d, facility_id: DAYLIGHT_FIELD });
  }
  return moves;
}
