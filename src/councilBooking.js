// Council sports-field applications: whether a booking goes in as a seasonal or a casual
// application, and the participant line the council form asks for. Pure functions, shared by
// the booking site (core.jsx) and its tests.
//
// Seasonal: regular weekly allocations for organised groups, applied for while the council's
// seasonal applications are open. Casual: one-off or irregular use, processed once seasonal
// bookings are settled; a casual hirer has fewer than 10 bookings per financial year
// (1 July – 30 June). So while seasonal applications are open everything goes in as seasonal;
// otherwise (late season) a booker with fewer than CASUAL_MAX council bookings in the
// booking's financial year is casual, and seasonal from CASUAL_MAX on.

export const CASUAL_MAX = 10;

// The financial year a date (YYYY-MM-DD) falls in, by its starting year: 2026-10-01 → 2026,
// 2027-03-01 → 2026.
export function financialYear(date) {
  const [y, m] = String(date).split("-").map(Number);
  return m >= 7 ? y : y - 1;
}

// Seasonal applications are open when one of the council's "*_apps" phases is in progress
// (councilState(date).now from councilSeasons.js).
export const seasonalAppsOpen = phasesNow => (phasesNow || []).some(p => /_apps$/.test(p.key || ""));

// "seasonal" | "casual" for booking `b`. `bookerCouncil` = the same booker's live council
// bookings (any dates; `b` may be among them); `canon` folds an email onto the booker.
export function councilBookingType(b, bookerCouncil, { appsOpen = false, canon = e => (e || "").toLowerCase() } = {}) {
  if (appsOpen) return "seasonal";
  const fy = financialYear(b.date), who = canon(b.email);
  const ids = new Set(), n = [b, ...(bookerCouncil || [])].filter(x => {
    if (canon(x.email) !== who || financialYear(x.date) !== fy || ids.has(x.id)) return false;
    ids.add(x.id); return true; }).length;
  return n < CASUAL_MAX ? "casual" : "seasonal";
}

// Junior grades a booker can play at (booker info "junior").
export const JUNIOR_GRADES = [
  { id: "high", label: "high school" },
  { id: "intermediate", label: "intermediate" },
  { id: "primary", label: "primary school" },
];

// The council form's participant line for one booker, from their booker info
// { level: "junior" | "senior", grade, teams, players, teamNames } and a fallback player count:
//   "Junior (high school) mixed ultimate frisbee: 1 team, 25 players. Teams: Matchbox."
//   "Senior mixed ultimate frisbee: 14 players."
export function participantText(info = {}, fallbackPlayers = null) {
  const junior = info.level === "junior";
  const grade = JUNIOR_GRADES.find(g => g.id === info.grade)?.label;
  const teams = parseInt(info.teams, 10) || 0, players = parseInt(info.players, 10) || parseInt(fallbackPlayers, 10) || 0;
  const head = junior ? `Junior${grade ? ` (${grade})` : ""} mixed ultimate frisbee` : "Senior mixed ultimate frisbee";
  const counts = [teams && `${teams} team${teams !== 1 ? "s" : ""}`, players && `${players} players`].filter(Boolean).join(", ");
  const names = String(info.teamNames || "").trim();
  return `${head}${counts ? `: ${counts}` : ""}.${names ? ` Teams: ${names}.` : ""}`;
}
