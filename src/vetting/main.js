// Council / Community fields (vetting.html) — admin tool for rating Auckland Council sports parks for
// ultimate. Two views on one Leaflet map:
//  · Auckland: every park plotted and coloured by its overall suitability rating; click one
//    to open it. This is how you move around between parks.
//  · Park: one park card at a time — live Esri satellite with the council field map laid over
//    it at its true position (georeferenced from each map page's GeoPDF data), a to-scale
//    ultimate field centred in the frame, light poles placed by clicking the map, and
//    decisions saved to Supabase (field_reviews, admin-only). See docs/council-field-vetting.md.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./vetting.css";
import { createClient } from "@supabase/supabase-js";
import { councilState, fmtRange, fmtDay, COUNCIL_LINKS, COUNCIL_CONTACTS } from "../councilSeasons.js";

const BASE = import.meta.env.BASE_URL;
const SB_URL = import.meta.env.VITE_SUPABASE_URL, SB_ANON = import.meta.env.VITE_SUPABASE_ANON;
const supabase = SB_URL && SB_ANON
  ? createClient(SB_URL, SB_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } })
  : null;

// Lights come from bulbs dropped on the map's poles; "No lights" records that you checked and there aren't any.
// Fit: how much ultimate the space holds.
const FIT_LABEL = { unknown: "not rated", reduced: "reduced size", full: "1 full field", multi: "2+ fields", no: "doesn't fit" };
// WFDF field: 100 × 37 m overall, 18 m end zones, brick marks 20 m in from each goal line.
const WFDF = { len: 100, wid: 37, ez: 18 };
const BRICK = 20;
// How far (in zoom levels) you can zoom from the fitted council map before it drops away
// to reveal the satellite: two to three wheel clicks either way.
const REVEAL_OUT = 1, REVEAL_IN = 1.5;
// Default Auckland view: North Harbour Stadium in the north to Opaheke Sports Park in the south.
const DEFAULT_VIEW = [[-36.72666, 174.70198], [-37.08545, 174.95175]];
const PRIV_COLOR = "#7c3aed";
// Parks that are home to an ultimate club stand out in hot pink.
const ULT_COLOR = "#ec4899";
// Community facilities (schools and trusts, not council parks) ring in blue.
const COMM_COLOR = "#2563eb";
const ultimateOf = p => (PRIV_BY_PARK[p.id] || []).filter(o => o.code === "ultimate");

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
                set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };
function setStatus(t, warn) { $("status").textContent = t; $("status").classList.toggle("warn", !!warn); }

let PARKS = [], BYID = {};
let PRIV = { operators: [], workflow: [] }, PRIV_BY_PARK = {};   // park_id -> [operators] from private-managed.json (a ground can have several)
// Council-only parks: a club is on site but bookings go straight to the council, so no private
// workflow. The data file's "council_only" is the default; admins can override it per park
// (settings key "council_only_parks": { park_id: { council_only, by, at } }).
const CO_KEY = "council_only_parks";
let councilOnlyOv = {};
const councilOnly = p => { const ops = PRIV_BY_PARK[p.id] || [], ov = councilOnlyOv[p.id];
  if (!ops.length || ops.some(o => o.must_book_through)) return false;
  return ov ? !!ov.council_only : ops.some(o => o.council_only); };
// The operators that shape the booking workflow and the map marker (none if council-only).
const privOps = p => councilOnly(p) ? [] : (PRIV_BY_PARK[p.id] || []);
let reviews = {};              // park_id -> review
let flags = {};                // park_id -> {club, by, at}: flagged as probably club-run, not yet in private-managed.json
let flagsShared = false;
let mode = "local";            // "shared" (Supabase) | "local" (this browser)
let session = null;
const later = new Set();
const draft = {};              // park_id -> tags being edited before deciding
const mapIdx = {};
// Council booking state (season phases) and the season whose field maps show by default.
const COUNCIL_NOW = councilState();
// The season's maps shown everywhere: the current season until the ☀/❄ toggle flips it.
let seasonPick = COUNCIL_NOW.mapSeason;
const mapIndex = p => mapIdx[p.id] ?? Math.max(0, p.maps.findIndex(m => m.season === seasonPick));
// Interests: which parks are served. Areas (regions; none ticked = all) and provider
// (council-run and/or privately operated).
let interests = store.get("vet-interests", { regions: [], council: true, priv: true });
const interestOk = p => (!interests.regions.length || interests.regions.includes(p.region))
  && (privOps(p).length ? interests.priv : interests.council);
const interestsSet = () => interests.regions.length > 0 || !interests.council || !interests.priv;
let cursor = 0, busy = false;
let dims = store.get("vet-field-dims", WFDF);
let fieldOn = store.get("vet-field-on", true);
let view = store.get("vet-view", "city");   // "city" | "park" | "book" (the cart)
// Admins rate and book for anyone; other signed-in bookers see the ratings and book for themselves.
let IS_ADMIN = true;
let workMode = store.get("vet-work-mode", "rate");   // "rate" | "book": what clicking a park's field areas does
let focusId = null;                          // park opened from the Auckland map (overrides the queue)
let focusFrom = null;                        // "city" (opened from the map) or "back" (the Back button)
const visited = [];                          // parks shown in park view, for Back
const edits = {};                            // per-park undo stack of rating snapshots

// ── Data ─────────────────────────────────────────────────────────────────────
function fromRow(r) { return { decision: r.decision, lights: r.lights, fit: r.fit, quality: r.quality, fields: r.fields || "", notes: r.notes || "",
  placement: r.placement || null, by: r.reviewer_email || "", at: r.updated_at }; }
async function loadShared() {
  const { data, error } = await supabase.from("field_reviews").select("*");
  if (error) {
    mode = "local"; reviews = store.get("vet-reviews", {}); flags = store.get("vet-flags", {});
    const missing = /field_reviews|does not exist|schema cache/i.test(error.message || "");
    setStatus(missing ? "The field_reviews table isn't set up yet (run supabase-migration-field-reviews.sql). Decisions are kept in this browser for now."
                      : "Couldn't load shared decisions (" + error.message + "). Decisions are kept in this browser for now.", true);
    return;
  }
  mode = "shared"; reviews = Object.fromEntries(data.map(r => [r.park_id, fromRow(r)]));
  setStatus(`Shared · ${data.length} decisions`);
  await loadFlags();
}
// Club-run flags live in their own table (field_flags) so a park can be flagged without a
// decision. Until that table exists they're kept in this browser.
async function loadFlags() {
  if (mode === "shared") {
    const { data, error } = await supabase.from("field_flags").select("*");
    if (!error) { flagsShared = true; flags = Object.fromEntries(data.map(r => [r.park_id, { club: r.club || "", kind: r.kind || "private", contact: r.contact || "",
      by: r.flagged_by_email || "", at: r.updated_at }])); return; }
  }
  flagsShared = false; flags = store.get("vet-flags", {});
}
async function saveFlag(id, flag) {
  if (flagsShared) {
    const row = flag && { park_id: id, club: flag.club || "", kind: flag.kind || "private", contact: flag.contact || "",
      flagged_by: session?.user?.id || null, flagged_by_email: session?.user?.email || null, updated_at: new Date().toISOString() };
    let { error } = flag ? await supabase.from("field_flags").upsert(row) : await supabase.from("field_flags").delete().eq("park_id", id);
    // Before the kind/contact columns exist (supabase-migration-field-reviews.sql), keep the provider only.
    if (error && flag && /kind|contact|column/i.test(error.message || "")) {
      const { kind, contact, ...old } = row; ({ error } = await supabase.from("field_flags").upsert(old));
      if (!error) setStatus("Saved the provider; its kind and contact person need the updated supabase-migration-field-reviews.sql.", true);
    }
    if (error) { setStatus("Couldn't save the club flag (" + error.message + ").", true); return false; }
  }
  if (flag) flags[id] = { ...flag, by: session?.user?.email || "", at: new Date().toISOString() }; else delete flags[id];
  if (!flagsShared) store.set("vet-flags", flags);
  return true;
}
async function save(id, rev) {
  if (mode === "shared") {
    const p = BYID[id];
    const q = rev
      ? supabase.from("field_reviews").upsert({ park_id: id, region: p.region, park: p.name, decision: rev.decision, lights: rev.lights, fit: rev.fit,
          quality: rev.quality || null, fields: rev.fields, notes: rev.notes, placement: rev.placement,
          reviewed_by: session?.user?.id || null, reviewer_email: session?.user?.email || null, updated_at: new Date().toISOString() })
      : supabase.from("field_reviews").delete().eq("park_id", id);
    const { error } = await q;
    if (error) {
      const old = /fit_check/i.test(error.message || ""), dec = /decision_check/i.test(error.message || "");
      setStatus(old || dec ? `Saving ${dec ? "field ratings before a decision" : "\"2+ fields\""} needs the updated supabase-migration-field-reviews.sql — re-run it in the Supabase SQL editor.`
                    : "Couldn't save that decision (" + error.message + "). Try again.", true);
      return false;
    }
  }
  if (rev) reviews[id] = { ...rev, by: session?.user?.email || rev.by || "", at: new Date().toISOString() }; else delete reviews[id];
  if (mode === "local") store.set("vet-reviews", reviews);
  return true;
}

// Overall suitability, 0 (rejected) … 1 (ideal); null when not rated yet.
function suitScore(r) {
  if (!r || r.decision === "rating") return null;
  if (r.decision === "no") return 0;
  let s = r.quality ? r.quality / 5 : 0.5;
  s += { multi: 0.2, full: 0.1, reduced: -0.15 }[r.fit] || 0;
  if (r.lights === "full" || r.lights === "training") s += 0.1;
  if (r.decision === "top") s += 0.15;
  return Math.max(0.05, Math.min(1, s));
}
const suitHue = s => Math.round(15 + s * 115);
function suitColor(r) { const s = suitScore(r); return s === null ? "#8a958f" : s === 0 ? "#b3372d" : `hsl(${suitHue(s)} 72% 42%)`; }
function suitWord(r) { const s = suitScore(r); return s === null ? (r?.decision === "rating" ? "Rating in progress" : "Not rated") : s === 0 ? "Rejected" : s >= 0.85 ? "Excellent" : s >= 0.65 ? "Good" : s >= 0.45 ? "Fair" : "Poor"; }
function parkLatLng(p) {
  const pl = reviews[p.id]?.placement;
  if (pl?.lat != null) return [pl.lat, pl.lon];
  return p.lat ? [p.lat, p.lon] : null;
}

function renderInterests() {
  const regions = [...new Set(PARKS.map(p => p.region))].sort();
  $("interestPanel").innerHTML = `<b>Interests</b><span class="ip-k">Area</span>`
    + regions.map(r => `<label><input type="checkbox" data-int="region" value="${esc(r)}"${interests.regions.includes(r) ? " checked" : ""}> ${esc(r)}</label>`).join("")
    + `<span class="ip-k">Provider</span><label><input type="checkbox" data-int="council"${interests.council ? " checked" : ""}> 🏛 Council-run</label>`
    + `<label><input type="checkbox" data-int="priv"${interests.priv ? " checked" : ""}> ◆ Privately operated</label>`
    + `<small>No area ticked = all areas. Only parks matching these are served.</small>`;
}
// ── Activity score: a background ranking metric per park ─────────────────────
// Starts at 0; each "Later" (skip) takes 1 off. Shared through the settings table for
// signed-in admins (key vet_park_activity), else kept on this device.
const ACTIVITY_KEY = "vet_park_activity";
let activity = {};
const activityOf = id => activity[id] || 0;
async function loadActivity() {
  if (supabase && session) {
    const { data, error } = await supabase.from("settings").select("value").eq("key", ACTIVITY_KEY).maybeSingle();
    if (!error) { activity = data?.value || {}; return; }
  }
  activity = store.get("vet-activity", {});
}
// Views: how many times each park has been served (counted when you move on from it).
const VIEWS_KEY = "vet_park_views";
let views = {};
const viewsOf = id => views[id] || 0;
async function loadViews() {
  if (supabase && session) {
    const { data, error } = await supabase.from("settings").select("value").eq("key", VIEWS_KEY).maybeSingle();
    if (!error) { views = data?.value || {}; return; }
  }
  views = store.get("vet-views", {});
}
async function bumpViews(id) {
  views[id] = viewsOf(id) + 1;
  if (supabase && session && IS_ADMIN) {
    const { data } = await supabase.from("settings").select("value").eq("key", VIEWS_KEY).maybeSingle();
    const fresh = data?.value || {}; fresh[id] = (fresh[id] || 0) + 1;
    const { error } = await supabase.from("settings").upsert({ key: VIEWS_KEY, value: fresh, updated_at: new Date().toISOString() });
    if (!error) { views = fresh; return; }
  }
  store.set("vet-views", views);
}
let servedPark = null;   // the park on screen; its view counts once you move on to another
async function bumpActivity(id, delta) {
  activity[id] = activityOf(id) + delta;
  if (supabase && session && IS_ADMIN) {
    // Re-read first so two admins skipping at once both count.
    const { data } = await supabase.from("settings").select("value").eq("key", ACTIVITY_KEY).maybeSingle();
    const fresh = data?.value || {}; fresh[id] = (fresh[id] || 0) + delta;
    const { error } = await supabase.from("settings").upsert({ key: ACTIVITY_KEY, value: fresh, updated_at: new Date().toISOString() });
    if (!error) { activity = fresh; return; }
  }
  store.set("vet-activity", activity);
}

// ── Queue ────────────────────────────────────────────────────────────────────
function queue() {
  const reg = $("region").value, m = $("mode").value, mapsOnly = $("mapsOnly").checked;
  let q = PARKS.filter(p => (!reg || p.region === reg) && (!mapsOnly || p.maps.length) && interestOk(p));
  const undecided = p => !reviews[p.id] || reviews[p.id].decision === "rating";
  if (m === "todo") q = q.filter(undecided);
  else if (m !== "all") q = q.filter(p => reviews[p.id]?.decision === m);
  // Parks still to review rank by their activity score (each skip lowers it), so parks
  // that keep getting skipped sink; ties keep the usual order.
  // The serving order: least viewed first (the default), the default order, or A–Z.
  const ord = $("order").value;
  if (ord === "alpha") q = [...q].sort((a, b) => a.name.localeCompare(b.name));
  else if (m === "todo") q = q.map((p, i) => [p, i]).sort((a, b) => (ord === "least" ? viewsOf(a[0].id) - viewsOf(b[0].id) : 0)
    || activityOf(b[0].id) - activityOf(a[0].id) || a[1] - b[1]).map(x => x[0]);
  if (m === "todo") q = q.filter(p => !later.has(p.id)).concat(q.filter(p => later.has(p.id)));
  return q;
}
function current() {
  if (focusId && BYID[focusId]) return BYID[focusId];
  const q = queue(); if (cursor >= q.length) cursor = 0; return q[cursor] || null;
}
function tagsFor(p) {
  if (!draft[p.id]) { const r = reviews[p.id] || {};
    draft[p.id] = { lights: r.lights || "unknown", lightPts: (r.placement?.lights || []).map(x => [...x]), fit: r.fit || "unknown",
      quality: r.quality || 0, fields: r.fields || "", notes: r.notes || "", fieldsManual: !!r.fields,
      // The confirmed field spot: set when a fit is rated, and only this spot is saved.
      spot: r.placement?.lat != null ? { lat: r.placement.lat, lon: r.placement.lon, angle: r.placement.angle || 0 } : null,
      // Per-council-field ratings, keyed by field: {name, fit, lat, lon, angle, lights: [[lat, lon]]}.
      fr: JSON.parse(JSON.stringify(r.placement?.fields || {})), sel: null };
    const d = draft[p.id];
    // Older reviews saved one spot for the park: treat it as a rating of its first field.
    if (!Object.keys(d.fr).length && d.spot && d.fit !== "unknown") {
      const name = (r.fields || "").split(",")[0].trim() || "This spot";
      d.fr[name] = { name, fit: d.fit, lat: d.spot.lat, lon: d.spot.lon, angle: d.spot.angle, lights: [] };
    }
  }
  return draft[p.id];
}
const FIT_RANK = { unknown: 0, reduced: 1, full: 2, multi: 3 };
// Park-level fit, fields and spot follow from the per-field ratings: the best fit wins.
function syncFromFields(t) {
  const rated = Object.values(t.fr).filter(x => x.fit && x.fit !== "unknown");
  const best = rated.sort((a, b) => FIT_RANK[b.fit] - FIT_RANK[a.fit])[0];
  t.fit = best ? best.fit : "unknown";
  t.spot = best ? { lat: best.lat, lon: best.lon, angle: best.angle } : null;
  if (!t.fieldsManual || !t.fields.trim()) { t.fields = rated.map(x => x.name).join(", "); t.fieldsManual = false; }
  const n = allLights(t).length;
  if (n && t.lights !== "full" && t.lights !== "training") t.lights = "full";
  if (!n && (t.lights === "full")) t.lights = "unknown";
}
const allLights = t => t.lightPts.concat(...Object.values(t.fr).map(x => x.lights || []));
// Bulbs go to the selected field; with no field selected they're park-wide.
function activeLights(t) {
  if (!t.sel) return t.lightPts;
  t.fr[t.sel] ||= { name: t.sel, fit: "unknown", lights: [] };
  return (t.fr[t.sel].lights ||= []);
}
// "Majority configured": at least three of lights, fit, quality and fields are set.
function ratedCount(t) { return [t.lights !== "unknown", t.fit !== "unknown", t.quality > 0, !!t.fields.trim()].filter(Boolean).length; }

// ── Map ──────────────────────────────────────────────────────────────────────
let map, overlay = null, overlayPanel = null, baseZoom = null, shownPark = null;
let lightLayer, parkFieldsLayer, cityLayer, cityFieldsLayer, cityHome = null;
function initMap() {
  map = L.map("map", { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 150, maxZoom: 21, zoomControl: true });
  map.zoomControl.setPosition("bottomright");
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: 19, maxZoom: 21,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics · Field maps © Auckland Council",
  }).addTo(map);
  map.createPane("fieldsPane").style.zIndex = 420;
  lightLayer = L.layerGroup(); parkFieldsLayer = L.layerGroup(); cityLayer = L.layerGroup(); cityFieldsLayer = L.layerGroup();
  map.on("zoomanim", e => { $("field").classList.add("zooming"); sizeField(e.zoom, e.center); });
  map.on("zoomend", () => { $("field").classList.remove("zooming"); updateLayer(); sizeField(); syncCityFields(); });
  map.on("move", () => sizeField());
  map.on("moveend", () => { if (view === "park" && fieldOn && !rotating && !pin) afterMove(); });
  map.on("click", () => { if (view === "park" && rotating) lockField(); });
}
// Every council map is the same 1100 × 778 template; its base panel (disclaimer, park name,
// date, logo) spans y 655–770 and x 15–1085. That band, in map coordinates, is the click
// target for the opaque view, so it's the same size on every plan and never covers fields.
function panelBounds(b) {
  const n = b.getNorth(), s = b.getSouth(), w = b.getWest(), e = b.getEast(), dy = n - s, dx = e - w;
  return L.latLngBounds([n - dy * 770 / 778, w + dx * 15 / 1100], [n - dy * 655 / 778, e - dx * 15 / 1100]);
}
function openCouncilImage() {
  const p = current(); if (!p || !overlay) return;
  const i = Math.min(mapIndex(p), Math.max(0, p.maps.length - 1)), m = p.maps[i], url = BASE + "council-maps/" + m.file;
  $("cimgImg").src = url; $("cimgOpen").href = url;
  $("cimgTitle").textContent = [p.name, m.title !== p.name && m.title, m.season === "winter" ? "❄ Winter" : "☀ Summer"].filter(Boolean).join(" · ");
  $("cimgBox").hidden = false;
}
function closeCouncilImage() { $("cimgBox").hidden = true; }

// ── Park view: Esri satellite + council overlay that drops away when you zoom off it ─
function showMap(p) {
  const i = Math.min(mapIndex(p), Math.max(0, p.maps.length - 1)), m = p.maps[i];
  if (overlay) { overlay.remove(); overlay = null; }
  if (overlayPanel) { overlayPanel.remove(); overlayPanel = null; }
  map.invalidateSize();
  if (m) {
    const b = L.latLngBounds([m.bounds[0], m.bounds[1]], [m.bounds[2], m.bounds[3]]);
    overlay = L.imageOverlay(BASE + "council-maps/" + m.file, b, { className: "council-overlay", interactive: false }).addTo(map);
    // The plan's base panel opens the plan opaque; once the plan has dissolved it's a dashed outline.
    overlayPanel = L.rectangle(panelBounds(b), { pane: "fieldsPane", className: "council-panel", color: "#ffffff", weight: 1.5,
      opacity: 0, fill: true, fillColor: "#ffffff", fillOpacity: 0, bubblingMouseEvents: false })
      .bindTooltip("Show the council map", { className: "parktip", sticky: true })
      .on("click", () => { if (rotating) return lockField(); openCouncilImage(); }).addTo(map);
    map.fitBounds(b, { animate: false });
    baseZoom = map.getZoom();
  } else {
    map.setView(p.lat ? [p.lat, p.lon] : [-36.87, 174.77], p.lat ? 16.5 : 11, { animate: false });
    baseZoom = null;
  }
  shownPark = p.id + "#" + i; pin = null; tagsFor(p).sel = null; updateLayer(); sizeField(); drawParkFields(p); drawLights(p);
}
function councilVisible() {
  if (!overlay) return false;
  const z = map.getZoom();
  return z >= baseZoom - REVEAL_OUT && z <= baseZoom + REVEAL_IN;
}
function updateLayer() {
  const on = councilVisible();
  if (overlay) overlay.setOpacity(on ? 1 : 0);
  if (overlayPanel) overlayPanel.setStyle(on ? { opacity: 0, dashArray: null } : { opacity: 0.8, dashArray: "6 5" });
  $("layerBadge").textContent = on ? "Council map" : "Satellite";
}
// Council fields traced from the map PDFs: [{n: name, c: [lat, lon], p: [[lat, lon], …]}].
function councilFields(p) {
  const i = Math.min(mapIndex(p), Math.max(0, p.maps.length - 1));
  return p.maps[i]?.fields || [];
}
// Council field areas are clickable: selecting one targets it for rating (or editing an
// existing rating) and shows only its lights.
function fieldKeys(p) {
  const seen = {};
  return councilFields(p).map((f, i) => { let key = f.n || `Field ${i + 1}`;
    if (seen[key]) key += ` (${++seen[key]})`; else seen[key] = 1;
    return { f, key }; });
}
const FIT_COLOR = { multi: "#1f7a4d", full: "#46b37b", reduced: "#e0a647" };
function drawParkFields(p) {
  parkFieldsLayer.clearLayers();
  const t = tagsFor(p);
  if (workMode === "book") {   // Book mode: field areas go in and out of the booker's cart
    fieldKeys(p).forEach(({ f, key }) => {
      const st = locState(cartId(p, key));   // "active" | "cart" | null
      L.polygon(f.p, { pane: "fieldsPane", fill: true, fillColor: st === "active" ? "#0f766e" : "#14b8a6",
        fillOpacity: st === "active" ? 0.55 : st ? 0.3 : 0.04, color: st === "active" ? "#0f766e" : st ? "#14b8a6" : "#ffffff",
        weight: st ? 3 : 1.4, dashArray: st === "cart" ? "7 4" : st ? null : "4 4", opacity: 0.95, bubblingMouseEvents: false })
        .bindTooltip(`${esc(key)} — ${st === "active" ? "📌 active booking" : st ? "🛒 in the cart (not booked yet) · click to remove" : "click to add to the cart"}`, { className: "parktip", sticky: true })
        .on("click", () => toggleCart(p, key))
        .addTo(parkFieldsLayer);
    });
    return;
  }
  fieldKeys(p).forEach(({ f, key }) => {
    const rt = t.fr[key], sel = t.sel === key, fc = rt?.fit && FIT_COLOR[rt.fit];
    L.polygon(f.p, { pane: "fieldsPane", fill: true, fillColor: fc || "#ffd400", fillOpacity: fc ? 0.3 : sel ? 0.12 : 0.02,
      color: sel ? "#ffd400" : fc || "#ffffff", weight: sel ? 3.5 : fc ? 2.5 : 1.2, dashArray: sel || fc ? null : "4 4", opacity: 0.95, bubblingMouseEvents: false })
      .bindTooltip(`${esc(key)}${rt?.fit && rt.fit !== "unknown" ? " · " + FIT_LABEL[rt.fit] : ""}${rt?.lights?.length ? " · 💡" + rt.lights.length : ""} — click to ${rt?.fit && rt.fit !== "unknown" ? "edit" : "rate"}`, { className: "parktip", sticky: true })
      .on("click", () => { if (rotating) return lockField(); selectField(p, key === t.sel ? null : key); })
      .addTo(parkFieldsLayer);
  });
}
function selectField(p, key) {
  const t = tagsFor(p); t.sel = key; fitOpen = false;
  if (key) {
    const hit = fieldKeys(p).find(x => x.key === key), rt = t.fr[key];
    if (rt?.lat != null) { angle = rt.angle; pin = L.latLng(rt.lat, rt.lon); }
    else if (hit) { pin = L.latLng(hit.f.c[0], hit.f.c[1]); angle = longAxis(hit.f.p); }
    if (pin) map.panTo(pin, { animate: true });
    $("fitPop").hidden = false;
  } else $("fitPop").hidden = true;
  sizeField(); drawParkFields(p); drawLights(p); previewFields(p); renderTags(p);
}
// The park's best rated field (its saved spot), pinned where and how it was saved.
function restorePlacement(p) {
  const t = tagsFor(p), sp = t.spot; if (!sp) return;
  const rated = Object.values(t.fr).filter(x => x.fit && x.fit !== "unknown" && x.lat != null);
  const f = rated.find(x => x.lat === sp.lat && x.lon === sp.lon) || rated.sort((a, b) => FIT_RANK[b.fit] - FIT_RANK[a.fit])[0];
  if (rotating) setRotating(false);
  angle = (f ? f.angle : sp.angle) || 0; pin = L.latLng(f ? f.lat : sp.lat, f ? f.lon : sp.lon);
  map.setView(pin, map.getZoom(), { animate: false });
  t.sel = f ? f.name : null; fitOpen = false; $("fitPop").hidden = !t.sel;
  sizeField(); renderCentre(); drawParkFields(p); drawLights(p); previewFields(p); renderTags(p);
}
// Screen angle of a polygon's longest edge, so a new field lines up with the council field.
function longAxis(pts) {
  let best = 0, ang = angle;
  for (let i = 0; i < pts.length; i++) {
    const a = map.latLngToLayerPoint(pts[i]), b = map.latLngToLayerPoint(pts[(i + 1) % pts.length]), d = a.distanceTo(b);
    if (d > best) { best = d; ang = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; }
  }
  return Math.round(ang);
}
// Light poles: bulbs dragged from the dispenser onto the map. Placed bulbs can be dragged to
// adjust them, dragged back onto the dispenser to remove them, or clicked to remove them.
function drawLights(p) {
  lightLayer.clearLayers();
  const t = tagsFor(p), arr = activeLights(t);
  const icon = cls => L.divIcon({ className: "", html: `<div class="lightpin${cls}">💡</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  if (!t.sel) Object.values(t.fr).forEach(x => (x.lights || []).forEach(ll =>
    L.marker(ll, { icon: icon(" other"), interactive: false, keyboard: false }).addTo(lightLayer)));
  arr.forEach((ll, k) => {
    const mk = L.marker(ll, { icon: icon(""), title: "Light pole — drag to move, drag back to the dispenser (or click) to remove", keyboard: false, draggable: true });
    mk.on("click", e => { L.DomEvent.stopPropagation(e); removeLight(p, k); });
    mk.on("drag", e => $("dispenser").classList.toggle("target", overDispenser(e.originalEvent)));
    mk.on("dragend", () => {
      $("dispenser").classList.remove("target");
      if (lastPointer && overDispenser(lastPointer)) return removeLight(p, k);
      snap(p); const l = mk.getLatLng(); arr[k] = [+l.lat.toFixed(6), +l.lng.toFixed(6)];
      if (t.sel && t.fr[t.sel]) { t.fr[t.sel].lightsAuto = false; renderLightStep(p); }
    });
    mk.addTo(lightLayer);
  });
  $("bulbCount").textContent = arr.length;
  $("dispenser").title = t.sel ? `Lights for ${t.sel}: drag a bulb onto each pole, drag one back to remove it` : "Park-wide lights: drag a bulb onto each pole (select a field to give it its own lights)";
  $("noLightsBtn").setAttribute("aria-pressed", String(t.lights === "none"));
}
let lastPointer = null;
function overDispenser(ev) {
  if (!ev) return false;
  const pt = ev.touches?.[0] || ev.changedTouches?.[0] || ev, r = $("dispenser").getBoundingClientRect();
  return pt.clientX >= r.left - 6 && pt.clientX <= r.right + 6 && pt.clientY >= r.top - 6 && pt.clientY <= r.bottom + 6;
}
function addLight(p, latlng) {
  snap(p);
  const t = tagsFor(p);
  activeLights(t).push([+latlng.lat.toFixed(6), +latlng.lng.toFixed(6)]);
  if (t.sel && t.fr[t.sel]) t.fr[t.sel].lightsAuto = false;
  syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p);
}
function removeLight(p, k) {
  snap(p);
  const t = tagsFor(p); activeLights(t).splice(k, 1);
  if (t.sel && t.fr[t.sel]) t.fr[t.sel].lightsAuto = false;
  syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p);
}
// Drag a bulb out of the dispenser: a ghost follows the pointer and drops where released.
function bindDispenser() {
  const src = $("bulbSrc"); let ghost = null;
  document.addEventListener("pointermove", e => { lastPointer = e; }, { passive: true });
  document.addEventListener("pointerup", e => { lastPointer = e; }, { passive: true, capture: true });
  src.addEventListener("pointerdown", e => {
    if (!current() || view !== "park") return;
    e.preventDefault(); src.setPointerCapture(e.pointerId);
    ghost = document.createElement("div"); ghost.className = "bulbghost"; ghost.textContent = "💡";
    ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px"; document.body.appendChild(ghost);
  });
  src.addEventListener("pointermove", e => { if (ghost) { ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px"; } });
  const drop = e => {
    if (!ghost) return; ghost.remove(); ghost = null;
    const p = current(), r = $("map").getBoundingClientRect();
    if (!p || overDispenser(e) || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    addLight(p, map.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]));
  };
  src.addEventListener("pointerup", drop);
  src.addEventListener("pointercancel", () => { if (ghost) { ghost.remove(); ghost = null; } });
  $("noLightsBtn").onclick = () => { const p = current(); if (!p) return; snap(p); const t = tagsFor(p);
    if (t.lights === "none") t.lights = "unknown"; else { t.lights = "none"; t.lightPts = []; Object.values(t.fr).forEach(x => { x.lights = []; }); }
    drawLights(p); renderTags(p); };
}

// ── Frisbee field overlay: frame-centred, true scale, centre button locks/unlocks rotation ─
// The field is frame-centred until it's locked; locking pins it to that spot on the map
// (pin), so panning afterwards moves the map under it. Unlocking recentres on it.
let angle = 0, rotating = false, pin = null, fitOpen = false;
const fieldCentre = () => pin || map.getCenter();
function drawField() {
  const { len: Lm, wid: Wm, ez } = dims, x0 = -Lm / 2, y0 = -Wm / 2, gl = Lm / 2 - ez, bx = gl - BRICK;
  const cross = x => `<path d="M${x - 0.8} -0.8 L${x + 0.8} 0.8 M${x - 0.8} 0.8 L${x + 0.8} -0.8"/>`;
  $("fieldSvg").setAttribute("viewBox", `${x0} ${y0} ${Lm} ${Wm}`);
  $("fieldSvg").innerHTML = `
    <g fill="none" stroke="var(--field)" stroke-width="2" vector-effect="non-scaling-stroke" style="vector-effect:non-scaling-stroke">
      <rect class="outline" x="${x0}" y="${y0}" width="${Lm}" height="${Wm}" fill="rgba(255,212,0,.14)" vector-effect="non-scaling-stroke"/>
      ${ez > 0 ? `<line x1="${-gl}" y1="${y0}" x2="${-gl}" y2="${-y0}" vector-effect="non-scaling-stroke"/><line x1="${gl}" y1="${y0}" x2="${gl}" y2="${-y0}" vector-effect="non-scaling-stroke"/>` : ""}
      ${bx > 0 ? `<g stroke-width="1.5">${cross(-bx)}${cross(bx)}</g>` : ""}
    </g>`;
  $("scaleNote").textContent = `Field ${dims.len} × ${dims.wid} m${dims.ez ? `, ${dims.ez} m end zones` : ""}`;
}
function sizeField(zoom, center) {
  if (!map) return;
  const z = zoom ?? map.getZoom(), lat = (pin || center || map.getCenter()).lat;
  const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, z));
  const w = dims.len / mpp, h = dims.wid / mpp, svg = $("fieldSvg");
  svg.style.width = w + "px"; svg.style.height = h + "px";
  svg.style.left = -w / 2 + "px"; svg.style.top = -h / 2 + "px";
  svg.style.transform = `rotate(${angle}deg)`;
  // Pinned: place the field (and its lock button) at the pin's screen position, including
  // mid-zoom, where the target zoom/centre come from the zoomanim event.
  let left = "50%", top = "50%";
  if (pin) {
    const size = map.getSize(), c = center || map.getCenter();
    const pt = map.project(pin, z).subtract(map.project(c, z)).add(size.divideBy(2));
    left = pt.x + "px"; top = pt.y + "px";
  }
  $("field").style.left = $("centreWrap").style.left = left;
  $("field").style.top = $("centreWrap").style.top = top;
}
function setRotating(on) {
  if (on && pin) { map.setView(pin, map.getZoom(), { animate: false }); pin = null; }
  rotating = on; $("field").classList.toggle("live", on); $("rotateHint").hidden = !on;
  $("rotateHint").textContent = matchMedia("(hover: none)").matches
    ? "Twist to turn · drag to move · tap 🔒 to lock"
    : "Mouse turns · drag moves · click locks";
  if (on) $("fitPop").hidden = true;
  sizeField(); renderCentre();
}
function showField(on) {
  fieldOn = on; store.set("vet-field-on", on);
  $("field").hidden = !on; $("centreWrap").hidden = !on; $("fieldBtn").setAttribute("aria-pressed", String(on));
  if (!on) { if (rotating) setRotating(false); $("fitPop").hidden = true; }
}
// Locking fixes the angle and pins the field where it is. Rating the fit then confirms the
// spot: that is when the fields are filled in and the position recorded, and only the
// confirmed spot is saved with a decision. Unlock to move or turn it again.
function lockField() {
  setRotating(false);
  pin = map.getCenter(); sizeField();
  const p = current(); if (!p) return;
  // The rating applies to the single council field closest to where the field was locked.
  const n = nearestFields(p); tagsFor(p).sel = n ? n.key : null; fitOpen = false;
  $("fitPop").hidden = false; drawParkFields(p); drawLights(p); previewFields(p); renderTags(p);
}
function nearestFields(p) {
  const fs = fieldKeys(p); if (!fs.length) return null;
  const c = fieldCentre(), kx = 111320 * Math.cos(c.lat * Math.PI / 180), ky = 110540;
  const byDist = fs.map(x => ({ ...x, m: Math.hypot((x.f.c[1] - c.lng) * kx, (x.f.c[0] - c.lat) * ky) })).sort((a, b) => a.m - b.m);
  return byDist[0];
}
// The rating being edited: the selected field's, if it has a spot.
const curRating = t => t.sel && t.fr[t.sel]?.lat != null ? t.fr[t.sel] : null;
function spotMoved(t) {
  const sp = curRating(t); if (!sp) return false;
  const c = fieldCentre(), kx = 111320 * Math.cos(c.lat * Math.PI / 180);
  const dm = Math.hypot((sp.lon - c.lng) * kx, (sp.lat - c.lat) * 110540);
  const da = Math.abs((((angle - sp.angle) % 360) + 540) % 360 - 180);
  return dm > 3 || da > 2;
}
function previewFields(p) {
  const t = tagsFor(p), moved = spotMoved(t);
  const target = t.sel ? `Rating ${t.sel}` : (() => { const n = nearestFields(p); return n ? `Nearest: ${n.key} (${Math.round(n.m)} m)` : "Rate the fit here"; })();
  // Short label; the how-to lives in the tooltip.
  $("fitMsg").textContent = moved ? `${target} · moved — rate again` : target;
  $("fitMsg").title = moved ? "Rate the fit again to save this spot" : t.sel && t.fr[t.sel]?.fit && t.fr[t.sel].fit !== "unknown" ? "Click a fit to change it, or the same one to clear it" : "Pan to fine-tune, then rate the fit";
  $("fitMsg").classList.toggle("warn", moved);
  // A chosen fit collapses to one button; clicking it reopens the options (fitOpen).
  const chosen = !moved && t.sel && t.fr[t.sel]?.fit && t.fr[t.sel].fit !== "unknown" ? t.fr[t.sel].fit : null;
  $("fitPop").querySelectorAll("[data-fit]").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.fit === chosen));
    b.hidden = !!chosen && !fitOpen && b.dataset.fit !== chosen;
    b.title = chosen && !fitOpen && b.dataset.fit === chosen ? "Change the fit" : ""; });

  $("saveNextBtn").hidden = !IS_ADMIN || !curRating(t) || moved;
  renderLightStep(p);
}
function afterMove() {
  const p = current(); if (!p) return;
  const t = tagsFor(p);
  if (t.spot && spotMoved(t)) $("fitPop").hidden = false;
  if (!$("fitPop").hidden) previewFields(p);
  renderCentre();
}
// Rate the targeted field (the selected one, else the single closest). Rating the same fit
// again clears that field's rating; its lights stay.
function confirmSpot(p, fit) {
  snap(p);
  const t = tagsFor(p), c = fieldCentre();
  if (!t.sel) { const n = nearestFields(p); t.sel = n ? n.key : "This spot"; }
  const cur = t.fr[t.sel] || { name: t.sel, lights: [] };
  if (cur.fit === fit && !spotMoved(t)) { cur.fit = "unknown"; delete cur.lat; delete cur.lon; delete cur.angle; }
  else Object.assign(cur, { name: t.sel, fit, lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), angle: Math.round(angle) });
  t.fr[t.sel] = cur;
  // Rated fields get light poles placed along their long sides (4 to start) until a pole
  // is moved by hand; cleared ratings keep whatever lights they had.
  if (cur.fit !== "unknown" && cur.lightsAuto !== false) { cur.lightCount ??= 4; placeLights(p, cur); }
  syncFromFields(t);
  // The bar stays open so the rating can go straight to "Save · next field".
  drawParkFields(p); drawLights(p); renderTags(p); previewFields(p); renderCentre();
}
// Auto-placed light poles: n poles (always even) split evenly between the field's two long
// sides, a few metres outside the sideline. The first pair goes on the long side nearer the
// council field's own edge (the sideline most likely to have poles), the next pair opposite,
// then one more each side per +2, spaced evenly along the length.
const POLE_OFFSET = 3;   // metres outside the sideline
function placeLights(p, fr) {
  const n = Math.max(0, fr.lightCount || 0), per = n / 2;
  const lat0 = fr.lat, lon0 = fr.lon, th = (fr.angle || 0) * Math.PI / 180;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  // Field-local (u along the length, v across) → lat/lon; the field is drawn rotated
  // clockwise on screen, so screen-x = u·cos − v·sin, screen-y (down) = u·sin + v·cos.
  const at = (u, v) => { const ex = u * Math.cos(th) - v * Math.sin(th), sy = u * Math.sin(th) + v * Math.cos(th);
    return [+(lat0 - sy / ky).toFixed(6), +(lon0 + ex / kx).toFixed(6)]; };
  const half = dims.wid / 2 + POLE_OFFSET;
  // Which long side is nearer the council field's boundary?
  const poly = councilFields(p).find(f => (f.n || "") === fr.name)?.p;
  const distToPoly = pt => { if (!poly?.length) return Infinity; let best = Infinity;
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length];
      const ax = (a[1] - pt[1]) * kx, ay = (a[0] - pt[0]) * ky, bx = (b[1] - pt[1]) * kx, by = (b[0] - pt[0]) * ky;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1, tt = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2));
      best = Math.min(best, Math.hypot(ax + tt * dx, ay + tt * dy)); }
    return best; };
  const first = distToPoly(at(0, -half)) <= distToPoly(at(0, half)) ? -half : half;
  const along = i => -dims.len / 2 + dims.len * (i + 0.5) / per;
  const out = [];
  for (let i = 0; i < per; i++) out.push(at(along(i), first));
  for (let i = 0; i < per; i++) out.push(at(along(i), -first));
  fr.lights = out;
}
function renderLightStep(p) {
  const t = p && tagsFor(p), fr = t?.sel && t.fr[t.sel], on = !!(fr && fr.fit && fr.fit !== "unknown" && fr.lat != null);
  $("lightStep").hidden = !on || !IS_ADMIN;
  if (!on) return;
  $("lightN").textContent = fr.lightsAuto === false ? (fr.lights || []).length : (fr.lightCount ?? 4);
  $("lightStep").classList.toggle("manual", fr.lightsAuto === false);
  $("lightStep").title = fr.lightsAuto === false ? "Lights placed by hand — drag bulbs to change them" : "Light poles for this field: placed along its long sides until you move one";
}
function stepLights(d) {
  const p = current(); if (!p) return; const t = tagsFor(p), fr = t.sel && t.fr[t.sel];
  if (!fr || fr.lat == null || fr.lightsAuto === false) return;
  snap(p); fr.lightCount = Math.max(0, (fr.lightCount ?? 4) + d);
  placeLights(p, fr); syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p); renderLightStep(p);
}
function renderCentre() {
  const p = current(), t = p ? tagsFor(p) : null, moved = !!t && spotMoved(t);
  $("centreWrap").classList.toggle("unlocked", rotating);
  $("centreWrap").classList.toggle("needfit", !rotating && !!t && (!curRating(t) || moved));
  $("centreIco").textContent = rotating ? "🔓" : "🔒";
  $("centreLbl").textContent = rotating ? (matchMedia("(hover: none)").matches ? "Tap to lock it here" : "Click to lock it here")
    : !curRating(t) ? "Unlock to turn · then rate the fit"
    : moved ? "Moved · rate the fit again" : `${t.sel}: ${FIT_LABEL[curRating(t).fit]}`;
}

// ── Auckland view: every park coloured by suitability ────────────────────────
function buildCity() {
  cityLayer.clearLayers(); cityFieldsLayer.clearLayers();
  const reg = $("region").value, cur = current();
  const pts = [];
  PARKS.forEach(p => {
    if ((reg && p.region !== reg) || !interestOk(p)) return;
    const ll = parkLatLng(p); if (!ll) return;
    const r = reviews[p.id], col = suitColor(r), top = r?.decision === "top", isCur = view === "city" && cur?.id === p.id && !!focusId;
    pts.push(ll);
    const pv = privOps(p);
    const fl = !PRIV_BY_PARK[p.id]?.length && flags[p.id];
    const ult = ultimateOf(p);
    const mineHere = workMode === "book" ? myLocs().filter(x => x.park_id === p.id) : [];
    const nAct = mineHere.filter(isActive).length, inCart = mineHere.length - nAct;
    // Book mode: parks with active bookings get a solid dark-teal ring; cart-only parks a dashed one.
    if (nAct) L.circleMarker(ll, { radius: 14, color: "#0f766e", weight: 5, fill: true, fillColor: "#14b8a6", fillOpacity: 0.25, interactive: false }).addTo(cityLayer);
    else if (inCart) L.circleMarker(ll, { radius: 13, color: "#14b8a6", weight: 3, dashArray: "4 3", fill: false, interactive: false }).addTo(cityLayer);
    // An ultimate club's home: a bigger diamond whose centre is the club's colours.
    const clubCol = ult.find(o => o.colors)?.colors;
    const isAmua = pv?.some(o => o.amua);
    // Grounds with a club or venue logo show it (letters until the logo file is added).
    const logoOp = pv?.find(o => o.icons);
    const mk = logoOp ? logoMarker(ll, logoOp.icons, isAmua ? "#e0a647" : ult.length ? ULT_COLOR : PRIV_COLOR, isCur)
      : isAmua ? amuaMarker(ll, col, isCur) : pv?.length ? privMarker(ll, col, isCur, top, clubCol) : L.circleMarker(ll, { radius: r ? 8 : 6,
      color: top ? "#e0a647" : isCur ? "#15211c" : fl ? PRIV_COLOR : "#ffffff", weight: top || isCur || fl ? 3 : 1.5, dashArray: fl ? "3 3" : null,
      fillColor: col, fillOpacity: r ? 0.95 : 0.7, bubblingMouseEvents: false });
    const tags = r ? [r.decision === "top" ? "★ Top pick" : r.decision === "yes" ? "Shortlisted" : r.decision === "rating" ? "Rating in progress" : "Rejected",
      r.quality ? r.quality + "/5" : "", r.fit && r.fit !== "unknown" ? FIT_LABEL[r.fit] : "",
      r.lights === "full" || r.lights === "training" ? "💡 lights" : r.lights === "none" ? "no lights" : ""].filter(Boolean).join(" · ") : "Not rated yet";
    mk.bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.region)} · <b style="color:${col}">${suitWord(r)}</b><br>${esc(tags)}${r?.fields ? "<br>Fields: " + esc(r.fields) : ""}`
      + (isAmua ? `<br><b style="color:#b7791f">★ Book only through: AMUA</b>`
        : pv?.length ? `<br><b style="color:${PRIV_COLOR}">◆ Privately managed: contact ${esc(pv[0].short)}</b> first` : "")
      + (ult.length ? `<br><b style="color:${ULT_COLOR}">🥏 ${ult.some(o => o.booking_only) ? "Book only through" : "Ultimate club"}: ${esc(ult.map(o => o.operator).join(", "))}</b>` : "")
      + (flags[p.id] ? `<br><b style="color:${PRIV_COLOR}">✎ ${esc(amendText(flags[p.id]))}</b>` : "")
      + (workMode === "book" ? `<br>${nAct ? `📌 ${nAct} active booking field${nAct > 1 ? "s" : ""} · ` : ""}${inCart ? `🛒 ${inCart} in the cart · ` : ""}<i>Click to book fields</i>` : `<br><i>Click to rate</i>`),
      { className: "parktip", direction: "top", offset: [0, -6] });
    mk.on("click", () => openPark(p.id));
    mk.addTo(cityLayer);
    const fs = p.maps[0]?.fields || [];
    const chosen = new Set((r?.fields || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
    fs.forEach(f => L.polygon(f.p, { pane: "fieldsPane", color: col, weight: chosen.has((f.n || "").toLowerCase()) ? 3 : 1.5, fillColor: col,
      fillOpacity: chosen.has((f.n || "").toLowerCase()) ? 0.45 : 0.22, bubblingMouseEvents: false })
      .bindTooltip(`${esc(p.name)}${f.n ? " · " + esc(f.n) : ""} — ${suitWord(r)}`, { className: "parktip", sticky: true })
      .on("click", () => openPark(p.id)).addTo(cityFieldsLayer));
  });
  // Private grounds that aren't in the council maps: hollow diamonds with the operator's contacts.
  PRIV.operators.filter(o => !o.park_id || !BYID[o.park_id]).forEach(o => {
    const ll = [o.lat, o.lon]; pts.push(ll);
    // Community facilities can be booked like council fields: in Book mode their popup adds
    // them to the cart, and their badge gets the cart / active ring.
    const comm = o.category === "community";
    if (comm && workMode === "book") { const st = locState("cm-" + o.id);
      if (st === "active") L.circleMarker(ll, { radius: 13, color: "#0f766e", weight: 4, fill: true, fillColor: "#14b8a6", fillOpacity: 0.25, interactive: false }).addTo(cityLayer);
      else if (st) L.circleMarker(ll, { radius: 12, color: "#14b8a6", weight: 3, dashArray: "4 3", fill: false, interactive: false }).addTo(cityLayer); }
    (o.icons ? logoMarker(ll, o.icons, comm ? COMM_COLOR : o.amua ? "#e0a647" : PRIV_COLOR, false, o.amua ? 700 : 550, comm) : o.amua ? amuaMarker(ll, "#ffffff", false) : privMarker(ll, "transparent", false, false))
      .bindPopup(() => privHtml(o) + (comm && workMode === "book" ? communityBookHtml(o) : ""), { className: "parktip", maxWidth: 320 })
      .bindTooltip(amuaOnly(o) ? `<b>${esc(o.park)}</b><br>Click to book in Facility Booking` : `<b>${esc(o.park)}</b><br><b style="color:${PRIV_COLOR}">◆ ${esc(o.operator)}</b><br>Not in the council field maps · click for contacts`, { className: "parktip", direction: "top", offset: [0, -8] })
      .addTo(cityLayer);
  });
  return pts;
}
// AMUA's existing providers (GTEC, booked through CPSA at Cornwall Park): a gold star whose
// centre shows the suitability colour.
// A round badge per logo (several overlap if a ground lists more than one). The
// image sits over the club's letters; if the logo file isn't there yet it removes itself.
// Sizes: AMUA's own badge 36px, other clubs and venues 27px, community facilities 18px.
function logoMarker(ll, icons, ring, isCur, z = 600, small = false) {
  const badge = (ic, i) => `<span class="lp" style="background:${ic.bg || "#334155"};z-index:${9 - i}"><b>${esc(ic.mono || "")}</b>`
    + (ic.img ? `<img src="${BASE}council-maps/${esc(ic.img)}" alt="" onerror="this.remove()">` : "") + `</span>`;
  const d = small ? 18 : icons.some(ic => ic.mono === "AMUA") ? 36 : 27, w = d + (icons.length - 1) * (d * 2 / 3);
  return L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [w, d], iconAnchor: [w / 2, d / 2],
    html: `<div class="logopin${isCur ? " cur" : ""}${d <= 18 ? " sm" : d < 36 ? " md" : ""}" style="--ring:${ring}">${icons.map(badge).join("")}</div>` }), keyboard: false, bubblingMouseEvents: false, zIndexOffset: z });
}
function amuaMarker(ll, fill, isCur) {
  return L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="amuapin${isCur ? " cur" : ""}"><div><span style="background:${fill}"></span></div></div>` }), keyboard: false, bubblingMouseEvents: false, zIndexOffset: 500 });
}
function privMarker(ll, fill, isCur, top, club) {
  const style = club
    ? `background:${club.pattern || club.fill};border-color:${club.edge || "#fff"};box-shadow:0 0 0 2.5px ${PRIV_COLOR},0 1px 5px rgba(0,0,0,.5);width:18px;height:18px;margin:2px`
    : `background:${fill};${top ? "border-color:#e0a647;" : ""}margin:3px`;
  return L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="privpin${isCur ? " cur" : ""}" style="${style}"></div>` }), keyboard: false, bubblingMouseEvents: false });
}
function privContacts(o) {
  const c = o.contact || {}, bits = [];
  if (c.email) bits.push(`<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
  if (c.phone) bits.push(`<a href="tel:${esc(c.phone.replace(/[^+\d]/g, ""))}">${esc(c.phone)}</a>`);
  if (c.url) bits.push(`<a href="${esc(c.url)}" target="_blank" rel="noopener">website ↗</a>`);
  return bits.join(" · ");
}
const privStatus = o => ({ confirmed: "confirmed", likely: "likely", "to-verify": "to verify" }[o.status] || o.status);
// The four-step request workflow (PRIV.workflow) belongs to booking, not vetting; see multi-provider design §7.1.
// Popup for a private ground that isn't a council park.
// AMUA's own grounds (GTEC / CPSA at Cornwall Park) are booked only through the booking site,
// so their popup is just the way back there.
const amuaOnly = o => o.must_book_through === "AMUA" && o.category !== "community";
function privHtml(o) {
  if (amuaOnly(o)) return `<b>${esc(o.park)}</b><br><a href="${BASE}">📅 Book in Facility Booking</a>`;
  const c = o.contact || {};
  return `<b>${esc(o.park)}</b>${o.approx ? " (approx. location)" : ""}${o.must_book_through === "AMUA" ? `<br><b style="color:#b7791f">★ BOOKING ONLY AVAILABLE THROUGH AMUA</b>` : ""}<br><b style="color:${PRIV_COLOR}">◆ ${esc(o.operator)}</b> · ${esc(privStatus(o))}<br>${esc(o.manages)}<br>${privContacts(o)}${c.address ? "<br>" + esc(c.address) : ""}${o.notes ? `<br><i>${esc(o.notes)}</i>` : ""}`;
}
// Park card banner: every operator on this ground, then the request steps once.
function privBanner(all) {
  // Ultimate clubs get their own line; the field contact is the managing club.
  const ult = all.filter(o => o.code === "ultimate" && !o.booking_only), ops = all.filter(o => o.code !== "ultimate" || o.booking_only);
  const ultLine = ult.map(o => `<span class="pb-ult"><b>🥏 ${esc(o.operator)}</b> — ${privContacts(o) || "no contact found"}${o.notes ? ` <i>${esc(o.notes)}</i>` : ""}</span>`).join("");
  if (!ops.length) return ultLine;
  const [lead, ...rest] = ops;
  // AMUA's own provider grounds (GTEC / CPSA): booked through the AMUA booking site.
  const amua = all.find(o => o.must_book_through === "AMUA");
  if (amua) return `<span class="pb-amua pb-only"><b>★ BOOKING ONLY AVAILABLE THROUGH AMUA</b> — <a href="${BASE}">AMUA booking site ↗</a> <i>GTEC / CPSA workflow; don't book directly with GTEC.</i></span>`
    + `<span class="pb-full">Fields managed by: ${all.filter(o => o.code !== "ultimate").map(o => `${esc(o.operator)} (${esc(o.code || o.type)})`).join(" · ")}</span>` + ultLine;
  if (lead.booking_only) return `<span class="pb-ult pb-only"><b>🥏 BOOKING ONLY AVAILABLE THROUGH ${esc(lead.operator)}</b> — ${privContacts(lead) || "no contact found"}${lead.notes ? ` <i>${esc(lead.notes)}</i>` : ""}</span>`
    + (rest.length ? `<span class="pb-full">Fields managed by: ${rest.map(o => `${esc(o.operator)} (${esc(o.code || o.type)})`).join(" · ")}</span>` : "") + ultLine;
  return `<span class="pb-full"><b>◆ Contact: ${esc(lead.operator)}</b> (${esc(privStatus(lead))}) — ${esc(lead.manages)} · ${privContacts(lead)}</span>`
    + `<span class="pb-short"><b>◆ ${esc(lead.short)}</b> · ${privContacts(lead)}${rest.length ? ` · +${rest.length} club${rest.length > 1 ? "s" : ""}` : ""}</span>`
    + ultLine
    + (rest.length ? `<span class="pb-full">Also on site: ${rest.map(o => `${esc(o.operator)} (${esc(o.code || o.type)}${o.contact?.url ? `, <a href="${esc(o.contact.url)}" target="_blank" rel="noopener">website ↗</a>` : ""})`).join(" · ")}</span>` : "")
    ;
}
function councilOnlyBanner(p) {
  const ops = PRIV_BY_PARK[p.id] || [];
  return `<span class="pb-co"><b>🏛 Council booking only</b> — ${ops.map(o => esc(o.operator)).join(" · ")} ${ops.length > 1 ? "are" : "is"} based here, but bookings go straight to Auckland Council; no club permission needed.</span>`;
}
function syncCityFields() {
  if (view !== "city") return;
  const want = map.getZoom() >= 14.5;
  if (want && !map.hasLayer(cityFieldsLayer)) cityFieldsLayer.addTo(map);
  if (!want && map.hasLayer(cityFieldsLayer)) cityFieldsLayer.remove();
}
function renderLegend() {
  const row = (c, t) => `<div><i style="background:${c}"></i>${t}</div>`;
  $("legend").innerHTML = `<button class="lg-h" id="legendToggle" aria-expanded="true">Suitability <span aria-hidden="true">▾</span></button>`
    + `<div class="lg-b">${row(`hsl(${suitHue(0.95)} 72% 42%)`, "Excellent")}${row(`hsl(${suitHue(0.7)} 72% 42%)`, "Good")}${row(`hsl(${suitHue(0.5)} 72% 42%)`, "Fair")}${row(`hsl(${suitHue(0.2)} 72% 42%)`, "Poor")}${row("#b3372d", "Rejected")}${row("#8a958f", "Not rated")}<div><span class="dia" style="background:linear-gradient(45deg,#f2b705 50%,#c8102e 50%);border-color:#f2b705;box-shadow:0 0 0 2px ${PRIV_COLOR}"></span><b>Ultimate club home</b> <span class="lg-note">(club colours)</span></div><div><span class="amualg"><span></span></span><b>AMUA venue</b> <span class="lg-note">(GTEC · CPSA)</span></div><div><span class="logolg">A</span>Club or venue logo</div><div><span class="logolg" style="border-color:${COMM_COLOR}">S</span>Community facility <span class="lg-note">(school)</span></div><div><span class="dia"></span>Privately managed</div><div><i style="background:#8a958f;border:2px dashed ${PRIV_COLOR};box-shadow:none"></i>Flagged: probably club-run</div><div class="lg-note">Gold ring = top pick</div></div>`;
  // Collapsed by default on small screens so it doesn't cover the map; the choice is remembered.
  const setOpen = open => { $("legend").classList.toggle("collapsed", !open); $("legendToggle").setAttribute("aria-expanded", String(open)); };
  setOpen(store.get("vet-legend-open", !matchMedia("(max-width: 640px)").matches));
  $("legendToggle").onclick = () => { const open = $("legend").classList.contains("collapsed"); store.set("vet-legend-open", open); setOpen(open); };
}
function setView(v, { refit } = {}) {
  const was = view; view = v; store.set("vet-view", v);
  $("cityTab").setAttribute("aria-selected", String(v === "city")); $("parkTab").setAttribute("aria-selected", String(v === "park"));
  $("bookTab").setAttribute("aria-selected", String(v === "book"));
  $("card").classList.toggle("city", v === "city"); $("card").classList.toggle("book", v === "book");
  $("cityInfo").hidden = v !== "city"; $("legend").hidden = v !== "city";
  $("bookPanel").hidden = v !== "book";
  $("railBox").hidden = v !== "book";
  applyModeUi();
  if (v === "book" && rotating) setRotating(false);
  if (v === "city") {
    if (rotating) setRotating(false);
    $("fitPop").hidden = true;
    if (was === "park" && shownPark) { /* remember nothing: the city view keeps its own position */ }
    if (overlay) { overlay.remove(); overlay = null; }
    if (overlayPanel) { overlayPanel.remove(); overlayPanel = null; }
    shownPark = null;
    lightLayer.remove(); parkFieldsLayer.remove();
    cityLayer.addTo(map);
    const pts = buildCity();
    map.invalidateSize();
    if (refit || !cityHome) map.fitBounds($("region").value && pts.length ? L.latLngBounds(pts).pad(0.05) : DEFAULT_VIEW, { animate: false, padding: [24, 24] });
    else map.setView(cityHome.c, cityHome.z, { animate: false });
    syncCityFields();
  } else {
    if (was === "city") cityHome = { c: map.getCenter(), z: map.getZoom() };
    cityLayer.remove(); cityFieldsLayer.remove();
    lightLayer.addTo(map); parkFieldsLayer.addTo(map);
    map.invalidateSize();
  }
  render();
}
function openPark(id) { focusId = id; focusFrom = "city"; setView("park"); }
// Back: the park shown before this one (a decided park opens for changing its decision).
function goBack() {
  const cur = current()?.id;
  while (visited.length && visited[visited.length - 1] === cur) visited.pop();
  const prev = visited.pop(); if (!prev || !BYID[prev]) return;
  focusId = prev; focusFrom = "back"; shownPark = null; $("fitPop").hidden = true; if (rotating) setRotating(false); render();
}
// Rating undo: snapshot a park's draft before each change; Undo restores the last one.
function snap(p) { if (!p) return; (edits[p.id] ||= []).push(JSON.stringify(tagsFor(p))); if (edits[p.id].length > 50) edits[p.id].shift(); }
function editUndo() {
  const p = current(); const st = p && edits[p.id]; if (!st?.length) return;
  const sel = tagsFor(p).sel; draft[p.id] = JSON.parse(st.pop()); draft[p.id].sel = sel;
  syncFromFields(draft[p.id]); drawParkFields(p); drawLights(p); renderTags(p); if (!$("fitPop").hidden) previewFields(p); renderCentre();
}

// ── Book: add council fields to a booker's booking locations ─────────────────
// Stored in the shared settings table under "council_facilities" as
// { "<booker email>": [ {id, park_id, park, region, field, lat, lon, kind, operator, added_at, added_by} ] }.
// The booking site turns each entry into a facility at the "<provider>|<park>" venue, visible
// to that booker (and admins), with the council or council + private-operator workflow.
const BOOK_KEY = "council_facilities";
let bookLocs = {}, bookFor = "", bookSel = new Set(), bookSelPark = null;
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function loadBookLocs() {
  if (supabase && session) {
    const { data, error } = await supabase.from("settings").select("value").eq("key", BOOK_KEY).maybeSingle();
    if (!error) { bookLocs = data?.value || {}; return; }
  }
  bookLocs = store.get("vet-booklocs", {});
}
async function saveBookLocs() {
  if (supabase && session && !IS_ADMIN) {
    // Bookers can only change their own cart, through a database function.
    const who = whoBooks();
    const { data, error } = await supabase.rpc("set_my_council_facilities", { entries: bookLocs[who] || [] });
    if (error) { setStatus("Couldn't save your cart (" + error.message + "). An admin may need to run supabase-migration-council-fields-access.sql.", true); return false; }
    bookLocs = data || {}; return true;
  }
  if (supabase && session) {
    // Re-read first so two admins adding at once don't overwrite each other's bookers.
    const { data } = await supabase.from("settings").select("value").eq("key", BOOK_KEY).maybeSingle();
    const fresh = data?.value || {}, who = bookFor.toLowerCase();
    fresh[who] = bookLocs[who] || []; if (!fresh[who].length) delete fresh[who];
    const { error } = await supabase.from("settings").upsert({ key: BOOK_KEY, value: fresh, updated_at: new Date().toISOString() });
    if (error) { setStatus("Couldn't save booking locations (" + error.message + ").", true); return false; }
    bookLocs = fresh; return true;
  }
  store.set("vet-booklocs", bookLocs); return true;
}
// ── Community facilities (schools, trusts) in the cart: one entry per facility, "cm-<id>" ──
function communityBookHtml(o) {
  const st = locState("cm-" + o.id);
  return `<div class="cm-book">${st === "active" ? "📌 Active booking — book dates in Facility Booking"
    : `<button data-cmbook="${esc(o.id)}">${st ? "🛒 In the cart · remove" : "📅 Add to cart"}</button>`}</div>`;
}
async function toggleCommunity(o) {
  const who = whoBooks(), before = [...(bookLocs[who] || [])], list = [...before], id = "cm-" + o.id, i = list.findIndex(x => x.id === id);
  if (i >= 0 && isActive(list[i])) return;
  if (i >= 0) list.splice(i, 1);
  else list.push({ id, park_id: o.id, park: o.park, region: "", field: "Main field", lat: o.lat, lon: o.lon, kind: "community", status: "cart",
    operator: { id: o.id, name: o.operator, short: o.short, email: o.contact?.email || "", phone: o.contact?.phone || "" },
    added_at: new Date().toISOString(), added_by: session?.user?.email || "" });
  bookLocs[who] = list;
  if (!(await saveBookLocs())) { bookLocs[who] = before; return; }
  setStatus(`${i >= 0 ? "Removed" : "Added"} ${o.short || o.operator} ${i >= 0 ? "from" : "to"} ${who}'s cart.`);
  map.closePopup(); render(); renderTabs();
}
document.addEventListener("click", e => { const b = e.target.closest("[data-cmbook]"); if (!b) return;
  const o = (PRIV.operators || []).find(x => x.id === b.dataset.cmbook); if (o) toggleCommunity(o); });
// A privately managed park's booking is filed under the club that manages the fields, but
// requests go to its booking contact: a booking-only club (e.g. Ellerslie Ultimate Club at
// Michaels Ave, managed by Ellerslie AFC), else the manager itself.
function parkWorkflow(p) {
  const ops = privOps(p);
  const manager = ops.find(o => o.code !== "ultimate") || ops.find(o => o.booking_only);
  const contact = ops.find(o => o.booking_only) || manager;
  return manager ? { kind: "council_private", provider: "op_" + manager.id, operator: { id: manager.id, name: manager.operator, short: manager.short,
      contact_name: contact.operator, email: contact.contact?.email || "", phone: contact.contact?.phone || "", url: contact.contact?.url || "" } }
    : { kind: "council", provider: "akl_council", operator: null };
}
const venueLink = (provider, park) => `${BASE}?venue=${encodeURIComponent(provider + "|" + park)}`;
const cartId = (p, key) => `cf-${p.id}--${slug(key)}`;
const whoBooks = () => (bookFor = (bookFor || session?.user?.email || "demo@local").toLowerCase());
// A booker's council fields: "cart" entries are being chosen; saving the cart makes them
// "active" bookings, which the booking site offers as Provider → Location → Facility.
const isActive = x => x.status === "active";
const myLocs = () => bookLocs[whoBooks()] || [];
const cartOf = () => myLocs().filter(x => !isActive(x));
const activeOf = () => myLocs().filter(isActive);
const locState = id => { const x = myLocs().find(y => y.id === id); return !x ? null : isActive(x) ? "active" : "cart"; };
// Save every cart field as an active booking.
async function saveCartActive() {
  const who = whoBooks(), before = myLocs().map(x => ({ ...x })), n = cartOf().length;
  if (!n) return;
  const at = new Date().toISOString();
  bookLocs[who] = before.map(x => isActive(x) ? x : { ...x, status: "active", activated_at: at });
  if (!(await saveBookLocs())) { bookLocs[who] = before; return; }
  setStatus(`Saved ${n} field${n > 1 ? "s" : ""} as active bookings. They're now in the booking site under Provider → Location.`);
  render(); renderTabs(); if (view === "book") renderBook();
}
// Add or remove one field (or "Whole park") of a park in the booker's cart; saves at once.
async function toggleCart(p, key) {
  const who = whoBooks(), before = [...(bookLocs[who] || [])], list = [...before], id = cartId(p, key), i = list.findIndex(x => x.id === id);
  if (i >= 0 && isActive(list[i])) {
    setStatus(`${p.name} – ${key} is an active booking. Remove it under 🛒 Cart → Active bookings.`); return;
  }
  if (i >= 0) list.splice(i, 1);
  else {
    const wf = parkWorkflow(p), f = fieldKeys(p).find(x => x.key === key)?.f, c = f?.c || [p.lat, p.lon];
    list.push({ id, park_id: p.id, park: p.name, region: p.region, field: key, lat: c[0], lon: c[1], kind: wf.kind, operator: wf.operator, status: "cart",
      added_at: new Date().toISOString(), added_by: session?.user?.email || "" });
  }
  bookLocs[who] = list;
  const saved = await saveBookLocs();
  if (!saved) { bookLocs[who] = before; drawParkFields(p); renderBookBar(p); renderTabs(); return; }   // not saved: don't show it as in the cart
  // A field added before it's been rated: switch to Rate mode on it, so its orientation
  // and fit get set (the ultimate field jumps onto it).
  const rt = tagsFor(p).fr[key];
  if (IS_ADMIN && saved && i < 0 && key !== "Whole park" && !(rt?.fit && rt.fit !== "unknown")) {
    setStatus(`Added ${p.name} – ${key} to ${who}'s cart. It isn't rated yet: set its orientation and fit, then switch back to Book.`);
    setMode("rate"); selectField(p, key); renderTabs(); return;
  }
  if (saved) setStatus(`${i >= 0 ? "Removed" : "Added"} ${p.name} – ${key} ${i >= 0 ? "from" : "to"} ${who}'s cart.`);
  drawParkFields(p); renderBookBar(p); renderTabs();
}
function workflowHtml(wf) {
  return wf.kind === "council_private"
    ? `<span class="wf"><b>◆ Council + ${esc(wf.operator.name)}</b> · contact ${esc(wf.operator.contact_name || wf.operator.name)}${wf.operator.email || wf.operator.phone ? ` (${esc([wf.operator.email, wf.operator.phone].filter(Boolean).join(" · "))})` : ""}: ask the contact → apply to council → wait → confirm with the contact</span>`
    : `<span class="wf"><b>🏛 Council booking</b>: AMUA review → apply to council → wait for the decision</span>`;
}
// Book mode's bar under the park map: booker, this park's fields in the cart, workflow, fee.
function renderBookBar(p) {
  const who = whoBooks(), wf = parkWorkflow(p), inPark = myLocs().filter(x => x.park_id === p.id);
  const actHere = inPark.filter(isActive), cartHere = inPark.filter(x => !isActive(x)), nCart = cartOf().length;
  const whole = inPark.some(x => x.field === "Whole park"), known = Object.keys(bookLocs).filter(e => e !== who);
  $("bookBar").innerHTML = `<div class="bb-row"><label>Booking for ${IS_ADMIN ? `<input id="bookWho2" list="bookWhoList2" value="${esc(who)}" title="The booker whose cart this is">` : `<b>${esc(who)}</b>`}</label>
      <datalist id="bookWhoList2">${known.map(e => `<option value="${esc(e)}">`).join("")}</datalist>
      <button class="b" id="bbWhole" aria-pressed="${whole}" title="Book the park without choosing fields">Whole park</button>
      <button class="b" id="bbCart">🛒 Cart (${nCart})</button>
      ${nCart ? `<button class="b save" id="bbSave" title="Save every cart field as an active booking">✅ Save cart as active bookings</button>` : ""}
      ${actHere.length ? `<a href="${venueLink(wf.provider, p.name)}" target="_blank" rel="noopener">Book in Facility Booking ↗</a>` : ""}</div>
    <div class="bb-row">${actHere.map(x => `<span class="chipf act" title="Active booking">📌 ${esc(x.field)}</span>`).join("")}
      ${cartHere.map(x => `<span class="chipf" title="In the cart, not booked yet">🛒 ${esc(x.field)} <button data-uncart="${esc(x.field)}" title="Remove">✕</button></span>`).join("")}
      ${inPark.length ? "" : `<span class="muted">Click a field area on the map to add it to the cart.</span>`}</div>
    <div class="bb-row">${workflowHtml(wf)}</div>
    <div class="bb-row muted">Council fee: $10 per field per application, pending until AMUA sends it, then split between the bookers sharing each field.</div>`;
}
// The booker's council contact (booker_contacts): they're the key holder on AMUA's council
// application, and council fields can't be booked until it's filled in. undefined = unknown.
const contactCache = {};
async function loadContact(who) {
  if (!supabase || !session || who in contactCache) return;
  contactCache[who] = undefined;
  const { data, error } = await supabase.from("booker_contacts").select("*").eq("email", who).maybeSingle();
  contactCache[who] = error ? "n/a" : data || null;
  if (view === "book") renderBook();
}
function contactNote(who) {
  const c = contactCache[who];
  if (c === undefined || c === "n/a") return "";
  const ok = c && c.full_name && c.phone;
  return ok ? `<p class="muted">📇 Key holder on council applications: <b>${esc(c.full_name)}</b> · ${esc(c.phone)} <a href="./?contact=1">edit</a></p>`
    : `<p class="warn-note">📇 <b>Add ${who === (session?.user?.email || "").toLowerCase() ? "your" : "the booker's"} council contact</b> (name and phone) before booking these fields — the booker is the key holder on AMUA's council application.
       <a href="./?contact=1">Add it in Facility Booking ↗</a></p>`;
}
// The Cart tab: fields being chosen (cart), then the booker's active bookings.
function renderBook() {
  const who = whoBooks(), known = Object.keys(bookLocs).filter(e => e !== who), cart = cartOf(), act = activeOf();
  loadContact(who);
  const tag = x => x.kind === "community" ? `<span class="tag comm">🏫 community</span>` : `<span class="tag${x.kind === "council_private" ? " priv" : ""}">${x.kind === "council_private" ? "◆ " + esc(x.operator?.short || "operator") + " + council" : "🏛 council"}</span>`;
  const prov = x => x.kind === "community" ? "cm_" + x.operator.id : x.kind === "council_private" ? "op_" + x.operator.id : "akl_council";
  const parks = xs => new Set(xs.map(x => x.park)).size;
  $("bookPanel").innerHTML = `<div class="bk-who"><h3>📌 Active bookings / 🛒 Cart</h3><label>for ${IS_ADMIN ? `<input id="bookWho" list="bookWhoList" value="${esc(who)}" title="The booker whose cart this is">` : `<b>${esc(who)}</b>`}</label>
      <datalist id="bookWhoList">${known.map(e => `<option value="${esc(e)}">`).join("")}</datalist></div>
    ${contactNote(who)}
    <p class="muted">${IS_ADMIN ? `<b>★ Top pick</b> or <b>✓ Shortlist</b> a park and its rated fields become active here (Reject removes them). Then book dates and times in Facility Booking (Provider → Location → Facility).`
      : `1. In <b>📅 Book</b> mode, open a park from the Auckland map and click its field areas to add them here. 2. <b>Save them as active bookings</b>. 3. Book dates and times for them in Facility Booking (Provider → Location → Facility).`}</p>
    <section class="bk-sec"><h4>🛒 In the cart <span class="muted">${cart.length} field${cart.length === 1 ? "" : "s"}${cart.length ? ` at ${parks(cart)} park${parks(cart) === 1 ? "" : "s"}` : ""} · not booked yet</span></h4>
      <div class="bk-list">${cart.length ? cart.map(x => `<div class="bk-row"><span class="n">${esc(x.park)} – ${esc(x.field)}</span>${tag(x)}
        ${x.kind === "community" ? "" : `<button data-bkopen="${esc(x.park_id)}" title="Open this park in Book mode">open</button>`}
        <button data-bkdel="${esc(x.id)}" title="Remove from the cart">✕</button></div>`).join("") : `<p class="muted">Nothing in the cart.</p>`}</div>
      ${cart.length ? `<div class="bk-go"><button class="primary" id="bkSave">✅ Save ${cart.length} field${cart.length === 1 ? "" : "s"} as active bookings</button></div>` : ""}</section>
    <section class="bk-sec act"><h4>📌 Active bookings <span class="muted">${act.length} field${act.length === 1 ? "" : "s"} · in Facility Booking</span></h4>
      <div class="bk-list">${act.length ? act.map(x => `<div class="bk-row"><span class="n">${esc(x.park)} – ${esc(x.field)}</span>${tag(x)}
        ${x.kind === "community" ? "" : `<button data-bkopen="${esc(x.park_id)}" title="Open this park in Book mode">open</button>`}
        <a href="${venueLink(prov(x), x.park)}" target="_blank" rel="noopener">book dates ↗</a>
        <button data-bkdel="${esc(x.id)}" data-active="1" title="Remove this active booking field">✕</button></div>`).join("") : `<p class="muted">No active bookings yet. Save cart fields to make them bookable.</p>`}</div></section>`;
}
function renderTabs() { const c = cartOf().length, a = activeOf().length;
  $("bookTab").innerHTML = `📌<span class="tl"> Active bookings</span>${a ? ` (${a})` : ""} / 🛒<span class="tl"> Cart</span>${c ? ` (${c})` : ""}`; }
function applyModeUi() {
  const book = workMode === "book";
  $("modeRate").setAttribute("aria-checked", String(!book)); $("modeBook").setAttribute("aria-checked", String(book));
  document.querySelector(".modetabs").hidden = true;
  $("card").classList.toggle("bookmode", book);
  $("info").hidden = view !== "park" || book; $("bookBar").hidden = view !== "park" || !book;
  $("actions").hidden = view !== "park" || book;
  if (book && rotating) setRotating(false);
  if (book) $("fitPop").hidden = true;
}
function setMode(m) {
  // One way into the active fields: admins decide (top pick / shortlist adds the park's
  // rated fields); bookers, who don't rate, pick fields in Book mode.
  m = IS_ADMIN ? "rate" : "book";
  workMode = m; store.set("vet-work-mode", m); applyModeUi();
  const p = current(); if (p && view === "park") { drawParkFields(p); drawLights(p); }
  render();
}
function bindBook() {
  const who = e => { bookFor = e.target.value.trim().toLowerCase(); renderTabs(); render(); };
  $("bookPanel").addEventListener("change", e => { if (e.target.id === "bookWho") who(e); });
  $("bookBar").addEventListener("change", e => { if (e.target.id === "bookWho2") who(e); });
  $("bookBar").addEventListener("click", e => { const p = current(); if (!p) return;
    const un = e.target.closest("[data-uncart]"); if (un) return toggleCart(p, un.dataset.uncart);
    if (e.target.id === "bbWhole") return toggleCart(p, "Whole park");
    if (e.target.id === "bbCart") setView("book");
    if (e.target.id === "bbSave") saveCartActive(); });
  $("bookPanel").addEventListener("click", async e => {
    const del = e.target.closest("[data-bkdel]");
    if (e.target.id === "bkSave") return saveCartActive();
    if (del && del.dataset.active && !confirm("Remove this field from the active bookings? It won't be offered in Facility Booking any more (existing bookings stay).")) return;
    if (del) { const w = whoBooks(), before = bookLocs[w] || []; bookLocs[w] = before.filter(x => x.id !== del.dataset.bkdel);
      if (await saveBookLocs()) setStatus("Removed from " + w + "'s cart."); else bookLocs[w] = before;
      renderBook(); renderTabs(); return; }
    const op = e.target.closest("[data-bkopen]"); if (op) { if (workMode !== "book") setMode("book"); openPark(op.dataset.bkopen); }
  });
  $("modeRate").onclick = () => setMode("rate");
  $("modeBook").onclick = () => setMode("book");
}

// ── Render ───────────────────────────────────────────────────────────────────
// A park with council fields but nothing rated yet needs its field data first: the
// decision buttons (reject / top pick / shortlist) give way to the fit bar, docked in their
// place. Once a field is rated (or the park already has a decision) they come back, and the
// fit bar returns to the map for editing.
let fitHome = null;
function needsData(p) {
  if (!p || !IS_ADMIN || workMode === "book" || view !== "park" || reviews[p.id] || !councilFields(p).length) return false;
  return !Object.values(tagsFor(p).fr).some(x => x.fit && x.fit !== "unknown" && x.lat != null);
}
function dockFitBar(p) {
  const dock = needsData(p), bar = $("fitPop"), acts = $("actions");
  acts.classList.toggle("collect", dock);
  if (dock && bar.parentElement !== acts) { fitHome ||= bar.parentElement; acts.appendChild(bar); }
  else if (!dock && fitHome && bar.parentElement === acts) fitHome.appendChild(bar);
  if (dock) previewFields(p);
}
function renderTags(p) {
  const t = tagsFor(p);
  dockFitBar(p);
  $("editUndoBtn").disabled = !edits[p.id]?.length;
  $("segQuality").innerHTML = [1, 2, 3, 4, 5].map(n => `<button data-tag="quality" data-val="${n}" aria-pressed="${t.quality === n}" title="${n}/5">${n <= t.quality ? "★" : "☆"}</button>`).join("");
  // Fit and lights are set on the map (fit bar, bulb dispenser); here they're read-outs.
  const rated = Object.values(t.fr).filter(x => x.fit && x.fit !== "unknown");
  $("fitVal").textContent = rated.length ? rated.map(x => `${x.name}: ${FIT_LABEL[x.fit]}`).join(" · ") : "click a field area, or lock the field, then rate";
  $("fitVal").classList.toggle("unset", t.fit === "unknown");
  const nl = allLights(t).length, ns = t.sel ? (t.fr[t.sel]?.lights || []).length : null;
  $("lightsVal").textContent = nl ? `💡 ${nl} pole${nl > 1 ? "s" : ""}${ns !== null ? ` (${ns} on ${t.sel})` : ""}`
    : t.lights === "none" ? "none" : t.lights === "training" || t.lights === "full" ? "yes" : "drag 💡 onto poles";
  $("lightsVal").classList.toggle("unset", t.lights === "unknown");
  if (document.activeElement !== $("fieldsIn")) $("fieldsIn").value = t.fields;
  if (document.activeElement !== $("notesIn")) $("notesIn").value = t.notes;
  renderCentre();
}
// Parks in the private-operator list can be switched to council-only (and back).
function renderCouncilOnly(p) {
  const ops = PRIV_BY_PARK[p.id] || [], b = $("councilOnlyBtn");
  b.hidden = !ops.length || ops.some(o => o.must_book_through);
  if (b.hidden) return;
  const co = councilOnly(p), ov = councilOnlyOv[p.id];
  b.setAttribute("aria-pressed", String(co));
  b.textContent = co ? "🏛 Council only ✓" : "🏛 Council only?";
  b.title = (co ? "Bookings go straight to the council. Click to use the private-operator workflow again."
    : "Only the council needs to be contacted here: drop the private-operator workflow for this park.")
    + (ov?.by ? ` (set by ${ov.by.split("@")[0]})` : "");
}
async function loadCouncilOnly() {
  if (supabase && session) {
    const { data, error } = await supabase.from("settings").select("value").eq("key", CO_KEY).maybeSingle();
    if (!error) { councilOnlyOv = data?.value || {}; return; }
  }
  councilOnlyOv = store.get("vet-council-only", {});
}
// ── Operator info (ⓘ): local-board links from the data file, and AMUA's relationship history
// with each operator from the settings key "operator_relations" (signed-in users only):
// { operator_id: { rating, contacts:[{name,role}], community:[{name,link,with}], events:[{date,tag,ref,tone}] } }.
const REL_KEY = "operator_relations";
const REL = {
  rating: { good: "Good", neutral: "Neutral", difficult: "Difficult", unknown: "Unknown" },
  role: { contact: "contact", manager: "manager", president: "president", secretary: "secretary", groundsperson: "groundsperson" },
  link: { knows_contact: "knows", dealt_with: "dealt with them", organised_event: "organised an event there", member: "member" },
  tag: { event_held: "Event held there", tournament_damage: "Tournament damage", booking_granted: "Booking granted", booking_declined: "Booking declined", access_issue: "Access issue", cooperative: "Cooperative", no_response: "No response" },
  tone: { positive: "👍", neutral: "·", negative: "👎" },
};
let relations = {}, infoOpenFor = null;
// People are often tagged here without asking them, so only a first name and last initial is
// ever kept: "Clare Gibson" → "Clare G.", "Rory H" → "Rory H.".
const shortName = s => { const w = String(s || "").trim().split(/\s+/).filter(Boolean);
  return w.length < 2 ? (w[0] || "") : `${w[0]} ${w[w.length - 1][0].toUpperCase()}.`; };
async function loadRelations() {
  if (!supabase || !session) { relations = store.get("vet-relations", {}); return; }
  const { data, error } = await supabase.from("settings").select("value").eq("key", REL_KEY).maybeSingle();
  relations = error ? {} : data?.value || {};
}
async function saveRelation(id, rel) {
  const entry = { ...rel, updated_by: session?.user?.email || "", updated_at: new Date().toISOString() };
  if (supabase && session) {
    const { data } = await supabase.from("settings").select("value").eq("key", REL_KEY).maybeSingle();
    const fresh = { ...(data?.value || {}), [id]: entry };
    const { error } = await supabase.from("settings").upsert({ key: REL_KEY, value: fresh, updated_at: entry.updated_at });
    if (error) { setStatus("Couldn't save (" + error.message + ").", true); return false; }
    relations = fresh;
  } else { relations[id] = entry; store.set("vet-relations", relations); }
  return true;
}
// Rugby and league clubs tend to run their own grounds regardless of council bookings.
const influenceOf = o => o.influence || (["rugby", "league"].includes(o.code) ? "low" : null);
const hasInfo = o => !!(o.local_board || o.tenure || o.board_links?.length || influenceOf(o) || relations[o.id]);
function infoHtml(ops) {
  const E = PRIV.enums || {}, LBS = PRIV.local_boards || {}, lab = (t, k) => esc(E[t]?.[k] || k);
  return ops.filter(hasInfo).map(o => {
    const lb = LBS[o.local_board], rel = relations[o.id] || {}, inf = influenceOf(o);
    const facts = [lb ? `<a href="${esc(lb.url)}" target="_blank" rel="noopener">${esc(lb.name)} Local Board</a>` : "",
      o.tenure && o.tenure.kind !== "unknown" ? `${lab("tenure", o.tenure.kind)}${o.tenure.until ? ` → ${esc(o.tenure.until.slice(0, 4))}` : ""}` : "",
      (o.board_links || []).map(b => lab("board_link", b)).join(", "),
      inf ? `council influence: ${lab("influence", inf)}${o.influence ? "" : " <span class='muted'>(typical for " + esc(o.code) + ")</span>"}` : "",
      (o.refs || []).map((r, i) => o.sources?.[r] ? `<a href="${esc(o.sources[r])}" target="_blank" rel="noopener">[${i + 1}]</a>` : "").join(" ")].filter(Boolean).join(" · ");
    const people = (rel.contacts || []).map((c, i) => `${esc(shortName(c.name))} (${esc(REL.role[c.role] || c.role)})${IS_ADMIN ? ` <button class="ip-x" data-del="contacts:${i}" title="Remove">✕</button>` : ""}`).join(", ");
    const events = (rel.events || []).map((e, i) => `${esc(e.date || "")} ${esc(REL.tag[e.tag] || e.tag)}${e.ref ? ` · ${esc(e.ref)}` : ""} ${REL.tone[e.tone] || ""}${IS_ADMIN ? ` <button class="ip-x" data-del="events:${i}" title="Remove">✕</button>` : ""}`).join("; ");
    const comm = (rel.community || []).map((c, i) => `${esc(shortName(c.name))} (${esc(REL.link[c.link] || c.link)}${c.with ? " " + esc(shortName(c.with)) : ""})${IS_ADMIN ? ` <button class="ip-x" data-del="community:${i}" title="Remove">✕</button>` : ""}`).join(", ");
    const opt = (m, v) => Object.entries(m).map(([k, t]) => `<option value="${k}"${k === v ? " selected" : ""}>${esc(t)}</option>`).join("");
    const editor = IS_ADMIN ? `<details class="ip-edit"><summary>Edit relationship</summary>
      <label>Rating <select data-f="rating">${opt(REL.rating, rel.rating || "unknown")}</select></label>
      <div class="ip-row"><input data-f="cName" placeholder="Operator person (first name)"><select data-f="cRole">${opt(REL.role)}</select><button data-add="contact">Add</button></div>
      <div class="ip-row"><input data-f="mName" placeholder="Community person (first name + initial)"><select data-f="mLink">${opt(REL.link)}</select><input data-f="mWith" placeholder="whom (optional)"><button data-add="community">Add</button></div>
      <div class="ip-row"><input data-f="eDate" type="date"><select data-f="eTag">${opt(REL.tag)}</select><input data-f="eRef" placeholder="Ref e.g. NZTUC25" maxlength="24"><select data-f="eTone">${opt({ positive: "positive", neutral: "neutral", negative: "negative" })}</select><button data-add="event">Add</button></div></details>` : "";
    return `<div class="ip-op" data-op="${esc(o.id)}"><div class="ip-h">${esc(o.short || o.operator)}</div>
      ${facts ? `<div><span class="ip-k">Local board</span> ${facts}</div>` : ""}
      ${rel.rating || people || events ? `<div><span class="ip-k">Relationship</span> ${rel.rating ? esc(REL.rating[rel.rating]) : ""}${people ? " · " + people : ""}${events ? " · " + events : ""}</div>` : ""}
      ${comm ? `<div><span class="ip-k">Community</span> ${comm}</div>` : ""}${editor}</div>`;
  }).join("");
}
function renderInfo(p) {
  const ops = PRIV_BY_PARK[p.id] || [], any = ops.some(hasInfo), box = $("privBox"), panel = $("infoPanel");
  if (any && !box.hidden) box.insertAdjacentHTML("beforeend", `<button class="pb-info" id="pbInfo" aria-expanded="${infoOpenFor === p.id}" title="Local board, history and community contacts">ⓘ</button>`);
  panel.hidden = !(any && infoOpenFor === p.id && !box.hidden);
  panel.innerHTML = panel.hidden ? "" : infoHtml(ops);
}
function bindInfo() {
  $("privBox").addEventListener("click", e => { if (!e.target.closest("#pbInfo")) return; const p = current(); if (!p) return;
    infoOpenFor = infoOpenFor === p.id ? null : p.id; render(); });
  $("infoPanel").addEventListener("change", async e => { const f = e.target.dataset.f; if (f !== "rating") return;
    const id = e.target.closest("[data-op]").dataset.op; if (await saveRelation(id, { ...(relations[id] || {}), rating: e.target.value })) render(); });
  $("infoPanel").addEventListener("click", async e => {
    const op = e.target.closest("[data-op]"); if (!op) return; const id = op.dataset.op, rel = { ...(relations[id] || {}) }, v = n => op.querySelector(`[data-f="${n}"]`)?.value.trim() || "";
    const del = e.target.closest("[data-del]"), add = e.target.closest("[data-add]"); if (!del && !add) return;
    if (del) { const [k, i] = del.dataset.del.split(":"); rel[k] = (rel[k] || []).filter((_, j) => j !== +i); }
    else if (add.dataset.add === "contact") { if (!v("cName")) return; rel.contacts = [...(rel.contacts || []), { name: shortName(v("cName")), role: v("cRole") }]; }
    else if (add.dataset.add === "community") { if (!v("mName")) return; rel.community = [...(rel.community || []), { name: shortName(v("mName")), link: v("mLink"), ...(v("mWith") ? { with: shortName(v("mWith")) } : {}) }]; }
    else if (add.dataset.add === "event") { if (!v("eDate") && !v("eRef")) return; rel.events = [...(rel.events || []), { date: v("eDate"), tag: v("eTag"), ref: v("eRef"), tone: v("eTone") }]; }
    if (await saveRelation(id, rel)) render();
  });
}
// Saves the override, then re-files the park's fields already in anyone's cart under the new
// workflow, so the booking site picks it up.
async function setCouncilOnly(p, on) {
  const entry = { council_only: on, by: session?.user?.email || "", at: new Date().toISOString() };
  if (supabase && session) {
    const { data } = await supabase.from("settings").select("value").eq("key", CO_KEY).maybeSingle();
    const fresh = { ...(data?.value || {}), [p.id]: entry };
    const { error } = await supabase.from("settings").upsert({ key: CO_KEY, value: fresh, updated_at: entry.at });
    if (error) { setStatus("Couldn't save council-only (" + error.message + ").", true); return false; }
    councilOnlyOv = fresh;
  } else { councilOnlyOv[p.id] = entry; store.set("vet-council-only", councilOnlyOv); }
  const wf = parkWorkflow(p);
  if (supabase && session) {
    const { data } = await supabase.from("settings").select("value").eq("key", BOOK_KEY).maybeSingle();
    const all = data?.value || {}; let n = 0;
    Object.values(all).forEach(list => list.forEach(x => { if (x.park_id === p.id) { x.kind = wf.kind; x.operator = wf.operator; n++; } }));
    if (n) {
      const { error } = await supabase.from("settings").upsert({ key: BOOK_KEY, value: all, updated_at: new Date().toISOString() });
      if (error) { setStatus("Saved, but couldn't update carts (" + error.message + ").", true); return true; }
      bookLocs = all;
    }
  } else Object.values(bookLocs).forEach(list => list.forEach(x => { if (x.park_id === p.id) { x.kind = wf.kind; x.operator = wf.operator; } }));
  setStatus(on ? `${p.name}: council booking only — no private-operator step.` : `${p.name}: private-operator workflow restored.`);
  return true;
}
// Cart entries filed before a park's workflow changed (e.g. a data-file council_only default)
// are re-filed on load, so the booking site uses the current workflow.
async function syncCartWorkflows() {
  if (!IS_ADMIN) return;
  let n = 0;
  Object.values(bookLocs).forEach(list => list.forEach(x => { const p = BYID[x.park_id]; if (!p) return;
    const wf = parkWorkflow(p);
    if (x.kind !== wf.kind || (x.operator?.id || null) !== (wf.operator?.id || null)) { x.kind = wf.kind; x.operator = wf.operator; n++; } }));
  if (!n) return;
  if (supabase && session) await supabase.from("settings").upsert({ key: BOOK_KEY, value: bookLocs, updated_at: new Date().toISOString() });
  else store.set("vet-booklocs", bookLocs);
}
// Provider amendments: tag a park whose provider listing needs changing, e.g. Liston Park is
// privately operated by Ellerslie AFC. Once tagged, the row asks for the provider's contact
// person (first name and last initial only).
const AMEND_KIND = { private: "Privately operated by", change: "Operator changed to", other: "Provider change" };
let amendFor = null;
const amendText = fl => `${AMEND_KIND[fl.kind || "private"]}${fl.club ? " " + fl.club : ""}${fl.contact ? " · contact " + fl.contact : ""}`;   // the park whose amendment row is open
// What's already on record for a park's provider: its private operator (and the first
// contact AMUA has for them), or the council for a council-only park.
function knownProvider(p) {
  if (councilOnly(p) && (PRIV_BY_PARK[p.id] || []).length) return { club: "Auckland Council (council only)", kind: "other", contact: "", known: true };
  const ops = PRIV_BY_PARK[p.id] || [], op = ops.find(o => o.code !== "ultimate") || ops[0];
  if (!op) return null;
  return { club: op.short || op.operator, kind: "private", contact: shortName(relations[op.id]?.contacts?.[0]?.name || ""), known: true };
}
function renderFlag(p) {
  const fl = flags[p.id], known = knownProvider(p), d = fl || known || {};
  $("clubFlagBtn").setAttribute("aria-pressed", String(!!fl));
  $("clubFlagBtn").textContent = fl ? "✎ " + amendText(fl) : known ? "✎ " + amendText(known) : "✎ Provider?";
  $("clubFlagBtn").title = fl ? `Provider amendment${fl.by ? " by " + fl.by.split("@")[0] : ""}. Click to edit.`
    : known ? "Provider on record. Click to amend it (the fields start from what's on record)."
    : "Tag this park's provider for amendment, e.g. privately operated by a club that isn't listed yet";
  $("amendRow").hidden = amendFor !== p.id;
  $("amendContact").hidden = !fl && !known;
  $("amendClear").hidden = !fl;
  const ae = document.activeElement;
  if (ae !== $("clubIn")) $("clubIn").value = d.club || "";
  if (ae !== $("amendKind")) $("amendKind").value = d.kind || "private";
  if (ae !== $("amendContact")) $("amendContact").value = d.contact || "";
  if (!$("providerList").options.length)
    $("providerList").innerHTML = [...new Set(PRIV.operators.map(o => o.short || o.operator))].sort().map(n => `<option value="${esc(n)}">`).join("");
}
// Contact person as typed: the first space ends the first name, then one letter (the last
// initial) is all that's allowed. "rory hughes" → "Rory H".
function maskContact(v) {
  const m = String(v).replace(/^\s+/, "").match(/^(\S*)(\s?)(\S?)/);
  const first = m[1] ? m[1][0].toUpperCase() + m[1].slice(1) : "";
  return first + (m[2] && first ? " " + m[3].replace(/[^\p{L}]/gu, "").toUpperCase() : "");
}
const contactValue = v => { const s = maskContact(v).trim(); return /\s\p{L}$/u.test(s) ? s + "." : s; };
function renderRail() {
  const reg = $("region").value, mapsOnly = $("mapsOnly").checked;
  const scope = PARKS.filter(x => (!reg || x.region === reg) && (!mapsOnly || x.maps.length) && interestOk(x));
  const done = scope.filter(x => reviews[x.id] && reviews[x.id].decision !== "rating").length;
  $("progress").textContent = `${done} / ${scope.length} reviewed`;
  $("barFill").style.width = scope.length ? (100 * done / scope.length) + "%" : "0";
  const all = Object.entries(reviews).filter(([id]) => BYID[id]);
  $("nTop").textContent = all.filter(([, r]) => r.decision === "top").length;
  $("nYes").textContent = all.filter(([, r]) => r.decision === "yes").length;
  $("nNo").textContent = all.filter(([, r]) => r.decision === "no").length;
  const picks = all.filter(([, r]) => r.decision !== "no" && r.decision !== "rating").sort((a, b) => suitScore(b[1]) - suitScore(a[1]) || BYID[a[0]].name.localeCompare(BYID[b[0]].name));
  $("list").innerHTML = picks.length ? picks.map(([id, r]) => { const pp = BYID[id], st = parkStage(id);
    return `<div class="pick"><button data-open="${id}"><span class="dot" style="background:${suitColor(r)}"></span><span style="min-width:0"><span class="n">${r.decision === "top" ? "★ " : ""}${esc(pp.name)}</span><span class="m">${esc(pp.region)} · ${suitWord(r).toLowerCase()} · ${esc(FIT_LABEL[r.fit] || r.fit)}${r.quality ? " · " + r.quality + "/5" : ""}${r.lights === "full" || r.lights === "training" ? " · 💡" : ""}</span></span></button>`
      + `<span class="stage" role="group" aria-label="Stage for ${esc(pp.name)}">${["cart", "active"].map(k => `<button data-stage="${k}" data-park="${id}" class="${st === k ? "on" : ""}" aria-pressed="${st === k}" title="${k === "active" ? "Active: bookable in Facility Booking" : "Cart: chosen, not bookable yet"}${st === k ? " · click again to remove" : ""}">${k === "active" ? "✓ Active" : "🛒 Cart"}</button>`).join("")}</span></div>`; }).join("")
    : `<p class="help">Shortlisted and top-pick parks collect here, best first.</p>`;
  return { scope, done };
}
function renderCity() {
  const { scope, done } = renderRail();
  const reg = $("region").value;
  $("parkName").textContent = reg ? reg + " parks" : "Auckland";
  $("parkRegion").textContent = `${scope.length} parks`; $("decChip").innerHTML = "";
  $("handle").title = "Click a park to rate it · colours show overall suitability · zoom in to see its fields";
  const rated = scope.filter(x => reviews[x.id]);
  const unplaced = scope.filter(x => !parkLatLng(x)).length;
  const nextUp = queue()[0];
  $("cityInfo").innerHTML = `<span><b>${done}</b> of ${scope.length} rated</span>`
    + `<span><b>${rated.filter(x => suitScore(reviews[x.id]) >= 0.65).length}</b> good or better</span>`
    + `<span><b>${rated.filter(x => ["full", "training"].includes(reviews[x.id].lights)).length}</b> with lights</span>`
    + (unplaced ? `<span>${unplaced} without a location (no council map)</span>` : "")
    + (nextUp ? `<button class="railtools" id="nextUnrated" style="border:1px solid var(--line);background:var(--surface);border-radius:8px;padding:4px 10px">Rate next: ${esc(nextUp.name)} ▸</button>` : "");
  const nb = $("nextUnrated"); if (nb) nb.onclick = () => openPark(nextUp.id);
  $("emptyState").hidden = true; $("card").hidden = false; $("behind").hidden = true;
  buildCity(); syncCityFields();
}
function renderParkHeader() {
  const p = current();
  $("parkName").textContent = "Cart";
  $("emptyState").hidden = true; $("card").hidden = false; $("behind").hidden = true;
  $("parkName").textContent = "🛒 Cart"; $("parkRegion").textContent = p ? "last park: " + p.name : "";
  $("decChip").innerHTML = ""; $("handle").title = "Council fields in the booker's cart, ready for the booking site";
}
function render() {
  if (view === "book") { renderParkHeader(); renderBook(); renderTabs(); renderRail(); return; }
  renderTabs(); applyModeUi();
  if (view === "city") return renderCity();
  const q = queue(), p = current(), next = focusId ? null : (q[cursor + 1] || (q.length > 1 ? q[0] : null));
  const card = $("card");
  $("emptyState").hidden = !!p; card.hidden = !p; $("behind").hidden = !p || !next || next.id === p?.id || !next.maps.length;
  $("handle").title = focusId ? "Opened from the Auckland map: decide to go back to it (drag ← reject · → shortlist · ↑ top pick)" : "Drag ← reject · → shortlist · ↑ top pick";
  if (!p) {
    const m = $("mode").value;
    $("emptyState").innerHTML = `<h2>${m === "todo" ? "All caught up" : "Nothing here yet"}</h2>${m === "todo" ? "Every park in this view has a decision. Open the Auckland map to look back over them." : "Parks you decide on will appear here."}`;
  } else {
    if (next?.maps.length) $("behindImg").src = BASE + "council-maps/" + next.maps[0].file;
    $("parkName").textContent = p.name; $("parkRegion").textContent = p.region;
    const pv = privOps(p), co = councilOnly(p);
    $("privBox").hidden = !pv.length && !co; $("privBox").classList.toggle("co", co);
    $("privBox").innerHTML = co ? councilOnlyBanner(p) : pv.length ? privBanner(pv) : "";
    renderInfo(p);
    renderFlag(p); renderCouncilOnly(p);
    const r = reviews[p.id];
    // Chips: the managing club (◆) and any ultimate club (🥏), which may be the booking contact.
    const lead = (pv || []).find(o => o.code !== "ultimate"), ult = ultimateOf(p);
    $("decChip").innerHTML = (lead ? `<span class="chip priv" title="Ask ${esc(lead.operator)} before applying to council">◆ ${esc(lead.short)}</span> ` : "")
      + ult.map(o => `<span class="chip ult" title="Home of ${esc(o.operator)}"${o.colors ? ` style="background:${o.colors.pattern || o.colors.fill};color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.8);box-shadow:inset 0 0 0 2px ${o.colors.edge || "#fff"}"` : ""}>🥏 ${esc(o.short)}</span> `).join("") + (r ? `<span class="chip ${r.decision === "no" ? "no" : r.decision === "top" ? "top" : ""}">${r.decision === "top" ? "Top pick" : r.decision === "yes" ? "Shortlisted" : "Rejected"}${r.by ? " · " + esc(r.by.split("@")[0]) : ""}</span>` : "");
    const i = Math.min(mapIndex(p), Math.max(0, p.maps.length - 1));
    // One ☀/❄ toggle flips the season for every park; extra maps in a season (e.g. an
    // area plan) get a small cycle button.
    const seasons = new Set(p.maps.map(m => m.season)), same = p.maps.map((m, k) => k).filter(k => p.maps[k].season === p.maps[i]?.season);
    $("thumbs").innerHTML = (seasons.size > 1 ? `<button data-season title="Showing ${p.maps[i].season} council maps (current season: ${COUNCIL_NOW.mapSeason}). Click for ${p.maps[i].season === "winter" ? "summer" : "winter"}.">${p.maps[i].season === "winter" ? "❄ Winter" : "☀ Summer"}</button>`
      : p.maps.length ? `<span class="seasononly" title="This park has ${p.maps[i]?.season || ""} maps only">${p.maps[i]?.season === "winter" ? "❄" : "☀"}</span>` : "")
      + (same.length > 1 ? `<button data-map="${same[(same.indexOf(i) + 1) % same.length]}" title="Next ${p.maps[i].season} map: ${esc(p.maps[same[(same.indexOf(i) + 1) % same.length]].title)}">▦ ${same.indexOf(i) + 1}/${same.length}</button>` : "");
    if (servedPark !== p.id) { if (servedPark) bumpViews(servedPark); servedPark = p.id; }
    const cf = councilFields(p).map(f => f.n).filter(Boolean);
    $("fieldList").textContent = cf.length ? "Council fields: " + [...new Set(cf)].join(" · ") : p.fields.length ? "Council fields: " + p.fields.join(" · ") : (p.maps.length ? "" : "No council map for this park (often a school or stadium ground). Satellite only.");
    const c = p.lat ? `${p.lat},${p.lon}` : encodeURIComponent(p.name + " Auckland");
    $("gmaps").href = p.lat ? `https://www.google.com/maps/@${c},250m/data=!3m1!1e3` : `https://www.google.com/maps/search/${c}`;
    const fresh = shownPark !== p.id + "#" + i;
    if (fresh) showMap(p);
    renderTags(p);
    if (workMode === "book") renderBookBar(p);
    // Coming back to a park with a placed field: lock the field to its saved spot and angle
    // (not the screen centre), select that field and redraw its lights.
    if (fresh) restorePlacement(p);
  }
  ["noBtn", "yesBtn", "topBtn", "skipBtn"].forEach(b => $(b).disabled = !p);
  $("interestBtn").setAttribute("aria-pressed", String(interestsSet()));
  $("skipBtn").title = `Decide later (S)${p ? ` · lowers its activity score (now ${activityOf(p.id)}), so it ranks lower in the queue` : ""}`;
  if (p && visited[visited.length - 1] !== p.id) visited.push(p.id);
  $("backBtn").disabled = !visited.some(id => id !== p?.id);
  renderRail();
}

// ── Decisions ────────────────────────────────────────────────────────────────
function askPlacement(p, t, decision) {
  const dlg = $("saveDlg"), moved = spotMoved(t);
  const rated = Object.values(t.fr).filter(x => x.fit && x.fit !== "unknown"), nl = allLights(t).length;
  $("dlgTitle").textContent = `${decision === "top" ? "Top pick" : decision === "yes" ? "Shortlist" : "Reject"} ${p.name} — save the field spots?`;
  $("dlgBody").textContent = rated.map(x => `${x.name}: ${FIT_LABEL[x.fit]} (turned ${((x.angle % 360) + 360) % 360}°${x.lights?.length ? `, ${x.lights.length} light${x.lights.length > 1 ? "s" : ""}` : ""})`).join(" · ")
    + ` · ${nl ? nl + " light pole" + (nl > 1 ? "s" : "") + " in all" : "lights " + t.lights}.`
    + (moved ? " You've moved the field since rating it; this saves the spots you rated, not the current view." : "")
    + " Saving restores each field's spot and lights next time and plots the park at its best field on the Auckland map.";
  return new Promise(res => {
    dlg.returnValue = "";
    dlg.addEventListener("close", () => res(dlg.returnValue || "cancel"), { once: true });
    dlg.showModal();
  });
}
async function decide(decision) {
  const p = current(); if (!p || busy || view !== "park" || workMode === "book") return;
  const t = tagsFor(p);
  let withField = false;
  if (t.spot && ratedCount(t) >= 3) {
    const a = await askPlacement(p, t, decision);
    if (a === "cancel") return;
    withField = a === "with";
  }
  busy = true;
  const card = $("card"); card.classList.remove("snap", "deal"); card.classList.add("fly");
  const x = decision === "yes" ? 800 : decision === "no" ? -800 : 0, y = decision === "top" ? -600 : 40;
  card.style.transform = `translate(${x}px, ${y}px) rotate(${x / 25}deg)`; card.style.opacity = "0";
  const rev = buildReview(p, t, decision, withField);
  await new Promise(r => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220));
  const ok = await save(p.id, rev);
  if (ok) await decisionToActive(p, t, decision);
  const fromCity = !!focusId && focusFrom === "city";
  if (ok && focusFrom === "back") { focusId = null; focusFrom = null; }
  if (ok) { delete draft[p.id]; delete edits[p.id]; later.delete(p.id); if (!fromCity && $("mode").value !== "todo") cursor++; }
  card.classList.remove("fly"); card.style.transform = ""; card.style.opacity = "";
  void card.offsetWidth; card.classList.add("deal");
  if (rotating) setRotating(false);
  $("fitPop").hidden = true;
  busy = false;
  if (ok && fromCity) { focusId = null; setView("city"); setStatus(`Saved ${p.name} — ${suitWord(reviews[p.id]).toLowerCase()}.`); return; }
  render();
}
// A decided park's stage among the booker's fields: "active" when any of its fields are
// active, "cart" when they're only in the cart, null when none are listed.
function parkStage(id) {
  const xs = myLocs().filter(x => x.park_id === id);
  return !xs.length ? null : xs.some(isActive) ? "active" : "cart";
}
// The summary's Cart / Active toggle: move a park's fields to that stage (adding its rated
// fields when none are listed); pressing the current stage again removes them.
async function setParkStage(p, stage) {
  if (!p) return;
  const who = whoBooks(), before = [...(bookLocs[who] || [])], cur = parkStage(p.id), at = new Date().toISOString();
  let list;
  if (cur === stage) list = before.filter(x => x.park_id !== p.id);
  else if (cur) list = before.map(x => x.park_id !== p.id ? x : stage === "active" ? { ...x, status: "active", activated_at: x.activated_at || at } : { ...x, status: "cart" });
  else {
    const rated = Object.values(tagsFor(p).fr).filter(x => x.fit && x.fit !== "unknown").map(x => x.name), wf = parkWorkflow(p);
    list = [...before, ...(rated.length ? rated : ["Whole park"]).map(key => {
      const f = fieldKeys(p).find(x => x.key === key)?.f, c = f?.c || [p.lat, p.lon];
      return { id: cartId(p, key), park_id: p.id, park: p.name, region: p.region, field: key, lat: c[0], lon: c[1], kind: wf.kind, operator: wf.operator,
        status: stage, added_at: at, ...(stage === "active" ? { activated_at: at } : {}), added_by: session?.user?.email || "", decision: reviews[p.id]?.decision };
    })];
  }
  bookLocs[who] = list;
  if (!(await saveBookLocs())) { bookLocs[who] = before; return; }
  setStatus(cur === stage ? `Removed ${p.name} from ${who}'s fields.` : stage === "active" ? `${p.name} is active for ${who}: bookable in Facility Booking.` : `${p.name} moved to ${who}'s cart (not bookable yet).`);
  renderRail(); renderTabs(); if (view === "book") renderBook(); if (view !== "city" && current()?.id === p.id) drawParkFields(p);
}
// A decision is the one way a field becomes bookable: Top pick or Shortlist adds the park's
// rated fields (or the whole park, when it has none rated) to the booker's active fields;
// Reject takes the park's fields off them.
async function decisionToActive(p, t, decision) {
  const who = whoBooks(), before = [...(bookLocs[who] || [])], list = before.filter(x => x.park_id !== p.id || decision !== "no");
  if (decision !== "no") {
    const rated = Object.values(t.fr).filter(x => x.fit && x.fit !== "unknown").map(x => x.name);
    const keys = rated.length ? rated : ["Whole park"], wf = parkWorkflow(p), at = new Date().toISOString();
    keys.forEach(key => {
      const id = cartId(p, key), i = list.findIndex(x => x.id === id);
      if (i >= 0) { list[i] = { ...list[i], status: "active", activated_at: list[i].activated_at || at }; return; }
      const f = fieldKeys(p).find(x => x.key === key)?.f, c = f?.c || [p.lat, p.lon];
      list.push({ id, park_id: p.id, park: p.name, region: p.region, field: key, lat: c[0], lon: c[1], kind: wf.kind, operator: wf.operator,
        status: "active", added_at: at, activated_at: at, added_by: session?.user?.email || "", decision });
    });
  }
  if (JSON.stringify(list) === JSON.stringify(before)) return;
  bookLocs[who] = list;
  if (!(await saveBookLocs())) { bookLocs[who] = before; return; }
  const n = list.filter(x => x.park_id === p.id).length;
  setStatus(decision === "no" ? `Rejected ${p.name}: removed from ${who}'s active fields.` : `${p.name}: ${n} field${n === 1 ? "" : "s"} now active for ${who} — bookable in Facility Booking.`);
  renderTabs();
}
function buildReview(p, t, decision, withField) {
  const prevPl = reviews[p.id]?.placement;
  const pos = withField ? { ...t.spot, ...dims }
    : prevPl?.lat != null ? { lat: prevPl.lat, lon: prevPl.lon, angle: prevPl.angle, len: prevPl.len, wid: prevPl.wid, ez: prevPl.ez } : { lat: null, lon: null };
  // Per-field ratings and their lights are kept either way; "without" only skips the park's pin.
  const fr = Object.fromEntries(Object.entries(t.fr).filter(([, x]) => (x.fit && x.fit !== "unknown") || x.lights?.length));
  const placement = (pos.lat != null || t.lightPts.length || Object.keys(fr).length) ? { ...pos, lights: t.lightPts, fields: fr } : null;
  return { decision, lights: t.lights, fit: t.fit, quality: t.quality || null, fields: t.fields.trim(), notes: t.notes.trim(), placement };
}
// Save the park's field ratings so far without deciding (an existing decision is kept), stay
// on the park and move the field to its next unrated council field, ready to rate.
async function saveAndNext() {
  const p = current(); if (!p || busy || view !== "park") return;
  const t = tagsFor(p), done = t.sel;
  busy = true;
  const ok = await save(p.id, buildReview(p, t, reviews[p.id]?.decision || "rating", false));
  busy = false;
  if (!ok) return;
  const next = fieldKeys(p).find(x => x.key !== done && !(t.fr[x.key]?.fit && t.fr[x.key].fit !== "unknown"));
  renderRail();
  if (!next) { $("fitPop").hidden = true; t.sel = null; drawParkFields(p); drawLights(p); renderTags(p); renderCentre();
    setStatus(`Saved ${done}. Every council field at ${p.name} is rated — top pick, shortlist or reject it when you're ready.`); return; }
  if (rotating) setRotating(false);
  map.setView(next.f.c, map.getZoom(), { animate: false });
  lockField();
  setStatus(`Saved ${done}. Now rating ${next.key} — turn the field if needed, then rate the fit.`);
}
function skip() {
  const p = current(); if (!p) return;
  if (focusId && focusFrom === "back") { focusId = null; focusFrom = null; render(); return; }
  if (focusId) { focusId = null; setView("city"); return; }
  later.add(p.id); bumpActivity(p.id, -1); cursor = $("mode").value === "todo" ? 0 : cursor + 1; $("fitPop").hidden = true; render();
}

// ── Events ───────────────────────────────────────────────────────────────────
function bind() {
  $("card").addEventListener("click", e => {
    const t = e.target.closest("[data-tag]"), mp = e.target.closest("[data-map]"), p = current(); if (!p || view === "city") return;
    if (mp) { mapIdx[p.id] = +mp.dataset.map; render(); return; }
    if (e.target.closest("[data-season]")) { seasonPick = (p.maps[mapIndex(p)]?.season || seasonPick) === "winter" ? "summer" : "winter";
      Object.keys(mapIdx).forEach(k => delete mapIdx[k]); render();
      const sm = document.querySelector(".sb-map"); if (sm) sm.textContent = (seasonPick === "winter" ? "❄ Winter" : "☀ Summer") + " maps"; setStatus(`Showing ${seasonPick} council maps${seasonPick === COUNCIL_NOW.mapSeason ? " (the current season)" : ""}.`); return; }
    if (t && t.tagName === "BUTTON") { snap(p); const d = tagsFor(p), k = t.dataset.tag, v = k === "quality" ? +t.dataset.val : t.dataset.val;
      if (k === "quality") d.quality = d.quality === v ? 0 : v;
      renderTags(p); }
  });
  $("fieldsIn").addEventListener("input", () => { const p = current(); if (p) { const t = tagsFor(p); t.fields = $("fieldsIn").value; t.fieldsManual = !!t.fields.trim(); drawParkFields(p); } });
  $("notesIn").addEventListener("input", () => { const p = current(); if (p) tagsFor(p).notes = $("notesIn").value; });
  // Swipe on the title bar (the map itself pans and zooms).
  const h = $("handle"), card = $("card"); let sx = 0, sy = 0, dx = 0, dy = 0, drag = false;
  h.addEventListener("pointerdown", e => { if (view !== "park" || workMode === "book") return; drag = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; card.classList.remove("snap", "deal"); h.setPointerCapture(e.pointerId); });
  h.addEventListener("pointermove", e => { if (!drag) return; dx = e.clientX - sx; dy = e.clientY - sy;
    card.style.transform = `translate(${dx}px, ${Math.min(dy, 30)}px) rotate(${dx / 25}deg)`;
    const up = -dy > 70 && Math.abs(dx) < 90;
    $("stYes").style.opacity = !up && dx > 0 ? Math.min(1, dx / 110) : 0;
    $("stNo").style.opacity = !up && dx < 0 ? Math.min(1, -dx / 110) : 0;
    $("stTop").style.opacity = up ? Math.min(1, -dy / 110) : 0; });
  const end = () => { if (!drag) return; drag = false; ["stYes", "stNo", "stTop"].forEach(s => $(s).style.opacity = 0);
    card.classList.add("snap"); card.style.transform = "";
    if (-dy > 100 && Math.abs(dx) < 90) decide("top"); else if (dx > 110) decide("yes"); else if (dx < -110) decide("no"); };
  h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
  // Field rotation follows the pointer while unlocked.
  // While unlocked, hovering turns the field and dragging pans the map under it. On touch
  // screens (no hover), drag outward from the centre button to turn it.
  const turnTo = e => { const r = $("map").getBoundingClientRect();
    const px = e.clientX - (r.left + r.width / 2), py = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(px, py) < 30) return;   // too close to the centre to read a direction
    angle = Math.atan2(py, px) * 180 / Math.PI; sizeField(); };
  $("map").parentElement.addEventListener("pointermove", e => { if (rotating && !e.buttons && e.pointerType === "mouse") turnTo(e); });
  let twist = null;
  $("centreBtn").addEventListener("pointerdown", e => { if (!rotating || e.pointerType === "mouse") return;
    twist = { x: e.clientX, y: e.clientY, moved: false }; $("centreBtn").setPointerCapture(e.pointerId); e.preventDefault(); });
  $("centreBtn").addEventListener("pointermove", e => { if (!twist) return;
    if (Math.hypot(e.clientX - twist.x, e.clientY - twist.y) > 8) twist.moved = true; if (twist.moved) turnTo(e); });
  // Two-finger twist (touch): the change in angle between the fingers turns the field.
  // Pinch-zoom still works at the same time, so the field scales and turns together.
  let pivot = null;
  const fingerAngle = ts => Math.atan2(ts[1].clientY - ts[0].clientY, ts[1].clientX - ts[0].clientX) * 180 / Math.PI;
  const mapbox = $("map").parentElement;
  mapbox.addEventListener("touchstart", e => { pivot = rotating && e.touches.length === 2 ? { a0: fingerAngle(e.touches), base: angle } : null; }, { capture: true, passive: true });
  mapbox.addEventListener("touchmove", e => { if (!pivot || e.touches.length !== 2) return;
    angle = pivot.base + (fingerAngle(e.touches) - pivot.a0); sizeField(); }, { capture: true, passive: true });
  mapbox.addEventListener("touchend", e => { if (e.touches.length < 2) pivot = null; }, { capture: true, passive: true });
  let swallowClick = false;   // a twist ends in a click on the button; don't let it lock
  $("centreBtn").addEventListener("pointerup", () => { if (twist?.moved) swallowClick = true; twist = null; });
  $("centreBtn").onclick = e => { e.stopPropagation(); if (swallowClick) { swallowClick = false; return; } if (rotating) lockField(); else setRotating(true); };
  $("lightStep").addEventListener("click", e => { const b = e.target.closest("[data-lstep]"); if (b) { e.stopPropagation(); stepLights(+b.dataset.lstep); } });
  $("fitPop").addEventListener("click", e => { const b = e.target.closest("[data-fit]"), p = current(); if (!b || !p) return;
    const t = tagsFor(p), cur = t.sel && t.fr[t.sel];
    if (!fitOpen && cur?.fit === b.dataset.fit && !spotMoved(t)) { fitOpen = true; previewFields(p); return; }   // collapsed: reopen the options
    fitOpen = false;
    confirmSpot(p, b.dataset.fit); });
  $("fieldBtn").onclick = () => showField(!fieldOn);
  bindDispenser();
  $("clubFlagBtn").onclick = () => { const p = current(); if (!p) return;
    amendFor = amendFor === p.id ? null : p.id; renderFlag(p); if (amendFor) $("clubIn").focus(); };
  const amendSave = async () => { const p = current(); if (!p) return;
    const fl = { club: $("clubIn").value.trim(), kind: $("amendKind").value, contact: contactValue($("amendContact").value) };
    const isNew = !flags[p.id];
    if (!fl.club && fl.kind !== "other") { $("clubIn").focus(); return; }
    if (await saveFlag(p.id, fl)) { renderFlag(p); if (isNew) $("amendContact").focus(); renderRail(); } };
  $("amendSave").onclick = amendSave;
  $("amendClear").onclick = async () => { const p = current(); if (!p) return;
    if (await saveFlag(p.id, null)) { amendFor = null; renderFlag(p); renderRail(); } };
  $("amendContact").addEventListener("input", e => { const el = e.target, v = maskContact(el.value); if (v !== el.value) el.value = v; });
  $("amendRow").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); amendSave(); } });
  $("saveNextBtn").onclick = e => { e.stopPropagation(); saveAndNext(); };
  bindInfo();
  $("councilOnlyBtn").onclick = async () => { const p = current(); if (!p) return;
    if (await setCouncilOnly(p, !councilOnly(p))) render(); };
  $("fitBtn").onclick = () => { const p = current(); if (p) showMap(p); };
  $("cityTab").onclick = () => { if (view !== "city") { focusId = null; setView("city"); } else setView("city", { refit: true }); };
  $("parkTab").onclick = () => { if (view !== "park") { if (view === "city") focusId = null; setView("park"); } };
  $("bookTab").onclick = () => { if (view !== "book") setView("book"); };
  bindBook();
  $("sizeBtn").onclick = () => { $("sizePanel").hidden = !$("sizePanel").hidden; };
  const syncDims = () => { $("fLen").value = dims.len; $("fWid").value = dims.wid; $("fEz").value = dims.ez; };
  ["fLen", "fWid", "fEz"].forEach(id => $(id).addEventListener("change", () => {
    dims = { len: +$("fLen").value || WFDF.len, wid: +$("fWid").value || WFDF.wid, ez: Math.max(0, +$("fEz").value || 0) };
    store.set("vet-field-dims", dims); drawField(); sizeField(); }));
  $("fReset").onclick = () => { dims = { ...WFDF }; store.set("vet-field-dims", dims); syncDims(); drawField(); sizeField(); };
  syncDims();
  $("noBtn").onclick = () => decide("no"); $("yesBtn").onclick = () => decide("yes"); $("topBtn").onclick = () => decide("top");
  $("skipBtn").onclick = skip; $("backBtn").onclick = goBack; $("editUndoBtn").onclick = editUndo;
  $("interestBtn").onclick = () => { const el = $("interestPanel"); el.hidden = !el.hidden; if (!el.hidden) renderInterests(); };
  $("interestPanel").addEventListener("change", e => {
    const c = e.target; if (!c.dataset.int) return;
    if (c.dataset.int === "region") interests.regions = [...$("interestPanel").querySelectorAll("[data-int=region]:checked")].map(x => x.value);
    else interests[c.dataset.int] = c.checked;
    if (!interests.council && !interests.priv) { interests[c.dataset.int === "council" ? "priv" : "council"] = true; }
    store.set("vet-interests", interests); cursor = 0; if (view === "park" && !focusId) shownPark = null;
    renderInterests(); render(); });
  ["region", "mode", "mapsOnly", "order"].forEach(id => $(id).addEventListener("change", () => {
    cursor = 0; store.set("vet-" + id, id === "mapsOnly" ? $(id).checked : $(id).value);
    if (view === "city" && id === "region") return setView("city", { refit: true });
    if (view === "park" && !focusId) shownPark = null;
    render(); }));
  $("list").addEventListener("click", e => {
    const sb = e.target.closest("[data-stage]"); if (sb) { if (!busy) setParkStage(BYID[sb.dataset.park], sb.dataset.stage); return; }
    const b = e.target.closest("[data-open]"); if (b) openPark(b.dataset.open); });
  $("exportBtn").onclick = exportCsv;
  window.addEventListener("focus", async () => { if (mode === "shared" && !busy) { await loadShared(); if (view === "city") render(); else renderRail(); } });
  // Any click on the opaque plan (except the open-in-new-tab link) puts it away again.
  $("cimgBox").addEventListener("click", e => { if (!e.target.closest("#cimgOpen")) closeCouncilImage(); });
  document.addEventListener("keydown", e => {
    if (!$("cimgBox").hidden && e.key === "Escape") return closeCouncilImage();
    if ($("saveDlg").open || e.target.matches("input, textarea, select")) return;
    const p = current();
    if (!IS_ADMIN && !/^(Escape|c|C)$/.test(e.key)) return;   // bookers: no rating keys
    if (e.key === "Escape") { if (infoOpenFor) { infoOpenFor = null; render(); return; } if (rotating) setRotating(false); $("sizePanel").hidden = true; $("interestPanel").hidden = true; $("fitPop").hidden = true; if (p && tagsFor(p).sel) selectField(p, null); return; }
    if (/^[cC]$/.test(e.key)) { focusId = null; setView(view === "city" ? "park" : "city"); return; }
    if (/^[bB]$/.test(e.key)) { setMode(workMode === "book" ? "rate" : "book"); return; }
    if (view === "city") return;
    if (e.key === "ArrowRight") { e.preventDefault(); decide("yes"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); decide("no"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); decide("top"); }
    else if (e.key === "Enter" && fieldOn && !e.target.closest("button")) { e.preventDefault(); $("centreBtn").click(); }
    else if (/^[sS]$/.test(e.key)) skip();
    else if (/^[zZ]$/.test(e.key)) editUndo();
    else if (/^[tT]$/.test(e.key)) showField(!fieldOn);
    else if (e.key === "0") $("fitBtn").click();
    else if (/^[rR]$/.test(e.key)) { angle = (angle + 15) % 360; sizeField(); afterMove(); }
    else if (p && /^[1-5]$/.test(e.key)) { tagsFor(p).quality = +e.key; renderTags(p); }
    else if (p && /^[mM]$/.test(e.key) && p.maps.length > 1) { mapIdx[p.id] = ((mapIndex(p)) + 1) % p.maps.length; render(); }
  });
}
function opCsv(o) {
  if (!o) return ["", "", "", "", "", "", ""];
  const E = PRIV.enums || {}, rel = relations[o.id] || {}, ev = (rel.events || []).slice(-1)[0], inf = influenceOf(o);
  return [PRIV.local_boards?.[o.local_board]?.name || "", o.tenure ? E.tenure?.[o.tenure.kind] || o.tenure.kind : "", o.tenure?.until || "",
    (o.board_links || []).map(b => E.board_link?.[b] || b).join("; "), inf ? E.influence?.[inf] || inf : "", rel.rating ? REL.rating[rel.rating] : "",
    ev ? [ev.date, REL.tag[ev.tag] || ev.tag, ev.ref].filter(Boolean).join(" ") : ""];
}
function exportCsv() {
  const rows = [["Region", "Park", "Decision", "Suitability", "Lights", "Light poles", "Fit", "Quality", "Fields", "Notes", "Field placement (lat, lon, angle°)", "Private operator", "Operator contact", "Ultimate club", "Provider amendment", "Reviewer", "Reviewed at", "Activity score",
    "Local board", "Tenure", "Tenure until", "Board links", "Council influence", "Relationship", "Last event"]];
  PARKS.forEach(p => { const r = reviews[p.id] || {}, fl = flags[p.id]; if (!reviews[p.id] && !fl && !ultimateOf(p).length) return; const pl = r.placement;
    rows.push([p.region, p.name, r.decision ? (r.decision === "top" ? "top pick" : r.decision === "yes" ? "shortlist" : r.decision === "rating" ? "rating in progress" : "reject") : "", r.decision ? suitWord(r) : "", r.lights || "", pl?.lights?.length || 0,
      r.fit ? FIT_LABEL[r.fit] || r.fit : "", r.quality || "", r.fields || "", r.notes || "", pl?.lat != null ? `${pl.lat}, ${pl.lon}, ${pl.angle}` : "",
      privOps(p)[0]?.operator || "",
      [privOps(p)[0]?.contact?.email, privOps(p)[0]?.contact?.phone].filter(Boolean).join(" / "),
      ultimateOf(p).map(o => o.operator + ([o.contact?.email, o.contact?.phone].filter(Boolean).length ? ` (${[o.contact?.email, o.contact?.phone].filter(Boolean).join(" / ")})` : "")).join("; "),
      fl ? amendText(fl) : "", r.by || "", r.at || "", activityOf(p.id), ...opCsv(PRIV_BY_PARK[p.id]?.[0])]); });
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "council-field-vetting.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Council booking state: what the council's sports-field calendar is doing now ──
function renderSeasonBar() {
  const { now, next, mapSeason } = COUNCIL_NOW, el = $("seasonBar");
  const chip = p => `<span class="sb-p ${p.season}" title="${p.approx ? "Estimated from last year's dates" : "Published dates"}"><b>${p.label}</b> ${fmtRange(p)}</span>`;
  el.innerHTML = `<details><summary><span class="sb-k">Council bookings now</span>
      ${now.length ? now.map(chip).join("") : `<span class="sb-p">Between phases</span>`}
      <span class="sb-map" title="Council field maps shown for this season">${mapSeason === "winter" ? "❄ Winter" : "☀ Summer"} maps</span></summary>
    <div class="sb-more"><div><span class="sb-k">Next</span> ${next.map(p => `<span class="sb-p ${p.season}"><b>${p.label}</b> from ${p.approx ? "≈ " : ""}${fmtDay(p.from)}</span>`).join("")}</div>
      <div class="muted">≈ = estimated from this year's published dates (same week of the year). Confirm on the council's
        <a href="${COUNCIL_LINKS[0].url}" target="_blank" rel="noopener">How to book our sports facilities</a> page ·
        <a href="mailto:${COUNCIL_CONTACTS.email}">${COUNCIL_CONTACTS.email}</a> · ${COUNCIL_CONTACTS.phone}</div></div></details>`;
}

// ── Profile (same look as the booking site's user button) ────────────────────
const EMAIL_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#84cc16","#f97316","#14b8a6","#e879f9","#fb7185","#34d399","#60a5fa","#fbbf24"];
const COUNCIL_APPLICATION_URL = "https://onlineservices.aucklandcouncil.govt.nz/councilonline/application/sportapplication?bookingApplicationType=SEASONAL_ALL_SPORTS_PARKS&productCode=SSPPERMITBK";
function renderProfile() {
  const email = session?.user?.email || "";
  if (!email) { $("profileBtn").hidden = true; return; }
  let h = 0; for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  $("profileAv").textContent = email[0].toUpperCase(); $("profileAv").style.background = EMAIL_COLORS[h % EMAIL_COLORS.length];
  $("profileName").textContent = email.split("@")[0]; $("profileBtn").title = email; $("profileBtn").hidden = false;
  $("profileMenu").innerHTML = `<div class="pm-head"><div class="pm-k">Signed in</div><div class="pm-e">${esc(email)}</div>
      <span class="pm-role${IS_ADMIN ? " admin" : ""}">${IS_ADMIN ? "👑 Admin" : "👤 User"}</span></div>
    <a class="pm-item" href="./">📅 Facility Booking</a>
    ${IS_ADMIN ? `<a class="pm-item" href="${COUNCIL_APPLICATION_URL}" target="_blank" rel="noopener">🏛 Council application</a>` : ""}
    <button class="pm-item danger" id="pmSignOut">↪ Sign out</button>`;
  const close = () => { $("profileMenu").hidden = true; $("profileBtn").setAttribute("aria-expanded", "false"); };
  $("profileBtn").onclick = e => { e.stopPropagation(); const open = $("profileMenu").hidden; $("profileMenu").hidden = !open; $("profileBtn").setAttribute("aria-expanded", String(open)); };
  document.addEventListener("click", e => { if (!e.target.closest(".profile")) close(); });
  $("pmSignOut").onclick = async () => { await supabase?.auth.signOut(); location.reload(); };
}

// ── Start ────────────────────────────────────────────────────────────────────
function gate(html) { $("gate").innerHTML = html; $("gate").hidden = false; $("app").hidden = true; }
async function start() {
  // "no-cache" revalidates with the server, so a data update shows on the next load instead
  // of after GitHub Pages' ~10-minute browser cache expires.
  const res = await fetch(BASE + "council-maps/parks.json", { cache: "no-cache" }); PARKS = (await res.json()).parks; BYID = Object.fromEntries(PARKS.map(p => [p.id, p]));
  // A per-minute query string skips GitHub Pages' CDN copy (cached ~10 min after a deploy),
  // so edits to the operator list show on the next load.
  try { const pr = await fetch(BASE + "council-maps/private-managed.json?v=" + Math.floor(Date.now() / 60000), { cache: "no-cache" }); if (pr.ok) PRIV = await pr.json(); } catch { /* optional data */ }
  PRIV_BY_PARK = {};
  (PRIV.operators || []).filter(o => o.park_id).forEach(o => (PRIV_BY_PARK[o.park_id] ||= []).push(o));
  // Point of contact first: the operator marked primary, else the rugby or football club.
  // Contact order: the sole booking channel, then primary, then rugby/football; an ultimate
  // club that isn't the booking channel is listed separately.
  const rank = o => o.booking_only ? -1 : o.code === "ultimate" ? 3 : o.primary ? 0 : ["rugby", "football"].includes(o.code) ? 1 : 2;
  Object.values(PRIV_BY_PARK).forEach(ops => ops.sort((a, b) => rank(a) - rank(b)));
  const regions = [...new Set(PARKS.map(p => p.region))];
  $("region").insertAdjacentHTML("beforeend", regions.map(r => `<option>${esc(r)}</option>`).join(""));
  $("region").value = store.get("vet-region", ""); $("mode").value = store.get("vet-mode", "todo"); $("mapsOnly").checked = store.get("vet-mapsOnly", true); $("order").value = store.get("vet-order", "least");

  if (supabase) {
    const { data } = await supabase.auth.getSession(); session = data.session;
    if (!session) {
      gate(`<h2>Sign in to see council fields</h2>Use the same Google account as the booking site.<br><button id="signIn">Sign in with Google</button>`);
      // Sign in through the booking site's URL (the one on Supabase's redirect list); it sends
      // the browser back here once the session is stored (same origin, shared storage).
      $("signIn").onclick = () => { try { sessionStorage.setItem("amua-after-login", "vetting.html"); } catch { /* storage blocked */ }
        supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + BASE } }); };
      setStatus(""); return;
    }
    IS_ADMIN = session.user?.app_metadata?.role === "admin";
    renderProfile();
    await loadShared();
    if (!IS_ADMIN) {
      workMode = "book"; document.body.classList.add("viewer");
      setStatus("Pick a park, then click its field areas to add them to your cart. They show up in your booking site locations.");
    }
  } else {
    reviews = store.get("vet-reviews", {}); flags = store.get("vet-flags", {});
    setStatus("Demo mode (no Supabase configured): decisions are kept in this browser.", true);
  }
  $("app").hidden = false; renderSeasonBar();
  await loadBookLocs(); await loadActivity(); await loadViews(); await loadCouncilOnly(); await loadRelations(); await syncCartWorkflows();
  initMap(); drawField(); showField(fieldOn); renderLegend(); bind();
  setView(view === "park" || view === "book" ? view : "city", { refit: true });
  if (mode === "shared") setInterval(async () => { if (!busy && !rotating && document.visibilityState === "visible" && !$("saveDlg").open) { await loadShared(); if (view === "city") render(); else renderRail(); } }, 30000);
}
start().catch(e => setStatus("Couldn't start: " + (e.message || e), true));
