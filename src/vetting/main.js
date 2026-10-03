// Council / Community fields (vetting.html) — admin tool for rating Auckland Council sports parks for
// ultimate. Two views on one Leaflet map:
//  · Auckland: every park plotted and coloured by its overall suitability rating; click one
//    to open it. This is how you move around between parks.
//  · Park: one park card at a time — live Esri satellite with the council field map laid over
//    it at its true position (georeferenced from each map page's GeoPDF data), a to-scale
//    ultimate field centred in the frame, light poles placed by clicking the map, and
//    decisions saved to Supabase (field_reviews, admin-only). See docs/council-field-vetting.md.
import L from "leaflet";
import "../theme.css";
import "leaflet/dist/leaflet.css";
import "./vetting.css";
import { createClient } from "@supabase/supabase-js";
import { councilState, fmtRange, fmtDay, COUNCIL_LINKS, COUNCIL_CONTACTS } from "../councilSeasons.js";
import { askActor, getActor, clearActor } from "../actor.js";
import { shortName, personFromEmail } from "../people.js";
import { renderAppNav } from "../appnav.js";

const BASE = import.meta.env.BASE_URL;
renderAppNav(document.getElementById("appNav"), "fields", BASE);
const SB_URL = import.meta.env.VITE_SUPABASE_URL, SB_ANON = import.meta.env.VITE_SUPABASE_ANON;
const supabase = SB_URL && SB_ANON
  ? createClient(SB_URL, SB_ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" } })
  : null;

// Lights come from bulbs dropped on the map's poles; "No lights" records that you checked and there aren't any.
// Fit: how much ultimate the space holds.
// Metres per degree on Leaflet's sphere (radius 6378137 m), the same scale the live field
// is drawn at, so saved fields, outlines and lights land exactly where they were locked.
const M_PER_DEG = 6378137 * Math.PI / 180;
// Saved coordinates keep 8 decimals (about 1 mm) and angles 0.01°.
const fx = v => +(+v).toFixed(8), fa = v => +(+v).toFixed(2);
// Fit ratings: "no" = unusable (rejected, never bookable), "reduced" = 3v3 only.
const FIT_LABEL = { unknown: "not rated", reduced: "3v3 only", full: "1 × full 7v7", multi: "2 × full 7v7", no: "unusable (reject)" };
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
let interests = { regions: [], council: true, priv: true, lit: true, dark: true, ...store.get("vet-interests", {}) };
const interestOk = p => (!interests.regions.length || interests.regions.includes(p.region))
  && (privOps(p).length ? interests.priv : interests.council)
  && (reviews[p.id]?.lights === "none" ? interests.dark : interests.lit);
const interestsSet = () => interests.regions.length > 0 || !interests.council || !interests.priv || !interests.lit || !interests.dark;
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
const savedDepth = {};                       // undo depth at the last save: edits since then are unsaved

// ── Data ─────────────────────────────────────────────────────────────────────
function fromRow(r) { return { decision: r.decision, lights: r.lights, fit: r.fit, quality: r.quality, fields: r.fields || "", notes: r.notes || "",
  placement: r.placement || null, by: r.reviewer_email || "", at: r.updated_at }; }
async function loadShared() {
  const { data, error } = await supabase.from("field_reviews").select("*");
  if (error) {
    mode = "local"; reviews = store.get("vet-reviews", {}); flags = store.get("vet-flags", {});
    const missing = /field_reviews|does not exist|schema cache/i.test(error.message || "");
    setStatus(missing ? "The field_reviews table isn't set up yet (run supabase-setup.sql). Decisions are kept in this browser for now."
                      : "Couldn't load shared decisions (" + error.message + "). Decisions are kept in this browser for now.", true);
    return;
  }
  mode = "shared"; reviews = Object.fromEntries(data.map(r => [r.park_id, fromRow(r)]));
  setStatus(`Shared · ${data.length} decisions`);
  await loadFlags();
}
// Crowd-sourced quality: everyone signed in gives a park 1–5 stars (table field_ratings,
// one per person); the stars show the average. Until the table exists, this browser's own
// ratings are kept locally. ratings: { park_id: { sum, n, mine } }.
let ratings = {}, ratingsShared = false;
async function loadRatings() {
  if (supabase && session) {
    const { data, error } = await supabase.from("field_ratings").select("park_id,stars,user_id");
    if (!error) {
      ratingsShared = true; ratings = {};
      data.forEach(r => { const e = ratings[r.park_id] ||= { sum: 0, n: 0, mine: 0 }; e.sum += r.stars; e.n++; if (r.user_id === session.user.id) e.mine = r.stars; });
      return;
    }
  }
  ratingsShared = false; ratings = {};
  Object.entries(store.get("vet-ratings", {})).forEach(([id, v]) => { ratings[id] = { sum: v, n: 1, mine: v }; });
}
async function setRating(id, stars) {
  const e = ratings[id] ||= { sum: 0, n: 0, mine: 0 }, before = { ...e };
  if ((e.mine || 0) === (stars || 0)) return true;
  if (e.mine) { e.sum -= e.mine; e.n--; }
  if (stars) { e.sum += stars; e.n++; }
  e.mine = stars;
  if (ratingsShared) {
    const q = stars ? supabase.from("field_ratings").upsert({ park_id: id, user_id: session.user.id, user_email: session.user.email, stars, updated_at: new Date().toISOString() })
      : supabase.from("field_ratings").delete().eq("park_id", id).eq("user_id", session.user.id);
    const { error } = await q;
    if (error) { Object.assign(e, before); setStatus("Couldn't save your rating (" + error.message + ").", true); return false; }
  } else {
    const mine = store.get("vet-ratings", {}); if (stars) mine[id] = stars; else delete mine[id]; store.set("vet-ratings", mine);
  }
  logChange("rating", id, before.mine ? { stars: before.mine } : null, stars ? { stars } : null);
  return true;
}
const crowdAvg = id => ratings[id]?.n ? ratings[id].sum / ratings[id].n : null;
// Club-run flags live in their own table (field_flags) so a park can be flagged without a
// decision. Until that table exists they're kept in this browser.
async function loadFlags() {
  if (mode === "shared") {
    const { data, error } = await supabase.from("field_flags").select("*");
    if (!error) { flagsShared = true; flags = Object.fromEntries(data.map(r => [r.park_id, { club: r.club || "", kind: r.kind || "private", contact: r.contact || "",
      website: r.website || "", details: r.details || "",
      by: r.flagged_by_email || "", at: r.updated_at }])); return; }
  }
  flagsShared = false; flags = store.get("vet-flags", {});
}
async function saveFlag(id, flag) {
  const prev = snapOf(flags[id]);
  if (flagsShared) {
    const row = flag && { park_id: id, club: flag.club || "", kind: flag.kind || "private", contact: flag.contact || "",
      website: flag.website || "", details: flag.details || "",
      flagged_by: session?.user?.id || null, flagged_by_email: session?.user?.email || null, updated_at: new Date().toISOString() };
    let { error } = flag ? await supabase.from("field_flags").upsert(row) : await supabase.from("field_flags").delete().eq("park_id", id);
    // Before the website/details columns exist (supabase-setup.sql v2), save without them.
    if (error && flag && /website|details/i.test(error.message || "")) {
      const { website: _w, details: _d, ...rest } = row; ({ error } = await supabase.from("field_flags").upsert(rest));
      if (!error) setStatus("Saved the vendor; its website and other info need the updated supabase-setup.sql — re-run it.", true);
    }
    // Before the kind/contact columns exist (supabase-setup.sql), keep the provider only.
    if (error && flag && /kind|contact|column/i.test(error.message || "")) {
      const { kind: _kind, contact: _contact, website: _w2, details: _d2, ...old } = row; ({ error } = await supabase.from("field_flags").upsert(old));
      if (!error) setStatus("Saved the vendor; its kind and contact person need supabase-setup.sql.", true);
    }
    if (error) { setStatus("Couldn't save the club flag (" + error.message + ").", true); return false; }
  }
  if (flag) flags[id] = { ...flag, by: session?.user?.email || "", at: new Date().toISOString() }; else delete flags[id];
  if (!flagsShared) store.set("vet-flags", flags);
  logChange("flag", id, prev, snapOf(flags[id]));
  return true;
}
async function save(id, rev) {
  const prev = snapOf(reviews[id]);
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
      setStatus(old || dec ? `Saving ${dec ? "field ratings before a decision" : "\"2 × full 7v7\""} needs supabase-setup.sql — run it in the Supabase SQL editor.`
                    : "Couldn't save that decision (" + error.message + "). Try again.", true);
      return false;
    }
  }
  if (rev) reviews[id] = { ...rev, by: session?.user?.email || rev.by || "", at: new Date().toISOString() }; else delete reviews[id];
  savedDepth[id] = edits[id]?.length || 0;
  if (mode === "local") store.set("vet-reviews", reviews);
  logChange("review", id, prev, snapOf(reviews[id]));
  return true;
}

// ── Vetting history: a global log of vetting changes (profile menu → 📜 Vetting history) ──
// Every saved field rating / decision, provider amendment and quality rating is logged with
// the value it replaced. Entries are accepted by default; an admin can reject one, which
// restores that earlier value (and accept it again, which re-applies the change). Shared
// through the vetting_history table; until it exists, kept in this browser.
const HIST_MAX = 500, HIST_FOLD_MS = 15 * 60000;
let history = [], historyShared = false, replaying = false;
// The saved value without its who/when stamp (those live on the history entry).
const snapOf = v => { if (!v) return null; const { by, at, ...rest } = v; void by; void at; return JSON.parse(JSON.stringify(rest)); };
const sameThing = (a, b) => a.kind === b.kind && a.park_id === b.park_id && (a.kind !== "rating" || a.by_email === b.by_email);
const histTime = h => Date.parse(h.at) || 0;
async function loadHistory() {
  if (supabase && session) {
    const { data, error } = await supabase.from("vetting_history").select("*").order("at", { ascending: false }).limit(HIST_MAX);
    if (!error) { historyShared = true; history = data; return; }
  }
  historyShared = false; history = store.get("vet-history", []);
}
async function logChange(kind, id, before, after) {
  if (replaying || JSON.stringify(before) === JSON.stringify(after)) return;
  const me = session?.user?.email || "demo@local", who = getActor(me), now = new Date().toISOString();
  // Quick successive saves of the same park by the same person fold into one entry.
  const last = history.find(h => sameThing(h, { kind, park_id: id, by_email: me }));
  if (last && last.by_email === me && (last.by_name || "") === who && last.status === "accepted" && Date.now() - histTime(last) < HIST_FOLD_MS) {
    last.after = after; last.at = now;
    if (historyShared) await supabase.from("vetting_history").update({ after, at: now }).eq("id", last.id);
  } else {
    const row = { park_id: id, park: BYID[id]?.name || id, kind, before, after, by_email: me, ...(who ? { by_name: who } : {}), at: now, status: "accepted" };
    if (historyShared) {
      let { data, error } = await supabase.from("vetting_history").insert({ ...row, by_id: session.user.id }).select().single();
      // Before the by_name column exists, log without the person's name.
      if (error && row.by_name && /by_name/i.test(error.message || "")) { const { by_name, ...rest } = row; void by_name; ({ data, error } = await supabase.from("vetting_history").insert({ ...rest, by_id: session.user.id }).select().single()); }
      if (error || !data) return;
      history.unshift(data);
    } else history.unshift({ ...row, id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
  }
  history.sort((a, b) => histTime(b) - histTime(a));
  if (history.length > HIST_MAX) history.length = HIST_MAX;
  if (!historyShared) store.set("vet-history", history);
  if ($("histDlg")?.open) renderHistory();
}
// Put a logged value back: a review or provider through the normal saves (not logged again),
// someone's quality stars directly (admins may write any rating).
async function applyValue(h, v) {
  replaying = true;
  try {
    if (h.kind === "review") { delete draft[h.park_id]; delete edits[h.park_id]; return await save(h.park_id, v ? JSON.parse(JSON.stringify(v)) : null); }
    if (h.kind === "flag") return await saveFlag(h.park_id, v ? { ...v } : null);
    if (h.by_email === (session?.user?.email || "demo@local")) { await setRating(h.park_id, v?.stars || 0); return true; }
    if (!ratingsShared || !h.by_id) { setStatus("That rating was made on another device and can only be changed there.", true); return false; }
    const { error } = v?.stars
      ? await supabase.from("field_ratings").upsert({ park_id: h.park_id, user_id: h.by_id, user_email: h.by_email, stars: v.stars, updated_at: new Date().toISOString() })
      : await supabase.from("field_ratings").delete().eq("park_id", h.park_id).eq("user_id", h.by_id);
    if (error) { setStatus("Couldn't change that rating (" + error.message + ").", true); return false; }
    await loadRatings(); return true;
  } finally { replaying = false; }
}
// Reject: restore the value before this change. Later accepted changes to the same thing were
// made on top of it, so they're rejected with it. Accept again: re-apply this change.
async function setHistoryStatus(h, status) {
  if (!IS_ADMIN || h.status === status) return;
  const after = history.filter(x => x !== h && sameThing(x, h) && histTime(x) > histTime(h) && x.status === "accepted");
  if (status === "rejected" && after.length
    && !confirm(`${after.length} later change${after.length > 1 ? "s" : ""} to ${h.park} ${after.length > 1 ? "were" : "was"} made on top of this one and will be rejected too.`)) return;
  // Accepting an older change again doesn't override a newer accepted one: only its status flips.
  const apply = status === "rejected" || !after.length;
  if (apply && !(await applyValue(h, status === "rejected" ? h.before : h.after))) return;
  const me = session?.user?.email || "demo@local", meName = getActor(me), now = new Date().toISOString();
  for (const x of status === "rejected" ? [h, ...after] : [h]) {
    if (historyShared) {
      const { error } = await supabase.from("vetting_history").update({ status, status_by_email: meName ? `${meName} (${me})` : me, status_at: now }).eq("id", x.id);
      if (error) { setStatus("Couldn't update the history (" + error.message + ").", true); break; }
    }
    Object.assign(x, { status, status_by_email: meName ? `${meName} (${me})` : me, status_at: now });
  }
  if (!historyShared) store.set("vet-history", history);
  renderHistory();
  const p = BYID[h.park_id];
  if (p && view === "park" && current()?.id === p.id) render(); else renderRail();
  setStatus(`${status === "rejected" ? "Rejected" : "Accepted"} the ${HIST_KIND[h.kind].toLowerCase()} change to ${h.park}.`);
}
const HIST_KIND = { review: "Fields", flag: "Vendor", rating: "Quality" };
// Who, as a first name and last initial: the name picked at sign-in, else from the email
// ("rory.hughes@…" → "Rory H.").
const personOf = (email, name) => name ? shortName(name) : personFromEmail(email);
const DEC_WORD = { top: "Top pick", yes: "Shortlist", no: "Reject", rating: "Rating in progress" };
const FIT_WORD = { reduced: "3v3 only", full: "1 × full 7v7", multi: "2 × full 7v7", no: "unusable" };
function histValue(kind, v) {
  if (!v) return kind === "review" ? "not rated" : kind === "flag" ? "no vendor" : "no stars";
  if (kind === "rating") return "★".repeat(v.stars) + "☆".repeat(5 - v.stars);
  if (kind === "flag") return [v.club || "provider", v.contact && `contact ${shortName(v.contact)}`].filter(Boolean).join(", ");
  const fields = Object.values(v.placement?.fields || {});
  return [DEC_WORD[v.decision] || v.decision, fields.length ? `${fields.length} field${fields.length > 1 ? "s" : ""}${fields.some(f => f.fit) ? " (" + fields.map(f => FIT_WORD[f.fit] || "?").join(", ") + ")" : ""}` : FIT_WORD[v.fit],
    v.lights && v.lights !== "unknown" ? (v.lights === "none" ? "no lights" : "lights") : "", v.quality && "★" + v.quality].filter(Boolean).join(" · ");
}
const fmtWhen = iso => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("en-NZ", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }); };
let histFilter = "all";
function renderHistory() {
  const me = session?.user?.email || "demo@local";
  const meName = getActor(me);
  const rows = history.filter(h => histFilter === "all" || (histFilter === "mine" ? h.by_email === me && (!meName || !h.by_name || h.by_name === meName) : h.status === "rejected"));
  $("histNote").textContent = historyShared ? `Everyone's vetting changes, newest first${IS_ADMIN ? ". Changes are accepted unless you reject them; rejecting restores what was there before." : "."}`
    : "Kept in this browser until the vetting_history table is set up (supabase-setup.sql).";
  $("histFilters").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.f === histFilter)));
  $("histList").innerHTML = rows.length ? rows.map(h => `<li class="hist-row ${h.status}" data-id="${esc(String(h.id))}">
      <div class="hist-top"><button class="hist-park" data-park="${esc(h.park_id)}" title="Open in park view">${esc(h.park)}</button>
        <span class="hist-kind">${HIST_KIND[h.kind] || esc(h.kind)}</span>
        <span class="hist-st ${h.status}" title="${h.status_by_email ? esc(`${h.status === "rejected" ? "Rejected" : "Accepted again"} by ${/^[^@]+ \(/.test(h.status_by_email) ? h.status_by_email.split(" (")[0] : personOf(h.status_by_email)}${h.status_at ? " · " + fmtWhen(h.status_at) : ""}`) : "Accepted by default"}">${h.status === "rejected" ? "✕ Rejected" : "✓ Accepted"}</span></div>
      <div class="hist-chg"><span class="hist-b">${esc(histValue(h.kind, h.before))}</span> → <span class="hist-a">${esc(histValue(h.kind, h.after))}</span></div>
      <div class="hist-meta">${esc(personOf(h.by_email, h.by_name))}${h.by_name ? ` <span class="hist-acct">(${esc(h.by_email.split("@")[0])})</span>` : ""} · ${esc(fmtWhen(h.at))}
        ${IS_ADMIN ? `<button class="hist-act" data-act="${h.status === "rejected" ? "accepted" : "rejected"}">${h.status === "rejected" ? "↺ Accept again" : "✕ Reject"}</button>` : ""}</div></li>`).join("")
    : `<li class="hist-empty">${histFilter === "all" ? "No vetting changes yet." : "Nothing here."}</li>`;
}
async function openHistory() {
  await loadHistory(); renderHistory();
  const dlg = $("histDlg");
  if (!dlg.dataset.bound) {
    dlg.dataset.bound = "1";
    $("histFilters").onclick = e => { const b = e.target.closest("button[data-f]"); if (b) { histFilter = b.dataset.f; renderHistory(); } };
    $("histList").onclick = async e => {
      const act = e.target.closest(".hist-act"), park = e.target.closest(".hist-park");
      if (act) { const h = history.find(x => String(x.id) === act.closest(".hist-row").dataset.id); act.disabled = true; if (h) await setHistoryStatus(h, act.dataset.act); act.disabled = false; }
      else if (park && BYID[park.dataset.park]) { dlg.close(); openPark(park.dataset.park); }
    };
  }
  dlg.showModal();
}

// Overall suitability, 0 (rejected) … 1 (ideal); null when not rated yet.
function suitScore(r) {
  if (!r || r.decision === "rating") return null;
  if (r.decision === "no") return 0;
  let s = r.quality ? r.quality / 5 : 0.5;
  s += { multi: 0.2, full: 0.1, reduced: -0.15, no: -0.3 }[r.fit] || 0;
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

// Interests open inline in the map toolbar as toggle buttons: pressed = served. Every area
// and both providers start pressed (no filter).
const allRegions = () => [...new Set(PARKS.map(p => p.region))].sort();
function renderInterests() {
  const inc = interests.regions.length ? interests.regions : allRegions();
  const btn = (k, v, label, on, title) => `<button data-int="${k}"${v ? ` data-val="${esc(v)}"` : ""} aria-pressed="${on}" title="${title}">${label}</button>`;
  $("interestRow").innerHTML = allRegions().map(r => btn("region", r, esc(r), inc.includes(r), `${esc(r)} parks`)).join("")
    + `<i class="sep"></i>` + btn("council", "", "🏛 Council", interests.council, "Council-run parks") + btn("priv", "", "◆ Private", interests.priv, "Privately operated parks")
    + `<i class="sep"></i>` + btn("lit", "", "💡 Lights / ?", interests.lit, "Parks with lights, or not known yet") + btn("dark", "", "🚫 No lights", interests.dark, "Parks known to have no lights")
    + (interestsSet() ? `<button data-int="reset" title="Serve every park again">↺ All</button>` : "");
  $("interestBtn").setAttribute("aria-pressed", String(interestsSet()));
}
// Change some entries of a shared settings value: settings_merge() (supabase-setup.sql) does it
// atomically, so two admins saving different entries can't overwrite each other. Until that
// function exists, falls back to read-modify-write. Returns { value } or { error }.
async function mergeSetting(key, patch, remove = []) {
  const { data, error } = await supabase.rpc("settings_merge", { setting_key: key, patch, remove_keys: remove });
  if (!error && data && typeof data === "object" && !Array.isArray(data)) return { value: data };
  if (error && !/settings_merge|function|schema cache/i.test(error.message || "")) return { error };
  const { data: cur } = await supabase.from("settings").select("value").eq("key", key).maybeSingle();
  const fresh = { ...(cur?.value || {}) }; remove.forEach(k => delete fresh[k]); Object.assign(fresh, patch);
  const r = await supabase.from("settings").upsert({ key, value: fresh, updated_at: new Date().toISOString() });
  return r.error ? { error: r.error } : { value: fresh };
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
    const { value, error } = await mergeSetting(VIEWS_KEY, { [id]: views[id] });
    if (!error) { views = value; return; }
  }
  store.set("vet-views", views);
}
let servedPark = null;   // the park on screen; its view counts once you move on to another
async function bumpActivity(id, delta) {
  activity[id] = activityOf(id) + delta;
  if (supabase && session && IS_ADMIN) {
    const { value, error } = await mergeSetting(ACTIVITY_KEY, { [id]: activity[id] });
    if (!error) { activity = value; return; }
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
    // Light poles belong to the venue: older saves kept some per field, so merge them in
    // (once, de-duplicated) and drop the per-field copies.
    const seen = new Set();
    d.lightPts = d.lightPts.concat(...Object.values(d.fr).map(x => x.lights || [])).filter(q => { const k = poleKey(q); return !seen.has(k) && seen.add(k); }).map(q => [...q]);
    Object.values(d.fr).forEach(x => { delete x.lights; delete x.lightsAuto; });
    // Older reviews saved one spot for the park: treat it as a rating of its first field.
    if (!Object.keys(d.fr).length && d.spot && d.fit !== "unknown") {
      const name = (r.fields || "").split(",")[0].trim() || "This spot";
      d.fr[name] = { name, fit: d.fit, lat: d.spot.lat, lon: d.spot.lon, angle: d.spot.angle };
    }
  }
  return draft[p.id];
}
const FIT_RANK = { unknown: 0, no: 0.5, reduced: 1, full: 2, multi: 3 };
// Park-level fit, fields and spot follow from the per-field ratings: the best fit wins.
function syncFromFields(t) {
  const rated = Object.values(t.fr).filter(x => x.fit && x.fit !== "unknown");
  const best = rated.sort((a, b) => FIT_RANK[b.fit] - FIT_RANK[a.fit])[0];
  t.fit = best ? best.fit : "unknown";
  t.spot = best ? { lat: best.lat, lon: best.lon, angle: best.angle } : null;
  if (!t.fieldsManual || !t.fields.trim()) { t.fields = rated.map(x => x.name).join(", "); t.fieldsManual = false; }
  const n = allLights(t).length;
  if (n && t.lights !== "full" && t.lights !== "training") t.lights = "full";
}
// Light poles belong to the venue (t.lightPts), each [lat, lon, dir, owner]: dir is the way
// it shines (compass bearing, degrees; missing = towards the nearest field), owner the field
// that auto-placed it (missing = placed by hand). Fields share whatever poles stand along them.
const poleKey = q => q[0].toFixed(7) + "," + q[1].toFixed(7);
const allLights = t => t.lightPts;
// Poles standing along a field's long sides (within its length plus 6 m, and within 8 m of
// the usual pole line just outside each sideline): the ones lighting that field.
function fieldPoles(t, fr) {
  if (!fr || fr.lat == null) return [];
  const { kx, ky } = metric(fr.lat), th = (fr.angle || 0) * Math.PI / 180, L2 = (fr.len || dims.len) / 2, line = (fr.wid || dims.wid) / 2 + POLE_OFFSET;
  return t.lightPts.filter(([la, lo]) => { const ex = (lo - fr.lon) * kx, sy = (fr.lat - la) * ky;
    const u = ex * Math.cos(th) + sy * Math.sin(th), v = -ex * Math.sin(th) + sy * Math.cos(th);
    return Math.abs(u) <= L2 + 6 && Math.abs(Math.abs(v) - line) <= 8; });
}
// Compass bearing from one [lat, lon] to another, in degrees.
const bearingTo = (a, b) => { const { kx, ky } = metric(a[0]); return (Math.atan2((b[1] - a[1]) * kx, (b[0] - a[0]) * ky) * 180 / Math.PI + 360) % 360; };
// A pole's direction: its own, else towards the nearest placed field's centre.
function poleDir(t, q) {
  if (q[2] != null) return q[2];
  const fs = Object.values(t.fr).filter(x => x.lat != null); if (!fs.length) return 0;
  const near = fs.map(x => ({ x, d: Math.hypot(x.lat - q[0], x.lon - q[1]) })).sort((a, b) => a.d - b.d)[0].x;
  return bearingTo(q, [near.lat, near.lon]);
}
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
  map.on("zoomend", () => { $("field").classList.remove("zooming"); updateLayer(); sizeField(); syncCityFields(); if (whereMark) schedulePinLabel(); });
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
    const b = mapBounds(p, m);
    overlay = L.imageOverlay(BASE + "council-maps/" + m.file, b, { className: "council-overlay", interactive: false }).addTo(map);
    // The plan's base panel opens the plan opaque; once the plan has dissolved it's a dashed outline.
    overlayPanel = L.rectangle(panelBounds(b), { pane: "fieldsPane", className: "council-panel", color: "#ffffff", weight: 1.5,
      opacity: 0, fill: true, fillColor: "#ffffff", fillOpacity: 0, bubblingMouseEvents: false })
      .bindTooltip("Show the council map", { className: "parktip", sticky: true })
      .on("click", () => { if (rotating) return lockField(); openCouncilImage(); }).addTo(map);
    map.fitBounds(b, { animate: false });
    baseZoom = map.getZoom();
    parkView = { c: map.getCenter(), z: map.getZoom() };
  } else {
    map.setView(p.lat ? [p.lat, p.lon] : [-36.87, 174.77], p.lat ? 16.5 : 11, { animate: false });
    baseZoom = null;
    parkView = { c: map.getCenter(), z: map.getZoom() };
  }
  shownPark = p.id + "#" + i; pin = null; tagsFor(p).sel = null; updateLayer(); sizeField(); drawParkFields(p); drawLights(p);
}
// ⤢ alternates: zoom to the park (keeping the placed field), then all of Auckland with the
// park pinned, then back to the park.
// While the map is still at the park's default zoom (as opened), the first press goes
// straight to Auckland.
let aklNext = false, whereMark = null, parkView = null;
// (Zoom only: opening a placed field re-centres on it without zooming.)
const atParkView = () => parkView && Math.abs(map.getZoom() - parkView.z) < 0.01;
// Suburb outlines (public/council-maps/suburbs.json, from LINZ; built by
// scripts/build-suburbs.mjs). Optional: without the file the Auckland view has no outlines.
let suburbs = null, suburbLayer = null;
const SUBURB_CREDIT = 'Suburbs © <a href="https://data.linz.govt.nz/layer/113764" target="_blank" rel="noopener">LINZ</a> (CC BY 4.0)';
async function loadSuburbs() {
  if (suburbs) return suburbs;
  try { const r = await fetch(BASE + "council-maps/suburbs.json", { cache: "no-cache" }); suburbs = r.ok ? (await r.json()).suburbs || [] : []; }
  catch { suburbs = []; }
  return suburbs;
}
const inRings = ([la, lo], rings) => rings.some(r => { let inn = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [yi, xi] = r[i], [yj, xj] = r[j];
    if ((yi > la) !== (yj > la) && lo < (xj - xi) * (la - yi) / (yj - yi) + xi) inn = !inn; }
  return inn; });
// Neighbours: bounding boxes within ~60 m, then any vertex within ~60 m of the other's.
function adjacentSuburbs(home) {
  const pad = 0.0006, hb = home.b, hv = home.p.flat();
  return suburbs.filter(s => s !== home && s.b[0] <= hb[2] + pad && s.b[2] >= hb[0] - pad && s.b[1] <= hb[3] + pad && s.b[3] >= hb[1] - pad
    && s.p.flat().some(([la, lo]) => la >= hb[0] - pad && la <= hb[2] + pad && lo >= hb[1] - pad && lo <= hb[3] + pad
      && hv.some(([a, b]) => Math.abs(a - la) < pad && Math.abs(b - lo) < pad)));
}
// In the Auckland view: the park's suburb highlighted and named, its neighbours outlined and
// named, and the zoom set to take in all of them. Returns the bounds, or null without data.
async function showSuburbs(p, ll) {
  hideSuburbs();
  const all = await loadSuburbs(); if (!all.length || !ll) return null;
  const home = all.find(s => ll[0] >= s.b[0] && ll[0] <= s.b[2] && ll[1] >= s.b[1] && ll[1] <= s.b[3] && inRings(ll, s.p));
  if (!home) return null;
  const near = adjacentSuburbs(home);
  suburbLayer = L.layerGroup().addTo(map);
  map.attributionControl.addAttribution(SUBURB_CREDIT);
  // Names sit at the centroid of the suburb's largest outline (inside it, unlike the bounding
  // box centre for odd shapes); colliding names are pushed apart once drawn (spreadLabels).
  const centroid = s => { const ring = s.p.reduce((a, r) => (r.length > a.length ? r : a), s.p[0]); let A = 0, cy = 0, cx = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const f = ring[j][1] * ring[i][0] - ring[i][1] * ring[j][0]; A += f; cx += (ring[j][1] + ring[i][1]) * f; cy += (ring[j][0] + ring[i][0]) * f; }
    const c = A ? [cy / (3 * A), cx / (3 * A)] : [(s.b[0] + s.b[2]) / 2, (s.b[1] + s.b[3]) / 2];
    return inRings(c, s.p) ? c : [(s.b[0] + s.b[2]) / 2, (s.b[1] + s.b[3]) / 2]; };
  const label = (s, cls) => { L.marker(centroid(s), { interactive: false, keyboard: false,
    icon: L.divIcon({ className: "", html: `<span class="sublbl ${cls}">${esc(s.n)}</span>`, iconSize: null }) }).addTo(suburbLayer); };
  near.forEach(s => { L.polygon(s.p, { pane: "fieldsPane", color: "#e2e8f0", weight: 1.5, dashArray: "5 4", fillOpacity: 0.04, fillColor: "#ffffff", interactive: false }).addTo(suburbLayer); label(s, ""); });
  L.polygon(home.p, { pane: "fieldsPane", color: "#f59e0b", weight: 3, fillColor: "#f59e0b", fillOpacity: 0.16, interactive: false }).addTo(suburbLayer);
  label(home, "home");
  const b = L.latLngBounds([[home.b[0], home.b[1]], [home.b[2], home.b[3]]]);
  near.forEach(s => b.extend([[s.b[0], s.b[1]], [s.b[2], s.b[3]]]));
  return b;
}
function hideSuburbs() { if (suburbLayer) { suburbLayer.remove(); suburbLayer = null; map.attributionControl.removeAttribution(SUBURB_CREDIT); } }
async function zoomToggle(p) {
  const back = !!whereMark;
  if (whereMark) { whereMark.remove(); whereMark = null; }
  document.body.classList.remove("aklzoom");
  hideSuburbs();
  if (!back && (aklNext || atParkView())) {
    // Zoom out to the park's suburb and all its neighbours (with suburb outlines), or
    // Auckland-wide centred on the park when there's no suburb data.
    const ll = parkLatLng(p), z = map.getBoundsZoom(L.latLngBounds(DEFAULT_VIEW));
    const sb = await showSuburbs(p, ll);
    if (sb) map.fitBounds(sb, { padding: [20, 20] });
    else if (ll) map.setView(ll, z); else map.fitBounds(DEFAULT_VIEW, { padding: [16, 16] });
    if (ll) { whereMark = L.marker(ll, { icon: L.divIcon({ className: "", html: `<div class="wherepin">📍</div>`, iconSize: [30, 30], iconAnchor: [15, 28] }), interactive: false }).addTo(map);
      whereMark._label = p.name; placePinLabel(); map.once("moveend", schedulePinLabel); document.body.classList.add("aklzoom"); }
    $("fitBtn").title = "Back to the park (0)"; aklNext = false; return;
  }
  const m = p.maps[Math.min(mapIndex(p), Math.max(0, p.maps.length - 1))];
  if (m) map.fitBounds(mapBounds(p, m));
  else if (p.lat) map.setView([p.lat, p.lon], 16.5);
  $("fitBtn").title = "All of Auckland, with this park pinned (0)"; aklNext = true;
}
// The pin's name label goes on whichever side (above, right, left, below) clashes least with
// the suburb names; any suburb name it still covers is nudged clear. Re-run after zooming.
const PIN_SIDES = [["top", [0, -26]], ["right", [12, -14]], ["left", [-12, -14]], ["bottom", [0, 4]]];
// Suburb names that collide are pushed down, the park's own suburb first in place.
function spreadLabels(labels, obstacles = []) {
  labels.forEach(l => { l.style.marginTop = ""; });
  const placed = [...obstacles];
  [...labels].sort((a, b) => b.classList.contains("home") - a.classList.contains("home")).forEach(l => {
    for (let k = 0; k < 12; k++) { const r = l.getBoundingClientRect();
      const hit = placed.find(q => Math.min(r.right, q.right) > Math.max(r.left, q.left) && Math.min(r.bottom, q.bottom) > Math.max(r.top, q.top));
      if (!hit) break; l.style.marginTop = `${(parseFloat(l.style.marginTop) || 0) + hit.bottom - r.top + 2}px`; }
    placed.push(l.getBoundingClientRect()); });
}
// Measure only once the zoom animation has settled.
let pinTimer = null;
const schedulePinLabel = () => { clearTimeout(pinTimer); pinTimer = setTimeout(placePinLabel, 120); };
function placePinLabel() {
  if (!whereMark) return;
  const labels = [...document.querySelectorAll(".sublbl")];
  spreadLabels(labels);
  const rects = labels.map(l => l.getBoundingClientRect());
  // Clash = area over suburb names, plus (weighted) any part hanging off the map.
  const box = map.getContainer().getBoundingClientRect();
  const clash = r => rects.reduce((a, q) => a + Math.max(0, Math.min(r.right, q.right) - Math.max(r.left, q.left)) * Math.max(0, Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top)), 0)
    + 3 * (r.width * r.height - Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left)) * Math.max(0, Math.min(r.bottom, box.bottom) - Math.max(r.top, box.top)));
  let best = null;
  for (const [direction, offset] of PIN_SIDES) {
    whereMark.unbindTooltip().bindTooltip(esc(whereMark._label), { permanent: true, direction, offset, className: "parktip" }).openTooltip();
    const el = whereMark.getTooltip()?.getElement(); if (!el) continue;
    const r = el.getBoundingClientRect(), c = clash(r);
    if (!best || c < best.c) best = { direction, offset, c };
    if (!c) break;
  }
  if (!best) return;
  whereMark.unbindTooltip().bindTooltip(esc(whereMark._label), { permanent: true, direction: best.direction, offset: best.offset, className: "parktip" }).openTooltip();
  // Still covering a name: lay the names out again with the pin label as an obstacle.
  if (best.c) spreadLabels(labels, [whereMark.getTooltip().getElement().getBoundingClientRect()]);
}
// Phones: ⛶ fills the screen with the map and the rating buttons.
function setFullMap(on) {
  document.body.classList.toggle("mapfull", on);
  $("fullBtn").setAttribute("aria-pressed", String(on)); $("fullBtn").textContent = on ? "✕" : "⛶";
  $("fullBtn").title = on ? "Exit full screen" : "Full-screen map";
  setTimeout(() => { map.invalidateSize(); sizeField(); }, 50);
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
// Council fields traced from the map PDFs: [{n: name, c: [lat, lon], p: [[lat, lon], …]}],
// shifted by the park's alignment offset when its council map was realigned.
const shiftedFields = new Map();
function councilFields(p, i = Math.min(mapIndex(p), Math.max(0, p.maps.length - 1))) {
  const fs = p.maps[i]?.fields || [], o = offsets[p.id];
  if (!o || (!o.dlat && !o.dlon)) return fs;
  const k = `${p.id}#${i}#${o.dlat},${o.dlon}`;
  if (!shiftedFields.has(k)) shiftedFields.set(k, fs.map(f => ({ ...f, c: [f.c[0] + o.dlat, f.c[1] + o.dlon], p: f.p.map(q => [q[0] + o.dlat, q[1] + o.dlon]) })));
  return shiftedFields.get(k);
}
// Softball / baseball diamonds on a park's summer map: pitching mounds and skinned
// infields can make that ground unsuitable for frisbee in summer.
const DIAMOND_RE = /\b(softball|baseball|t-?ball)\b|diamond/i;
function diamonds(p) {
  const i = p.maps.findIndex(m => m.season === "summer"); if (i < 0) return [];
  return councilFields(p, i).filter(f => DIAMOND_RE.test(f.n || ""));
}
function renderSoftWarn(p) {
  const el = $("softWarn"), ds = diamonds(p);
  el.hidden = !ds.length; if (!ds.length) return;
  const t = tagsFor(p), names = [...new Set(ds.map(f => f.n))];
  // Placed frisbee fields standing on a diamond.
  const hit = Object.values(t.fr).filter(fr => fr.lat != null).filter(fr => { const r = toXY(frisbeeCorners(fr), fr.lat, fr.lon);
    return ds.some(f => areaXY(clipXY(toXY(f.p, fr.lat, fr.lon), r)) > 0.05 * areaXY(r)); }).map(fr => fr.name);
  el.innerHTML = `<b>⚾ Softball / baseball ground (summer)</b> — pitching mounds and skinned infields may make it unsuitable for frisbee in summer. `
    + `<span class="sw-f">${esc(names.join(" · "))}</span>${hit.length ? `<br><b>On a diamond:</b> ${esc(hit.join(", "))}` : ""}`;
}
const mapBounds = (p, m) => { const o = offsets[p.id] || {}, a = o.dlat || 0, b = o.dlon || 0;
  return L.latLngBounds([m.bounds[0] + a, m.bounds[1] + b], [m.bounds[2] + a, m.bounds[3] + b]); };

// ── Council map alignment ────────────────────────────────────────────────────
// The council's maps can sit a few metres off the satellite imagery. When placed fields lie
// mostly outside the council field areas, ⚠ Misaligned (beside Remove) offers to shift the
// council fields and map overlay so they line up with the placement. Offsets are per park,
// shared through settings (key council_offsets): { park_id: { dlat, dlon, by, at } }.
const OFFSETS_KEY = "council_offsets";
let offsets = {};
const alignDismissed = new Set();
async function loadOffsets() {
  if (supabase && session) {
    const { data, error } = await supabase.from("settings").select("value").eq("key", OFFSETS_KEY).maybeSingle();
    if (!error) { offsets = data?.value || {}; return; }
  }
  offsets = store.get("vet-council-offsets", {});
}
async function saveOffset(id, o) {
  const entry = o ? { ...o, by: session?.user?.email || "", at: new Date().toISOString() } : null;
  if (supabase && session && IS_ADMIN) {
    const { value, error } = entry ? await mergeSetting(OFFSETS_KEY, { [id]: entry }) : await mergeSetting(OFFSETS_KEY, {}, [id]);
    if (error) { setStatus("Couldn't save the alignment (" + error.message + ").", true); return false; }
    offsets = value; return true;
  }
  if (entry) offsets[id] = entry; else delete offsets[id];
  store.set("vet-council-offsets", offsets); return true;
}
// Share of the placed fields' area inside the council field areas, with the council fields
// shifted by (dx, dy) metres. Sampled on a 6 m grid across each field.
// Each placed field's share inside the council areas (shifted by dx, dy metres).
function alignShares(p, t, dx, dy) {
  const fs = Object.values(t.fr).filter(rated); if (!fs.length) return [];
  const lat0 = fs[0].lat, lon0 = fs[0].lon, cf = (p.maps[Math.min(mapIndex(p), Math.max(0, p.maps.length - 1))]?.fields || []).map(f => toXY(f.p, lat0, lon0));
  const o = offsets[p.id] || {}, { kx, ky } = metric(lat0), ox = (o.dlon || 0) * kx + dx, oy = (o.dlat || 0) * ky + dy;
  return fs.map(fr => { const r = toXY(frisbeeCorners(fr), lat0, lon0), xs = r.map(q => q[0]), ys = r.map(q => q[1]); let n = 0, inn = 0;
    for (let x = Math.min(...xs) + 3; x < Math.max(...xs); x += 6) for (let y = Math.min(...ys) + 3; y < Math.max(...ys); y += 6) {
      if (!insideXY([x, y], r)) continue; n++; if (cf.some(c => insideXY([x - ox, y - oy], c))) inn++; }
    return { name: fr.name, share: n ? inn / n : 0 }; });
}
function alignScore(p, t, dx, dy) {
  const fs = Object.values(t.fr).filter(rated); if (!fs.length) return 0;
  const lat0 = fs[0].lat, lon0 = fs[0].lon, cf = (p.maps[Math.min(mapIndex(p), Math.max(0, p.maps.length - 1))]?.fields || []).map(f => toXY(f.p, lat0, lon0));
  const o = offsets[p.id] || {}, { kx, ky } = metric(lat0), ox = (o.dlon || 0) * kx + dx, oy = (o.dlat || 0) * ky + dy;
  let n = 0, inn = 0;
  fs.forEach(fr => { const r = toXY(frisbeeCorners(fr), lat0, lon0), xs = r.map(q => q[0]), ys = r.map(q => q[1]);
    for (let x = Math.min(...xs) + 3; x < Math.max(...xs); x += 6) for (let y = Math.min(...ys) + 3; y < Math.max(...ys); y += 6) {
      if (!insideXY([x, y], r)) continue; n++; if (cf.some(c => insideXY([x - ox, y - oy], c))) inn++; } });
  return n ? inn / n : 0;
}
// A field may stand up to a quarter outside the council areas (alignment wiggle room): it's
// placed exactly where it was locked, with no warning. Misaligned: some field is more than
// a quarter outside, and a shift of the council map within ±60 m would bring the fields
// clearly further in (by 15 points or more). Returns the best shift found.
const OUTSIDE_TOL = 0.25;
const misCache = new Map();
function misalignment(p, t) {
  if (!councilFields(p).length || !Object.values(t.fr).some(rated)) return null;
  const key = JSON.stringify([p.id, mapIndex(p), offsets[p.id], Object.values(t.fr).filter(rated).map(x => [x.lat, x.lon, x.angle, x.len, x.wid])]);
  if (!misCache.has(key)) { if (misCache.size > 50) misCache.clear(); misCache.set(key, findMisalignment(p, t)); }
  return misCache.get(key);
}
function findMisalignment(p, t) {
  const shares = alignShares(p, t, 0, 0), out = shares.filter(x => x.share < 1 - OUTSIDE_TOL);
  if (!out.length) return null;
  const now = alignScore(p, t, 0, 0);
  let best = { dx: 0, dy: 0, s: now };
  for (let dx = -60; dx <= 60; dx += 4) for (let dy = -60; dy <= 60; dy += 4) { const sc = alignScore(p, t, dx, dy);
    if (sc > best.s + 1e-9 || (Math.abs(sc - best.s) < 1e-9 && Math.hypot(dx, dy) < Math.hypot(best.dx, best.dy))) best = { dx, dy, s: sc }; }
  const c = best; for (let dx = c.dx - 3; dx <= c.dx + 3; dx++) for (let dy = c.dy - 3; dy <= c.dy + 3; dy++) { const sc = alignScore(p, t, dx, dy); if (sc > best.s) best = { dx, dy, s: sc }; }
  return best.s >= now + 0.15 ? { ...best, now, out } : null;
}
function renderAlign(p) {
  const b = $("fbAlign"), t = tagsFor(p), o = offsets[p.id];
  const mis = IS_ADMIN && !alignDismissed.has(p.id) ? misalignment(p, t) : null;
  b.hidden = !(mis || (IS_ADMIN && o));
  b.classList.toggle("warn", !!mis);
  b.textContent = mis ? "⚠ Misaligned" : "⟲ Realigned";
  b.title = mis ? "Your fields sit outside the council field areas. Realign the council map to them?" : o ? `Council map shifted ${Math.round(Math.hypot((o.dlat || 0) * M_PER_DEG, (o.dlon || 0) * metric(p.lat || -36.85).kx))} m to line up with the fields. Click to reset it.` : "";
  b._mis = mis;
}
async function askAlign(p) {
  const b = $("fbAlign"), mis = b._mis, o = offsets[p.id], dlg = $("alignDlg");
  if (mis) {
    const d = Math.round(Math.hypot(mis.dx, mis.dy)), dir = (mis.dy > 0 ? "north" : mis.dy < 0 ? "south" : "") + (mis.dx > 0 ? "east" : mis.dx < 0 ? "west" : "");
    $("alignTitle").textContent = "Realign the council fields?";
    $("alignBody").textContent = `${mis.out.map(x => `${x.name} is ${Math.round((1 - x.share) * 100)}% outside`).join(", ")} the council's field areas at ${p.name} (more than the ${Math.round(OUTSIDE_TOL * 100)}% allowed), so the council map looks misaligned. `
      + `Should the council fields be realigned to your field placement? That moves the council fields and map overlay ${d} m ${dir || ""} (then ${Math.round(mis.s * 100)}% inside).`;
    $("alignYes").textContent = "Yes, realign";
  } else if (o) {
    $("alignTitle").textContent = "Reset the council map alignment?";
    $("alignBody").textContent = `The council fields at ${p.name} were shifted to line up with the field placement${o.by ? ` by ${o.by.split("@")[0]}` : ""}. Put them back where the council's map has them?`;
    $("alignYes").textContent = "Yes, reset";
  } else return;
  dlg.returnValue = ""; dlg.showModal();
  const a = await new Promise(res => dlg.addEventListener("close", () => res(dlg.returnValue), { once: true }));
  if (a !== "yes") { if (mis) alignDismissed.add(p.id); renderAlign(p); return; }
  const kx = metric(p.lat || -36.85).kx, cur = offsets[p.id] || {};
  const ok = await saveOffset(p.id, mis ? { dlat: (cur.dlat || 0) + mis.dy / M_PER_DEG, dlon: (cur.dlon || 0) + mis.dx / kx } : null);
  if (!ok) return;
  shownPark = null; render();
  setStatus(mis ? `Council fields at ${p.name} realigned to your field placement.` : `Council fields at ${p.name} back on the council's map position.`);
}

// Council field areas are clickable: selecting one targets it for rating (or editing an
// existing rating) and shows only its lights.
function fieldKeys(p) {
  const seen = {};
  return councilFields(p).map((f, i) => { let key = f.n || `Field ${i + 1}`;
    if (seen[key]) key += ` (${++seen[key]})`; else seen[key] = 1;
    return { f, key }; });
}
// ── Frisbee fields → council fields (worked out on venue save) ────────────────
// While adding fields, each locked frisbee field stands on its own ("Frisbee 1", …). Saving
// the venue maps them back to the council's field areas:
//   1. a council area overlapping a frisbee field (by more than OVERLAP_TOL of the smaller
//      of the two) goes with that frisbee field;
//   2. if what's left uncovered is under SPARE_RULE of the council area, each leftover
//      council area joins the nearest frisbee field (by centroid);
//   3. frisbee fields sharing a council area merge into one bookable multi-field area.
const OVERLAP_TOL = 0.10, SPARE_RULE = 0.25;
// Rectangular field codes, which win over cricket, softball and other shaped areas they overlap.
const RECT_RE = /rugby|football|soccer|league|lacrosse|touch|hockey|general sport|ultimate|frisbee/i;
const newFrisbeeName = t => { let n = 1; while (t.fr["Frisbee " + n]) n++; return "Frisbee " + n; };
const rated = x => x && x.fit && x.fit !== "unknown" && x.lat != null;
// Unusable (reject) fields (fit "no") are kept as ratings but never become bookable.
const bookable = x => rated(x) && x.fit !== "no";
function metric(lat0) { const kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180), ky = M_PER_DEG; return { kx, ky }; }
// A frisbee field's rectangle as [lat, lon] corners (same convention as placeLights).
function frisbeeCorners(fr) {
  const { kx, ky } = metric(fr.lat), th = (fr.angle || 0) * Math.PI / 180, L2 = (fr.len || dims.len) / 2, W2 = (fr.wid || dims.wid) / 2;
  return [[-L2, -W2], [L2, -W2], [L2, W2], [-L2, W2]].map(([u, v]) => { const ex = u * Math.cos(th) - v * Math.sin(th), sy = u * Math.sin(th) + v * Math.cos(th);
    return [fx(fr.lat - sy / ky), fx(fr.lon + ex / kx)]; });
}
const toXY = (pts, lat0, lon0) => { const { kx, ky } = metric(lat0); return pts.map(([la, lo]) => [(lo - lon0) * kx, (la - lat0) * ky]); };
const areaXY = pts => Math.abs(pts.reduce((s, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + x * y2 - x2 * y; }, 0)) / 2;
// Sutherland–Hodgman: clip any polygon by a convex one; the result's area is the overlap.
function clipXY(subject, clip) {
  const orient = Math.sign(clip.reduce((s, [x, y], i) => { const [x2, y2] = clip[(i + 1) % clip.length]; return s + x * y2 - x2 * y; }, 0)) || 1;
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const [ax, ay] = clip[i], [bx, by] = clip[(i + 1) % clip.length];
    const inside = ([x, y]) => orient * ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) >= 0;
    const cut = ([px, py], [qx, qy]) => { const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d2 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax), k = d1 / (d1 - d2);
      return [px + (qx - px) * k, py + (qy - py) * k]; };
    const inp = out; out = [];
    inp.forEach((P, j) => { const Q = inp[(j + 1) % inp.length], pin = inside(P), qin = inside(Q);
      if (pin) out.push(P); if (pin !== qin) out.push(cut(P, Q)); });
  }
  return out;
}
const insideXY = ([x, y], poly) => { let inn = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inn = !inn; }
  return inn; };
function coverageXY(council, frisbee) {
  if (!council.length) return { total: 0, covered: 0 };
  const xs = council.flat().map(q => q[0]), ys = council.flat().map(q => q[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const step = Math.max(2.5, Math.sqrt((x1 - x0) * (y1 - y0) / 60000));   // at most ~60k samples
  let total = 0, covered = 0;
  for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) {
    if (!council.some(c => insideXY([x, y], c))) continue;
    total++; if (frisbee.some(f => insideXY([x, y], f))) covered++;
  }
  return { total: total * step * step, covered: covered * step * step };
}
// The venue's mapping: { groups: [{key, name, council[], frisbee[], fit, cap, c}], covered, total }.
function councilGroups(p, t) {
  const cf = fieldKeys(p);
  // Drafting allows overlap; here a field lying mostly (over half) on an earlier one is the
  // same field, so only the earlier one counts.
  const fs = [];
  Object.values(t.fr).filter(bookable).forEach(fr => { const r = toXY(frisbeeCorners(fr), fr.lat, fr.lon), a = areaXY(r);
    if (!fs.some(o => areaXY(clipXY(toXY(frisbeeCorners(o), fr.lat, fr.lon), r)) > 0.5 * a)) fs.push(fr); });
  if (!fs.length) return { groups: [], covered: 0, total: 0 };
  const lat0 = fs[0].lat, lon0 = fs[0].lon;
  const cpoly = cf.map(({ f, key }) => ({ key, xy: toXY(f.p, lat0, lon0), c: f.c })), fpoly = fs.map(fr => ({ fr, xy: toXY(frisbeeCorners(fr), lat0, lon0) }));
  cpoly.forEach(c => { c.area = areaXY(c.xy); });
  fpoly.forEach(f => { f.area = areaXY(f.xy); });
  // Council areas overlap one another (touch or football fields inside a cricket oval). The
  // rectangular codes take priority: a cricket, softball or other shaped area overlapping a
  // rectangular one that a frisbee field uses is left out, rather than assigning both
  // mutually exclusive sets.
  cpoly.forEach(c => { c.rect = RECT_RE.test(c.key); });
  const clash = (a, b) => areaXY(clipXY(a.xy, b.xy)) > OVERLAP_TOL * Math.min(a.area, b.area);   // b convex (a rectangle)
  // Each frisbee field's council areas (overlap above the tolerance).
  const C = fpoly.map(f => { const hit = cpoly.filter(c => areaXY(clipXY(c.xy, f.xy)) > OVERLAP_TOL * Math.min(c.area, f.area)), rect = hit.filter(c => c.rect);
    return new Set(hit.filter(c => c.rect || !rect.some(r => clash(c, r))).map(c => c.key)); });
  // Coverage by sampling a 2.5 m grid: council areas often overlap one another (touch fields
  // inside a cricket oval), so the union is measured, not the sum.
  const { total, covered } = coverageXY(cpoly.map(c => c.xy), fpoly.map(f => f.xy));
  // The mosaic: slots of one field, or two neighbouring single fields (only the fields as
  // placed), chosen to cross as few council boundaries as possible, i.e. to minimise how
  // many slots each council area is split across: Σ over slots of |council areas it
  // touches|. Pairing two fields saves the council areas they share; a tie keeps them single.
  const n = fs.length, single = i => fs[i].fit !== "multi";   // an older 2+ rating is already a two-field slot
  const near = (i, j) => areaXY(clipXY(toXY(frisbeeCorners({ ...fs[i], len: (fs[i].len || dims.len) + 12, wid: (fs[i].wid || dims.wid) + 12 }), lat0, lon0), fpoly[j].xy)) > 1;
  const adj = (i, j) => single(i) && single(j) && (fs[i].pair === fs[j].name || fs[j].pair === fs[i].name || near(i, j));
  const cost = (i, j) => j == null ? C[i].size : new Set([...C[i], ...C[j]]).size;
  const tiles = [];
  if (n <= 16) {
    const memo = new Map();
    const solve = mask => { if (!mask) return { c: 0, t: [] };
      if (memo.has(mask)) return memo.get(mask);
      const i = 31 - Math.clz32(mask & -mask), rest = mask & ~(1 << i);
      let best = (() => { const r = solve(rest); return { c: r.c + cost(i), t: [[i], ...r.t] }; })();
      for (let j = 0; j < n; j++) if (rest & (1 << j) && adj(i, j)) { const r = solve(rest & ~(1 << j)), c = r.c + cost(i, j);
        if (c < best.c) best = { c, t: [[i, j], ...r.t] }; }
      memo.set(mask, best); return best; };
    tiles.push(...solve((1 << n) - 1).t);
  } else {   // many fields: pair greedily by council areas shared
    const used = new Set();
    const pairs = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (adj(i, j)) pairs.push([i, j, cost(i) + cost(j) - cost(i, j)]);
    pairs.sort((a, b) => b[2] - a[2]).forEach(([i, j, gain]) => { if (gain > 0 && !used.has(i) && !used.has(j)) { used.add(i); used.add(j); tiles.push([i, j]); } });
    fs.forEach((_, i) => { if (!used.has(i)) tiles.push([i]); });
  }
  // Each council area goes to the slot that overlaps it most; under the spare-space rule the
  // untouched ones join the nearest slot.
  const council = tiles.map(() => []), used = cpoly.filter(c => c.rect && C.some(set => set.has(c.key)));
  [...cpoly].sort((a, b) => b.rect - a.rect).forEach(c => { let best = -1, bestOv = 0;
    if (!c.rect && used.some(r => clash(c, r))) return;   // excluded by a rectangular area in use
    tiles.forEach((tile, k) => { if (!tile.some(i => C[i].has(c.key))) return; const ov = tile.reduce((s2, i) => s2 + areaXY(clipXY(c.xy, fpoly[i].xy)), 0); if (ov > bestOv) { bestOv = ov; best = k; } });
    if (best < 0 && total && (total - covered) / total < SPARE_RULE)
      best = tiles.map((tile, k) => ({ k, d: Math.min(...tile.map(i => Math.hypot((fs[i].lat - c.c[0]) * M_PER_DEG, (fs[i].lon - c.c[1]) * metric(fs[i].lat).kx))) })).sort((a, b) => a.d - b.d)[0].k;
    if (best >= 0) council[best].push(c.key); });
  const groups = tiles.map((tile, k) => {
    const members = tile.map(i => fs[i]), cap = members.reduce((s2, x) => s2 + (x.fit === "multi" ? 2 : 1), 0), frisbee = members.map(x => x.name);
    const name = council[k].length ? council[k].join(" + ") : frisbee.join(" + ");
    const c = [members.reduce((s2, x) => s2 + x.lat, 0) / members.length, members.reduce((s2, x) => s2 + x.lon, 0) / members.length];
    return { key: name, name, council: council[k], frisbee, cap, fit: cap > 1 ? "multi" : members[0].fit, crossings: Math.max(0, council[k].length - 1), c: [fx(c[0]), fx(c[1])] };
  });
  return { groups, covered, total };
}
const spareShare = m => m.total ? Math.max(0, (m.total - m.covered) / m.total) : 0;
const FIT_COLOR = { multi: "#1f7a4d", full: "#46b37b", reduced: "#e0a647", no: "#b3372d" };
function drawParkFields(p) {
  parkFieldsLayer.clearLayers();
  const t = tagsFor(p);
  if (workMode === "book") {   // Book mode: field areas go in and out of the booker's cart
    const groups = reviews[p.id]?.placement?.groups || [];
    fieldKeys(p).forEach(({ f, key }) => {
      const g = groups.find(x => x.council?.includes(key)), st = locState(cartId(p, g ? g.key : key));   // "active" | "cart" | null
      L.polygon(f.p, { pane: "fieldsPane", fill: true, fillColor: st === "active" ? "#0f766e" : "#14b8a6",
        fillOpacity: st === "active" ? 0.55 : st ? 0.3 : 0.04, color: st === "active" ? "#0f766e" : st ? "#14b8a6" : "#ffffff",
        weight: st ? 3 : 1.4, dashArray: st === "cart" ? "7 4" : st ? null : "4 4", opacity: 0.95, bubblingMouseEvents: false })
        .bindTooltip(`${esc(g ? g.name : key)}${g?.cap > 1 ? ` (${g.cap} field areas)` : ""} — ${st === "active" ? "📌 active booking" : st ? "🛒 in the cart (not booked yet) · click to remove" : "click to add to the cart"}`, { className: "parktip", sticky: true })
        .on("click", () => toggleCart(p, key))
        .addTo(parkFieldsLayer);
    });
    return;
  }
  // Council areas stay neutral while fields are added (the mapping happens on venue save);
  // once saved, each is tinted by the frisbee group it belongs to.
  const groups = reviews[p.id]?.placement?.groups || [];
  fieldKeys(p).forEach(({ f, key }) => {
    const g = groups.find(x => x.council?.includes(key)), fc = g && FIT_COLOR[g.fit], dia = DIAMOND_RE.test(f.n || "");
    L.polygon(f.p, { pane: "fieldsPane", fill: true, fillColor: fc || (dia ? "#f97316" : "#ffffff"), fillOpacity: fc ? 0.18 : dia ? 0.12 : 0.02,
      color: dia ? "#f97316" : fc || "#ffffff", weight: dia ? 2 : 1.2, dashArray: "4 4", opacity: 0.85, bubblingMouseEvents: false })
      .bindTooltip(`${dia ? "⚾ " : ""}${esc(key)}${dia ? " — pitching mound / infield: may be unsuitable for frisbee in summer" : ""}${g ? ` · in ${esc(g.frisbee.join(" + "))}${g.cap > 1 ? ` (${g.cap} field areas)` : ""}` : ""} — click to place a frisbee field here`, { className: "parktip", sticky: true })
      .on("click", () => { if (rotating) return lockField(); placeOnCouncil(p, f); })
      .addTo(parkFieldsLayer);
  });
  // Saved frisbee fields: their outlines, coloured by fit; click one to edit it.
  Object.values(t.fr).filter(x => x.lat != null).forEach(fr => {
    const sel = t.sel === fr.name, fc = rated(fr) && FIT_COLOR[fr.fit];
    if (sel && !rotating) return;   // the live field is drawn on top
    L.polygon(frisbeeCorners(fr), { pane: "fieldsPane", fill: true, fillColor: fc || "#ffd400", fillOpacity: fc ? 0.28 : 0.1,
      color: fc || "#ffd400", weight: sel ? 3 : 2.5, opacity: 0.95, bubblingMouseEvents: false })
      .bindTooltip(`${esc(fr.name)}${rated(fr) ? " · " + FIT_LABEL[fr.fit] : " · not rated"}${fieldPoles(t, fr).length ? " · 💡" + fieldPoles(t, fr).length : ""} — click to edit`, { className: "parktip", sticky: true })
      .on("click", () => { if (rotating) return lockField(); selectField(p, fr.name === t.sel ? null : fr.name); })
      .addTo(parkFieldsLayer);
  });
}
// Clicking a council area drops a new frisbee field on it, lined up with its long side.
function placeOnCouncil(p, f) {
  const t = tagsFor(p); t.sel = null;
  // Lock reads the map centre, so move there at once (not animated).
  angle = longAxis(f.p); map.setView(f.c, map.getZoom(), { animate: false });
  lockField();
}
function selectField(p, key) {
  const t = tagsFor(p); t.sel = key;
  if (key) {
    const rt = t.fr[key];
    if (rt?.lat != null) { angle = rt.angle; pin = L.latLng(rt.lat, rt.lon); }
    if (pin) map.panTo(pin, { animate: true });
    $("fitPop").hidden = false; fitArmed = true;
  } else { $("fitPop").hidden = true; fitArmed = false; }
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
  t.sel = f ? f.name : null; $("fitPop").hidden = !t.sel;
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
// Light poles (the venue's): bulbs dragged from the dispenser onto the map. Each shows a beam
// the way it shines; tap one to turn it 45°, drag it to move it, drag it back onto the
// dispenser to remove it. Poles along the selected field are highlighted.
function drawLights(p) {
  lightLayer.clearLayers();
  const t = tagsFor(p), arr = t.lightPts, near = new Set(fieldPoles(t, t.sel && t.fr[t.sel]).map(poleKey));
  const icon = (q, cls) => L.divIcon({ className: "", html: `<div class="lightpin${cls}" style="--dir:${Math.round(poleDir(t, q))}deg"><span class="beam"></span><span class="bulb">💡</span></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  arr.forEach((q, k) => {
    const mk = L.marker([q[0], q[1]], { icon: icon(q, t.sel && !near.has(poleKey(q)) ? " other" : ""), title: "Light pole — tap to turn it, drag to move, drag back to the dispenser to remove", keyboard: false, draggable: true });
    mk.on("click", e => { L.DomEvent.stopPropagation(e); turnLight(p, k); });
    mk.on("drag", e => $("dispenser").classList.toggle("target", overDispenser(e.originalEvent)));
    mk.on("dragend", () => {
      $("dispenser").classList.remove("target");
      if (lastPointer && overDispenser(lastPointer)) return removeLight(p, k);
      snap(p); const l = mk.getLatLng(); arr[k] = [fx(l.lat), fx(l.lng), poleDir(t, q)];   // moved by hand: no longer auto-placed
      drawLights(p); renderTags(p);
    });
    mk.addTo(lightLayer);
  });
  renderDispenser(p);
}
function turnLight(p, k) {
  snap(p); const t = tagsFor(p), q = t.lightPts[k];
  t.lightPts[k] = [q[0], q[1], (Math.round(poleDir(t, q) / 45) * 45 + 45) % 360, q[3]].filter((v, i) => i < 3 || v != null);
  drawLights(p);
}
let lastPointer = null;
function overDispenser(ev) {
  if (!ev) return false;
  const pt = ev.touches?.[0] || ev.changedTouches?.[0] || ev, r = $("dispenser").getBoundingClientRect();
  return pt.clientX >= r.left - 6 && pt.clientX <= r.right + 6 && pt.clientY >= r.top - 6 && pt.clientY <= r.bottom + 6;
}
function addLight(p, latlng) {
  snap(p);
  const t = tagsFor(p), q = [fx(latlng.lat), fx(latlng.lng)];
  t.lightPts.push([q[0], q[1], Math.round(poleDir(t, q))]);
  syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p);
}
function removeLight(p, k) {
  snap(p);
  const t = tagsFor(p); t.lightPts.splice(k, 1);
  syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p);
}
// Drag a bulb out of the dispenser: a ghost follows the pointer and drops where released.
function bindDispenser() {
  const src = $("bulbSrc"); let ghost = null, start = null;
  document.addEventListener("pointermove", e => { lastPointer = e; }, { passive: true });
  document.addEventListener("pointerup", e => { lastPointer = e; }, { passive: true, capture: true });
  // A tap cycles the state; moving more than a few pixels drags out a bulb instead.
  src.addEventListener("pointerdown", e => {
    if (!current() || view !== "park") return;
    e.preventDefault(); src.setPointerCapture(e.pointerId); start = { x: e.clientX, y: e.clientY };
  });
  src.addEventListener("pointermove", e => {
    if (!start) return;
    if (!ghost && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
      ghost = document.createElement("div"); ghost.className = "bulbghost"; ghost.textContent = "💡"; document.body.appendChild(ghost);
    }
    if (ghost) { ghost.style.left = e.clientX + "px"; ghost.style.top = e.clientY + "px"; }
  });
  src.addEventListener("pointerup", e => {
    const p = current(); if (!start) return; start = null;
    if (!ghost) { if (p) tapLights(p); return; }
    ghost.remove(); ghost = null;
    const r = $("map").getBoundingClientRect();
    if (!p || overDispenser(e) || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const t = tagsFor(p); if (!hasLights(t)) t.lights = "full";   // dragging a bulb out answers "lights"
    addLight(p, map.containerPointToLatLng([e.clientX - r.left, e.clientY - r.top]));
  });
  src.addEventListener("pointercancel", () => { start = null; if (ghost) { ghost.remove(); ghost = null; } });
  src.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && current()) { e.preventDefault(); tapLights(current()); } });
  $("lightsReset").onclick = e => { e.stopPropagation(); const p = current(); if (p) resetLights(p); };
}

// ── Frisbee field overlay: frame-centred, true scale, centre button locks/unlocks rotation ─
// The field is frame-centred until it's locked; locking pins it to that spot on the map
// (pin), so panning afterwards moves the map under it. Unlocking recentres on it.
let angle = 0, rotating = false, pin = null;
// Fit mode: after the field is locked in place (🔒) or put on a council field area, the
// decision buttons become the fit buttons (Unusable | 3v3 only / 1 × full 7v7 / 2 × full 7v7) until
// a fit is chosen. hintFrom tracks the unlocked field so the how-to hint can go once it
// has been both moved and turned.
let fitArmed = false, hintFrom = null;
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
  // The unlocked how-to goes once the field has been moved and turned past a threshold.
  if (rotating && hintFrom && !$("rotateHint").hidden) {
    const c = map.getCenter(), kx = M_PER_DEG * Math.cos(c.lat * Math.PI / 180);
    if (Math.hypot((c.lng - hintFrom.c.lng) * kx, (c.lat - hintFrom.c.lat) * M_PER_DEG) > 12) hintFrom.moved = true;
    if (Math.abs((((angle - hintFrom.a) % 360) + 540) % 360 - 180) > 15) hintFrom.turned = true;
    if (hintFrom.moved && hintFrom.turned) $("rotateHint").hidden = true;
  }
}
function setRotating(on) {
  if (on && pin) { map.setView(pin, map.getZoom(), { animate: false }); pin = null; }
  rotating = on; $("field").classList.toggle("live", on); $("rotateHint").hidden = !on;
  hintFrom = on ? { c: map.getCenter(), a: angle, moved: false, turned: false } : null;
  if (on) fitArmed = false;
  $("rotateHint").textContent = matchMedia("(hover: none)").matches
    ? "Twist to turn · drag to move · tap 🔒 to lock"
    : "Mouse turns · drag moves · click locks";
  if (on) $("fitPop").hidden = true;
  sizeField(); renderCentre(); updateActions();
}
function showField(on) {
  fieldOn = on; store.set("vet-field-on", on);
  $("field").hidden = !on; $("centreWrap").hidden = !on; $("fieldBtn").setAttribute("aria-pressed", String(on));
  if (!on) { if (rotating) setRotating(false); $("fitPop").hidden = true; }
}
// Locking fixes the angle and pins the field where it is. Rating the fit then confirms the
// spot: that is when the fields are filled in and the position recorded, and only the
// confirmed spot is saved with a decision. Unlock to move or turn it again.
// Locking also records the spot (centre and angle) on the nearest council field, so the
// lock, not saving, fixes the coordinates; a rated field's auto lights follow it.
function lockField() {
  // Stop any glide (inertia after a fling, a zoom or pan animation) first: otherwise the
  // field is pinned mid-glide and slides away with the map once locked.
  map.stop();
  setRotating(false);
  pin = map.getCenter(); sizeField();
  const p = current(); if (!p) return;
  snap(p);
  // Re-locking moves the selected frisbee field; otherwise this is a new one.
  const t = tagsFor(p), key = t.sel && t.fr[t.sel] ? t.sel : newFrisbeeName(t);
  const cur = t.fr[key] ||= { name: key, fit: "unknown", lights: [] };
  Object.assign(cur, { name: key, lat: fx(pin.lat), lon: fx(pin.lng), angle: fa(angle), len: dims.len, wid: dims.wid, ez: dims.ez });
  // Its auto-placed poles follow it; poles already standing along it (the venue's) light it too.
  if (cur.fit && cur.fit !== "unknown" && hasLights(t) && cur.lightCount) placeLights(p, cur);
  syncFromFields(t);
  t.sel = key; fitArmed = true;
  $("fitPop").hidden = false; drawParkFields(p); drawLights(p); previewFields(p); renderTags(p); renderCentre();
}
// The rating being edited: the selected field's, if it has a spot.
const curRating = t => t.sel && t.fr[t.sel]?.lat != null ? t.fr[t.sel] : null;
function spotMoved(t) {
  const sp = curRating(t); if (!sp) return false;
  const c = fieldCentre(), kx = M_PER_DEG * Math.cos(c.lat * Math.PI / 180);
  const dm = Math.hypot((sp.lon - c.lng) * kx, (sp.lat - c.lat) * M_PER_DEG);
  const da = Math.abs((((angle - sp.angle) % 360) + 540) % 360 - 180);
  return dm > 3 || da > 2;
}
function previewFields(p) {
  const t = tagsFor(p), moved = spotMoved(t);
  const target = t.sel ? `Rating ${t.sel}` : "Lock the field to add a frisbee field";
  // Short label; the how-to lives in the tooltip.
  $("fitMsg").textContent = moved ? `${target} · moved — rate again` : target;
  $("fitMsg").title = moved ? "Rate the fit again to save this spot" : t.sel && t.fr[t.sel]?.fit && t.fr[t.sel].fit !== "unknown" ? "Click a fit to change it, or the same one to clear it" : "Pan to fine-tune, then rate the fit";
  $("fitMsg").classList.toggle("warn", moved);
  // The chosen fit shows pressed on its button in fit mode.
  const chosen = !moved && t.sel && t.fr[t.sel]?.fit && t.fr[t.sel].fit !== "unknown" ? t.fr[t.sel].fit : null;
  $("actions").querySelectorAll("[data-fit]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.fit === chosen)));
  updateActions();

  // Tools for the selected field: undo, move (unlock), remove.
  const fr = t.sel && t.fr[t.sel];
  $("fbTools").hidden = !IS_ADMIN || !(fr?.lat != null || edits[p.id]?.length);
  $("fbUndo").disabled = !edits[p.id]?.length;
  $("fbMove").hidden = $("fbRemove").hidden = !(fr?.lat != null);
  renderAlign(p);
  $("saveNextBtn").hidden = !IS_ADMIN || !(curRating(t)?.fit && curRating(t).fit !== "unknown") || moved;
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
  if (!t.sel) t.sel = newFrisbeeName(t);
  const cur = t.fr[t.sel] || { name: t.sel, lights: [] };
  if (cur.fit === fit && !spotMoved(t)) { cur.fit = "unknown"; delete cur.lat; delete cur.lon; delete cur.angle; }
  else Object.assign(cur, { name: t.sel, fit, lat: fx(c.lat), lon: fx(c.lng), angle: fa(angle), len: dims.len, wid: dims.wid, ez: dims.ez });
  t.fr[t.sel] = cur;
  if (cur.fit === "multi") splitMulti(p, t, cur);
  // Rated fields get light poles placed along their long sides (4 to start) until a pole
  // is moved by hand; cleared ratings keep whatever lights they had.
  if (cur.fit !== "unknown" && hasLights(t) && cur.lightCount) placeLights(p, cur);
  syncFromFields(t);
  // Rated: the decision buttons come back; the bar stays for lights and "Next field".
  fitArmed = false;
  drawParkFields(p); drawLights(p); renderTags(p); previewFields(p); renderCentre();
}
// "2 × full 7v7" becomes two single fields: the field as placed plus a twin beside it (a
// field-width over) or end to end (a field-length on). The direction that maximises the
// venue's council area under the twin wins, with overlap of other frisbee fields counted
// against it at half weight. Overlap is allowed while drafting: the roll-up resolves it.
function splitMulti(p, t, F) {
  const W = F.wid || dims.wid, { kx, ky } = metric(F.lat), th = (F.angle || 0) * Math.PI / 180;
  // Field-local offset (u along the length, v across) → a copy of F moved by it.
  const shift = (u, v) => ({ ...F, lat: fx(F.lat - (u * Math.sin(th) + v * Math.cos(th)) / ky), lon: fx(F.lon + (u * Math.cos(th) - v * Math.sin(th)) / kx) });
  const L = F.len || dims.len;
  const others = Object.values(t.fr).filter(x => x !== F && x.lat != null && x.fit && x.fit !== "unknown");
  const cf = fieldKeys(p).map(({ f }) => toXY(f.p, F.lat, F.lon)), xy = fr => toXY(frisbeeCorners(fr), F.lat, F.lon), fa = (F.len || dims.len) * W;
  const taken = [xy(F), ...others.map(xy)];
  // Under a candidate, sampled on a 2 m grid: council area (any of the venue's council
  // fields) and area already under another frisbee field.
  const measure = txy => { const xs = txy.map(q => q[0]), ys = txy.map(q => q[1]); let inC = 0, inF = 0;
    for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x += 2) for (let y = Math.min(...ys) + 1; y < Math.max(...ys); y += 2) {
      const q = [x, y]; if (!insideXY(q, txy)) continue;
      if (cf.some(c => insideXY(q, c))) inC++; if (taken.some(r => insideXY(q, r))) inF++; }
    return { council: inC * 4, overlap: inF * 4 }; };
  // Side by side (either long side) or end to end (either end), whichever covers most free
  // council area; ties prefer side by side, as listed.
  const cand = [[0, W], [0, -W], [L, 0], [-L, 0]].map(([u, v]) => { const tw = shift(u, v), txy = xy(tw);
    const hit = others.map(o => ({ o, r: areaXY(clipXY(xy(o), txy)) / fa })).sort((a, b) => b.r - a.r)[0];
    const m = measure(txy);
    return { tw, hit, ov: hit?.r || 0, score: m.council - 0.5 * m.overlap, end: u !== 0 }; }).sort((a, b) => b.score - a.score || a.ov - b.ov)[0];
  F.fit = "full";
  const name = newFrisbeeName(t);
  t.fr[name] = { name, fit: "full", lat: cand.tw.lat, lon: cand.tw.lon, angle: F.angle, len: F.len, wid: F.wid, ez: F.ez, pair: F.name };
  F.pair = name;
  setStatus(`2 × full 7v7: ${F.name} and ${name} set ${cand.end ? "end to end" : "side by side"} as two single fields.`);
}
// Auto-placed light poles: n poles (always even) split evenly between the field's two long
// sides, a few metres outside the sideline. The first pair goes on the long side nearer the
// council field's own edge (the sideline most likely to have poles), the next pair opposite,
// then one more each side per +2, spaced evenly along the length.
const POLE_OFFSET = 3;   // metres outside the sideline
function placeLights(p, fr) {
  const n = Math.max(0, fr.lightCount || 0), per = n / 2;
  const lat0 = fr.lat, lon0 = fr.lon, th = (fr.angle || 0) * Math.PI / 180;
  const kx = M_PER_DEG * Math.cos(lat0 * Math.PI / 180), ky = M_PER_DEG;
  // Field-local (u along the length, v across) → lat/lon; the field is drawn rotated
  // clockwise on screen, so screen-x = u·cos − v·sin, screen-y (down) = u·sin + v·cos.
  const at = (u, v) => { const ex = u * Math.cos(th) - v * Math.sin(th), sy = u * Math.sin(th) + v * Math.cos(th);
    return [fx((lat0 - sy / ky)), fx((lon0 + ex / kx))]; };
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
  // The field's own auto-placed poles are replaced; a new spot within 7 m of a pole already
  // standing (by hand, or another field's) is that pole: two fields side by side have their
  // pole lines 6 m apart, either side of the shared edge. New poles shine across the field.
  const t = tagsFor(p);
  t.lightPts = t.lightPts.filter(q => q[3] !== fr.name);
  out.forEach(q => { const near = t.lightPts.map(o => Math.hypot((o[0] - q[0]) * ky, (o[1] - q[1]) * kx)).sort((a, b) => a - b)[0];
    if (!(near <= 7)) t.lightPts.push([q[0], q[1], Math.round(bearingTo(q, [lat0, lon0])), fr.name]); });
}
// The lights button cycles ❓ unknown → 🚫 no lights → 💡 lights. In 💡 each tap adds two
// poles along the selected field's long sides, up to 8, then the next tap goes back to 0.
// A bulb can be dragged out in any state (that also answers "lights"). The small ? resets
// the park's lights to unknown.
const LIGHTS_MAX = 8;
const hasLights = t => t.lights === "full" || t.lights === "training";
function renderDispenser(p) {
  const t = tagsFor(p), arr = t.lightPts, lit = hasLights(t), fr = t.sel && t.fr[t.sel];
  const src = $("bulbSrc");
  src.textContent = lit ? "💡" : t.lights === "none" ? "🚫" : "?";   // unknown: "?" over a half-lit bulb (CSS)
  src.className = "bulbsrc " + (lit ? "lit" : t.lights === "none" ? "dark" : "unknown");
  src.setAttribute("aria-label", lit ? `Lights: ${arr.length} pole${arr.length === 1 ? "" : "s"}. Tap to add two (up to ${LIGHTS_MAX}), or drag a bulb onto a pole`
    : t.lights === "none" ? "No lights. Tap for lights, or drag a bulb onto a pole" : "Lights unknown. Tap for no lights, or drag a bulb onto a pole");
  $("dispenser").title = lit ? (fr?.lat != null ? `${t.sel}: tap to add two poles (up to ${LIGHTS_MAX}, then back to 0); drag bulbs to place them by hand` : "Lights: drag a bulb onto each pole (lock the field on a council field to place poles by tapping)")
    : t.lights === "none" ? "No lights — tap if there are lights" : "Lights unknown — tap for no lights, tap again for lights";
  $("bulbCount").hidden = !lit; $("bulbCount").textContent = arr.length;
  $("lightsReset").hidden = !(t.lights !== "unknown" || allLights(t).length);
}
function tapLights(p) {
  const t = tagsFor(p); snap(p);
  if (t.lights === "unknown") { t.lights = "none"; t.lightPts = []; Object.values(t.fr).forEach(x => { delete x.lightCount; }); }
  else if (t.lights === "none") t.lights = "full";
  else {
    const fr = t.sel && t.fr[t.sel];
    if (!fr || fr.lat == null) { setStatus("Lock the field on a council field to place its poles by tapping, or drag bulbs onto the poles."); renderDispenser(p); return; }
    const cur = fr.lightCount ?? fieldPoles(t, fr).length;
    fr.lightCount = cur >= LIGHTS_MAX ? 0 : Math.min(LIGHTS_MAX, (cur % 2 ? cur + 1 : cur + 2));
    placeLights(p, fr);
  }
  syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p);
}
function resetLights(p) {
  const t = tagsFor(p); snap(p);
  t.lights = "unknown"; t.lightPts = [];
  Object.values(t.fr).forEach(x => { delete x.lightCount; });
  syncFromFields(t); drawLights(p); drawParkFields(p); renderTags(p);
  setStatus(`${p.name}: lights reset to unknown.`);
}
function renderCentre() {
  const p = current(), t = p ? tagsFor(p) : null, moved = !!t && spotMoved(t);
  $("centreWrap").classList.toggle("unlocked", rotating);
  const rated = !!t && curRating(t)?.fit && curRating(t).fit !== "unknown";
  $("centreWrap").classList.toggle("needfit", !rotating && !!t && (!rated || moved));
  $("centreIco").textContent = rotating ? "🔓" : "🔒";
  $("centreLbl").textContent = rotating ? (matchMedia("(hover: none)").matches ? "Tap to lock it here" : "Click to lock it here")
    : !curRating(t) ? "Unlock to place the field"
    : moved ? "Moved · lock it again" : !rated ? `${t.sel}: rate the fit` : `${t.sel}: ${FIT_LABEL[curRating(t).fit]}`;
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
    // Lights (saved review, or unsaved edits) show as ⚡ inside the park's own marker.
    const lt = draft[p.id]?.lights ?? r?.lights, lit = lt === "full" || lt === "training";
    const dotEdge = top ? "#e0a647" : isCur ? "#15211c" : fl ? PRIV_COLOR : "#ffffff", dotW = top || isCur || fl ? 3 : 1.5;
    const mk = logoOp ? logoMarker(ll, logoOp.icons, isAmua ? "#e0a647" : ult.length ? ULT_COLOR : PRIV_COLOR, isCur, 600, false, lit)
      : isAmua ? amuaMarker(ll, col, isCur, lit) : pv?.length ? privMarker(ll, col, isCur, top, clubCol, lit)
      : lit ? L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
          html: `<div class="dotpin" style="background:${col};opacity:${r ? 1 : 0.8};border:${dotW}px ${fl ? "dashed" : "solid"} ${dotEdge}"><span class="litin" aria-label="Lights">⚡</span></div>` }),
          keyboard: false, bubblingMouseEvents: false, zIndexOffset: 300 })
      : L.circleMarker(ll, { radius: r ? 8 : 6, color: dotEdge, weight: dotW, dashArray: fl ? "3 3" : null,
      fillColor: col, fillOpacity: r ? 0.95 : 0.7, bubblingMouseEvents: false });
    const tags = r ? [r.decision === "top" ? "★ Top pick" : r.decision === "yes" ? "Shortlisted" : r.decision === "rating" ? "Rating in progress" : "Rejected",
      r.quality ? r.quality + "/5" : "", r.fit && r.fit !== "unknown" ? FIT_LABEL[r.fit] : "",
      r.lights === "full" || r.lights === "training" ? "💡 lights" : r.lights === "none" ? "no lights" : ""].filter(Boolean).join(" · ") : "Not rated yet";
    mk.bindTooltip(`<b>${esc(p.name)}</b><br>${esc(p.region)} · <b style="color:${col}">${suitWord(r)}</b><br>${esc(tags)}${r?.fields ? "<br>Fields: " + esc(r.fields) : ""}`
      + (isAmua ? `<br><b style="color:#b7791f">★ Book only through: AMUA</b>`
        : pv?.length ? `<br><b style="color:${PRIV_COLOR}">◆ Privately managed: contact ${esc(pv[0].short)}</b> first` : "")
      + (ult.length ? `<br><b style="color:${ULT_COLOR}">🥏 ${ult.some(o => o.booking_only) ? "Book only through" : "Ultimate club"}: ${esc(ult.map(o => o.operator).join(", "))}</b>` : "")
      + (flags[p.id] ? `<br><b style="color:${PRIV_COLOR}">✎ ${esc(amendText(flags[p.id]))}</b>${flags[p.id].website ? `<br>🔗 ${esc(flags[p.id].website.replace(/^https?:\/\//, ""))}` : ""}` : "")
      + (diamonds(p).length ? `<br><b style="color:#c2410c">⚾ Softball / baseball ground: mounds may make it unsuitable in summer</b>` : "")
      + (workMode === "book" ? `<br>${nAct ? `📌 ${nAct} active booking field${nAct > 1 ? "s" : ""} · ` : ""}${inCart ? `🛒 ${inCart} in the cart · ` : ""}<i>Click to book fields</i>` : `<br><i>Click to rate</i>`),
      { className: "parktip", direction: "top", offset: [0, -6] });
    mk.on("click", () => openPark(p.id));
    mk.addTo(cityLayer);
    const fs = councilFields(p, 0);
    const chosen = new Set((r?.fields || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
    fs.forEach(f => L.polygon(f.p, { pane: "fieldsPane", color: col, weight: chosen.has((f.n || "").toLowerCase()) ? 3 : 1.5, fillColor: col,
      fillOpacity: chosen.has((f.n || "").toLowerCase()) ? 0.45 : 0.22, bubblingMouseEvents: false })
      .bindTooltip(`${esc(p.name)}${f.n ? " · " + esc(f.n) : ""} — ${suitWord(r)}`, { className: "parktip", sticky: true })
      .on("click", () => openPark(p.id)).addTo(cityFieldsLayer));
  });
  drawMyFieldPins(reg);
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
// My fields on the Auckland map: a 📌 per park with fields in the cart or active for the
// booker chosen in My fields (everyone's for admins until one is picked). Teal = active,
// amber = cart only; the count is the number of fields; click opens the park.
// The header's region and review-status dropdowns filter My fields (table and pins) too.
function mfMatches(x) {
  const p = BYID[x.park_id], reg = $("region").value, m = $("mode").value;
  if (!p) return !reg && (m === "all" || m === "todo");   // community facilities aren't rated parks
  if (reg && p.region !== reg) return false;
  const d = reviews[p.id]?.decision;
  return m === "all" || (m === "todo" ? !d || d === "rating" : d === m);
}
function mfBookerList() {
  const who = mfWho === null ? (IS_ADMIN ? "" : whoBooks()) : mfWho;
  return who ? [who] : Object.keys(bookLocs);
}
function drawMyFieldPins(reg) {
  const byPlace = new Map();
  mfBookerList().forEach(w => (bookLocs[w] || []).filter(x => !isRetired(x) && mfMatches(x)).forEach(x => {
    const op = x.id.startsWith("cm-") ? (PRIV.operators || []).find(o => "cm-" + o.id === x.id) : null;
    const p = BYID[x.park_id];
    if (p && reg && p.region !== reg) return;
    const ll = p ? parkLatLng(p) : op ? [op.lat, op.lon] : null; if (!ll) return;
    const k = p ? p.id : x.id;
    if (!byPlace.has(k)) byPlace.set(k, { ll, park: p, name: p?.name || x.park, items: [] });
    byPlace.get(k).items.push({ x, w });
  }));
  byPlace.forEach(({ ll, park, name, items }) => {
    const act = items.some(i => isActive(i.x)), n = items.length;
    const lines = items.map(i => `${isActive(i.x) ? "📌" : "🛒"} ${esc(i.x.field)}${mfWho ? "" : ` · ${esc(personFromEmail(i.w))}`}`).join("<br>");
    L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [26, 30], iconAnchor: [13, 34],
        html: `<div class="myfpin ${act ? "act" : "cart"}"><span>📌</span>${n > 1 ? `<b>${n}</b>` : ""}</div>` }),
      zIndexOffset: 800, keyboard: false, bubblingMouseEvents: false })
      .bindTooltip(`<b>${esc(name)}</b> — my fields<br>${lines}`, { className: "parktip", direction: "top", offset: [0, -30] })
      .on("click", () => { if (park) openPark(park.id); })
      .addTo(cityLayer);
  });
}
// AMUA's existing providers (GTEC, booked through CPSA at Cornwall Park): a gold star whose
// centre shows the suitability colour.
// A round badge per logo (several overlap if a ground lists more than one). The
// image sits over the club's letters; if the logo file isn't there yet it removes itself.
// Sizes: AMUA's own badge 36px, other clubs and venues 27px, community facilities 18px.
// Every park marker can carry the lights symbol inside it (`lit`), so a park is one icon.
function logoMarker(ll, icons, ring, isCur, z = 600, small = false, lit = false) {
  const badge = (ic, i) => `<span class="lp" style="background:${ic.bg || "#334155"};z-index:${9 - i}"><b>${esc(ic.mono || "")}</b>`
    + (ic.img ? `<img src="${BASE}council-maps/${esc(ic.img)}" alt="" onerror="this.remove()">` : "") + `</span>`;
  const d = small ? 18 : icons.some(ic => ic.mono === "AMUA") ? 36 : 27, w = d + (icons.length - 1) * (d * 2 / 3);
  return L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [w, d], iconAnchor: [w / 2, d / 2],
    html: `<div class="logopin${isCur ? " cur" : ""}${d <= 18 ? " sm" : d < 36 ? " md" : ""}" style="--ring:${ring}">${icons.map(badge).join("")}${lit ? `<span class="litin" aria-label="Lights">⚡</span>` : ""}</div>` }), keyboard: false, bubblingMouseEvents: false, zIndexOffset: z });
}
function amuaMarker(ll, fill, isCur, lit = false) {
  return L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="amuapin${isCur ? " cur" : ""}"><div><span style="background:${fill}"></span></div>${lit ? `<span class="litin" aria-label="Lights">⚡</span>` : ""}</div>` }), keyboard: false, bubblingMouseEvents: false, zIndexOffset: 500 });
}
function privMarker(ll, fill, isCur, top, club, lit = false) {
  const style = club
    ? `background:${club.pattern || club.fill};border-color:${club.edge || "#fff"};box-shadow:0 0 0 2.5px ${PRIV_COLOR},0 1px 5px rgba(0,0,0,.5);width:18px;height:18px;margin:2px`
    : `background:${fill};${top ? "border-color:#e0a647;" : ""}margin:3px`;
  return L.marker(ll, { icon: L.divIcon({ className: "", iconSize: [26, 26], iconAnchor: [13, 13],
    html: `<div class="privpin${isCur ? " cur" : ""}" style="${style}">${lit ? `<span class="litin" aria-label="Lights">⚡</span>` : ""}</div>` }), keyboard: false, bubblingMouseEvents: false });
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
// The provider line shows names only; contacts and details open under ⓘ.
function privBanner(all) {
  const ult = all.filter(o => o.code === "ultimate" && !o.booking_only), ops = all.filter(o => o.code !== "ultimate" || o.booking_only);
  const ultLine = ult.map(o => `<span class="pb-ult"><b>🥏 ${esc(o.short || o.operator)}</b></span>`).join("");
  if (!ops.length) return ultLine;
  const [lead, ...rest] = ops;
  const amua = all.find(o => o.must_book_through === "AMUA");
  if (amua) return `<span class="pb-amua pb-only"><b>★ Booking only through AMUA</b> — <a href="${BASE}">booking site ↗</a></span>` + ultLine;
  const more = rest.length ? ` <span class="pb-more">+ ${rest.map(o => esc(o.short || o.operator)).join(", ")}</span>` : "";
  if (lead.booking_only) return `<span class="pb-ult pb-only"><b>🥏 Booking only through ${esc(lead.short || lead.operator)}</b>${more}</span>` + ultLine;
  return `<span><b>◆ ${esc(lead.operator)}</b>${more}</span>` + ultLine;
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
    + `<div class="lg-b">${row(`hsl(${suitHue(0.95)} 72% 42%)`, "Excellent")}${row(`hsl(${suitHue(0.7)} 72% 42%)`, "Good")}${row(`hsl(${suitHue(0.5)} 72% 42%)`, "Fair")}${row(`hsl(${suitHue(0.2)} 72% 42%)`, "Poor")}${row("#b3372d", "Rejected")}${row("#8a958f", "Not rated")}<div><span class="dia" style="background:linear-gradient(45deg,#f2b705 50%,#c8102e 50%);border-color:#f2b705;box-shadow:0 0 0 2px ${PRIV_COLOR}"></span><b>Ultimate club home</b> <span class="lg-note">(club colours)</span></div><div><span class="amualg"><span></span></span><b>AMUA venue</b> <span class="lg-note">(GTEC · CPSA)</span></div><div><span class="logolg">A</span>Club or venue logo</div><div><span class="logolg" style="border-color:${COMM_COLOR}">S</span>Community facility <span class="lg-note">(school)</span></div><div><span class="dia"></span>Privately managed</div><div><i style="background:#8a958f;border:2px dashed ${PRIV_COLOR};box-shadow:none"></i>Flagged: probably club-run</div><div><span class="litbadge lg">⚡</span>Lights <span class="lg-note">(shown inside the park's marker)</span></div><div class="lg-note">Gold ring = top pick</div></div>`;
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
// Remove the selected frisbee field (its 2 × partner stays, now unpaired).
function removeField(p) {
  const t = tagsFor(p), key = t.sel; if (!key || !t.fr[key]) return;
  snap(p);
  delete t.fr[key];
  t.lightPts = t.lightPts.filter(q => q[3] !== key);   // the poles it auto-placed go with it
  Object.values(t.fr).forEach(x => { if (x.pair === key) delete x.pair; });
  t.sel = null; fitArmed = false; $("fitPop").hidden = true;
  syncFromFields(t); drawParkFields(p); drawLights(p); renderTags(p); renderCentre();
  setStatus(`Removed ${key}. ↶ Undo (Z) brings it back.`);
}
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
let bookLocs = {}, bookFor = "";
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
async function loadBookLocs() {
  if (supabase && session) {
    const { data, error } = await supabase.from("settings").select("value").eq("key", BOOK_KEY).maybeSingle();
    if (!error) { bookLocs = data?.value || {}; savedLocs = Object.fromEntries(Object.keys(bookLocs).map(w => [w, locsSnap(w)])); return; }
  }
  bookLocs = store.get("vet-booklocs", {});
}
// Cart changes go to the booking site's activity log (fields added, made active, removed),
// stamped with who on the login made them.
const locsSnap = who => Object.fromEntries((bookLocs[who] || []).map(x => [x.id, { park: x.park, field: x.field, status: x.status || "cart" }]));
async function logCartChange(who, before) {
  if (!supabase || !session) return;
  const after = locsSnap(who), lbl = x => `${x.park} · ${x.field}`;
  const added = Object.keys(after).filter(k => !before[k]).map(k => lbl(after[k]));
  const removed = Object.keys(before).filter(k => !after[k]).map(k => lbl(before[k]));
  const activated = Object.keys(after).filter(k => before[k] && before[k].status !== "active" && after[k].status === "active").map(k => lbl(after[k]));
  const retired = Object.keys(after).filter(k => before[k] && before[k].status !== "retired" && after[k].status === "retired").map(k => lbl(after[k]));
  if (!added.length && !removed.length && !activated.length && !retired.length) return;
  const actor = getActor(session.user.email);
  try {
    await supabase.from("activity_log").insert({ user_id: session.user.id, user_email: session.user.email, session_id: "vetting", action: "council_fields",
      detail: { booker: who, added, removed, activated, retired, by: IS_ADMIN ? "admin" : "booker", ...(actor ? { actor } : {}) } });
  } catch { /* the log is best-effort */ }
}
async function saveBookLocs() {
  const logWho = whoBooks(), logBefore = savedLocs[logWho] || {};
  const ok = await saveBookLocsRaw();
  if (ok) { logCartChange(logWho, logBefore); savedLocs[logWho] = locsSnap(logWho); }
  return ok;
}
let savedLocs = {};   // per booker, the cart as last loaded/saved (to log what changed)
async function saveBookLocsRaw() {
  if (supabase && session && !IS_ADMIN) {
    // Bookers can only change their own cart, through a database function.
    const who = whoBooks();
    const { data, error } = await supabase.rpc("set_my_council_facilities", { entries: bookLocs[who] || [] });
    if (error) { setStatus("Couldn't save your cart (" + error.message + "). An admin may need to run supabase-setup.sql.", true); return false; }
    bookLocs = data || {}; return true;
  }
  if (supabase && session) {
    // Only this booker's list changes, so two admins editing different bookers don't collide.
    const who = bookFor.toLowerCase(), list = bookLocs[who] || [];
    const { value, error } = list.length ? await mergeSetting(BOOK_KEY, { [who]: list }) : await mergeSetting(BOOK_KEY, {}, [who]);
    if (error) { setStatus("Couldn't save booking locations (" + error.message + ").", true); return false; }
    bookLocs = value; return true;
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
    added_at: new Date().toISOString(), ...addedBy() });
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
// Stamped on cart entries: the account and, on a shared login, the person using it.
const addedBy = () => { const e = session?.user?.email || "", n = getActor(e); return { added_by: e, ...(n ? { added_by_name: n } : {}) }; };
const activatedBy = () => { const n = getActor(session?.user?.email || ""); return n ? { activated_by_name: n } : {}; };
const myLocs = () => bookLocs[whoBooks()] || [];
// "retired": a field replaced when the venue's fields were regrouped; kept so bookings on it
// keep their name, but neither active nor in the cart.
const isRetired = x => x.status === "retired";
const cartOf = () => myLocs().filter(x => x.status === "cart" || (!isActive(x) && !isRetired(x)));
const activeOf = () => myLocs().filter(isActive);
const locState = id => { const x = myLocs().find(y => y.id === id); return !x || isRetired(x) ? null : isActive(x) ? "active" : "cart"; };
// Save every cart field as an active booking.
async function saveCartActive() {
  const who = whoBooks(), before = myLocs().map(x => ({ ...x })), n = cartOf().length;
  if (!n) return;
  const at = new Date().toISOString();
  bookLocs[who] = before.map(x => isActive(x) || isRetired(x) ? x : { ...x, status: "active", activated_at: at, ...activatedBy() });
  if (!(await saveBookLocs())) { bookLocs[who] = before; return; }
  setStatus(`Saved ${n} field${n > 1 ? "s" : ""} as active bookings. They're now in the booking site under Vendor → Location.`);
  render(); renderTabs(); if (view === "book") renderBook();
}
// Add or remove one field (or "Whole park") of a park in the booker's cart; saves at once.
async function toggleCart(p, key) {
  // A council area that's part of a saved frisbee group books the whole group.
  const grp = (reviews[p.id]?.placement?.groups || []).find(g => g.council?.includes(key));
  if (grp) key = grp.key;
  const who = whoBooks(), before = [...(bookLocs[who] || [])], list = [...before], id = cartId(p, key);
  let i = list.findIndex(x => x.id === id);
  if (i >= 0 && isRetired(list[i])) { list.splice(i, 1); i = -1; }
  if (i >= 0 && isActive(list[i])) {
    setStatus(`${p.name} – ${key} is an active booking. Remove it under 📌 My fields.`); return;
  }
  if (i >= 0) list.splice(i, 1);
  else {
    const wf = parkWorkflow(p), f = fieldKeys(p).find(x => x.key === key)?.f, c = grp ? grp.c : f?.c || [p.lat, p.lon];
    list.push({ id, park_id: p.id, park: p.name, region: p.region, field: grp ? grp.name : key, lat: c[0], lon: c[1], kind: wf.kind, operator: wf.operator, status: "cart",
      ...(grp ? { council_fields: grp.council, frisbee: grp.cap, fit: grp.fit } : {}), added_at: new Date().toISOString(), ...addedBy() });
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
// ── My fields: every booker's council fields as one table (default: the signed-in booker) ──
// Field · Booker · Carted · Active · Started (first accepted booking) · Ended (retired, or the
// last booking once none are upcoming) · ★ crowd rating. The booker's cart can be saved as
// active here; another booker's rows are read-only unless you're an admin.
let mfWho = null, mfStage = "all";
// Removal cart: fields marked ✕ wait here (struck through) until "Remove N" — no popup.
const mfRemove = new Map();   // cart entry id -> booker email   // mfWho: booker email, "" = all bookers (null = you)
let fieldBookings = null;            // facility_id -> [{date, status, email}] from Facility Booking
const ACCEPTED = new Set(["approved", "council_granted", "cpsa_confirmed"]);
async function loadFieldBookings() {
  if (!supabase || !session) { fieldBookings = {}; return; }
  const { data, error } = await supabase.from("bookings").select("facility_id,date,status,email").or("facility_id.like.cf-%,facility_id.like.cm-%");
  fieldBookings = {};
  if (!error) (data || []).forEach(r => (fieldBookings[r.facility_id] ||= []).push(r));
  if (view === "book") renderBook();
}
const mfDate = iso => { if (!iso) return ""; const d = new Date(String(iso).length === 10 ? iso + "T12:00" : iso); if (isNaN(d)) return "";
  return d.toLocaleDateString("en-NZ", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "2-digit" } : {}) }); };
function mfTimeline(x, who) {
  const today = new Date().toISOString().slice(0, 10);
  const bk = (fieldBookings?.[x.id] || []).filter(r => (r.email || "").toLowerCase() === who && !["rejected", "cancelled"].includes(r.status)).sort((a, b) => a.date.localeCompare(b.date));
  const acc = bk.filter(r => ACCEPTED.has(r.status));
  const started = acc[0]?.date || "";
  const ended = isRetired(x) ? x.retired_at : bk.length && !bk.some(r => r.date >= today) ? bk[bk.length - 1].date : "";
  const pending = !started && bk.length ? bk.length : 0;
  return { started, ended, pending, next: bk.find(r => r.date >= today)?.date || "" };
}
function renderBook() {
  const me = whoBooks();
  if (mfWho === null) mfWho = IS_ADMIN ? "" : me;   // admins see every booker by default
  const bookers = Object.keys(bookLocs).filter(e => (bookLocs[e] || []).length).sort();
  if (mfWho && !bookers.includes(mfWho)) bookers.unshift(mfWho);
  const rows = (mfWho ? [mfWho] : bookers).flatMap(w => (bookLocs[w] || []).map(x => ({ x, w })));
  const stageOf = ({ x, w }) => isRetired(x) || mfTimeline(x, w).ended ? "ended" : isActive(x) ? "active" : "cart";
  const counts = { all: 0, cart: 0, active: 0, ended: 0 }; rows.filter(r => mfMatches(r.x)).forEach(r => { counts.all++; counts[stageOf(r)]++; });
  // Header dropdowns: region and review status filter; the order sorts (least viewed parks
  // first, A–Z, or the default: cart, active, ended, newest first).
  const ord = $("order").value, rank = { cart: 0, active: 1, ended: 2 };
  const byDefault = (a, b) => rank[stageOf(a)] - rank[stageOf(b)] || (b.x.activated_at || b.x.added_at || "").localeCompare(a.x.activated_at || a.x.added_at || "");
  const matching = rows.filter(r => mfMatches(r.x)), hidden = rows.length - matching.length;
  const shown = matching.filter(r => mfStage === "all" || stageOf(r) === mfStage)
    .sort((a, b) => ord === "alpha" ? (a.x.park || "").localeCompare(b.x.park || "") || (a.x.field || "").localeCompare(b.x.field || "") || byDefault(a, b)
      : ord === "least" ? viewsOf(a.x.park_id) - viewsOf(b.x.park_id) || byDefault(a, b) : byDefault(a, b));
  const canEdit = w => IS_ADMIN || w === (session?.user?.email || "demo@local").toLowerCase();
  const editable = mfWho && canEdit(mfWho), cart = editable ? (bookLocs[mfWho] || []).filter(x => !isActive(x) && !isRetired(x)) : [];
  if (IS_ADMIN && mfWho) bookFor = mfWho;   // admins' cart clicks in Book mode go to the booker shown
  const prov = x => x.kind === "community" ? "cm_" + x.operator.id : x.kind === "council_private" ? "op_" + x.operator.id : "akl_council";
  const tag = x => x.kind === "community" ? `<span class="mf-tag comm" title="Community facility">🏫</span>` : x.kind === "council_private" ? `<span class="mf-tag priv" title="${esc(x.operator?.name || "operator")} + council">◆</span>` : `<span class="mf-tag" title="Council">🏛</span>`;
  const who = w => esc(personFromEmail(w));
  // Who added it: the person picked at sign-in, else the adding account when it isn't the booker's.
  const byWho = (x, w) => x.added_by_name ? shortName(x.added_by_name) : x.added_by && x.added_by.toLowerCase() !== w ? personFromEmail(x.added_by) : "";
  const stars = id => { const a = crowdAvg(id); return a ? `<span title="${ratings[id].n} rating${ratings[id].n > 1 ? "s" : ""}">★${a.toFixed(1)}</span>` : `<span class="mf-none">–</span>`; };
  const cell = (k, v, title) => `<td class="mf-d" data-k="${k}"${title ? ` title="${esc(title)}"` : ""}>${v || `<span class="mf-none">–</span>`}</td>`;
  loadContact(mfWho || me);
  if (fieldBookings === null) { fieldBookings = {}; loadFieldBookings(); }
  $("bookPanel").innerHTML = `<div class="mf-head">
      <select id="mfWho" aria-label="Booker">${[...new Set([me, ...bookers])].map(e => `<option value="${esc(e)}"${e === mfWho ? " selected" : ""}>${e === me ? "Me" : who(e)} · ${esc(e.split("@")[0])}</option>`).join("")}
        <option value=""${mfWho === "" ? " selected" : ""}>All bookers</option></select>
      <div class="mf-stages">${[["all", "All"], ["cart", "🛒 Cart"], ["active", "📌 Active"], ["ended", "Ended"]].map(([k, l]) => `<button data-mfstage="${k}" aria-pressed="${mfStage === k}">${l} <b>${counts[k]}</b></button>`).join("")}</div></div>
    ${mfWho ? contactNote(mfWho) : ""}
    ${cart.length ? `<div class="mf-go"><span>${cart.length} field${cart.length === 1 ? "" : "s"} in the cart, not bookable yet.</span><button class="primary" id="bkSave">✅ Save as active</button></div>` : ""}
    ${mfRemove.size ? `<div class="mf-go mf-rmbar"><span>🗑 ${mfRemove.size} field${mfRemove.size === 1 ? "" : "s"} queued for removal${[...mfRemove.keys()].some(id => Object.values(bookLocs).flat().find(x => x.id === id && isActive(x))) ? " — active ones stop being offered in Facility Booking (existing bookings stay)" : ""}.</span>
      <button id="mfRmClear">Clear</button><button class="danger" id="mfRmGo">Remove ${mfRemove.size}</button></div>` : ""}
    ${hidden ? `<p class="mf-hidden">${hidden} field${hidden === 1 ? " is" : "s are"} hidden by the region / review filters above. <button id="mfShowAll">Show all</button></p>` : ""}
    ${shown.length ? `<div class="mf-wrap"><table class="mf"><thead><tr><th>Field</th><th title="The booker, and who on the login added the field">Booker · by</th><th title="Added to the cart">Carted</th><th title="Saved as an active booking field">Active</th>
      <th title="First booking the council / vendor accepted">Started</th><th title="Field retired, or its last booking once none are upcoming">Ended</th><th title="Crowd quality rating">★</th><th></th></tr></thead><tbody>
      ${shown.map(r => { const { x, w } = r, t = mfTimeline(x, w), st = stageOf(r);
        return `<tr class="mf-${st}${mfRemove.has(x.id) ? " mf-rm" : ""}"><td class="mf-f"><span class="mf-st ${st}" title="${st === "cart" ? "In the cart" : st === "active" ? "Active" : "Ended"}"></span>${tag(x)}
            <span class="mf-n" title="${esc(x.park)} – ${esc(x.field)}">${esc(x.park)} <span class="muted">– ${esc(x.field)}</span></span></td>
          <td class="mf-w" title="${esc(w)}${x.added_by ? " · added by " + esc(x.added_by_name ? `${x.added_by_name} (${x.added_by})` : x.added_by) : ""}${x.activated_by_name ? " · made active by " + esc(x.activated_by_name) : ""}">${who(w)}${byWho(x, w) ? `<span class="mf-by"> · ${esc(byWho(x, w))}</span>` : ""}</td>
          ${cell("Carted", mfDate(x.added_at), x.added_by && x.added_by !== w ? "Added by " + x.added_by : "")}${cell("Active", mfDate(x.activated_at))}
          ${cell("Started", t.started ? mfDate(t.started) : t.pending ? `<span class="mf-pend">${t.pending} pending</span>` : "", t.next ? "Next booking " + mfDate(t.next) : "")}${cell("Ended", mfDate(t.ended))}
          <td class="mf-r">${stars(x.park_id)}</td>
          <td class="mf-a">${x.kind === "community" ? "" : `<button data-bkopen="${esc(x.park_id)}" title="Open this park">↗</button>`}${isActive(x) ? `<a href="${venueLink(prov(x), x.park)}" target="_blank" rel="noopener" title="Book dates in Facility Booking">📅</a>` : ""}${canEdit(w) && !isRetired(x) ? (mfRemove.has(x.id) ? `<button data-bkdel="${esc(x.id)}" data-bkw="${esc(w)}" title="Keep this field (take it out of the removal cart)">↶</button>` : `<button data-bkdel="${esc(x.id)}" data-bkw="${esc(w)}" title="Add to the removal cart">✕</button>`) : ""}</td></tr>`; }).join("")}
      </tbody></table></div>`
    : `<p class="muted">${rows.length ? "Nothing at this stage." : mfWho === me ? (IS_ADMIN ? "No fields yet. ★ Top pick or ✓ Shortlist a park and its rated fields are added here." : "No fields yet. In 📅 Book mode, open a park and tap its field areas to add them to your cart.") : "No fields."}</p>`}`;
}
function renderTabs() { const n = activeOf().length + cartOf().length;
  $("bookTab").innerHTML = `📌<span class="tl"> My fields</span>${n ? ` (${n})` : ""}`; }
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
  $("bookPanel").addEventListener("change", e => { if (e.target.id === "mfWho") { mfWho = e.target.value; renderBook(); renderTabs(); buildCity(); } });
  $("bookBar").addEventListener("change", e => { if (e.target.id === "bookWho2") who(e); });
  $("bookBar").addEventListener("click", e => { const p = current(); if (!p) return;
    const un = e.target.closest("[data-uncart]"); if (un) return toggleCart(p, un.dataset.uncart);
    if (e.target.id === "bbWhole") return toggleCart(p, "Whole park");
    if (e.target.id === "bbCart") setView("book");
    if (e.target.id === "bbSave") saveCartActive(); });
  $("bookPanel").addEventListener("click", async e => {
    const del = e.target.closest("[data-bkdel]"), stage = e.target.closest("[data-mfstage]");
    if (stage) { mfStage = stage.dataset.mfstage; renderBook(); return; }
    if (e.target.id === "bkSave") return saveCartActive();
    if (del) { const id = del.dataset.bkdel; if (mfRemove.has(id)) mfRemove.delete(id); else mfRemove.set(id, del.dataset.bkw); renderBook(); return; }
    if (e.target.id === "mfRmClear") { mfRemove.clear(); renderBook(); return; }
    if (e.target.id === "mfShowAll") { $("region").value = ""; $("mode").value = "all"; ["region", "mode"].forEach(id => $(id).dispatchEvent(new Event("change"))); return; }
    if (e.target.id === "mfRmGo") {
      // One save per booker; anything that fails stays queued.
      const byBooker = {}; mfRemove.forEach((w, id) => (byBooker[w] ||= []).push(id));
      let removed = 0;
      for (const [w, ids] of Object.entries(byBooker)) {
        if (IS_ADMIN) bookFor = w; else if (w !== whoBooks()) continue;
        const before = bookLocs[w] || [];
        bookLocs[w] = before.filter(x => !ids.includes(x.id));
        if (await saveBookLocs()) { ids.forEach(id => mfRemove.delete(id)); removed += ids.length; } else bookLocs[w] = before;
      }
      setStatus(removed ? `Removed ${removed} field${removed === 1 ? "" : "s"}.` : "Nothing was removed.", !removed);
      renderBook(); renderTabs(); render(); return; }
    const op = e.target.closest("[data-bkopen]"); if (op) { if (workMode !== "book") setMode("book"); openPark(op.dataset.bkopen); }
  });
  $("modeRate").onclick = () => setMode("rate");
  $("modeBook").onclick = () => setMode("book");
}

// ── Render ───────────────────────────────────────────────────────────────────
// The decision buttons, or (in fit mode) the fit buttons in their places.
function updateActions() {
  const p = current(), t = p && tagsFor(p);
  const on = !!(fitArmed && !rotating && t?.sel && IS_ADMIN && workMode !== "book" && view === "park");
  $("actions").classList.toggle("fitmode", on);
}
function renderTags(p) {
  const t = tagsFor(p);
  updateActions(); if (view === "park") { renderAlign(p); renderSoftWarn(p); }
  $("editUndoBtn").disabled = !edits[p.id]?.length;
  // Stars fill to the crowd average; your own rating is ringed. Click to rate (again to clear).
  const avg = crowdAvg(p.id), cnt = ratings[p.id]?.n || 0, mine = ratings[p.id]?.mine || (ratingsShared ? 0 : t.quality), shown = Math.round(avg ?? t.quality ?? 0);
  $("segQuality").innerHTML = [1, 2, 3, 4, 5].map(n => `<button data-tag="quality" data-val="${n}" class="${n === mine ? "mine" : ""}" aria-pressed="${n === mine}" title="Rate ${n}/5${n === mine ? " (your rating — click to clear)" : ""}">${n <= shown ? "★" : "☆"}</button>`).join("");
  $("qAvg").textContent = cnt ? `${avg.toFixed(1)} · ${cnt} rating${cnt > 1 ? "s" : ""}` : "";
  $("qAvg").title = cnt ? `Average of ${cnt} rating${cnt > 1 ? "s" : ""}${mine ? `; yours: ${mine}/5` : ""}` : "";
  // Fit and lights are set on the map (fit bar, bulb dispenser); here they're read-outs.
  const rated = Object.values(t.fr).filter(x => x.fit && x.fit !== "unknown");
  $("fitVal").textContent = rated.length ? rated.map(x => `${x.name}: ${FIT_LABEL[x.fit]}`).join(" · ") : "";
  $("fitVal").classList.toggle("unset", t.fit === "unknown");
  const nl = allLights(t).length, ns = t.sel ? fieldPoles(t, t.fr[t.sel]).length : null;
  $("lightsVal").innerHTML = nl ? `💡 ${nl}<span class="lx"> pole${nl > 1 ? "s" : ""}${ns !== null ? ` (${ns} on ${esc(t.sel)})` : ""}</span>`
    : t.lights === "none" ? "none" : t.lights === "training" || t.lights === "full" ? "yes" : "";
  $("lightsVal").classList.toggle("unset", t.lights === "unknown");
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
async function loadRelations() {
  if (!supabase || !session) { relations = store.get("vet-relations", {}); return; }
  const { data, error } = await supabase.from("settings").select("value").eq("key", REL_KEY).maybeSingle();
  relations = error ? {} : data?.value || {};
}
async function saveRelation(id, rel) {
  const entry = { ...rel, updated_by: session?.user?.email || "", updated_at: new Date().toISOString() };
  if (supabase && session) {
    const { value, error } = await mergeSetting(REL_KEY, { [id]: entry });
    if (error) { setStatus("Couldn't save (" + error.message + ").", true); return false; }
    relations = value;
  } else { relations[id] = entry; store.set("vet-relations", relations); }
  return true;
}
// Rugby and league clubs tend to run their own grounds regardless of council bookings.
const influenceOf = o => o.influence || (["rugby", "league"].includes(o.code) ? "low" : null);
// Contact details (from the operator list) shown first under ⓘ.
const contactHtml = o => { const c = privContacts(o);
  return `<div><span class="ip-k">Contact</span> ${esc(o.operator)}${o.status ? ` <span class="muted">(${esc(privStatus(o))})</span>` : ""}${c ? ` · ${c}` : " · no contact found"}${o.manages ? `<br><span class="muted">${esc(o.manages)}</span>` : ""}${o.notes ? `<br><i>${esc(o.notes)}</i>` : ""}</div>`; };
function infoHtml(ops) {
  const E = PRIV.enums || {}, LBS = PRIV.local_boards || {}, lab = (t, k) => esc(E[t]?.[k] || k);
  return ops.map(o => {
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
      ${contactHtml(o)}
      ${facts ? `<div><span class="ip-k">Local board</span> ${facts}</div>` : ""}
      ${rel.rating || people || events ? `<div><span class="ip-k">Relationship</span> ${rel.rating ? esc(REL.rating[rel.rating]) : ""}${people ? " · " + people : ""}${events ? " · " + events : ""}</div>` : ""}
      ${comm ? `<div><span class="ip-k">Community</span> ${comm}</div>` : ""}${editor}</div>`;
  }).join("");
}
function renderInfo(p) {
  const ops = PRIV_BY_PARK[p.id] || [], any = ops.length > 0, box = $("privBox"), panel = $("infoPanel");
  if (any && !box.hidden) box.insertAdjacentHTML("beforeend", `<button class="pb-info" id="pbInfo" aria-expanded="${infoOpenFor === p.id}" title="Contact details, local board and history">ⓘ</button>`);
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
    const { value, error } = await mergeSetting(CO_KEY, { [p.id]: entry });
    if (error) { setStatus("Couldn't save council-only (" + error.message + ").", true); return false; }
    councilOnlyOv = value;
  } else { councilOnlyOv[p.id] = entry; store.set("vet-council-only", councilOnlyOv); }
  const wf = parkWorkflow(p);
  if (supabase && session) {
    const { data } = await supabase.from("settings").select("value").eq("key", BOOK_KEY).maybeSingle();
    const all = data?.value || {}, changed = {};
    Object.entries(all).forEach(([w, list]) => list.forEach(x => { if (x.park_id === p.id) { x.kind = wf.kind; x.operator = wf.operator; changed[w] = list; } }));
    if (Object.keys(changed).length) {
      const { value, error } = await mergeSetting(BOOK_KEY, changed);
      if (error) { setStatus("Saved, but couldn't update carts (" + error.message + ").", true); return true; }
      bookLocs = value;
    }
  } else Object.values(bookLocs).forEach(list => list.forEach(x => { if (x.park_id === p.id) { x.kind = wf.kind; x.operator = wf.operator; } }));
  setStatus(on ? `${p.name}: council booking only — no private-operator step.` : `${p.name}: private-operator workflow restored.`);
  return true;
}
// Cart entries filed before a park's workflow changed (e.g. a data-file council_only default)
// are re-filed on load, so the booking site uses the current workflow.
async function syncCartWorkflows() {
  if (!IS_ADMIN) return;
  const changed = {};
  Object.entries(bookLocs).forEach(([w, list]) => list.forEach(x => { const p = BYID[x.park_id]; if (!p) return;
    const wf = parkWorkflow(p);
    if (x.kind !== wf.kind || (x.operator?.id || null) !== (wf.operator?.id || null)) { x.kind = wf.kind; x.operator = wf.operator; changed[w] = list; } }));
  if (!Object.keys(changed).length) return;
  if (supabase && session) await mergeSetting(BOOK_KEY, changed);
  else store.set("vet-booklocs", bookLocs);
}
// Provider amendments: tag a park whose provider listing needs changing, e.g. Liston Park is
// privately operated by Ellerslie AFC. Once tagged, the row asks for the provider's contact
// person (first name and last initial only).
const AMEND_KIND = { private: "Privately operated by", change: "Operator changed to", other: "Other vendor change" };
let amendFor = null;
const amendText = fl => `${AMEND_KIND[fl.kind || "private"]}${fl.club ? " " + fl.club : ""}${fl.contact ? " · contact " + fl.contact : ""}`;   // the park whose amendment row is open
// What's already on record for a park's provider: its private operator (and the first
// contact AMUA has for them), or the council for a council-only park.
function knownProvider(p) {
  if (councilOnly(p) && (PRIV_BY_PARK[p.id] || []).length) return { club: "Auckland Council (council only)", kind: "other", contact: "", known: true };
  const ops = PRIV_BY_PARK[p.id] || [], op = ops.find(o => o.code !== "ultimate") || ops[0];
  if (!op) return null;
  return { club: op.short || op.operator, kind: "private", contact: shortName(relations[op.id]?.contacts?.[0]?.name || ""), website: op.contact?.url || "", known: true };
}
function renderFlag(p) {
  const fl = flags[p.id], known = knownProvider(p), d = fl || known || {};
  $("clubFlagBtn").setAttribute("aria-pressed", String(!!fl));
  $("clubFlagBtn").textContent = fl ? "✎ " + amendText(fl) : known ? "✎ " + amendText(known) : "✎ Vendor?";
  $("clubFlagBtn").title = fl ? `Vendor amendment${fl.by ? " by " + fl.by.split("@")[0] : ""}${fl.website ? " · " + fl.website : ""}${fl.details ? " · " + fl.details : ""}. Click to edit.`
    : known ? "Vendor on record. Click to amend it (the fields start from what's on record)."
    : "Tag this park's vendor for amendment, e.g. privately operated by a club that isn't listed yet";
  $("amendRow").hidden = amendFor !== p.id;
  $("amendContact").hidden = $("amendWebsite").hidden = $("amendDetails").hidden = !fl && !known;
  $("amendClear").hidden = !fl;
  const ae = document.activeElement;
  if (ae !== $("clubIn")) $("clubIn").value = d.club || "";
  if (ae !== $("amendKind")) $("amendKind").value = d.kind || "private";
  if (ae !== $("amendContact")) $("amendContact").value = d.contact || "";
  if (ae !== $("amendWebsite")) $("amendWebsite").value = d.website || "";
  if (ae !== $("amendDetails")) $("amendDetails").value = d.details || "";
  if (!$("providerList").options.length)
    $("providerList").innerHTML = [...new Set(PRIV.operators.map(o => o.short || o.operator))].sort().map(n => `<option value="${esc(n)}">`).join("");
}
// A website as typed: "easternsuburbs.org.nz" → "https://easternsuburbs.org.nz".
const websiteValue = v => { v = String(v || "").trim(); return !v ? "" : /^https?:\/\//i.test(v) ? v : "https://" + v; };
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
  $("parkName").textContent = "📌 My fields"; $("parkRegion").textContent = p ? "last park: " + p.name : "";
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
    renderFlag(p); renderCouncilOnly(p); renderSoftWarn(p);
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
    if (fresh) { fitArmed = false; aklNext = false; if (whereMark) { whereMark.remove(); whereMark = null; } document.body.classList.remove("aklzoom"); hideSuburbs(); showMap(p); }
    renderTags(p);
    if (workMode === "book") renderBookBar(p);
    // Coming back to a park with a placed field: lock the field to its saved spot and angle
    // (not the screen centre), select that field and redraw its lights.
    if (fresh) restorePlacement(p);
  }
  ["noBtn", "yesBtn", "topBtn", "skipBtn"].forEach(b => $(b).disabled = !p);
  $("interestBtn").setAttribute("aria-pressed", String(interestsSet()));
  $("skipBtn").title = `Decide later (→ or S)${p ? ` · lowers its activity score (now ${activityOf(p.id)}), so it ranks lower in the queue` : ""}`;
  if (p && visited[visited.length - 1] !== p.id) visited.push(p.id);
  $("backBtn").disabled = !visited.some(id => id !== p?.id);
  renderRail();
}

// ── Decisions ────────────────────────────────────────────────────────────────
function askSpare(p, share) {
  const dlg = $("saveDlg");
  $("dlgTitle").textContent = `Add another frisbee field at ${p.name}?`;
  $("dlgBody").textContent = `About ${Math.round(share * 100)}% of the council field area has no frisbee field on it yet. Would you like to add another frisbee field to the space? `
    + `If you save as it is, that space stays separate rather than being grouped with the nearest field.`;
  return new Promise(res => { dlg.returnValue = ""; dlg.addEventListener("close", () => res(dlg.returnValue || "cancel"), { once: true }); dlg.showModal(); });
}
// Ready the next frisbee field: unlocked over the largest council area with no frisbee
// field yet (or where the view is), with nothing selected.
function startNextField(p) {
  const t = tagsFor(p); t.sel = null; fitArmed = false; $("fitPop").hidden = true;
  const fs = Object.values(t.fr).filter(x => x.lat != null), cf = fieldKeys(p);
  const free = cf.map(({ f }) => f).filter(f => !fs.some(fr => areaXY(clipXY(toXY(f.p, fr.lat, fr.lon), toXY(frisbeeCorners(fr), fr.lat, fr.lon))) > OVERLAP_TOL * areaXY(toXY(f.p, fr.lat, fr.lon))))
    .sort((a, b) => areaXY(toXY(b.p, b.c[0], b.c[1])) - areaXY(toXY(a.p, a.c[0], a.c[1])))[0];
  if (free) { map.setView(free.c, map.getZoom(), { animate: false }); angle = longAxis(free.p); }
  pin = null; if (!rotating) setRotating(true);
  drawParkFields(p); drawLights(p); renderTags(p); renderCentre();
  setStatus(free ? `Place the next frisbee field (unrated council area: ${free.n || "unnamed"}); lock it, then rate the fit.` : "Place the next frisbee field, lock it, then rate the fit.");
}
async function decide(decision) {
  const p = current(); if (!p || busy || view !== "park" || workMode === "book") return;
  const t = tagsFor(p);
  // Spare council space: if a quarter or more of the council field area has no frisbee
  // field, ask whether to add another before saving the venue.
  if (decision !== "no" && Object.values(t.fr).some(bookable)) {
    const share = spareShare(councilGroups(p, t));
    if (share >= SPARE_RULE) {
      const a = await askSpare(p, share);
      if (a === "cancel") return;
      if (a === "add") { startNextField(p); return; }
    }
  }
  // The spots were fixed when each field was locked, so they're saved with the decision.
  const withField = !!t.spot;
  fitArmed = false;
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
  const xs = myLocs().filter(x => x.park_id === id && !isRetired(x));
  return !xs.length ? null : xs.some(isActive) ? "active" : "cart";
}
// The summary's Cart / Active toggle: move a park's fields to that stage (adding its rated
// fields when none are listed); pressing the current stage again removes them.
// The venue's bookable fields: its saved frisbee groups (council fields grouped on save,
// multi-field areas included), else its rated fields, else the whole park.
function venueEntries(p, status, extra = {}) {
  const t = tagsFor(p), wf = parkWorkflow(p), at = new Date().toISOString(), base = { park_id: p.id, park: p.name, region: p.region, kind: wf.kind, operator: wf.operator,
    status, added_at: at, ...(status === "active" ? { activated_at: at, ...activatedBy() } : {}), ...addedBy(), ...extra };
  const groups = reviews[p.id]?.placement?.groups || [];
  if (groups.length) return groups.map(g => ({ ...base, id: cartId(p, g.key), field: g.name, council_fields: g.council, frisbee: g.cap, fit: g.fit, lat: g.c[0], lon: g.c[1] }));
  const keys = Object.values(t.fr).filter(bookable).map(x => x.name);
  return (keys.length ? keys : ["Whole park"]).map(key => { const fr = t.fr[key], f = fieldKeys(p).find(x => x.key === key)?.f, c = fr?.lat != null ? [fr.lat, fr.lon] : f?.c || [p.lat, p.lon];
    return { ...base, id: cartId(p, key), field: key, lat: c[0], lon: c[1] }; });
}
async function setParkStage(p, stage) {
  if (!p) return;
  const who = whoBooks(), before = [...(bookLocs[who] || [])], cur = parkStage(p.id), at = new Date().toISOString();
  let list;
  if (cur === stage) list = before.filter(x => x.park_id !== p.id || isRetired(x));
  else if (cur) list = before.map(x => x.park_id !== p.id || isRetired(x) ? x : stage === "active" ? { ...x, status: "active", activated_at: x.activated_at || at, ...(x.activated_at ? {} : activatedBy()) } : { ...x, status: "cart" });
  else {
    const add = venueEntries(p, stage, { decision: reviews[p.id]?.decision }), ids = new Set(add.map(x => x.id));
    list = [...before.filter(x => !ids.has(x.id)), ...add];
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
  const who = whoBooks(), before = [...(bookLocs[who] || [])];
  let list = before.filter(x => x.park_id !== p.id || decision !== "no");
  if (decision !== "no") {
    // The venue's groups become its active fields; the park's earlier fields that aren't
    // among them are retired (kept for the bookings already on them).
    const add = venueEntries(p, "active", { decision }), ids = new Set(add.map(x => x.id)), at = new Date().toISOString();
    list = list.map(x => x.park_id !== p.id || ids.has(x.id) || isRetired(x) ? x : { ...x, status: "retired", retired_at: at });
    add.forEach(e => { const i = list.findIndex(x => x.id === e.id);
      if (i >= 0) list[i] = { ...list[i], ...e, status: "active", added_at: list[i].added_at || e.added_at, activated_at: list[i].activated_at || e.activated_at };
      else list.push(e); });
  }
  if (JSON.stringify(list) === JSON.stringify(before)) return;
  bookLocs[who] = list;
  if (!(await saveBookLocs())) { bookLocs[who] = before; return; }
  const n = list.filter(x => x.park_id === p.id && isActive(x)).length;
  setStatus(decision === "no" ? `Rejected ${p.name}: removed from ${who}'s active fields.` : `${p.name}: ${n} field${n === 1 ? "" : "s"} now active for ${who} — bookable in Facility Booking.`);
  renderTabs();
}
function buildReview(p, t, decision, withField) {
  const prevPl = reviews[p.id]?.placement;
  const pos = withField ? { ...t.spot, ...dims }
    : prevPl?.lat != null ? { lat: prevPl.lat, lon: prevPl.lon, angle: prevPl.angle, len: prevPl.len, wid: prevPl.wid, ez: prevPl.ez } : { lat: null, lon: null };
  // Per-field ratings and their lights are kept either way; "without" only skips the park's pin.
  const fr = Object.fromEntries(Object.entries(t.fr).filter(([, x]) => x.fit && x.fit !== "unknown"));
  // On venue save (a decision) the frisbee fields are mapped back to council fields.
  let groups = prevPl?.groups;
  if (decision !== "rating") {
    const m = councilGroups(p, t); groups = m.groups;
    m.groups.forEach(g => g.frisbee.forEach(n => { if (fr[n]) fr[n] = { ...fr[n], council: g.council, group: g.key }; }));
    if (!t.fieldsManual && m.groups.length) t.fields = m.groups.map(g => g.name).join("; ");
  }
  const placement = (pos.lat != null || t.lightPts.length || Object.keys(fr).length) ? { ...pos, lights: t.lightPts, fields: fr, ...(groups ? { groups } : {}) } : null;
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
  renderRail();
  const share = spareShare(councilGroups(p, t));
  if (share < SPARE_RULE) { $("fitPop").hidden = true; t.sel = null; fitArmed = false; drawParkFields(p); drawLights(p); renderTags(p); renderCentre();
    setStatus(`Saved ${done}. The frisbee fields cover ${Math.round((1 - share) * 100)}% of the council area — top pick, shortlist or reject ${p.name} when you're ready (the rest joins the nearest field).`); return; }
  startNextField(p);
  setStatus(`Saved ${done}. About ${Math.round(share * 100)}% of the council area is still free — would you like to add another frisbee field? Lock this one to add it.`);
}
// Field configuration changed since the last save (each edit pushes an undo snapshot; notes don't).
function hasUnsaved(p) {
  if (!IS_ADMIN || !p || !draft[p.id]) return false;
  return (edits[p.id]?.length || 0) !== (savedDepth[p.id] || 0) || (draft[p.id].notes || "").trim() !== (reviews[p.id]?.notes || "").trim();
}
function askUnsaved(p) {
  const dlg = $("unsavedDlg");
  $("unsavedTitle").textContent = `Save your changes to ${p.name}?`;
  $("unsavedBody").textContent = "You've changed the field configuration here since it was last saved. Save it before moving on (any decision stays as it is), or discard the changes.";
  return new Promise(res => { dlg.returnValue = ""; dlg.addEventListener("close", () => res(dlg.returnValue || "cancel"), { once: true }); dlg.showModal(); });
}
async function skip() {
  const p = current(); if (!p) return;
  // Unsaved field configuration: offer to save it (or discard it) before moving on.
  if (hasUnsaved(p)) {
    const a = await askUnsaved(p);
    if (a === "cancel") return;
    if (a === "save") { busy = true; const ok = await save(p.id, buildReview(p, tagsFor(p), reviews[p.id]?.decision || "rating", false)); busy = false; if (!ok) return; renderRail(); }
    else { delete draft[p.id]; delete edits[p.id]; delete savedDepth[p.id]; }
  }
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
      if (k === "quality") { const nv = (ratings[p.id]?.mine || (ratingsShared ? 0 : d.quality)) === v ? 0 : v;
        if (IS_ADMIN) d.quality = nv;
        setRating(p.id, nv).then(() => renderTags(p)); }
      renderTags(p); }
  });
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
  $("actions").addEventListener("click", e => { const b = e.target.closest("[data-fit]"), p = current(); if (!b || !p) return;
    confirmSpot(p, b.dataset.fit); });
  $("fbUndo").onclick = e => { e.stopPropagation(); editUndo(); };
  $("fbMove").onclick = e => { e.stopPropagation(); const p = current(); if (p && tagsFor(p).sel) { snap(p); setRotating(true); setStatus(`Moving ${tagsFor(p).sel}: turn and drag it, then tap 🔓 to lock it in its new spot.`); } };
  $("fbAlign").onclick = e => { e.stopPropagation(); const p = current(); if (p) askAlign(p); };
  $("fbRemove").onclick = e => { e.stopPropagation(); const p = current(); if (p) removeField(p); };
  $("helpBtn").onclick = () => { const el = $("helpPanel"); el.hidden = !el.hidden; $("helpBtn").setAttribute("aria-expanded", String(!el.hidden)); };
  $("fieldBtn").onclick = () => showField(!fieldOn);
  bindDispenser();
  $("clubFlagBtn").onclick = () => { const p = current(); if (!p) return;
    amendFor = amendFor === p.id ? null : p.id; renderFlag(p); if (amendFor) $("clubIn").focus(); };
  const amendSave = async () => { const p = current(); if (!p) return;
    const fl = { club: $("clubIn").value.trim(), kind: $("amendKind").value, contact: contactValue($("amendContact").value),
      website: websiteValue($("amendWebsite").value), details: $("amendDetails").value.trim().slice(0, 300) };
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
  $("fitBtn").onclick = () => { const p = current(); if (p) zoomToggle(p); };
  $("fullBtn").onclick = () => setFullMap(!document.body.classList.contains("mapfull"));
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
  $("interestBtn").onclick = () => { const el = $("interestRow"); el.hidden = !el.hidden; $("interestBtn").setAttribute("aria-expanded", String(!el.hidden)); if (!el.hidden) renderInterests(); };
  $("interestRow").addEventListener("click", e => {
    const b = e.target.closest("[data-int]"); if (!b) return;
    const k = b.dataset.int;
    if (k === "reset") interests = { regions: [], council: true, priv: true, lit: true, dark: true };
    else if (k === "region") {
      const all = allRegions(), inc = new Set(interests.regions.length ? interests.regions : all);
      inc.has(b.dataset.val) ? inc.delete(b.dataset.val) : inc.add(b.dataset.val);
      interests.regions = !inc.size || inc.size === all.length ? [] : all.filter(r => inc.has(r));
    } else { interests[k] = !interests[k];
      if (!interests.council && !interests.priv) interests[k === "council" ? "priv" : "council"] = true;
      if (!interests.lit && !interests.dark) interests[k === "lit" ? "dark" : "lit"] = true; }
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
    if ($("saveDlg").open || $("unsavedDlg").open || e.target.matches("input, textarea, select")) return;
    const p = current();
    if (!IS_ADMIN && !/^(Escape|c|C)$/.test(e.key)) return;   // bookers: no rating keys
    if (e.key === "Escape") { if (document.body.classList.contains("mapfull")) { setFullMap(false); return; } if (infoOpenFor) { infoOpenFor = null; render(); return; } if (rotating) setRotating(false); $("sizePanel").hidden = true; $("helpPanel").hidden = true; $("fitPop").hidden = true; if (p && tagsFor(p).sel) selectField(p, null); return; }
    if (/^[cC]$/.test(e.key)) { focusId = null; setView(view === "city" ? "park" : "city"); return; }
    if (/^[bB]$/.test(e.key)) { setMode(workMode === "book" ? "rate" : "book"); return; }
    if (view === "city") return;
    const fm = $("actions").classList.contains("fitmode") && p;
    // Deciding a park: ← back, → later, ↓ shortlist, ↑ top pick, Backspace reject.
    // A locked field's fit keeps its own arrows: ← unusable, ↓ 3v3, ↑ 1 ×, → 2 ×.
    if (e.key === "ArrowRight") { e.preventDefault(); fm ? confirmSpot(p, "multi") : skip(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); fm ? confirmSpot(p, "no") : goBack(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); fm ? confirmSpot(p, "reduced") : decide("yes"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); fm ? confirmSpot(p, "full") : decide("top"); }
    else if (e.key === "Backspace" && !fm) { e.preventDefault(); decide("no"); }
    else if (e.key === "Enter" && fieldOn && !e.target.closest("button")) { e.preventDefault(); $("centreBtn").click(); }
    else if (/^[sS]$/.test(e.key)) skip();
    else if (/^[zZ]$/.test(e.key)) editUndo();
    else if (/^[tT]$/.test(e.key)) showField(!fieldOn);
    else if (e.key === "0") $("fitBtn").click();
    else if (/^[rR]$/.test(e.key)) { angle = (angle + 15) % 360; sizeField(); afterMove(); }
    else if (p && /^[1-5]$/.test(e.key)) { tagsFor(p).quality = +e.key; setRating(p.id, +e.key).then(() => renderTags(p)); renderTags(p); }
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
  const rows = [["Region", "Park", "Decision", "Suitability", "Lights", "Light poles", "Fit", "Quality", "Fields", "Notes", "Field placement (lat, lon, angle°)", "Private operator", "Operator contact", "Ultimate club", "Vendor amendment", "Reviewer", "Reviewed at", "Activity score",
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
  // On phones the chips roll through one line: the first shows for a moment, then the rest
  // scroll past (the copy makes the loop seamless).
  const chips = now.length ? now.map(chip).join("") : `<span class="sb-p">Between phases</span>`;
  el.innerHTML = `<details><summary><span class="sb-k">Council bookings now</span>
      <span class="sb-tick"><span class="sb-track">${chips}<span class="sb-copy" aria-hidden="true">${chips}</span></span></span>
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
  const actor = getActor(email);
  $("profileName").textContent = actor || email.split("@")[0]; $("profileBtn").title = actor ? `${actor} · ${email}` : email; $("profileBtn").hidden = false;
  $("profileMenu").innerHTML = `<div class="pm-head"><div class="pm-k">Signed in</div><div class="pm-e">${esc(email)}</div>
      ${actor ? `<div class="pm-actor">as <b>${esc(actor)}</b></div>` : ""}
      <span class="pm-role${IS_ADMIN ? " admin" : ""}">${IS_ADMIN ? "👑 Admin" : "👤 User"}</span></div>
    <button class="pm-item" id="pmActor">👥 Switch or edit names</button>
    <a class="pm-item" href="./">📅 Facility Booking</a>
    ${IS_ADMIN ? `<a class="pm-item" href="${COUNCIL_APPLICATION_URL}" target="_blank" rel="noopener">🏛 Council application</a>` : ""}
    <button class="pm-item" id="pmHistory">📜 Vetting history</button>
    <button class="pm-item danger" id="pmSignOut">↪ Sign out</button>`;
  const close = () => { $("profileMenu").hidden = true; $("profileBtn").setAttribute("aria-expanded", "false"); };
  $("profileBtn").onclick = e => { e.stopPropagation(); const open = $("profileMenu").hidden; $("profileMenu").hidden = !open; $("profileBtn").setAttribute("aria-expanded", String(open)); };
  document.addEventListener("click", e => { if (!e.target.closest(".profile")) close(); });
  $("pmHistory").onclick = () => { close(); openHistory(); };
  $("pmActor").onclick = async () => { close(); await askActor({ supabase, user: session.user, edit: true }); await ensureActor(); renderProfile(); };
  $("pmSignOut").onclick = signOut;
}

async function signOut() { clearActor(session?.user?.email); await supabase?.auth.signOut(); location.reload(); }
// A shared login: whoever is using it picks their name (first name, last initial) first.
async function ensureActor() {
  while (session && !getActor(session.user.email)) {
    if (await askActor({ supabase, user: session.user, onSignOut: signOut }) === null) return false;
  }
  return true;
}

// ── Start ────────────────────────────────────────────────────────────────────
// Signed out (or no access): only the message shows, not the views, filters or progress.
function gate(html) { $("gate").innerHTML = html; $("gate").hidden = false; $("app").hidden = true; document.body.classList.add("gated"); document.body.classList.remove("booting"); }
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
    if (!(await ensureActor())) return;
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
  await loadBookLocs(); await loadActivity(); await loadViews(); await loadRatings(); await loadHistory(); await loadOffsets(); await loadCouncilOnly(); await loadRelations(); await syncCartWorkflows();
  initMap(); drawField(); showField(fieldOn); renderLegend(); bind();
  setView(view === "park" || view === "book" ? view : "city", { refit: true });
  // The header controls stay hidden (body.booting) until sign-in, role and mode are known,
  // so they appear once, fully set, instead of flashing their defaults first.
  document.body.classList.remove("booting");
  if (mode === "shared") setInterval(async () => { if (!busy && !rotating && document.visibilityState === "visible" && !$("saveDlg").open) { await loadShared(); if (view === "city") render(); else renderRail(); } }, 30000);
}
start().catch(e => { document.body.classList.remove("booting"); setStatus("Couldn't start: " + (e.message || e), true); });
// Uncaught errors go to the booking site's activity log (admins see them as "App error"),
// at most five per page load.
let errorsLogged = 0;
function logClientError(message, where) {
  if (errorsLogged >= 5 || !message || !supabase || !session) return;
  errorsLogged++;
  supabase.from("activity_log").insert({ user_id: session.user.id, user_email: session.user.email, session_id: "vetting", action: "client_error",
    detail: { message: String(message).slice(0, 300), where: String(where || "").slice(0, 200), page: location.pathname, by: IS_ADMIN ? "admin" : "booker" } }).then(() => {}, () => {});
}
window.addEventListener("error", e => logClientError(e.message, e.filename ? `${e.filename.split("/").pop()}:${e.lineno}` : ""));
window.addEventListener("unhandledrejection", e => logClientError(e.reason?.message || e.reason, "promise"));
