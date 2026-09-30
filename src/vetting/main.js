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

// Lights come from the poles you mark on the map; "None" records that you checked and there aren't any.
const LIGHT_OPTS = [["unknown", "?"], ["none", "None"], ["full", "Yes"]];
// Fit: how much ultimate the space holds.
const FIT_OPTS = [["reduced", "Reduced size"], ["full", "1 full field"], ["multi", "2+ fields"]];
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

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
                set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };
function setStatus(t, warn) { $("status").textContent = t; $("status").classList.toggle("warn", !!warn); }

let PARKS = [], BYID = {};
let PRIV = { operators: [], workflow: [] }, PRIV_BY_PARK = {};   // park_id -> [operators] from private-managed.json (a ground can have several)
let reviews = {};              // park_id -> review
let mode = "local";            // "shared" (Supabase) | "local" (this browser)
let session = null;
const undoStack = [];
const later = new Set();
const draft = {};              // park_id -> tags being edited before deciding
const mapIdx = {};
let cursor = 0, busy = false;
let dims = store.get("vet-field-dims", WFDF);
let fieldOn = store.get("vet-field-on", true);
let view = store.get("vet-view", "city");   // "city" | "park"
let focusId = null;                          // park opened from the Auckland map (overrides the queue)

// ── Data ─────────────────────────────────────────────────────────────────────
function fromRow(r) { return { decision: r.decision, lights: r.lights, fit: r.fit, quality: r.quality, fields: r.fields || "", notes: r.notes || "",
  placement: r.placement || null, by: r.reviewer_email || "", at: r.updated_at }; }
async function loadShared() {
  const { data, error } = await supabase.from("field_reviews").select("*");
  if (error) {
    mode = "local"; reviews = store.get("vet-reviews", {});
    const missing = /field_reviews|does not exist|schema cache/i.test(error.message || "");
    setStatus(missing ? "The field_reviews table isn't set up yet (run supabase-migration-field-reviews.sql). Decisions are kept in this browser for now."
                      : "Couldn't load shared decisions (" + error.message + "). Decisions are kept in this browser for now.", true);
    return;
  }
  mode = "shared"; reviews = Object.fromEntries(data.map(r => [r.park_id, fromRow(r)]));
  setStatus(`Shared with all admins · ${data.length} decisions so far`);
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
      spot: r.placement?.lat != null ? { lat: r.placement.lat, lon: r.placement.lon, angle: r.placement.angle || 0 } : null }; }
  return draft[p.id];
}
// "Majority configured": at least three of lights, fit, quality and fields are set.
function ratedCount(t) { return [t.lights !== "unknown", t.fit !== "unknown", t.quality > 0, !!t.fields.trim()].filter(Boolean).length; }

// ── Map ──────────────────────────────────────────────────────────────────────
let map, overlay = null, baseZoom = null, forced = null, shownPark = null;
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
  map.on("zoomanim", e => { $("field").classList.add("zooming"); sizeField(e.zoom); });
  map.on("zoomend", () => { $("field").classList.remove("zooming"); forced = null; updateLayer(); sizeField(); syncCityFields(); });
  map.on("move", () => sizeField());
  map.on("moveend", () => { if (view === "park" && fieldOn && !rotating) afterMove(); });
  map.on("click", e => {
    if (view === "city") return;
    if (rotating) { lockField(); return; }
    const p = current(); if (!p) return;
    const t = tagsFor(p); t.lightPts.push([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]);
    if (t.lights !== "full" && t.lights !== "training") t.lights = "full";
    drawLights(p); renderTags(p);
  });
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
  forced = null; shownPark = p.id + "#" + i; updateLayer(); sizeField(); drawParkFields(p); drawLights(p);
}
function councilVisible() {
  if (!overlay) return false;
  if (forced) return forced === "council";
  const z = map.getZoom();
  return z >= baseZoom - REVEAL_OUT && z <= baseZoom + REVEAL_IN;
}
function updateLayer() {
  const on = councilVisible();
  if (overlay) overlay.setOpacity(on ? 1 : 0);
  $("layerBadge").textContent = on ? "Council map" : "Satellite";
  $("layerBtn").textContent = on ? "⇄ Satellite" : "⇄ Council map";
  $("layerBtn").disabled = !overlay;
}
// Council fields traced from the map PDFs: [{n: name, c: [lat, lon], p: [[lat, lon], …]}].
function councilFields(p) {
  const i = Math.min(mapIdx[p.id] || 0, Math.max(0, p.maps.length - 1));
  return p.maps[i]?.fields || [];
}
function drawParkFields(p) {
  parkFieldsLayer.clearLayers();
  const chosen = new Set(tagsFor(p).fields.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  councilFields(p).forEach(f => {
    const on = chosen.has((f.n || "").toLowerCase());
    L.polygon(f.p, { pane: "fieldsPane", interactive: false, fill: on, fillColor: "#ffd400", fillOpacity: 0.12,
      color: on ? "#ffd400" : "#ffffff", weight: on ? 2.5 : 1.2, dashArray: on ? null : "4 4", opacity: 0.9 }).addTo(parkFieldsLayer);
  });
}
function drawLights(p) {
  lightLayer.clearLayers();
  const t = tagsFor(p);
  t.lightPts.forEach((ll, k) => {
    L.marker(ll, { icon: L.divIcon({ className: "", html: `<div class="lightpin">💡</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }),
      title: "Light pole — click to remove", keyboard: false })
      .on("click", e => { L.DomEvent.stopPropagation(e); t.lightPts.splice(k, 1);
        if (!t.lightPts.length && t.lights === "full") t.lights = "unknown"; drawLights(p); renderTags(p); })
      .addTo(lightLayer);
  });
}

// ── Frisbee field overlay: frame-centred, true scale, centre button locks/unlocks rotation ─
let angle = 0, rotating = false;
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
function sizeField(zoom) {
  if (!map) return;
  const z = zoom ?? map.getZoom(), lat = map.getCenter().lat;
  const mpp = 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * Math.pow(2, z));
  const w = dims.len / mpp, h = dims.wid / mpp, svg = $("fieldSvg");
  svg.style.width = w + "px"; svg.style.height = h + "px";
  svg.style.left = -w / 2 + "px"; svg.style.top = -h / 2 + "px";
  svg.style.transform = `rotate(${angle}deg)`;
}
function setRotating(on) {
  rotating = on; $("field").classList.toggle("live", on); $("rotateHint").hidden = !on;
  if (on) { map.dragging.disable(); $("fitPop").hidden = true; } else map.dragging.enable();
  renderCentre();
}
function showField(on) {
  fieldOn = on; store.set("vet-field-on", on);
  $("field").hidden = !on; $("centreWrap").hidden = !on; $("fieldBtn").setAttribute("aria-pressed", String(on));
  if (!on) { if (rotating) setRotating(false); $("fitPop").hidden = true; }
}
// Locking only fixes the angle. You can still pan to fine-tune the spot; the nearest council
// field is previewed as you go. Rating the fit confirms the spot: that is when the fields are
// filled in and the position recorded, and only the confirmed spot is saved with a decision.
function lockField() {
  setRotating(false);
  const p = current(); if (!p) return;
  $("fitPop").hidden = false; previewFields(p); renderCentre();
}
function nearestFields(p, fit) {
  const fs = councilFields(p).filter(f => f.n); if (!fs.length) return null;
  const c = map.getCenter(), kx = 111320 * Math.cos(c.lat * Math.PI / 180), ky = 110540;
  const d = f => Math.hypot((f.c[1] - c.lng) * kx, (f.c[0] - c.lat) * ky);
  const byDist = fs.map(f => ({ f, m: d(f) })).sort((a, b) => a.m - b.m);
  const pick = fit === "multi" ? byDist.filter(x => x.m <= Math.max(dims.len, 60) * 1.2) : [byDist[0]];
  return { nearest: byDist[0], names: [...new Set((pick.length ? pick : [byDist[0]]).map(x => x.f.n))] };
}
function spotMoved(t) {
  if (!t.spot) return false;
  const c = map.getCenter(), kx = 111320 * Math.cos(c.lat * Math.PI / 180);
  const dm = Math.hypot((t.spot.lon - c.lng) * kx, (t.spot.lat - c.lat) * 110540);
  const da = Math.abs((((angle - t.spot.angle) % 360) + 540) % 360 - 180);
  return dm > 3 || da > 2;
}
function previewFields(p) {
  const t = tagsFor(p), n = nearestFields(p, t.fit), moved = spotMoved(t);
  const near = n ? ` · nearest: ${n.nearest.f.n} (${Math.round(n.nearest.m)} m)` : "";
  $("fitMsg").textContent = moved ? `Field moved — rate the fit again to save this spot${near}` : `Pan to fine-tune, then rate the fit here${near}`;
  $("fitMsg").classList.toggle("warn", moved);
}
function afterMove() {
  const p = current(); if (!p) return;
  const t = tagsFor(p);
  if (t.spot && spotMoved(t)) $("fitPop").hidden = false;
  if (!$("fitPop").hidden) previewFields(p);
  renderCentre();
}
function confirmSpot(p, fit) {
  const t = tagsFor(p), c = map.getCenter();
  t.fit = fit;
  t.spot = { lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), angle: Math.round(angle) };
  const n = nearestFields(p, fit);
  if (n) {
    if (!t.fieldsManual || !t.fields.trim()) { t.fields = n.names.join(", "); t.fieldsManual = false; }
    $("fieldList").textContent = `Nearest council field: ${n.nearest.f.n} (${Math.round(n.nearest.m)} m from centre)`;
  }
  $("fitPop").hidden = true; drawParkFields(p); renderTags(p);
}
function renderCentre() {
  const p = current(), t = p ? tagsFor(p) : null, moved = !!t && spotMoved(t);
  $("centreWrap").classList.toggle("unlocked", rotating);
  $("centreWrap").classList.toggle("needfit", !rotating && !!t && (!t.spot || moved));
  $("centreIco").textContent = rotating ? "🔓" : "🔒";
  $("centreLbl").textContent = rotating ? "Click to lock the angle"
    : !t?.spot ? "Unlock to turn · then rate the fit"
    : moved ? "Moved · rate the fit again" : `Fits: ${FIT_LABEL[t.fit]} · spot saved`;
  $("fitPop").querySelectorAll("[data-fit]").forEach(b => b.setAttribute("aria-pressed", String(!!t && t.fit === b.dataset.fit && !moved)));
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
    const pv = PRIV_BY_PARK[p.id];
    const mk = pv?.length ? privMarker(ll, col, isCur, top) : L.circleMarker(ll, { radius: r ? 8 : 6, color: top ? "#e0a647" : isCur ? "#15211c" : "#ffffff", weight: top || isCur ? 3 : 1.5,
      fillColor: col, fillOpacity: r ? 0.95 : 0.7, bubblingMouseEvents: false });
    const tags = r ? [r.decision === "top" ? "★ Top pick" : r.decision === "yes" ? "Shortlisted" : "Rejected",
      r.quality ? r.quality + "/5" : "", r.fit && r.fit !== "unknown" ? FIT_LABEL[r.fit] : "",
      r.lights === "full" || r.lights === "training" ? "💡 lights" : r.lights === "none" ? "no lights" : ""].filter(Boolean).join(" · ") : "Not rated yet";
    mk.bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.region)} · <b style="color:${col}">${suitWord(r)}</b><br>${esc(tags)}${r?.fields ? "<br>Fields: " + esc(r.fields) : ""}`
      + (pv?.length ? `<br><b style="color:${PRIV_COLOR}">◆ Privately managed: contact ${esc(pv[0].short)}</b> first` : "") + `<br><i>Click to rate</i>`,
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
    privMarker(ll, "transparent", false, false).bindPopup(privHtml(o), { className: "parktip", maxWidth: 320 })
      .bindTooltip(`<b>${esc(o.park)}</b><br><b style="color:${PRIV_COLOR}">◆ ${esc(o.operator)}</b><br>Not in the council field maps · click for contacts`, { className: "parktip", direction: "top", offset: [0, -8] })
      .addTo(cityLayer);
  });
  return pts;
}
function privMarker(ll, fill, isCur, top) {
  return L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11],
    html: `<div class="privpin${isCur ? " cur" : ""}" style="background:${fill};${top ? "border-color:#e0a647;" : ""}margin:3px"></div>` }), keyboard: false, bubblingMouseEvents: false });
}
function privContacts(o) {
  const c = o.contact || {}, bits = [];
  if (c.email) bits.push(`<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
  if (c.phone) bits.push(`<a href="tel:${esc(c.phone.replace(/[^+\d]/g, ""))}">${esc(c.phone)}</a>`);
  if (c.url) bits.push(`<a href="${esc(c.url)}" target="_blank" rel="noopener">website ↗</a>`);
  return bits.join(" · ");
}
const privStatus = o => ({ confirmed: "confirmed", likely: "likely", "to-verify": "to verify" }[o.status] || o.status);
const privSteps = () => `<ol>${PRIV.workflow.map(w => `<li title="${esc(w.detail)}">${esc(w.label)}</li>`).join("")}</ol>`;
// Popup for a private ground that isn't a council park.
function privHtml(o) {
  const c = o.contact || {};
  return `<b>${esc(o.park)}</b>${o.approx ? " (approx. location)" : ""}<br><b style="color:${PRIV_COLOR}">◆ ${esc(o.operator)}</b> · ${esc(privStatus(o))}<br>${esc(o.manages)}<br>${privContacts(o)}${c.address ? "<br>" + esc(c.address) : ""}<br><b>Request steps</b>${privSteps()}${o.notes ? `<i>${esc(o.notes)}</i>` : ""}`;
}
// Park card banner: every operator on this ground, then the request steps once.
function privBanner(ops) {
  const [lead, ...rest] = ops;
  return `<span><b>◆ Contact: ${esc(lead.operator)}</b> (${esc(privStatus(lead))}) — ${esc(lead.manages)} · ${privContacts(lead)}</span>`
    + (rest.length ? `<span>Also on site: ${rest.map(o => `${esc(o.operator)} (${esc(o.code || o.type)}${o.contact?.url ? `, <a href="${esc(o.contact.url)}" target="_blank" rel="noopener">website ↗</a>` : ""})`).join(" · ")}</span>` : "")
    + `<span><b>Request steps:</b> ${privSteps()}</span>`;
}
function syncCityFields() {
  if (view !== "city") return;
  const want = map.getZoom() >= 14.5;
  if (want && !map.hasLayer(cityFieldsLayer)) cityFieldsLayer.addTo(map);
  if (!want && map.hasLayer(cityFieldsLayer)) cityFieldsLayer.remove();
}
function renderLegend() {
  const row = (c, t) => `<div><i style="background:${c}"></i>${t}</div>`;
  $("legend").innerHTML = `<b>Suitability</b>${row(`hsl(${suitHue(0.95)} 72% 42%)`, "Excellent")}${row(`hsl(${suitHue(0.7)} 72% 42%)`, "Good")}${row(`hsl(${suitHue(0.5)} 72% 42%)`, "Fair")}${row(`hsl(${suitHue(0.2)} 72% 42%)`, "Poor")}${row("#b3372d", "Rejected")}${row("#8a958f", "Not rated")}<div><span class="dia"></span>Privately managed</div><div style="color:var(--muted)">Gold ring = top pick</div>`;
}
function setView(v, { refit } = {}) {
  const was = view; view = v; store.set("vet-view", v);
  $("cityTab").setAttribute("aria-selected", String(v === "city")); $("parkTab").setAttribute("aria-selected", String(v === "park"));
  $("card").classList.toggle("city", v === "city");
  $("info").hidden = v === "city"; $("cityInfo").hidden = v !== "city"; $("legend").hidden = v !== "city";
  $("actions").style.visibility = v === "city" ? "hidden" : "";
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

// ── Render ───────────────────────────────────────────────────────────────────
function renderTags(p) {
  const t = tagsFor(p);
  $("segQuality").innerHTML = [1, 2, 3, 4, 5].map(n => `<button data-tag="quality" data-val="${n}" aria-pressed="${t.quality === n}" title="${n}/5">${n <= t.quality ? "★" : "☆"}</button>`).join("");
  $("segFit").innerHTML = FIT_OPTS.map(([v, l]) => `<button data-tag="fit" data-val="${v}" aria-pressed="${t.fit === v}">${l}</button>`).join("");
  const lit = t.lights === "full" || t.lights === "training";
  $("segLights").innerHTML = LIGHT_OPTS.map(([v, l]) => `<button data-tag="lights" data-val="${v}" aria-pressed="${v === "full" ? lit : t.lights === v}">${v === "full" && t.lights === "training" ? "Yes (training)" : l}</button>`).join("")
    + `<span class="note">${t.lightPts.length ? `💡 ${t.lightPts.length} pole${t.lightPts.length > 1 ? "s" : ""} marked` : "click the map to mark poles"}</span>`;
  if (document.activeElement !== $("fieldsIn")) $("fieldsIn").value = t.fields;
  if (document.activeElement !== $("notesIn")) $("notesIn").value = t.notes;
  renderCentre();
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
function render() {
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
    const pv = PRIV_BY_PARK[p.id];
    $("privBox").hidden = !pv?.length; $("privBox").innerHTML = pv?.length ? privBanner(pv) : "";
    const r = reviews[p.id];
    $("decChip").innerHTML = (pv?.length ? `<span class="chip priv" title="Ask ${esc(pv[0].operator)} before applying to council">◆ ${esc(pv[0].short)}</span> ` : "") + (r ? `<span class="chip ${r.decision === "no" ? "no" : r.decision === "top" ? "top" : ""}">${r.decision === "top" ? "Top pick" : r.decision === "yes" ? "Shortlisted" : "Rejected"}${r.by ? " · " + esc(r.by.split("@")[0]) : ""}</span>` : "");
    const i = Math.min(mapIdx[p.id] || 0, Math.max(0, p.maps.length - 1));
    $("thumbs").innerHTML = p.maps.length > 1 ? p.maps.map((m, k) => `<button data-map="${k}" aria-pressed="${k === i}" title="${esc(m.title)}">${m.season === "winter" ? "❄ Winter" : "☀ Summer"}${/area/i.test(m.title) ? " area" : ""}</button>`).join("") : "";
    const cf = councilFields(p).map(f => f.n).filter(Boolean);
    $("fieldList").textContent = cf.length ? "Council fields: " + [...new Set(cf)].join(" · ") : p.fields.length ? "Council fields: " + p.fields.join(" · ") : (p.maps.length ? "" : "No council map for this park (often a school or stadium ground). Satellite only.");
    const c = p.lat ? `${p.lat},${p.lon}` : encodeURIComponent(p.name + " Auckland");
    $("gmaps").href = p.lat ? `https://www.google.com/maps/@${c},250m/data=!3m1!1e3` : `https://www.google.com/maps/search/${c}`;
    const fresh = shownPark !== p.id + "#" + i;
    if (fresh) showMap(p);
    renderTags(p);
    // Restore a saved field placement for a reviewed park.
    if (fresh && r?.placement?.lat != null && !tagsFor(p)._placed) { angle = r.placement.angle || 0; map.setView([r.placement.lat, r.placement.lon], map.getZoom(), { animate: false }); tagsFor(p)._placed = true; sizeField(); }
  }
  ["noBtn", "yesBtn", "topBtn", "skipBtn"].forEach(b => $(b).disabled = !p);
  $("undoBtn").disabled = !undoStack.length;
  renderRail();
}

// ── Decisions ────────────────────────────────────────────────────────────────
function askPlacement(p, t, decision) {
  const dlg = $("saveDlg"), sp = t.spot, moved = spotMoved(t);
  $("dlgTitle").textContent = `${decision === "top" ? "Top pick" : decision === "yes" ? "Shortlist" : "Reject"} ${p.name} — save the field spot?`;
  $("dlgBody").textContent = `Field centred at ${sp.lat.toFixed(5)}, ${sp.lon.toFixed(5)}, turned ${((sp.angle % 360) + 360) % 360}°`
    + ` · fits ${FIT_LABEL[t.fit]}${t.fields.trim() ? ` · on ${t.fields.trim()}` : ""}`
    + ` · ${t.lightPts.length ? t.lightPts.length + " light pole" + (t.lightPts.length > 1 ? "s" : "") : "lights " + t.lights}.`
    + (moved ? " You've moved the field since rating the fit; this saves the spot you rated, not the current view." : "")
    + " Saving it restores this spot next time and plots the park there on the Auckland map.";
  return new Promise(res => {
    dlg.returnValue = "";
    dlg.addEventListener("close", () => res(dlg.returnValue || "cancel"), { once: true });
    dlg.showModal();
  });
}
async function decide(decision) {
  const p = current(); if (!p || busy || view === "city") return;
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
  const placement = (pos.lat != null || t.lightPts.length) ? { ...pos, lights: t.lightPts } : null;
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
      else if (k === "fit") { if (d.fit === v) d.fit = "unknown"; else if (fieldOn && view === "park") return confirmSpot(p, v); else d.fit = v; }
      else if (k === "lights") { d.lights = v; if (v === "none" && d.lightPts.length) { d.lightPts = []; drawLights(p); } }
      renderTags(p); }
  });
  $("fieldsIn").addEventListener("input", () => { const p = current(); if (p) { const t = tagsFor(p); t.fields = $("fieldsIn").value; t.fieldsManual = !!t.fields.trim(); drawParkFields(p); } });
  $("notesIn").addEventListener("input", () => { const p = current(); if (p) tagsFor(p).notes = $("notesIn").value; });
  // Swipe on the title bar (the map itself pans and zooms).
  const h = $("handle"), card = $("card"); let sx = 0, sy = 0, dx = 0, dy = 0, drag = false;
  h.addEventListener("pointerdown", e => { if (view === "city") return; drag = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; card.classList.remove("snap", "deal"); h.setPointerCapture(e.pointerId); });
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
  $("map").parentElement.addEventListener("pointermove", e => {
    if (!rotating) return; const r = $("map").getBoundingClientRect();
    const px = e.clientX - (r.left + r.width / 2), py = e.clientY - (r.top + r.height / 2);
    if (Math.hypot(px, py) < 30) return;   // too close to the centre to read a direction
    angle = Math.atan2(py, px) * 180 / Math.PI; sizeField(); });
  $("centreBtn").onclick = e => { e.stopPropagation(); if (rotating) lockField(); else setRotating(true); };
  $("fitPop").addEventListener("click", e => { const b = e.target.closest("[data-fit]"), p = current(); if (!b || !p) return;
    confirmSpot(p, b.dataset.fit); });
  $("fieldBtn").onclick = () => showField(!fieldOn);
  $("layerBtn").onclick = () => { forced = councilVisible() ? "sat" : "council"; updateLayer(); };
  $("fitBtn").onclick = () => { const p = current(); if (p) showMap(p); };
  $("backCity").onclick = () => { focusId = null; setView("city"); };
  $("cityTab").onclick = () => { if (view !== "city") { focusId = null; setView("city"); } else setView("city", { refit: true }); };
  $("parkTab").onclick = () => { if (view !== "park") { focusId = null; setView("park"); } };
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
    if (e.key === "Escape") { if (rotating) setRotating(false); $("sizePanel").hidden = true; $("fitPop").hidden = true; return; }
    if (/^[cC]$/.test(e.key)) { focusId = null; setView(view === "city" ? "park" : "city"); return; }
    if (view === "city") return;
    if (e.key === "ArrowRight") { e.preventDefault(); decide("yes"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); decide("no"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); decide("top"); }
    else if (e.key === "Enter" && fieldOn && !e.target.closest("button")) { e.preventDefault(); $("centreBtn").click(); }
    else if (/^[sS]$/.test(e.key)) skip();
    else if (/^[zZ]$/.test(e.key)) undo();
    else if (/^[tT]$/.test(e.key)) showField(!fieldOn);
    else if (/^[vV]$/.test(e.key)) $("layerBtn").click();
    else if (e.key === "0") $("fitBtn").click();
    else if (/^[rR]$/.test(e.key)) { angle = (angle + 15) % 360; sizeField(); afterMove(); }
    else if (p && /^[1-5]$/.test(e.key)) { tagsFor(p).quality = +e.key; renderTags(p); }
    else if (p && /^[mM]$/.test(e.key) && p.maps.length > 1) { mapIdx[p.id] = ((mapIdx[p.id] || 0) + 1) % p.maps.length; render(); }
  });
}
function exportCsv() {
  const rows = [["Region", "Park", "Decision", "Suitability", "Lights", "Light poles", "Fit", "Quality", "Fields", "Notes", "Field placement (lat, lon, angle°)", "Private operator", "Operator contact", "Reviewer", "Reviewed at"]];
  PARKS.forEach(p => { const r = reviews[p.id]; if (!r) return; const pl = r.placement;
    rows.push([p.region, p.name, r.decision === "top" ? "top pick" : r.decision === "yes" ? "shortlist" : "reject", suitWord(r), r.lights, pl?.lights?.length || 0,
      FIT_LABEL[r.fit] || r.fit, r.quality || "", r.fields, r.notes, pl?.lat != null ? `${pl.lat}, ${pl.lon}, ${pl.angle}` : "",
      PRIV_BY_PARK[p.id]?.[0]?.operator || "",
      [PRIV_BY_PARK[p.id]?.[0]?.contact?.email, PRIV_BY_PARK[p.id]?.[0]?.contact?.phone].filter(Boolean).join(" / "), r.by || "", r.at || ""]); });
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "council-field-vetting.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Start ────────────────────────────────────────────────────────────────────
function gate(html) { $("gate").innerHTML = html; $("gate").hidden = false; $("app").hidden = true; }
async function start() {
  const res = await fetch(BASE + "council-maps/parks.json"); PARKS = (await res.json()).parks; BYID = Object.fromEntries(PARKS.map(p => [p.id, p]));
  try { const pr = await fetch(BASE + "council-maps/private-managed.json"); if (pr.ok) PRIV = await pr.json(); } catch { /* optional data */ }
  PRIV_BY_PARK = {};
  (PRIV.operators || []).filter(o => o.park_id).forEach(o => (PRIV_BY_PARK[o.park_id] ||= []).push(o));
  // Point of contact first: the operator marked primary, else the rugby or football club.
  const rank = o => o.primary ? 0 : ["rugby", "football"].includes(o.code) ? 1 : 2;
  Object.values(PRIV_BY_PARK).forEach(ops => ops.sort((a, b) => rank(a) - rank(b)));
  const regions = [...new Set(PARKS.map(p => p.region))];
  $("region").insertAdjacentHTML("beforeend", regions.map(r => `<option>${esc(r)}</option>`).join(""));
  $("region").value = store.get("vet-region", ""); $("mode").value = store.get("vet-mode", "todo"); $("mapsOnly").checked = store.get("vet-mapsOnly", true);

  if (supabase) {
    const { data } = await supabase.auth.getSession(); session = data.session;
    if (!session) {
      gate(`<h2>Sign in to rate council fields</h2>Use the same Google account as the booking site.<br><button id="signIn">Sign in with Google</button>`);
      $("signIn").onclick = () => supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href } });
      setStatus(""); return;
    }
    if (session.user?.app_metadata?.role !== "admin") { gate(`<h2>Admins only</h2>Council field vetting is limited to AMUA admins. <a href="./">Back to bookings</a>`); setStatus(""); return; }
    await loadShared();
  } else {
    reviews = store.get("vet-reviews", {});
    setStatus("Demo mode (no Supabase configured): decisions are kept in this browser.", true);
  }
  $("app").hidden = false;
  initMap(); drawField(); showField(fieldOn); renderLegend(); bind();
  setView(view === "park" ? "park" : "city", { refit: true });
  if (mode === "shared") setInterval(async () => { if (!busy && !rotating && document.visibilityState === "visible" && !$("saveDlg").open) { await loadShared(); if (view === "city") render(); else renderRail(); } }, 30000);
}
start().catch(e => setStatus("Couldn't start: " + (e.message || e), true));
