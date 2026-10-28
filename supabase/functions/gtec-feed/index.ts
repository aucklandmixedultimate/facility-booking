// gtec-feed — reads one month of GTEC's calendar server-side (Supabase Edge Function, Deno).
//
// Why: GTEC's calendar API sends no CORS headers, so the booking site used to read it through
// free public CORS relays, which fail often ("the sync button only works occasionally"). A
// server-side fetch isn't subject to CORS. The site falls back to the relays when this function
// isn't deployed, so deploying it is an upgrade, not a requirement.
//
// Admins only: the caller's Supabase access token must belong to a user whose
// app_metadata.role is "admin". SUPABASE_URL and SUPABASE_ANON_KEY are injected automatically.
//
// POST { year: 2026, month: 10 }   (month 1–12)  →  200 [ …GTEC events… ]

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Same URL as cjrMonthUrl() in src/gtecFeed.js.
const CJR_ORG_ID = "14520";
const CJR_ICAL = "https://ics.teamup.com/feed/ksooqhdi7ua5ucp58j/15068031.ics";
const monthUrl = (year: number, month: number) =>
  `https://www.carltonjuniorsrugby.co.nz/api/v1/calendar/MonthCalendarEvents?organisationId=%20${CJR_ORG_ID}` +
  `&sportId=0&ical=${encodeURIComponent(CJR_ICAL)}&date=${year}-${String(month).padStart(2, "0")}-01&_=${Date.now()}`;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function fetchFeed(url: string, ms: number) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (FacilityBook GTEC sync)" } });
    if (!r.ok) throw new Error(`GTEC answered HTTP ${r.status}`);
    const v = JSON.parse(await r.text());
    if (!Array.isArray(v)) throw new Error("GTEC's answer wasn't a list of events");
    return v;
  } finally { clearTimeout(timer); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return json(401, { error: "missing_token" });
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } });
  if (!userRes.ok) return json(401, { error: "unauthorized" });
  const user = await userRes.json();
  if (user?.app_metadata?.role !== "admin") return json(403, { error: "admins_only" });

  let body: { year?: number; month?: number } = {};
  try { body = await req.json(); } catch { return json(400, { error: "bad_json" }); }
  const year = Number(body.year), month = Number(body.month);
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12)
    return json(400, { error: "bad_month" });

  // Two tries: GTEC's API is occasionally slow to answer the first request.
  let last = "";
  for (let i = 0; i < 2; i++) {
    try { return json(200, await fetchFeed(monthUrl(year, month), 20000)); }
    catch (e) { last = e instanceof Error ? (e.name === "AbortError" ? "GTEC timed out" : e.message) : String(e); }
    if (!i) await new Promise((res) => setTimeout(res, 1000));
  }
  return json(502, { error: "gtec_unreachable", detail: last });
});
