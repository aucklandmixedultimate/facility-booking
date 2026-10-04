// Booker categories (league seasons): NZMUC/TUC runs May–November, NZUC December–April, and
// NZU/AU (university bookers) is continuous — year-round, never the "current" season, and
// shown collapsed (one chip for all its bookers) in the booker filter bar. Each
// booker (canonical email) is assigned one by an admin (User Management → Season), saved in
// settings "booker_seasons"; unassigned bookers are NZMUC.
export const LEAGUE_SEASONS = [
  { id: "nzmuc", name: "NZMUC/TUC", span: "May–Nov", months: [5, 6, 7, 8, 9, 10, 11] },
  { id: "nzuc",  name: "NZUC",  span: "Dec–Apr", months: [12, 1, 2, 3, 4] },
  { id: "nzuau", name: "NZU/AU", span: "year-round", months: [], continuous: true, collapsed: true },
];
export const DEFAULT_BOOKER_SEASONS = { "grootultimateclub@gmail.com": "nzuc" };
export const currentLeagueSeason = (d = new Date()) => LEAGUE_SEASONS.find(x => x.months.includes(d.getMonth() + 1)).id;
export const seasonOfBooker = (email, map = {}) => { const e = (email || "").toLowerCase(); return map[e] || DEFAULT_BOOKER_SEASONS[e] || "nzmuc"; };
