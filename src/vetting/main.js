// Council field vetting (vetting.html) — admin tool for deciding which Auckland Council
// sports parks are worth applying for. One park card at a time: live Esri satellite with
// the council's field map laid over it at its true position (georeferenced from each map
// page's GeoPDF data), a to-scale ultimate field centred in the frame, review tags, and
// decisions saved to Supabase (field_reviews, admin-only). See docs/council-field-vetting.md.
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./vetting.css";
import { createClient } from "@supabase/supabase-js";

const BASE = import.meta.env.BASE_URL;
const SB_URL = import.meta.env.VITE_SUPABASE_URL, SB_ANON = import.meta.env.VITE_SUPABASE_ANON;
const supabase = SB_URL && SB_ANON
  ? createClient(SB_URL, SB_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } })
  : null;

const LIGHTS = ["unknown", "none", "training", "full"], FITS = ["unknown", "full", "reduced", "no"];
// WFDF field: 100 × 37 m overall, 18 m end zones, brick marks 20 m in from each goal line.
const WFDF = { len: 100, wid: 37, ez: 18 };
const BRICK = 20;
// How far (in zoom levels) you can zoom from the fitted council map before it drops away
// to reveal the satellite: two to three wheel clicks either way.
const REVEAL_OUT = 1, REVEAL_IN = 1.5;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = { get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
                set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } } };
function setStatus(t, warn) { $("status").textContent = t; $("status").classList.toggle("warn", !!warn); }

let PARKS = [], BYID = {};
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
    if (error) { setStatus("Couldn't save that decision (" + error.message + "). Try again.", true); return false; }
  }
  if (rev) reviews[id] = { ...rev, by: session?.user?.email || rev.by || "" }; else delete reviews[id];
  if (mode === "local") store.set("vet-reviews", reviews);
  return true;
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
function current() { const q = queue(); if (cursor >= q.length) cursor = 0; return q[cursor] || null; }
function tagsFor(p) {
  if (!draft[p.id]) { const r = reviews[p.id] || {};
    draft[p.id] = { lights: r.lights || "unknown", fit: r.fit || "unknown", quality: r.quality || 0, fields: r.fields || "", notes: r.notes || "" }; }
  return draft[p.id];
}

// ── Map: Esri satellite + council overlay that drops away when you zoom off it ─
let map, overlay = null, baseZoom = null, forced = null, shownPark = null;
function initMap() {
  map = L.map("map", { zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 150, maxZoom: 21, zoomControl: true });
  map.zoomControl.setPosition("bottomright");
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: 19, maxZoom: 21,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics · Field maps © Auckland Council",
  }).addTo(map);
  map.on("zoomanim", e => { $("field").classList.add("zooming"); sizeField(e.zoom); });
  map.on("zoomend", () => { $("field").classList.remove("zooming"); forced = null; updateLayer(); sizeField(); });
  map.on("move", () => sizeField());
  map.on("click", () => { if (rotating) setRotating(false); });
}
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
  forced = null; shownPark = p.id + "#" + i; updateLayer(); sizeField();
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

// ── Frisbee field overlay: frame-centred, true scale, click to rotate ─────────
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
    </g>
    <rect class="hit" x="${x0}" y="${y0}" width="${Lm}" height="${Wm}" fill="none" stroke="transparent" stroke-width="14" vector-effect="non-scaling-stroke" style="pointer-events:stroke"><title>Click to turn the field</title></rect>
    <circle class="hit" r="${Math.max(2, Wm * 0.08)}" fill="rgba(21,33,28,.75)" stroke="#ffd400" stroke-width="2" vector-effect="non-scaling-stroke"><title>Click to turn the field</title></circle>`;
  $("fieldSvg").querySelectorAll(".hit").forEach(h => h.addEventListener("click", e => { e.stopPropagation(); setRotating(!rotating); }));
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
  if (on) map.dragging.disable(); else map.dragging.enable();
}
function showField(on) {
  fieldOn = on; store.set("vet-field-on", on);
  $("field").hidden = !on; $("fieldBtn").setAttribute("aria-pressed", String(on));
  if (!on && rotating) setRotating(false);
}

// ── Render ───────────────────────────────────────────────────────────────────
function segButtons(el, key, vals, t, labels) {
  el.innerHTML = vals.map(v => `<button data-tag="${key}" data-val="${v}" aria-pressed="${t[key] === v}">${labels ? labels(v, t) : v}</button>`).join("");
}
function renderTags(p) {
  const t = tagsFor(p);
  segButtons($("segLights"), "lights", LIGHTS, t);
  segButtons($("segFit"), "fit", FITS, t);
  segButtons($("segQuality"), "quality", [1, 2, 3, 4, 5], t, (n, tt) => (n <= tt.quality ? "★" : "☆"));
  $("fieldsIn").value = t.fields; $("notesIn").value = t.notes;
  const lit = t.lights === "training" || t.lights === "full";
  $("lightsBtn").textContent = "💡 Lights: " + t.lights; $("lightsBtn").classList.toggle("lit", lit);
}
function render() {
  const q = queue(), p = current(), next = q[cursor + 1] || (q.length > 1 ? q[0] : null);
  const card = $("card");
  $("emptyState").hidden = !!p; card.hidden = !p; $("behind").hidden = !p || !next || next.id === p?.id || !next.maps.length;
  if (!p) {
    const m = $("mode").value;
    $("emptyState").innerHTML = `<h2>${m === "todo" ? "All caught up" : "Nothing here yet"}</h2>${m === "todo" ? "Every park in this view has a decision. Switch the queue to look back over shortlisted or rejected parks." : "Parks you decide on will appear here."}`;
  } else {
    if (next?.maps.length) $("behindImg").src = BASE + "council-maps/" + next.maps[0].file;
    $("parkName").textContent = p.name; $("parkRegion").textContent = p.region;
    const r = reviews[p.id];
    $("decChip").innerHTML = r ? `<span class="chip ${r.decision === "no" ? "no" : r.decision === "top" ? "top" : ""}">${r.decision === "top" ? "Top pick" : r.decision === "yes" ? "Shortlisted" : "Rejected"}${r.by ? " · " + esc(r.by.split("@")[0]) : ""}</span>` : "";
    const i = Math.min(mapIdx[p.id] || 0, Math.max(0, p.maps.length - 1));
    $("thumbs").innerHTML = p.maps.length > 1 ? p.maps.map((m, k) => `<button data-map="${k}" aria-pressed="${k === i}" title="${esc(m.title)}"><img src="${BASE}council-maps/${m.file}" alt="" loading="lazy"><span>${m.season}${/area/i.test(m.title) ? " · area" : ""}</span></button>`).join("") : "";
    $("fieldList").textContent = p.fields.length ? "Council fields: " + p.fields.join(" · ") : (p.maps.length ? "" : "No council map for this park (often a school or stadium ground). Satellite only.");
    const c = p.lat ? `${p.lat},${p.lon}` : encodeURIComponent(p.name + " Auckland");
    $("gmaps").href = p.lat ? `https://www.google.com/maps/@${c},250m/data=!3m1!1e3` : `https://www.google.com/maps/search/${c}`;
    renderTags(p);
    if (shownPark !== p.id + "#" + i) showMap(p);
    // Restore a saved field placement for a reviewed park.
    if (r?.placement && !draft[p.id]?._placed) { angle = r.placement.angle || 0; map.setView([r.placement.lat, r.placement.lon], map.getZoom(), { animate: false }); draft[p.id]._placed = true; sizeField(); }
  }
  ["noBtn", "yesBtn", "topBtn", "skipBtn"].forEach(b => $(b).disabled = !p);
  $("undoBtn").disabled = !undoStack.length;
  const reg = $("region").value, mapsOnly = $("mapsOnly").checked;
  const scope = PARKS.filter(x => (!reg || x.region === reg) && (!mapsOnly || x.maps.length));
  const done = scope.filter(x => reviews[x.id]).length;
  $("progress").textContent = `${done} / ${scope.length} reviewed`;
  $("barFill").style.width = scope.length ? (100 * done / scope.length) + "%" : "0";
  const all = Object.entries(reviews).filter(([id]) => BYID[id]);
  $("nTop").textContent = all.filter(([, r]) => r.decision === "top").length;
  $("nYes").textContent = all.filter(([, r]) => r.decision === "yes").length;
  $("nNo").textContent = all.filter(([, r]) => r.decision === "no").length;
  const picks = all.filter(([, r]) => r.decision !== "no")
    .sort((a, b) => (a[1].decision === "top" ? 0 : 1) - (b[1].decision === "top" ? 0 : 1) || BYID[a[0]].name.localeCompare(BYID[b[0]].name));
  $("list").innerHTML = picks.length ? picks.map(([id, r]) => { const pp = BYID[id], m = pp.maps[0];
    return `<button data-open="${id}">${m ? `<img src="${BASE}council-maps/${m.file}" alt="" loading="lazy">` : `<span class="ph"></span>`}<span style="min-width:0"><span class="n">${r.decision === "top" ? "★ " : ""}${esc(pp.name)}</span><span class="m">${esc(pp.region)} · lights ${esc(r.lights)} · fit ${esc(r.fit)}${r.quality ? " · " + r.quality + "/5" : ""}</span></span></button>`; }).join("")
    : `<p class="help">Shortlisted and top-pick parks collect here.</p>`;
}

// ── Decisions ────────────────────────────────────────────────────────────────
async function decide(decision) {
  const p = current(); if (!p || busy) return;
  busy = true;
  const card = $("card"); card.classList.remove("snap", "deal"); card.classList.add("fly");
  const x = decision === "yes" ? 800 : decision === "no" ? -800 : 0, y = decision === "top" ? -600 : 40;
  card.style.transform = `translate(${x}px, ${y}px) rotate(${x / 25}deg)`; card.style.opacity = "0";
  const t = tagsFor(p), c = map.getCenter();
  const rev = { decision, lights: t.lights, fit: t.fit, quality: t.quality || null, fields: t.fields.trim(), notes: t.notes.trim(),
    placement: fieldOn ? { lat: +c.lat.toFixed(6), lon: +c.lng.toFixed(6), angle: Math.round(angle), ...dims } : null };
  const prev = reviews[p.id] ? { ...reviews[p.id] } : null;
  await new Promise(r => setTimeout(r, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 220));
  const ok = await save(p.id, rev);
  if (ok) { undoStack.push({ id: p.id, prev }); delete draft[p.id]; later.delete(p.id); if ($("mode").value !== "todo") cursor++; }
  card.classList.remove("fly"); card.style.transform = ""; card.style.opacity = "";
  void card.offsetWidth; card.classList.add("deal");
  if (rotating) setRotating(false);
  busy = false; render();
}
function skip() { const p = current(); if (!p) return; later.add(p.id); cursor = $("mode").value === "todo" ? 0 : cursor + 1; render(); }
async function undo() {
  const last = undoStack.pop(); if (!last) return render();
  if (await save(last.id, last.prev)) { delete draft[last.id]; const i = queue().findIndex(p => p.id === last.id); if (i >= 0) cursor = i;
    setStatus("Undid the decision on " + BYID[last.id].name + "."); }
  render();
}

// ── Events ───────────────────────────────────────────────────────────────────
function bind() {
  $("card").addEventListener("click", e => {
    const t = e.target.closest("[data-tag]"), mp = e.target.closest("[data-map]"), p = current(); if (!p) return;
    if (mp) { mapIdx[p.id] = +mp.dataset.map; render(); return; }
    if (t && t.tagName === "BUTTON") { const d = tagsFor(p), v = t.dataset.tag === "quality" ? +t.dataset.val : t.dataset.val;
      d[t.dataset.tag] = (t.dataset.tag === "quality" && d.quality === v) ? 0 : v; renderTags(p); }
  });
  $("fieldsIn").addEventListener("input", () => { const p = current(); if (p) tagsFor(p).fields = $("fieldsIn").value; });
  $("notesIn").addEventListener("input", () => { const p = current(); if (p) tagsFor(p).notes = $("notesIn").value; });
  // Swipe on the title bar (the map itself pans and zooms).
  const h = $("handle"), card = $("card"); let sx = 0, sy = 0, dx = 0, dy = 0, drag = false;
  h.addEventListener("pointerdown", e => { drag = true; sx = e.clientX; sy = e.clientY; dx = dy = 0; card.classList.remove("snap", "deal"); h.setPointerCapture(e.pointerId); });
  h.addEventListener("pointermove", e => { if (!drag) return; dx = e.clientX - sx; dy = e.clientY - sy;
    card.style.transform = `translate(${dx}px, ${Math.min(dy, 30)}px) rotate(${dx / 25}deg)`;
    const up = -dy > 70 && Math.abs(dx) < 90;
    $("stYes").style.opacity = !up && dx > 0 ? Math.min(1, dx / 110) : 0;
    $("stNo").style.opacity = !up && dx < 0 ? Math.min(1, -dx / 110) : 0;
    $("stTop").style.opacity = up ? Math.min(1, -dy / 110) : 0; });
  const end = () => { if (!drag) return; drag = false; ["stYes", "stNo", "stTop"].forEach(s => $(s).style.opacity = 0);
    if (-dy > 100 && Math.abs(dx) < 90) decide("top"); else if (dx > 110) decide("yes"); else if (dx < -110) decide("no");
    else { card.classList.add("snap"); card.style.transform = ""; } };
  h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
  // Field rotation follows the pointer while unfrozen.
  $("map").parentElement.addEventListener("pointermove", e => {
    if (!rotating) return; const r = $("map").getBoundingClientRect();
    angle = Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; sizeField(); });
  $("fieldBtn").onclick = () => showField(!fieldOn);
  $("lightsBtn").onclick = () => { const p = current(); if (!p) return; const d = tagsFor(p); d.lights = LIGHTS[(LIGHTS.indexOf(d.lights) + 1) % LIGHTS.length]; renderTags(p); };
  $("layerBtn").onclick = () => { forced = councilVisible() ? "sat" : "council"; updateLayer(); };
  $("fitBtn").onclick = () => { const p = current(); if (p) showMap(p); };
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
    cursor = 0; store.set("vet-" + id, id === "mapsOnly" ? $(id).checked : $(id).value); render(); }));
  $("list").addEventListener("click", e => { const b = e.target.closest("[data-open]"); if (!b) return;
    $("mode").value = "all"; $("region").value = ""; cursor = Math.max(0, queue().findIndex(p => p.id === b.dataset.open)); render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
  $("exportBtn").onclick = exportCsv;
  window.addEventListener("focus", async () => { if (mode === "shared") { await loadShared(); render(); } });
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea, select")) return;
    const p = current();
    if (e.key === "Escape") { if (rotating) setRotating(false); $("sizePanel").hidden = true; return; }
    if (e.key === "ArrowRight") { e.preventDefault(); decide("yes"); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); decide("no"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); decide("top"); }
    else if (/^[sS]$/.test(e.key)) skip();
    else if (/^[zZ]$/.test(e.key)) undo();
    else if (/^[tT]$/.test(e.key)) showField(!fieldOn);
    else if (/^[vV]$/.test(e.key)) $("layerBtn").click();
    else if (e.key === "0") $("fitBtn").click();
    else if (/^[rR]$/.test(e.key)) { angle = (angle + 15) % 360; sizeField(); }
    else if (p && /^[1-5]$/.test(e.key)) { tagsFor(p).quality = +e.key; renderTags(p); }
    else if (p && /^[lL]$/.test(e.key)) $("lightsBtn").click();
    else if (p && /^[fF]$/.test(e.key)) { const d = tagsFor(p); d.fit = FITS[(FITS.indexOf(d.fit) + 1) % FITS.length]; renderTags(p); }
    else if (p && /^[mM]$/.test(e.key) && p.maps.length > 1) { mapIdx[p.id] = ((mapIdx[p.id] || 0) + 1) % p.maps.length; render(); }
  });
}
function exportCsv() {
  const rows = [["Region", "Park", "Decision", "Lights", "Fit", "Quality", "Fields", "Notes", "Field placement (lat, lon, angle°)", "Reviewer", "Reviewed at"]];
  PARKS.forEach(p => { const r = reviews[p.id]; if (!r) return;
    rows.push([p.region, p.name, r.decision === "top" ? "top pick" : r.decision === "yes" ? "shortlist" : "reject", r.lights, r.fit, r.quality || "",
      r.fields, r.notes, r.placement ? `${r.placement.lat}, ${r.placement.lon}, ${r.placement.angle}` : "", r.by || "", r.at || ""]); });
  const csv = rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(",")).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = "council-field-vetting.csv"; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Start ────────────────────────────────────────────────────────────────────
function gate(html) { $("gate").innerHTML = html; $("gate").hidden = false; $("app").hidden = true; }
async function start() {
  const res = await fetch(BASE + "council-maps/parks.json"); PARKS = (await res.json()).parks; BYID = Object.fromEntries(PARKS.map(p => [p.id, p]));
  const regions = [...new Set(PARKS.map(p => p.region))];
  $("region").insertAdjacentHTML("beforeend", regions.map(r => `<option>${esc(r)}</option>`).join(""));
  $("region").value = store.get("vet-region", ""); $("mode").value = store.get("vet-mode", "todo"); $("mapsOnly").checked = store.get("vet-mapsOnly", true);

  if (supabase) {
    const { data } = await supabase.auth.getSession(); session = data.session;
    if (!session) {
      gate(`<h2>Sign in to vet fields</h2>Use the same Google account as the booking site.<br><button id="signIn">Sign in with Google</button>`);
      $("signIn").onclick = () => supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href } });
      setStatus(""); return;
    }
    if (session.user?.app_metadata?.role !== "admin") { gate(`<h2>Admins only</h2>Field vetting is limited to AMUA admins. <a href="./">Back to bookings</a>`); setStatus(""); return; }
    await loadShared();
  } else {
    reviews = store.get("vet-reviews", {});
    setStatus("Demo mode (no Supabase configured): decisions are kept in this browser.", true);
  }
  $("app").hidden = false;
  initMap(); drawField(); showField(fieldOn); bind(); render();
  if (mode === "shared") setInterval(async () => { if (!busy && document.visibilityState === "visible") { await loadShared(); render(); } }, 30000);
}
start().catch(e => setStatus("Couldn't start: " + (e.message || e), true));
