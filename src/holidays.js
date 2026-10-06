// New Zealand public holidays for the calendars, synced from Nager.Date (date.nager.at, a
// public, CORS-enabled holiday API) and kept on the device for a week. National holidays
// plus Auckland Anniversary Day. A holiday that falls on a weekend is shown only on the
// weekday it's observed (Mondayisation): Saturday or Sunday → Monday, or Tuesday when Monday
// is already a holiday (Christmas / Boxing Day, New Year / 2 January) — whether or not the
// source already gives the observed date.

const API = "https://date.nager.at/api/v3/PublicHolidays/";
const CACHE_KEY = "fb_nz_holidays";
const MAX_AGE = 7 * 24 * 3600 * 1000;

// Calendar-date holidays that move when they fall on a weekend: [match, month, day].
const FIXED = [[/day after new year/i, 1, 2], [/new year/i, 1, 1], [/waitangi/i, 2, 6], [/anzac/i, 4, 25], [/boxing/i, 12, 26], [/christmas/i, 12, 25]];

const pad = n => String(n).padStart(2, "0");
const keyOf = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = k => { const [y, m, d] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (k, n) => { const d = parse(k); d.setUTCDate(d.getUTCDate() + n); return keyOf(d); };
const isWeekend = k => { const w = parse(k).getUTCDay(); return w === 0 || w === 6; };

// Plain English names, whichever spelling the source uses.
// (NZ's local names are English; the API's "name" can differ, e.g. "St. Stephen's Day".)
const strip = s => String(s || "").replace(/\s*\((observed|mondayised)\)\s*/i, "").trim();
function cleanName(h) {
  const n = strip(h.localName || h.name) || "Public holiday";
  return /anniversary/i.test(n) && /auckland/i.test(n + " " + (h.name || "") + " " + (h.counties || []).join(" ")) ? "Auckland Anniversary" : n;
}

// Source list (one or more years) → { "YYYY-MM-DD": { name, kind, mondayised } }.
// kind: "national" | "auckland". Other regions' anniversary days are left out.
export function nzHolidayMap(list) {
  const items = [];
  (Array.isArray(list) ? list : []).forEach(h => {
    if (!h?.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date)) return;
    const regional = h.global === false || (Array.isArray(h.counties) && h.counties.length);
    if (regional && !(h.counties || []).some(c => /AUK/i.test(c))) return;
    const name = cleanName(h), fixed = FIXED.find(([re]) => re.test(name) || re.test(strip(h.name)));
    items.push({ date: h.date, name, kind: regional ? "auckland" : "national", fixed });
  });
  // One entry per holiday per year (a source may list both the real and the observed day).
  const seen = new Set(), uniq = [];
  items.sort((a, b) => a.date.localeCompare(b.date)).forEach(x => { const id = x.date.slice(0, 4) + "|" + x.name;
    if (seen.has(id)) { const prev = uniq.find(y => y.date.slice(0, 4) + "|" + y.name === id); if (prev && isWeekend(prev.date) && !isWeekend(x.date)) prev.date = x.date; return; }
    seen.add(id); uniq.push(x); });
  const out = {};
  // Weekday holidays first, so a moved one goes to the next free weekday after them.
  uniq.sort((a, b) => isWeekend(a.date) - isWeekend(b.date) || a.date.localeCompare(b.date)).forEach(x => {
    let date = x.date, mondayised = false;
    if (x.fixed) { const [, m, d] = x.fixed; if (x.date !== `${x.date.slice(0, 4)}-${pad(m)}-${pad(d)}`) mondayised = true; }
    if (isWeekend(date)) {
      if (!x.fixed) return;   // only calendar-date holidays are Mondayised
      while (isWeekend(date) || out[date]) date = addDays(date, 1);
      mondayised = true;
    }
    if (out[date]) return;
    out[date] = { name: x.name, kind: x.kind, mondayised };
  });
  return out;
}

// The label under a date: "Christmas Day (Mondayised)", "Auckland Anniversary", "Matariki".
export const holidayLabel = h => h ? `${h.name}${h.mondayised ? " (Mondayised)" : ""}` : "";

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") || {}; } catch { return {}; } }
function writeCache(c) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* storage blocked */ } }

// Holidays for these years: cached ones at once (even stale), fresh ones fetched when older
// than a week. onUpdate gets the merged map whenever it changes. Offline → whatever's cached.
export function loadNzHolidays(years, onUpdate) {
  const cache = readCache();
  const merged = () => nzHolidayMap(years.flatMap(y => cache[y]?.list || []));
  onUpdate(merged());
  const stale = years.filter(y => !cache[y] || Date.now() - (cache[y].at || 0) > MAX_AGE);
  if (!stale.length || typeof fetch !== "function") return;
  Promise.all(stale.map(y => fetch(API + y + "/NZ").then(r => r.ok ? r.json() : null).catch(() => null)))
    .then(res => { let changed = false;
      res.forEach((list, i) => { if (Array.isArray(list) && list.length) { cache[stale[i]] = { at: Date.now(), list }; changed = true; } });
      if (changed) { writeCache(cache); onUpdate(merged()); } });
}
