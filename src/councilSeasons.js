// Auckland Council sports-field booking calendar, contacts and links, shared by the booking
// site (About → How to book → Council) and the Council fields page (season bar, default map).
//
// BASE_CYCLE holds one year's published dates (winter 2026 from the council's "How to book
// our sports facilities" page; summer 2026/27 from the parksbookings news email, see
// docs/multi-provider-design.md §6.3). Other years reuse them as approximations: each date
// moves to the same week of the year (same calendar date, nudged to the same weekday), and
// is shown with "≈" until the council publishes the real dates. Replace BASE_CYCLE with the
// new year's dates when they're out.

export const BASE_CYCLE = [
  // Winter 2026
  { key: "winter_apps",    season: "winter", label: "Winter seasonal applications open", from: "2025-12-15", to: "2026-02-08" },
  { key: "winter_alloc",   season: "winter", label: "Winter allocation coordination",   from: "2026-02-09", to: "2026-03-20", est: true },
  { key: "winter_casual",  season: "winter", label: "Winter casual applications open",  from: "2026-03-21", to: "2026-08-28", est: true },
  { key: "winter_season",  season: "winter", label: "Winter sport season",              from: "2026-04-04", to: "2026-09-06" },
  { key: "spring_reno",    season: "summer", label: "Spring renovation (casual only with written approval)", from: "2026-09-07", to: "2026-10-23" },
  // Summer 2026/27
  { key: "summer_apps",    season: "summer", label: "Summer seasonal applications open", from: "2026-07-13", to: "2026-08-21" },
  { key: "summer_alloc",   season: "summer", label: "Summer allocation coordination",   from: "2026-08-17", to: "2026-09-21" },
  { key: "summer_casual",  season: "summer", label: "Summer casual applications open",  from: "2026-09-21", to: "2027-02-15" },
  { key: "summer_season",  season: "summer", label: "Summer community sport season",    from: "2026-10-24", to: "2027-03-21" },
  { key: "autumn_change",  season: "winter", label: "Autumn changeover to winter fields", from: "2027-03-22", to: "2027-04-02", est: true },
];

export const COUNCIL_CONTACTS = {
  email: "parksbookings@aucklandcouncil.govt.nz",
  phone: "09 301 0101",
  // Coordinators by region. Names and direct numbers are kept out of the repo.
  coordinators: [
    { role: "Senior Parks Booking Coordinator", region: "Central" },
    { role: "Parks Booking Coordinator", region: "West / Upper North" },
    { role: "Parks Booking Coordinator", region: "South / East" },
    { role: "Parks Booking Coordinator", region: "North Shore" },
    { role: "Team Leader Visitor Experience", region: "All" },
  ],
};

export const COUNCIL_LINKS = [
  { label: "How to book our sports facilities (season dates are published here)", url: "https://www.aucklandcouncil.govt.nz/en/parks-recreation/sports/book-sports-facilities.html" },
  { label: "Casual booking applications", url: "https://www.aucklandcouncil.govt.nz/parks-recreation/sports/book-sports-facilities/Pages/casual-booking-applications-sports-facilities.aspx" },
  { label: "How we prioritise sports field applications", url: "https://www.aucklandcouncil.govt.nz/en/parks-recreation/sports/how-we-prioritise-sports-field-applications.html" },
  { label: "Check if a sports field is open or closed", url: "https://www.aucklandcouncil.govt.nz/en/parks-recreation/sports/sports-field-closures.html" },
  { label: "Online sports-field application (council portal)", url: "https://onlineservices.aucklandcouncil.govt.nz/councilonline/application/sportapplication?bookingApplicationType=SEASONAL_ALL_SPORTS_PARKS&productCode=SSPPERMITBK" },
  { label: "My applications (council portal)", url: "https://onlineservices.aucklandcouncil.govt.nz/councilonline/my-account" },
  { label: "North winter sports-field maps (PDF)", url: "https://www.aucklandcouncil.govt.nz/content/dam/ac/docs/parks-recreation/north-winter-sports-fields-maps.pdf" },
];

const DAY = 86400000;
const parse = s => new Date(s + "T12:00:00");
export const iso = d => d.toISOString().slice(0, 10);
// The same week of the year `years` later: same calendar date, moved to the nearest day
// with the same weekday (at most 3 days), so a Saturday season start stays a Saturday.
function shiftYears(s, years) {
  if (!years) return parse(s);
  const d = parse(s), t = new Date(d); t.setFullYear(d.getFullYear() + years);
  let diff = (d.getDay() - t.getDay() + 7) % 7; if (diff > 3) diff -= 7;
  return new Date(t.getTime() + diff * DAY);
}
// Every phase from `years` = -1 … +2 cycles, with real dates and whether they're estimates.
export function allPhases() {
  const out = [];
  for (let k = -1; k <= 2; k++) BASE_CYCLE.forEach(p => {
    const from = shiftYears(p.from, k), to = shiftYears(p.to, k);
    out.push({ ...p, from, to, approx: k !== 0 || !!p.est, year: from.getFullYear() });
  });
  return out.sort((a, b) => a.from - b.from);
}
// What's happening on `date`: the phases in progress and the next few to start.
export function councilState(date = new Date()) {
  const t = new Date(date); t.setHours(12, 0, 0, 0);
  const ps = allPhases();
  const now = ps.filter(p => p.from <= t && t <= p.to);
  const next = ps.filter(p => p.from > t).slice(0, 3);
  return { now, next, mapSeason: mapSeason(t, ps) };
}
// Which season's field layout applies: winter from the autumn changeover until the winter
// season ends, summer otherwise.
export function mapSeason(date = new Date(), ps = allPhases()) {
  const t = new Date(date); t.setHours(12, 0, 0, 0);
  return ps.some(p => p.key === "winter_season" && new Date(p.from.getTime() - 14 * DAY) <= t && t <= p.to) ? "winter" : "summer";
}
export const fmtDay = d => d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" });
export const fmtRange = p => `${p.approx ? "≈ " : ""}${fmtDay(p.from)} – ${fmtDay(p.to)}`;
