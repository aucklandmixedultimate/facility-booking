// Booking times are hours as numbers (18.25 = 6:15 PM). Starts and lengths come in 15-minute
// and 20-minute steps. A 20-minute step is a third of an hour, which a number can't hold
// exactly, so an end worked out by adding (18⅓ + ⅔) can land a hair off 19. Every
// comparison of times goes through here, with a tolerance far below a minute, so a booking
// ending at 7:00 never "overlaps" one starting at 7:00. Pure module (no React), unit-tested.

export const T_EPS = 1e-6;   // hours; a few milliseconds

// An hour value for a whole number of minutes, built the same way everywhere (h + m/60, as
// the GTEC feed parser does), so equal times compare equal.
export const fromMinutes = t => Math.floor(t / 60) + (t % 60) / 60;
export const toMinutes = h => Math.round(h * 60);
// The same time, snapped to the minute.
export const snapMinute = h => fromMinutes(toMinutes(h));

// Do two spans [start, start + duration) overlap by more than a rounding error?
export const spansOverlap = (s1, d1, s2, d2) => s1 < s2 + d2 - T_EPS && s2 < s1 + d1 - T_EPS;
// a ≤ b, allowing for rounding.
export const atMost = (a, b) => a <= b + T_EPS;

// Start times from `from` to `to` (hours): every quarter hour and every 20 minutes
// (:00 :15 :20 :30 :40 :45).
export function startTimes(from, to) {
  const out = [];
  for (let t = Math.round(from * 60); t <= Math.round(to * 60); t += 5)
    if (t % 15 === 0 || t % 20 === 0) out.push(fromMinutes(t));
  return out;
}
// Lengths offered (minutes): 15- and 20-minute steps up to 3 hrs, then the long hires.
export const DURATION_MINUTES = [
  ...Array.from({ length: 36 }, (_, i) => (i + 1) * 5).filter(m => m % 15 === 0 || m % 20 === 0),
  210, 240, 300, 360, 480,
];
