// Council fields (vetting.html) — admin tool for rating Auckland Council sports parks for
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
const undoStack = [];
const later = new Set();
const draft = {};              // park_id -> tags being edited before deciding
const mapIdx = {};
let cursor = 0, busy = false;
let dims = store.get("vet-field-dims", WFDF);
let fieldOn = store.get("vet-field-on", true);
let view = store.get("vet-view", "city");   // "city" | "park" | "book" (the cart)
// Admins rate and book for anyone; other signed-in bookers see the ratings and book for themselves.
let IS_ADMIN = true;
let workMode = store.get("vet-work-mode", "rate");   // "rate" | "book": what clicking a park's field areas does
let focusId = null;                          // park opened from the Auckland map (overrides the queue)

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
  setStatus(`Shared with all admins · ${data.length} decisions so far`);
  await loadFlags();
}
// Club-run flags live in their own table (field_flags) so a park can be flagged without a
// decision. Until that table exists they're kept in this browser.
async function loadFlags() {
  if (mode === "shared") {
    const { data, error } = await supabase.from("field_flags").select("*");
    if (!error) { flagsShared = true; flags = Object.fromEntries(data.map(r => [r.park_id, { club: r.club || "", by: r.flagged_by_email || "", at: r.updated_at }])); return; }
  }
  flagsShared = false; flags = store.get("vet-flags", {});
}
async function saveFlag(id, flag) {
  if (flagsShared) {
    const q = flag ? supabase.from("field_flags").upsert({ park_id: id, club: flag.club || "", flagged_by: session?.user?.id || null,
        flagged_by_email: session?.user?.email || null, updated_at: new Date().toISOString() })
      : supabase.from("field_flags").delete().eq("park_id", id);
    const { error } = await q;
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
      const old = /fit_check/i.test(error.message || "");
      setStatus(old ? "Saving \"2+ fields\" needs the updated supabase-migration-field-reviews.sql — re-run it in the Supabase SQL editor."
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
  if (!r) return null;
  if (r.decision === "no") return 0;
  let s = r.quality ? r.quality / 5 : 0.5;
  s += { multi: 0.2, full: 0.1, reduced: -0.15 }[r.fit] || 0;
  if (r.lights === "full" || r.lights === "training") s += 0.1;
  if (r.decision === "top") s += 0.15;
  return Math.max(0.05, Math.min(1, s));
}
const suitHue = s => Math.round(15 + s * 115);
function suitColor(r) { const s = suitScore(r); return s === null ? "#8a958f" : s === 0 ? "#b3372d" : `hsl(${suitHue(s)} 72% 42%)`; }
function suitWord(r) { const s = suitScore(r); return s === null ? "Not rated" : s === 0 ? "Rejected" : s >= 0.85 ? "Excellent" : s >= 0.65 ? "Good" : s >= 0.45 ? "Fair" : "Poor"; }
function parkLatLng(p) {
  const pl = reviews[p.id]?.placement;
  if (pl?.lat != null) return [pl.lat, pl.lon];
  return p.lat ? [p.lat, p.lon] : null;
}

// ── Queue ────────────────────────────────────────────────────────────────────
function queue() {
  const reg = $("region").value, m = $("mode").value, mapsOnly = $("mapsOnly").checked;
  let q = PARKS.filter(p => (!reg || p.region === reg) && (!mapsOnly || p.maps.length));
  if (m === "todo") q = q.filter(p => !reviews[p.id]);
  else if (m !== "all") q = q.filter(p => reviews[p.id]?.decision === m);
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
let map, overlay = null, baseZoom = null, shownPark = null;
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

// ── Park view: Esri satellite + council overlay that drops away when you zoom off it ─
function showMap(p) {
  const i = Math.min(mapIdx[p.id] || 0, Math.max(0, p.maps.length - 1)), m = p.maps[i];
  if (overlay) { overlay.remove(); overlay = null; }
  map.invalidateSize();
  if (m) {
    const b = L.latLngBounds([m.bounds[0], m.bounds[1]], [m.bounds[2], m.bounds[3]]);
    overlay = L.imageOverlay(BASE + "council-maps/" + m.file, b, { className: "council-overlay", interactive: false }).addTo(map);
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
  $("layerBadge").textContent = on ? "Council map" : "Satellite";
}
// Council fields traced from the map PDFs: [{n: name, c: [lat, lon], p: [[lat, lon], …]}].
function councilFields(p) {
  const i = Math.min(mapIdx[p.id] || 0, Math.max(0, p.maps.length - 1));
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
    const cart = cartIds();
    fieldKeys(p).forEach(({ f, key }) => {
      const on = cart.has(cartId(p, key));
      L.polygon(f.p, { pane: "fieldsPane", fill: true, fillColor: "#14b8a6", fillOpacity: on ? 0.4 : 0.04,
        color: on ? "#14b8a6" : "#ffffff", weight: on ? 3 : 1.4, dashArray: on ? null : "4 4", opacity: 0.95, bubblingMouseEvents: false })
        .bindTooltip(`${esc(key)} — ${on ? "in the cart · click to remove" : "click to add to the cart"}`, { className: "parktip", sticky: true })
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
  const t = tagsFor(p); t.sel = key;
  if (key) {
    const hit = fieldKeys(p).find(x => x.key === key), rt = t.fr[key];
    if (rt?.lat != null) { angle = rt.angle; pin = L.latLng(rt.lat, rt.lon); }
    else if (hit) { pin = L.latLng(hit.f.c[0], hit.f.c[1]); angle = longAxis(hit.f.p); }
    if (pin) map.panTo(pin, { animate: true });
    $("fitPop").hidden = false;
  } else $("fitPop").hidden = true;
  sizeField(); drawParkFields(p); drawLights(p); previewFields(p); renderTags(p);
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
      const l = mk.getLatLng(); arr[k] = [+l.lat.toFixed(6), +l.lng.toFixed(6)];
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
  const t = tagsFor(p);
  activeLights(t).push([+latlng.lat.toFixed(6), +latlng.lng.toFixed(6)]);
  syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p);
}
function removeLight(p, k) {
  const t = tagsFor(p); activeLights(t).splice(k, 1);
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
  $("noLightsBtn").onclick = () => { const p = current(); if (!p) return; const t = tagsFor(p);
    if (t.lights === "none") t.lights = "unknown"; else { t.lights = "none"; t.lightPts = []; Object.values(t.fr).forEach(x => { x.lights = []; }); }
    drawLights(p); renderTags(p); };
}

// ── Frisbee field overlay: frame-centred, true scale, centre button locks/unlocks rotation ─
// The field is frame-centred until it's locked; locking pins it to that spot on the map
// (pin), so panning afterwards moves the map under it. Unlocking recentres on it.
let angle = 0, rotating = false, pin = null;
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
    ? "Twist with two fingers to turn · drag to move · tap the button to lock it there"
    : "Move the mouse to turn · drag the map to move · click to lock it there";
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
  const n = nearestFields(p); tagsFor(p).sel = n ? n.key : null;
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
  $("fitMsg").textContent = moved ? `${target} — moved, rate it again to save this spot` : `${target}${t.sel && t.fr[t.sel]?.fit && t.fr[t.sel].fit !== "unknown" ? " · click a fit to change it, or the same one to clear it" : pin ? "" : " · pan to fine-tune"}`;
  $("fitMsg").classList.toggle("warn", moved);
  $("fitPop").querySelectorAll("[data-fit]").forEach(b => b.setAttribute("aria-pressed", String(!!t.sel && t.fr[t.sel]?.fit === b.dataset.fit && !moved)));
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
  const t = tagsFor(p), c = fieldCentre();
  if (!t.sel) { const n = nearestFields(p); t.sel = n ? n.key : "This spot"; }
  const cur = t.fr[t.sel] || { name: t.sel, lights: [] };
  if (cur.fit === fit && !spotMoved(t)) { cur.fit = "unknown"; delete cur.lat; delete cur.lon; delete cur.angle; }
  else Object.assign(cur, { name: t.sel, fit, lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), angle: Math.round(angle) });
  t.fr[t.sel] = cur;
  syncFromFields(t);
  $("fitPop").hidden = true; drawParkFields(p); drawLights(p); renderTags(p);
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
    if (reg && p.region !== reg) return;
    const ll = parkLatLng(p); if (!ll) return;
    const r = reviews[p.id], col = suitColor(r), top = r?.decision === "top", isCur = view === "city" && cur?.id === p.id && !!focusId;
    pts.push(ll);
    const pv = privOps(p);
    const fl = !PRIV_BY_PARK[p.id]?.length && flags[p.id];
    const ult = ultimateOf(p);
    const inCart = workMode === "book" ? (bookLocs[whoBooks()] || []).filter(x => x.park_id === p.id).length : 0;
    if (inCart) L.circleMarker(ll, { radius: 13, color: "#14b8a6", weight: 4, fill: false, interactive: false }).addTo(cityLayer);
    // An ultimate club's home: a bigger diamond whose centre is the club's colours.
    const clubCol = ult.find(o => o.colors)?.colors;
    const isAmua = pv?.some(o => o.amua);
    const mk = isAmua ? amuaMarker(ll, col, isCur) : pv?.length ? privMarker(ll, col, isCur, top, clubCol) : L.circleMarker(ll, { radius: r ? 8 : 6,
      color: top ? "#e0a647" : isCur ? "#15211c" : fl ? PRIV_COLOR : "#ffffff", weight: top || isCur || fl ? 3 : 1.5, dashArray: fl ? "3 3" : null,
      fillColor: col, fillOpacity: r ? 0.95 : 0.7, bubblingMouseEvents: false });
    const tags = r ? [r.decision === "top" ? "★ Top pick" : r.decision === "yes" ? "Shortlisted" : "Rejected",
      r.quality ? r.quality + "/5" : "", r.fit && r.fit !== "unknown" ? FIT_LABEL[r.fit] : "",
      r.lights === "full" || r.lights === "training" ? "💡 lights" : r.lights === "none" ? "no lights" : ""].filter(Boolean).join(" · ") : "Not rated yet";
    mk.bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.region)} · <b style="color:${col}">${suitWord(r)}</b><br>${esc(tags)}${r?.fields ? "<br>Fields: " + esc(r.fields) : ""}`
      + (isAmua ? `<br><b style="color:#b7791f">★ Book only through: AMUA</b>`
        : pv?.length ? `<br><b style="color:${PRIV_COLOR}">◆ Privately managed: contact ${esc(pv[0].short)}</b> first` : "")
      + (ult.length ? `<br><b style="color:${ULT_COLOR}">🥏 ${ult.some(o => o.booking_only) ? "Book only through" : "Ultimate club"}: ${esc(ult.map(o => o.operator).join(", "))}</b>` : "")
      + (fl ? `<br><b style="color:${PRIV_COLOR}">◇ Flagged: probably club-run${fl.club ? " (" + esc(fl.club) + ")" : ""}</b>` : "")
      + (workMode === "book" ? `<br>🛒 ${inCart ? `${inCart} field${inCart > 1 ? "s" : ""} in the cart · ` : ""}<i>Click to book fields</i>` : `<br><i>Click to rate</i>`),
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
    (o.amua ? amuaMarker(ll, "#ffffff", false) : privMarker(ll, "transparent", false, false)).bindPopup(privHtml(o), { className: "parktip", maxWidth: 320 })
      .bindTooltip(`<b>${esc(o.park)}</b><br><b style="color:${PRIV_COLOR}">◆ ${esc(o.operator)}</b><br>Not in the council field maps · click for contacts`, { className: "parktip", direction: "top", offset: [0, -8] })
      .addTo(cityLayer);
  });
  return pts;
}
// AMUA's existing providers (GTEC, booked through CPSA at Cornwall Park): a gold star whose
// centre shows the suitability colour.
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
function privHtml(o) {
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
    + `<div class="lg-b">${row(`hsl(${suitHue(0.95)} 72% 42%)`, "Excellent")}${row(`hsl(${suitHue(0.7)} 72% 42%)`, "Good")}${row(`hsl(${suitHue(0.5)} 72% 42%)`, "Fair")}${row(`hsl(${suitHue(0.2)} 72% 42%)`, "Poor")}${row("#b3372d", "Rejected")}${row("#8a958f", "Not rated")}<div><span class="dia" style="background:linear-gradient(45deg,#f2b705 50%,#c8102e 50%);border-color:#f2b705;box-shadow:0 0 0 2px ${PRIV_COLOR}"></span><b>Ultimate club home</b> <span class="lg-note">(club colours)</span></div><div><span class="amualg"><span></span></span><b>AMUA venue</b> <span class="lg-note">(GTEC · CPSA)</span></div><div><span class="dia"></span>Privately managed</div><div><i style="background:#8a958f;border:2px dashed ${PRIV_COLOR};box-shadow:none"></i>Flagged: probably club-run</div><div class="lg-note">Gold ring = top pick</div></div>`;
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
  applyModeUi();
  if (v === "book" && rotating) setRotating(false);
  if (v === "city") {
    if (rotating) setRotating(false);
    $("fitPop").hidden = true;
    if (was === "park" && shownPark) { /* remember nothing: the city view keeps its own position */ }
    if (overlay) { overlay.remove(); overlay = null; }
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
function openPark(id) { focusId = id; setView("park"); }

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
const cartIds = () => new Set((bookLocs[whoBooks()] || []).map(x => x.id));
// Add or remove one field (or "Whole park") of a park in the booker's cart; saves at once.
async function toggleCart(p, key) {
  const who = whoBooks(), list = bookLocs[who] || [], id = cartId(p, key), i = list.findIndex(x => x.id === id);
  if (i >= 0) list.splice(i, 1);
  else {
    const wf = parkWorkflow(p), f = fieldKeys(p).find(x => x.key === key)?.f, c = f?.c || [p.lat, p.lon];
    list.push({ id, park_id: p.id, park: p.name, region: p.region, field: key, lat: c[0], lon: c[1], kind: wf.kind, operator: wf.operator,
      added_at: new Date().toISOString(), added_by: session?.user?.email || "" });
  }
  bookLocs[who] = list;
  const saved = await saveBookLocs();
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
  const who = whoBooks(), wf = parkWorkflow(p), inPark = (bookLocs[who] || []).filter(x => x.park_id === p.id);
  const whole = inPark.some(x => x.field === "Whole park"), known = Object.keys(bookLocs).filter(e => e !== who);
  $("bookBar").innerHTML = `<div class="bb-row"><label>Booking for ${IS_ADMIN ? `<input id="bookWho2" list="bookWhoList2" value="${esc(who)}" title="The booker whose cart this is">` : `<b>${esc(who)}</b>`}</label>
      <datalist id="bookWhoList2">${known.map(e => `<option value="${esc(e)}">`).join("")}</datalist>
      <button class="b" id="bbWhole" aria-pressed="${whole}" title="Book the park without choosing fields">Whole park</button>
      <button class="b" id="bbCart">🛒 Cart (${(bookLocs[who] || []).length})</button>
      <a href="${venueLink(wf.provider, p.name)}" target="_blank" rel="noopener">Open in bookings ↗</a></div>
    <div class="bb-row">${inPark.length ? inPark.map(x => `<span class="chipf">${esc(x.field)} <button data-uncart="${esc(x.field)}" title="Remove">✕</button></span>`).join("") : `<span class="muted">Click a field area on the map to add it to the cart.</span>`}</div>
    <div class="bb-row">${workflowHtml(wf)}</div>
    <div class="bb-row muted">Council fee: $10 per field per application, pending until AMUA sends it, then split between the bookers sharing each field.</div>`;
}
// The Cart tab: everything in the booker's cart, by park.
function renderBook() {
  const who = whoBooks(), mine = bookLocs[who] || [], known = Object.keys(bookLocs).filter(e => e !== who);
  const byPark = {};
  mine.forEach(x => (byPark[x.park] ||= []).push(x));
  $("bookPanel").innerHTML = `<div class="bk-who"><h3>🛒 Cart</h3><label>for ${IS_ADMIN ? `<input id="bookWho" list="bookWhoList" value="${esc(who)}" title="The booker whose cart this is">` : `<b>${esc(who)}</b>`}</label>
      <datalist id="bookWhoList">${known.map(e => `<option value="${esc(e)}">`).join("")}</datalist></div>
    <p class="muted">Switch to <b>📅 Book</b> mode, open a park from the Auckland map and click its field areas to add them. Cart fields appear in the booking site's location dropdown for this booker.</p>
    <div><b>${mine.length} field${mine.length === 1 ? "" : "s"}</b> <span class="muted">at ${Object.keys(byPark).length} park${Object.keys(byPark).length === 1 ? "" : "s"}</span></div><div class="bk-list">`
    + (mine.length ? Object.entries(byPark).map(([park, xs]) => xs.map(x => `<div class="bk-row"><span class="n">${esc(park)} – ${esc(x.field)}</span>
        <span class="tag${x.kind === "council_private" ? " priv" : ""}">${x.kind === "council_private" ? "◆ " + esc(x.operator?.short || "operator") + " + council" : "🏛 council"}</span>
        <button data-bkopen="${esc(x.park_id)}" title="Open this park in Book mode">open</button>
        <a href="${venueLink(x.kind === "council_private" ? "op_" + x.operator.id : "akl_council", park)}" target="_blank" rel="noopener">book ↗</a>
        <button data-bkdel="${esc(x.id)}" title="Remove from the cart">✕</button></div>`).join("")).join("")
      : `<p class="muted">The cart is empty.</p>`) + `</div>`;
}
function renderTabs() { $("bookTab").textContent = `🛒 Cart${(bookLocs[whoBooks()] || []).length ? ` (${(bookLocs[whoBooks()] || []).length})` : ""}`; }
function applyModeUi() {
  const book = workMode === "book";
  $("modeRate").setAttribute("aria-checked", String(!book)); $("modeBook").setAttribute("aria-checked", String(book));
  $("card").classList.toggle("bookmode", book);
  $("info").hidden = view !== "park" || book; $("bookBar").hidden = view !== "park" || !book;
  $("actions").hidden = view !== "park" || book;
  if (book && rotating) setRotating(false);
  if (book) $("fitPop").hidden = true;
}
function setMode(m) {
  if (!IS_ADMIN) m = "book";
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
    if (e.target.id === "bbCart") setView("book"); });
  $("bookPanel").addEventListener("click", async e => {
    const del = e.target.closest("[data-bkdel]");
    if (del) { const w = whoBooks(); bookLocs[w] = (bookLocs[w] || []).filter(x => x.id !== del.dataset.bkdel);
      if (await saveBookLocs()) setStatus("Removed from " + w + "'s cart."); renderBook(); renderTabs(); return; }
    const op = e.target.closest("[data-bkopen]"); if (op) { if (workMode !== "book") setMode("book"); openPark(op.dataset.bkopen); }
  });
  $("modeRate").onclick = () => setMode("rate");
  $("modeBook").onclick = () => setMode("book");
}

// ── Render ───────────────────────────────────────────────────────────────────
function renderTags(p) {
  const t = tagsFor(p);
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
// The club-run flag only applies to parks not already in the private-operator list.
function renderFlag(p) {
  const known = !!PRIV_BY_PARK[p.id]?.length, fl = flags[p.id];
  $("clubFlagBtn").hidden = known; $("clubIn").hidden = known || !fl;
  $("clubFlagBtn").setAttribute("aria-pressed", String(!!fl));
  $("clubFlagBtn").textContent = fl ? "◆ Flagged: club-run" : "◇ Club-run?";
  $("clubFlagBtn").title = fl ? `Flagged${fl.by ? " by " + fl.by.split("@")[0] : ""} as probably club-run. Click to clear.`
    : "Flag this park as probably run by a club, even though it isn't in the private-operator list yet";
  if (document.activeElement !== $("clubIn")) $("clubIn").value = fl?.club || "";
}
function renderRail() {
  const reg = $("region").value, mapsOnly = $("mapsOnly").checked;
  const scope = PARKS.filter(x => (!reg || x.region === reg) && (!mapsOnly || x.maps.length));
  const done = scope.filter(x => reviews[x.id]).length;
  $("progress").textContent = `${done} / ${scope.length} reviewed`;
  $("barFill").style.width = scope.length ? (100 * done / scope.length) + "%" : "0";
  const all = Object.entries(reviews).filter(([id]) => BYID[id]);
  $("nTop").textContent = all.filter(([, r]) => r.decision === "top").length;
  $("nYes").textContent = all.filter(([, r]) => r.decision === "yes").length;
  $("nNo").textContent = all.filter(([, r]) => r.decision === "no").length;
  const picks = all.filter(([, r]) => r.decision !== "no").sort((a, b) => suitScore(b[1]) - suitScore(a[1]) || BYID[a[0]].name.localeCompare(BYID[b[0]].name));
  $("list").innerHTML = picks.length ? picks.map(([id, r]) => { const pp = BYID[id];
    return `<button data-open="${id}"><span class="dot" style="background:${suitColor(r)}"></span><span style="min-width:0"><span class="n">${r.decision === "top" ? "★ " : ""}${esc(pp.name)}</span><span class="m">${esc(pp.region)} · ${suitWord(r).toLowerCase()} · ${esc(FIT_LABEL[r.fit] || r.fit)}${r.quality ? " · " + r.quality + "/5" : ""}${r.lights === "full" || r.lights === "training" ? " · 💡" : ""}</span></span></button>`; }).join("")
    : `<p class="help">Shortlisted and top-pick parks collect here, best first.</p>`;
  return { scope, done };
}
function renderCity() {
  const { scope, done } = renderRail();
  const reg = $("region").value;
  $("parkName").textContent = reg ? reg + " parks" : "Auckland";
  $("parkRegion").textContent = `${scope.length} parks`; $("decChip").innerHTML = "";
  $("handleHint").textContent = "Click a park to rate it · colours show overall suitability · zoom in to see its fields";
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
  $("decChip").innerHTML = ""; $("handleHint").textContent = "Council fields in the booker's cart, ready for the booking site";
}
function render() {
  if (view === "book") { renderParkHeader(); renderBook(); renderTabs(); renderRail(); return; }
  renderTabs(); applyModeUi();
  if (view === "city") return renderCity();
  const q = queue(), p = current(), next = focusId ? null : (q[cursor + 1] || (q.length > 1 ? q[0] : null));
  const card = $("card");
  $("emptyState").hidden = !!p; card.hidden = !p; $("behind").hidden = !p || !next || next.id === p?.id || !next.maps.length;
  $("handleHint").textContent = focusId ? "Opened from the Auckland map · decide to go back to it · ← reject · → shortlist · ↑ top pick" : "Drag here to decide · ← reject · → shortlist · ↑ top pick";
  if (!p) {
    const m = $("mode").value;
    $("emptyState").innerHTML = `<h2>${m === "todo" ? "All caught up" : "Nothing here yet"}</h2>${m === "todo" ? "Every park in this view has a decision. Open the Auckland map to look back over them." : "Parks you decide on will appear here."}`;
  } else {
    if (next?.maps.length) $("behindImg").src = BASE + "council-maps/" + next.maps[0].file;
    $("parkName").textContent = p.name; $("parkRegion").textContent = p.region;
    const pv = privOps(p), co = councilOnly(p);
    $("privBox").hidden = !pv.length && !co; $("privBox").classList.toggle("co", co);
    $("privBox").innerHTML = co ? councilOnlyBanner(p) : pv.length ? privBanner(pv) : "";
    renderFlag(p); renderCouncilOnly(p);
    const r = reviews[p.id];
    // Chips: the managing club (◆) and any ultimate club (🥏), which may be the booking contact.
    const lead = (pv || []).find(o => o.code !== "ultimate"), ult = ultimateOf(p);
    $("decChip").innerHTML = (lead ? `<span class="chip priv" title="Ask ${esc(lead.operator)} before applying to council">◆ ${esc(lead.short)}</span> ` : "")
      + ult.map(o => `<span class="chip ult" title="Home of ${esc(o.operator)}"${o.colors ? ` style="background:${o.colors.pattern || o.colors.fill};color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.8);box-shadow:inset 0 0 0 2px ${o.colors.edge || "#fff"}"` : ""}>🥏 ${esc(o.short)}</span> `).join("") + (r ? `<span class="chip ${r.decision === "no" ? "no" : r.decision === "top" ? "top" : ""}">${r.decision === "top" ? "Top pick" : r.decision === "yes" ? "Shortlisted" : "Rejected"}${r.by ? " · " + esc(r.by.split("@")[0]) : ""}</span>` : "");
    const i = Math.min(mapIdx[p.id] || 0, Math.max(0, p.maps.length - 1));
    $("thumbs").innerHTML = p.maps.length > 1 ? p.maps.map((m, k) => `<button data-map="${k}" aria-pressed="${k === i}" title="${esc(m.title)}">${m.season === "winter" ? "❄ Winter" : "☀ Summer"}${/area/i.test(m.title) ? " area" : ""}</button>`).join("") : "";
    const cf = councilFields(p).map(f => f.n).filter(Boolean);
    $("fieldList").textContent = cf.length ? "Council fields: " + [...new Set(cf)].join(" · ") : p.fields.length ? "Council fields: " + p.fields.join(" · ") : (p.maps.length ? "" : "No council map for this park (often a school or stadium ground). Satellite only.");
    const c = p.lat ? `${p.lat},${p.lon}` : encodeURIComponent(p.name + " Auckland");
    $("gmaps").href = p.lat ? `https://www.google.com/maps/@${c},250m/data=!3m1!1e3` : `https://www.google.com/maps/search/${c}`;
    const fresh = shownPark !== p.id + "#" + i;
    if (fresh) showMap(p);
    renderTags(p);
    if (workMode === "book") renderBookBar(p);
    // Restore a saved field placement for a reviewed park.
    if (fresh && tagsFor(p).spot && !tagsFor(p)._placed) { const sp = tagsFor(p).spot; angle = sp.angle || 0; map.setView([sp.lat, sp.lon], map.getZoom(), { animate: false }); pin = L.latLng(sp.lat, sp.lon); tagsFor(p)._placed = true; sizeField(); renderCentre(); }
  }
  ["noBtn", "yesBtn", "topBtn", "skipBtn"].forEach(b => $(b).disabled = !p);
  $("undoBtn").disabled = !undoStack.length;
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
  const prevPl = reviews[p.id]?.placement;
  if (t.spot && ratedCount(t) >= 3) {
    const a = await askPlacement(p, t, decision);
    if (a === "cancel") return;
    withField = a === "with";
  }
  busy = true;
  const card = $("card"); card.classList.remove("snap", "deal"); card.classList.add("fly");
  const x = decision === "yes" ? 800 : decision === "no" ? -800 : 0, y = decision === "top" ? -600 : 40;
  card.style.transform = `translate(${x}px, ${y}px) rotate(${x / 25}deg)`; card.style.opacity = "0";
  const pos = withField ? { ...t.spot, ...dims }
    : prevPl?.lat != null ? { lat: prevPl.lat, lon: prevPl.lon, angle: prevPl.angle, len: prevPl.len, wid: prevPl.wid, ez: prevPl.ez } : { lat: null, lon: null };
  // Per-field ratings and their lights are kept either way; "without" only skips the park's pin.
  const fr = Object.fromEntries(Object.entries(t.fr).filter(([, x]) => (x.fit && x.fit !== "unknown") || x.lights?.length));
  const placement = (pos.lat != null || t.lightPts.length || Object.keys(fr).length) ? { ...pos, lights: t.lightPts, fields: fr } : null;
  const rev = { decision, lights: t.lights, fit: t.fit, quality: t.quality || null, fields: t.fields.trim(), notes: t.notes.trim(), placement };
  const prev = reviews[p.id] ? { ...reviews[p.id] } : null;
  await new Promise(r => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220));
  const ok = await save(p.id, rev);
  const fromCity = !!focusId;
  if (ok) { undoStack.push({ id: p.id, prev }); delete draft[p.id]; later.delete(p.id); if (!fromCity && $("mode").value !== "todo") cursor++; }
  card.classList.remove("fly"); card.style.transform = ""; card.style.opacity = "";
  void card.offsetWidth; card.classList.add("deal");
  if (rotating) setRotating(false);
  $("fitPop").hidden = true;
  busy = false;
  if (ok && fromCity) { focusId = null; setView("city"); setStatus(`Saved ${p.name} — ${suitWord(reviews[p.id]).toLowerCase()}.`); return; }
  render();
}
function skip() {
  const p = current(); if (!p) return;
  if (focusId) { focusId = null; setView("city"); return; }
  later.add(p.id); cursor = $("mode").value === "todo" ? 0 : cursor + 1; $("fitPop").hidden = true; render();
}
async function undo() {
  const last = undoStack.pop(); if (!last) return render();
  if (await save(last.id, last.prev)) { delete draft[last.id]; shownPark = null;
    setStatus("Undid the decision on " + BYID[last.id].name + ".");
    if (view === "city") return render();
    const i = queue().findIndex(p => p.id === last.id); if (i >= 0 && !focusId) cursor = i; else focusId = last.id; }
  render();
}

// ── Events ───────────────────────────────────────────────────────────────────
function bind() {
  $("card").addEventListener("click", e => {
    const t = e.target.closest("[data-tag]"), mp = e.target.closest("[data-map]"), p = current(); if (!p || view === "city") return;
    if (mp) { mapIdx[p.id] = +mp.dataset.map; render(); return; }
    if (t && t.tagName === "BUTTON") { const d = tagsFor(p), k = t.dataset.tag, v = k === "quality" ? +t.dataset.val : t.dataset.val;
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
  $("fitPop").addEventListener("click", e => { const b = e.target.closest("[data-fit]"), p = current(); if (!b || !p) return;
    confirmSpot(p, b.dataset.fit); });
  $("fieldBtn").onclick = () => showField(!fieldOn);
  bindDispenser();
  $("clubFlagBtn").onclick = async () => { const p = current(); if (!p) return;
    if (await saveFlag(p.id, flags[p.id] ? null : { club: "" })) { renderFlag(p); if (flags[p.id]) $("clubIn").focus(); } };
  $("councilOnlyBtn").onclick = async () => { const p = current(); if (!p) return;
    if (await setCouncilOnly(p, !councilOnly(p))) render(); };
  $("clubIn").addEventListener("change", async () => { const p = current(); if (!p || !flags[p.id]) return;
    await saveFlag(p.id, { club: $("clubIn").value.trim() }); renderFlag(p); });
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
  $("skipBtn").onclick = skip; $("undoBtn").onclick = undo;
  ["region", "mode", "mapsOnly"].forEach(id => $(id).addEventListener("change", () => {
    cursor = 0; store.set("vet-" + id, id === "mapsOnly" ? $(id).checked : $(id).value);
    if (view === "city" && id === "region") return setView("city", { refit: true });
    if (view === "park" && !focusId) shownPark = null;
    render(); }));
  $("list").addEventListener("click", e => { const b = e.target.closest("[data-open]"); if (b) openPark(b.dataset.open); });
  $("exportBtn").onclick = exportCsv;
  window.addEventListener("focus", async () => { if (mode === "shared" && !busy) { await loadShared(); if (view === "city") render(); else renderRail(); } });
  document.addEventListener("keydown", e => {
    if ($("saveDlg").open || e.target.matches("input, textarea, select")) return;
    const p = current();
    if (!IS_ADMIN && !/^(Escape|c|C)$/.test(e.key)) return;   // bookers: no rating keys
    if (e.key === "Escape") { if (rotating) setRotating(false); $("sizePanel").hidden = true; $("fitPop").hidden = true; if (p && tagsFor(p).sel) selectField(p, null); return; }
    if (/^[cC]$/.test(e.key)) { focusId = null; setView(view === "city" ? "park" : "city"); return; }
    if (/^[bB]$/.test(e.key)) { setMode(workMode === "book" ? "rate" : "book"); return; }
    if (view === "city") return;
    if (e.key === "ArrowRight") { e.preventDefault(); decide("yes"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); decide("no"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); decide("top"); }
    else if (e.key === "Enter" && fieldOn && !e.target.closest("button")) { e.preventDefault(); $("centreBtn").click(); }
    else if (/^[sS]$/.test(e.key)) skip();
    else if (/^[zZ]$/.test(e.key)) undo();
    else if (/^[tT]$/.test(e.key)) showField(!fieldOn);
    else if (e.key === "0") $("fitBtn").click();
    else if (/^[rR]$/.test(e.key)) { angle = (angle + 15) % 360; sizeField(); afterMove(); }
    else if (p && /^[1-5]$/.test(e.key)) { tagsFor(p).quality = +e.key; renderTags(p); }
    else if (p && /^[mM]$/.test(e.key) && p.maps.length > 1) { mapIdx[p.id] = ((mapIdx[p.id] || 0) + 1) % p.maps.length; render(); }
  });
}
function exportCsv() {
  const rows = [["Region", "Park", "Decision", "Suitability", "Lights", "Light poles", "Fit", "Quality", "Fields", "Notes", "Field placement (lat, lon, angle°)", "Private operator", "Operator contact", "Ultimate club", "Flagged club-run", "Reviewer", "Reviewed at"]];
  PARKS.forEach(p => { const r = reviews[p.id] || {}, fl = flags[p.id]; if (!reviews[p.id] && !fl && !ultimateOf(p).length) return; const pl = r.placement;
    rows.push([p.region, p.name, r.decision ? (r.decision === "top" ? "top pick" : r.decision === "yes" ? "shortlist" : "reject") : "", r.decision ? suitWord(r) : "", r.lights || "", pl?.lights?.length || 0,
      r.fit ? FIT_LABEL[r.fit] || r.fit : "", r.quality || "", r.fields || "", r.notes || "", pl?.lat != null ? `${pl.lat}, ${pl.lon}, ${pl.angle}` : "",
      privOps(p)[0]?.operator || "",
      [privOps(p)[0]?.contact?.email, privOps(p)[0]?.contact?.phone].filter(Boolean).join(" / "),
      ultimateOf(p).map(o => o.operator + ([o.contact?.email, o.contact?.phone].filter(Boolean).length ? ` (${[o.contact?.email, o.contact?.phone].filter(Boolean).join(" / ")})` : "")).join("; "),
      fl ? "yes" + (fl.club ? ": " + fl.club : "") : "", r.by || "", r.at || ""]); });
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "council-field-vetting.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Start ────────────────────────────────────────────────────────────────────
function gate(html) { $("gate").innerHTML = html; $("gate").hidden = false; $("app").hidden = true; }
async function start() {
  // "no-cache" revalidates with the server, so a data update shows on the next load instead
  // of after GitHub Pages' ~10-minute browser cache expires.
  const res = await fetch(BASE + "council-maps/parks.json", { cache: "no-cache" }); PARKS = (await res.json()).parks; BYID = Object.fromEntries(PARKS.map(p => [p.id, p]));
  try { const pr = await fetch(BASE + "council-maps/private-managed.json", { cache: "no-cache" }); if (pr.ok) PRIV = await pr.json(); } catch { /* optional data */ }
  PRIV_BY_PARK = {};
  (PRIV.operators || []).filter(o => o.park_id).forEach(o => (PRIV_BY_PARK[o.park_id] ||= []).push(o));
  // Point of contact first: the operator marked primary, else the rugby or football club.
  // Contact order: the sole booking channel, then primary, then rugby/football; an ultimate
  // club that isn't the booking channel is listed separately.
  const rank = o => o.booking_only ? -1 : o.code === "ultimate" ? 3 : o.primary ? 0 : ["rugby", "football"].includes(o.code) ? 1 : 2;
  Object.values(PRIV_BY_PARK).forEach(ops => ops.sort((a, b) => rank(a) - rank(b)));
  const regions = [...new Set(PARKS.map(p => p.region))];
  $("region").insertAdjacentHTML("beforeend", regions.map(r => `<option>${esc(r)}</option>`).join(""));
  $("region").value = store.get("vet-region", ""); $("mode").value = store.get("vet-mode", "todo"); $("mapsOnly").checked = store.get("vet-mapsOnly", true);

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
    await loadShared();
    if (!IS_ADMIN) {
      workMode = "book"; document.body.classList.add("viewer");
      setStatus("Pick a park, then click its field areas to add them to your cart. They show up in your booking site locations.");
    }
  } else {
    reviews = store.get("vet-reviews", {}); flags = store.get("vet-flags", {});
    setStatus("Demo mode (no Supabase configured): decisions are kept in this browser.", true);
  }
  $("app").hidden = false;
  await loadBookLocs(); await loadCouncilOnly(); await syncCartWorkflows();
  initMap(); drawField(); showField(fieldOn); renderLegend(); bind();
  setView(view === "park" || view === "book" ? view : "city", { refit: true });
  if (mode === "shared") setInterval(async () => { if (!busy && !rotating && document.visibilityState === "visible" && !$("saveDlg").open) { await loadShared(); if (view === "city") render(); else renderRail(); } }, 30000);
}
start().catch(e => setStatus("Couldn't start: " + (e.message || e), true));
