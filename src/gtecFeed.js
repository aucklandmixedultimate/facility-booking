// GTEC's calendar feed: where it is fetched from, and whether what came back can be trusted.
// Pure module (no React, no Supabase client) so it can be unit-tested; gtec.jsx re-exports it.
//
// Sources, in order:
//   1. The `gtec-feed` Supabase Edge Function, which fetches the feed server-side (no CORS).
//   2. Free public CORS relays, the old route. None is dependable on its own.
//   3. (Caller) the last month pushed by the FacilityBook widget from GTEC's calendar page
//      (table `gtec_feed`), and pasting the feed by hand.
// A feed that looks wrong (empty while GTEC blocks are saved, or holding another month) is
// refused, so a bad answer can never delete the saved GTEC blocks.

const CJR_ORG_ID = "14520";
const CJR_ICAL   = "https://ics.teamup.com/feed/ksooqhdi7ua5ucp58j/15068031.ics";

// GTEC's calendar API for a month (0-based) — also opened directly in a browser tab for the manual
// "paste the feed" fallback (a top-level page isn't subject to CORS, so it always shows the JSON).
export function cjrMonthUrl(year, month) {
  const dateStr = `${year}-${String(month+1).padStart(2,"0")}-01`;
  return `https://www.carltonjuniorsrugby.co.nz/api/v1/calendar/MonthCalendarEvents?organisationId=%20${CJR_ORG_ID}&sportId=0&ical=${encodeURIComponent(CJR_ICAL)}&date=${dateStr}`;
}

// The feed as an array of events, from raw JSON text or a relay's wrapper ({ contents: "…" }).
export function parseFeedText(text) {
  let v = JSON.parse(String(text || "").trim());
  if (v && !Array.isArray(v) && typeof v.contents === "string") v = JSON.parse(v.contents);
  if (v && !Array.isArray(v) && Array.isArray(v.events)) v = v.events;
  if (!Array.isArray(v)) throw new Error("not a GTEC calendar feed (expected a list of events)");
  return v;
}

export const monthKeyOf = (year, month) => `${year}-${String(month+1).padStart(2,"0")}`;
// "08/06/2026" → "2026-06"
const feedMonth = s => { const [, m, y] = String(s || "").split("/"); return m && y ? `${y}-${m.padStart(2,"0")}` : null; };

// Why a fetched feed can't be trusted for this month, or "" when it can. savedBlocks is how many
// GTEC (admin) blocks are saved for the month: an empty answer then is far likelier a relay or
// GTEC hiccup than GTEC clearing the whole month, and syncing it would delete every block.
export function feedProblem(events, year, month, savedBlocks = 0) {
  if (!Array.isArray(events)) return "the answer wasn't a list of events";
  const key = monthKeyOf(year, month);
  if (!events.length) return savedBlocks > 0
    ? `GTEC's feed came back empty for ${key}, but ${savedBlocks} GTEC block${savedBlocks === 1 ? " is" : "s are"} saved`
    : "";
  const months = events.map(ev => feedMonth(ev?.EventStartDate)).filter(Boolean);
  if (!months.length) return "none of the entries has a date";
  // The month view includes a few days either side, but most entries sit in the month itself.
  if (!months.includes(key)) return `the feed holds ${[...new Set(months)].sort().join(", ")}, not ${key}`;
  return "";
}

// Public CORS relays, starting with whichever worked last; each attempt is capped.
export const RELAYS = [
  ["allorigins", t => `https://api.allorigins.win/raw?url=${encodeURIComponent(t)}`],
  ["allorigins-get", t => `https://api.allorigins.win/get?url=${encodeURIComponent(t)}`],
  ["codetabs", t => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(t)}`],
  ["cors.lol", t => `https://api.cors.lol/?url=${encodeURIComponent(t)}`],
  ["corsproxy.io", t => `https://corsproxy.io/?url=${encodeURIComponent(t)}`],
];
let _lastGoodRelay = null;
// After every relay has failed, the rest of that sync's months skip the relays (for a minute)
// rather than each waiting out every relay again.
let _relaysDownUntil = 0;
// The edge function isn't deployed (404) or refuses this user: don't ask again for a while.
let _functionOffUntil = 0;

async function fetchWithTimeout(fetchImpl, url, opts, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetchImpl(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}
const errText = e => e?.name === "AbortError" ? "timed out" : (e?.message || String(e));

// One month of GTEC's feed: { events, source }. Throws with every source's reason when all
// fail. functionUrl/headers reach the edge function (skipped when either is missing);
// savedBlocks feeds feedProblem, so a doubtful answer moves on to the next source.
export async function fetchGtecMonth(year, month, { functionUrl = null, headers = null, savedBlocks = 0, fetchImpl = fetch, timeoutMs = 15000, retryDelayMs = 1500 } = {}) {
  const errs = [];
  const accept = (events, source) => {
    const why = feedProblem(events, year, month, savedBlocks);
    if (why) { errs.push(`${source}: ${why}`); return null; }
    return { events, source };
  };
  if (functionUrl && headers && Date.now() >= _functionOffUntil) {
    try {
      const r = await fetchWithTimeout(fetchImpl, functionUrl, { method: "POST",
        headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ year, month: month + 1 }) }, timeoutMs + 10000);
      if (r.status === 404 || r.status === 401 || r.status === 403) { _functionOffUntil = Date.now() + 10 * 60000; throw new Error(`HTTP ${r.status}`); }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ok = accept(parseFeedText(await r.text()), "server");
      if (ok) return ok;
    } catch (e) { errs.push(`server: ${errText(e)}`); }
  }
  if (Date.now() >= _relaysDownUntil) {
    // The `_` parameter changes every call: some relays cache responses, which made a sync miss
    // entries GTEC had added since (the feed ignores the unknown parameter).
    const target = `${cjrMonthUrl(year, month)}&_=${Date.now()}`;
    const order = [...RELAYS].sort((a, b) => (b[0] === _lastGoodRelay) - (a[0] === _lastGoodRelay));
    for (let round = 0; round < 2; round++) {
      if (round) await new Promise(res => setTimeout(res, retryDelayMs));
      for (const [name, wrap] of order) {
        try {
          const r = await fetchWithTimeout(fetchImpl, wrap(target), {}, timeoutMs);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const ok = accept(parseFeedText(await r.text()), name);
          if (ok) { _lastGoodRelay = name; _relaysDownUntil = 0; return ok; }
        } catch (e) { errs.push(`${name}: ${errText(e)}`); }
      }
    }
    _relaysDownUntil = Date.now() + 60000;
  } else errs.push("relays: all failed moments ago");
  throw new Error("Couldn't read GTEC's calendar (" + errs.slice(-(RELAYS.length + 1)).join("; ") + ").");
}

// Test hook: forget which sources failed.
export function _resetFeedSources() { _lastGoodRelay = null; _relaysDownUntil = 0; _functionOffUntil = 0; }
