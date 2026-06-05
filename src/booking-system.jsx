import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { createClient } from "@supabase/supabase-js";
import logoUrl from "./assets/logo.jpg";

// ─── LOGO ─────────────────────────────────────────────────────────────────────
const LOGO_SRC = logoUrl;
// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL  = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON;
const supabase = SUPABASE_URL && SUPABASE_ANON
  ? createClient(SUPABASE_URL, SUPABASE_ANON, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    })
  : null;
let _accessToken = null;
let _currentUser = null; // { id, email } — kept in sync by onAuthStateChange
// { secondaryEmail: primaryEmail } — kept in sync from the component's emailAliases
// state so module-level sendEmail can CC a booker's primary address on mail sent
// to one of their linked secondary addresses.
let _emailAliases = {};
function primaryEmailFor(em) {
  if (!em) return null;
  return _emailAliases[em.toLowerCase()] || null;
}
const _sessionId = (crypto?.randomUUID?.() || `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`);
function authHeaders(extra = {}) {
  return { apikey: SUPABASE_ANON, Authorization: `Bearer ${_accessToken || SUPABASE_ANON}`, ...extra };
}

// Best-effort audit trail. Never throws — a missing table or RLS denial must not
// break the app flow. Captures auth events, booking changes, syncs and emails.
async function logActivity(action, detail = {}) {
  if (!supabase || !_currentUser?.id) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/activity_log`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json", Prefer: "return=minimal" }),
      body: JSON.stringify({
        user_id: _currentUser.id,
        user_email: _currentUser.email || null,
        session_id: _sessionId,
        action,
        detail,
      }),
    });
  } catch { /* silent */ }
}

const sb = {
  async select(table, query="") {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}&order=created_at.desc`,
      { headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async insert(table, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method:"POST",
      headers: authHeaders({ "Content-Type":"application/json", Prefer:"return=representation" }),
      body:JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async update(table, id, data) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:"PATCH",
      headers: authHeaders({ "Content-Type":"application/json", Prefer:"return=representation" }),
      body:JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async remove(table, id) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, { method:"DELETE",
      headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text());
  },
  // Delete rows matching a raw PostgREST filter query (e.g. "created_at=lt.2025-01-01").
  async removeWhere(table, query) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { method:"DELETE",
      headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text());
  },
  async upsert(table, data, onConflict="key") {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, { method:"POST",
      headers: authHeaders({ "Content-Type":"application/json", Prefer:"return=representation,resolution=merge-duplicates" }),
      body:JSON.stringify(data) });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
  async selectAll(table) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=*`,
      { headers: authHeaders() });
    if (!r.ok) throw new Error(await r.text()); return r.json();
  },
};

// ─── Facilities ───────────────────────────────────────────────────────────────
const FACILITIES = [
  { id:"f1", name:"Meeting Room – Ground Floor", capacity:20,  color:"#a78bfa", kind:"social" }, // light purple
  { id:"f2", name:"Function Room – Upstairs",    capacity:100, color:"#7c3aed", kind:"social" }, // deep purple
  { id:"f3", name:"Field #1",                    capacity:50,  color:"#166534", kind:"field"  }, // darkest green
  { id:"f4", name:"Field #2",                    capacity:50,  color:"#22c55e", kind:"field"  }, // mid green
  { id:"f5", name:"Field #3",                    capacity:50,  color:"#86efac", kind:"field"  }, // light green
];
// Light tint of each facility colour for day-view column backgrounds.
const FACILITY_TINT = { f1:"#f5f3ff", f2:"#ede9fe", f3:"#dcfce7", f4:"#ecfdf5", f5:"#f0fdf4" };
function isSocialFac(id) { return FACILITIES.find(f=>f.id===id)?.kind==="social"; }
const EMAIL_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4","#84cc16","#f97316","#14b8a6","#e879f9","#fb7185","#34d399","#60a5fa","#fbbf24"];
const _ecc = {}; let _eci = 0;
function emailColor(email) {
  const k = (email||"").toLowerCase().trim();
  if (!_ecc[k]) { _ecc[k] = EMAIL_COLORS[_eci % EMAIL_COLORS.length]; _eci++; }
  return _ecc[k];
}

const CAL_START=7, CAL_END=22, CAL_TOTAL=CAL_END-CAL_START, HOUR_H=56, SLOT_H=HOUR_H*0.5;
const DURATIONS = [
  {label:"30 min",value:0.5},{label:"1 hr",value:1},{label:"1.5 hrs",value:1.5},
  {label:"2 hrs",value:2},{label:"2.5 hrs",value:2.5},{label:"3 hrs",value:3},
  {label:"4 hrs",value:4},{label:"6 hrs",value:6},{label:"8 hrs",value:8},
];
const STATUS_META = {
  pending_amua: {bg:"#fff8e1",border:"#f59e0b",text:"#92400e",dot:"#f59e0b",label:"(1/4) Pending AMUA Review"},
  queued_cpsa:  {bg:"#dbeafe",border:"#93c5fd",text:"#1e40af",dot:"#3b82f6",label:"(2/4) Queued for GTEC"},
  pending_cpsa: {bg:"#e0f2fe",border:"#7dd3fc",text:"#075985",dot:"#0ea5e9",label:"(3/4) Pending GTEC Review"},
  approved:      {bg:"#f0fdf4",border:"#22c55e",text:"#14532d",dot:"#22c55e",label:"(4/4) Approved"},
  cpsa_confirmed:{bg:"#ecfeff",border:"#0891b2",text:"#155e75",dot:"#0891b2",label:"🌐 GTEC Confirmed"},
  cpsa_review_needed: {bg:"#fef9c3",border:"#a16207",text:"#713f12",dot:"#a16207",label:"⚠ GTEC Mismatch — AMUA Review"},
  rejected:     {bg:"#fff1f2",border:"#f43f5e",text:"#881337",dot:"#f43f5e",label:"Rejected"},
  cancelled:    {bg:"#f8f8f8",border:"#94a3b8",text:"#475569",dot:"#94a3b8",label:"Cancelled"},
  clash:        {bg:"#fef3c7",border:"#d97706",text:"#92400e",dot:"#d97706",label:"Clash"},
  amua_submit:  {bg:"#dbeafe",border:"#93c5fd",text:"#1e40af",dot:"#3b82f6",label:"(2/4) Queued for GTEC"},
  pending:      {bg:"#fff8e1",border:"#f59e0b",text:"#92400e",dot:"#f59e0b",label:"(1/4) Pending AMUA Review"},
};
// invoiced is an orthogonal billing flag (booking.invoiced boolean), not a workflow status.
const INVOICED_META = {bg:"#f5f3ff",border:"#7c3aed",text:"#5b21b6",dot:"#7c3aed",label:"🧾 Invoiced"};
const REVIEW_STATUSES = new Set(["pending_amua","queued_cpsa","amua_submit","pending_cpsa","pending","cpsa_review_needed"]);
// Solid status colours used as the primary background in week/month calendar blocks.
// Field colour becomes the left-border accent; booker email colour appears as a small dot.
// Matches STATUS_META.dot exactly so calendar chips and status badges use the same palette.
const STATUS_CAL_COLOR = {
  pending_amua:"#f59e0b", queued_cpsa:"#3b82f6", amua_submit:"#3b82f6",
  pending_cpsa:"#0ea5e9", pending:"#f59e0b",     approved:"#22c55e",
  cpsa_confirmed:"#0891b2", cpsa_review_needed:"#fef9c3",
  clash:"#d97706", rejected:"#f43f5e", cancelled:"#94a3b8",
};
// Per-status text colour override for calendar chips (default white). Light backgrounds need dark text.
const STATUS_CAL_TEXT = { cpsa_review_needed: "#713f12" };
// Fields that participate in CPSA sync (f1/f2 are meeting/function rooms and stay "approved").
const CPSA_FIELD_IDS = new Set(["f3","f4","f5"]);
const AMUA_INFO = {
  name:      "Auckland Mixed Ultimate Association (AMUA)",
  address:   "",
  gstNumber: "",
  bank:      "",
};

// Pre-configured vendor: Grammar TEC Rugby Club (the facility owner / invoice recipient for POs).
const VENDOR_GTEC = {
  id:        "gtec",
  name:      "Grammar TEC Rugby Club Inc",
  address:   "PO BOX 42 210\nOrakei\nAuckland\nNEW ZEALAND",
  gstNumber: "113-246-812",
};

// fb_profiles schema (localStorage):
// { [primaryEmail]: { fullName, officialName, address, gstNumber, accountNumber, accountName, profileType } }
// profileType: "user" | "admin" | "vendor"
const MONTHS=["January","February","March","April","May","June","July","August","September","October","November","December"];

// Generate sequential IDs like "INV-20260528-001" for a given prefix.
// Pass the full current records array to ensure uniqueness within a batch.
function generateDocId(existingRecords, prefix) {
  const today = new Date().toISOString().slice(0,10).replace(/-/g,"");
  const todayRecs = (existingRecords||[]).filter(r => r.id && r.id.startsWith(`${prefix}-${today}-`));
  const seq = String(todayRecs.length + 1).padStart(3,"0");
  return `${prefix}-${today}-${seq}`;
}

function fmtTime(h) {
  const hh=Math.floor(h), m=Math.round((h%1)*60), dh=hh>12?hh-12:hh===0?12:hh;
  return `${dh}:${m===0?"00":String(m).padStart(2,"0")} ${hh>=12?"PM":"AM"}`;
}
function fmt24(h) {
  const hh=Math.floor(h), m=Math.round((h%1)*60);
  return `${String(hh).padStart(2,"0")}:${m===0?"00":String(m).padStart(2,"0")}`;
}
function fmtDateShort(s) {
  const d=new Date(s+"T00:00:00"); return `${d.getDate()} ${d.toLocaleDateString("en-NZ",{month:"short"})}`;
}
function fmtDate(s) { return new Date(s+"T00:00:00").toLocaleDateString("en-NZ",{weekday:"short",day:"numeric",month:"short",year:"numeric"}); }
// Format a CPSA-RES "logged at" stamp — a full ISO datetime (new) or a legacy date-only key.
function fmtLoggedAt(s) {
  if (!s) return "";
  const hasTime = /T\d/.test(s);
  const d = new Date(hasTime ? s : s + "T00:00:00");
  if (isNaN(d.getTime())) return s;
  return hasTime
    ? d.toLocaleString("en-NZ", { day:"numeric", month:"short", year:"numeric", hour:"numeric", minute:"2-digit" })
    : d.toLocaleDateString("en-NZ", { day:"numeric", month:"short", year:"numeric" });
}
function fmtCost(n) { return "$" + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,","); }
function fmtTimeShort(h) {
  const hh=Math.floor(h), m=Math.round((h%1)*60), dh=hh>12?hh-12:hh===0?12:hh;
  return `${dh}${m?":"+String(m).padStart(2,"0"):""}${hh>=12?"p":"a"}`;
}
const FAC_SHORT = { f1:"Mtg", f2:"Fn", f3:"Fld1", f4:"Fld2", f5:"Fld3" };
function facShort(id) { return FAC_SHORT[id] || (FACILITIES.find(x=>x.id===id)?.name) || id; }
// Global mobile styles
const MOBILE_STYLE = `
  .modal-backdrop > div { border-radius: 16px 16px 0 0; }
  @media (min-width: 768px) {
    .modal-backdrop { align-items: center !important; }
    .modal-backdrop > div { border-radius: 16px !important; max-height: 90vh !important; }
  }
  ::-webkit-scrollbar { display: none; }
  /* Diagonal stripe overlay distinguishes social-space chips in week/month calendar */
  .fac-social-tex {
    background-image: repeating-linear-gradient(45deg, rgba(255,255,255,0.20) 0 4px, rgba(255,255,255,0) 4px 9px);
  }
  .fac-social-tex-dark {
    background-image: repeating-linear-gradient(45deg, rgba(0,0,0,0.10) 0 4px, rgba(0,0,0,0) 4px 9px);
  }
`;
function useMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  return mobile;
}

function todayKey() { const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function dateKey(d)  { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function newId()     { return crypto?.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)+Date.now().toString(36); }
function addDays(dateStr, n) {
  // Use UTC to avoid daylight-saving / timezone shifts causing off-by-one
  const [y,m,d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m-1, d+n));
  return dt.toISOString().split("T")[0];
}
function getWeekDates(base) {
  const d=new Date(base), day=d.getDay(), mon=new Date(d);
  mon.setDate(d.getDate()-(day===0?6:day-1));
  return Array.from({length:7},(_,i)=>{const dd=new Date(mon);dd.setDate(mon.getDate()+i);return dd;});
}
function getDaysInMonth(y,m) {
  const f=new Date(y,m,1),days=[];
  while(f.getMonth()===m){days.push(new Date(f));f.setDate(f.getDate()+1);}
  return days;
}
function timeOverlaps(a,b) {
  if(a.date!==b.date||a.id===b.id) return false;
  if(["cancelled","rejected"].includes(a.status)||["cancelled","rejected"].includes(b.status)) return false;
  return a.start_hour<b.start_hour+b.duration && a.start_hour+a.duration>b.start_hour;
}
function isAdminBooking(b)  { return b.email === "admin"; }

// ─── Copy any rendered table to the clipboard ────────────────────────────────
// Serialises a live <table> DOM node to clean HTML + tab-separated text so it
// pastes as a real table into Sheets/Excel/Docs/email (same idea as the mismatch
// "copy" action, but generic). <CopyableTable> wraps a table and adds the button.
function escTableText(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function serializeTableEl(table){
  if(!table) return { html:"", text:"" };
  const rows = [...table.rows];
  const cellText = c => (c.innerText||c.textContent||"").replace(/\s+/g," ").trim();
  const text = rows.map(r => [...r.cells].map(cellText).join("\t")).join("\n");
  const htmlRows = rows.map(r => {
    const head = r.parentElement && r.parentElement.tagName === "THEAD";
    return "<tr>" + [...r.cells].map(c => {
      const th = c.tagName === "TH" || head;
      return `<${th?"th":"td"} style="border:1px solid #cbd5e1;padding:4px 8px;text-align:left;font-size:12px;${th?"background:#f1f5f9;font-weight:700":""}">${escTableText(cellText(c))}</${th?"th":"td"}>`;
    }).join("") + "</tr>";
  }).join("");
  return { html:`<table style="border-collapse:collapse;font-family:sans-serif">${htmlRows}</table>`, text };
}
function CopyableTable({ children, style, align="left" }){
  const [done, setDone] = useState(false);
  async function copy(e){
    const table = e.currentTarget.closest("[data-copytable]")?.querySelector("table");
    const { html, text } = serializeTableEl(table);
    if(!text) return;
    try { await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html],{type:"text/html"}), "text/plain": new Blob([text],{type:"text/plain"}) })]); }
    catch { try { await navigator.clipboard.writeText(text); } catch { /* ignore */ } }
    setDone(true); setTimeout(()=>setDone(false), 1500);
  }
  return (
    <div data-copytable="" style={style}>
      <div style={{display:"flex",justifyContent:align==="right"?"flex-end":"flex-start",marginBottom:4}}>
        <button type="button" onClick={copy} title="Copy this table to the clipboard — paste into Sheets, Docs or email"
          style={{fontFamily:"inherit",fontSize:10,fontWeight:700,cursor:"pointer",border:"1px solid #cbd5e1",borderRadius:6,padding:"2px 8px",background:done?"#dcfce7":"#fff",color:done?"#166534":"#475569",lineHeight:1.4}}>
          {done?"✓ Copied":"📋 Copy table"}</button>
      </div>
      {children}
    </div>
  );
}
// System markers (CPSA mismatch, billing snapshot, CPSA submission refs) live in
// booking.system_notes — separate from user-editable booking.notes. All read helpers
// fall back to booking.notes for rows that pre-date the system_notes column migration.
const CPSA_MISMATCH_RE = /\[CPSA-MISMATCH\][^\n]*/g;
function setMismatchNote(sysNotes, reasons) {
  const base = (sysNotes||"").replace(CPSA_MISMATCH_RE,"").trim();
  if (!reasons || !reasons.length) return base;
  const marker = `[CPSA-MISMATCH] ${reasons.join(" | ")}`;
  return base ? `${base}\n${marker}` : marker;
}
// Read from system_notes; fall back to notes for pre-migration rows.
function parseMismatchNote(sysNotes, notesLegacy) {
  const src = sysNotes || notesLegacy || "";
  const m = src.match(/\[CPSA-MISMATCH\]\s*([^\n]*)/);
  return m ? m[1].split("|").map(s=>s.trim()).filter(Boolean) : [];
}
function stripMismatchNote(sysNotes) { return (sysNotes||"").replace(CPSA_MISMATCH_RE,"").trim(); }
// Split a succinct reason "Label: old → new" into structured parts for old/new columns.
function splitReason(r) {
  const m = (r||"").match(/^(.+?):\s*(.*?)\s*→\s*(.*)$/);
  return m ? { label: m[1], old: m[2], next: m[3] } : { label: r, old: "", next: "" };
}
// Billed snapshot stored in system_notes.
const BILLED_RE = /\[BILLED\][^\n]*/g;
function setBilledSnapshot(sysNotes, b) {
  const base = (sysNotes||"").replace(BILLED_RE,"").trim();
  const marker = `[BILLED] ${b.facility_id}|${b.start_hour}|${b.duration}`;
  return base ? `${base}\n${marker}` : marker;
}
function parseBilledSnapshot(sysNotes, notesLegacy) {
  const src = sysNotes || notesLegacy || "";
  const m = src.match(/\[BILLED\]\s*([^|]+)\|([^|]+)\|([^\n|]+)/);
  if (!m) return null;
  return { facility_id: m[1].trim(), start_hour: parseFloat(m[2]), duration: parseFloat(m[3]) };
}
// CPSA mismatch resolution state stored in system_notes as [CPSA-RES] resolution|billingState|loggedAtISO.
// Billing states: none | credit_pending | invoice_pending | credited | invoiced
const CPSA_RES_RE_G = /\[CPSA-RES\][^\n]*/g;
const CPSA_ORIG_RE_G = /\[CPSA-ORIG\][^\n]*/g;
function parseCpsaResolution(sysNotes) {
  const m = (sysNotes||"").match(/\[CPSA-RES\]\s*([^\n]*)/);
  if (!m) return null;
  const [res, billing, date] = m[1].split("|").map(s=>s.trim());
  return { resolution: res||"pending", billingState: billing||"none", date: date||"" };
}
function setCpsaResolution(sysNotes, resolution, billingState="none") {
  const base = (sysNotes||"").replace(CPSA_RES_RE_G,"").trim();
  // Stamp the full date+time the resolution/update was logged (ISO; legacy rows are date-only).
  const marker = `[CPSA-RES] ${resolution}|${billingState}|${new Date().toISOString()}`;
  return base ? `${base}\n${marker}` : marker;
}
// Original booking values before CPSA amendment — stored so the change can be tracked/reversed.
function parseCpsaOrig(sysNotes) {
  const m = (sysNotes||"").match(/\[CPSA-ORIG\]\s*([^\n]*)/);
  if (!m) return null;
  const [fac, sh, dur] = m[1].split("|").map(s=>s.trim());
  return { facility_id: fac, start_hour: parseFloat(sh), duration: parseFloat(dur) };
}
function setCpsaOrig(sysNotes, b) {
  const base = (sysNotes||"").replace(CPSA_ORIG_RE_G,"").trim();
  const marker = `[CPSA-ORIG] ${b.facility_id}|${b.start_hour}|${b.duration}`;
  return base ? `${base}\n${marker}` : marker;
}
// Parse the compact time strings produced by fmtTimeShort, e.g. "6p" → 18, "6:30p" → 18.5.
function parseFmtTimeShort(s) {
  const m = (s||"").trim().toLowerCase().match(/^(\d+)(?::(\d+))?([ap])$/);
  if (!m) return NaN;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (m[3]==="p" && h!==12) h += 12;
  if (m[3]==="a" && h===12) h = 0;
  return h + min/60;
}
// Extract the CPSA-intended values from parsed mismatch reasons (the "new" side of each reason).
function extractCpsaAmendValues(reasons, booking) {
  let { facility_id, start_hour, duration } = booking;
  for (const r of reasons) {
    const p = splitReason(r);
    if (!p.next) continue;
    if (p.label === "Time") { const h=parseFmtTimeShort(p.next.trim()); if(!isNaN(h)) start_hour=h; }
    else if (p.label === "Dur") { const d=parseFloat(p.next); if(!isNaN(d)) duration=d; }
    else if (p.label === "Field") {
      const first = p.next.split("/")[0].trim();
      const fac = FACILITIES.find(f=>facShort(f.id)===first);
      if (fac) facility_id = fac.id;
    }
  }
  return { facility_id, start_hour, duration };
}
// Parse CPSA submission markers "[CPSA <date>] Ref <ref> · <url>" out of
// system_notes (falls back to notes for pre-migration rows). Returns one
// { date, ref, url } per marker — the link to CPSA's record of the booking.
function parseCpsaRefs(sysNotes, notesLegacy) {
  const src = sysNotes || notesLegacy || "";
  const re = /\[CPSA ([^\]]+)\]\s*Ref\s+(\S+)\s*·\s*(https?:\/\/\S+)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push({ date: m[1], ref: m[2], url: m[3] });
  return out;
}

// Compare the billed snapshot to a booking's current dimensions. Returns the
// Day/evening-split cost of a booking-like {start_hour,duration,facility_id} at the
// given facility rates (5:30pm cutoff). Shared by the mismatch view and billed-change
// tracking so both frame credit/deficit identically.
function bookingCost(v, facilityRates) {
  const CUTOFF=17.5, end=v.start_hour+v.duration;
  const day = v.start_hour>=CUTOFF ? 0 : end>CUTOFF ? CUTOFF-v.start_hour : v.duration;
  const evening = v.duration-day;
  const r=(facilityRates||{})[v.facility_id];
  const rates = !r ? {day:0,evening:0} : typeof r==="object" ? {day:parseFloat(r.day)||0,evening:parseFloat(r.evening)||0} : {day:parseFloat(r)||0,evening:0};
  return day*rates.day + evening*rates.evening;
}
// structured discrepancies (old → new) plus the net hours delta and, when rates are
// supplied, the cost delta vs the billed snapshot (>0 ⇒ deficit owed by the booker,
// <0 ⇒ credit owed to them). Returns null when there is no snapshot / no drift.
function getBillingDrift(booking, facilityRates) {
  const snap = parseBilledSnapshot(booking.system_notes, booking.notes);
  if (!snap) return null;
  const rows = [];
  if (snap.facility_id !== booking.facility_id)
    rows.push({ label:"Field", old: facShort(snap.facility_id), next: facShort(booking.facility_id) });
  if (snap.start_hour !== booking.start_hour)
    rows.push({ label:"Time", old: fmtTimeShort(snap.start_hour), next: fmtTimeShort(booking.start_hour) });
  if (snap.duration !== booking.duration)
    rows.push({ label:"Dur", old: `${snap.duration}h`, next: `${booking.duration}h` });
  if (!rows.length) return null;
  const out = { rows, hoursDelta: +(booking.duration - snap.duration).toFixed(2), snap, costDelta: null, billedCost: null, currentCost: null };
  if (facilityRates) {
    out.billedCost  = bookingCost(snap, facilityRates);
    out.currentCost = bookingCost(booking, facilityRates);
    out.costDelta   = +(out.currentCost - out.billedCost).toFixed(2);
  }
  return out;
}
function getSameFacilityOverlaps(draft, others) {
  return others.filter(o => o.facility_id === draft.facility_id && timeOverlaps(draft, o));
}
function getCrossFacilityOverlaps(draft, others) {
  return others.filter(o => o.facility_id !== draft.facility_id && timeOverlaps(draft, o));
}
function getClashes(allBookings) {
  // Returns pairs: admin booking overlapping a non-admin booking on same facility (future dates only)
  const today = todayKey();
  const clashes = [];
  const adminBks = allBookings.filter(b => isAdminBooking(b) && b.date >= today);
  const userBks  = allBookings.filter(b => !isAdminBooking(b) && b.date >= today);
  adminBks.forEach(ab => {
    userBks.forEach(ub => {
      if (ab.facility_id === ub.facility_id && timeOverlaps(ab, ub)) {
        // Avoid duplicate pairs
        if (!clashes.find(c => c.admin.id === ab.id && c.user.id === ub.id)) {
          clashes.push({ admin: ab, user: ub });
        }
      }
    });
  });
  return clashes;
}


// ─── EmailJS ──────────────────────────────────────────────────────────────────
// Email is sent server-side by the `send-email` Supabase Edge Function, so NO
// EmailJS credentials ship in the browser bundle. The function authenticates the
// caller's Supabase session (JWT) and holds the EmailJS keys as Supabase secrets.
// If the function isn't reachable/deployed, sending is skipped (never throws).
async function sendEmail({ to, subject, html, kind = "order", cc }) {
  if (!supabase || !_accessToken) {
    console.warn("Email skipped: no Supabase session for", to);
    logActivity("email_failed", { to, subject, error: "no_session" });
    return;
  }
  // When `to` is a linked secondary address, CC the booker's primary email so the
  // main account is kept in the loop. Caller can pass an explicit `cc` to override.
  const ccResolved = cc ?? primaryEmailFor(to);
  const ccFinal = ccResolved && ccResolved.toLowerCase() !== (to||"").toLowerCase() ? ccResolved : undefined;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: `Bearer ${_accessToken}` },
      body: JSON.stringify({ to, subject, html, kind, ...(ccFinal ? { cc: ccFinal } : {}) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      console.warn(`send-email ${res.status}:`, body);
      logActivity("email_failed", { to, subject, status: res.status });
    } else {
      logActivity("email_sent", { to, subject, ...(ccFinal ? { cc: ccFinal } : {}) });
    }
  } catch (e) {
    console.error("Email network error:", e);
    logActivity("email_failed", { to, subject, error: String(e?.message || e) });
  }
}
async function sendApprovalEmail({ to, subject, html }) {
  return sendEmail({ to, subject, html, kind: "approval" });
}

// Build HTML for booking confirmation email
function buildOrderEmailHtml({ name, email, bookings: bkgs=[], deletedBookings=[], orderRef=null, isDeletionOnly=false }) {
  const hasAdded   = bkgs.length > 0;
  const hasDeleted = deletedBookings.length > 0;

  function tableRows(items, textColor="#0f172a", borderColor="#f1f5f9") {
    return items.map(b => {
      const f = FACILITIES.find(x=>x.id===b.facility_id);
      return `<tr>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor};font-weight:600">${f?.name||b.facility_id}</td>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor}">${fmtDate(b.date)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor};white-space:nowrap">${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}</td>
        <td style="padding:10px 14px;border-bottom:1px solid ${borderColor};font-size:13px;color:${textColor}">${b.purpose||""}</td>
      </tr>`;
    }).join("");
  }

  function tableBlock(items, headerBg, headerText, borderColor, textColor) {
    return `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${borderColor};border-radius:10px;overflow:hidden;margin-bottom:0">
      <thead><tr style="background:${headerBg}">
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Facility</th>
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Date</th>
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Time</th>
        <th style="padding:9px 14px;text-align:left;font-size:10px;font-weight:700;color:${headerText};text-transform:uppercase;letter-spacing:0.08em;border-bottom:1px solid ${borderColor}">Purpose</th>
      </tr></thead>
      <tbody>${tableRows(items, textColor, borderColor)}</tbody>
    </table>`;
  }

  const headerBg   = isDeletionOnly ? "linear-gradient(135deg,#5c0a0a 0%,#7f1d1d 100%)" : "linear-gradient(135deg,#1e3a1e 0%,#2d5a2d 100%)";
  const headerIcon = isDeletionOnly ? "🗑" : "📋";
  const headerTitle= isDeletionOnly ? `Booking${deletedBookings.length>1?"s":""} Removed` : "Booking Request Received";
  const headerSub  = isDeletionOnly
    ? `${deletedBookings.length} booking${deletedBookings.length>1?"s have":" has"} been permanently removed.`
    : "Your request has been submitted and is awaiting admin review.";
  const refBlock   = orderRef ? `<div style="background:rgba(255,255,255,0.15);border-radius:8px;padding:9px 14px;text-align:center;white-space:nowrap"><div style="font-size:9px;color:rgba(255,255,255,0.55);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:3px">Ref</div><div style="font-size:12px;font-weight:800;color:#fff;font-family:monospace">${orderRef}</div></div>` : "";

  const addedSection = hasAdded ? `
    <div style="font-size:10px;font-weight:700;color:#22c55e;text-transform:uppercase;letter-spacing:0.1em;margin:24px 0 10px">✅ Added Bookings (${bkgs.length})</div>
    ${tableBlock(bkgs,"#f0fdf4","#166534","#bbf7d0","#14532d")}
    <div style="margin-top:14px;padding:13px 16px;background:#fefce8;border:1px solid #fde68a;border-radius:8px;font-size:13px;color:#92400e">
      ⏳ Your bookings are <strong>pending approval</strong>. You'll receive a follow-up email once reviewed.
    </div>` : "";

  const deletedSection = hasDeleted ? `
    <div style="font-size:10px;font-weight:700;color:#ef4444;text-transform:uppercase;letter-spacing:0.1em;margin:${hasAdded?"20px":"24px"} 0 10px">🗑 Removed Bookings (${deletedBookings.length})</div>
    ${tableBlock(deletedBookings,"#fef2f2","#991b1b","#fecaca","#7f1d1d")}
    <div style="margin-top:14px;padding:13px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:13px;color:#991b1b">
      These bookings have been <strong>permanently removed</strong>. If you believe this was an error, please contact the facility administrator.
    </div>` : "";

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px"><tr><td align="center">
<table width="580" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.10)">
  <tr><td style="background:${headerBg};padding:32px 36px 28px">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.14em;margin-bottom:8px">FacilityBook</div>
        <div style="font-size:24px;font-weight:800;color:#fff;line-height:1.25">${headerIcon} ${headerTitle}</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.7);margin-top:6px;line-height:1.5">${headerSub}</div>
      </td>
      ${refBlock ? `<td align="right" valign="top" style="padding-left:16px">${refBlock}</td>` : ""}
    </tr></table>
  </td></tr>
  <tr><td style="padding:28px 36px">
    <p style="margin:0 0 4px;font-size:15px;color:#334155">Hi <strong style="color:#0f172a">${name}</strong>,</p>
    ${addedSection}
    ${deletedSection}
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">If you have questions, please contact the facility administrator directly.</p>
  </td></tr>
  <tr><td style="padding:14px 36px 20px;background:#f8fafc;font-size:11px;color:#94a3b8;text-align:center">FacilityBook · Automated notification · ${email}</td></tr>
</table>
</td></tr></table></body></html>`;
}

// Build HTML for approval/rejection/status notification
function buildApprovalEmailHtml({ name, email, bookings: bkgs, newStatus, adminNote }) {
  const isApproved = newStatus === "approved";
  const isQueued = newStatus === "queued_cpsa" || newStatus === "amua_submit";
  const isCpsaConfirmed = newStatus === "cpsa_confirmed";
  const isCpsaReview = newStatus === "cpsa_review_needed";
  const color = isApproved ? "#22c55e" : isCpsaConfirmed ? "#0891b2" : isQueued ? "#3b82f6" : isCpsaReview ? "#d97706" : "#f43f5e";
  const label = isApproved ? "Approved ✓" : isCpsaConfirmed ? "Confirmed by GTEC ✓" : isQueued ? "Queued for GTEC Review" : isCpsaReview ? "Needs Review — GTEC Mismatch" : "Rejected ✗";
  const bodyText = isApproved
    ? "Great news — your booking request has been approved!"
    : isCpsaConfirmed
    ? "Good news — GTEC has confirmed your booking. The details on GTEC's official schedule match what you booked, so nothing further is needed."
    : isQueued
    ? "Your booking request has been reviewed by AMUA and is now queued to be submitted to GTEC for final approval. We'll notify you once a decision has been made."
    : isCpsaReview
    ? "The details GTEC holds for your booking currently differ from your original request. AMUA is clarifying this with GTEC — nothing is final yet, and we'll do our best to align it to your original request."
    : "We're sorry — your booking request could not be approved.";
  const rows = bkgs.map(b => {
    const f = FACILITIES.find(x=>x.id===b.facility_id);
    return `<tr>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${f?.name||b.facility_id}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${fmtDate(b.date)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${b.purpose}</td>
    </tr>`;
  }).join("");
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8fafc;font-family:'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
  <tr><td style="background:${color};padding:28px 32px">
    <div style="font-size:22px;font-weight:800;color:#fff;letter-spacing:-0.02em">Booking ${label}</div>
  </td></tr>
  <tr><td style="padding:28px 32px">
    <p style="margin:0 0 6px;font-size:15px;color:#0f172a">Hi <strong>${name}</strong>,</p>
    <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6">${bodyText}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f1f5f9;border-radius:10px;overflow:hidden">
      <thead><tr style="background:#f8fafc">
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Facility</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Date</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Time</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em">Purpose</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${adminNote?`<div style="margin-top:16px;padding:14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#475569"><strong>Note from admin:</strong> ${adminNote}</div>`:""}
    <p style="margin:24px 0 0;font-size:12px;color:#94a3b8">If you have questions, please contact the facility manager.</p>
  </td></tr>
  <tr><td style="padding:16px 32px 24px;background:#f8fafc;font-size:11px;color:#94a3b8;text-align:center">FacilityBook · Sent to ${email}</td></tr>
</table></td></tr></table></body></html>`;
}

// Rich CPSA-mismatch email shown to the booker: each booking's booked → CPSA
// diff plus reassurance that AMUA is clarifying with CPSA. Single source of truth
// shared by the manual "Notify affected users" action and the automatic sync
// notification, so both read identically.
function buildMismatchEmailHtml({ name, email, bookings: bkgs }) {
  const rows = bkgs.map(b => {
    const fac = FACILITIES.find(x => x.id === b.facility_id);
    const reasons = parseMismatchNote(b.system_notes, b.notes);
    const cv = extractCpsaAmendValues(reasons, b);
    const cfac = FACILITIES.find(x => x.id === cv.facility_id);
    const facNote = b.facility_id !== cv.facility_id ? " (" + (cfac?.name || cv.facility_id) + ")" : "";
    return "<tr>"
      + "<td style='padding:6px 8px'>" + (b.purpose || "Booking") + "</td>"
      + "<td style='padding:6px 8px'>" + (fac?.name || b.facility_id) + "</td>"
      + "<td style='padding:6px 8px'>" + fmtDate(b.date) + "</td>"
      + "<td style='padding:6px 8px'><span style='text-decoration:line-through;color:#94a3b8'>" + fmtTime(b.start_hour) + "–" + fmtTime(b.start_hour + b.duration) + "</span> → <span style='color:#a16207;font-weight:700'>" + fmtTime(cv.start_hour) + "–" + fmtTime(cv.start_hour + cv.duration) + facNote + "</span></td>"
      + "<td style='padding:6px 8px;color:#64748b'>" + reasons.join("; ") + "</td>"
      + "</tr>";
  }).join("");
  return "<div style='font-family:sans-serif;max-width:640px'>"
    + "<h2 style='color:#b45309'>⚡ GTEC Booking Mismatch — Please Review</h2>"
    + "<p>Hi " + (name || email) + ",</p>"
    + "<p>The details GTEC holds for the following booking(s) currently differ from your original request. We're clarifying these with GTEC, so nothing is final yet.</p>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;border:1px solid #fde68a'><thead><tr style='background:#fef3c7'><th style='padding:8px;text-align:left'>Booking</th><th style='padding:8px'>Field</th><th style='padding:8px'>Date</th><th style='padding:8px'>Booked → GTEC</th><th style='padding:8px'>Changes</th></tr></thead><tbody>" + rows + "</tbody></table>"
    + "<p>AMUA will do its best to align each booking to your original request as closely as it can. If the booked time ends up reduced, the difference will be credited against a future invoice. If you have any questions, just reply to this email and we'll follow up.</p>"
    + "<p style='color:#64748b;font-size:12px'>Automated notification from FacilityBook – AMUA.</p></div>";
}

// Email to a vendor (e.g. a CPSA contact) asking them to correct CPSA's schedule
// so it matches AMUA's record. Carries the booking's CPSA submission link(s) and
// a notification reference. Sent by the "Inform CPSA" action; does not change the
// booking.
function buildInformCpsaEmailHtml({ vendorName, booking, refs = [], submissionId }) {
  const fac = FACILITIES.find(x => x.id === booking.facility_id);
  const reasons = parseMismatchNote(booking.system_notes, booking.notes);
  const cv = extractCpsaAmendValues(reasons, booking);
  const cfac = FACILITIES.find(x => x.id === cv.facility_id);
  const facNote = booking.facility_id !== cv.facility_id ? " — GTEC shows " + (cfac?.name || cv.facility_id) : "";
  const reasonRows = reasons.length
    ? reasons.map(r => { const p = splitReason(r); return "<tr><td style='padding:4px 8px;font-weight:600;color:#0f172a'>" + p.label + "</td><td style='padding:4px 8px;color:#15803d;font-weight:700'>AMUA: " + (p.old || "—") + "</td><td style='padding:4px 8px;color:#b45309'>GTEC now: " + (p.next || "—") + "</td></tr>"; }).join("")
    : "<tr><td colspan='3' style='padding:4px 8px;color:#64748b'>See booking details above.</td></tr>";
  const linkRows = refs.length
    ? refs.map(r => "<div style='margin:4px 0'><a href='" + r.url + "' style='color:#0369a1;font-weight:600'>" + (r.ref || "View on Sporty") + " ↗</a> <span style='color:#94a3b8;font-size:12px'>" + (r.date || "") + "</span></div>").join("")
    : "<div style='color:#64748b;font-size:13px'>No GTEC submission link is on file for this booking.</div>";
  return "<div style='font-family:sans-serif;max-width:640px'>"
    + "<h2 style='color:#0369a1'>GTEC Booking Discrepancy — Correction Requested</h2>"
    + "<p>Hi " + (vendorName || "there") + ",</p>"
    + "<p>AMUA's record for the booking below differs from what GTEC currently holds. Please review and correct GTEC's schedule to match our record (the <strong>AMUA</strong> values).</p>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;margin:12px 0;border:1px solid #e2e8f0'><tbody>"
    + "<tr><td style='padding:6px 8px;color:#64748b;width:96px'>Booker</td><td style='padding:6px 8px;color:#0f172a'>" + (booking.name || "") + "</td></tr>"
    + "<tr><td style='padding:6px 8px;color:#64748b'>Field</td><td style='padding:6px 8px;color:#0f172a'>" + (fac?.name || booking.facility_id) + facNote + "</td></tr>"
    + "<tr><td style='padding:6px 8px;color:#64748b'>Date</td><td style='padding:6px 8px;color:#0f172a'>" + fmtDate(booking.date) + "</td></tr>"
    + "<tr><td style='padding:6px 8px;color:#64748b'>Time (AMUA)</td><td style='padding:6px 8px;color:#0f172a;font-weight:700'>" + fmtTime(booking.start_hour) + "–" + fmtTime(booking.start_hour + booking.duration) + " (" + booking.duration + "h)</td></tr>"
    + "</tbody></table>"
    + "<div style='font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin:14px 0 4px'>Discrepancies</div>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0'><tbody>" + reasonRows + "</tbody></table>"
    + "<div style='font-size:12px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.04em;margin:14px 0 4px'>GTEC record</div>"
    + linkRows
    + (submissionId ? "<p style='color:#94a3b8;font-size:12px;margin-top:14px'>Reference: " + submissionId + "</p>" : "")
    + "<p style='color:#64748b;font-size:12px'>Sent from FacilityBook – AMUA.</p></div>";
}

// Scheduling-clash email shown to a booker whose booking overlaps an admin/field
// reservation. Top-level so the cart outbox can send it on submit.
function buildClashEmailHtml({ name, email, clashes }) {
  const rows = (clashes || []).map(c => {
    const f = FACILITIES.find(x => x.id === c.admin.facility_id);
    return "<tr><td style='padding:6px 8px'>" + (c.admin.purpose || "Admin booking") + "</td><td style='padding:6px 8px'>" + (f?.name || "") + "</td><td style='padding:6px 8px'>" + fmtDate(c.admin.date) + "</td><td style='padding:6px 8px'>" + fmtTime(c.admin.start_hour) + "–" + fmtTime(c.admin.start_hour + c.admin.duration) + "</td><td style='padding:6px 8px'>" + (c.user.purpose || "Your booking") + "</td></tr>";
  }).join("");
  return "<div style='font-family:sans-serif;max-width:600px'>"
    + "<h2 style='color:#9f1239'>⚠️ Scheduling Clash Notice</h2>"
    + "<p>Hi " + (name || email) + ",</p>"
    + "<p>One or more of your bookings at Cornwall Park clash with scheduled field bookings on the same facility at the same time.</p>"
    + "<table style='width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;border:1px solid #f1f5f9'><thead><tr style='background:#f8fafc'><th style='padding:8px;text-align:left'>Field Booking</th><th style='padding:8px'>Facility</th><th style='padding:8px'>Date</th><th style='padding:8px'>Time</th><th style='padding:8px'>Your Booking</th></tr></thead><tbody>" + rows + "</tbody></table>"
    + "<p>Please contact AMUA to discuss rescheduling.</p>"
    + "<p style='color:#64748b;font-size:12px'>Automated notification from FacilityBook – AMUA.</p></div>";
}

const S = {
  inp:  {width:"100%",padding:"9px 12px",borderRadius:8,border:"1.5px solid #e2e8f0",fontSize:14,color:"#0f172a",background:"#f8fafc",outline:"none",boxSizing:"border-box",fontFamily:"inherit"},
  lbl:  {display:"block",fontSize:12,fontWeight:600,color:"#64748b",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"},
  btn:  (x={})=>({padding:"8px 18px",borderRadius:8,border:"none",cursor:"pointer",fontSize:13,fontWeight:600,fontFamily:"inherit",...x}),
  card: {background:"#fff",borderRadius:16,border:"1px solid #f1f5f9",padding:24,boxShadow:"0 1px 8px rgba(0,0,0,0.04)"},
};

// ─── Google Sign-In ───────────────────────────────────────────────────────────
function EmailLoginScreen() {
  const [busy, setBusy] = useState(false);
  async function signIn() {
    if (!supabase) return;
    setBusy(true);
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + import.meta.env.BASE_URL },
    });
  }
  return (
    <div style={{minHeight:"100vh",background:"#f8fafc",display:"flex",alignItems:"center",justifyContent:"center",padding:16,fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif"}}>
      <div style={{background:"#fff",borderRadius:20,padding:40,maxWidth:400,width:"100%",boxShadow:"0 8px 40px rgba(0,0,0,0.10)",border:"1px solid #f1f5f9"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:28}}>
          <img src={LOGO_SRC} alt="AMUA" style={{width:48,height:48,borderRadius:10,objectFit:"cover"}}/>
          <div>
            <div style={{fontSize:20,fontWeight:800,color:"#0f172a",letterSpacing:"-0.02em"}}>FacilityBook</div>
            <div style={{fontSize:13,color:"#64748b"}}>Sign in to manage bookings</div>
          </div>
        </div>
        <button onClick={signIn} disabled={busy} style={S.btn({width:"100%",padding:"11px",background:"#2d4a1e",color:"#fff",fontSize:14,opacity:busy?0.7:1,cursor:busy?"wait":"pointer"})}>
          {busy ? "Redirecting…" : "Sign in with Google"}
        </button>
        <p style={{marginTop:16,fontSize:12,color:"#94a3b8",textAlign:"center",lineHeight:1.5}}>Only authorised Google accounts can access this system.</p>
      </div>
    </div>
  );
}

// ─── Small UI atoms ───────────────────────────────────────────────────────────
function Badge({status}) {
  const m=STATUS_META[status]||STATUS_META.pending_amua;
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,padding:"2px 10px",borderRadius:999,background:m.bg,border:`1px solid ${m.border}`,color:m.text,fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}><span style={{width:6,height:6,borderRadius:"50%",background:m.dot,display:"inline-block"}}/>{m.label}</span>;
}
function EmailChip({email}) {
  const c=emailColor(email);
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:999,background:c+"18",border:`1px solid ${c}44`,color:c,fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{email||"unknown"}</span>;
}
function Modal({title,onClose,children,width=560}) {
  useEffect(()=>{
    const onKey=e=>{ if(e.key==="Escape"){ e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown",onKey);
    return ()=>window.removeEventListener("keydown",onKey);
  },[onClose]);
  return (
    <div onClick={e=>e.target===e.currentTarget&&onClose()} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1000,padding:"0",backdropFilter:"blur(2px)"}}
      className="modal-backdrop">
      <div style={{background:"#fff",borderRadius:"16px 16px 0 0",width:"100%",maxWidth:width,maxHeight:"92vh",display:"flex",flexDirection:"column",boxShadow:"0 -8px 40px rgba(0,0,0,0.2)"}}
        onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"20px 24px 16px",borderBottom:"1px solid #f1f5f9",flexShrink:0}}>
          <h2 style={{margin:0,fontSize:18,fontWeight:700,color:"#0f172a"}}>{title}</h2>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"#94a3b8",lineHeight:1,padding:4}}>✕</button>
        </div>
        <div style={{padding:24,flex:1,minHeight:0,display:"flex",flexDirection:"column",overflowY:"auto",overflowX:"hidden"}}>{children}</div>
      </div>
    </div>
  );
}
function ActivityLogModal({onClose, inline=false}) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("sync"); // sync | all
  const SYNC_ACTIONS = useMemo(()=>new Set([
    "cpsa_sync_start","cpsa_sync_complete","cpsa_confirm","cpsa_review_flag",
    "cpsa_admin_booking_add","cpsa_admin_booking_remove","mismatch_resolution","mismatch_billing_settled"
  ]),[]);
  useEffect(()=>{
    (async ()=>{
      try {
        const data = await sb.select("activity_log", "select=*&limit=200");
        setRows(data||[]);
      } catch(e) { setError(e.message); setRows([]); }
    })();
  },[]);
  // Collapse sign_in/sign_out into one row per user (most recent) — admins want
  // "last login per user", not a history of every session.
  const collapsed = useMemo(() => {
    if (!rows) return [];
    const out = [];
    const seenLogin = new Set();
    for (const r of rows) { // rows arrive in created_at DESC order from sb.select
      if (r.action === "sign_in" || r.action === "sign_out") {
        const key = `${r.action}:${(r.user_email||r.user_id||"").toLowerCase()}`;
        if (seenLogin.has(key)) continue;
        seenLogin.add(key);
      }
      out.push(r);
    }
    return out;
  }, [rows]);
  const filtered = collapsed.filter(r => filter==="all" ? true : SYNC_ACTIONS.has(r.action));
  const actionStyle = a => {
    if (a.startsWith("cpsa_sync")) return {color:"#0e7490",bg:"#ecfeff",border:"#a5f3fc"};
    if (a==="cpsa_confirm") return {color:"#0e7490",bg:"#ecfeff",border:"#a5f3fc"};
    if (a==="cpsa_review_flag") return {color:"#b45309",bg:"#fffbeb",border:"#fde68a"};
    if (a.startsWith("cpsa_admin_booking")) return {color:"#475569",bg:"#f8fafc",border:"#e2e8f0"};
    if (a.startsWith("mismatch")) return {color:"#7c3aed",bg:"#f5f3ff",border:"#ddd6fe"};
    if (a==="sign_in"||a==="sign_out") return {color:"#475569",bg:"#f8fafc",border:"#e2e8f0"};
    return {color:"#475569",bg:"#fff",border:"#e2e8f0"};
  };
  const ALWrapper = inline
    ? ({children}) => <div style={{background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:12,padding:16,maxHeight:520,display:"flex",flexDirection:"column"}}><div style={{fontSize:14,fontWeight:700,color:"#0f172a",marginBottom:10}}>📜 Activity Log</div>{children}</div>
    : ({children}) => <Modal title="📜 Activity Log" onClose={onClose} width={780}>{children}</Modal>;
  return (
    <ALWrapper>
      <div style={{display:"flex",flexDirection:"column",gap:10,minHeight:0,flex:1}}>
        <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
          <button onClick={()=>setFilter("sync")} style={{padding:"4px 10px",borderRadius:14,border:`1.5px solid ${filter==="sync"?"#0f172a":"#e2e8f0"}`,background:filter==="sync"?"#0f172a":"#fff",color:filter==="sync"?"#fff":"#475569",fontSize:12,fontWeight:600,fontFamily:"inherit",cursor:"pointer"}}>Sync & GTEC</button>
          <button onClick={()=>setFilter("all")} style={{padding:"4px 10px",borderRadius:14,border:`1.5px solid ${filter==="all"?"#0f172a":"#e2e8f0"}`,background:filter==="all"?"#0f172a":"#fff",color:filter==="all"?"#fff":"#475569",fontSize:12,fontWeight:600,fontFamily:"inherit",cursor:"pointer"}}>All</button>
          <span style={{marginLeft:"auto",fontSize:11,color:"#94a3b8"}}>{rows===null?"Loading…":`${filtered.length} of ${collapsed.length} entries (logins collapsed to most-recent per user)`}</span>
        </div>
        {error&&<div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:6,padding:"6px 10px",fontSize:12,color:"#b91c1c"}}>⚠ {error} — has <code>supabase-migration-activity-log.sql</code> been run?</div>}
        <div style={{overflowY:"auto",flex:1,minHeight:0,border:"1px solid #f1f5f9",borderRadius:8}}>
          <CopyableTable>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead style={{position:"sticky",top:0,background:"#f8fafc",zIndex:1}}>
              <tr>
                <th style={{textAlign:"left",padding:"7px 10px",fontWeight:700,color:"#475569",borderBottom:"1px solid #e2e8f0"}}>When</th>
                <th style={{textAlign:"left",padding:"7px 10px",fontWeight:700,color:"#475569",borderBottom:"1px solid #e2e8f0"}}>Action</th>
                <th style={{textAlign:"left",padding:"7px 10px",fontWeight:700,color:"#475569",borderBottom:"1px solid #e2e8f0"}}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length===0&&rows!==null
                ? <tr><td colSpan={3} style={{padding:24,textAlign:"center",color:"#94a3b8",fontSize:13}}>No activity matches this filter.</td></tr>
                : filtered.map(r=>{
                    const st = actionStyle(r.action);
                    return (
                      <tr key={r.id} style={{borderBottom:"1px solid #f1f5f9"}}>
                        <td style={{padding:"6px 10px",color:"#64748b",whiteSpace:"nowrap",fontSize:11}}>{new Date(r.created_at).toLocaleString("en-NZ",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</td>
                        <td style={{padding:"6px 10px",whiteSpace:"nowrap"}}><span style={{fontSize:11,fontWeight:700,padding:"1px 7px",borderRadius:10,background:st.bg,color:st.color,border:`1px solid ${st.border}`}}>{r.action}</span></td>
                        <td style={{padding:"6px 10px",color:"#475569",fontFamily:"ui-monospace,monospace",fontSize:11,wordBreak:"break-word"}}>{r.detail?JSON.stringify(r.detail):""}</td>
                      </tr>
                    );
                  })
              }
            </tbody>
          </table>
          </CopyableTable>
        </div>
      </div>
    </ALWrapper>
  );
}

// Admin UI: map secondary emails into a primary profile + manage profile details.
function UserMgmtModal({ bookings, aliases, aliasNames, onChange, onChangeNames, profiles, onUpdateProfile, adminEmail, onClose, onViewAs }) {
  const allEmails = useMemo(() => {
    const s = new Set();
    bookings.forEach(b => { if (b.email && !isAdminBooking(b)) s.add(b.email.toLowerCase()); });
    Object.keys(aliases||{}).forEach(k => s.add(k));
    Object.values(aliases||{}).forEach(v => s.add(v));
    return [...s].sort();
  }, [bookings, aliases]);
  // Collect every distinct `name` value a booker has used on bookings, keyed by email.
  const namesByEmail = useMemo(() => {
    const m = {};
    bookings.forEach(b => {
      if (!b.email || isAdminBooking(b) || !b.name) return;
      const k = b.email.toLowerCase();
      if (!m[k]) m[k] = new Set();
      m[k].add(b.name);
    });
    return m;
  }, [bookings]);
  // group emails by primary
  const groups = useMemo(() => {
    const g = {};
    allEmails.forEach(em => {
      const primary = aliases[em] || em;
      if (!g[primary]) g[primary] = new Set();
      g[primary].add(em);
    });
    return g;
  }, [allEmails, aliases]);
  function setAliasName(primary, value) {
    const next = { ...(aliasNames||{}) };
    const trimmed = (value||"").trim();
    const dflt = primary.split("@")[0];
    if (!trimmed || trimmed === dflt) delete next[primary];
    else next[primary] = trimmed;
    onChangeNames(next);
  }
  const [linkSource, setLinkSource] = useState("");
  const [linkTarget, setLinkTarget] = useState("");
  const [expandedProfile, setExpandedProfile] = useState(null);

  function link() {
    if (!linkSource || !linkTarget) return;
    const src = linkSource.toLowerCase().trim();
    const tgt = linkTarget.toLowerCase().trim();
    if (src === tgt) return;
    const next = { ...aliases };
    const realTarget = next[tgt] || tgt;
    Object.keys(next).forEach(k => { if (next[k] === src) next[k] = realTarget; });
    next[src] = realTarget;
    onChange(next);
    setLinkSource(""); setLinkTarget("");
  }
  function unlink(em) {
    const next = { ...aliases };
    delete next[em];
    onChange(next);
  }
  function upProfile(primary, field, value) {
    const k = primary.toLowerCase();
    const next = { ...(profiles||{}) };
    next[k] = { ...(next[k]||{}), [field]: value };
    onUpdateProfile(next);
  }

  const si = {padding:"4px 8px",fontSize:12,borderRadius:6,border:"1.5px solid #e2e8f0",fontFamily:"inherit",outline:"none",width:"100%"};
  const fieldRow = (label, content) => (
    <div style={{display:"grid",gridTemplateColumns:"80px 1fr",alignItems:"start",gap:6,marginBottom:6}}>
      <span style={{fontSize:11,color:"#64748b",fontWeight:600,paddingTop:5}}>{label}</span>
      {content}
    </div>
  );

  // All primaries including adminEmail and any standalone profiles (e.g. vendors not linked to a Google account yet).
  const allPrimaries = useMemo(() => {
    const s = new Set(Object.keys(groups));
    if (adminEmail) s.add(adminEmail.toLowerCase());
    Object.keys(profiles||{}).forEach(k => s.add(k));
    return [...s].sort();
  }, [groups, adminEmail, profiles]);

  // Create-vendor form state
  const [newVendorEmail, setNewVendorEmail] = useState("");
  const [newVendorName, setNewVendorName] = useState("");
  function createVendor() {
    const em = newVendorEmail.trim().toLowerCase();
    if (!em) return;
    const next = { ...(profiles||{}) };
    next[em] = { ...(next[em]||{}), profileType:"vendor", fullName: newVendorName.trim() || next[em]?.fullName || "" };
    onUpdateProfile(next);
    setNewVendorEmail(""); setNewVendorName("");
    setExpandedProfile(em);
  }

  return (
    <Modal title="👤 User Management" onClose={onClose} width={680}>
      {/* Email alias linking */}
      <div style={{background:"#f8fafc",border:"1.5px solid #e2e8f0",borderRadius:10,padding:12,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8}}>Link email aliases</div>
        <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>Map a secondary email onto a primary profile — bookings, filters and summaries treat both as the same user.</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <select value={linkSource} onChange={e=>setLinkSource(e.target.value)}
            style={{flex:"1 1 180px",padding:"6px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}>
            <option value="">Secondary email…</option>
            {allEmails.filter(em=>!aliases[em]).map(em=><option key={em} value={em}>{em}</option>)}
          </select>
          <span style={{fontSize:11,color:"#64748b"}}>→ maps to</span>
          <select value={linkTarget} onChange={e=>setLinkTarget(e.target.value)}
            style={{flex:"1 1 180px",padding:"6px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}>
            <option value="">Primary email…</option>
            {allEmails.filter(em=>em!==linkSource).map(em=><option key={em} value={em}>{em}</option>)}
          </select>
          <button onClick={link} disabled={!linkSource||!linkTarget}
            style={S.btn({background:linkSource&&linkTarget?"#0f172a":"#cbd5e1",color:"#fff",fontSize:12,cursor:linkSource&&linkTarget?"pointer":"not-allowed"})}>
            Link
          </button>
        </div>
      </div>

      {/* Vendor pre-config */}
      <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"8px 12px",marginBottom:12,fontSize:11,color:"#166534"}}>
        <strong>Vendor (GTEC)</strong> — Grammar TEC Rugby Club Inc · GST 113-246-812 · PO BOX 42 210, Orakei, Auckland · pre-configured as PO recipient
      </div>

      {/* Create standalone vendor profile (works without a linked Google login) */}
      <div style={{background:"#f8fafc",border:"1.5px solid #e2e8f0",borderRadius:10,padding:12,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:6}}>Create vendor profile</div>
        <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>Vendor profiles can exist standalone — they show as a user before a Google account is linked.</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input value={newVendorEmail} onChange={e=>setNewVendorEmail(e.target.value)}
            placeholder="vendor email…"
            style={{flex:"1 1 180px",padding:"6px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}/>
          <input value={newVendorName} onChange={e=>setNewVendorName(e.target.value)}
            placeholder="display name (optional)"
            style={{flex:"1 1 180px",padding:"6px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}/>
          <button onClick={createVendor} disabled={!newVendorEmail.trim()}
            style={S.btn({background:newVendorEmail.trim()?"#15803d":"#cbd5e1",color:"#fff",fontSize:12,cursor:newVendorEmail.trim()?"pointer":"not-allowed"})}>
            + Create
          </button>
        </div>
      </div>

      {/* Profile cards */}
      <div style={{fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:6}}>Profiles ({allPrimaries.length})</div>
      <div style={{display:"flex",flexDirection:"column",gap:8,paddingRight:2}}>
        {allPrimaries.map(primary => {
          const secondaries = [...(groups[primary]||new Set())].filter(e=>e!==primary).sort();
          const dflt = primary.split("@")[0];
          const aliasName = (aliasNames||{})[primary] || "";
          const prof = (profiles||{})[primary] || {};
          const ptype = prof.profileType || (primary === adminEmail?.toLowerCase() ? "admin" : "user");
          const isExpanded = expandedProfile === primary;
          // Gather all booker `name` values seen on either the primary or its secondaries.
          const allNames = new Set();
          [primary, ...secondaries].forEach(em => { (namesByEmail[em]||[]).forEach(n=>allNames.add(n)); });
          const PTYPE_COLOR = { admin:"#7c3aed", user:"#0369a1", vendor:"#15803d" };
          return (
            <div key={primary} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,overflow:"hidden"}}>
              {/* Header row — always visible */}
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"8px 12px",cursor:"pointer"}}
                onClick={()=>setExpandedProfile(isExpanded?null:primary)}>
                <span style={{width:9,height:9,borderRadius:"50%",background:emailColor(primary),flexShrink:0}}/>
                <span style={{fontSize:13,fontWeight:700,color:"#0f172a",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{primary}</span>
                <span style={{fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:10,background:`${PTYPE_COLOR[ptype]}18`,color:PTYPE_COLOR[ptype],border:`1px solid ${PTYPE_COLOR[ptype]}40`,flexShrink:0}}>{ptype}</span>
                {onViewAs && primary !== adminEmail?.toLowerCase() && (
                  <button onClick={e=>{e.stopPropagation(); onViewAs(primary);}}
                    title={`View interface as ${primary}`}
                    style={{padding:"3px 8px",borderRadius:6,border:"1px solid #c7d2fe",background:"#eef2ff",color:"#4338ca",cursor:"pointer",fontSize:10,fontWeight:700,fontFamily:"inherit",flexShrink:0}}>
                    👁 View as
                  </button>
                )}
                <span style={{fontSize:11,color:"#94a3b8",flexShrink:0}}>{isExpanded?"▴":"▾"}</span>
              </div>
              {/* Expanded detail */}
              {isExpanded && (
                <div style={{padding:"0 12px 12px",borderTop:"1px solid #f1f5f9",display:"flex",flexDirection:"column",gap:0}}>
                  <div style={{paddingTop:10}}>
                    {/* Profile type */}
                    <div style={{display:"grid",gridTemplateColumns:"80px 1fr",gap:6,marginBottom:6,alignItems:"center"}}>
                      <span style={{fontSize:11,color:"#64748b",fontWeight:600}}>Type</span>
                      <div style={{display:"flex",gap:4}}>
                        {["user","vendor"].map(t=>(
                          <button key={t} onClick={()=>upProfile(primary,"profileType",t)}
                            style={{padding:"2px 10px",borderRadius:10,border:`1.5px solid ${ptype===t?PTYPE_COLOR[t]:"#e2e8f0"}`,
                              background:ptype===t?PTYPE_COLOR[t]:"#f8fafc",color:ptype===t?"#fff":"#475569",
                              fontSize:11,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                            {t}
                          </button>
                        ))}
                      </div>
                    </div>
                    {/* Alias / display name */}
                    {fieldRow("Alias",
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <input value={aliasName} onChange={e=>setAliasName(primary,e.target.value)}
                          placeholder={dflt}
                          style={{...si,width:"auto",flex:1}}/>
                        <span style={{fontSize:10,color:"#94a3b8",whiteSpace:"nowrap"}}>default: {dflt}</span>
                      </div>
                    )}
                    {/* Full / official name */}
                    {fieldRow("Full name",
                      <input value={prof.fullName||""} onChange={e=>upProfile(primary,"fullName",e.target.value)}
                        placeholder="Official name for invoices…"
                        style={si}/>
                    )}
                    {/* Address */}
                    {fieldRow("Address",
                      <textarea value={prof.address||""} onChange={e=>upProfile(primary,"address",e.target.value)}
                        placeholder={"Street\nCity\nNEW ZEALAND"}
                        rows={3}
                        style={{...si,resize:"vertical",minHeight:58,lineHeight:1.5}}/>
                    )}
                    {/* GST */}
                    {fieldRow("GST no.",
                      <input value={prof.gstNumber||""} onChange={e=>upProfile(primary,"gstNumber",e.target.value)}
                        placeholder="e.g. 123-456-789"
                        style={{...si,width:"auto",maxWidth:180}}/>
                    )}
                    {/* Admin-only: bank account */}
                    {ptype==="admin" && <>
                      {fieldRow("Account no.",
                        <input value={prof.accountNumber||""} onChange={e=>upProfile(primary,"accountNumber",e.target.value)}
                          placeholder="e.g. 01-1234-5678901-00"
                          style={{...si,width:"auto",maxWidth:220}}/>
                      )}
                      {fieldRow("Account name",
                        <input value={prof.accountName||""} onChange={e=>upProfile(primary,"accountName",e.target.value)}
                          placeholder="Account name…"
                          style={si}/>
                      )}
                    </>}
                    {/* Booker names from bookings */}
                    {allNames.size>0 && (
                      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4,flexWrap:"wrap"}}>
                        <span style={{fontSize:11,color:"#64748b",fontWeight:600,minWidth:80}}>Booking names</span>
                        {[...allNames].sort().map(n=>(
                          <span key={n} style={{fontSize:11,padding:"2px 8px",borderRadius:10,background:"#f8fafc",border:"1px solid #e2e8f0",color:"#475569"}}>{n}</span>
                        ))}
                      </div>
                    )}
                    {/* Linked secondaries */}
                    {secondaries.length>0 && (
                      <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:4}}>
                        <span style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em"}}>Linked emails</span>
                        {secondaries.map(s=>(
                          <div key={s} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#475569"}}>
                            <span style={{color:"#94a3b8"}}>↪</span>
                            <span style={{flex:1,wordBreak:"break-all"}}>{s}</span>
                            <button onClick={()=>unlink(s)}
                              style={{background:"#fff1f2",border:"1px solid #fda4af",borderRadius:4,color:"#f43f5e",cursor:"pointer",fontSize:11,fontWeight:600,padding:"2px 8px"}}>
                              ✕ Unlink
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {allPrimaries.length===0 && <div style={{color:"#94a3b8",fontSize:13,textAlign:"center",padding:20}}>No profiles yet.</div>}
      </div>
      <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
        <button onClick={onClose} style={S.btn({background:"#0f172a",color:"#fff",fontSize:12})}>Done</button>
      </div>
    </Modal>
  );
}

// Single chip that opens a popover with From/To date inputs and an Apply button.
// Applies only when the user clicks Apply, so partial selections don't trigger
// re-renders / refilters.
function DateRangePicker({ from, to, onApply }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from||"");
  const [draftTo, setDraftTo] = useState(to||"");
  useEffect(()=>{ if(open){ setDraftFrom(from||""); setDraftTo(to||""); } }, [open, from, to]);
  const label = (from||to)
    ? `${from?fmtDate(from):"…"} – ${to?fmtDate(to):"…"}`
    : "Any date";
  function apply() { onApply(draftFrom, draftTo); setOpen(false); }
  function clear() { setDraftFrom(""); setDraftTo(""); onApply("", ""); setOpen(false); }
  return (
    <div style={{position:"relative"}}>
      <button onClick={()=>setOpen(v=>!v)}
        style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",fontSize:11,borderRadius:5,border:`1.5px solid ${(from||to)?"#0f172a":"#cbd5e1"}`,background:"#fff",color:(from||to)?"#0f172a":"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600,width:"100%",justifyContent:"center"}}>
        📅 {label}<span style={{fontSize:9,color:"#94a3b8"}}>▾</span>
      </button>
      {open && (
        <>
          <div onClick={()=>setOpen(false)} style={{position:"fixed",inset:0,zIndex:30}}/>
          <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,zIndex:31,background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:10,boxShadow:"0 8px 24px rgba(15,23,42,0.12)",padding:12,minWidth:240,display:"flex",flexDirection:"column",gap:10}}>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>From</div>
              <input type="date" value={draftFrom} max={draftTo||undefined} onChange={e=>setDraftFrom(e.target.value)}
                style={{padding:"5px 8px",fontSize:12,border:"1.5px solid #e2e8f0",borderRadius:6,fontFamily:"inherit",width:"100%",outline:"none"}}/>
            </div>
            <div>
              <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>To</div>
              <input type="date" value={draftTo} min={draftFrom||undefined} onChange={e=>setDraftTo(e.target.value)}
                style={{padding:"5px 8px",fontSize:12,border:"1.5px solid #e2e8f0",borderRadius:6,fontFamily:"inherit",width:"100%",outline:"none"}}/>
            </div>
            <div style={{display:"flex",gap:6,justifyContent:"flex-end"}}>
              <button onClick={clear}
                style={{padding:"4px 10px",fontSize:11,borderRadius:5,border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
                Clear
              </button>
              <button onClick={apply}
                style={{padding:"4px 12px",fontSize:11,borderRadius:5,border:"none",background:"#0f172a",color:"#fff",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>
                Apply
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UserMenuItem({icon, label, onClick, danger=false}) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"9px 14px",background:hover?(danger?"#fef2f2":"#f8fafc"):"transparent",border:"none",fontFamily:"inherit",fontSize:13,color:danger?"#b91c1c":"#0f172a",textAlign:"left",cursor:"pointer",fontWeight:500}}>
      <span style={{fontSize:14,width:18,textAlign:"center"}}>{icon}</span>{label}
    </button>
  );
}
function OverlapWarning({title,description,bookings:bkgs,onProceed,onCancel}) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fffbeb",border:"1.5px solid #f59e0b",borderRadius:10,padding:"14px 16px",display:"flex",gap:12}}>
        <span style={{fontSize:24,lineHeight:1}}>⚠️</span>
        <div><div style={{fontWeight:700,fontSize:15,color:"#92400e",marginBottom:6}}>{title}</div>
          <div style={{fontSize:13,color:"#78350f",lineHeight:1.6}}>{description}</div></div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {bkgs.map(b=>{const f=FACILITIES.find(x=>x.id===b.facility_id);return(
          <div key={b.id} style={{display:"flex",gap:10,alignItems:"center",padding:"10px 14px",background:"#f8fafc",borderRadius:8,border:"1px solid #e2e8f0"}}>
            <span style={{width:10,height:10,borderRadius:"50%",background:f?.color,flexShrink:0,display:"inline-block"}}/>
            <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700,color:"#0f172a"}}>{f?.name}</div>
              <div style={{fontSize:12,color:"#64748b"}}>{b.purpose} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.name}</div></div>
            <Badge status={b.status}/>
          </div>
        );})}
      </div>
      <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:4}}>
        <button onClick={onCancel}  style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>← Go Back</button>
        <button onClick={onProceed} style={S.btn({background:"#f59e0b",color:"#fff"})}>Proceed Anyway</button>
      </div>
    </div>
  );
}

// ─── Single Booking Row Form ──────────────────────────────────────────────────
// Used inside BookingForm to represent one item in the cart
function InlineDayPicker({ date, bookings, onPick }) {
  const [drag, setDrag] = useState(null);
  const SH = 14; // shorter slot height for inline
  const yToSlot = y => Math.max(0, Math.min(Math.floor(y/SH), CAL_TOTAL*2-1));
  const slotToHour = s => CAL_START + s*0.5;
  const norm = ds => ds ? { ...ds, lo:Math.min(ds.startSlot,ds.endSlot), hi:Math.max(ds.startSlot,ds.endSlot) } : null;
  function down(e, facId) {
    if (e.button!==0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setDrag({ facility:facId, startSlot:yToSlot(e.clientY-rect.top), endSlot:yToSlot(e.clientY-rect.top) });
  }
  function move(e, facId) {
    if (!drag || drag.facility!==facId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = yToSlot(e.clientY-rect.top);
    if (slot!==drag.endSlot) setDrag(ds=>({ ...ds, endSlot:slot }));
  }
  function up(e, facId) {
    if (!drag || drag.facility!==facId) return;
    const nd = norm(drag);
    const duration = (nd.hi-nd.lo+1)*0.5;
    setDrag(null);
    onPick(facId, slotToHour(nd.lo), Math.max(0.5, duration));
  }
  const nd = norm(drag);
  const dayBkgs = bookings.filter(b=>b.date===date && !["cancelled","rejected"].includes(b.status));
  return (
    <div style={{border:"1.5px solid #e2e8f0",borderRadius:8,background:"#fff",padding:8}}>
      <div style={{fontSize:11,color:"#64748b",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>
        <span style={{fontWeight:700,color:"#0f172a"}}>📅 Pick a slot</span>
        <span>Click or drag a column to set facility, start time and duration.</span>
      </div>
      <div style={{display:"flex",overflowX:"auto"}}>
        {/* Hour labels */}
        <div style={{width:36,flexShrink:0}}>
          <div style={{height:18}}/>
          {Array.from({length:CAL_TOTAL+1},(_,i)=>CAL_START+i).map(h=>(
            <div key={h} style={{height:SH*2,fontSize:9,color:"#94a3b8",textAlign:"right",paddingRight:4}}>{fmtTime(h)}</div>
          ))}
        </div>
        {FACILITIES.map(fac=>{
          const isDragging = drag?.facility===fac.id;
          const facBkgs = dayBkgs.filter(b=>b.facility_id===fac.id);
          const colTint = FACILITY_TINT[fac.id] || "#fff";
          return (
            <div key={fac.id} style={{flex:1,minWidth:64}}>
              <div title={fac.name} style={{height:18,display:"flex",alignItems:"center",justifyContent:"center",gap:3,fontSize:9,fontWeight:700,color:fac.color,background:colTint,borderTopLeftRadius:4,borderTopRightRadius:4,borderBottom:`2px solid ${fac.color}`,overflow:"hidden",whiteSpace:"nowrap"}}>
                <span style={{width:6,height:6,borderRadius:"50%",background:fac.color,flexShrink:0}}/>
                {fac.name.includes("Field")?fac.name.replace("Field ","Fld "):fac.name.split("–")[0].trim().slice(0,8)}
              </div>
              <div onMouseDown={e=>down(e,fac.id)} onMouseMove={e=>move(e,fac.id)} onMouseUp={e=>up(e,fac.id)}
                onMouseLeave={()=>isDragging&&setDrag(null)}
                style={{position:"relative",cursor:"crosshair",background:colTint,height:CAL_TOTAL*SH*2,borderLeft:"1px solid #f1f5f9"}}>
                {Array.from({length:CAL_TOTAL},(_,i)=>(
                  <div key={i} style={{height:SH*2,borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                    <div style={{height:"50%",borderBottom:"1px dashed rgba(0,0,0,0.03)"}}/>
                  </div>
                ))}
                {facBkgs.map(b=>(
                  <div key={b.id} title={`${b.name||"booking"} · ${fmtTime(b.start_hour)}`}
                    style={{position:"absolute",left:1,right:1,top:(b.start_hour-CAL_START)*SH*2,height:Math.max(b.duration*SH*2-1,12),background:fac.color,opacity:0.75,borderRadius:3,pointerEvents:"none",overflow:"hidden",fontSize:8,color:"#fff",padding:"1px 3px"}}>
                    {b.purpose?b.purpose.slice(0,18):""}
                  </div>
                ))}
                {isDragging&&nd&&(
                  <div style={{position:"absolute",left:0,right:0,top:nd.lo*SH,height:(nd.hi-nd.lo+1)*SH,background:"rgba(99,102,241,0.20)",border:"1.5px solid #6366f1",borderRadius:4,pointerEvents:"none",zIndex:3,display:"flex",alignItems:"flex-start",justifyContent:"center",fontSize:8,fontWeight:700,color:"#4338ca",paddingTop:1}}>
                    {fmtTime(slotToHour(nd.lo))}–{fmtTime(slotToHour(nd.hi+1))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function BookingRow({ row, idx, onChange, onRemove, isOnly, isAdmin, isEditing, allBookings }) {
  const isMobile = useMobile();
  const [recurMode, setRecurMode] = useState(row.recur?.mode || "none");
  const [recurWeeks, setRecurWeeks] = useState(row.recur?.weeks || 4);
  const [recurUntil, setRecurUntil] = useState(row.recur?.until || "");
  // Manual entry for facility/time/duration. Day-grid picker opens in its own popup.
  const [showPicker, setShowPicker] = useState(false);

  function upd(k,v) { onChange(idx, {...row, [k]:v}); }
  function pickSlot(facility_id, start_hour, duration) {
    onChange(idx, {...row, facility_id, start_hour, duration});
    setShowPicker(false);
  }
  function updRecur(changes) {
    const r = {mode:recurMode, weeks:recurWeeks, until:recurUntil, ...changes};
    if(changes.mode!==undefined) setRecurMode(changes.mode);
    if(changes.weeks!==undefined) setRecurWeeks(changes.weeks);
    if(changes.until!==undefined) setRecurUntil(changes.until);
    onChange(idx, {...row, recur:r});
  }

  const canRecur = !isEditing; // recurrence only for new bookings, not edits

  return (
    <div style={{border:"1.5px solid #e2e8f0",borderRadius:12,padding:16,background:"#fafafa",display:"flex",flexDirection:"column",gap:12,position:"relative"}}>
      {!isOnly && <button onClick={()=>onRemove(idx)} style={{position:"absolute",top:10,right:10,background:"#fff1f2",border:"1px solid #fda4af",borderRadius:6,color:"#f43f5e",cursor:"pointer",fontSize:12,fontWeight:700,padding:"2px 8px"}}>✕ Remove</button>}
      {!isOnly && <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.08em"}}>Booking #{idx+1}</div>}

      {/* Date row + slot-picker launcher */}
      <div style={{display:"flex",alignItems:"flex-end",gap:10,flexWrap:"wrap"}}>
        <div style={{flex:"1 1 200px"}}>
          <label style={S.lbl}>Date *</label>
          <input style={S.inp} type="date" value={row.date} onChange={e=>upd("date",e.target.value)} min={todayKey()}/>
        </div>
        <button type="button" onClick={()=>setShowPicker(true)}
          title="Pick a slot on the day grid"
          style={S.btn({border:"1.5px solid #6366f1",background:"#eef2ff",color:"#4338ca",fontSize:12,padding:"7px 12px",fontWeight:700})}>
          📅 Pick on day grid
        </button>
      </div>

      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:10}}>
        <div>
          <label style={S.lbl}>Facility *</label>
          <select style={S.inp} value={row.facility_id} onChange={e=>upd("facility_id",e.target.value)}>
            {FACILITIES.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Start Time *</label>
          <select style={S.inp} value={row.start_hour} onChange={e=>upd("start_hour",parseFloat(e.target.value))}>
            {Array.from({length:CAL_TOTAL*2+1},(_,i)=>CAL_START+i*0.5).filter(h=>h<=CAL_END).map(h=><option key={h} value={h}>{fmtTime(h)}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label style={S.lbl}>Duration *</label>
        <select style={S.inp} value={row.duration} onChange={e=>upd("duration",parseFloat(e.target.value))}>
          {(DURATIONS.some(d=>d.value===row.duration)?DURATIONS:[...DURATIONS,{value:row.duration,label:row.duration+" hrs"}].sort((a,b)=>a.value-b.value)).map(d=><option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
      </div>

      {showPicker && (
        <Modal title={`📅 Pick a slot — ${row.date||"select date first"}`} onClose={()=>setShowPicker(false)} width={760}>
          {row.date
            ? <InlineDayPicker date={row.date} bookings={allBookings} onPick={pickSlot}/>
            : <div style={{padding:24,textAlign:"center",color:"#94a3b8",fontSize:13}}>Set a date first, then pick a slot.</div>
          }
          <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
            <button onClick={()=>setShowPicker(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:12})}>Close</button>
          </div>
        </Modal>
      )}
      <div>
        <label style={S.lbl}>Purpose *</label>
        <input style={S.inp} value={row.purpose} onChange={e=>upd("purpose",e.target.value)} placeholder="e.g. Training, Meeting…"/>
      </div>
      <div>
        <label style={S.lbl}>Notes</label>
        <textarea style={{...S.inp,resize:"vertical",minHeight:52}} value={row.notes} onChange={e=>upd("notes",e.target.value)} placeholder="Any requirements…"/>
      </div>

      {/* Recurrence — only for edit mode */}
      {canRecur && (
        <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:12}}>
          <label style={{...S.lbl,color:"#16a34a"}}>🔁 Weekly Recurrence</label>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
            <select style={{...S.inp,width:"auto"}} value={recurMode} onChange={e=>updRecur({mode:e.target.value})}>
              <option value="none">No recurrence</option>
              <option value="weeks">Repeat for N weeks</option>
              <option value="until">Repeat until date</option>
            </select>
            {recurMode==="weeks" && (
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min={1} max={52} value={recurWeeks} onChange={e=>updRecur({weeks:parseInt(e.target.value)||1})} style={{...S.inp,width:70}}/>
                <span style={{fontSize:13,color:"#475569"}}>weeks</span>
              </div>
            )}
            {recurMode==="until" && (
              <input type="date" value={recurUntil} min={row.date||todayKey()} onChange={e=>updRecur({until:e.target.value})} style={{...S.inp,width:"auto"}}/>
            )}
          </div>
          {recurMode!=="none" && (
            <div style={{fontSize:12,color:"#16a34a",marginTop:6}}>
              Will create {recurMode==="weeks"?recurWeeks:(()=>{
                if(!recurUntil||!row.date) return "?";
                const [sy,sm,sd]=row.date.split("-").map(Number);
                const [ey,em,ed]=recurUntil.split("-").map(Number);
                const diff=Math.round((Date.UTC(ey,em-1,ed)-Date.UTC(sy,sm-1,sd))/(7*86400000));
                return Math.max(1,diff+1);
              })()} bookings (weekly on same day/time)
            </div>
          )}
        </div>
      )}

      {isAdmin && isEditing && (
        <div>
          <label style={S.lbl}>Status</label>
          <select style={S.inp} value={row.status} onChange={e=>upd("status",e.target.value)}>
            {Object.entries(STATUS_META).filter(([k])=>!["pending","amua_submit"].includes(k)).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      )}

      {/* Live availability indicator */}
      {(()=>{
        if (!row.date || !row.facility_id || !row.duration) return null;
        const draft = { id: row.id || "__draft__", facility_id: row.facility_id, date: row.date, start_hour: row.start_hour, duration: row.duration, status: "pending_amua" };
        const others = allBookings.filter(b => b.id !== draft.id && !["cancelled","rejected"].includes(b.status));
        const sameClashes = getSameFacilityOverlaps(draft, others);
        const adminClashes = sameClashes.filter(b => isAdminBooking(b));
        const userClashes  = sameClashes.filter(b => !isAdminBooking(b));
        const crossClashes = getCrossFacilityOverlaps(draft, others).filter(b => !isAdminBooking(b));
        const facName = FACILITIES.find(f=>f.id===row.facility_id)?.name || row.facility_id;
        return (
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {adminClashes.length > 0 && (
              <div style={{background:"#fef2f2",border:"1px solid #fca5a5",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontWeight:700,fontSize:12,color:"#b91c1c",marginBottom:4}}>🚫 {facName} is blocked at this time</div>
                {adminClashes.map(b=>(
                  <div key={b.id} style={{fontSize:12,color:"#991b1b",padding:"1px 0"}}>
                    {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.purpose||"Facility block"}
                  </div>
                ))}
              </div>
            )}
            {userClashes.length > 0 && (
              <div style={{background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontWeight:700,fontSize:12,color:"#c2410c",marginBottom:4}}>⚠ {facName} has overlapping bookings</div>
                {userClashes.map(b=>(
                  <div key={b.id} style={{fontSize:12,color:"#9a3412",padding:"1px 0"}}>
                    {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.name||b.email} · {b.purpose}
                  </div>
                ))}
              </div>
            )}
            {crossClashes.length > 0 && (
              <div style={{background:"#fefce8",border:"1px solid #fde68a",borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontWeight:700,fontSize:12,color:"#854d0e",marginBottom:4}}>ℹ Other facilities also booked at this time</div>
                {crossClashes.map(b=>{
                  const cf=FACILITIES.find(f=>f.id===b.facility_id);
                  return (
                    <div key={b.id} style={{fontSize:12,color:"#713f12",padding:"1px 0"}}>
                      {cf?.name||b.facility_id} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.name||b.email}
                    </div>
                  );
                })}
              </div>
            )}
            {sameClashes.length === 0 && (
              <div style={{fontSize:12,color:"#16a34a",display:"flex",alignItems:"center",gap:5}}>
                <span style={{width:7,height:7,borderRadius:"50%",background:"#22c55e",display:"inline-block"}}/>
                {facName} is available {fmtTime(row.start_hour)}–{fmtTime(row.start_hour+row.duration)} on {fmtDate(row.date)}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ─── Multi-Edit Form ──────────────────────────────────────────────────────────
// Edits the shared start_time/duration across a set of same-weekday bookings.
// The new dates are calculated by keeping each booking's original calendar week
// but shifting to a new weekday if changed.
// ─── Cart Modal ───────────────────────────────────────────────────────────────
function CartModal({ cart, setCart, onClose, onSubmit, openNew, silentMode=false, onToggleSilent }) {
  const [editingDraft, setEditingDraft] = useState(null); // {gi, di, draft}
  const [expandedNotify, setExpandedNotify] = useState(new Set()); // email keys that are open
  const totalNew    = cart.filter(i=>!i.isEdit&&!i.isMultiEdit&&!i.notifyOnly&&!i.statusChange).reduce((s,i)=>s+i.drafts.length,0);
  const totalEdits  = cart.filter(i=>i.isEdit||i.isMultiEdit).reduce((s,i)=>s+i.drafts.length,0);
  const totalStatus = cart.filter(i=>i.statusChange).reduce((s,i)=>s+(i.ids?.length||i.drafts?.length||0),0);
  const totalNotify = cart.filter(i=>i.notifyOnly&&!i.informCpsa&&!i.clashNotify).reduce((s,i)=>s+(i.drafts?.length||0),0);
  const totalClash  = cart.filter(i=>i.clashNotify).length;
  const totalInform = cart.filter(i=>i.informCpsa).reduce((s,i)=>s+(i.drafts?.length||0),0);
  // Group CPSA status notify-only items by booker email so the cart doesn't explode
  // into one row per booking. Status-change, clash and inform-CPSA items are rendered
  // separately below (clash/inform have no drafts to group).
  const notifyByEmail = {};
  cart.forEach((item, gi) => {
    if (!item.notifyOnly || item.informCpsa || item.clashNotify) return;
    const key = item.email;
    if (!notifyByEmail[key]) notifyByEmail[key] = { name: item.name, email: item.email, newStatus: item.newStatus, entries: [] };
    item.drafts.forEach((d, di) => notifyByEmail[key].entries.push({ d, gi, di }));
  });

  function removeItem(gi) { setCart(prev => prev.filter((_,i)=>i!==gi)); }
  function toggleItemSkip(gi) { setCart(prev => prev.map((it,i)=>i===gi?{...it,skipEmail:!it.skipEmail}:it)); }

  function removeDraft(gi, di) {
    setCart(prev => prev.map((item,i) => {
      if(i!==gi) return item;
      const drafts = item.drafts.filter((_,j)=>j!==di);
      return drafts.length===0 ? null : {...item, drafts};
    }).filter(Boolean));
  }

  function updateDraft(gi, di, patch) {
    setCart(prev => prev.map((item,i) => {
      if(i!==gi) return item;
      const drafts = item.drafts.map((d,j)=>j===di?{...d,...patch}:d);
      return {...item, drafts};
    }));
    setEditingDraft(null);
  }

  // Detect recurring groups: consecutive weekly drafts with same purpose+facility
  function groupDrafts(drafts) {
    const groups = [];
    let i = 0;
    while(i < drafts.length) {
      const d = drafts[i];
      let j = i+1;
      while(j < drafts.length) {
        const next = drafts[j];
        const prevDate = drafts[j-1].date;
        const isWeekApart = (() => {
          const [py,pm,pd] = prevDate.split('-').map(Number);
          const [ny,nm,nd] = next.date.split('-').map(Number);
          const diff = Math.round((Date.UTC(ny,nm-1,nd)-Date.UTC(py,pm-1,pd))/86400000);
          return diff===7;
        })();
        if(isWeekApart && next.facility_id===d.facility_id && next.start_hour===d.start_hour && next.duration===d.duration) j++;
        else break;
      }
      if(j-i > 1) groups.push({type:'recur', drafts:drafts.slice(i,j), startIdx:i});
      else         groups.push({type:'single', draft:d, idx:i});
      i = j;
    }
    return groups;
  }

  return (
    <div style={{display:'flex',flexDirection:'column',gap:0,height:'100%'}}>
      {cart.length===0
        ? <div style={{textAlign:'center',padding:'40px 0',color:'#94a3b8',fontSize:14}}>Your cart is empty.</div>
        : (
          <>
            <div style={{fontSize:13,color:'#64748b',marginBottom:12}}>
              {[totalNew>0&&`${totalNew} new booking${totalNew>1?'s':''}`, totalEdits>0&&`${totalEdits} edit${totalEdits>1?'s':''}`, totalStatus>0&&`${totalStatus} status change${totalStatus>1?'s':''}`, totalClash>0&&`${totalClash} clash alert${totalClash>1?'s':''}`, totalNotify>0&&`${totalNotify} GTEC notification${totalNotify>1?'s':''}`, totalInform>0&&`${totalInform} Inform-GTEC email${totalInform>1?'s':''}`].filter(Boolean).join(' · ')} ready to submit.
            </div>
            <div style={{flex:1,minHeight:0,overflowY:'auto',display:'flex',flexDirection:'column',gap:10,paddingRight:2}}>
              {/* Regular (non-notify) cart items */}
              {cart.map((item,gi)=>{
                if(item.notifyOnly||item.statusChange) return null;
                const groups = groupDrafts(item.drafts);
                return (
                  <div key={gi} style={{border:'1.5px solid #e2e8f0',borderRadius:12,overflow:'hidden'}}>
                    <div style={{background:item.isEdit||item.isMultiEdit?'#eff6ff':'#f8fafc',padding:'10px 14px',display:'flex',alignItems:'center',borderBottom:'1px solid #e2e8f0'}}>
                      <div style={{display:'flex',alignItems:'center',gap:8,flex:1,flexWrap:'wrap'}}>
                        <EmailChip email={item.email}/>
                        <span style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{item.name}</span>
                        {(item.isEdit||item.isMultiEdit)
                          ? <span style={{fontSize:11,fontWeight:700,color:'#1d4ed8',background:'#dbeafe',border:'1px solid #93c5fd',borderRadius:4,padding:'1px 7px'}}>✏ edit</span>
                          : <span style={{fontSize:12,color:'#94a3b8'}}>· {item.drafts.length} booking{item.drafts.length>1?'s':''}</span>
                        }
                      </div>
                    </div>
                    {groups.map((g,gi2)=>{
                      if(g.type==='recur') {
                        const f=FACILITIES.find(x=>x.id===g.drafts[0].facility_id);
                        const first=g.drafts[0], last=g.drafts[g.drafts.length-1];
                        return (
                          <div key={gi2} style={{background:'#f0fdf4',borderBottom:'1px solid #e2e8f0',padding:'10px 14px'}}>
                            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                              <span style={{width:8,height:8,borderRadius:'50%',background:f?.color,flexShrink:0,display:'inline-block'}}/>
                              <span style={{fontSize:11,fontWeight:700,color:'#16a34a',background:'#dcfce7',border:'1px solid #bbf7d0',borderRadius:4,padding:'1px 7px'}}>🔁 {g.drafts.length}× weekly</span>
                              <span style={{fontSize:12,fontWeight:600,color:'#0f172a',flex:1}}>{f?.name}</span>
                            </div>
                            <div style={{fontSize:12,color:'#64748b',paddingLeft:16}}>
                              {fmtDate(first.date)} → {fmtDate(last.date)} · {fmtTime(first.start_hour)}–{fmtTime(first.start_hour+first.duration)} · {first.purpose}
                            </div>
                            <div style={{paddingLeft:16,marginTop:6,display:'flex',flexDirection:'column',gap:3}}>
                              {g.drafts.map((d,k)=>{
                                const di = g.startIdx+k;
                                const isEditing2 = editingDraft?.gi===gi && editingDraft?.di===di;
                                return (
                                  <div key={k} style={{display:'flex',alignItems:'center',gap:6}}>
                                    {isEditing2 ? (
                                      <InlineDraftEditor draft={d} onSave={p=>updateDraft(gi,di,p)} onCancel={()=>setEditingDraft(null)}/>
                                    ) : (
                                      <>
                                        <span style={{fontSize:11,color:'#64748b',flex:1}}>{fmtDate(d.date)}</span>
                                        <button onClick={()=>setEditingDraft({gi,di,draft:d})} style={{background:'none',border:'none',cursor:'pointer',color:'#6366f1',fontSize:12,padding:'1px 5px'}}>✏</button>
                                        <button onClick={()=>removeDraft(gi,di)} style={{background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:13,padding:'1px 5px'}}>✕</button>
                                      </>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      }
                      const {draft:d, idx:di} = g;
                      const f=FACILITIES.find(x=>x.id===d.facility_id);
                      const isEditing2 = editingDraft?.gi===gi && editingDraft?.di===di;
                      return (
                        <div key={gi2} style={{borderBottom:gi2<groups.length-1?'1px solid #f1f5f9':'none'}}>
                          {isEditing2 ? (
                            <div style={{padding:'10px 14px'}}>
                              <InlineDraftEditor draft={d} onSave={p=>updateDraft(gi,di,p)} onCancel={()=>setEditingDraft(null)}/>
                            </div>
                          ) : (
                            <div style={{display:'flex',gap:10,alignItems:'center',padding:'10px 14px'}}>
                              <span style={{width:8,height:8,borderRadius:'50%',background:f?.color,flexShrink:0,display:'inline-block'}}/>
                              <div style={{flex:1}}>
                                <div style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{f?.name}</div>
                                <div style={{fontSize:12,color:'#64748b'}}>{fmtDate(d.date)} · {fmtTime(d.start_hour)}–{fmtTime(d.start_hour+d.duration)} · {d.purpose}</div>
                              </div>
                              <button onClick={()=>setEditingDraft({gi,di,draft:d})} title="Edit" style={{background:'none',border:'none',cursor:'pointer',color:'#6366f1',fontSize:15,padding:'2px 5px',lineHeight:1}}>✏</button>
                              <button onClick={()=>removeDraft(gi,di)} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:16,padding:'2px 5px',lineHeight:1}}>✕</button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* CPSA notification groups — one collapsible card per booker */}
              {Object.entries(notifyByEmail).map(([email, group])=>{
                const isExpanded = expandedNotify.has(email);
                const isMismatch = group.newStatus === 'cpsa_review_needed';
                const toggleExpand = ()=>setExpandedNotify(prev=>{const s=new Set(prev);s.has(email)?s.delete(email):s.add(email);return s;});
                return (
                  <div key={email} style={{border:'1.5px solid #fde047',borderRadius:12,overflow:'hidden'}}>
                    <div onClick={toggleExpand} style={{background:'#fef9c3',padding:'10px 14px',display:'flex',alignItems:'center',gap:8,cursor:'pointer',userSelect:'none'}}>
                      <EmailChip email={email}/>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a',flex:1}}>{group.name}</span>
                      <span style={{fontSize:11,fontWeight:700,color:'#854d0e',background:'#fef08a',border:'1px solid #fde047',borderRadius:4,padding:'1px 7px'}}>
                        🔔 {group.entries.length} {isMismatch?'mismatch':'confirmed'} notification{group.entries.length!==1?'s':''}
                      </span>
                      <span style={{fontSize:12,color:'#a16207',marginLeft:4}}>{isExpanded?'▲':'▼'}</span>
                    </div>
                    {isExpanded && group.entries.map(({d, gi, di}, ei)=>{
                      const f=FACILITIES.find(x=>x.id===d.facility_id);
                      const reasons=parseMismatchNote(d.system_notes,d.notes);
                      return (
                        <div key={ei} style={{padding:'8px 14px',borderTop:'1px solid #fde047',background:'#fffbeb'}}>
                          <div style={{display:'flex',gap:10,alignItems:'center'}}>
                            <span style={{width:7,height:7,borderRadius:'50%',background:f?.color,flexShrink:0,display:'inline-block'}}/>
                            <div style={{flex:1,fontSize:12,color:'#64748b'}}>
                              <span style={{fontWeight:600,color:'#0f172a',marginRight:6}}>{f?.name||d.facility_id}</span>
                              {fmtDate(d.date)} · {fmtTime(d.start_hour)}–{fmtTime(d.start_hour+d.duration)}
                            </div>
                            <button onClick={()=>removeDraft(gi,di)} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:15,padding:'2px 4px',lineHeight:1}}>✕</button>
                          </div>
                          {reasons.length>0&&<div style={{marginTop:4,marginLeft:13,fontSize:11,color:'#a16207'}}>{reasons.join(' · ')}</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {/* Inform-CPSA vendor alerts — one card per selected vendor */}
              {cart.map((item,gi)=>{
                if(!item.informCpsa) return null;
                const b=item.drafts[0]; if(!b) return null;
                const f=FACILITIES.find(x=>x.id===b.facility_id);
                const reasons=parseMismatchNote(b.system_notes,b.notes);
                const refs=item.cpsaRefs||[];
                return (
                  <div key={'inform-'+gi} style={{border:'1.5px solid #7dd3fc',borderRadius:12,overflow:'hidden'}}>
                    <div style={{background:'#f0f9ff',padding:'10px 14px',display:'flex',alignItems:'center',gap:8}}>
                      <EmailChip email={item.email}/>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a',flex:1}}>{item.name}</span>
                      <span style={{fontSize:11,fontWeight:700,color:'#0369a1',background:'#e0f2fe',border:'1px solid #7dd3fc',borderRadius:4,padding:'1px 7px'}}>📨 Inform GTEC</span>
                      <button onClick={()=>removeDraft(gi,0)} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:15,padding:'2px 4px',lineHeight:1}}>✕</button>
                    </div>
                    <div style={{padding:'8px 14px',fontSize:12,color:'#64748b',background:'#fff'}}>
                      <div><span style={{fontWeight:600,color:'#0f172a',marginRight:6}}>{f?.name||b.facility_id}</span>{fmtDate(b.date)} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)}</div>
                      {reasons.length>0&&<div style={{marginTop:4,color:'#0369a1'}}>{reasons.join(' · ')}</div>}
                      {refs.length>0
                        ? <div style={{marginTop:4,fontSize:11,color:'#0891b2'}}>🔗 {refs.map(r=>r.ref).join(', ')}</div>
                        : <div style={{marginTop:4,fontSize:11,color:'#94a3b8'}}>No GTEC link on file</div>}
                    </div>
                  </div>
                );
              })}

              {/* Queued status-change actions — applied on submit */}
              {cart.map((item,gi)=>{
                if(!item.statusChange) return null;
                const meta=STATUS_META[item.newStatus]||{};
                const willEmail=!item.skipEmail;
                return (
                  <div key={'status-'+gi} style={{border:`1.5px solid ${meta.border||'#e2e8f0'}`,borderRadius:12,overflow:'hidden'}}>
                    <div style={{background:meta.bg||'#f8fafc',padding:'10px 14px',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <EmailChip email={item.email}/>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{item.name}</span>
                      <Badge status={item.newStatus}/>
                      <span style={{fontSize:12,color:'#94a3b8'}}>· {item.drafts.length} booking{item.drafts.length>1?'s':''}</span>
                      <button onClick={()=>removeItem(gi)} title="Remove" style={{marginLeft:'auto',background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:15,padding:'2px 4px',lineHeight:1}}>✕</button>
                    </div>
                    <div style={{padding:'8px 14px',background:'#fff',display:'flex',flexDirection:'column',gap:4}}>
                      {item.drafts.map((d,k)=>{ const f=FACILITIES.find(x=>x.id===d.facility_id); return (
                        <div key={k} style={{display:'flex',gap:8,alignItems:'center',fontSize:12,color:'#64748b'}}>
                          <span style={{width:7,height:7,borderRadius:'50%',background:f?.color||'#94a3b8',flexShrink:0,display:'inline-block'}}/>
                          <span style={{fontWeight:600,color:'#0f172a'}}>{f?.name||d.facility_id}</span>
                          {fmtDate(d.date)} · {fmtTime(d.start_hour)}–{fmtTime(d.start_hour+d.duration)}
                        </div>
                      );})}
                      {item.adminNote&&<div style={{fontSize:11,color:'#94a3b8',marginTop:2}}>Note: {item.adminNote}</div>}
                      <label style={{display:'flex',alignItems:'center',gap:6,fontSize:11,color:willEmail?'#475569':'#94a3b8',marginTop:4,cursor:'pointer'}}>
                        <input type="checkbox" checked={!willEmail} onChange={()=>toggleItemSkip(gi)} style={{width:13,height:13,accentColor:'#0f172a'}}/>
                        Don&apos;t email this booker
                      </label>
                    </div>
                  </div>
                );
              })}

              {/* Clash alerts — one per affected booker */}
              {cart.map((item,gi)=>{
                if(!item.clashNotify) return null;
                const n=(item.clashes||[]).length;
                return (
                  <div key={'clash-'+gi} style={{border:'1.5px solid #fda4af',borderRadius:12,overflow:'hidden'}}>
                    <div style={{background:'#fff1f2',padding:'10px 14px',display:'flex',alignItems:'center',gap:8}}>
                      <EmailChip email={item.email}/>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a',flex:1}}>{item.name}</span>
                      <span style={{fontSize:11,fontWeight:700,color:'#9f1239',background:'#fecdd3',border:'1px solid #fda4af',borderRadius:4,padding:'1px 7px'}}>⚠️ {n} clash{n!==1?'es':''}</span>
                      <button onClick={()=>removeItem(gi)} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:15,padding:'2px 4px',lineHeight:1}}>✕</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {onToggleSilent&&(
              <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',borderRadius:10,marginTop:8,flexShrink:0,background:silentMode?'#fffbeb':'#ecfdf5',border:`1.5px solid ${silentMode?'#fde68a':'#6ee7b7'}`}}>
                <span style={{fontSize:18}}>{silentMode?'🔇':'🔔'}</span>
                <div style={{flex:1,fontSize:12,color:silentMode?'#92400e':'#047857'}}>
                  <div style={{fontWeight:700}}>{silentMode?'Silent mode ON':'Emails will be sent on submit'}</div>
                  <div>{silentMode?'Submitting applies changes/removals but sends no emails.':'Bookers and vendors are emailed when you submit.'}</div>
                </div>
                <button onClick={()=>onToggleSilent(!silentMode)} style={S.btn({background:silentMode?'#f59e0b':'#10b981',color:'#fff',fontSize:12,fontWeight:700})}>
                  {silentMode?'Enable emails':'Mute emails'}
                </button>
              </div>
            )}
            <div style={{display:'flex',gap:10,justifyContent:'space-between',paddingTop:12,marginTop:4,borderTop:'1px solid #f1f5f9',flexShrink:0}}>
              <button onClick={()=>setCart([])} style={S.btn({border:'1.5px solid #f43f5e',background:'#fff',color:'#f43f5e'})}>Clear All</button>
              <div style={{display:'flex',gap:10}}>
                <button onClick={()=>{onClose();openNew(todayKey(),9,1);}} style={S.btn({border:'1.5px solid #e2e8f0',background:'#fff',color:'#475569'})}>+ Add More</button>
                <button onClick={onSubmit} style={S.btn({background:'#2d4a1e',color:'#fff'})}>
                  ✓ {totalEdits>0&&totalNew===0 ? "Save All Edits" : totalEdits>0 ? "Submit All" : "Submit All Bookings"}
                </button>
              </div>
            </div>
          </>
        )}
    </div>
  );
}

function InlineDraftEditor({ draft, onSave, onCancel }) {
  const [facility, setFacility] = useState(draft.facility_id);
  const [date,     setDate]     = useState(draft.date);
  const [hour,     setHour]     = useState(draft.start_hour);
  const [dur,      setDur]      = useState(draft.duration);
  const [purpose,  setPurpose]  = useState(draft.purpose);
  return (
    <div style={{background:'#f0f4ff',border:'1.5px solid #c7d2fe',borderRadius:8,padding:'10px 12px',display:'flex',flexDirection:'column',gap:8}}>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        <div>
          <label style={S.lbl}>Facility</label>
          <select style={{...S.inp,fontSize:12}} value={facility} onChange={e=>setFacility(e.target.value)}>
            {FACILITIES.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Date</label>
          <input style={{...S.inp,fontSize:12}} type="date" value={date} onChange={e=>setDate(e.target.value)}/>
        </div>
        <div>
          <label style={S.lbl}>Start Time</label>
          <select style={{...S.inp,fontSize:12}} value={hour} onChange={e=>setHour(parseFloat(e.target.value))}>
            {Array.from({length:CAL_TOTAL*2+1},(_,i)=>CAL_START+i*0.5).filter(h=>h<=CAL_END).map(h=><option key={h} value={h}>{fmtTime(h)}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Duration</label>
          <select style={{...S.inp,fontSize:12}} value={dur} onChange={e=>setDur(parseFloat(e.target.value))}>
            {DURATIONS.map(d=><option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label style={S.lbl}>Purpose</label>
        <input style={{...S.inp,fontSize:12}} value={purpose} onChange={e=>setPurpose(e.target.value)}/>
      </div>
      <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
        <button onClick={onCancel} style={S.btn({border:'1.5px solid #e2e8f0',background:'#fff',color:'#64748b',fontSize:12,padding:'5px 12px'})}>Cancel</button>
        <button onClick={()=>onSave({facility_id:facility,date,start_hour:hour,duration:dur,purpose})} style={S.btn({background:'#6366f1',color:'#fff',fontSize:12,padding:'5px 12px'})}>Save</button>
      </div>
    </div>
  );
}

function DeleteCartModal({ deleteQueue, setDeleteQueue, onClose, onSubmit, isAdmin, silentMode=false, onToggleSilent }) {
  const [adminNote, setAdminNote] = useState('');
  const [skipEmail, setSkipEmail] = useState(false);
  return (
    <div style={{display:'flex',flexDirection:'column',gap:0,height:'100%'}}>
      <div style={{background:'#fef2f2',border:'1px solid #fecaca',borderRadius:10,padding:'12px 16px',marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:14,color:'#7f1d1d',marginBottom:4}}>🗑 Removal Queue</div>
        <div style={{fontSize:13,color:'#991b1b'}}>Review the bookings below before permanently removing them.</div>
      </div>
      <div style={{flex:1,overflowY:'auto',maxHeight:'45vh',display:'flex',flexDirection:'column',gap:6,paddingRight:2,marginBottom:12}}>
        {deleteQueue.map((b)=>{
          const f=FACILITIES.find(x=>x.id===b.facility_id);
          return (
            <div key={b.id} style={{display:'flex',gap:10,alignItems:'center',padding:'10px 14px',background:'#fff',border:'1px solid #fee2e2',borderRadius:8}}>
              <span style={{width:8,height:8,borderRadius:'50%',background:f?.color,flexShrink:0,display:'inline-block'}}/>
              <div style={{flex:1}}>
                <div style={{fontSize:13,fontWeight:600,color:'#0f172a'}}>{f?.name} · {b.name}</div>
                <div style={{fontSize:12,color:'#64748b'}}>{fmtDate(b.date)} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.purpose}</div>
                <div style={{fontSize:11,color:'#94a3b8'}}>{b.email}</div>
              </div>
              <button onClick={()=>setDeleteQueue(prev=>prev.filter(x=>x.id!==b.id))} title="Remove from queue" style={{background:'none',border:'none',cursor:'pointer',color:'#94a3b8',fontSize:16,padding:'2px 5px',lineHeight:1}}>✕</button>
            </div>
          );
        })}
      </div>
      {isAdmin && (
        <div style={{marginBottom:12,display:'flex',flexDirection:'column',gap:8}}>
          <label style={S.lbl}>Admin Note (optional — included in email)</label>
          <textarea style={{...S.inp,resize:'vertical',minHeight:52,fontSize:13}} value={adminNote} onChange={e=>setAdminNote(e.target.value)} placeholder="Reason for removal..."/>
          <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',fontSize:13,color:'#475569'}}>
            <input type="checkbox" checked={skipEmail} onChange={e=>setSkipEmail(e.target.checked)} style={{width:15,height:15,accentColor:'#0f172a'}}/>
            Remove without notifying bookers by email
          </label>
        </div>
      )}
      {isAdmin&&onToggleSilent&&(
        <div style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',borderRadius:10,marginBottom:12,background:silentMode?'#fffbeb':'#ecfdf5',border:`1.5px solid ${silentMode?'#fde68a':'#6ee7b7'}`}}>
          <span style={{fontSize:18}}>{silentMode?'🔇':'🔔'}</span>
          <div style={{flex:1,fontSize:12,color:silentMode?'#92400e':'#047857'}}>
            <div style={{fontWeight:700}}>{silentMode?'Silent mode ON':'Emails will be sent on submit'}</div>
            <div>{silentMode?'Removal happens but no booker email is sent.':'Bookers are emailed their removal when you confirm.'}</div>
          </div>
          <button onClick={()=>onToggleSilent(!silentMode)} style={S.btn({background:silentMode?'#f59e0b':'#10b981',color:'#fff',fontSize:12,fontWeight:700})}>
            {silentMode?'Enable emails':'Mute emails'}
          </button>
        </div>
      )}
      <div style={{display:'flex',gap:10,justifyContent:'space-between',paddingTop:10,borderTop:'1px solid #f1f5f9',flexShrink:0}}>
        <button onClick={()=>setDeleteQueue([])} style={S.btn({border:'1.5px solid #e2e8f0',background:'#fff',color:'#94a3b8'})}>Clear Queue</button>
        <div style={{display:'flex',gap:10}}>
          <button onClick={onClose} style={S.btn({border:'1.5px solid #e2e8f0',background:'#fff',color:'#475569'})}>Cancel</button>
          <button onClick={()=>onSubmit(adminNote,silentMode||skipEmail)} style={S.btn({background:'#7f1d1d',color:'#fff'})}>
            🗑 Confirm Removal ({deleteQueue.length})
          </button>
        </div>
      </div>
    </div>
  );
}

function MultiEditForm({ bookings: srcBookings, onAddToCart, onClose, allBookings }) {
  const ref = srcBookings[0];
  const [newHour,     setNewHour]     = useState(ref.start_hour);
  const [newDuration, setNewDuration] = useState(ref.duration);
  const [newDow,      setNewDow]      = useState(new Date(ref.date+"T00:00:00").getDay()); // 0=Sun
  const [error,       setError]       = useState("");

  // Day-of-week options
  const DAYS = [{label:"Sunday",v:0},{label:"Monday",v:1},{label:"Tuesday",v:2},{label:"Wednesday",v:3},{label:"Thursday",v:4},{label:"Friday",v:5},{label:"Saturday",v:6}];

  function shiftToNewDow(dateStr, targetDow) {
    const d = new Date(dateStr+"T00:00:00");
    const curDow = d.getDay();
    const diff = targetDow - curDow;
    return addDays(dateStr, diff);
  }

  function handleAddToCart() {
    const drafts = srcBookings.map(b => ({
      ...b,
      start_hour:  newHour,
      duration:    newDuration,
      date:        shiftToNewDow(b.date, newDow),
      status:      "pending_amua", // re-submit for approval
      updated_at:  new Date().toISOString(),
    }));
    // Basic overlap check
    const others = allBookings.filter(b => !drafts.find(d=>d.id===b.id));
    const issues = drafts.filter(d => getSameFacilityOverlaps(d, others).length > 0);
    if (issues.length > 0) {
      setError(`Warning: ${issues.length} booking(s) may overlap with existing bookings. Proceeding adds them to cart for review.`);
    }
    onAddToCart(drafts, ref.name, ref.email);
  }

  const previewDrafts = srcBookings.map(b => ({
    ...b, start_hour:newHour, duration:newDuration, date:shiftToNewDow(b.date, newDow)
  }));

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#ede9fe",border:"1px solid #c4b5fd",borderRadius:10,padding:"12px 16px"}}>
        <div style={{fontWeight:700,fontSize:14,color:"#5b21b6",marginBottom:4}}>✏️ Multi-Edit — {srcBookings.length} Bookings</div>
        <div style={{fontSize:13,color:"#6d28d9"}}>Change the weekday and/or start time for all selected bookings. Other details are preserved. Edits are added to cart and require re-approval.</div>
      </div>
      {error&&<div style={{background:"#fff8e1",border:"1px solid #fcd34d",borderRadius:8,padding:"10px 14px",color:"#92400e",fontSize:13}}>{error}</div>}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
        <div>
          <label style={S.lbl}>Day of Week</label>
          <select style={S.inp} value={newDow} onChange={e=>setNewDow(parseInt(e.target.value))}>
            {DAYS.map(d=><option key={d.v} value={d.v}>{d.label}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Start Time</label>
          <select style={S.inp} value={newHour} onChange={e=>setNewHour(parseFloat(e.target.value))}>
            {Array.from({length:CAL_TOTAL*2+1},(_,i)=>CAL_START+i*0.5).filter(h=>h<=CAL_END).map(h=><option key={h} value={h}>{fmtTime(h)}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Duration</label>
          <select style={S.inp} value={newDuration} onChange={e=>setNewDuration(parseFloat(e.target.value))}>
            {DURATIONS.map(d=><option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
      </div>
      <div>
        <div style={{fontSize:11,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:8}}>Preview ({previewDrafts.length} bookings)</div>
        <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:240,overflowY:"auto"}}>
          {previewDrafts.map((d,i)=>{
            const f=FACILITIES.find(x=>x.id===d.facility_id);
            return (
              <div key={i} style={{display:"flex",gap:8,alignItems:"center",padding:"8px 12px",background:"#f8fafc",borderRadius:8,border:"1px solid #e2e8f0"}}>
                <span style={{width:8,height:8,borderRadius:"50%",background:f?.color,display:"inline-block",flexShrink:0}}/>
                <span style={{fontSize:13,color:"#0f172a",flex:1}}>{f?.name} · {fmtDate(d.date)} · {fmtTime(d.start_hour)}–{fmtTime(d.start_hour+d.duration)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:4}}>
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
        <button onClick={handleAddToCart} style={S.btn({background:"#6366f1",color:"#fff"})}>➕ Add Changes to Cart</button>
      </div>
    </div>
  );
}


function BookingForm({ booking, allBookings, onAddToCart, onClose, isAdmin, loggedInEmail }) {
  const isMobile = useMobile();
  const isEditing  = !!booking?.id && !booking?._multiEdit;
  const isMultiEdit = !!booking?._multiEdit;

  // All hooks must be declared before any conditional return
  function makeBlankRow(overrides={}) {
    return {
      facility_id: FACILITIES[0].id,
      date:        todayKey(),
      start_hour:  9,
      duration:    1,
      purpose:     "",
      notes:       "",
      status:      "pending_amua",
      recur:       { mode:"none", weeks:4, until:"" },
      ...overrides,
    };
  }

  const initRows = isEditing
    ? [{ id:booking.id, facility_id:booking.facility_id, date:booking.date, start_hour:booking.start_hour,
         duration:booking.duration, purpose:booking.purpose, notes:booking.notes||"",
         status:booking.status, recur:booking.recur||{mode:"none",weeks:4,until:""} }]
    : [makeBlankRow(booking && !isMultiEdit ? { facility_id:booking.facility_id||FACILITIES[0].id,
        date:booking.date||todayKey(), start_hour:booking.start_hour||9, duration:booking.duration||1 } : {})];

  const [name,  setName]  = useState(booking?.name  || "");
  const [email, setEmail] = useState(booking?.email || loggedInEmail || "");
  const [rows,  setRows]  = useState(initRows);
  const [error, setError] = useState("");
  const [warn,  setWarn]  = useState(null);

  // ── Multi-edit mode: simple time/weekday change across multiple bookings ──
  if (isMultiEdit) {
    return <MultiEditForm bookings={booking._bookings} onAddToCart={onAddToCart} onClose={onClose} allBookings={allBookings}/>;
  }

  function updateRow(idx, upd) { setRows(rs=>rs.map((r,i)=>i===idx?upd:r)); }
  function addRow()   { setRows(rs=>[...rs, makeBlankRow()]); }
  function removeRow(idx) { setRows(rs=>rs.filter((_,i)=>i!==idx)); }

  // Expand recurrence rules into individual booking drafts
  function expandRows() {
    const drafts = [];
    rows.forEach(row => {
      const base = { ...row, name, email, id:newId(), created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
      drafts.push(base);
      if (row.recur?.mode !== "none") {
        // base booking counts as week 1, so generate (total - 1) more
        const maxAdditional = row.recur.mode === "weeks"
          ? row.recur.weeks - 1
          : 103; // safety cap for "until" mode
        let currentDate = row.date;
        for (let w = 0; w < maxAdditional; w++) {
          currentDate = addDays(currentDate, 7);
          if (row.recur.mode === "until" && currentDate > row.recur.until) break;
          drafts.push({ ...base, id:newId(), date:currentDate });
        }
      }
    });
    // For edit: preserve original id
    if (isEditing && drafts.length === 1) drafts[0].id = booking.id;
    return drafts;
  }

  function validate() {
    if (!name.trim()) { setError("Please enter your name."); return false; }
    if (!/\S+@\S+\.\S+/.test(email)) { setError("Please enter a valid email."); return false; }
    for (let i=0; i<rows.length; i++) {
      const r = rows[i];
      if (!r.facility_id || !r.date || !r.purpose.trim()) {
        setError(`Booking #${i+1}: please fill in facility, date and purpose.`); return false;
      }
    }
    return true;
  }

  function handleAddToCart() {
    if (!validate()) return;
    setError("");
    const drafts = expandRows();
    const others  = allBookings.filter(b => !drafts.find(d=>d.id===b.id));
    const same    = drafts.flatMap(d=>getSameFacilityOverlaps(d,others));
    if (same.length > 0 && !warn?.sameDismissed) { setWarn({type:"same",list:[...new Map(same.map(x=>[x.id,x])).values()],drafts}); return; }
    const cross   = drafts.flatMap(d=>getCrossFacilityOverlaps(d,others));
    if (cross.length > 0 && !warn?.crossDismissed) { setWarn({type:"cross",list:[...new Map(cross.map(x=>[x.id,x])).values()],drafts}); return; }
    setWarn(null);
    onAddToCart(drafts, name, email);
  }

  function proceedSame() {
    const drafts = warn?.drafts; if(!drafts) return;
    const others = allBookings.filter(b=>!drafts.find(d=>d.id===b.id));
    const cross  = drafts.flatMap(d=>getCrossFacilityOverlaps(d,others));
    if (cross.length>0) { setWarn({type:"cross",list:[...new Map(cross.map(x=>[x.id,x])).values()],drafts,sameDismissed:true}); return; }
    setWarn(null);
    onAddToCart(drafts, name, email);
  }
  function proceedCross() {
    const drafts = warn?.drafts; if(!drafts) return;
    setWarn(null);
    onAddToCart(drafts, name, email);
  }

  // Overlap warnings
  if (warn?.type==="same" && warn.list) return <OverlapWarning title="Same Facility Already Booked" description="This facility already has bookings at this time. Shared use is allowed — confirm you are aware." bookings={warn.list} onProceed={proceedSame} onCancel={()=>setWarn(null)}/>;
  if (warn?.type==="cross" && warn.list) return <OverlapWarning title="Other Facilities Also Booked" description="Other facilities are booked at the same time. Simultaneous use is allowed — heads-up only." bookings={warn.list} onProceed={proceedCross} onCancel={()=>setWarn(null)}/>;

  // Main form
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {error&&<div style={{background:"#fff1f2",border:"1px solid #f43f5e",borderRadius:8,padding:"10px 14px",color:"#881337",fontSize:13}}>{error}</div>}

      {/* Name + Email */}
      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr":"1fr 1fr",gap:14}}>
        <div>
          <label style={S.lbl}>Your Name *</label>
          <input style={S.inp} value={name} onChange={e=>setName(e.target.value)} placeholder="Full name"/>
        </div>
        <div>
          <label style={S.lbl}>Email *</label>
          <input style={{...S.inp,background:loggedInEmail?"#f0fdf4":S.inp.background}} type="email" value={email} readOnly={!!loggedInEmail} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/>
          {loggedInEmail&&<div style={{fontSize:11,color:"#16a34a",marginTop:3}}>✓ Pre-filled from your login</div>}
        </div>
      </div>

      {/* Booking rows */}
      {rows.map((row,i)=>(
        <BookingRow key={i} row={row} idx={i} onChange={updateRow} onRemove={removeRow}
          isOnly={rows.length===1} isAdmin={isAdmin} isEditing={isEditing}
          allBookings={allBookings} loggedInEmail={loggedInEmail}/>
      ))}

      {/* Add another slot (only when not editing) */}
      {!isEditing && (
        <button onClick={addRow} style={S.btn({border:"1.5px dashed #cbd5e1",background:"#f8fafc",color:"#475569",width:"100%",padding:"10px"})}>
          + Add Another Booking
        </button>
      )}

      <div style={{display:"flex",gap:10,justifyContent:"flex-end",paddingTop:4}}>
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
        <button onClick={handleAddToCart} style={S.btn({background:"#2d4a1e",color:"#fff"})}>
          {isEditing ? "✏ Add Edit to Cart" : "➕ Add to Cart"}
        </button>
      </div>
    </div>
  );
}

// ─── Booking Detail ───────────────────────────────────────────────────────────
function BookingDetail({booking,onEdit,onClose,onCancel,isAdmin,onStatusChange,loggedInEmail,allClashes=[]}) {
  const f=FACILITIES.find(x=>x.id===booking.facility_id);
  const m=STATUS_META[booking.status]||STATUS_META.pending;
  const isPast = booking.date < todayKey();
  const isOwn  = booking.email?.toLowerCase() === loggedInEmail?.toLowerCase();
  const clashingAdminBks = booking.status==="clash"
    ? allClashes.filter(c=>c.user.id===booking.id).map(c=>c.admin)
    : [];
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:m.bg,border:`1px solid ${m.border}`,borderRadius:10,padding:"12px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          {isAdmin ? (
            <label style={{display:"inline-flex",alignItems:"center",gap:8,margin:0}}>
              <span style={{fontSize:12,fontWeight:600,color:m.text,textTransform:"uppercase",letterSpacing:"0.05em"}}>Status</span>
              <select
                value={booking.status}
                onChange={e=>onStatusChange(e.target.value)}
                style={{padding:"4px 10px",borderRadius:8,border:`1.5px solid ${m.border}`,background:m.bg,color:m.text,fontSize:13,fontWeight:600,cursor:"pointer",outline:"none"}}
              >
                {Object.entries(STATUS_META).map(([key,meta])=>(
                  <option key={key} value={key}>{meta.label}</option>
                ))}
              </select>
            </label>
          ) : (
            <Badge status={booking.status}/>
          )}
          {booking.invoiced&&<span style={{fontSize:12,fontWeight:700,background:INVOICED_META.bg,color:INVOICED_META.text,border:`1px solid ${INVOICED_META.border}`,borderRadius:8,padding:"3px 9px"}}>🧾 Invoiced</span>}
          {REVIEW_STATUSES.has(booking.status)&&<p style={{margin:0,fontSize:13,color:m.text}}>Awaiting admin review.</p>}
        </div>
        {booking.status==="clash"&&clashingAdminBks.length>0&&(
          <div style={{marginTop:10}}>
            <div style={{fontSize:12,fontWeight:700,color:"#92400e",marginBottom:6}}>Overlapping reservations:</div>
            {clashingAdminBks.map((ab,i)=>(
              <div key={i} style={{fontSize:12,color:"#0f172a",padding:"5px 8px",background:"#fff8e1",borderRadius:6,marginBottom:4,border:"1px solid #fcd34d"}}>
                <strong>{ab.purpose}</strong> — {fmtDate(ab.date)}, {fmtTime(ab.start_hour)}–{fmtTime(ab.start_hour+ab.duration)}
              </div>
            ))}
          </div>
        )}
      </div>
      {booking.status==="cpsa_review_needed"&&parseMismatchNote(booking.system_notes,booking.notes).length>0&&(
        <div style={{background:"#fef9c3",border:"1px solid #fde047",borderRadius:10,padding:"12px 16px"}}>
          <div style={{fontSize:12,fontWeight:700,color:"#713f12",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>⚠ Flagged inconsistencies vs GTEC</div>
          <div style={{display:"grid",gridTemplateColumns:"auto 1fr auto 1fr",gap:"4px 10px",alignItems:"center"}}>
            <div style={{fontSize:10,fontWeight:700,color:"#a16207",textTransform:"uppercase"}}></div>
            <div style={{fontSize:10,fontWeight:700,color:"#a16207",textTransform:"uppercase"}}>Booked</div>
            <div></div>
            <div style={{fontSize:10,fontWeight:700,color:"#a16207",textTransform:"uppercase"}}>GTEC</div>
            {parseMismatchNote(booking.system_notes,booking.notes).map((r,i)=>{const p=splitReason(r);return(<Fragment key={i}>
              <div style={{fontSize:13,fontWeight:600,color:"#713f12"}}>{p.label}</div>
              <div style={{fontSize:13,color:"#854d0e"}}>{p.old||"—"}</div>
              <div style={{fontSize:12,color:"#a16207"}}>→</div>
              <div style={{fontSize:13,color:"#854d0e",fontWeight:600}}>{p.next||"—"}</div>
            </Fragment>);})}
          </div>
          <div style={{fontSize:11,color:"#a16207",marginTop:8}}>Detected during GTEC sync — reconcile before confirming.</div>
        </div>
      )}
      {isPast&&<div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#64748b",display:"flex",alignItems:"center",gap:6}}>🔒 Past booking — {isAdmin?"admin can delete":"read-only"}</div>}
      <div><EmailChip email={booking.email}/></div>
      {[
        ["Facility",<span style={{display:"inline-flex",alignItems:"center",gap:6}}><span style={{width:10,height:10,borderRadius:"50%",background:f?.color,display:"inline-block"}}/>{f?.name}</span>],
        ["Date",fmtDate(booking.date)],
        ["Time",`${fmtTime(booking.start_hour)} – ${fmtTime(booking.start_hour+booking.duration)}`],
        ["Duration",DURATIONS.find(d=>d.value===booking.duration)?.label||`${booking.duration}h`],
        ["Purpose",booking.purpose],
        ["Booked by",booking.name],
        ["Email",booking.email],
        ].filter(Boolean).map(([label,value])=>(
        <div key={label} style={{display:"flex",gap:12}}>
          <span style={{minWidth:90,fontSize:12,fontWeight:600,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",paddingTop:1}}>{label}</span>
          <span style={{fontSize:14,color:"#0f172a"}}>{value}</span>
        </div>
      ))}
      {(()=>{
        // Parse system markers from system_notes; fall back to notes for pre-migration rows.
        const sysNotesSrc = booking.system_notes || booking.notes || "";
        const userNotesSrc = booking.notes || "";
        // Parse CPSA submission lines: [CPSA <date>] Ref <ref> · <url>
        const cpsaRe=/\[CPSA ([^\]]+)\]\s*Ref\s+(\S+)\s*·\s*(https?:\/\/\S+)/g;
        const cpsaLines=[];
        let m;
        while((m=cpsaRe.exec(sysNotesSrc))!==null) cpsaLines.push({date:m[1],ref:m[2],url:m[3]});
        // User-visible notes: strip any legacy system markers from the notes field for display.
        const remainingNotes=stripMismatchNote(userNotesSrc.replace(/\[CPSA [^\]]+\]\s*Ref\s+\S+\s*·\s*https?:\/\/\S+/g,"").replace(BILLED_RE,"")).trim();
        if(!cpsaLines.length&&!remainingNotes) return null;
        return <>
          {cpsaLines.map((c,i)=>(
            <div key={i} style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:8,padding:"10px 14px",display:"flex",flexDirection:"column",gap:6}}>
              <div style={{fontSize:11,fontWeight:700,color:"#0369a1",textTransform:"uppercase",letterSpacing:"0.05em"}}>GTEC Submission</div>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span style={{fontSize:12,background:"#0891b2",color:"#fff",borderRadius:6,padding:"2px 8px",fontWeight:700}}>{c.ref}</span>
                <span style={{fontSize:12,color:"#64748b"}}>{c.date}</span>
                <a href={c.url} target="_blank" rel="noopener noreferrer"
                  style={{fontSize:12,background:"#0ea5e9",color:"#fff",borderRadius:6,padding:"3px 10px",textDecoration:"none",fontWeight:600,marginLeft:"auto"}}>
                  View / Edit on Sporty ↗
                </a>
              </div>
            </div>
          ))}
          {remainingNotes&&(
            <div style={{display:"flex",gap:12}}>
              <span style={{minWidth:90,fontSize:12,fontWeight:600,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",paddingTop:1}}>Notes</span>
              <span style={{fontSize:14,color:"#0f172a",whiteSpace:"pre-wrap"}}>{remainingNotes}</span>
            </div>
          )}
        </>;
      })()}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",paddingTop:8,borderTop:"1px solid #f1f5f9"}}>
        {isAdmin&&<>
          {!isPast&&<button onClick={onEdit} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#0f172a"})}>Edit</button>}
          <button onClick={onCancel} style={S.btn({border:"1.5px solid #f43f5e",background:"#fff",color:"#f43f5e"})}>🗑 Queue Removal</button>
        </>}
        {!isAdmin&&isOwn&&!isPast&&booking.status!=="cancelled"&&<>
          <button onClick={onEdit}   style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#0f172a"})}>Edit Request</button>
          <button onClick={onCancel} style={S.btn({border:"1.5px solid #f43f5e",background:"#fff",color:"#f43f5e"})}>🗑 Queue Removal</button>
        </>}
        {!isAdmin&&(!isOwn||isPast)&&<div style={{fontSize:12,color:"#94a3b8",alignSelf:"center"}}>{!isOwn?"You can only edit your own bookings.":"Past bookings are read-only."}</div>}
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",marginLeft:"auto"})}>Close</button>
      </div>
    </div>
  );
}

function WeekCalendar({ bookings, onNewBooking, onBookingClick, selectedFacility, cartSourceIds=new Set(), deleteIds=new Set(), cartNewDrafts=[], focusedDate, setFocusedDate, onOpenDay, bookerFilter=new Set(), aliasNames={}, emailAliases={} }) {
  function calAlias(em) {
    if (!em) return "";
    const primary = (emailAliases[em.toLowerCase()] || em).toLowerCase();
    return aliasNames[primary] || primary.split("@")[0];
  }
  const [localBase, setLocalBase] = useState(new Date());
  const weekBase    = focusedDate || localBase;
  const setWeekBase = setFocusedDate || setLocalBase;
  // dragState tracks the active drag; dragMoved tracks whether mouse moved
  // enough to be considered a drag (vs a plain click)
  const [dragState, setDragState] = useState(null);
  const dragMoved = useRef(false);
  const gridRef   = useRef(null);

  const days    = getWeekDates(weekBase);
  const today   = todayKey();
  const visible = (selectedFacility === "all" ? bookings : bookings.filter(b => b.facility_id === selectedFacility))
    .filter(b => !["cancelled","rejected"].includes(b.status));

  function yToSlot(y)      { return Math.max(0, Math.min(Math.floor(y / SLOT_H), CAL_TOTAL * 2 - 1)); }
  function slotToHour(s)   { return CAL_START + s * 0.5; }
  function normDrag(ds) {
    if (!ds) return null;
    const lo = Math.min(ds.startSlot, ds.endSlot), hi = Math.max(ds.startSlot, ds.endSlot);
    return { ...ds, lo, hi };
  }

  function handleMouseDown(e, dk) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = yToSlot(e.clientY - rect.top);
    dragMoved.current = false;
    setDragState({ date:dk, startSlot:slot, endSlot:slot, active:true });
  }

  function handleMouseMove(e, dk) {
    if (!dragState?.active || dragState.date !== dk) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = yToSlot(e.clientY - rect.top);
    if (slot !== dragState.endSlot) {
      dragMoved.current = true;
      setDragState(ds => ({ ...ds, endSlot: slot }));
    }
  }

  function handleMouseUp(e, dk) {
    if (!dragState?.active || dragState.date !== dk) return;
    const nd     = normDrag(dragState);
    const moved  = dragMoved.current;
    dragMoved.current = false;
    setDragState(null);
    // Interacting with the week grid (click or drag) opens the day timeline popup
    // centered on the start time, rather than creating a booking directly — so the
    // user picks a facility column there. (booking chips stopPropagation, so they
    // never reach here.)
    if (onOpenDay) onOpenDay(nd.date, slotToHour(nd.lo));
    else onNewBooking(nd.date, slotToHour(nd.lo), moved ? (nd.hi - nd.lo + 1) * 0.5 : 1);
  }

  function getStackStyle(b, dayBkgs) {
    const ov = dayBkgs.filter(o => o.id !== b.id && o.start_hour < b.start_hour+b.duration && o.start_hour+o.duration > b.start_hour);
    if (ov.length === 0) return { left:2, right:2 };
    const all = [b,...ov].sort((a,x)=>a.start_hour-x.start_hour||a.id.localeCompare(x.id));
    const idx = all.findIndex(x=>x.id===b.id), cnt=all.length, w=96/cnt;
    return { left:`${2+idx*w}%`, width:`${w-1}%`, right:"auto" };
  }

  const nd = normDrag(dragState);

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
        {[["← Prev",-7],["Today",0],["Next →",7]].map(([lbl,delta])=>(
          <button key={lbl} onClick={()=>delta===0?setWeekBase(new Date()):setWeekBase(d=>{const nd=new Date(d);nd.setDate(nd.getDate()+delta);return nd;})}
            style={S.btn({ border:"1.5px solid #e2e8f0", background:"#fff", color:"#475569" })}>{lbl}</button>
        ))}
        <span style={{ fontSize:15, fontWeight:700, color:"#0f172a", marginLeft:4 }}>{days[0].toLocaleDateString("en-NZ",{month:"long",year:"numeric"})}</span>
        {window.innerWidth>=768&&<span style={{ fontSize:12, color:"#94a3b8", marginLeft:8 }}>Click or drag to create a booking</span>}
      </div>
      <div style={{ overflowX:"auto" }} ref={gridRef} onMouseLeave={()=>{ dragMoved.current=false; setDragState(null); }}>
        <div style={{ minWidth:680 }}>
          {/* Day headers */}
          <div style={{ display:"flex", marginLeft:52 }}>
            {days.map(d=>{
              const dk=dateKey(d), isToday=dk===today;
              return (
                <div key={dk} style={{ flex:1, textAlign:"center", padding:"6px 0 10px" }}>
                  <div style={{ fontSize:11, fontWeight:600, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.08em" }}>{d.toLocaleDateString("en-NZ",{weekday:"short"})}</div>
                  <div onClick={()=>onOpenDay&&onOpenDay(dk)} title="Open day view"
                    style={{ width:32, height:32, borderRadius:"50%", margin:"4px auto 0", background:isToday?"#0f172a":"transparent", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:isToday?700:500, color:isToday?"#fff":"#0f172a", cursor:onOpenDay?"pointer":"default" }}>{d.getDate()}</div>
                  {onOpenDay&&<button onClick={()=>onOpenDay(dk)} title="Open day view"
                    style={{ marginTop:3, fontSize:9, fontWeight:700, color:"#4f46e5", background:"#eef2ff", border:"1px solid #c7d2fe", borderRadius:6, padding:"1px 6px", cursor:"pointer", fontFamily:"inherit" }}>⤢ day</button>}
                </div>
              );
            })}
          </div>
          {/* Grid */}
          <div style={{ display:"flex" }}>
            {/* Hour labels */}
            <div style={{ width:52, flexShrink:0 }}>
              {Array.from({length:CAL_TOTAL+1},(_,i)=>CAL_START+i).map(h=>(
                <div key={h} style={{ height:HOUR_H, display:"flex", alignItems:"flex-start", justifyContent:"flex-end", paddingRight:8, paddingTop:3 }}>
                  <span style={{ fontSize:10, color:"#94a3b8", whiteSpace:"nowrap" }}>{fmtTime(h)}</span>
                </div>
              ))}
            </div>
            {/* Day columns */}
            <div style={{ flex:1, display:"flex" }}>
              {days.map(d=>{
                const dk=dateKey(d);
                const dayBkgs=visible.filter(b=>b.date===dk);
                const isDragging=dragState?.active&&dragState.date===dk;
                return (
                  <div key={dk}
                    style={{ flex:1, position:"relative", borderLeft:"1px solid #f1f5f9", cursor:isDragging?"ns-resize":"crosshair" }}
                    onMouseDown={e=>handleMouseDown(e,dk)}
                    onMouseMove={e=>handleMouseMove(e,dk)}
                    onMouseUp={e=>handleMouseUp(e,dk)}
                  >
                    {/* Hour cells */}
                    {Array.from({length:CAL_TOTAL},(_,i)=>i).map(i=>(
                      <div key={i} style={{ height:HOUR_H, boxSizing:"border-box", borderBottom:"1px solid #f1f5f9" }}>
                        <div style={{ height:"50%", borderBottom:"1px dashed #f5f5f5" }}/>
                      </div>
                    ))}
                    {/* Drag preview */}
                    {isDragging && nd && (
                      <div style={{ position:"absolute", left:2, right:2, top:nd.lo*SLOT_H, height:(nd.hi-nd.lo+1)*SLOT_H, background:"rgba(99,102,241,0.15)", border:"2px solid rgba(99,102,241,0.5)", borderRadius:6, pointerEvents:"none", zIndex:3 }}>
                        <div style={{ position:"absolute", top:4, left:6, fontSize:10, fontWeight:700, color:"#4f46e5" }}>{fmtTime(slotToHour(nd.lo))} – {fmtTime(slotToHour(nd.hi+1))}</div>
                      </div>
                    )}
                    {/* Booking blocks */}
                    {dayBkgs.map(b=>{
                      const fac=FACILITIES.find(x=>x.id===b.facility_id);
                      const stk=getStackStyle(b,dayBkgs);
                      const ec=emailColor(b.email);
                      const isAdmin_bk = isAdminBooking(b);
                      const bkBg = isAdmin_bk ? "#94a3b8" : (STATUS_CAL_COLOR[b.status] || "#64748b");
                      const bkTxt = isAdmin_bk ? "#fff" : (STATUS_CAL_TEXT[b.status] || "#fff");
                      const bkTxtMuted = bkTxt === "#fff" ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.55)";
                      const bkBorderLeft = (deleteIds.has(b.id)||cartSourceIds.has(b.id)||isAdmin_bk) ? undefined : `4px solid ${fac?.color||"#4a90d9"}`;
                      const filterActive = bookerFilter.size > 0;
                      const isDimmed = filterActive && !bookerFilter.has(b.email?.toLowerCase());
                      const dimOpacity = isAdmin_bk ? 0.25 : 0.12;
                      const facSocial = !isAdmin_bk && isSocialFac(b.facility_id);
                      return (
                        <div key={b.id}
                          onClick={e=>{ e.stopPropagation(); if(!isDimmed) onBookingClick(b); }}
                          onMouseDown={e=>e.stopPropagation()}
                          title={(()=>{const r=parseMismatchNote(b.system_notes,b.notes);return `${b.name} – ${fac?.name}`+(b.status==="cpsa_review_needed"&&r.length?`\n⚠ GTEC inconsistencies:\n${r.join("\n")}`:b.status==="cpsa_confirmed"?"\n🌐 GTEC confirmed":"");})()}
                          className={facSocial?(bkTxt==="#fff"?"fac-social-tex":"fac-social-tex-dark"):undefined}
                          style={{ position:"absolute", top:(b.start_hour-CAL_START)*HOUR_H, height:Math.max(b.duration*HOUR_H-2,20), background:bkBg, borderRadius:6, padding:"3px 6px", cursor:isDimmed?"default":"pointer", overflow:"hidden", opacity:isDimmed?dimOpacity:REVIEW_STATUSES.has(b.status)?0.75:1, pointerEvents:isDimmed?"none":"auto", border:deleteIds.has(b.id)?"2.5px solid #ef4444":cartSourceIds.has(b.id)?"2.5px solid #f59e0b":b.status==="clash"?"2px dashed #d97706":REVIEW_STATUSES.has(b.status)?`2px dashed ${bkTxt==="#fff"?"rgba(255,255,255,0.6)":"rgba(113,63,18,0.5)"}`:b.status==="rejected"?"2px solid rgba(244,63,94,0.8)":"none", boxShadow:deleteIds.has(b.id)?"0 0 0 3px rgba(239,68,68,0.25)":cartSourceIds.has(b.id)?"0 0 0 3px rgba(245,158,11,0.25)":"0 1px 4px rgba(0,0,0,0.15)", zIndex:2, borderLeft:bkBorderLeft, ...stk }}>
                          {!isAdmin_bk&&b.email&&(
                            <div style={{fontSize:9,fontWeight:700,color:bkTxt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:3,opacity:0.92}}>
                              <span style={{width:6,height:6,borderRadius:"50%",background:ec,flexShrink:0,boxShadow:"0 0 0 1px rgba(255,255,255,0.4)",display:"inline-block"}}/>
                              {calAlias(b.email)}
                            </div>
                          )}
                          <div style={{display:"flex",alignItems:"center",gap:3,overflow:"hidden"}}>
                            {b.status==="cpsa_review_needed"&&<span style={{fontSize:9,flexShrink:0,lineHeight:1}}>⚠</span>}
                            {b.status==="cpsa_confirmed"&&<span style={{fontSize:9,flexShrink:0,lineHeight:1}}>🌐</span>}
                            <div style={{ fontSize:11, fontWeight:700, color:bkTxt, lineHeight:1.3, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                              {b.purpose||b.name}
                            </div>
                          </div>
                          {b.duration*HOUR_H>22&&!isAdmin_bk&&<div style={{ fontSize:9, color:bkTxtMuted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", paddingLeft:0 }}>{b.name}</div>}
                          {b.duration*HOUR_H>32&&<div style={{display:"flex",alignItems:"center",gap:3,marginTop:1,paddingLeft:10}}>
                            {b.invoiced&&<span style={{fontSize:9,fontWeight:700,color:bkTxt==="#fff"?"rgba(255,255,255,0.9)":bkTxt,background:bkTxt==="#fff"?"rgba(124,58,237,0.5)":"rgba(124,58,237,0.15)",borderRadius:3,padding:"1px 4px",whiteSpace:"nowrap"}}>🧾</span>}
                          </div>}
                          {b.duration*HOUR_H>44&&<div style={{display:"flex",alignItems:"center",gap:4,paddingLeft:10,marginTop:1}}>
                            <span style={{width:6,height:6,borderRadius:2,background:fac?.color||"#4a90d9",flexShrink:0,display:"inline-block"}}/>
                            <span style={{ fontSize:9, color:bkTxtMuted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{fac?.name}</span>
                          </div>}
                        </div>
                      );
                    })}
                    {/* Ghost blocks for new cart drafts on this date */}
                    {cartNewDrafts.filter(d=>d.date===dk).map((d,gi)=>{
                      const fac=FACILITIES.find(x=>x.id===d.facility_id);
                      return (
                        <div key={"ghost-"+gi} title={"🛒 In cart: "+d.purpose} style={{ position:"absolute", top:(d.start_hour-CAL_START)*HOUR_H, height:Math.max(d.duration*HOUR_H-2,18), left:"4px", right:"4px", background:"rgba(245,158,11,0.15)", border:"2px dashed #f59e0b", borderRadius:6, padding:"3px 6px", pointerEvents:"none", zIndex:1, display:"flex", alignItems:"flex-start", gap:4 }}>
                          <span style={{fontSize:9,marginTop:1}}>🛒</span>
                          <div style={{fontSize:10,fontWeight:700,color:"#92400e",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{d.purpose||fac?.name}</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Month Calendar (multi-select + status chips) ───────────────────────────────
function MonthCalendar({ bookings, onBookingClick, onNewBooking, selectedFacility, loggedInEmail, isAdmin, onMultiDelete, onMultiAddToCart, cartSourceIds=new Set(), deleteIds=new Set(), cartNewDrafts=[], onOpenDay, onGotoWeek, bookerFilter=new Set(), aliasNames={}, emailAliases={} }) {
  function calAlias(em) {
    if (!em) return "";
    const primary = (emailAliases[em.toLowerCase()] || em).toLowerCase();
    return aliasNames[primary] || primary.split("@")[0];
  }
  const now = new Date();
  const [year,   setYear]   = useState(now.getFullYear());
  const [month,  setMonth]  = useState(now.getMonth());
  const [selIds, setSelIds] = useState(new Set());
  const [selMode,setSelMode]= useState(false);
  const today = todayKey();

  const days    = getDaysInMonth(year, month);
  const visible = (selectedFacility === "all" ? bookings : bookings.filter(b => b.facility_id === selectedFacility))
    .filter(b => !["cancelled","rejected"].includes(b.status));

  const firstDow = days[0].getDay();
  const padStart = firstDow === 0 ? 6 : firstDow - 1;
  const cells    = [...Array(padStart).fill(null), ...days];
  while (cells.length % 7 !== 0) cells.push(null);

  function prevMonth() { if(month===0){setYear(y=>y-1);setMonth(11);}else setMonth(m=>m-1); setSelIds(new Set()); }
  function nextMonth() { if(month===11){setYear(y=>y+1);setMonth(0);}else setMonth(m=>m+1); setSelIds(new Set()); }
  function toggleSel(id) { setSelIds(s=>{ const ns=new Set(s); ns.has(id)?ns.delete(id):ns.add(id); return ns; }); }

  const selectedBookings = visible.filter(b=>selIds.has(b.id));

  const canMultiEdit = selIds.size >= 2 && (() => {
    const sb2 = selectedBookings;
    const fw = new Date(sb2[0].date+"T00:00:00").getDay();
    return sb2.every(b => b.start_hour===sb2[0].start_hour && b.duration===sb2[0].duration && new Date(b.date+"T00:00:00").getDay()===fw);
  })();

  function canDelete(b) {
    if(isAdmin) return true;
    return b.email?.toLowerCase()===loggedInEmail?.toLowerCase() && b.date>=today;
  }
  const allSelDeletable = selIds.size > 0 && selectedBookings.every(canDelete);

  function StatusDot({status}) {
    const cfg={
      approved:           {c:"#22c55e",l:"✓"},
      cpsa_confirmed:     {c:"#0891b2",l:"✓"},
      cpsa_review_needed: {c:"#a16207",l:"?"},
      rejected:           {c:"#f43f5e",l:"✗"},
      cancelled:          {c:"#94a3b8",l:"—"},
      clash:              {c:"#d97706",l:"!"},
      pending_amua:       {c:"#f59e0b",l:"⏳"},
      queued_cpsa:        {c:"#3b82f6",l:"→"},
      amua_submit:        {c:"#3b82f6",l:"→"},
      pending_cpsa:       {c:"#0ea5e9",l:"⏳"},
      pending:            {c:"#f59e0b",l:"⏳"},
    };
    const {c,l}=cfg[status]||{c:"#94a3b8",l:"?"};
    return <span style={{fontSize:8,fontWeight:800,background:c,color:"#fff",borderRadius:3,padding:"1px 3px",lineHeight:"14px",flexShrink:0}}>{l}</span>;
  }

  const selBtn = {border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"};
  const selBtnActive = {border:"1.5px solid #6366f1",background:"#eef2ff",color:"#6366f1"};

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16, flexWrap:"wrap" }}>
        <button onClick={prevMonth} style={S.btn({ border:"1.5px solid #e2e8f0", background:"#fff", color:"#475569" })}>← Prev</button>
        <button onClick={()=>{setYear(now.getFullYear());setMonth(now.getMonth());}} style={S.btn({ border:"1.5px solid #e2e8f0", background:"#fff", color:"#475569" })}>Today</button>
        <button onClick={nextMonth} style={S.btn({ border:"1.5px solid #e2e8f0", background:"#fff", color:"#475569" })}>Next →</button>
        <span style={{ fontSize:18, fontWeight:800, color:"#0f172a", letterSpacing:"-0.02em" }}>{MONTHS[month]} {year}</span>
        <button onClick={()=>{setSelMode(m=>!m);setSelIds(new Set());}}
          style={S.btn(selMode ? selBtnActive : selBtn)}>
          {selMode?"✕ Exit Select":"☑ Select"}
        </button>
      </div>

      {selMode && selIds.size > 0 && (
        <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap", padding:"12px 14px", background:"#f0f0ff", border:"1.5px solid #c7d2fe", borderRadius:10, marginBottom:12 }}>
          <span style={{ fontSize:13, fontWeight:700, color:"#4f46e5" }}>{selIds.size} selected</span>
          {allSelDeletable && (
            <button onClick={()=>{ onMultiDelete([...selIds]); setSelIds(new Set()); setSelMode(false); }}
              style={S.btn({ background:"#f43f5e", color:"#fff", fontSize:12 })}>🗑 Delete</button>
          )}
          {canMultiEdit && (
            <button onClick={()=>{ onMultiAddToCart(selectedBookings); setSelIds(new Set()); setSelMode(false); }}
              style={S.btn({ background:"#2d4a1e", color:"#fff", fontSize:12 })}>✏ Edit & Add to Cart</button>
          )}
          {!canMultiEdit && selIds.size >= 2 && (
            <span style={{ fontSize:12, color:"#6366f1" }}>Multi-edit needs same weekday, time and duration</span>
          )}
          <button onClick={()=>setSelIds(new Set())} style={S.btn({ border:"1.5px solid #c7d2fe", background:"#fff", color:"#6366f1", fontSize:12 })}>Clear</button>
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2, marginBottom:4 }}>
        {["M","T","W","T","F","S","S"].map((d,i)=><div key={i} style={{ textAlign:"center", fontSize:10, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.04em", padding:"4px 0" }}>{d}</div>)}
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}>
        {cells.map((d,ci)=>{
          if (!d) return <div key={"p"+ci} style={{ minHeight:80, background:"#fafafa", borderRadius:6 }}/>;
          const dk=dateKey(d), isToday=dk===today, isPast=dk<today;
          const dayBkgs=visible.filter(b=>b.date===dk)
            .sort((a,b)=>{
              const ai=isAdminBooking(a)?1:0,bi=isAdminBooking(b)?1:0;
              if(ai!==bi) return ai-bi;
              if(bookerFilter.size>0){
                const af=bookerFilter.has(a.email?.toLowerCase())?0:1;
                const bf=bookerFilter.has(b.email?.toLowerCase())?0:1;
                if(af!==bf) return af-bf;
              }
              return a.start_hour-b.start_hour;
            });
          const hasSelected=dayBkgs.some(b=>selIds.has(b.id));
          const cellBg = hasSelected?"#eef2ff":isToday?"#f0f9ff":"#fff";
          const cellBorder = hasSelected?"1.5px solid #6366f1":isToday?"1.5px solid #4a90d9":"1px solid #f1f5f9";
          return (
            <div key={dk}
              onClick={()=>{ if(!selMode&&!isPast) onNewBooking(dk,9,1); }}
              style={{ minHeight:80, background:cellBg, border:cellBorder, borderRadius:6, padding:"4px 4px 3px", cursor:selMode||isPast?"default":"pointer", overflow:"hidden" }}
              onMouseEnter={e=>{ if(!selMode&&!isPast) e.currentTarget.style.boxShadow="0 2px 8px rgba(0,0,0,0.08)"; }}
              onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}>
              <div onClick={e=>{ e.stopPropagation(); onGotoWeek&&onGotoWeek(dk); }} title="Open this day in week view"
                style={{ fontSize:12, fontWeight:isToday?800:500, color:isToday?"#1d4ed8":isPast?"#cbd5e1":"#0f172a", marginBottom:4, textAlign:"right", cursor:onGotoWeek?"pointer":"default" }}>{d.getDate()}</div>
              <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                {dayBkgs.slice(0,3).map(b=>{
                  const fac=FACILITIES.find(x=>x.id===b.facility_id);
                  const ec=emailColor(b.email);
                  const isSel=selIds.has(b.id);
                  const inDelete = deleteIds.has(b.id);
                  const inCart   = cartSourceIds.has(b.id);
                  const isAdmin_bk = isAdminBooking(b);
                  const chipBg = isSel?"#6366f1": isAdmin_bk?"#94a3b8" : (STATUS_CAL_COLOR[b.status]||"#64748b");
                  const chipTxt = isSel||isAdmin_bk?"#fff" : (STATUS_CAL_TEXT[b.status] || "#fff");
                  const chipOutline = inDelete?"2.5px solid #ef4444":inCart?"2.5px solid #f59e0b":isSel?"2px solid #4f46e5":"none";
                  const chipLeft = inDelete||inCart||isAdmin_bk?"none": `3px solid ${fac?.color||"#4a90d9"}`;
                  const filterActive = bookerFilter.size > 0;
                  const isDimmed = filterActive && !bookerFilter.has(b.email?.toLowerCase());
                  const dimOpacity = isAdmin_bk ? 0.25 : 0.15;
                  const facSocial = !isAdmin_bk && isSocialFac(b.facility_id);
                  return (
                    <div key={b.id}
                      onClick={e=>{ e.stopPropagation(); if(isDimmed) return; if(selMode) toggleSel(b.id); else onBookingClick(b); }}
                      title={(()=>{const r=parseMismatchNote(b.system_notes,b.notes);return `${b.name} · ${fac?.name} · ${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`+(b.status==="cpsa_review_needed"&&r.length?`\n⚠ GTEC inconsistencies:\n${r.join("\n")}`:b.status==="cpsa_confirmed"?"\n🌐 GTEC confirmed":"");})()}
                      className={facSocial?(chipTxt==="#fff"?"fac-social-tex":"fac-social-tex-dark"):undefined}
                      style={{ background:chipBg, borderRadius:4, padding:"2px 4px", fontSize:10, fontWeight:700, color:chipTxt, overflow:"hidden", whiteSpace:"nowrap", borderLeft:chipLeft, outline:chipOutline, opacity:isDimmed?dimOpacity:REVIEW_STATUSES.has(b.status)?0.75:1, cursor:isDimmed?"default":"pointer", pointerEvents:isDimmed?"none":"auto", display:"flex", alignItems:"center", gap:3 }}>
                      {!isAdmin_bk&&<span style={{width:6,height:6,borderRadius:"50%",background:ec,flexShrink:0,display:"inline-block",boxShadow:"0 0 0 1px rgba(255,255,255,0.35)"}}/>}
                      {b.status==="cpsa_review_needed"&&<span style={{fontSize:8,flexShrink:0,lineHeight:1}}>⚠</span>}
                      {b.status==="cpsa_confirmed"&&<span style={{fontSize:8,flexShrink:0,lineHeight:1}}>🌐</span>}
                      <span style={{overflow:"hidden",textOverflow:"ellipsis",flex:1,minWidth:0}}>
                        {!isAdmin_bk&&b.email&&<span style={{fontWeight:700,opacity:0.9,marginRight:3}}>{calAlias(b.email)}</span>}
                        <span style={{fontWeight:400,opacity:0.8,marginRight:3}}>{fmt24(b.start_hour)}</span>
                        {b.purpose||b.name}
                      </span>
                      {b.invoiced&&<span style={{fontSize:8,flexShrink:0}}>🧾</span>}
                    </div>
                  );
                })}
                {dayBkgs.length>3&&<div onClick={e=>{ e.stopPropagation(); onOpenDay&&onOpenDay(dk); }} title="View all bookings this day"
                  style={{ fontSize:10, color:"#6366f1", fontWeight:700, paddingLeft:2, cursor:onOpenDay?"pointer":"default" }}>+{dayBkgs.length-3} more</div>}
                {cartNewDrafts.filter(d=>d.date===dk).map((d,gi)=>{
                  const fac=FACILITIES.find(x=>x.id===d.facility_id);
                  return (
                    <div key={"ghost-"+gi} style={{borderRadius:4,padding:"2px 4px",fontSize:10,fontWeight:700,color:"#92400e",background:"rgba(245,158,11,0.15)",border:"1.5px dashed #f59e0b",overflow:"hidden",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:3}}>
                      <span>🛒</span>
                      <span style={{overflow:"hidden",textOverflow:"ellipsis",flex:1}}>{fmtTime(d.start_hour)} {d.purpose||fac?.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Day Timeline Popup (per-facility columns, drag-through to create) ──────────
// Bookings render as blocks; a plain click opens a booking, a click-drag (even
// starting on a block) passes through to create a new booking — so overlapping /
// same-facility bookings (e.g. for merges) are easy to create.
function DayTimelinePopup({ date, bookings, onClose, onBookingClick, onNewBooking, cartNewDrafts=[], focusHour=null }) {
  const [dragState, setDragState] = useState(null); // {facility, startSlot, endSlot}
  const [pendingSel, setPendingSel] = useState(null); // {facility, lo, hi} staged for the Create button
  const dragMoved   = useRef(false);
  const justDragged = useRef(false);
  const downBooking = useRef(false);
  const scrollRef   = useRef(null);
  // When opened from a week/month interaction, center the time grid on the chosen hour.
  useEffect(()=>{
    if (focusHour==null || !scrollRef.current) return;
    const el = scrollRef.current;
    const y = (focusHour-CAL_START)*HOUR_H;
    el.scrollTop = Math.max(0, y - el.clientHeight/2 + HOUR_H);
  },[focusHour]);

  const dk = typeof date === "string" ? date : dateKey(date);
  const dObj = typeof date === "string" ? new Date(date+"T00:00:00") : date;
  const dayBkgs = bookings.filter(b=>b.date===dk && !["cancelled","rejected"].includes(b.status));

  const yToSlot   = y => Math.max(0, Math.min(Math.floor(y/SLOT_H), CAL_TOTAL*2-1));
  const slotToHour= s => CAL_START + s*0.5;
  const norm = ds => ds ? { ...ds, lo:Math.min(ds.startSlot,ds.endSlot), hi:Math.max(ds.startSlot,ds.endSlot) } : null;

  function down(e, facId) {
    if (e.button!==0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = yToSlot(e.clientY - rect.top);
    dragMoved.current = false;
    setPendingSel(null);
    setDragState({ facility:facId, startSlot:slot, endSlot:slot });
  }
  function move(e, facId) {
    if (!dragState || dragState.facility!==facId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = yToSlot(e.clientY - rect.top);
    if (slot !== dragState.endSlot) { dragMoved.current = true; setDragState(ds=>({ ...ds, endSlot:slot })); }
  }
  function up(e, facId) {
    if (!dragState || dragState.facility!==facId) return;
    const ndUp = norm(dragState);
    const moved = dragMoved.current;
    const wasOnBooking = downBooking.current;
    dragMoved.current = false; downBooking.current = false;
    setDragState(null);
    // Stage the selection; the user confirms via the footer "Create booking" button.
    if (moved) {
      justDragged.current = true;
      setPendingSel({ facility:facId, lo:ndUp.lo, hi:ndUp.hi });
    } else if (!wasOnBooking) {
      setPendingSel({ facility:facId, lo:ndUp.lo, hi:Math.min(ndUp.lo+1, CAL_TOTAL*2-1) });
    }
  }

  const nd = norm(dragState);

  return (
    <Modal title={`📅 ${dObj.toLocaleDateString("en-NZ",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}`} onClose={onClose} width={760}>
      <div style={{fontSize:12,color:"#94a3b8",marginBottom:8}}>Click a booking to view it · click or drag an empty area to select a time, then press Create booking.</div>
      <div ref={scrollRef} style={{overflow:"auto",maxHeight:"60vh"}}>
        <div style={{display:"flex",minWidth:560}}>
          {/* Hour labels (sticky on horizontal scroll) */}
          <div style={{width:48,flexShrink:0,position:"sticky",left:0,zIndex:6,background:"#fff"}}>
            <div style={{height:24,position:"sticky",top:0,zIndex:7,background:"#fff"}}/>
            {Array.from({length:CAL_TOTAL+1},(_,i)=>CAL_START+i).map(h=>(
              <div key={h} style={{height:HOUR_H,display:"flex",alignItems:"flex-start",justifyContent:"flex-end",paddingRight:6,paddingTop:3}}>
                <span style={{fontSize:10,color:"#94a3b8",whiteSpace:"nowrap"}}>{fmtTime(h)}</span>
              </div>
            ))}
          </div>
          {/* Facility columns */}
          {FACILITIES.map(fac=>{
            const isDragging = dragState?.facility===fac.id;
            const colSel = (isDragging && nd) ? nd : (pendingSel?.facility===fac.id ? pendingSel : null);
            const colTint = FACILITY_TINT[fac.id] || "#fff";
            return (
              <div key={fac.id} style={{flex:1,minWidth:96}}>
                <div style={{height:24,boxSizing:"border-box",position:"sticky",top:0,zIndex:5,display:"flex",alignItems:"center",justifyContent:"center",gap:4,fontSize:10,fontWeight:700,color:fac.color,whiteSpace:"nowrap",overflow:"hidden",background:colTint,borderBottom:`2px solid ${fac.color}`}}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:fac.color,flexShrink:0}}/>
                  {fac.name.includes("Field")?fac.name.replace("Field ","Fld "):fac.name.split("–")[0].trim().slice(0,10)}
                </div>
                <div style={{position:"relative",borderLeft:"1px solid #f1f5f9",cursor:isDragging?"ns-resize":"crosshair",background:colTint}}
                  onMouseDown={e=>down(e,fac.id)} onMouseMove={e=>move(e,fac.id)} onMouseUp={e=>up(e,fac.id)}
                  onMouseLeave={()=>{ if(isDragging){ dragMoved.current=false; setDragState(null);} }}>
                  {/* Hour cells */}
                  {Array.from({length:CAL_TOTAL},(_,i)=>i).map(i=>(
                    <div key={i} style={{height:HOUR_H,boxSizing:"border-box",borderBottom:"1px solid #f1f5f9"}}>
                      <div style={{height:"50%",borderBottom:"1px dashed #f8fafc"}}/>
                    </div>
                  ))}
                  {/* Drag / staged-selection preview */}
                  {colSel && (
                    <div style={{position:"absolute",left:2,right:2,top:colSel.lo*SLOT_H,height:(colSel.hi-colSel.lo+1)*SLOT_H,background:"rgba(99,102,241,0.15)",border:"2px solid rgba(99,102,241,0.6)",borderRadius:6,pointerEvents:"none",zIndex:4}}>
                      <div style={{position:"absolute",top:2,left:4,fontSize:9,fontWeight:700,color:"#4f46e5"}}>{fmtTime(slotToHour(colSel.lo))}-{fmtTime(slotToHour(colSel.hi+1))}</div>
                    </div>
                  )}
                  {/* Booking blocks (only this facility's own, non-admin shown in colour; admin as grey background) */}
                  {dayBkgs.filter(b=>b.facility_id===fac.id).map(b=>{
                    const ec=emailColor(b.email);
                    const isAdmin_bk=isAdminBooking(b);
                    const isCpsa=b.status==="cpsa_confirmed"||b.status==="cpsa_review_needed";
                    const bg=isAdmin_bk?"#94a3b8":isCpsa?"#78909c":fac.color;
                    return (
                      <div key={b.id}
                        onMouseDown={()=>{ downBooking.current = true; }}
                        onClick={e=>{ e.stopPropagation(); if(justDragged.current){ justDragged.current=false; return; } onBookingClick(b); }}
                        title={`${b.name} · ${fmtTime(b.start_hour)}`}
                        style={{position:"absolute",top:(b.start_hour-CAL_START)*HOUR_H,height:Math.max(b.duration*HOUR_H-2,18),left:3,right:3,background:bg,borderRadius:6,padding:"2px 5px",cursor:"pointer",overflow:"hidden",opacity:REVIEW_STATUSES.has(b.status)?0.78:0.95,borderLeft:isAdmin_bk?undefined:`4px solid ${ec}`,zIndex:2,boxShadow:"0 1px 3px rgba(0,0,0,0.15)"}}>
                        <div style={{fontSize:10,fontWeight:700,color:"#fff",lineHeight:1.2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.purpose||b.name}</div>
                        {b.duration*HOUR_H>30&&<div style={{fontSize:9,color:"rgba(255,255,255,0.85)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name}</div>}
                      </div>
                    );
                  })}
                  {/* Ghost blocks for cart drafts */}
                  {cartNewDrafts.filter(d=>d.date===dk&&d.facility_id===fac.id).map((d,gi)=>(
                    <div key={"g"+gi} title={"🛒 In cart"} style={{position:"absolute",top:(d.start_hour-CAL_START)*HOUR_H,height:Math.max(d.duration*HOUR_H-2,16),left:3,right:3,background:"rgba(245,158,11,0.15)",border:"2px dashed #f59e0b",borderRadius:6,padding:"2px 5px",pointerEvents:"none",zIndex:1}}>
                      <div style={{fontSize:9,fontWeight:700,color:"#92400e",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>🛒 {d.purpose}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {pendingSel && (() => {
        const f = FACILITIES.find(x=>x.id===pendingSel.facility);
        const sH = slotToHour(pendingSel.lo), eH = slotToHour(pendingSel.hi+1);
        return (
          <div style={{display:"flex",alignItems:"center",gap:10,marginTop:12,padding:"10px 14px",background:"#eef2ff",border:"1.5px solid #c7d2fe",borderRadius:10,flexWrap:"wrap"}}>
            <span style={{width:9,height:9,borderRadius:"50%",background:f?.color,flexShrink:0}}/>
            <div style={{fontSize:13,color:"#0f172a"}}><strong>{f?.name}</strong> &middot; {fmtTime(sH)}-{fmtTime(eH)} <span style={{color:"#64748b"}}>({+(eH-sH).toFixed(1)}h)</span></div>
            <div style={{marginLeft:"auto",display:"flex",gap:8}}>
              <button onClick={()=>setPendingSel(null)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#64748b",fontSize:12,padding:"6px 12px"})}>Clear</button>
              <button onClick={()=>{ onNewBooking(dk, sH, +(eH-sH).toFixed(2), pendingSel.facility); setPendingSel(null); }} style={S.btn({background:"#6366f1",color:"#fff",fontSize:12,padding:"6px 14px"})}>Create booking</button>
            </div>
          </div>
        );
      })()}
    </Modal>
  );
}

function AboutTab() {
  const card = { background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"20px 24px", marginBottom:16 };
  const h2 = { margin:"0 0 12px", fontSize:16, fontWeight:700, color:"#0f172a" };
  const step = { display:"flex", gap:12, alignItems:"flex-start", marginBottom:12 };
  const stepNum = (col) => ({
    width:28, height:28, borderRadius:"50%", background:col, color:"#fff",
    fontWeight:700, fontSize:13, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0
  });
  const arrow = { textAlign:"center", color:"#94a3b8", fontSize:18, margin:"4px 0 4px 14px" };
  const link = { color:"#2563eb", textDecoration:"underline" };
  return (
    <div style={{maxWidth:720,margin:"0 auto"}}>
      <div style={card}>
        <h2 style={h2}>How to Book</h2>
        <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>
          Bookings at Cornwall Park are managed through GTEC (Grammar TEC).
          AMUA (Auckland Mixed Ultimate Association) acts as a facilitating body and can submit booking requests on your behalf.
          You can also submit directly using the{" "}
          <a href="https://www.grammartec.co.nz/viewform/499414" target="_blank" rel="noopener noreferrer" style={link}>GTEC field hire form</a>.
        </p>
        <h3 style={{margin:"12px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Approval Process</h3>
        <div style={step}>
          <div style={stepNum("#6366f1")}>1</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>Submit booking request</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>Fill in the booking form with your group name, facility, date, time, and purpose. Your request is saved with status <Badge status="pending_amua"/>.</div>
          </div>
        </div>
        <div style={arrow}>↓</div>
        <div style={step}>
          <div style={stepNum("#f59e0b")}>2</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>AMUA reviews your request</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>AMUA checks availability and eligibility. If accepted, the booking is queued for submission to GTEC — status becomes <Badge status="queued_cpsa"/>. If there is a conflict or issue, AMUA may reject or request revision.</div>
          </div>
        </div>
        <div style={arrow}>↓</div>
        <div style={step}>
          <div style={stepNum("#0ea5e9")}>3</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>AMUA submits to GTEC</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>AMUA lodges the request with GTEC using the{" "}
              <a href="https://www.grammartec.co.nz/viewform/499414" target="_blank" rel="noopener noreferrer" style={link}>GTEC field hire form</a>.
              Status becomes <Badge status="pending_cpsa"/>. You can also contact GTEC directly — AMUA can co-sign as the responsible party.
            </div>
          </div>
        </div>
        <div style={arrow}>↓</div>
        <div style={step}>
          <div style={stepNum("#22c55e")}>4</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>GTEC decision &amp; reconciliation</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>
              Once AMUA receives verbal confirmation from GTEC, the booking is marked <Badge status="approved"/> (or <Badge status="rejected"/> if declined) — accept/reject only applies while a booking has not yet been reconciled against GTEC's published schedule. When AMUA later syncs the official GTEC schedule, an approved booking that matches GTEC's record exactly is promoted to <Badge status="cpsa_confirmed"/> — confirming that what you booked is what GTEC has on file. If anything differs (time, duration or facility), the booking is flagged <Badge status="cpsa_review_needed"/> instead, and AMUA will triage the discrepancy. Bookings with a 🌐 marker in the calendar are GTEC-confirmed.
            </div>
          </div>
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>About Admin Bookings</h2>
        <p style={{margin:"0 0 8px",fontSize:13,color:"#475569"}}>
          Bookings shown with a grey/admin tag are imported from the{" "}
          <a href="https://www.carltonjuniorsrugby.co.nz/venue-hire-fields-1/field-calendar" target="_blank" rel="noopener noreferrer" style={link}>Carlton Juniors Rugby field calendar</a>.
          These represent existing field bookings and block-outs that may affect availability.
        </p>
        <p style={{margin:0,fontSize:13,color:"#94a3b8"}}>
          Note: the CJR calendar covers sports field bookings only. It does <strong>not</strong> include availability of function rooms or meeting rooms.
        </p>
      </div>

      <div style={card}>
        <h2 style={h2}>Hiring Rates</h2>
        <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>Rates are set per facility and time of day. Contact AMUA for current rates.</p>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          {FACILITIES.map(f=>(
            <div key={f.id} style={{display:"flex",alignItems:"center",gap:8,background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 14px",flex:"1 1 180px"}}>
              <span style={{width:10,height:10,borderRadius:"50%",background:f.color,display:"inline-block",flexShrink:0}}/>
              <span style={{fontWeight:600,fontSize:13,color:"#0f172a"}}>{f.name}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Status Guide</h2>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {Object.entries(STATUS_META).filter(([k])=>!["pending","amua_submit"].includes(k)).map(([k,v])=>(
            <div key={k} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 10px",background:v.bg,border:`1px solid ${v.border}`,borderRadius:8}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:v.dot,flexShrink:0}}/>
              <span style={{fontWeight:600,fontSize:13,color:v.text}}>{v.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildOverlapPatternMap(active, facSensitive) {
  function dayName(d){return["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(d+"T12:00").getDay()];}
  function timesOverlap(b1,b2){return b1.start_hour<b2.start_hour+b2.duration&&b2.start_hour<b1.start_hour+b1.duration;}
  const patternMap={};
  active.forEach(b=>{
    const email=b.email.toLowerCase();
    const dn=dayName(b.date);
    if(!patternMap[email]) patternMap[email]={};
    const emailPats=patternMap[email];
    let matchedPk=null;
    for(const [pk,bkgs] of Object.entries(emailPats)){
      const parts=pk.split("_");
      const pkDn=facSensitive?parts[1]:parts[0];
      const pkFac=facSensitive?parts[0]:null;
      if(pkDn!==dn) continue;
      if(facSensitive&&pkFac!==b.facility_id) continue;
      if(bkgs.some(eb=>timesOverlap(eb,b))){matchedPk=pk;break;}
    }
    if(matchedPk){emailPats[matchedPk].push(b);}
    else{
      const pk=facSensitive?`${b.facility_id}_${dn}_${b.start_hour}`:`${dn}_${b.start_hour}`;
      if(!emailPats[pk]) emailPats[pk]=[];
      emailPats[pk].push(b);
    }
  });
  return patternMap;
}

function PatternModal({ email, name, pk, bkgs, isAdmin, canEdit: canEditProp, onClose, onBulkApply }) {
  const canEdit = canEditProp !== undefined ? canEditProp : isAdmin;
  const parts = pk.split("_");
  const startH = parseFloat(parts[parts.length-1]);
  const dn = parts[parts.length-2]||"";
  const facId = parts.length>2 ? parts[0] : null;
  const fac = facId ? FACILITIES.find(f=>f.id===facId) : null;

  const [bulkTime, setBulkTime] = useState(startH);
  const [bulkDur, setBulkDur] = useState(bkgs[0]?.duration ?? 2);
  const [bulkFac, setBulkFac] = useState(bkgs[0]?.facility_id ?? "");
  const [cancelFrom, setCancelFrom] = useState("");

  const sorted = [...bkgs].sort((a,b)=>a.date.localeCompare(b.date));

  const si = {border:"1px solid #e2e8f0",borderRadius:6,padding:"4px 8px",fontSize:13,fontFamily:"inherit",background:"#fff"};

  return (
    <Modal title={`Pattern: ${dn} ${fmtTime(startH)} — ${name}`} onClose={onClose}>
      <div style={{fontSize:12,color:"#64748b",marginBottom:12}}>
        {bkgs.length} booking{bkgs.length!==1?"s":""} · {email}
        {fac && <span> · {fac.name}</span>}
      </div>

      <div style={{overflowY:"auto",maxHeight:280,marginBottom:16}}>
        <CopyableTable>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0"}}>
              <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Date</th>
              <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Facility</th>
              <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Time</th>
              <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Dur</th>
              <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(b=>{
              const f=FACILITIES.find(x=>x.id===b.facility_id);
              const sm=STATUS_META[b.status];
              return (
                <tr key={b.id} style={{borderBottom:"1px solid #f1f5f9"}}>
                  <td style={{padding:"5px 8px"}}>{fmtDate(b.date)}</td>
                  <td style={{padding:"5px 8px"}}><span style={{fontSize:11,background:f?.color+"22",color:f?.color,borderRadius:4,padding:"1px 5px"}}>{f?.name.split("–")[0].trim()}</span></td>
                  <td style={{padding:"5px 8px",textAlign:"right"}}>{fmtTime(b.start_hour)}</td>
                  <td style={{padding:"5px 8px",textAlign:"right"}}>{b.duration}h</td>
                  <td style={{padding:"5px 8px"}}><span style={{fontSize:11,background:sm?.bg,color:sm?.text,border:`1px solid ${sm?.border}`,borderRadius:4,padding:"1px 5px"}}>{sm?.label||b.status}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </CopyableTable>
      </div>

      {(isAdmin || canEdit) && (
        <div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 12px"}}>
          <div style={{fontWeight:700,fontSize:13,color:"#0f172a",marginBottom:8}}>Bulk Edit (apply to all in pattern)</div>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:12,color:"#64748b"}}>Start time</span>
              <input type="number" min="0" max="23" step="0.5" value={bulkTime}
                onChange={e=>setBulkTime(parseFloat(e.target.value)||0)}
                style={{...si,width:64}}/>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:12,color:"#64748b"}}>Duration</span>
              <select value={bulkDur} onChange={e=>setBulkDur(parseFloat(e.target.value))} style={si}>
                {DURATIONS.map(d=><option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <span style={{fontSize:12,color:"#64748b"}}>Facility</span>
              <select value={bulkFac} onChange={e=>setBulkFac(e.target.value)} style={si}>
                {FACILITIES.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
            <span style={{fontSize:12,color:"#e11d48"}}>Cancel from date</span>
            <input type="date" value={cancelFrom} onChange={e=>setCancelFrom(e.target.value)} style={{...si,width:140}}/>
            <span style={{fontSize:11,color:"#94a3b8"}}>(leave blank to skip)</span>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>{
              onBulkApply({email,pk,bkgs:sorted,bulkTime,bulkDur,bulkFac,cancelFrom});
              onClose();
            }} style={S.btn({background:"#0f172a",color:"#fff",fontSize:12})}>
              Apply to all ({sorted.filter(b=>!cancelFrom||b.date>=cancelFrom).length} bookings)
            </button>
            <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#64748b",fontSize:12})}>Close</button>
          </div>
        </div>
      )}
      {!(isAdmin || canEdit) && (
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#64748b",fontSize:12})}>Close</button>
      )}
    </Modal>
  );
}

function OneOffModal({ email, name, bkgs, onClose }) {
  const sorted = [...bkgs].sort((a,b)=>a.date.localeCompare(b.date));
  return (
    <Modal title={`One-off Bookings — ${name}`} onClose={onClose}>
      <div style={{fontSize:12,color:"#64748b",marginBottom:10}}>{sorted.length} one-off booking{sorted.length!==1?"s":""} · {email}</div>
      <div style={{overflowY:"auto",maxHeight:360}}>
        <CopyableTable>
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{background:"#f8fafc",borderBottom:"1px solid #e2e8f0"}}>
              <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Date</th>
              <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Facility</th>
              <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Time</th>
              <th style={{textAlign:"right",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Dur</th>
              <th style={{textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b"}}>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(b=>{
              const f=FACILITIES.find(x=>x.id===b.facility_id);
              const sm=STATUS_META[b.status];
              return (
                <tr key={b.id} style={{borderBottom:"1px solid #f1f5f9"}}>
                  <td style={{padding:"5px 8px"}}>{fmtDate(b.date)}</td>
                  <td style={{padding:"5px 8px"}}><span style={{fontSize:11,background:f?.color+"22",color:f?.color,borderRadius:4,padding:"1px 5px"}}>{f?.name.split("–")[0].trim()}</span></td>
                  <td style={{padding:"5px 8px",textAlign:"right"}}>{fmtTime(b.start_hour)}</td>
                  <td style={{padding:"5px 8px",textAlign:"right"}}>{b.duration}h</td>
                  <td style={{padding:"5px 8px"}}><span style={{fontSize:11,background:sm?.bg,color:sm?.text,border:`1px solid ${sm?.border}`,borderRadius:4,padding:"1px 5px"}}>{sm?.label||b.status}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </CopyableTable>
      </div>
      <div style={{marginTop:12}}>
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#64748b",fontSize:12})}>Close</button>
      </div>
    </Modal>
  );
}

function ScheduleSummaryModal({ bookings, isAdmin, loggedInEmail, onBulkApply, onBulkStatusChange, onClose, inline=false, aliasNames={}, emailAliases={} }) {
  const [facSensitive, setFacSensitive] = useState(false);
  const [splitPatterns, setSplitPatterns] = useState(new Set());
  const [patternModal, setPatternModal] = useState(null);
  const [oneOffModalData, setOneOffModalData] = useState(null);
  const [schedDateFrom, setSchedDateFrom] = useState("");
  const [schedDateTo,   setSchedDateTo]   = useState("");
  const [schedStatusFilter, setSchedStatusFilter] = useState(new Set());
  // Selected {email, status} groups for bulk action. Key = `${email}::${status}`.
  const [selectedGroups, setSelectedGroups] = useState(new Set());
  const [bulkStatusTarget, setBulkStatusTarget] = useState("approved");

  const schedAlias = em => {
    if (!em) return em;
    const primary = (emailAliases[em.toLowerCase()] || em).toLowerCase();
    return aliasNames[primary] || primary.split("@")[0];
  };

  const active = bookings.filter(b=>(["approved","cpsa_confirmed","cpsa_review_needed","pending_cpsa","queued_cpsa","pending_amua","amua_submit","pending"].includes(b.status)||b.invoiced)&&!isAdminBooking(b));
  const patternMap = buildOverlapPatternMap(active, facSensitive);

  const rows = Object.entries(patternMap).map(([email,pats])=>{
    const nameDisplay=(Object.values(pats)[0]||[])[0]?.name||email;
    const recurring=Object.entries(pats).filter(([,bs])=>bs.length>=2);
    const oneOffs=Object.values(pats).filter(bs=>bs.length===1).flat();
    const totalBkgs=Object.values(pats).reduce((s,bs)=>s+bs.length,0);
    // Date-filtered bookings for this row
    const allBkgs = Object.values(pats).flat();
    const filteredBkgs = allBkgs.filter(b=>{
      if(schedDateFrom && b.date < schedDateFrom) return false;
      if(schedDateTo   && b.date > schedDateTo)   return false;
      return true;
    });
    const dates = filteredBkgs.map(b=>b.date).filter(Boolean).sort();
    const patternDateFrom = dates[0] || "";
    const patternDateTo   = dates[dates.length-1] || "";
    // Status counts for filtered bookings
    const statusCounts = {};
    filteredBkgs.forEach(b=>{ statusCounts[b.status] = (statusCounts[b.status]||0) + 1; });
    // Apply status filter — skip row if filter is active and no bookings match
    if(schedStatusFilter.size>0 && !filteredBkgs.some(b=>schedStatusFilter.has(b.status))) return null;
    return {email,nameDisplay,recurring,oneOffs,totalBkgs,filteredBkgs,patternDateFrom,patternDateTo,statusCounts};
  }).filter(Boolean).sort((a,b)=>b.totalBkgs-a.totalBkgs);

  // All unique statuses present in the active pool for the status filter chips
  const allStatuses = [...new Set(active.map(b=>b.status))];

  const thS2={textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b",fontSize:12,borderBottom:"1px solid #e2e8f0"};
  const tdS2={padding:"6px 8px",verticalAlign:"top",fontSize:13};

  function renderChips(email, nameDisplay, recurring) {
    const ec = emailColor(email);
    const canEdit = isAdmin || email.toLowerCase() === loggedInEmail?.toLowerCase();
    const chips = [];
    for (const [pk, bkgs] of recurring) {
      const splitKey = `${email}::${pk}`;
      const isSplit = splitPatterns.has(splitKey);
      const startHours = [...new Set(bkgs.map(b=>b.start_hour))];
      const isMixed = startHours.length > 1;
      if (isSplit && isMixed) {
        for (const sh of startHours.sort((a,b)=>a-b)) {
          const subBkgs = bkgs.filter(b=>b.start_hour===sh);
          const parts=pk.split("_"); const dn=parts[parts.length-2]||"";
          const durs=[...new Set(subBkgs.map(b=>b.duration))];
          const durLabel=durs.length===1?`${durs[0]}h`:`~${Math.round(durs.reduce((s,d)=>s+d,0)/durs.length*2)/2}h`;
          const facIds=[...new Set(subBkgs.map(b=>b.facility_id))];
          const facLabel=facIds.map(fid=>{const f=FACILITIES.find(x=>x.id===fid);return f?(f.name.includes("Field")?f.name.replace("Field ","Fld "):f.name.split("–")[0].trim().slice(0,6)):fid;}).join(", ");
          chips.push(
            <span key={`${pk}::${sh}`} onClick={()=>setPatternModal({email,name:nameDisplay,pk:`${dn}_${sh}`,bkgs:subBkgs,canEdit})}
              style={{display:"inline-flex",alignItems:"center",gap:3,background:ec+"22",color:ec,border:`1px solid ${ec}55`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>
              {dn} {fmtTime(sh)} · {durLabel} · {facLabel} ×{subBkgs.length}
            </span>
          );
        }
        chips.push(
          <button key={`merge-${pk}`} onClick={()=>setSplitPatterns(prev=>{const ns=new Set(prev);ns.delete(splitKey);return ns;})}
            title="Re-merge sub-patterns"
            style={{fontSize:10,padding:"1px 6px",borderRadius:4,border:"1px solid #e2e8f0",background:"#fff",color:"#64748b",cursor:"pointer"}}>↩ merge</button>
        );
      } else {
        const parts=pk.split("_");
        const startH=parseFloat(parts[parts.length-1]);
        const dn=parts[parts.length-2]||"";
        const durs=[...new Set(bkgs.map(b=>b.duration))];
        const durLabel=durs.length===1?`${durs[0]}h`:`~${Math.round(durs.reduce((s,d)=>s+d,0)/durs.length*2)/2}h`;
        const facIds=[...new Set(bkgs.map(b=>b.facility_id))];
        const facLabel=facIds.map(fid=>{const f=FACILITIES.find(x=>x.id===fid);return f?(f.name.includes("Field")?f.name.replace("Field ","Fld "):f.name.split("–")[0].trim().slice(0,6)):fid;}).join(", ");
        chips.push(
          <span key={pk} onClick={()=>setPatternModal({email,name:nameDisplay,pk,bkgs,canEdit})}
            style={{display:"inline-flex",alignItems:"center",gap:3,background:ec+"22",color:ec,border:`1px solid ${ec}55`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>
            {dn} {fmtTime(startH)} · {durLabel} · {facLabel} ×{bkgs.length}
            {isMixed&&<span title="Mixed start times — click ↕ to split"
              onClick={e=>{e.stopPropagation();setSplitPatterns(prev=>{const ns=new Set(prev);ns.add(splitKey);return ns;});}}
              style={{fontSize:10,opacity:0.7,cursor:"pointer"}}>↕</span>}
          </span>
        );
      }
    }
    return chips;
  }

  const Wrapper = inline
    ? ({children}) => <div style={{background:"#f0f9ff",border:"1.5px solid #bae6fd",borderRadius:12,padding:16}}><div style={{fontSize:14,fontWeight:700,color:"#0369a1",marginBottom:10}}>📅 Schedule Summary</div>{children}</div>
    : ({children}) => <Modal title="📅 Schedule Summary" onClose={onClose}>{children}</Modal>;
  const colCount = 5;
  const groupSelectable = isAdmin && onBulkStatusChange;
  function toggleGroup(email, status) {
    const k = `${email}::${status}`;
    setSelectedGroups(prev=>{
      const s = new Set(prev);
      if (s.has(k)) s.delete(k); else s.add(k);
      return s;
    });
  }
  // Resolve selected groups → all matching bookings
  const selectedBkgs = (()=>{
    if (selectedGroups.size===0) return [];
    const out = [];
    for (const row of rows) {
      for (const b of row.filteredBkgs) {
        if (selectedGroups.has(`${row.email}::${b.status}`)) out.push(b);
      }
    }
    return out;
  })();
  return (
    <>
      <Wrapper>
        {/* Toolbar: facility-sensitive + date range filter + status filter */}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:10}}>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer",color:"#475569"}}>
            <input type="checkbox" checked={facSensitive} onChange={e=>setFacSensitive(e.target.checked)}/>
            Facility-sensitive
          </label>
          <div style={{marginLeft:4}}>
            <DateRangePicker from={schedDateFrom} to={schedDateTo} onApply={(f,t)=>{setSchedDateFrom(f);setSchedDateTo(t);}}/>
          </div>
          {allStatuses.length>0&&(
            <div style={{display:"flex",gap:4,flexWrap:"wrap",alignItems:"center"}}>
              <span style={{fontSize:11,fontWeight:600,color:"#64748b"}}>Status:</span>
              {allStatuses.map(st=>{
                const m=STATUS_META[st]||STATUS_META.pending_amua;
                const active=schedStatusFilter.has(st);
                return(
                  <button key={st} onClick={()=>setSchedStatusFilter(prev=>{const s=new Set(prev);active?s.delete(st):s.add(st);return s;})}
                    style={{padding:"2px 7px",borderRadius:8,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:`1.5px solid ${active?m.border:"#e2e8f0"}`,background:active?m.bg:"#fff",color:active?m.text:"#64748b"}}>
                    {m.label.replace(/^\(\d\/\d\) /,"")}
                  </button>
                );
              })}
              {schedStatusFilter.size>0&&<button onClick={()=>setSchedStatusFilter(new Set())} style={{padding:"2px 7px",borderRadius:8,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:"1.5px solid #e2e8f0",background:"#fff",color:"#94a3b8"}}>✕ clear</button>}
            </div>
          )}
        </div>
        {isAdmin&&onBulkStatusChange&&(
          <div style={{fontSize:11,color:"#64748b",marginBottom:8,fontStyle:"italic"}}>
            Tip: click status chips below to select groups, then apply a bulk action.
          </div>
        )}
        <div style={{overflowY:"auto",maxHeight:"60vh",overflowX:"auto"}}>
          <CopyableTable>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
            <thead>
              <tr style={{background:"#f8fafc"}}>
                <th style={thS2}>Booker</th>
                <th style={thS2}>Recurring Patterns <span style={{fontWeight:400,fontSize:11,color:"#94a3b8"}}>(click to edit)</span></th>
                <th style={{...thS2,minWidth:100}}>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    Date Range
                    {(schedDateFrom||schedDateTo)&&<span style={{fontSize:9,background:"#0f172a",color:"#fff",borderRadius:4,padding:"0 3px"}}>filtered</span>}
                  </div>
                </th>
                <th style={{...thS2,minWidth:110}}>Status {groupSelectable&&<span style={{fontWeight:400,fontSize:11,color:"#94a3b8"}}>(click to select)</span>}</th>
                <th style={{...thS2,textAlign:"right"}}>One-offs</th>
                <th style={{...thS2,textAlign:"right"}}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row=>{
                const ec = emailColor(row.email);
                return (
                  <tr key={row.email} style={{borderBottom:"1px solid #f1f5f9"}}>
                    <td style={tdS2}>
                      <span style={{display:"inline-block",padding:"3px 10px",borderRadius:12,background:ec,color:"#fff",fontSize:12,fontWeight:700}}>
                        {schedAlias(row.email)}
                      </span>
                    </td>
                    <td style={tdS2}>
                      <div style={{display:"flex",flexWrap:"wrap",gap:4,alignItems:"center"}}>
                        {row.recurring.length===0&&<span style={{fontSize:12,color:"#94a3b8"}}>—</span>}
                        {renderChips(row.email, row.nameDisplay, row.recurring)}
                      </div>
                    </td>
                    <td style={{...tdS2,fontSize:12,color:"#475569",whiteSpace:"nowrap"}}>
                      {row.patternDateFrom
                        ? <>{fmtDateShort(row.patternDateFrom)}<span style={{color:"#94a3b8",margin:"0 3px"}}>–</span>{fmtDateShort(row.patternDateTo)}</>
                        : <span style={{color:"#94a3b8"}}>—</span>}
                      {row.filteredBkgs.length>0&&<div style={{fontSize:10,color:"#94a3b8",marginTop:2}}>{row.filteredBkgs.length} bookings</div>}
                    </td>
                    <td style={tdS2}>
                      <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                        {Object.entries(row.statusCounts).map(([st,cnt])=>{
                          const m=STATUS_META[st]||STATUS_META.pending_amua;
                          const sel=selectedGroups.has(`${row.email}::${st}`);
                          const Tag = groupSelectable ? "button" : "span";
                          return(
                            <Tag key={st} title={groupSelectable?`Click to select ${cnt} ${m.label.replace(/^\(\d\/\d\) /,"")}`:m.label}
                              onClick={groupSelectable?()=>toggleGroup(row.email,st):undefined}
                              style={{display:"inline-flex",alignItems:"center",gap:3,padding:"2px 7px",borderRadius:8,background:sel?m.dot:m.bg,color:sel?"#fff":m.text,border:`1.5px solid ${sel?m.dot:m.border}`,fontSize:10,fontWeight:700,cursor:groupSelectable?"pointer":"default",fontFamily:"inherit",outline:"none",boxShadow:sel?`0 0 0 2px ${m.dot}33`:"none"}}>
                              {sel&&<span style={{fontSize:9}}>✓</span>}
                              <span style={{width:5,height:5,borderRadius:"50%",background:sel?"#fff":m.dot,flexShrink:0}}/>
                              {m.label.replace(/^\(\d\/\d\) /,"").slice(0,10)} ×{cnt}
                            </Tag>
                          );
                        })}
                        {Object.keys(row.statusCounts).length===0&&<span style={{color:"#94a3b8",fontSize:12}}>—</span>}
                      </div>
                    </td>
                    <td style={{...tdS2,textAlign:"right"}}>
                      {row.oneOffs.length>0
                        ? <span style={{cursor:"pointer",color:"#6366f1",textDecoration:"underline dotted",fontSize:13}}
                            onClick={()=>setOneOffModalData({email:row.email,name:row.nameDisplay,bkgs:row.oneOffs,isAdmin})}>
                            {row.oneOffs.length}
                          </span>
                        : <span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{...tdS2,textAlign:"right",fontWeight:700}}>{row.totalBkgs}</td>
                  </tr>
                );
              })}
              {rows.length===0&&<tr><td colSpan={colCount} style={{...tdS2,textAlign:"center",color:"#94a3b8"}}>No active bookings.</td></tr>}
            </tbody>
          </table>
          </CopyableTable>
        </div>
        {groupSelectable && selectedGroups.size>0 && (
          <div style={{marginTop:10,padding:"10px 14px",background:"#0f172a",borderRadius:10,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",color:"#fff"}}>
            <span style={{fontSize:12,fontWeight:700}}>
              {selectedGroups.size} group{selectedGroups.size!==1?"s":""} · {selectedBkgs.length} booking{selectedBkgs.length!==1?"s":""} selected
            </span>
            <button onClick={()=>setSelectedGroups(new Set())}
              style={{padding:"3px 9px",fontSize:11,borderRadius:6,border:"1.5px solid #334155",background:"transparent",color:"#cbd5e1",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
              Clear
            </button>
            <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
              <span style={{fontSize:11,color:"#94a3b8"}}>Set status to:</span>
              <select value={bulkStatusTarget} onChange={e=>setBulkStatusTarget(e.target.value)}
                style={{fontSize:11,padding:"4px 8px",borderRadius:6,border:"1.5px solid #334155",background:"#1e293b",color:"#fff",fontFamily:"inherit",fontWeight:600}}>
                {Object.entries(STATUS_META).filter(([k])=>!["pending","amua_submit","clash"].includes(k)).map(([k,v])=>(
                  <option key={k} value={k}>{v.label.replace(/^\(\d\/\d\) /,"")}</option>
                ))}
              </select>
              <button onClick={()=>{
                if(selectedBkgs.length===0) return;
                onBulkStatusChange(selectedBkgs.map(b=>b.id), bulkStatusTarget);
                setSelectedGroups(new Set());
              }} disabled={selectedBkgs.length===0}
                style={{padding:"5px 14px",fontSize:11,borderRadius:6,border:"none",background:selectedBkgs.length?"#22c55e":"#475569",color:"#fff",cursor:selectedBkgs.length?"pointer":"not-allowed",fontFamily:"inherit",fontWeight:700}}>
                ✓ Apply
              </button>
            </div>
          </div>
        )}
      </Wrapper>
      {patternModal&&(
        <PatternModal {...patternModal} isAdmin={isAdmin}
          onClose={()=>setPatternModal(null)}
          onBulkApply={args=>{onBulkApply&&onBulkApply(args);setPatternModal(null);}}/>
      )}
      {oneOffModalData&&(
        <OneOffModal {...oneOffModalData} onClose={()=>setOneOffModalData(null)}/>
      )}
    </>
  );
}

// Invoice modal sub-components defined at module level so their references
// are stable across SummaryTab re-renders — prevents focus loss on the Name input.
function InvoiceOptionRow({label, children}) {
  return (
    <div style={{display:"flex",alignItems:"flex-start",gap:10,flexWrap:"wrap"}}>
      <span style={{fontSize:12,fontWeight:600,color:"#64748b",minWidth:90,paddingTop:5}}>{label}</span>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",flex:1}}>{children}</div>
    </div>
  );
}
function InvoicePill({active, onClick, children}) {
  return (
    <button onClick={onClick} style={{padding:"4px 12px",borderRadius:8,border:active?"1.5px solid #0f172a":"1.5px solid #e2e8f0",background:active?"#0f172a":"#f8fafc",color:active?"#fff":"#475569",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
      {children}
    </button>
  );
}

const PIPELINE_STATES = [
  { key:"draft",         label:"Draft",           color:"#94a3b8", description:"Invoice created, not yet submitted" },
  { key:"submitted",     label:"Submitted",        color:"#f59e0b", description:"Sent to Grammar TEC" },
  { key:"gtec_invoiced", label:"GTEC Invoice Rcvd",color:"#3b82f6", description:"Received invoice from Grammar TEC" },
  { key:"club_invoiced", label:"Invoiced to Club", color:"#8b5cf6", description:"Invoice sent to club for payment" },
  { key:"complete",      label:"Complete",         color:"#22c55e", description:"All payments settled" },
];
const PIPELINE_KEYS = PIPELINE_STATES.map(s=>s.key);

function BillingTab({ billingRecords=[], onUpdateRecord, onDeleteRecord, onLoadToSummary, isAdmin=false, loggedInEmail="", emailAliases={}, aliasNames={} }) {
  const [filterStatus, setFilterStatus] = useState("all");
  const [expandedId, setExpandedId] = useState(null);
  const [expandedBatchId, setExpandedBatchId] = useState(null);
  const [expandedSubId, setExpandedSubId] = useState(null);
  const [exportMode, setExportMode] = useState("grouped"); // "grouped" | "individual"
  const [viewMode, setViewMode] = useState("grouped"); // "grouped" = batch cards | "individual" = flat rows

  const SHORT_STATUS = { draft:"Draft", submitted:"Sent", gtec_invoiced:"GTEC", club_invoiced:"Club", complete:"Done" };

  const canonEmail = em => (emailAliases[(em||"").toLowerCase()] || em || "").toLowerCase();
  const displayName = em => {
    if (!em || em === "combined") return em || "—";
    const k = canonEmail(em);
    return aliasNames[k] || k.split("@")[0];
  };

  const visibleRecords = isAdmin
    ? billingRecords
    : billingRecords.filter(r => canonEmail(r.bookerEmail) === canonEmail(loggedInEmail));

  const filtered = filterStatus === "all" ? visibleRecords : visibleRecords.filter(r => r.status === filterStatus);
  const sorted = [...filtered].sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));

  // Group records that share a batchId (created together as one Official invoice run)
  const { batches, ungrouped } = useMemo(() => {
    const batchMap = {};
    const ung = [];
    for (const rec of sorted) {
      if (rec.batchId) {
        if (!batchMap[rec.batchId]) batchMap[rec.batchId] = [];
        batchMap[rec.batchId].push(rec);
      } else {
        ung.push(rec);
      }
    }
    const bs = Object.entries(batchMap).map(([batchId, recs]) => {
      const invRecs = recs.filter(r => r.type !== "purchase_order");
      const poRec = recs.find(r => r.type === "purchase_order");
      // Display order: PO → grouped INVs (future: GTEC receipt → club receipts)
      const ordered = [poRec, ...invRecs].filter(Boolean);
      const worstStatus = recs.reduce((worst, r) => {
        const wi = PIPELINE_KEYS.indexOf(worst);
        const ri = PIPELINE_KEYS.indexOf(r.status || "draft");
        return ri < wi ? (r.status || "draft") : worst;
      }, "complete");
      return {
        batchId, records: ordered, invRecs, poRec,
        orderName: recs[0].orderName || "",
        createdAt: recs[0].createdAt || "",
        dateFrom: recs[0].dateFrom || "",
        dateTo: recs[0].dateTo || "",
        total: invRecs.reduce((s, r) => s + (r.total || 0), 0),
        status: worstStatus,
        allDraft: recs.every(r => (r.status || "draft") === "draft"),
      };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { batches: bs, ungrouped: ung };
  }, [sorted]);

  const fmtDate = d => d ? new Date(d+"T00:00:00").toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"}) : "—";
  const fmtMoney = n => n!=null ? `$${Number(n).toFixed(2)}` : "—";

  // ─── Document download from stored billing record ──────────────────────────
  // Builds invoice/PO HTML from the snapshot stored on the record. Falls back
  // to "draft" formatting (no GST extraction) when fields are missing.
  function buildRecordHtml(rec, docType, lines) {
    const docLabel = docType === "purchase_order" ? "Purchase Order" : "Invoice";
    const fmtC = n => "$" + Number(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,",");
    const periodStr = rec.dateFrom&&rec.dateTo ? `${fmtDate(rec.dateFrom)} – ${fmtDate(rec.dateTo)}` : "All periods";
    const docId = docType==="purchase_order" ? (rec.poId||rec.id) : rec.id;
    const orderName = rec.orderName||"";
    const rowsHtml = (lines||[]).map(l=>`
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${l.desc||l.description||l.label||"—"}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b">${l.detail||""}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a;text-align:right;white-space:nowrap">${fmtC(l.cost)}</td>
      </tr>`).join("");
    const pre = rec.subtotal!=null ? rec.subtotal : (lines||[]).reduce((s,l)=>s+(l.cost||0),0);
    const gst = rec.gst!=null ? rec.gst : 0;
    const total = rec.total!=null ? rec.total : pre + gst;
    const gstLabel = rec.gstMode==="note"?"":rec.gstMode==="exclusive"?"excl. GST":"incl. GST";
    const gstRows = rec.gstMode==="note"
      ? `<tr><td colspan="2" style="padding:8px 16px;font-size:12px;color:#64748b;text-align:right">GST inclusive</td><td style="padding:8px 16px;font-size:13px;font-weight:700;color:#0f172a;text-align:right">${fmtC(total)}</td></tr>`
      : `<tr style="background:#f8fafc"><td colspan="2" style="padding:8px 16px;font-size:12px;color:#64748b;text-align:right">Subtotal (${gstLabel})</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;text-align:right">${fmtC(pre)}</td></tr>
         <tr style="background:#f8fafc"><td colspan="2" style="padding:8px 16px;font-size:12px;color:#64748b;text-align:right">GST (15%)</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;text-align:right">${fmtC(gst)}</td></tr>
         <tr style="background:#f0fdf4"><td colspan="2" style="padding:10px 16px;font-size:14px;font-weight:700;color:#0f172a;text-align:right">Total</td><td style="padding:10px 16px;font-size:16px;font-weight:800;color:#15803d;text-align:right">${fmtC(total)}</td></tr>`;
    const amuaLines = [AMUA_INFO.address, AMUA_INFO.gstNumber?`GST No: ${AMUA_INFO.gstNumber}`:"", AMUA_INFO.bank].filter(Boolean).map(l=>`<div>${l}</div>`).join("");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${docLabel} ${docId}</title><style>
      @media print { body{margin:0} }
      body{font-family:'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:32px 16px}
      .page{max-width:700px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)}
    </style></head><body>
    <div class="page">
      <div style="background:#0f172a;padding:32px 40px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px">
        <div>
          <div style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.02em">${AMUA_INFO.name}</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:4px">${amuaLines}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:28px;font-weight:800;color:#fff">${docLabel}</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:4px">#${docId}</div>
          <div style="font-size:13px;color:#94a3b8">Date: ${(rec.createdAt||"").slice(0,10)||new Date().toISOString().slice(0,10)}</div>
          ${orderName?`<div style="font-size:13px;color:#94a3b8">Order: ${orderName}</div>`:""}
        </div>
      </div>
      <div style="padding:28px 40px;display:grid;grid-template-columns:1fr 1fr;gap:24px;border-bottom:1px solid #f1f5f9">
        <div>
          <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Bill To</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a">${rec.bookerName||"(see email)"}</div>
          <div style="font-size:13px;color:#475569">${rec.bookerEmail||""}</div>
          ${rec.bookerAddress?`<div style="font-size:12px;color:#475569;margin-top:4px;white-space:pre-line">${rec.bookerAddress}</div>`:""}
          ${rec.bookerGst?`<div style="font-size:12px;color:#94a3b8;margin-top:2px">GST: ${rec.bookerGst}</div>`:""}
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Period</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a">${periodStr}</div>
        </div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <thead><tr style="background:#f8fafc">
          <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #f1f5f9">Description</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #f1f5f9">Detail</th>
          <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #f1f5f9">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>${gstRows}</tfoot>
      </table>
      <div style="padding:20px 40px 32px;font-size:12px;color:#94a3b8;text-align:center">
        ${AMUA_INFO.bank?`Bank: ${AMUA_INFO.bank} · `:""}Generated by FacilityBook${rec.status==="draft"?" · DRAFT":""}
      </div>
    </div></body></html>`;
  }
  function downloadRecord(rec, format, docType, detail) {
    const lines = detail==="individual" ? (rec.individualLines||rec.lines||[]) : (rec.lines||[]);
    const docTag = docType==="purchase_order" ? "PO" : "Invoice";
    const orderTag = rec.orderName ? ` - ${rec.orderName.replace(/[^\w- ]+/g,"")}` : "";
    const baseName = `AMUA ${docTag}${orderTag} - ${(rec.dateFrom||"").replace(/-/g,"")}-${(rec.dateTo||"").replace(/-/g,"")}${detail==="individual"?" - itemised":""}`;
    if (format==="csv") {
      const esc = v => `"${String(v||"").replace(/"/g,'""')}"`;
      const rowsCsv = lines.map(l=>[(docType==="purchase_order"?rec.poId:rec.id)||"", rec.bookerName||"", rec.bookerEmail||"", l.desc||l.description||l.label||"", l.detail||"", Number(l.cost||0).toFixed(2)].map(esc).join(","));
      rowsCsv.push(["","","","","Subtotal",Number(rec.subtotal||0).toFixed(2)].map(esc).join(","));
      rowsCsv.push(["","","","","GST (15%)",Number(rec.gst||0).toFixed(2)].map(esc).join(","));
      rowsCsv.push(["","","","","Total",Number(rec.total||0).toFixed(2)].map(esc).join(","));
      const csv = [[docType==="purchase_order"?"Purchase Order":"Invoice","Name","Email","Description","Detail","Amount"].map(esc).join(","), ...rowsCsv].join("\n");
      const blob = new Blob([csv],{type:"text/csv"});
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href=url; a.download=`${baseName}.csv`; a.click();
      URL.revokeObjectURL(url);
      return;
    }
    const html = buildRecordHtml(rec, docType, lines);
    const win = window.open("","_blank");
    if (win) {
      win.document.write(html); win.document.close();
      if (format==="print") { win.focus(); win.print(); }
    }
  }

  const stateInfo = key => PIPELINE_STATES.find(s=>s.key===key) || { label: key, color:"#94a3b8" };

  function StatusPill({ status }) {
    const s = stateInfo(status);
    return <span style={{display:"inline-block",padding:"2px 8px",borderRadius:999,fontSize:11,fontWeight:700,background:s.color+"22",color:s.color,border:`1px solid ${s.color}55`}}>{s.label}</span>;
  }

  function ProgressTrack({ status }) {
    const idx = PIPELINE_KEYS.indexOf(status);
    return (
      <div style={{display:"flex",alignItems:"center",gap:0,marginBottom:10}}>
        {PIPELINE_STATES.map((s,i)=>{
          const done = i < idx, active = i === idx;
          return (
            <Fragment key={s.key}>
              {i>0&&<div style={{flex:1,height:2,background:done?"#22c55e":"#e2e8f0"}}/>}
              <div title={s.description} style={{width:14,height:14,borderRadius:"50%",background:done?"#22c55e":active?s.color:"#e2e8f0",border:`2px solid ${done?"#22c55e":active?s.color:"#cbd5e1"}`,flexShrink:0}}/>
            </Fragment>
          );
        })}
      </div>
    );
  }

  // Reusable expanded detail panel for any billing record
  function renderRecordExpanded(rec) {
    const isPO = rec.type==="purchase_order" || rec.bookerEmail==="gtec";
    const isInv = !isPO;
    return (
      <div style={{borderTop:"1px solid #f1f5f9",padding:"14px 16px",background:"#fafafa"}}>
        <ProgressTrack status={rec.status||"draft"}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:"10px 20px",marginBottom:14}}>
          {[
            ["Booker", isPO ? (rec.bookerName||VENDOR_GTEC.name) : displayName(rec.bookerEmail)],
            ["Booker Address", rec.bookerAddress||"—"],
            ["Booker GST", rec.bookerGst||"—"],
            ["Created", rec.createdAt?new Date(rec.createdAt).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—"],
            ["Subtotal", fmtMoney(rec.subtotal)],
            ["GST", fmtMoney(rec.gst)],
            ["Total", fmtMoney(rec.total)],
          ].map(([k,v])=>(
            <div key={k}>
              <div style={{fontSize:10,fontWeight:600,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em"}}>{k}</div>
              <div style={{fontSize:12,color:"#0f172a",whiteSpace:"pre-wrap"}}>{v}</div>
            </div>
          ))}
        </div>
        {isAdmin&&(
          <div style={{display:"flex",flexDirection:"column",gap:8,padding:"10px 0",borderTop:"1px solid #e2e8f0"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#475569",marginBottom:2}}>Pipeline Actions</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
              {PIPELINE_KEYS.indexOf(rec.status||"draft") < PIPELINE_KEYS.length-1&&(
                <button onClick={()=>{
                  const next = PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")+1];
                  onUpdateRecord({id:rec.id,status:next});
                }} style={{padding:"5px 12px",borderRadius:8,border:"none",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit",background:"#0f172a",color:"#fff"}}>
                  → Mark as {stateInfo(PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")+1]).label}
                  {(rec.status||"draft")==="draft"&&isInv&&<span style={{fontWeight:400,marginLeft:4,opacity:0.7}}>(marks {(rec.bookingIds||[]).length} bookings invoiced)</span>}
                </button>
              )}
              {PIPELINE_KEYS.indexOf(rec.status||"draft") > 0&&(
                <button onClick={()=>{
                  const prev = PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")-1];
                  onUpdateRecord({id:rec.id,status:prev});
                }} style={{padding:"5px 12px",borderRadius:8,border:"1px solid #e2e8f0",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",background:"#fff",color:"#64748b"}}>
                  ← Revert to {stateInfo(PIPELINE_KEYS[PIPELINE_KEYS.indexOf(rec.status||"draft")-1]).label}
                </button>
              )}
              {(rec.status||"draft")==="draft" && onDeleteRecord && (
                <button onClick={()=>{
                  if(window.confirm(`Delete draft record ${rec.id}? This cannot be undone.`)) onDeleteRecord(rec.id);
                }} style={{padding:"5px 12px",borderRadius:8,border:"1px solid #fecaca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit",background:"#fef2f2",color:"#b91c1c",marginLeft:"auto"}}>
                  🗑 Delete draft
                </button>
              )}
            </div>
            {["gtec_invoiced","club_invoiced","complete"].includes(rec.status)&&(
              <div style={{display:"flex",alignItems:"center",gap:8,marginTop:4}}>
                <span style={{fontSize:11,color:"#475569",flexShrink:0}}>GTEC Invoice #:</span>
                <input value={rec.gtecInvoiceNumber||""} onChange={e=>onUpdateRecord({id:rec.id,gtecInvoiceNumber:e.target.value})}
                  placeholder="e.g. GTEC-2026-001"
                  style={{padding:"4px 8px",borderRadius:6,border:"1px solid #e2e8f0",fontSize:11,fontFamily:"inherit",width:160}}/>
              </div>
            )}
            <div style={{display:"flex",alignItems:"flex-start",gap:8,marginTop:4}}>
              <span style={{fontSize:11,color:"#475569",flexShrink:0,paddingTop:4}}>Notes:</span>
              <textarea value={rec.notes||""} onChange={e=>onUpdateRecord({id:rec.id,notes:e.target.value})}
                rows={2} placeholder="Internal notes…"
                style={{padding:"4px 8px",borderRadius:6,border:"1px solid #e2e8f0",fontSize:11,fontFamily:"inherit",flex:1,resize:"vertical"}}/>
            </div>
          </div>
        )}
        <div style={{display:"flex",flexDirection:"column",gap:6,padding:"10px 0",borderTop:"1px solid #e2e8f0"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#475569"}}>📥 Download Documents</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
            {[
              {dt:"invoice", id:rec.id, show:!isPO},
              {dt:"purchase_order", id:rec.id, show:isPO},
            ].filter(x=>x.show).map(({dt,id})=>(
              <div key={dt} style={{display:"flex",gap:0,border:"1px solid #e2e8f0",borderRadius:8,overflow:"hidden",alignItems:"stretch"}}>
                <span style={{padding:"5px 10px",fontSize:11,fontWeight:700,color:"#475569",background:"#f8fafc",borderRight:"1px solid #e2e8f0",display:"flex",alignItems:"center",gap:4}}>
                  {dt==="purchase_order"?"📋 PO":"🧾 Invoice"} <span style={{fontFamily:"monospace",fontSize:10,color:"#94a3b8"}}>{id}</span>
                </span>
                {[{fmt:"html",label:"HTML",icon:"🌐"},{fmt:"print",label:"PDF",icon:"🖨"},{fmt:"csv",label:"CSV",icon:"📊"}].map(({fmt,label,icon})=>(
                  <button key={fmt} onClick={()=>downloadRecord(rec,fmt,dt,exportMode)}
                    title={`${exportMode==="individual"?"Itemised":"Grouped"} ${label}`}
                    style={{padding:"5px 9px",border:"none",borderLeft:"1px solid #f1f5f9",background:"#fff",cursor:"pointer",fontSize:11,fontWeight:600,color:"#0f172a",fontFamily:"inherit"}}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
        {((exportMode==="individual"?(rec.individualLines||rec.lines):rec.lines)||[]).length>0&&(
          <div style={{marginTop:10}}>
            <div style={{fontSize:11,fontWeight:700,color:"#475569",marginBottom:4}}>Invoice Lines ({exportMode==="individual"?"Itemised — per booking":"Summary — grouped"})</div>
            <CopyableTable>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
              <thead>
                <tr style={{background:"#f8fafc"}}>
                  {["Description","Detail","Amount"].map(h=>(
                    <th key={h} style={{padding:"4px 8px",textAlign:h==="Amount"?"right":"left",fontWeight:700,color:"#64748b",borderBottom:"1px solid #e2e8f0"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(exportMode==="individual"?(rec.individualLines||rec.lines):rec.lines).map((l,i)=>(
                  <tr key={i} style={{borderBottom:"1px solid #f1f5f9"}}>
                    <td style={{padding:"4px 8px",color:"#0f172a"}}>{l.desc||l.description||l.label||"—"}</td>
                    <td style={{padding:"4px 8px",color:"#64748b"}}>{l.detail||"—"}</td>
                    <td style={{padding:"4px 8px",textAlign:"right",fontWeight:600,color:"#0f172a"}}>{l.cost!=null?`$${Number(l.cost).toFixed(2)}`:"—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </CopyableTable>
          </div>
        )}
      </div>
    );
  }

  // Render a single ungrouped billing record row
  function renderSingleRecord(rec) {
    const isExpanded = expandedId === rec.id;
    const isPO = rec.type==="purchase_order" || rec.bookerEmail==="gtec";
    const isInv = !isPO;
    const typeTag = isPO
      ? <span style={{fontFamily:"monospace",fontSize:10,background:"#dbeafe",padding:"1px 6px",borderRadius:4,color:"#1d4ed8",fontWeight:700}}>PO</span>
      : <span style={{fontFamily:"monospace",fontSize:10,background:"#e0f2fe",padding:"1px 6px",borderRadius:4,color:"#0369a1",fontWeight:700}}>INV</span>;
    return (
      <div key={rec.id} style={{background:"#fff",border:`1px solid ${isPO?"#bfdbfe":"#e2e8f0"}`,borderRadius:12,overflow:"hidden",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        <div onClick={()=>setExpandedId(isExpanded?null:rec.id)}
          style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",cursor:"pointer",userSelect:"none",flexWrap:"wrap"}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              {typeTag}
              <span style={{fontSize:12,fontWeight:800,color:"#0f172a",fontFamily:"monospace"}}>{rec.id}</span>
              {rec.orderName&&<span style={{fontSize:11,color:"#475569",fontWeight:600}}>{rec.orderName}</span>}
            </div>
            <div style={{fontSize:11,color:"#64748b",marginTop:2}}>
              {isPO ? <strong style={{color:"#1d4ed8"}}>{rec.bookerName||VENDOR_GTEC.name}</strong> : displayName(rec.bookerEmail)}
              {" · "}{fmtDate(rec.dateFrom)}{rec.dateTo&&rec.dateTo!==rec.dateFrom?` – ${fmtDate(rec.dateTo)}`:""}
              {" · "}{(rec.bookingIds||[]).length} booking{(rec.bookingIds||[]).length!==1?"s":""}
              {(rec.status||"draft")==="draft"&&isInv&&<span style={{marginLeft:6,fontSize:10,color:"#94a3b8",fontStyle:"italic"}}>bookings marked invoiced on advance</span>}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <span style={{fontSize:13,fontWeight:700,color:"#0f172a"}}>{fmtMoney(rec.total)}</span>
            <StatusPill status={rec.status||"draft"}/>
            {onLoadToSummary&&(
              <button onClick={e=>{e.stopPropagation();onLoadToSummary(rec);}}
                title="Load this record's date range + booker into the Summary view"
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #c7d2fe",background:"#eef2ff",color:"#4338ca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                ↗ Summary
              </button>
            )}
            <span style={{fontSize:10,color:"#94a3b8"}}>{isExpanded?"▲":"▼"}</span>
          </div>
        </div>
        {isExpanded&&renderRecordExpanded(rec)}
      </div>
    );
  }

  // Render a batch group card (INV×N + PO×1 created together)
  function renderBatchGroup(batch) {
    const isGroupExpanded = expandedBatchId === batch.batchId;
    const activeSubRec = isGroupExpanded
      ? (batch.records.find(r=>r.id===expandedSubId) || batch.records[0])
      : null;
    return (
      <div key={batch.batchId} style={{background:"#fff",border:"2px solid #e0e7ff",borderRadius:14,overflow:"hidden",boxShadow:"0 2px 8px rgba(99,102,241,0.08)"}}>
        {/* Batch header */}
        <div onClick={()=>{ setExpandedBatchId(isGroupExpanded?null:batch.batchId); if(!isGroupExpanded) setExpandedSubId(batch.records[0]?.id||null); }}
          style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",cursor:"pointer",userSelect:"none",flexWrap:"wrap",background:"#f5f3ff"}}>
          <div style={{minWidth:0,flex:1}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={{fontFamily:"monospace",fontSize:10,background:"#6366f1",padding:"2px 7px",borderRadius:4,color:"#fff",fontWeight:700,letterSpacing:"0.04em"}}>BATCH</span>
              {batch.orderName&&<span style={{fontSize:12,fontWeight:800,color:"#312e81"}}>{batch.orderName}</span>}
              <span style={{fontSize:11,color:"#6366f1",fontWeight:600}}>{batch.invRecs.length} invoice{batch.invRecs.length!==1?"s":""} + {batch.poRec?"1 PO":"no PO"}</span>
            </div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:3,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
              <span>{fmtDate(batch.dateFrom)}{batch.dateTo&&batch.dateTo!==batch.dateFrom?` – ${fmtDate(batch.dateTo)}`:""}</span>
              <span style={{color:"#c4b5fd"}}>·</span>
              <span style={{color:"#475569"}}>{new Date(batch.createdAt).toLocaleDateString("en-NZ",{day:"numeric",month:"short",year:"numeric"})}</span>
            </div>
            {/* Sub-record chips — display order: PO → INVs. Click name expands; ↓ icon downloads */}
            <div style={{display:"flex",gap:5,flexWrap:"wrap",marginTop:6}}>
              {batch.records.map(r=>{
                const isPOChip = r.type==="purchase_order";
                const active = activeSubRec?.id===r.id;
                const tone = isPOChip
                  ? { borderActive:"#1d4ed8", borderIdle:"#bfdbfe", bgActive:"#1d4ed8", bgIdle:"#dbeafe", fgActive:"#fff", fgIdle:"#1d4ed8" }
                  : { borderActive:"#4f46e5", borderIdle:"#c7d2fe", bgActive:"#4f46e5", bgIdle:"#eef2ff", fgActive:"#fff", fgIdle:"#4338ca" };
                const dt = isPOChip ? "purchase_order" : "invoice";
                const label = isPOChip ? "PO · GTEC" : `INV · ${displayName(r.bookerEmail)}`;
                return (
                  <div key={r.id} style={{display:"inline-flex",borderRadius:6,overflow:"hidden",border:`1.5px solid ${active?tone.borderActive:tone.borderIdle}`}}>
                    <button onClick={e=>{e.stopPropagation();setExpandedBatchId(batch.batchId);setExpandedSubId(r.id);}}
                      style={{padding:"3px 8px",border:"none",background:active?tone.bgActive:tone.bgIdle,color:active?tone.fgActive:tone.fgIdle,
                        cursor:"pointer",fontSize:10,fontWeight:700,fontFamily:"monospace"}}>
                      {label} <span style={{opacity:0.7,fontWeight:400}}>{r.id}</span>
                    </button>
                    <button onClick={e=>{e.stopPropagation();downloadRecord(r,"html",dt,exportMode);}}
                      title={`Download ${exportMode} HTML`}
                      style={{padding:"3px 7px",border:"none",borderLeft:`1px solid ${active?tone.borderActive:tone.borderIdle}`,
                        background:active?tone.bgActive:tone.bgIdle,color:active?tone.fgActive:tone.fgIdle,cursor:"pointer",fontSize:11}}>
                      ↓
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
            <span style={{fontSize:13,fontWeight:700,color:"#312e81"}}>{fmtMoney(batch.total)}</span>
            <StatusPill status={batch.status}/>
            <button onClick={e=>{e.stopPropagation();
              batch.records.forEach(r=>{
                const dt = r.type==="purchase_order"?"purchase_order":"invoice";
                downloadRecord(r,"html",dt,exportMode);
              });
            }} title={`Open HTML for all ${batch.records.length} records (${exportMode})`}
              style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #c4b5fd",background:"#ede9fe",color:"#6d28d9",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
              📥 Download all
            </button>
            {onLoadToSummary&&(
              <button onClick={e=>{e.stopPropagation();onLoadToSummary({
                dateFrom: batch.dateFrom, dateTo: batch.dateTo,
                emails: batch.invRecs.map(r=>r.bookerEmail).filter(Boolean),
              });}}
                title={`Load date range + all ${batch.invRecs.length} bookers into Summary`}
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #c7d2fe",background:"#eef2ff",color:"#4338ca",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                ↗ Summary
              </button>
            )}
            {isAdmin&&batch.allDraft&&onDeleteRecord&&(
              <button onClick={e=>{e.stopPropagation();if(window.confirm(`Delete all ${batch.records.length} draft records in this batch? This cannot be undone.`)) batch.records.forEach(r=>onDeleteRecord(r.id));}}
                style={{padding:"3px 9px",borderRadius:6,border:"1.5px solid #fecaca",background:"#fef2f2",color:"#b91c1c",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
                🗑 Delete batch
              </button>
            )}
            <span style={{fontSize:10,color:"#94a3b8"}}>{isGroupExpanded?"▲":"▼"}</span>
          </div>
        </div>
        {/* Expanded: sub-record detail */}
        {isGroupExpanded&&activeSubRec&&(
          <div>
            <div style={{padding:"6px 16px 0",background:"#faf5ff",borderTop:"1px solid #e0e7ff",display:"flex",gap:5,flexWrap:"wrap"}}>
              {batch.records.map(r=>(
                <button key={r.id} onClick={()=>setExpandedSubId(r.id)}
                  style={{padding:"4px 10px",borderRadius:"6px 6px 0 0",border:"1px solid",borderBottom:"none",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"monospace",
                    borderColor:expandedSubId===r.id?"#6366f1":"#c4b5fd",
                    background:expandedSubId===r.id?"#fff":"#ede9fe",
                    color:expandedSubId===r.id?"#4f46e5":"#7c3aed"}}>
                  {r.type==="purchase_order"?"PO":"INV"} {r.id}
                  <StatusPill status={r.status||"draft"}/>
                </button>
              ))}
            </div>
            {renderRecordExpanded(activeSubRec)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <span style={{fontSize:15,fontWeight:800,color:"#0f172a",whiteSpace:"nowrap"}}>🧾 Billing Records</span>
        <div style={{marginLeft:"auto",display:"flex",gap:4,flexWrap:"nowrap",overflowX:"auto",scrollbarWidth:"none",maxWidth:"100%"}}>
          {[{k:"all",l:"All"}, ...PIPELINE_STATES].map(s=>{
            const key = s.k||s.key;
            const label = s.l || SHORT_STATUS[s.key] || s.label;
            const active = filterStatus===key;
            return (
              <button key={key} onClick={()=>setFilterStatus(key)} title={s.description||s.label||s.l}
                style={{padding:"3px 9px",borderRadius:14,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",whiteSpace:"nowrap",flexShrink:0,
                  borderColor:active?"#0f172a":"#e2e8f0",background:active?"#0f172a":"#fff",color:active?"#fff":"#64748b"}}>
                {label}
              </button>
            );
          })}
        </div>
      </div>
      {/* View mode + export mode */}
      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12,padding:"6px 10px",background:"#f8fafc",borderRadius:8,fontSize:11,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{color:"#64748b",fontWeight:600,whiteSpace:"nowrap"}}>View:</span>
          {[{k:"grouped",l:"Grouped"},{k:"individual",l:"Individual"}].map(opt=>(
            <button key={opt.k} onClick={()=>setViewMode(opt.k)}
              title={opt.k==="grouped"?"Batch INV+PO sets shown as one card":"Every record shown as its own row"}
              style={{padding:"3px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",
                borderColor:viewMode===opt.k?"#0f172a":"#e2e8f0",background:viewMode===opt.k?"#0f172a":"#fff",color:viewMode===opt.k?"#fff":"#475569"}}>
              {opt.l}
            </button>
          ))}
        </div>
        <div style={{width:1,height:18,background:"#e2e8f0",flexShrink:0}}/>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <span style={{color:"#64748b",fontWeight:600,whiteSpace:"nowrap"}}>Export:</span>
          {[{k:"grouped",l:"Summary"},{k:"individual",l:"Itemised"}].map(opt=>(
            <button key={opt.k} onClick={()=>setExportMode(opt.k)}
              title={opt.k==="grouped"?"One line per booking pattern":"One line per individual booking"}
              style={{padding:"3px 10px",borderRadius:6,border:"1px solid",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit",
                borderColor:exportMode===opt.k?"#4338ca":"#e2e8f0",background:exportMode===opt.k?"#4338ca":"#fff",color:exportMode===opt.k?"#fff":"#475569"}}>
              {opt.l}
            </button>
          ))}
        </div>
      </div>

      {batches.length===0&&ungrouped.length===0&&(
        <div style={{textAlign:"center",padding:48,color:"#94a3b8",fontSize:14}}>No billing records{filterStatus!=="all"?` with status "${stateInfo(filterStatus).label}"`:""}.</div>
      )}

      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {viewMode==="grouped"
          ? <>{batches.map(batch=>renderBatchGroup(batch))}{ungrouped.map(rec=>renderSingleRecord(rec))}</>
          : sorted.map(rec=>renderSingleRecord(rec))
        }
      </div>
    </div>
  );
}

// ─── Pricing conditions ─────────────────────────────────────────────────────
// A condition pins a booker's rate for one facility over a date range. All
// conditions are stored even when they overlap/conflict; at price time the
// applicable one is chosen by priority — invoice-locked first, then newest.
// Each condition may override the day rate, the evening rate, or both.
// { id, bookerEmail, facilityId, period:"day"|"evening"|"both",
//   dayRate, eveningRate, dateFrom, dateTo, locked, source, createdAt }
function defaultFacRates(facilityRates, facId) {
  const r = (facilityRates || {})[facId];
  if (!r) return { day: 0, evening: 50 };
  if (typeof r === "object") return { day: r.day ?? 0, evening: r.evening ?? 50 };
  return { day: parseFloat(r) || 0, evening: 50 }; // backward compat (number = day rate)
}
// A rule targets one or more bookers and facilities. New rules store arrays
// (bookerEmails/facilityIds); legacy rules and invoice-locked snapshots store the
// singular bookerEmail/facilityId — both are normalised here.
function condBookerList(c)   { return (c.bookerEmails && c.bookerEmails.length) ? c.bookerEmails : (c.bookerEmail ? [c.bookerEmail] : []); }
function condFacilityList(c) { return (c.facilityIds  && c.facilityIds.length)  ? c.facilityIds  : (c.facilityId  ? [c.facilityId]  : []); }
function matchingConditions(conditions, facId, bookerEmail, dateStr) {
  const be = (bookerEmail || "").toLowerCase();
  return (conditions || []).filter(c => {
    if (!c) return false;
    const facs = condFacilityList(c);
    const bkrs = condBookerList(c).map(x => (x || "").toLowerCase());
    return facs.includes(facId) && bkrs.includes(be) &&
      (!c.dateFrom || !dateStr || dateStr >= c.dateFrom) &&
      (!c.dateTo   || !dateStr || dateStr <= c.dateTo);
  });
}
// Effective {day,evening} for a booker+facility+date: the global rate, then any
// matching conditions overlaid lowest-priority first so the winner applies last
// (order: non-locked oldest → newest → locked).
function resolveRates(facilityRates, conditions, facId, bookerEmail, dateStr) {
  const base = defaultFacRates(facilityRates, facId);
  const matches = matchingConditions(conditions, facId, bookerEmail, dateStr);
  if (!matches.length) return base;
  const sorted = [...matches].sort((a, b) => {
    const ra = a.locked ? 1 : 0, rb = b.locked ? 1 : 0;
    if (ra !== rb) return ra - rb;                                  // locked last → wins
    return (a.createdAt || "").localeCompare(b.createdAt || "");    // newest last → wins
  });
  let { day, evening } = base;
  for (const c of sorted) {
    if (c.dayRate != null && c.dayRate !== "")         day = Number(c.dayRate);
    if (c.eveningRate != null && c.eveningRate !== "") evening = Number(c.eveningRate);
  }
  return { day, evening };
}

// Add / edit / list pricing rules. Self-contained (manages its own form state) so it
// can be dropped into both the Summary tab and the Admin view. A rule targets any
// number of bookers and facilities, a period (day/evening/both) and a date range.
function PricingConditionsManager({ conditions = [], bookers = [], onAdd, onUpdate, onRemove, aliasFor }) {
  const [showForm, setShowForm] = useState(false);
  const [editId,   setEditId]   = useState(null);
  const [bkrSel,   setBkrSel]   = useState([]); // lowercased emails
  const [facSel,   setFacSel]   = useState([]); // facility ids
  const [period,   setPeriod]   = useState("both");
  const [dayRate,  setDayRate]  = useState("");
  const [eveRate,  setEveRate]  = useState("");
  const [from,     setFrom]     = useState("");
  const [to,       setTo]       = useState("");

  const inp      = {padding:"4px 7px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",outline:"none"};
  const lblBlock = {fontSize:10,fontWeight:700,color:"#64748b",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4};
  const lblInline= {fontSize:11,color:"#64748b",display:"flex",alignItems:"center",gap:3};
  const facName  = id => FACILITIES.find(f=>f.id===id)?.name || id;
  const label    = em => (aliasFor && aliasFor(em)) || bookers.find(b=>b.email===em)?.label || em;

  const reset   = ()=>{ setEditId(null); setBkrSel([]); setFacSel([]); setPeriod("both"); setDayRate(""); setEveRate(""); setFrom(""); setTo(""); setShowForm(false); };
  const openAdd = ()=>{ reset(); setShowForm(true); };
  const openEdit= c =>{
    setEditId(c.id);
    setBkrSel(condBookerList(c).map(e=>(e||"").toLowerCase()));
    setFacSel(condFacilityList(c));
    setPeriod(c.period||"both");
    setDayRate(c.dayRate??""); setEveRate(c.eveningRate??"");
    setFrom(c.dateFrom||""); setTo(c.dateTo||"");
    setShowForm(true);
  };
  const toggle  = (arr,setArr,v)=> setArr(arr.includes(v)?arr.filter(x=>x!==v):[...arr,v]);
  const canSave = bkrSel.length && facSel.length && from && to &&
    (period==="day" ? dayRate!=="" : period==="evening" ? eveRate!=="" : (dayRate!==""||eveRate!==""));
  const save = ()=>{
    if(!canSave) return;
    const payload = {
      bookerEmails: bkrSel.map(e=>e.toLowerCase()),
      facilityIds:  facSel,
      period,
      dayRate:     period==="evening" ? null : (dayRate===""?null:Number(dayRate)),
      eveningRate: period==="day"     ? null : (eveRate===""?null:Number(eveRate)),
      dateFrom: from, dateTo: to,
    };
    if(editId) onUpdate && onUpdate(editId, { ...payload, bookerEmail:undefined, facilityId:undefined });
    else       onAdd    && onAdd({ id:newId(), ...payload, locked:false, source:"manual", createdAt:new Date().toISOString() });
    reset();
  };
  const chip = (active,onClick,children,activeBg="#4338ca",activeFg="#fff") => (
    <button type="button" onClick={onClick} style={{fontFamily:"inherit",fontSize:11,fontWeight:active?700:500,cursor:"pointer",borderRadius:999,padding:"2px 9px",border:`1.5px solid ${active?activeBg:"#cbd5e1"}`,background:active?activeBg:"#fff",color:active?activeFg:"#475569"}}>{children}</button>
  );
  const sorted = [...conditions].sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  return (
    <div style={{background:"#fff",border:"1.5px solid #e0e7ff",borderRadius:12,padding:14}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:(sorted.length||showForm)?10:0,flexWrap:"wrap"}}>
        <span style={{fontSize:13,fontWeight:700,color:"#4338ca"}}>⚙ Pricing rules</span>
        <span style={{fontSize:11,color:"#94a3b8"}}>booker rate overrides — beat the global rate within their dates</span>
        {onAdd&&<button onClick={()=>showForm?reset():openAdd()} style={{marginLeft:"auto",...S.btn({border:"1.5px solid #c7d2fe",background:showForm?"#eef2ff":"#fff",color:"#4338ca",fontSize:12})}}>{showForm&&!editId?"Close":"＋ Add rule"}</button>}
      </div>
      {showForm && (
        <div style={{display:"flex",flexDirection:"column",gap:8,background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 12px",marginBottom:sorted.length?12:0}}>
          {editId&&<div style={{fontSize:11,fontWeight:700,color:"#4338ca"}}>✎ Editing rule</div>}
          <div>
            <div style={lblBlock}>Bookers <span style={{color:"#94a3b8",fontWeight:500}}>· pick one or more</span></div>
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {bookers.length===0&&<span style={{fontSize:11,color:"#94a3b8"}}>No bookers found.</span>}
              {bookers.map(b=><Fragment key={b.email}>{chip(bkrSel.includes(b.email),()=>toggle(bkrSel,setBkrSel,b.email),b.label)}</Fragment>)}
            </div>
          </div>
          <div>
            <div style={lblBlock}>Facilities <span style={{color:"#94a3b8",fontWeight:500}}>· pick one or more</span></div>
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
              {FACILITIES.map(f=><Fragment key={f.id}>{chip(facSel.includes(f.id),()=>toggle(facSel,setFacSel,f.id),f.name,f.color,"#fff")}</Fragment>)}
            </div>
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center"}}>
            <select value={period} onChange={e=>setPeriod(e.target.value)} style={inp}>
              <option value="both">Day + Evening</option><option value="day">Day only</option><option value="evening">Evening only</option>
            </select>
            {period!=="evening"&&<label style={lblInline}>Day $<input type="number" min="0" step="0.5" value={dayRate} onChange={e=>setDayRate(e.target.value)} style={{...inp,width:64,textAlign:"right"}}/>/hr</label>}
            {period!=="day"&&<label style={lblInline}>Eve $<input type="number" min="0" step="0.5" value={eveRate} onChange={e=>setEveRate(e.target.value)} style={{...inp,width:64,textAlign:"right"}}/>/hr</label>}
            <label style={lblInline}>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)} style={inp}/></label>
            <label style={lblInline}>To<input type="date" value={to} onChange={e=>setTo(e.target.value)} style={inp}/></label>
            <button onClick={save} disabled={!canSave} style={{...S.btn({border:"none",background:canSave?"#4338ca":"#cbd5e1",color:"#fff",fontSize:12,fontWeight:700}),cursor:canSave?"pointer":"not-allowed"}}>{editId?"Save":"Add"}</button>
            {editId&&<button onClick={reset} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#64748b",fontSize:12})}>Cancel</button>}
          </div>
        </div>
      )}
      {sorted.length>0 ? (
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          {sorted.map(c=>{
            const bkrs=condBookerList(c), facs=condFacilityList(c);
            return (
              <div key={c.id} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",fontSize:12,background:c.locked?"#f5f3ff":"#f8fafc",border:`1px solid ${c.locked?"#ddd6fe":"#e2e8f0"}`,borderRadius:7,padding:"5px 10px"}}>
                {c.locked&&<span title={c.source||"invoice snapshot"}>🔒</span>}
                <span style={{fontWeight:700,color:"#0f172a"}}>{bkrs.map(label).join(", ")||"—"}</span>
                <span style={{color:"#64748b"}}>· {facs.map(facName).join(", ")||"—"}</span>
                <span style={{color:"#334155"}}>· {c.dayRate!=null?`day ${fmtCost(c.dayRate)}`:""}{(c.dayRate!=null&&c.eveningRate!=null)?" / ":""}{c.eveningRate!=null?`eve ${fmtCost(c.eveningRate)}`:""}/hr</span>
                <span style={{color:"#94a3b8"}}>· {c.dateFrom} → {c.dateTo}</span>
                {c.locked&&<span style={{fontSize:10,color:"#7c3aed"}}>{c.source}</span>}
                <span style={{marginLeft:"auto",display:"flex",gap:6}}>
                  {onUpdate&&<button onClick={()=>openEdit(c)} title="Edit rule" style={{border:"none",background:"transparent",color:"#4338ca",cursor:"pointer",fontSize:13,fontWeight:700}}>✎</button>}
                  {onRemove&&<button onClick={()=>onRemove(c.id)} title="Remove rule" style={{border:"none",background:"transparent",color:"#ef4444",cursor:"pointer",fontSize:13,fontWeight:700}}>✕</button>}
                </span>
              </div>
            );
          })}
        </div>
      ) : !showForm && <div style={{fontSize:12,color:"#94a3b8"}}>No pricing rules yet. Add one to override the global rate for chosen bookers, facilities and dates.</div>}
    </div>
  );
}

function SummaryTab({ bookings, loggedInEmail, facilityRates = {}, pricingConditions = [], onAddPricingCondition, onUpdatePricingCondition, onRemovePricingCondition, isAdmin = false, approxPlayers = {}, onUpdateApproxPlayers, approxDurations = {}, onUpdateApproxDuration, onUpdateFacilityRate, pricingMode = "hourly", onSetPricingMode, onProposeMerge, onBulkApply, onMarkInvoiced, onMarkAdjustmentSettled, bookerFilter=new Set(), profiles={}, emailAliases={}, aliasNames={}, onCreateOfficialInvoice, onFilterChange=null, loadRequest=null }) {
  const now = new Date();
  const thisYear = now.getFullYear();

  // Date range state: preset key + optional custom from/to
  const [preset,      setPreset]      = useState("this_year");
  const [summaryIncludeInvoiced, setSummaryIncludeInvoiced] = useState(true); // show invoiced bookings in summary totals
  const [customFrom,  setCustomFrom]  = useState("");
  const [customTo,    setCustomTo]    = useState("");
  // Multi-select booker filter — Set of lowercased emails. Empty Set = all bookers.
  const [emailFilterSet, setEmailFilterSet] = useState(()=>{
    if (bookerFilter.size>0) return new Set([...bookerFilter].map(e=>e.toLowerCase()));
    return loggedInEmail ? new Set([loggedInEmail.toLowerCase()]) : new Set();
  });
  // Keep in sync with the global header booker pills (parent → child only; avoid loop via content comparison).
  useEffect(()=>{
    const next = new Set([...bookerFilter].map(e=>e.toLowerCase()));
    setEmailFilterSet(prev=>{
      if(prev.size!==next.size) return next;
      for(const e of next) if(!prev.has(e)) return next;
      return prev;
    });
  },[bookerFilter]);
  const toggleEmailFilter = em => {
    setEmailFilterSet(prev=>{
      const s=new Set(prev); const lk=em.toLowerCase();
      if(s.has(lk)) s.delete(lk); else s.add(lk);
      if(onFilterChange) onFilterChange(new Set(s));
      return s;
    });
  };
  // Honour load-from-billing requests: switch to custom preset and stamp the
  // record's date range. Tracked by version so re-loading the same record works.
  const lastLoadVersionRef = useRef(null);
  useEffect(()=>{
    if (!loadRequest || loadRequest.version===lastLoadVersionRef.current) return;
    lastLoadVersionRef.current = loadRequest.version;
    setPreset("custom");
    setCustomFrom(loadRequest.dateFrom||"");
    setCustomTo(loadRequest.dateTo||"");
  },[loadRequest]);

  // Invoice modal state
  const [showInvoice, setShowInvoice] = useState(false);
  const [showRatesEdit, setShowRatesEdit] = useState(false);
  // "Add pricing condition" form
  // (pricing-rule form state now lives inside <PricingConditionsManager/>)
  // Inline player-count editing: email being edited
  const [editingPlayers,  setEditingPlayers]  = useState(null);
  const [playersInput,    setPlayersInput]    = useState("");
  // Inline duration editing
  const [editingDuration, setEditingDuration] = useState(null);
  const [durationInput,   setDurationInput]   = useState("");
  // Per-email expansion in the Hire Usage table — shows individual bookings under the row
  const [expandedBookers, setExpandedBookers] = useState(new Set());
  function toggleBookerExpand(em) {
    setExpandedBookers(prev => {
      const s = new Set(prev); const k = em.toLowerCase();
      if (s.has(k)) s.delete(k); else s.add(k);
      return s;
    });
  }
  const [invMode,     setInvMode]     = useState("draft");            // "draft" | "official"
  const [invDetail,   setInvDetail]   = useState("grouped");        // "grouped" | "individual"
  const [invGst,      setInvGst]      = useState("inclusive");       // "inclusive" | "exclusive" | "note"
  const [invScope,    setInvScope]    = useState("combined");         // "combined" | "per_booker"
  const [invDocType,  setInvDocType]  = useState("invoice");          // "invoice" | "purchase_order"
  const [invName,     setInvName]     = useState("");                  // free-text label baked into the file name
  const [invOrderName, setInvOrderName] = useState("");               // official: order/project name (required)
  const [invMarkInvoiced, setInvMarkInvoiced] = useState(false);       // flag exported bookings as invoiced
  const [invIncludeInvoiced, setInvIncludeInvoiced] = useState(true); // include previously-invoiced bookings (default on — summary always shows them)
  const [invIncludeAdjustments, setInvIncludeAdjustments] = useState(true); // include mismatch billing adjustments
  const [invSelectedEmails, setInvSelectedEmails] = useState(new Set()); // empty = all
  // Schedule Summary state
  const [scheduleFacSensitive,setScheduleFacSensitive]= useState(false);
  const [sandboxMode,         setSandboxMode]         = useState(false);
  const [sandboxSelected,     setSandboxSelected]     = useState(new Set());
  const [previewMerge,        setPreviewMerge]        = useState(false);
  const [patternModal, setPatternModal] = useState(null);
  const [oneOffModal, setOneOffModal] = useState(null);
  const [mergeTarget, setMergeTarget] = useState(null);
  const [mergeResolution, setMergeResolution] = useState({});
  const [committedResolution, setCommittedResolution] = useState({});
  const [committedTarget, setCommittedTarget] = useState(null);

  function presetRange(key) {
    const y = thisYear;
    const pad = n => String(n).padStart(2,"0");
    const ymd = (yr,m,d) => `${yr}-${pad(m)}-${pad(d)}`;
    switch(key) {
      case "this_year":   return { from: ymd(y,1,1),   to: ymd(y,12,31) };
      case "last_year":   return { from: ymd(y-1,1,1), to: ymd(y-1,12,31) };
      case "last_6mo": {
        const d = new Date(now); d.setMonth(d.getMonth()-6);
        return { from: d.toISOString().slice(0,10), to: now.toISOString().slice(0,10) };
      }
      case "last_3mo": {
        const d = new Date(now); d.setMonth(d.getMonth()-3);
        return { from: d.toISOString().slice(0,10), to: now.toISOString().slice(0,10) };
      }
      case "all":         return { from: "", to: "" };
      default:            return { from: customFrom, to: customTo };
    }
  }

  const { from: dateFrom, to: dateTo } = preset === "custom" ? { from: customFrom, to: customTo } : presetRange(preset);

  const PRESETS = [
    { key:"this_year", label:`${thisYear}` },
    { key:"last_year", label:`${thisYear-1}` },
    { key:"last_6mo",  label:"6 months" },
    { key:"last_3mo",  label:"3 months" },
    { key:"all",       label:"All time" },
    { key:"custom",    label:"Custom" },
  ];

  // Rebuild color cache for all emails in the dataset so chips render correctly
  bookings.forEach(b => emailColor(b.email));

  const allEmails = [...new Set(bookings.filter(b=>!isAdminBooking(b)).map(b=>b.email).filter(Boolean))].sort();

  // Prune email filter entries that no longer match any booker in the dataset
  useEffect(()=>{
    if(emailFilterSet.size===0||!allEmails.length) return;
    const present=new Set(allEmails.map(e=>e.toLowerCase()));
    const pruned=[...emailFilterSet].filter(e=>present.has(e));
    if(pruned.length!==emailFilterSet.size) setEmailFilterSet(new Set(pruned));
  },[allEmails,emailFilterSet]);

  const active = bookings.filter(b => {
    if (isAdminBooking(b)) return false;
    if (["cancelled","rejected"].includes(b.status)) return false;
    if (b.invoiced && !summaryIncludeInvoiced) return false;
    if (dateFrom && b.date < dateFrom) return false;
    if (dateTo   && b.date > dateTo)   return false;
    if (emailFilterSet.size>0 && !emailFilterSet.has(b.email?.toLowerCase())) return false;
    return true;
  });

  // Pool for invoice popup — mirrors the summary view's filter (date + booker)
  // so what appears in the popup matches what the user sees in the summary.
  // invSelectedEmails further sub-filters within this pool.
  const activeForInvoice = bookings.filter(b => {
    if (isAdminBooking(b)) return false;
    if (["cancelled","rejected"].includes(b.status)) return false;
    if (b.invoiced && !invIncludeInvoiced) return false;
    if (emailFilterSet.size>0 && !emailFilterSet.has(b.email?.toLowerCase())) return false;
    if (dateFrom && b.date < dateFrom) return false;
    if (dateTo   && b.date > dateTo)   return false;
    return true;
  });
  // Bookings with a pending mismatch billing adjustment (credit or invoice owed).
  const mismatchAdjustments = bookings.filter(b => {
    if (isAdminBooking(b) || !b.invoiced) return false;
    const res = parseCpsaResolution(b.system_notes);
    if (!res) return false;
    return res.billingState === "credit_pending" || res.billingState === "invoice_pending";
  });
  const bookerNameMap = {};
  bookings.filter(b=>!isAdminBooking(b)&&b.email).forEach(b=>{ bookerNameMap[b.email.toLowerCase()]=b.name; });
  const allInvoiceEmails = [...new Set(activeForInvoice.map(b=>b.email).filter(Boolean))].sort();

  const EVENING_CUTOFF = 17.5; // 5:30pm

  function splitHours(b) {
    const end = b.start_hour + b.duration;
    if (b.start_hour >= EVENING_CUTOFF) return { day: 0, evening: b.duration };
    if (end > EVENING_CUTOFF) return { day: EVENING_CUTOFF - b.start_hour, evening: end - EVENING_CUTOFF };
    return { day: b.duration, evening: 0 };
  }

  function getFacRates(facId, bookerEmail, dateStr) {
    if (bookerEmail) return resolveRates(facilityRates, pricingConditions, facId, bookerEmail, dateStr);
    return defaultFacRates(facilityRates, facId);
  }
  const bRates = b => getFacRates(b.facility_id, b.email, b.date);

  const isPerBooking = pricingMode === "per_booking";

  function getApproxDuration(email) {
    const v = approxDurations[email.toLowerCase()];
    return (v && v > 0) ? v : 2;
  }

  function summaryAlias(em) {
    if (!em) return em;
    const primary = (emailAliases[em.toLowerCase()] || em).toLowerCase();
    return (aliasNames||{})[primary] || primary.split("@")[0];
  }

  // Categorize a booking as "day" or "evening" by which side of 5:30 pm has
  // the larger portion. Evening wins on ties.
  function categoryOf(b) {
    const { day, evening } = splitHours(b);
    return evening >= day ? "evening" : "day";
  }

  // In per-booking mode cost = approxDuration × the rate for the booking's
  // category (day/evening, decided by majority split). In hourly mode the
  // booking is split at 5:30 pm between day and evening rates.
  function getBookingCost(b) {
    const rates = bRates(b);
    if (isPerBooking) {
      const rate = categoryOf(b) === "evening" ? rates.evening : rates.day;
      return getApproxDuration(b.email) * rate;
    }
    const { day, evening } = splitHours(b);
    return day * rates.day + evening * rates.evening;
  }

  // Per-email aggregation (over filtered active bookings)
  const byEmail = {};
  active.forEach(b => {
    const key = b.email.toLowerCase();
    if (!byEmail[key]) byEmail[key] = { email:b.email, name:b.name, daytime:0, evening:0, total:0, bookings:0, dayBkgs:0, eveBkgs:0, cost:0, dayCost:0, eveCost:0 };
    const rec = byEmail[key];
    const { day, evening } = splitHours(b);
    const rates = bRates(b);
    rec.evening  += evening;
    rec.daytime  += day;
    rec.total    += b.duration;
    rec.bookings += 1;
    if (categoryOf(b) === "evening") rec.eveBkgs += 1; else rec.dayBkgs += 1;
    if (!isPerBooking) {
      rec.dayCost  += day * rates.day;
      rec.eveCost  += evening * rates.evening;
    }
    rec.cost += getBookingCost(b);
  });

  // Per-booking adjustment delta (uses billed snapshot from system_notes when present).
  // +ve = additional invoice owed (booker undercharged); -ve = credit owed (booker overcharged).
  function bookingAdjustment(b) {
    const snap = parseBilledSnapshot(b.system_notes, b.notes);
    if (!snap) return 0;
    const orig = { ...b, facility_id:snap.facility_id, start_hour:snap.start_hour, duration:snap.duration };
    const od = splitHours(orig), nd = splitHours(b);
    const or = getFacRates(snap.facility_id, b.email, b.date), nr = bRates(b);
    return (nd.day*nr.day + nd.evening*nr.evening) - (od.day*or.day + od.evening*or.evening);
  }
  // Pending credit (will be discounted from next invoice) — negative number.
  // billing_state is the source of truth: credit_pending always treated as a credit
  // regardless of the raw delta sign.
  function bookingPendingCredit(b) {
    const res = parseCpsaResolution(b.system_notes);
    if (res?.billingState !== "credit_pending") return 0;
    return -Math.abs(bookingAdjustment(b));
  }
  // Pending deficit (will be added to next invoice) — positive number.
  function bookingPendingDeficit(b) {
    const res = parseCpsaResolution(b.system_notes);
    if (res?.billingState !== "invoice_pending") return 0;
    return Math.abs(bookingAdjustment(b));
  }
  // Bookings per booker, sorted by date
  const bkgsByEmail = {};
  active.forEach(b => {
    const k = b.email.toLowerCase();
    if (!bkgsByEmail[k]) bkgsByEmail[k] = [];
    bkgsByEmail[k].push(b);
  });
  Object.values(bkgsByEmail).forEach(arr => arr.sort((a,b)=>a.date.localeCompare(b.date)||a.start_hour-b.start_hour));
  // Adjustment totals per booker — split pending credits (auto-discounted from
  // next invoice) from pending deficits (still owed); the legacy `adjustment`
  // field stays in sync with the displayed Adj column = deficits only.
  Object.values(byEmail).forEach(rec => {
    const list = bkgsByEmail[rec.email.toLowerCase()] || [];
    rec.pendingCredit  = list.reduce((s,b)=>s+bookingPendingCredit(b),  0); // ≤ 0
    rec.pendingDeficit = list.reduce((s,b)=>s+bookingPendingDeficit(b), 0); // ≥ 0
    rec.adjustment     = rec.pendingDeficit; // Adj column = only deficits owed
  });
  const rows          = Object.values(byEmail).sort((a,b)=>b.total-a.total);
  const totalEvening  = rows.reduce((s,r)=>s+r.evening,0);
  const totalDaytime  = rows.reduce((s,r)=>s+r.daytime,0);
  const totalHrs      = rows.reduce((s,r)=>s+r.total,0);
  const totalDayBkgs  = rows.reduce((s,r)=>s+r.dayBkgs,0);
  const totalEveBkgs  = rows.reduce((s,r)=>s+r.eveBkgs,0);
  const totalDayCost    = rows.reduce((s,r)=>s+r.dayCost,0);
  const totalEveCost    = rows.reduce((s,r)=>s+r.eveCost,0);

  // Per-facility cost (adapts to pricing mode) — always includes ALL facilities
  const byFacility = {};
  FACILITIES.forEach(fac => { byFacility[fac.id] = { fac, dayHrs: 0, eveningHrs: 0, bkgCount: 0, cost: 0 }; });
  active.forEach(b => {
    const fac = FACILITIES.find(x => x.id === b.facility_id);
    if (!fac) return;
    const { day, evening } = splitHours(b);
    byFacility[fac.id].dayHrs     += day;
    byFacility[fac.id].eveningHrs += evening;
    byFacility[fac.id].bkgCount   += 1;
    byFacility[fac.id].cost       += getBookingCost(b);
  });
  const facCosts = Object.values(byFacility).map(({ fac, dayHrs, eveningHrs, bkgCount, cost }) => {
    const rates = getFacRates(fac.id);
    return { fac, dayHrs, eveningHrs, hours: dayHrs + eveningHrs, bkgCount, rates, cost };
  });
  const totalCost = facCosts.reduce((s, c) => s + c.cost, 0);
  const anyRates  = FACILITIES.some(f => { const r = getFacRates(f.id); return r.day > 0 || r.evening > 0; });

  function fmtHrs(h) { return h===0?"0h" : h%1===0?`${h}h`:`${Math.floor(h)}h ${Math.round((h%1)*60)}m`; }
  function getPlayers(email) { return approxPlayers[email.toLowerCase()] || 0; }
  function canEditPlayers(email) { return isAdmin || (loggedInEmail && email.toLowerCase() === loggedInEmail.toLowerCase()); }
  function canEditDuration(email) { return isAdmin || (loggedInEmail && email.toLowerCase() === loggedInEmail.toLowerCase()); }

  // ── Invoice helpers ──────────────────────────────────────────────────────
  function buildInvoiceLines(bkgs, detail) {
    if (detail === "grouped") {
      const groups = {};
      bkgs.forEach(b => {
        const { day, evening } = splitHours(b);
        const rates = bRates(b);
        const fac = FACILITIES.find(f => f.id === b.facility_id);
        const facName = fac?.name || b.facility_id;
        if (day > 0) {
          const key = b.facility_id + ":day";
          if (!groups[key]) groups[key] = { desc:`${facName} – Daytime`, hours:0, rate:rates.day, cost:0 };
          groups[key].hours += day; groups[key].cost += day * rates.day;
        }
        if (evening > 0) {
          const key = b.facility_id + ":evening";
          if (!groups[key]) groups[key] = { desc:`${facName} – Evening`, hours:0, rate:rates.evening, cost:0 };
          groups[key].hours += evening; groups[key].cost += evening * rates.evening;
        }
      });
      return Object.values(groups).map(g => ({
        desc:  g.desc,
        detail:`${fmtHrs(g.hours)} @ ${fmtCost(g.rate)}/hr`,
        cost:  g.cost,
      }));
    } else {
      return bkgs.map(b => {
        const { day, evening } = splitHours(b);
        const rates = bRates(b);
        const fac = FACILITIES.find(f => f.id === b.facility_id);
        const cost = day * rates.day + evening * rates.evening;
        const timeStr = `${fmtTime(b.start_hour)}–${fmtTime(b.start_hour + b.duration)}`;
        const splitNote = day>0&&evening>0 ? ` (${fmtHrs(day)} day + ${fmtHrs(evening)} eve)` : "";
        return {
          desc:   `${fmtDate(b.date)} · ${fac?.name||b.facility_id} · ${timeStr}`,
          detail: `${b.purpose}${splitNote}`,
          cost,
        };
      }).sort((a,b)=>a.desc.localeCompare(b.desc));
    }
  }

  // Build adjustment line items for mismatch-amended invoiced bookings.
  // Cost sign reflects billing_state (credit_pending → negative; invoice_pending → positive),
  // not the raw delta. Magnitude comes from the snapshot↔current delta.
  function buildAdjustmentLines(adjustmentBkgs) {
    return adjustmentBkgs.flatMap(b => {
      const snap = parseBilledSnapshot(b.system_notes, b.notes);
      if (!snap) return [];
      const orig = { ...b, facility_id:snap.facility_id, start_hour:snap.start_hour, duration:snap.duration };
      const origDay = splitHours(orig), currDay = splitHours(b);
      const origRates = getFacRates(snap.facility_id, b.email, b.date), currRates = bRates(b);
      const origCost = origDay.day*origRates.day + origDay.evening*origRates.evening;
      const currCost = currDay.day*currRates.day + currDay.evening*currRates.evening;
      const rawDelta = currCost - origCost;
      if (rawDelta === 0) return [];
      const res = parseCpsaResolution(b.system_notes);
      const bs = res?.billingState || "";
      // Source of truth: billing_state. Credits are always negative, deficits always positive.
      const signedCost = bs === "credit_pending" || bs === "credited"
        ? -Math.abs(rawDelta)
        : Math.abs(rawDelta);
      const fac = FACILITIES.find(f=>f.id===b.facility_id);
      const timeStr = `${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`;
      const origTimeStr = `${fmtTime(snap.start_hour)}–${fmtTime(snap.start_hour+snap.duration)}`;
      return [{
        desc:    `[${signedCost>0?"Invoice adj.":"Credit adj."}] ${fmtDate(b.date)} · ${fac?.name||b.facility_id}`,
        detail:  `GTEC amendment: billed ${origTimeStr} ${snap.duration}h → amended ${timeStr} ${b.duration}h (${bs||"pending"})`,
        cost:    signedCost,
        isAdj:   true,
      }];
    });
  }

  function gstAmounts(subtotal, gstMode) {
    if (gstMode === "exclusive") {
      const gst = subtotal * 0.15;
      return { pre: subtotal, gst, total: subtotal + gst };
    }
    // inclusive: rates already include GST
    const gst = subtotal - subtotal / 1.15;
    return { pre: subtotal / 1.15, gst, total: subtotal };
  }

  function buildInvoiceHtml({ bookerName, bookerEmail, lines, gstMode, dateRange, invNumber, docType="invoice", docName="" }) {
    const docLabel = docType === "purchase_order" ? "PURCHASE ORDER" : "INVOICE";
    const subtotal = lines.reduce((s, l) => s + l.cost, 0);
    const { pre, gst, total } = gstAmounts(subtotal, gstMode);
    const gstLabel = gstMode === "note" ? "" : gstMode === "exclusive" ? "excl. GST" : "incl. GST";
    const periodStr = dateRange.from && dateRange.to ? `${fmtDate(dateRange.from)} – ${fmtDate(dateRange.to)}` : "All periods";
    const rowsHtml = lines.map(l => `
      <tr>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a">${l.desc}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b">${l.detail}</td>
        <td style="padding:10px 16px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#0f172a;text-align:right;white-space:nowrap">${fmtCost(l.cost)}</td>
      </tr>`).join("");
    const gstRows = gstMode === "note"
      ? `<tr><td colspan="2" style="padding:8px 16px;font-size:12px;color:#64748b;text-align:right">GST inclusive</td><td style="padding:8px 16px;font-size:13px;font-weight:700;color:#0f172a;text-align:right">${fmtCost(total)}</td></tr>`
      : `<tr style="background:#f8fafc"><td colspan="2" style="padding:8px 16px;font-size:12px;color:#64748b;text-align:right">Subtotal (${gstLabel})</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;text-align:right">${fmtCost(pre)}</td></tr>
         <tr style="background:#f8fafc"><td colspan="2" style="padding:8px 16px;font-size:12px;color:#64748b;text-align:right">GST (15%)</td><td style="padding:8px 16px;font-size:13px;color:#0f172a;text-align:right">${fmtCost(gst)}</td></tr>
         <tr style="background:#f0fdf4"><td colspan="2" style="padding:10px 16px;font-size:14px;font-weight:700;color:#0f172a;text-align:right">Total</td><td style="padding:10px 16px;font-size:16px;font-weight:800;color:#15803d;text-align:right">${fmtCost(total)}</td></tr>`;
    const amuaLines = [AMUA_INFO.address, AMUA_INFO.gstNumber ? `GST No: ${AMUA_INFO.gstNumber}` : "", AMUA_INFO.bank].filter(Boolean).map(l=>`<div>${l}</div>`).join("");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${docName || `${docLabel} ${invNumber}`}</title><style>
      @media print { body{margin:0} }
      body{font-family:'Segoe UI',sans-serif;background:#f8fafc;margin:0;padding:32px 16px}
      .page{max-width:700px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 32px rgba(0,0,0,0.08)}
    </style></head><body>
    <div class="page">
      <div style="background:#0f172a;padding:32px 40px;display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px">
        <div>
          <div style="font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.02em">${AMUA_INFO.name}</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:4px">${amuaLines||"<span style='color:#64748b'>Update AMUA_INFO in booking-system.jsx</span>"}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:28px;font-weight:800;color:#fff">${docLabel}</div>
          <div style="font-size:13px;color:#94a3b8;margin-top:4px">#${invNumber}</div>
          <div style="font-size:13px;color:#94a3b8">Date: ${todayKey()}</div>
        </div>
      </div>
      <div style="padding:28px 40px;display:grid;grid-template-columns:1fr 1fr;gap:24px;border-bottom:1px solid #f1f5f9">
        <div>
          <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Bill To</div>
          <div style="font-size:15px;font-weight:700;color:#0f172a">${bookerName||"(see email)"}</div>
          <div style="font-size:13px;color:#475569">${bookerEmail}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Period</div>
          <div style="font-size:14px;font-weight:600;color:#0f172a">${periodStr}</div>
        </div>
      </div>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <thead><tr style="background:#f8fafc">
          <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #f1f5f9">Description</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #f1f5f9">Detail</th>
          <th style="padding:10px 16px;text-align:right;font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;border-bottom:2px solid #f1f5f9">Amount</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>${gstRows}</tfoot>
      </table>
      <div style="padding:20px 40px 32px;font-size:12px;color:#94a3b8;text-align:center">
        ${AMUA_INFO.bank ? `Bank: ${AMUA_INFO.bank} · ` : ""}Generated by FacilityBook
      </div>
    </div></body></html>`;
  }

  // "AMUA PO - Pilot - 20260527-20260630" — label comes from the free-text name field;
  // date range falls back to the min/max booking dates when no preset range is set.
  function invoiceBaseName(bkgsForInvoice) {
    const dates = bkgsForInvoice.map(b=>b.date).filter(Boolean).sort();
    const fromD = (dateFrom || dates[0] || todayKey()).replace(/-/g,"");
    const toD   = (dateTo   || dates[dates.length-1] || todayKey()).replace(/-/g,"");
    const docTag = invDocType === "purchase_order" ? "PO" : "Invoice";
    const label = (invName||"").trim();
    return `AMUA ${docTag}${label?` - ${label}`:""} - ${fromD}-${toD}`;
  }

  function exportInvoice(format, bkgsForInvoice, bookerName, bookerEmail) {
    const adjBkgs = invIncludeAdjustments
      ? mismatchAdjustments.filter(b => b.email?.toLowerCase() === bookerEmail?.toLowerCase())
      : [];
    const lines = [
      ...buildInvoiceLines(bkgsForInvoice, invDetail),
      ...buildAdjustmentLines(adjBkgs),
    ];
    const dateRange = { from: dateFrom, to: dateTo };
    const baseName = invoiceBaseName(bkgsForInvoice);
    const invNumber = `${todayKey().replace(/-/g,"")}-${bookerEmail.replace(/[^a-z0-9]/gi,"").slice(0,6).toUpperCase()}`;
    const html = buildInvoiceHtml({ bookerName, bookerEmail, lines, gstMode: invGst, dateRange, invNumber, docType: invDocType, docName: baseName });
    if (invMarkInvoiced && onMarkInvoiced) onMarkInvoiced(bkgsForInvoice);
    if (format === "html" || format === "print") {
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(html);
        win.document.close();
        if (format === "print") { win.focus(); win.print(); }
      }
    } else if (format === "csv") {
      const subtotal = lines.reduce((s, l) => s + l.cost, 0);
      const { pre, gst, total } = gstAmounts(subtotal, invGst);
      const esc = v => `"${String(v||"").replace(/"/g,'""')}"`;
      const docLabel = invDocType === "purchase_order" ? "Purchase Order" : "Invoice";
      const csvRows = lines.map(l => [invNumber, bookerName, bookerEmail, l.desc, l.detail, l.cost.toFixed(2)].map(esc).join(","));
      csvRows.push(["","","","","Subtotal",pre.toFixed(2)].map(esc).join(","));
      csvRows.push(["","","","","GST (15%)",gst.toFixed(2)].map(esc).join(","));
      csvRows.push(["","","","","Total",total.toFixed(2)].map(esc).join(","));
      const csv = [[docLabel,"Name","Email","Description","Detail","Amount"].map(esc).join(","), ...csvRows].join("\n");
      const blob = new Blob([csv], { type:"text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href=url; a.download=`${baseName}.csv`; a.click();
      URL.revokeObjectURL(url);
    }
  }

  function openInvoice() {
    // The pool is already filtered by summary's emailFilterSet, so leave
    // invSelectedEmails empty (= "All from the visible pool") by default.
    // The chip list in the popup is the union of summary's filter; selecting
    // a specific booker further narrows it.
    setInvSelectedEmails(new Set());
    setShowInvoice(true);
  }

  // Build official invoice record (no side-effects) for one scope (one booker).
  // Appends any pending credit adjustments as negative line items so they are
  // discounted from the booker's next invoice automatically.
  function buildInvoiceRecord(scope, allRecs) {
    const invId = generateDocId(allRecs.filter(r=>r.id?.startsWith("INV-")), "INV");
    const canonKey = (emailAliases[scope.email] || scope.email).toLowerCase();
    const prof = (profiles||{})[canonKey] || {};
    const groupedLines    = buildInvoiceLines(scope.bkgs, "grouped");
    const individualLines = buildInvoiceLines(scope.bkgs, "individual");

    // Pending credits for this booker — negative lines that discount the total
    const creditBkgs = bookings.filter(b => {
      if (b.email?.toLowerCase() !== scope.email.toLowerCase()) return false;
      const res = parseCpsaResolution(b.system_notes);
      return res?.billingState === "credit_pending";
    });
    const creditLines = buildAdjustmentLines(creditBkgs).filter(l => l.cost < 0).map(l => ({
      ...l,
      desc: l.desc.replace("[Credit adj.]","[Credit]"),
      isCreditAdj: true,
    }));

    const allGroupedLines = [...groupedLines, ...creditLines];
    const subtotal = allGroupedLines.reduce((s,l)=>s+l.cost, 0);
    const { pre, gst, total } = gstAmounts(subtotal, invGst);
    const dates = scope.bkgs.map(b=>b.date).filter(Boolean).sort();
    return {
      id: invId,
      type: "invoice",
      orderName: invOrderName || "",
      createdAt: new Date().toISOString(),
      dateFrom: dateFrom || dates[0] || todayKey(),
      dateTo:   dateTo   || dates[dates.length-1] || todayKey(),
      bookerEmail: scope.email,
      bookerName:  prof.fullName || (aliasNames||{})[canonKey] || scope.email.split("@")[0],
      bookerAddress: prof.address || "",
      bookerGst:   prof.gstNumber || "",
      bookingIds:  scope.bkgs.map(b=>b.id),
      creditBookingIds: creditBkgs.map(b=>b.id),
      lines: allGroupedLines,
      individualLines: [...individualLines, ...creditLines],
      subtotal: pre, gst, total, gstMode: invGst,
      status: "draft",
      gtecInvoiceNumber: "",
      notes: "",
    };
  }

  // Build one combined PO record (AMUA → GTEC) covering all booker scopes.
  // Lines are one entry per booker showing their subtotal; references invoice IDs.
  function buildGtecPoRecord(scopes, invoiceRecords, allRecs) {
    const poId = generateDocId(allRecs.filter(r=>r.id?.startsWith("PO-")), "PO");
    const allBkgsFlat = scopes.flatMap(s=>s.bkgs);
    const allDates = allBkgsFlat.map(b=>b.date).filter(Boolean).sort();
    const poLines = scopes.map(scope=>{
      const canonKey = (emailAliases[scope.email] || scope.email).toLowerCase();
      const prof = (profiles||{})[canonKey] || {};
      const name = prof.fullName || bookerNameMap[scope.email?.toLowerCase()] || scope.email?.split("@")[0] || "Unknown";
      const inv = invoiceRecords.find(r=>r.bookerEmail===scope.email);
      const subtotal = (inv?.lines||[]).reduce((s,l)=>s+l.cost,0);
      const { pre } = gstAmounts(subtotal, invGst);
      return { desc:`${name}`, detail: inv?.id||"", cost: pre };
    });
    // Simpler: just sum totals directly
    const sumTotal = invoiceRecords.reduce((s,r)=>s+(r.total||0),0);
    const sumSubtotal = invoiceRecords.reduce((s,r)=>s+(r.subtotal||0),0);
    const sumGst = invoiceRecords.reduce((s,r)=>s+(r.gst||0),0);
    return {
      id: poId,
      type: "purchase_order",
      orderName: invOrderName || "",
      createdAt: new Date().toISOString(),
      dateFrom: dateFrom || allDates[0] || todayKey(),
      dateTo:   dateTo   || allDates[allDates.length-1] || todayKey(),
      bookerEmail: "gtec",
      bookerName:  VENDOR_GTEC.name,
      bookerAddress: VENDOR_GTEC.address,
      bookerGst:   VENDOR_GTEC.gstNumber,
      bookingIds:  allBkgsFlat.map(b=>b.id),
      linkedInvoiceIds: invoiceRecords.map(r=>r.id),
      lines: poLines,
      individualLines: [],
      subtotal: sumSubtotal, gst: sumGst, total: sumTotal, gstMode: invGst,
      status: "draft",
      gtecInvoiceNumber: "",
      notes: "",
    };
  }

  // Full name from profiles for official invoices; falls back to booking name then alias
  function officialBookerName(email) {
    if (!email || email === "combined") return email || "All Bookers";
    const canon = (emailAliases[email.toLowerCase()] || email).toLowerCase();
    const prof = (profiles||{})[canon] || {};
    return prof.fullName || bookerNameMap[email.toLowerCase()] || email.split("@")[0];
  }

  // Groups active bookings by booker for combined/per-booker export
  function getInvoiceScopes() {
    const sel = [...invSelectedEmails];
    const pool = sel.length > 0
      ? activeForInvoice.filter(b => sel.some(e => b.email.toLowerCase() === e.toLowerCase()))
      : activeForInvoice;
    if (invScope === "combined" || sel.length <= 1) {
      const email = sel.length === 1 ? sel[0] : "combined";
      const name = sel.length === 1 ? (invMode==="official" ? officialBookerName(sel[0]) : bookerNameMap[sel[0].toLowerCase()] || sel[0]) : "All Bookers";
      return [{ name, email, bkgs: pool }];
    }
    return sel.map(e => ({
      name: invMode==="official" ? officialBookerName(e) : (bookerNameMap[e.toLowerCase()] || e),
      email: e,
      bkgs: pool.filter(b => b.email.toLowerCase() === e.toLowerCase()),
    }));
  }

  // CSV export — all columns from every booking (not filtered)
  function exportCSV() {
    const cols = ["id","name","email","phone","facility_id","facility_name","date","start_hour","start_time","duration","end_time","purpose","notes","status","created_at","updated_at"];
    const esc  = v => `"${String(v||"").replace(/"/g,'""')}"`;
    const rows = bookings.map(b => {
      const f=FACILITIES.find(x=>x.id===b.facility_id);
      return [b.id,b.name,b.email,b.phone||"",b.facility_id,f?.name||"",b.date,b.start_hour,fmtTime(b.start_hour),b.duration,fmtTime(b.start_hour+b.duration),b.purpose,b.notes||"",b.status,b.created_at,b.updated_at||""].map(esc).join(",");
    });
    const csv  = [cols.join(","),...rows].join("\n");
    const blob = new Blob([csv],{type:"text/csv"});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href=url; a.download=`facilitybook-export-${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  }

  const thS = { textAlign:"left", padding:"10px 14px", fontSize:11, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.06em", borderBottom:"2px solid #f1f5f9", whiteSpace:"nowrap" };
  const tdS = { padding:"10px 14px", fontSize:13, color:"#0f172a", borderBottom:"1px solid #f8fafc", verticalAlign:"middle" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      {/* Controls */}
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {/* Date range presets */}
        <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
          <span style={{ fontSize:12, fontWeight:600, color:"#64748b", marginRight:2 }}>Period:</span>
          {PRESETS.map(p=>(
            <button key={p.key} onClick={()=>setPreset(p.key)}
              style={{ padding:"5px 12px", borderRadius:8, border: preset===p.key?"1.5px solid #0f172a":"1.5px solid #e2e8f0",
                background: preset===p.key?"#0f172a":"#f8fafc", color: preset===p.key?"#fff":"#475569",
                fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
              {p.label}
            </button>
          ))}
          <label style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,fontSize:12,color:"#475569",cursor:"pointer",userSelect:"none"}} title="Include or exclude already-invoiced bookings in the summary totals">
            <input type="checkbox" checked={summaryIncludeInvoiced} onChange={e=>setSummaryIncludeInvoiced(e.target.checked)} style={{accentColor:"#5b21b6"}}/>
            🧾 Include invoiced
          </label>
        </div>
        {/* Custom date range inputs */}
        {preset==="custom" && (
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ fontSize:12, fontWeight:600, color:"#64748b" }}>From:</span>
            <input type="date" value={customFrom} onChange={e=>setCustomFrom(e.target.value)}
              style={{ padding:"5px 10px", borderRadius:8, border:"1.5px solid #e2e8f0", fontSize:13, fontFamily:"inherit", background:"#f8fafc", color:"#0f172a", outline:"none" }}/>
            <span style={{ fontSize:12, fontWeight:600, color:"#64748b" }}>To:</span>
            <input type="date" value={customTo} onChange={e=>setCustomTo(e.target.value)}
              style={{ padding:"5px 10px", borderRadius:8, border:"1.5px solid #e2e8f0", fontSize:13, fontFamily:"inherit", background:"#f8fafc", color:"#0f172a", outline:"none" }}/>
          </div>
        )}
        {/* Booker filter chips — additive multi-select, mirrors global pills */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
          <button onClick={()=>{
            setEmailFilterSet(prev=>{
              const next=prev.size===0?new Set(allEmails.map(e=>e.toLowerCase())):new Set();
              if(onFilterChange) onFilterChange(new Set(next));
              return next;
            });
          }}
            title={emailFilterSet.size===0?"Select all bookers":"Clear selection"}
            style={{padding:"5px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,borderColor:emailFilterSet.size===0?"#0f172a":"#e2e8f0",background:emailFilterSet.size===0?"#0f172a":"#fff",color:emailFilterSet.size===0?"#fff":"#475569"}}>
            {emailFilterSet.size===0?"All":"None"}
          </button>
          {allEmails.map(e=>{
            const active=emailFilterSet.has(e.toLowerCase());
            const c=emailColor(e);
            return(
              <button key={e} onClick={()=>toggleEmailFilter(e)}
                style={{padding:"5px 12px",borderRadius:20,border:`1.5px solid ${active?c:"#e2e8f0"}`,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,background:active?c:"#fff",color:active?"#fff":"#475569"}}>
                {summaryAlias(e)}
              </button>
            );
          })}
          <div style={{marginLeft:"auto",display:"flex",gap:6}}>
            <button onClick={exportCSV} style={S.btn({ background:"#0f172a", color:"#fff", display:"flex", alignItems:"center", gap:6 })}>
              ⬇ Export All Data (CSV)
            </button>
            {anyRates && (
              <button onClick={openInvoice} style={S.btn({ background:"#15803d", color:"#fff", display:"flex", alignItems:"center", gap:6 })}>
                🧾 Export Invoice
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Pricing mode toggle */}
      <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
        <span style={{ fontSize:12, fontWeight:600, color:"#64748b" }}>Pricing:</span>
        {[
          { key:"hourly",      label:"⏱ Per Hour" },
          { key:"per_booking", label:"🎟 Per Booking" },
        ].map(opt=>(
          <button key={opt.key} onClick={()=>onSetPricingMode(opt.key)}
            style={{ padding:"5px 14px", borderRadius:8, fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"inherit",
              border: pricingMode===opt.key ? "1.5px solid #0f172a" : "1.5px solid #e2e8f0",
              background: pricingMode===opt.key ? "#0f172a" : "#f8fafc",
              color: pricingMode===opt.key ? "#fff" : "#475569" }}>
            {opt.label}
          </button>
        ))}
        <span style={{ fontSize:12, color:"#94a3b8" }}>
          {isPerBooking
            ? "Each booking = duration × the applicable hourly rate (day before 5:30 pm, evening after)"
            : "Hours are split at 5:30 pm between day and evening rates"}
        </span>
      </div>

      {/* KPI cards */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))", gap:12 }}>
        {[
          { label:"Bookings",      value:active.length,         icon:"📋" },
          { label:"Total Hours",   value:fmtHrs(totalHrs),      icon:"⏱" },
          { label:"Daytime Hrs",   value:fmtHrs(totalDaytime),  icon:"☀️",  sub:"before 5:30 PM" },
          { label:"Evening Hrs",   value:fmtHrs(totalEvening),  icon:"🌙",  sub:"from 5:30 PM" },
          { label:"Unique Bookers",value:rows.length,           icon:"👥" },
          ...(anyRates ? [{ label:"Total Cost", value:fmtCost(totalCost), icon:"💰", highlight:true }] : []),
        ].map(c=>(
          <div key={c.label} style={{ background: c.highlight?"#f0fdf4":"#fff", border:`1px solid ${c.highlight?"#bbf7d0":"#f1f5f9"}`, borderRadius:12, padding:"16px 18px", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <div style={{ fontSize:22, marginBottom:6 }}>{c.icon}</div>
            <div style={{ fontSize:22, fontWeight:800, color: c.highlight?"#15803d":"#0f172a", letterSpacing:"-0.03em" }}>{c.value}</div>
            <div style={{ fontSize:12, fontWeight:600, color:"#64748b", marginTop:2 }}>{c.label}</div>
            {c.sub&&<div style={{ fontSize:11, color:"#94a3b8" }}>{c.sub}</div>}
          </div>
        ))}
      </div>

      {/* Cost by facility tiles */}
      {(
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10, flexWrap:"wrap" }}>
            <h3 style={{ margin:0, fontSize:15, fontWeight:700, color:"#0f172a", flex:1 }}>
              Cost by Facility — {PRESETS.find(p=>p.key===preset)?.label}{dateFrom&&dateTo?` (${dateFrom} – ${dateTo})`:""}{emailFilterSet.size===1?` · ${[...emailFilterSet][0]}`:emailFilterSet.size>1?` · ${emailFilterSet.size} bookers`:""}
            </h3>
            {isAdmin && onUpdateFacilityRate && (
              <button onClick={()=>setShowRatesEdit(v=>!v)}
                style={S.btn({border:`1.5px solid ${showRatesEdit?"#6366f1":"#e2e8f0"}`,background:showRatesEdit?"#eef2ff":"#fff",color:showRatesEdit?"#4338ca":"#475569",fontSize:12})}>
                ✏ {showRatesEdit ? "Done" : "Edit Rates"}
              </button>
            )}
          </div>
          {showRatesEdit && isAdmin && onUpdateFacilityRate && (
            <div style={{ background:"#f8fafc", border:"1.5px solid #e0e7ff", borderRadius:12, padding:14, marginBottom:14 }}>
              <div style={{ fontSize:12, color:"#64748b", marginBottom:10 }}>Day rate = before 5:30 pm · Evening rate = 5:30 pm onwards</div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))", gap:10 }}>
                {FACILITIES.map(fac => {
                  const r = typeof facilityRates[fac.id]==="object" ? facilityRates[fac.id] : { day: facilityRates[fac.id]||0, evening: 50 };
                  const day = r.day ?? 0, evening = r.evening ?? 50;
                  const rateRow = (label, color, type, val) => (
                    <label style={{ display:"flex", alignItems:"center", gap:6 }}>
                      <span style={{ fontSize:11, fontWeight:600, color, flex:1, whiteSpace:"nowrap" }}>{label}</span>
                      <span style={{ fontSize:11, color:"#94a3b8" }}>$</span>
                      <input type="number" min="0" step="0.5" value={val||""} placeholder="0"
                        onChange={e=>onUpdateFacilityRate(fac.id,type,e.target.value)}
                        style={{ width:60, padding:"3px 6px", borderRadius:6, border:"1.5px solid #e2e8f0", fontSize:13, textAlign:"right", fontFamily:"inherit", outline:"none" }}/>
                      <span style={{ fontSize:11, color:"#94a3b8" }}>/hr</span>
                    </label>
                  );
                  return (
                    <div key={fac.id} style={{ background:"#fff", border:"1px solid #e2e8f0", borderRadius:10, padding:"10px 12px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
                        <span style={{ width:9, height:9, borderRadius:"50%", background:fac.color, flexShrink:0, display:"inline-block" }}/>
                        <span style={{ fontSize:12, fontWeight:700, color:"#0f172a", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{fac.name}</span>
                      </div>
                      <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                        {rateRow("Day", "#64748b", "day", day)}
                        {rateRow("Evening", "#7c3aed", "evening", evening)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {isAdmin && onAddPricingCondition && (
            <div style={{marginBottom:14}}>
              <PricingConditionsManager
                conditions={pricingConditions}
                bookers={[...new Map(allInvoiceEmails.map(em=>[em.toLowerCase(),{email:em.toLowerCase(),label:summaryAlias(em)}])).values()]}
                onAdd={onAddPricingCondition} onUpdate={onUpdatePricingCondition} onRemove={onRemovePricingCondition}
                aliasFor={summaryAlias}/>
            </div>
          )}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:10 }}>
            {facCosts.map(({ fac, dayHrs, eveningHrs, hours, bkgCount, rates, cost }) => {
              const hasRates = rates.day > 0 || rates.evening > 0;
              const isEmpty  = bkgCount === 0;
              return (
                <div key={fac.id} style={{ background: isEmpty?"#fafafa":"#fff", border:`1px solid ${isEmpty?"#f1f5f9":"#f1f5f9"}`, borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:6, boxShadow:"0 1px 4px rgba(0,0,0,0.04)", opacity: isEmpty ? 0.6 : 1 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                    <span style={{ width:10, height:10, borderRadius:"50%", background:fac.color, flexShrink:0, display:"inline-block" }}/>
                    <span style={{ fontSize:12, fontWeight:700, color:"#0f172a" }}>{fac.name}</span>
                  </div>
                  {isEmpty
                    ? <div style={{ fontSize:12, color:"#94a3b8" }}>0 bookings</div>
                    : isPerBooking
                      ? <div style={{ fontSize:12, color:"#64748b" }}>{bkgCount} booking{bkgCount!==1?"s":""} · {fmtHrs(hours)}</div>
                      : (<>
                          {dayHrs > 0 && <div style={{ fontSize:12, color:"#64748b" }}>Day: {fmtHrs(dayHrs)} {rates.day > 0 ? `@ ${fmtCost(rates.day)}/hr` : ""}</div>}
                          {eveningHrs > 0 && <div style={{ fontSize:12, color:"#64748b" }}>Eve: {fmtHrs(eveningHrs)} {rates.evening > 0 ? `@ ${fmtCost(rates.evening)}/hr` : ""}</div>}
                          {dayHrs === 0 && eveningHrs === 0 && <div style={{ fontSize:12, color:"#94a3b8" }}>{fmtHrs(hours)} total</div>}
                        </>)
                  }
                  <div style={{ fontSize:18, fontWeight:800, color: isEmpty ? "#94a3b8" : hasRates && cost > 0 ? "#15803d" : "#94a3b8" }}>
                    {isEmpty ? "—" : hasRates && cost > 0 ? fmtCost(cost) : "—"}
                  </div>
                  {!isEmpty && !hasRates && <div style={{ fontSize:11, color:"#94a3b8" }}>no rates set</div>}
                </div>
              );
            })}
            {anyRates && (
              <div style={{ background:"#f0fdf4", border:"1.5px solid #bbf7d0", borderRadius:12, padding:"14px 16px", display:"flex", flexDirection:"column", gap:6 }}>
                <div style={{ fontSize:12, fontWeight:700, color:"#166534" }}>Total Cost</div>
                <div style={{ fontSize:13, color:"#15803d" }}>{fmtHrs(totalHrs)} combined</div>
                <div style={{ fontSize:18, fontWeight:800, color:"#15803d" }}>{fmtCost(totalCost)}</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Table */}
      <div>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12, gap:8, flexWrap:"wrap" }}>
          <h3 style={{ margin:0, fontSize:15, fontWeight:700, color:"#0f172a" }}>
            Hire Usage &amp; Cost by Booker — {PRESETS.find(p=>p.key===preset)?.label}{dateFrom&&dateTo?` (${dateFrom} – ${dateTo})`:""}{emailFilterSet.size===1?` · ${[...emailFilterSet][0]}`:emailFilterSet.size>1?` · ${emailFilterSet.size} bookers`:""}
          </h3>
          {rows.length>0&&<button onClick={()=>{
            const esc = v => `"${String(v||"").replace(/"/g,'""')}"`;
            const hdrs = isPerBooking
              ? ["Booker","Email","Bookings","Day Bookings","Eve Bookings","Total Hrs (approx)",
                  ...(anyRates?["Total Cost"]:[]),
                  "Approx Players","Approx Duration (hrs)",
                  ...(anyRates?["Cost per Player"]:[])]
              : ["Booker","Email","Bookings","Daytime Hrs","Evening Hrs","Total Hrs",
                  ...(anyRates?["Day Cost","Eve Cost"]:[]),
                  ...(anyRates?["Total Cost"]:[]),
                  "Approx Players",
                  ...(anyRates?["Cost per Player"]:[])];
            const dataRows = rows.map(r=>{
              const players = getPlayers(r.email);
              const dur = getApproxDuration(r.email);
              const perPlayer = anyRates && players>0 && r.cost>0 ? r.cost/players : "";
              if (isPerBooking) {
                return [r.name,r.email,r.bookings,r.dayBkgs,r.eveBkgs,(r.bookings*dur).toFixed(2),
                  ...(anyRates?[r.cost.toFixed(2)]:[]),
                  players||"",dur,
                  ...(anyRates?[perPlayer?perPlayer.toFixed(2):""]:[])].map(esc).join(",");
              }
              return [r.name,r.email,r.bookings,r.daytime.toFixed(2),r.evening.toFixed(2),r.total.toFixed(2),
                ...(anyRates?[r.dayCost.toFixed(2),r.eveCost.toFixed(2)]:[]),
                ...(anyRates?[r.cost.toFixed(2)]:[]),
                players||"",
                ...(anyRates?[perPlayer?perPlayer.toFixed(2):""]:[])].map(esc).join(",");
            });
            const csv = [hdrs.map(esc).join(","), ...dataRows].join("\n");
            const blob = new Blob([csv],{type:"text/csv"});
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href=url; a.download=`summary-${dateFrom||"all"}.csv`; a.click();
            URL.revokeObjectURL(url);
          }} style={S.btn({background:"#0f172a",color:"#fff",fontSize:12,display:"flex",alignItems:"center",gap:5})}>
            ⬇ Export Table (CSV)
          </button>}
        </div>
        {rows.length===0
          ? <div style={{ textAlign:"center", padding:"32px 0", color:"#94a3b8", fontSize:14 }}>No active bookings match the current filter.</div>
          : (
            <div style={{ overflowX:"auto", borderRadius:12, border:"1px solid #f1f5f9" }}>
              <CopyableTable>
              <table style={{ width:"100%", borderCollapse:"collapse", background:"#fff" }}>
                <thead>
                  <tr style={{ background:"#f8fafc" }}>
                    <th style={{...thS,width:24,padding:"8px 4px"}}/>
                    <th style={thS}>Booker</th>
                    <th style={{ ...thS, textAlign:"right" }}>Bookings</th>
                    <th style={{ ...thS, textAlign:"right" }}>{isPerBooking ? "Day Bkgs" : "Daytime"}</th>
                    <th style={{ ...thS, textAlign:"right" }}>{isPerBooking ? "Eve Bkgs" : "Evening"}</th>
                    <th style={{ ...thS, textAlign:"right" }}>{isPerBooking ? "Total Hrs*" : "Total"}</th>
                    {anyRates&&!isPerBooking&&<th style={{ ...thS, textAlign:"right" }}>Day Cost</th>}
                    {anyRates&&!isPerBooking&&<th style={{ ...thS, textAlign:"right" }}>Eve Cost</th>}
                    {anyRates&&<th style={{ ...thS, textAlign:"right", color:"#15803d" }}>Total Cost</th>}
                    <th style={{ ...thS, textAlign:"right" }}>Players</th>
                    {isPerBooking&&<th style={{ ...thS, textAlign:"right", color:"#0369a1" }}>~Duration</th>}
                    {anyRates&&<th style={{ ...thS, textAlign:"right", color:"#7c3aed" }}>$/Player</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r=>{
                    const players = getPlayers(r.email);
                    const dur = getApproxDuration(r.email);
                    const durSaved = (approxDurations[r.email.toLowerCase()] || 0) > 0;
                    const canEditP = canEditPlayers(r.email);
                    const canEditD = canEditDuration(r.email);
                    const isEditingThis = editingPlayers === r.email.toLowerCase();
                    const isEditingDur  = editingDuration === r.email.toLowerCase();
                    const perPlayer = anyRates && players > 0 && r.cost > 0 ? r.cost / players : 0;
                    const isExpanded = expandedBookers.has(r.email.toLowerCase());
                    const bookerBkgs = bkgsByEmail[r.email.toLowerCase()] || [];
                    return (
                    <Fragment key={r.email}>
                    <tr onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <td style={{...tdS,padding:"6px 4px",textAlign:"center"}}>
                        <button onClick={()=>toggleBookerExpand(r.email)} title={isExpanded?"Hide individual bookings":"Show individual bookings"}
                          style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:"#94a3b8",padding:2,lineHeight:1,fontFamily:"inherit"}}>{isExpanded?"▼":"▶"}</button>
                      </td>
                      <td style={tdS}>
                        <span style={{display:"inline-block",padding:"3px 10px",borderRadius:12,background:emailColor(r.email),color:"#fff",fontSize:12,fontWeight:700}}>
                          {summaryAlias(r.email)}
                        </span>
                      </td>
                      <td style={{ ...tdS, textAlign:"right", fontWeight:600 }}>{r.bookings}</td>
                      <td style={{ ...tdS, textAlign:"right" }}>
                        {isPerBooking
                          ? <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:6, padding:"2px 8px", fontWeight:600, fontSize:12 }}>{r.dayBkgs}</span>
                          : <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:6, padding:"2px 8px", fontWeight:600, fontSize:12 }}>{fmtHrs(r.daytime)}</span>}
                      </td>
                      <td style={{ ...tdS, textAlign:"right" }}>
                        {isPerBooking
                          ? <span style={{ background:"#ede9fe", color:"#5b21b6", borderRadius:6, padding:"2px 8px", fontWeight:600, fontSize:12 }}>{r.eveBkgs}</span>
                          : <span style={{ background:"#ede9fe", color:"#5b21b6", borderRadius:6, padding:"2px 8px", fontWeight:600, fontSize:12 }}>{fmtHrs(r.evening)}</span>}
                      </td>
                      <td style={{ ...tdS, textAlign:"right", fontWeight:700 }}>
                        {isPerBooking ? fmtHrs(r.bookings * dur) : fmtHrs(r.total)}
                      </td>
                      {anyRates&&!isPerBooking&&<td style={{ ...tdS, textAlign:"right", fontWeight:600, color:r.dayCost>0?"#15803d":"#94a3b8" }}>{r.dayCost>0?fmtCost(r.dayCost):"—"}</td>}
                      {anyRates&&!isPerBooking&&<td style={{ ...tdS, textAlign:"right", fontWeight:600, color:r.eveCost>0?"#15803d":"#94a3b8" }}>{r.eveCost>0?fmtCost(r.eveCost):"—"}</td>}
                      {anyRates&&(()=>{
                        const netCost = r.cost + r.pendingCredit + r.pendingDeficit;
                        const hasCredit = r.pendingCredit < 0;
                        const hasDeficit = r.pendingDeficit > 0;
                        const tip = [
                          hasCredit?`− credit ${fmtCost(Math.abs(r.pendingCredit))}`:"",
                          hasDeficit?`+ deficit ${fmtCost(r.pendingDeficit)}`:"",
                        ].filter(Boolean).join(" ");
                        return (
                          <td style={{ ...tdS, textAlign:"right", fontWeight:700, color:netCost>0?"#15803d":"#94a3b8" }}
                              title={tip?`Cost ${fmtCost(r.cost)} ${tip} = ${fmtCost(netCost)}`:undefined}>
                            {netCost>0?fmtCost(netCost):"—"}
                            {hasCredit&&<div style={{fontSize:9,fontWeight:600,color:"#16a34a",marginTop:1}}>−{fmtCost(Math.abs(r.pendingCredit))} credit</div>}
                            {hasDeficit&&<div style={{fontSize:9,fontWeight:600,color:"#b45309",marginTop:1}}>+{fmtCost(r.pendingDeficit)} deficit</div>}
                          </td>
                        );
                      })()}
                      <td style={{ ...tdS, textAlign:"right" }}>
                        {isEditingThis ? (
                          <input
                            type="number" min="0" step="1"
                            value={playersInput}
                            onChange={e=>setPlayersInput(e.target.value)}
                            onBlur={()=>{ onUpdateApproxPlayers(r.email, playersInput); setEditingPlayers(null); }}
                            onKeyDown={e=>{ if(e.key==="Enter"||e.key==="Escape"){ onUpdateApproxPlayers(r.email, playersInput); setEditingPlayers(null); }}}
                            autoFocus
                            style={{ width:56, padding:"2px 6px", borderRadius:6, border:"1.5px solid #6366f1", fontSize:13, textAlign:"right", fontFamily:"inherit", outline:"none" }}
                          />
                        ) : (
                          <span
                            onClick={canEditP ? ()=>{ setEditingPlayers(r.email.toLowerCase()); setPlayersInput(String(players||"")); } : undefined}
                            title={canEditP ? "Click to edit" : undefined}
                            style={{ cursor:canEditP?"pointer":"default", padding:"2px 8px", borderRadius:6,
                              background: players>0?"#f0f9ff":"#f8fafc",
                              color: players>0?"#0369a1":"#94a3b8",
                              fontWeight:600, fontSize:12,
                              border: canEditP?"1px dashed #cbd5e1":"none",
                              minWidth:28, display:"inline-block", textAlign:"right" }}>
                            {players > 0 ? players : canEditP ? "+" : "—"}
                          </span>
                        )}
                      </td>
                      {isPerBooking&&<td style={{ ...tdS, textAlign:"right" }}>
                        {isEditingDur ? (
                          <input
                            type="number" min="0.5" step="0.5"
                            value={durationInput}
                            onChange={e=>setDurationInput(e.target.value)}
                            onBlur={()=>{ onUpdateApproxDuration(r.email, durationInput); setEditingDuration(null); }}
                            onKeyDown={e=>{ if(e.key==="Enter"||e.key==="Escape"){ onUpdateApproxDuration(r.email, durationInput); setEditingDuration(null); }}}
                            autoFocus
                            style={{ width:60, padding:"2px 6px", borderRadius:6, border:"1.5px solid #0369a1", fontSize:13, textAlign:"right", fontFamily:"inherit", outline:"none" }}
                          />
                        ) : (
                          <span
                            onClick={canEditD ? ()=>{ setEditingDuration(r.email.toLowerCase()); setDurationInput(String(dur)); } : undefined}
                            title={canEditD ? "Click to edit approx duration" : undefined}
                            style={{ cursor:canEditD?"pointer":"default", padding:"2px 8px", borderRadius:6,
                              background: durSaved?"#e0f2fe":"#f8fafc",
                              color: durSaved?"#0369a1":"#94a3b8",
                              fontWeight:600, fontSize:12,
                              border: canEditD?"1px dashed #cbd5e1":"none",
                              minWidth:32, display:"inline-block", textAlign:"right" }}>
                            {dur}h
                          </span>
                        )}
                      </td>}
                      {anyRates&&<td style={{ ...tdS, textAlign:"right", fontWeight:700, color:perPlayer>0?"#7c3aed":"#94a3b8" }}>
                        {perPlayer>0 ? fmtCost(perPlayer) : "—"}
                      </td>}
                    </tr>
                    {isExpanded && bookerBkgs.length>0 && (() => {
                      // Columns: chevron, booker, bookings, day, eve, total, [day$, eve$], total$, players, [dur], [$/player]
                      const baseCols = 6;
                      const dayCostCol = anyRates && !isPerBooking ? 2 : 0;
                      const totalCostCol = anyRates ? 1 : 0;
                      const playersCol = 1;
                      const durCol = isPerBooking ? 1 : 0;
                      const perPlayerCol = anyRates ? 1 : 0;
                      const totalCols = baseCols + dayCostCol + totalCostCol + playersCol + durCol + perPlayerCol;
                      return (
                        <tr style={{background:"#fafbff"}}>
                          <td/>
                          <td colSpan={totalCols-1} style={{padding:"6px 12px 10px"}}>
                            <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:4}}>Individual bookings ({bookerBkgs.length})</div>
                            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,background:"#fff",borderRadius:6,overflow:"hidden",border:"1px solid #eef2ff"}}>
                              <thead>
                                <tr style={{background:"#eef2ff"}}>
                                  {["Date","Facility","Time","Hrs","Cost","Status"].map(h=>(
                                    <th key={h} style={{padding:"4px 8px",textAlign:h==="Hrs"||h==="Cost"?"right":"left",fontWeight:700,color:"#4338ca",fontSize:10,whiteSpace:"nowrap"}}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {bookerBkgs.map(b => {
                                  const fac = FACILITIES.find(x=>x.id===b.facility_id);
                                  const cost = getBookingCost(b);
                                  const credit = bookingPendingCredit(b); // ≤ 0
                                  const deficit = bookingPendingDeficit(b); // ≥ 0
                                  const netCost = cost + credit;
                                  return (
                                    <tr key={b.id} style={{borderTop:"1px solid #f1f5f9"}}>
                                      <td style={{padding:"3px 8px",color:"#475569",whiteSpace:"nowrap"}}>{fmtDateShort(b.date)}</td>
                                      <td style={{padding:"3px 8px",color:"#475569",whiteSpace:"nowrap"}}>
                                        <span style={{display:"inline-flex",alignItems:"center",gap:4}}>
                                          <span style={{width:6,height:6,borderRadius:"50%",background:fac?.color,display:"inline-block"}}/>
                                          {fac?(fac.name.includes("Field")?fac.name.replace("Field ","F"):fac.name.split(" ")[0]):"—"}
                                        </span>
                                      </td>
                                      <td style={{padding:"3px 8px",color:"#475569",whiteSpace:"nowrap"}}>{fmt24(b.start_hour)}–{fmt24(b.start_hour+b.duration)}</td>
                                      <td style={{padding:"3px 8px",textAlign:"right",color:"#475569"}}>{fmtHrs(b.duration)}</td>
                                      <td style={{padding:"3px 8px",textAlign:"right",fontWeight:600,color:(netCost+deficit)>0?"#15803d":"#94a3b8"}}
                                          title={(credit<0||deficit>0)?`${fmtCost(cost)}${credit<0?` − credit ${fmtCost(Math.abs(credit))}`:""}${deficit>0?` + deficit ${fmtCost(deficit)}`:""} = ${fmtCost(cost+credit+deficit)}`:undefined}>
                                        {(cost+credit+deficit)>0?fmtCost(cost+credit+deficit):"—"}
                                        {credit<0&&<span style={{fontSize:9,color:"#16a34a",marginLeft:3,fontWeight:700}}>(−{fmtCost(Math.abs(credit))})</span>}
                                        {deficit>0&&<span style={{fontSize:9,color:"#b45309",marginLeft:3,fontWeight:700}}>(+{fmtCost(deficit)})</span>}
                                      </td>
                                      <td style={{padding:"3px 8px"}}><Badge status={b.status}/>{b.invoiced&&<span style={{marginLeft:3,fontSize:9,fontWeight:700,color:"#5b21b6"}}>🧾</span>}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      );
                    })()}
                    </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  {(()=>{
                    const totalPlayers = rows.reduce((s,r)=>s+getPlayers(r.email),0);
                    const totalCostAll = rows.reduce((s,r)=>s+r.cost,0);
                    const totalPerPlayer = anyRates && totalPlayers > 0 && totalCostAll > 0 ? totalCostAll / totalPlayers : 0;
                    const totalApproxHrs = isPerBooking ? rows.reduce((s,r)=>s+r.bookings*getApproxDuration(r.email),0) : totalHrs;
                    return (
                    <tr style={{ background:"#f8fafc", borderTop:"2px solid #f1f5f9" }}>
                      <td style={{...tdS}}/>
                      <td style={{ ...tdS, fontWeight:700 }}>Total</td>
                      <td style={{ ...tdS, textAlign:"right", fontWeight:700 }}>{active.length}</td>
                      <td style={{ ...tdS, textAlign:"right" }}>
                        {isPerBooking
                          ? <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:6, padding:"2px 8px", fontWeight:700, fontSize:12 }}>{totalDayBkgs}</span>
                          : <span style={{ background:"#fef9c3", color:"#854d0e", borderRadius:6, padding:"2px 8px", fontWeight:700, fontSize:12 }}>{fmtHrs(totalDaytime)}</span>}
                      </td>
                      <td style={{ ...tdS, textAlign:"right" }}>
                        {isPerBooking
                          ? <span style={{ background:"#ede9fe", color:"#5b21b6", borderRadius:6, padding:"2px 8px", fontWeight:700, fontSize:12 }}>{totalEveBkgs}</span>
                          : <span style={{ background:"#ede9fe", color:"#5b21b6", borderRadius:6, padding:"2px 8px", fontWeight:700, fontSize:12 }}>{fmtHrs(totalEvening)}</span>}
                      </td>
                      <td style={{ ...tdS, textAlign:"right", fontWeight:800 }}>{fmtHrs(totalApproxHrs)}</td>
                      {anyRates&&!isPerBooking&&<td style={{ ...tdS, textAlign:"right", fontWeight:800, color:"#15803d" }}>{fmtCost(totalDayCost)}</td>}
                      {anyRates&&!isPerBooking&&<td style={{ ...tdS, textAlign:"right", fontWeight:800, color:"#15803d" }}>{fmtCost(totalEveCost)}</td>}
                      {anyRates&&(()=>{
                        const totalCredit = rows.reduce((s,r)=>s+(r.pendingCredit||0),0);
                        const totalDeficit = rows.reduce((s,r)=>s+(r.pendingDeficit||0),0);
                        const netTotal = totalCostAll + totalCredit + totalDeficit;
                        const tip = [
                          totalCredit<0?`− credits ${fmtCost(Math.abs(totalCredit))}`:"",
                          totalDeficit>0?`+ deficits ${fmtCost(totalDeficit)}`:"",
                        ].filter(Boolean).join(" ");
                        return (
                          <td style={{ ...tdS, textAlign:"right", fontWeight:800, color:"#15803d" }}
                              title={tip?`Cost ${fmtCost(totalCostAll)} ${tip} = ${fmtCost(netTotal)}`:undefined}>
                            {fmtCost(netTotal)}
                            {totalCredit<0&&<div style={{fontSize:9,fontWeight:700,color:"#16a34a",marginTop:1}}>−{fmtCost(Math.abs(totalCredit))} credit</div>}
                            {totalDeficit>0&&<div style={{fontSize:9,fontWeight:700,color:"#b45309",marginTop:1}}>+{fmtCost(totalDeficit)} deficit</div>}
                          </td>
                        );
                      })()}
                      <td style={{ ...tdS, textAlign:"right", fontWeight:700, color:totalPlayers>0?"#0369a1":"#94a3b8" }}>{totalPlayers > 0 ? totalPlayers : "—"}</td>
                      {isPerBooking&&<td style={{ ...tdS }}/>}
                      {anyRates&&<td style={{ ...tdS, textAlign:"right", fontWeight:800, color:totalPerPlayer>0?"#7c3aed":"#94a3b8" }}>{totalPerPlayer>0?fmtCost(totalPerPlayer):"—"}</td>}
                    </tr>
                    );
                  })()}
                </tfoot>
              </table>
              </CopyableTable>
            </div>
          )}
        {isPerBooking && rows.length > 0 && (
          <div style={{ fontSize:11, color:"#94a3b8", marginTop:6 }}>
            * Total Hrs = bookings × approx duration per booker (default 2 h). Click the ~Duration cell to adjust.
          </div>
        )}
      </div>

      {/* Schedule Summary — always shown */}
      <div style={{marginTop:24}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
          <h3 style={{margin:0,fontSize:15,fontWeight:700,color:"#0f172a",flex:1}}>📅 Schedule Summary</h3>
          <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer",color:"#475569"}}>
              <input type="checkbox" checked={scheduleFacSensitive} onChange={e=>setScheduleFacSensitive(e.target.checked)}/>
              Facility-sensitive
            </label>
          {isAdmin&&(
            <button onClick={()=>{setSandboxMode(v=>!v);setPreviewMerge(false);setSandboxSelected(new Set());}} style={S.btn({
              background:sandboxMode?"#7c3aed":"#f8fafc",
              color:sandboxMode?"#fff":"#475569",
              border:`1.5px solid ${sandboxMode?"#7c3aed":"#e2e8f0"}`,
              fontSize:12
            })}>
              🧪 {sandboxMode?"Exit Sandbox":"Sandbox Mode"}
            </button>
          )}
        </div>
        {(()=>{
          // Build pattern groups per email using overlap-aware grouping
          const patternMap = buildOverlapPatternMap(active, scheduleFacSensitive);

          // Build rows: one per email with recurring + one-off lists + hours/cost/facilities summary
          const scheduleRows = Object.entries(patternMap).map(([email,pats])=>{
            const recurring = Object.entries(pats).filter(([,bkgs])=>bkgs.length>=2);
            const oneOffCount = Object.values(pats).filter(bkgs=>bkgs.length===1).reduce((s,bkgs)=>s+bkgs.length,0);
            const totalBkgs = Object.values(pats).reduce((s,bkgs)=>s+bkgs.length,0);
            const nameDisplay = (pats[Object.keys(pats)[0]]||[])[0]?.name || email;
            const allBkgs = Object.values(pats).flat();
            const totalHrs = allBkgs.reduce((s,b)=>s+(isPerBooking?getApproxDuration(email):b.duration),0);
            const totalCost = allBkgs.reduce((s,b)=>s+getBookingCost(b),0);
            const facIds = [...new Set(allBkgs.map(b=>b.facility_id))];
            return {email,nameDisplay,recurring,oneOffCount,totalBkgs,totalHrs,totalCost,facIds};
          }).sort((a,b)=>b.totalBkgs-a.totalBkgs);

          // Sandbox merge: combine ALL selected patterns into a single merge
          // group as long as 2+ unique bookers are involved. Day, time,
          // duration and facility differences are reconciled in the preview.
          let mergePreview = null;
          if(sandboxMode && sandboxSelected.size>0){
            const byEmail = {}; // email -> {email, bkgs, pks}
            sandboxSelected.forEach(key=>{
              const [email,...rest] = key.split("::");
              const pk = rest.join("::");
              const bkgs = patternMap[email]?.[pk]||[];
              if(!bkgs.length) return;
              if(!byEmail[email]) byEmail[email]={email,bkgs:[],pks:[]};
              byEmail[email].bkgs.push(...bkgs);
              byEmail[email].pks.push(pk);
            });
            const groups = Object.values(byEmail);
            if(groups.length >= 2){
              const allBkgs = groups.flatMap(g=>g.bkgs);
              const numBookers = groups.length;
              const totalRate = allBkgs.reduce((s,b)=>{
                const cat = categoryOf(b);
                const r = bRates(b);
                const dur = getApproxDuration(b.email);
                return s + (isPerBooking ? dur*r[cat] : (splitHours(b).day*r.day + splitHours(b).evening*r.evening));
              },0);
              const avgRate = totalRate / allBkgs.length;
              const mergedRate = avgRate / numBookers;
              const mergedTotalCost = mergedRate * allBkgs.length;
              const label = `${groups.length} bookers · ${allBkgs.length} sessions`;
              mergePreview = [{label,numBookers,mergedTotalCost,mergedRate,bookers:groups.map(g=>g.email),groups,pk:"merge",mergeKey:"merge"}];
            }
          }

          const hasSelection = sandboxMode && sandboxSelected.size>0;
          const hasMergeable = mergePreview && mergePreview.length>0;
          return (
            <div>
              {hasSelection && !hasMergeable && (
                <div style={{background:"#fffbeb",border:"1.5px dashed #fde68a",borderRadius:10,padding:"10px 14px",marginBottom:12,fontSize:12,color:"#92400e"}}>
                  Select patterns from at least 2 different bookers to preview a merge. Days, times, durations and facilities don't need to match — you can reconcile any differences in the preview.
                </div>
              )}
              {hasMergeable && !previewMerge && (
                <div style={{display:"flex",alignItems:"center",gap:10,background:"#f5f3ff",border:"1.5px solid #c4b5fd",borderRadius:10,padding:"10px 14px",marginBottom:12,flexWrap:"wrap"}}>
                  <span style={{fontSize:12,fontWeight:600,color:"#5b21b6",flex:1}}>
                    Ready to merge {mergePreview.length} pattern{mergePreview.length!==1?"s":""} ({mergePreview.reduce((s,m)=>s+m.numBookers,0)} bookers selected). Add more selections or preview now.
                  </span>
                  <button onClick={()=>{setCommittedResolution(mergeResolution);setCommittedTarget(mergeTarget);setPreviewMerge(true);}}
                    style={S.btn({background:"#7c3aed",color:"#fff",fontSize:12,fontWeight:700})}>
                    👁 Preview Merge
                  </button>
                  <button onClick={()=>{setSandboxSelected(new Set());setPreviewMerge(false);}}
                    style={S.btn({border:"1.5px solid #c4b5fd",background:"#fff",color:"#7c3aed",fontSize:12})}>
                    Clear
                  </button>
                </div>
              )}
              {hasMergeable && previewMerge && (()=>{
                return mergePreview.map((m,mi)=>{
                  const key = m.mergeKey || mi;
                  // UI ("editing") target reflects user's pending pick; preview ("committed") target was snapshotted on last Preview/Recalculate.
                  const editingTarget = mergeTarget || m.groups[0]?.email;
                  const committedTargetEmail = committedTarget || m.groups[0]?.email;
                  const targetGroup = m.groups.find(g=>g.email===committedTargetEmail)||m.groups[0];
                  const editingTargetGroup = m.groups.find(g=>g.email===editingTarget)||m.groups[0];
                  const conformGroups = m.groups.filter(g=>g.email!==editingTargetGroup.email);
                  const targetBkg = editingTargetGroup.bkgs[0];
                  const resKey = k => `${key}::${k}`;
                  const resolved = (field, targetVal) => mergeResolution[resKey(field)] ?? targetVal;
                  const committedVal = (field, fallback) => committedResolution[resKey(field)] ?? fallback;
                  const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
                  const getField = (b, field) => {
                    if(!b) return "";
                    if(field === "day") return new Date(b.date+"T12:00").getDay();
                    return b[field];
                  };
                  const fields = ["day","start_hour","duration","facility_id"].map(field=>{
                    const targetVal = getField(targetBkg, field);
                    const conflicts = conformGroups.map(g=>({email:g.email,val:getField(g.bkgs[0], field)})).filter(x=>x.val!==targetVal);
                    return {field, targetVal, conflicts, resolvedVal: resolved(field, targetVal)};
                  });
                  const allGroups = m.groups.map(g=>{
                    const dates = g.bkgs.map(b=>b.date).sort();
                    return {email:g.email, start:dates[0], end:dates[dates.length-1], count:g.bkgs.length};
                  });
                  const getCost = (g) => g.bkgs.reduce((s,b)=>{
                    const cat = categoryOf(b);
                    const r = bRates(b);
                    const dur = getApproxDuration(b.email);
                    return s + (isPerBooking ? dur*r[cat] : (splitHours(b).day*r.day+splitHours(b).evening*r.evening));
                  }, 0);
                  const groupCosts = m.groups.map(g=>({email:g.email, cost:getCost(g), count:g.bkgs.length, bkgs:g.bkgs}));
                  const totalCost = groupCosts.reduce((s,g)=>s+g.cost, 0);
                  // After-merge schedule = committed target's schedule with committed overrides applied,
                  // restricted to the overlap window across all bookers' date ranges. Sessions outside
                  // the overlap stay with their original booker at full original cost.
                  const committedBkg = targetGroup.bkgs[0];
                  const ovFacId = committedVal("facility_id", committedBkg?.facility_id);
                  const ovStart = committedVal("start_hour", committedBkg?.start_hour);
                  const ovDur = committedVal("duration", committedBkg?.duration);
                  const ovRates = getFacRates(ovFacId);
                  const ranges = m.groups.map(g=>{
                    const sorted = g.bkgs.map(b=>b.date).sort();
                    return {email:g.email, start:sorted[0], end:sorted[sorted.length-1]};
                  });
                  const overlapStart = ranges.reduce((a,r)=>r.start>a?r.start:a, ranges[0].start);
                  const overlapEnd = ranges.reduce((a,r)=>r.end<a?r.end:a, ranges[0].end);
                  const hasOverlap = overlapStart <= overlapEnd;
                  const targetInOverlap = targetGroup.bkgs.filter(b=>hasOverlap && b.date>=overlapStart && b.date<=overlapEnd);
                  const sharedCount = targetInOverlap.length;
                  const ratePerSession = (()=>{
                    if(isPerBooking){
                      const cat = ovStart >= EVENING_CUTOFF ? "evening" : "day";
                      return ovDur * ovRates[cat];
                    }
                    const end = ovStart + ovDur;
                    const dayHrs = Math.max(0, Math.min(EVENING_CUTOFF, end) - Math.min(EVENING_CUTOFF, ovStart));
                    const eveHrs = Math.max(0, end - Math.max(EVENING_CUTOFF, ovStart));
                    return dayHrs*ovRates.day + eveHrs*ovRates.evening;
                  })();
                  const sharedTotal = sharedCount * ratePerSession;
                  const sharePerBooker = sharedTotal / m.numBookers;
                  // Per-booker individual cost = bookings OUTSIDE the overlap window
                  const individualCostByEmail = {};
                  m.groups.forEach(g=>{
                    const outside = g.bkgs.filter(b=>!hasOverlap || b.date<overlapStart || b.date>overlapEnd);
                    individualCostByEmail[g.email] = outside.reduce((s,b)=>{
                      const cat = categoryOf(b);
                      const r = bRates(b);
                      const dur = getApproxDuration(b.email);
                      return s + (isPerBooking ? dur*r[cat] : (splitHours(b).day*r.day+splitHours(b).evening*r.evening));
                    }, 0);
                  });
                  const mergedTotal = sharedTotal + Object.values(individualCostByEmail).reduce((s,v)=>s+v,0);
                  const si={border:"1px solid #e2e8f0",borderRadius:6,padding:"3px 7px",fontSize:12,fontFamily:"inherit",background:"#fff"};
                  const setRes = (field, val) => setMergeResolution(prev=>({...prev,[resKey(field)]:val}));
                  // Stale = the editing values diverge from what's committed in the preview
                  const stale = JSON.stringify(mergeResolution) !== JSON.stringify(committedResolution) || editingTarget !== committedTargetEmail;
                  return (
                    <div key={key} style={{background:"#f5f3ff",border:"1.5px solid #c4b5fd",borderRadius:10,padding:"14px 16px",marginBottom:12}}>

                      {/* Header */}
                      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10,flexWrap:"wrap"}}>
                        <div style={{fontWeight:700,fontSize:13,color:"#5b21b6",flex:1}}>🧪 Merge Preview — {m.label}</div>
                        {stale
                          ? <span style={{fontSize:11,fontWeight:700,color:"#92400e",background:"#fef3c7",border:"1px solid #fde68a",borderRadius:6,padding:"2px 7px"}}>⚠ Pending changes</span>
                          : <span style={{fontSize:11,fontWeight:600,color:"#16a34a",background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:6,padding:"2px 7px"}}>✓ Up to date</span>
                        }
                        <button onClick={()=>{setCommittedResolution({...mergeResolution});setCommittedTarget(mergeTarget);}}
                          style={S.btn({background:"#7c3aed",color:"#fff",fontSize:11,opacity:stale?1:0.5})}>
                          🔄 Recalculate
                        </button>
                      </div>

                      {/* Target + merged slot */}
                      <div style={{background:"#ede9fe",borderRadius:8,padding:"8px 12px",marginBottom:10}}>
                        <div style={{fontSize:12,fontWeight:600,color:"#64748b",marginBottom:5}}>Target (others conform to their slot):</div>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>
                          {m.groups.map(g=>(
                            <button key={g.email} onClick={()=>setMergeTarget(g.email)}
                              style={{background:editingTarget===g.email?"#5b21b6":"#f5f3ff",color:editingTarget===g.email?"#fff":"#5b21b6",border:"1px solid #c4b5fd",borderRadius:6,padding:"2px 8px",fontSize:11,cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>
                              {g.email.split("@")[0]}
                            </button>
                          ))}
                        </div>
                        <div style={{fontSize:12,color:"#4c1d95"}}>
                          📌 Merged slot: <strong>{DAYS[committedVal("day",new Date((targetGroup.bkgs[0]?.date||"2000-01-01")+"T12:00").getDay())] } {fmtTime(ovStart)} · {ovDur}h · {FACILITIES.find(f=>f.id===ovFacId)?.name||ovFacId}</strong>
                          {stale&&<span style={{color:"#92400e",marginLeft:6,fontSize:11}}>(pending recalculate)</span>}
                        </div>
                      </div>

                      {/* Resolve differences */}
                      {fields.some(f=>f.conflicts.length>0)&&(
                        <div style={{marginBottom:10,background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 12px"}}>
                          <div style={{fontWeight:600,fontSize:12,color:"#64748b",marginBottom:6}}>Resolve differences</div>
                          {fields.map(f=>{
                            if(f.conflicts.length===0) return null;
                            const label = f.field==="day"?"Day":f.field==="start_hour"?"Start time":f.field==="duration"?"Duration":"Facility";
                            const disp = v => f.field==="day"?DAYS[v]:f.field==="start_hour"?fmtTime(v):f.field==="facility_id"?(FACILITIES.find(x=>x.id===v)?.name||v):`${v}h`;
                            return (
                              <div key={f.field} style={{display:"grid",gridTemplateColumns:"70px 1fr auto",gap:8,alignItems:"center",marginBottom:5,fontSize:12}}>
                                <span style={{fontWeight:600,color:"#4c1d95"}}>{label}</span>
                                <span style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                                  <span style={{color:"#16a34a"}}>✓ {disp(f.targetVal)} <span style={{color:"#94a3b8",fontSize:11}}>({editingTargetGroup.email.split("@")[0]})</span></span>
                                  {f.conflicts.map(c=>(
                                    <span key={c.email} style={{color:"#9f1239"}}>≠ {disp(c.val)} <span style={{color:"#94a3b8",fontSize:11}}>({c.email.split("@")[0]})</span></span>
                                  ))}
                                </span>
                                <span style={{display:"flex",alignItems:"center",gap:5}}>
                                  <span style={{fontSize:11,color:"#64748b"}}>→</span>
                                  {f.field==="day"&&<select value={f.resolvedVal} onChange={e=>setRes(f.field,parseInt(e.target.value))} style={si}>{DAYS.map((d,i)=><option key={i} value={i}>{d}</option>)}</select>}
                                  {f.field==="start_hour"&&<input type="number" min="0" max="23" step="0.5" value={f.resolvedVal} onChange={e=>setRes(f.field,parseFloat(e.target.value)||0)} style={{...si,width:60}}/>}
                                  {f.field==="duration"&&<select value={f.resolvedVal} onChange={e=>setRes(f.field,parseFloat(e.target.value))} style={si}>{DURATIONS.map(d=><option key={d.value} value={d.value}>{d.label}</option>)}</select>}
                                  {f.field==="facility_id"&&<select value={f.resolvedVal} onChange={e=>setRes(f.field,e.target.value)} style={si}>{FACILITIES.map(f2=><option key={f2.id} value={f2.id}>{f2.name}</option>)}</select>}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* Date ranges */}
                      <div style={{marginBottom:10,background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 12px"}}>
                        <div style={{fontWeight:600,fontSize:12,color:"#64748b",marginBottom:5}}>Date ranges &amp; overlap</div>
                        {allGroups.map(g=>(
                          <div key={g.email} style={{fontSize:12,color:"#4c1d95",marginBottom:2,display:"flex",justifyContent:"space-between",flexWrap:"wrap"}}>
                            <span style={{fontWeight:600}}>{g.email.split("@")[0]}</span>
                            <span>{fmtDate(g.start)} → {fmtDate(g.end)} · {g.count} sessions</span>
                          </div>
                        ))}
                        {hasOverlap?(
                          <div style={{marginTop:5,paddingTop:5,borderTop:"1px dashed #c4b5fd",fontSize:11,color:"#5b21b6",display:"flex",justifyContent:"space-between"}}>
                            <span style={{fontWeight:600}}>Overlap window</span>
                            <span>{fmtDate(overlapStart)} → {fmtDate(overlapEnd)} · {sharedCount} shared session{sharedCount!==1?"s":""}</span>
                          </div>
                        ):<div style={{fontSize:11,color:"#ef4444",marginTop:4}}>⚠ No overlap — no sessions to merge</div>}
                      </div>

                      {/* Cost breakdown */}
                      <div style={{background:"#ede9fe",borderRadius:8,padding:"8px 12px",marginBottom:10}}>
                        <div style={{fontWeight:700,fontSize:12,color:"#5b21b6",marginBottom:8}}>Cost breakdown <span style={{fontWeight:400,fontSize:11,color:"#94a3b8"}}>(Before → After)</span></div>
                        {groupCosts.map(g=>{
                          const indiv = individualCostByEmail[g.email]||0;
                          const finalCost = sharePerBooker+indiv;
                          const diff = g.cost-finalCost;
                          const players = getPlayers(g.email);
                          const insideCount = g.bkgs.filter(b=>hasOverlap&&b.date>=overlapStart&&b.date<=overlapEnd).length;
                          const outsideCount = g.bkgs.length-insideCount;
                          return (
                            <div key={g.email} style={{marginBottom:8,paddingBottom:8,borderBottom:"1px solid #c4b5fd"}}>
                              <div style={{fontWeight:700,fontSize:12,color:"#4c1d95",marginBottom:4}}>
                                {g.email.split("@")[0]}{players>0&&<span style={{fontWeight:400,color:"#64748b"}}> · {players} players</span>}
                              </div>
                              <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:"3px 12px",fontSize:11}}>
                                {insideCount>0&&<><span style={{color:"#475569"}}>Shared ({insideCount} sessions)</span><span style={{textAlign:"right",color:"#9f1239",textDecoration:"line-through"}}>{fmtCost(getCost({bkgs:g.bkgs.filter(b=>b.date>=overlapStart&&b.date<=overlapEnd)}))}</span><span style={{textAlign:"right",color:"#16a34a",fontWeight:600}}>{fmtCost(sharePerBooker)}</span></>}
                                {outsideCount>0&&<><span style={{color:"#94a3b8"}}>Unaffected ({outsideCount} sessions)</span><span style={{textAlign:"right",color:"#94a3b8"}}>{fmtCost(indiv)}</span><span style={{textAlign:"right",color:"#94a3b8"}}>{fmtCost(indiv)}</span></>}
                                <span style={{fontWeight:700,color:"#4c1d95",paddingTop:3,borderTop:"1px solid #c4b5fd"}}>Total</span>
                                <span style={{textAlign:"right",fontWeight:700,color:"#9f1239",paddingTop:3,borderTop:"1px solid #c4b5fd",textDecoration:"line-through"}}>{fmtCost(g.cost)}</span>
                                <span style={{textAlign:"right",fontWeight:700,color:"#16a34a",paddingTop:3,borderTop:"1px solid #c4b5fd"}}>{fmtCost(finalCost)}</span>
                                {players>0&&<><span style={{color:"#64748b"}}>Per player</span><span style={{textAlign:"right",color:"#9f1239",textDecoration:"line-through"}}>{fmtCost(g.cost/players)}</span><span style={{textAlign:"right",color:"#16a34a",fontWeight:600}}>{fmtCost(finalCost/players)}</span></>}
                              </div>
                              <div style={{fontSize:11,color:diff>=0?"#16a34a":"#dc2626",textAlign:"right",marginTop:2}}>
                                {diff>=0?"Saves":"Pays extra"} {fmtCost(Math.abs(diff))}{players>0?` · ${fmtCost(Math.abs(diff)/players)}/player`:""}
                              </div>
                            </div>
                          );
                        })}
                        {(()=>{
                          const totalPlayers = groupCosts.reduce((s,g)=>s+getPlayers(g.email),0);
                          const totalSaved = totalCost-mergedTotal;
                          return (
                            <div>
                              <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:"3px 12px",fontSize:12,fontWeight:700,color:"#5b21b6"}}>
                                <span>Combined{totalPlayers>0&&<span style={{fontWeight:400,color:"#64748b"}}> · {totalPlayers} players</span>}</span>
                                <span style={{textAlign:"right",textDecoration:"line-through",color:"#9f1239"}}>{fmtCost(totalCost)}</span>
                                <span style={{textAlign:"right",color:"#16a34a"}}>{fmtCost(mergedTotal)}</span>
                              </div>
                              {totalPlayers>0&&(
                                <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:"3px 12px",fontSize:11,color:"#64748b",marginTop:2}}>
                                  <span>Per player</span>
                                  <span style={{textAlign:"right",textDecoration:"line-through",color:"#9f1239"}}>{fmtCost(totalCost/totalPlayers)}</span>
                                  <span style={{textAlign:"right",color:"#16a34a",fontWeight:600}}>{fmtCost(mergedTotal/totalPlayers)}</span>
                                </div>
                              )}
                              <div style={{fontSize:11,color:"#16a34a",textAlign:"right",marginTop:3,fontWeight:600}}>
                                Total saves {fmtCost(totalSaved)}{totalPlayers>0?` · ${fmtCost(totalSaved/totalPlayers)}/player`:""}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                      <button
                        onClick={()=>{
                          if(onProposeMerge) onProposeMerge([m]);
                          else alert("Merge proposal added — commit your cart to notify bookers.");
                        }}
                        style={S.btn({background:"#7c3aed",color:"#fff",fontSize:12})}>
                        Propose Merge
                      </button>
                    </div>
                  );
                });
              })()}
              <div style={{overflowX:"auto"}}>
                <CopyableTable>
                <table style={{width:"100%",borderCollapse:"collapse",minWidth:480}}>
                  <thead>
                    <tr style={{background:"#f8fafc"}}>
                      <th style={thS}>Booker</th>
                      <th style={thS}>Recurring Patterns</th>
                      <th style={{...thS,textAlign:"left"}}>Facilities</th>
                      <th style={{...thS,textAlign:"right"}}>Hrs</th>
                      {anyRates&&<th style={{...thS,textAlign:"right",color:"#15803d"}}>Cost</th>}
                      <th style={{...thS,textAlign:"right"}}>One-offs</th>
                      <th style={{...thS,textAlign:"right"}}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {scheduleRows.map(row=>{
                      const ec = emailColor(row.email);
                      return (
                        <tr key={row.email} style={{borderBottom:"1px solid #f1f5f9"}}>
                          <td style={tdS}>
                            <span style={{display:"inline-block",padding:"3px 10px",borderRadius:12,background:emailColor(row.email),color:"#fff",fontSize:12,fontWeight:700}}>
                              {summaryAlias(row.email)}
                            </span>
                          </td>
                          <td style={tdS}>
                            <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                              {row.recurring.length===0&&<span style={{fontSize:12,color:"#94a3b8"}}>—</span>}
                              {row.recurring.map(([pk,bkgs])=>{
                                const selKey = `${row.email}::${pk}`;
                                const isSel = sandboxSelected.has(selKey);
                                const parts = pk.split("_");
                                const startH = parseFloat(parts[parts.length-1]);
                                const dn = parts[parts.length-2]||"";
                                const durs = [...new Set(bkgs.map(b=>b.duration))];
                                const durLabel = durs.length===1 ? `${durs[0]}h` : `~${Math.round(durs.reduce((s,d)=>s+d,0)/durs.length*2)/2}h`;
                                let facLabel;
                                if(scheduleFacSensitive){
                                  const facId = pk.split("_")[0];
                                  const fac = FACILITIES.find(f=>f.id===facId);
                                  facLabel = fac ? fac.name.split("–")[0].split("#")[0].trim().replace("Field","Fld") : facId;
                                } else {
                                  const facIds = [...new Set(bkgs.map(b=>b.facility_id))];
                                  facLabel = facIds.map(fid=>{
                                    const f=FACILITIES.find(x=>x.id===fid);
                                    return f ? (f.name.includes("Field") ? f.name.replace("Field ","Fld ") : f.name.split("–")[0].trim().slice(0,6)) : fid;
                                  }).join(", ");
                                }
                                const label = `${dn} ${fmtTime(startH)} · ${durLabel} · ${facLabel} ×${bkgs.length}`;
                                return (
                                  <div key={pk} style={{display:"flex",alignItems:"center",gap:4}}>
                                    {sandboxMode&&(
                                      <input type="checkbox" checked={isSel}
                                        onChange={e=>{
                                          setSandboxSelected(prev=>{
                                            const next=new Set(prev);
                                            if(e.target.checked) next.add(selKey); else next.delete(selKey);
                                            return next;
                                          });
                                          setPreviewMerge(false);
                                        }}
                                        style={{cursor:"pointer"}}/>
                                    )}
                                    <span onClick={()=>setPatternModal({email:row.email, name:row.nameDisplay, pk, bkgs})} style={{
                                      display:"inline-block",
                                      background:isSel?"#7c3aed":ec+"22",
                                      color:isSel?"#fff":ec,
                                      border:`1px solid ${isSel?"#7c3aed":ec+"55"}`,
                                      borderRadius:6,
                                      padding:"2px 8px",
                                      fontSize:11,
                                      fontWeight:600,
                                      whiteSpace:"nowrap",
                                      cursor:"pointer"
                                    }}>
                                      {label}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                          <td style={tdS}>
                            <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                              {row.facIds.length===0 && <span style={{fontSize:11,color:"#94a3b8"}}>—</span>}
                              {row.facIds.map(fid=>{
                                const fac=FACILITIES.find(f=>f.id===fid);
                                return (
                                  <span key={fid} title={fac?.name||fid}
                                    style={{display:"inline-flex",alignItems:"center",gap:3,padding:"1px 6px",borderRadius:10,background:(fac?.color||"#94a3b8")+"22",color:fac?.color||"#475569",fontSize:10,fontWeight:600,border:`1px solid ${(fac?.color||"#94a3b8")}55`}}>
                                    <span style={{width:5,height:5,borderRadius:"50%",background:fac?.color||"#94a3b8"}}/>
                                    {fac?(fac.name.includes("Field")?fac.name.replace("Field ","F"):fac.name.split(" ")[0]):fid}
                                  </span>
                                );
                              })}
                            </div>
                          </td>
                          <td style={{...tdS,textAlign:"right",fontWeight:600,color:"#475569"}}>{fmtHrs(row.totalHrs)}</td>
                          {anyRates&&<td style={{...tdS,textAlign:"right",fontWeight:700,color:row.totalCost>0?"#15803d":"#94a3b8"}}>{row.totalCost>0?fmtCost(row.totalCost):"—"}</td>}
                          <td style={{...tdS,textAlign:"right"}}>
                            {row.oneOffCount>0 ? (
                              <button onClick={()=>{
                                const oneOffBkgs = Object.values(patternMap[row.email]||{}).filter(bs=>bs.length===1).flat();
                                setOneOffModal({email:row.email, name:row.nameDisplay, bkgs:oneOffBkgs});
                              }} style={{background:"none",border:"1px solid #e2e8f0",borderRadius:6,padding:"2px 8px",cursor:"pointer",fontSize:12,color:"#475569",fontWeight:600}}>
                                {row.oneOffCount}
                              </button>
                            ) : <span style={{color:"#94a3b8"}}>—</span>}
                          </td>
                          <td style={{...tdS,textAlign:"right",fontWeight:700}}>{row.totalBkgs}</td>
                        </tr>
                      );
                    })}
                    {scheduleRows.length===0&&(
                      <tr><td colSpan={anyRates?7:6} style={{...tdS,textAlign:"center",color:"#94a3b8"}}>No bookings in current filter.</td></tr>
                    )}
                  </tbody>
                </table>
                </CopyableTable>
              </div>
            </div>
          );
        })()}
      </div>

      {patternModal && (
        <PatternModal
          {...patternModal}
          isAdmin={isAdmin}
          facilityRates={facilityRates}
          pricingMode={pricingMode}
          approxDurations={approxDurations}
          onClose={()=>setPatternModal(null)}
          onBulkApply={args=>{onBulkApply&&onBulkApply(args);}}
        />
      )}
      {oneOffModal && (
        <OneOffModal
          {...oneOffModal}
          isAdmin={isAdmin}
          onClose={()=>setOneOffModal(null)}
        />
      )}
      {/* Invoice modal */}
      {showInvoice && (()=>{
        const scopes = getInvoiceScopes();
        const allBkgs = scopes.flatMap(s => s.bkgs);
        const totalCostInv = allBkgs.reduce((s,b)=>s+getBookingCost(b),0);
        const docLabel = invMode==="official" ? "Invoice" : (invDocType === "purchase_order" ? "Purchase Order" : "Invoice");
        const OptionRow = InvoiceOptionRow;
        const Pill = InvoicePill;
        const officialReady = invMode==="official" && invOrderName.trim().length>0 && allBkgs.length>0;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.45)",zIndex:999,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
            <div style={{background:"#fff",borderRadius:16,padding:28,maxWidth:580,width:"100%",boxShadow:"0 8px 40px rgba(0,0,0,0.18)",display:"flex",flexDirection:"column",gap:16,maxHeight:"92vh",overflowY:"auto"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <h3 style={{margin:0,fontSize:18,fontWeight:800,color:"#0f172a"}}>🧾 Export Invoice</h3>
                <button onClick={()=>setShowInvoice(false)} style={{background:"none",border:"none",cursor:"pointer",fontSize:20,color:"#94a3b8",lineHeight:1}}>✕</button>
              </div>

              {/* Mode tabs */}
              <div style={{display:"flex",gap:0,border:"1.5px solid #e2e8f0",borderRadius:10,overflow:"hidden"}}>
                {[{k:"draft",label:"📄 Draft",desc:"Export HTML/PDF/CSV"},{k:"official",label:"📋 Official",desc:"Generate billing record"}].map(({k,label,desc})=>(
                  <button key={k} onClick={()=>setInvMode(k)} style={{flex:1,padding:"10px 16px",border:"none",background:invMode===k?"#0f172a":"#f8fafc",color:invMode===k?"#fff":"#64748b",fontWeight:700,fontSize:13,cursor:"pointer",fontFamily:"inherit",textAlign:"center",transition:"background 0.15s"}}>
                    {label}<div style={{fontSize:10,fontWeight:400,marginTop:2,opacity:0.75}}>{desc}</div>
                  </button>
                ))}
              </div>

              {/* Booker filter — shared across both modes */}
              <OptionRow label="Bookers">
                <Pill active={invSelectedEmails.size===0} onClick={()=>setInvSelectedEmails(new Set())}>All</Pill>
                {allInvoiceEmails.map(e=>{
                  const sel=invSelectedEmails.has(e.toLowerCase());
                  const c=emailColor(e);
                  return(
                    <button key={e} onClick={()=>{
                      setInvSelectedEmails(prev=>{
                        const s=new Set(prev);
                        if(s.has(e.toLowerCase())) s.delete(e.toLowerCase()); else s.add(e.toLowerCase());
                        return s;
                      });
                    }} style={{padding:"4px 12px",borderRadius:8,border:`1.5px solid ${sel?c:"#e2e8f0"}`,background:sel?c:"#f8fafc",color:sel?"#fff":"#475569",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>
                      {summaryAlias(e)}
                    </button>
                  );
                })}
              </OptionRow>

              {/* Include previously-invoiced bookings toggle (both modes) */}
              {isAdmin&&(
                <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#475569",cursor:"pointer",background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 12px"}}>
                  <input type="checkbox" checked={invIncludeInvoiced} onChange={e=>setInvIncludeInvoiced(e.target.checked)} style={{accentColor:"#64748b"}}/>
                  Include previously-invoiced bookings
                </label>
              )}

              {/* Summary bar */}
              {(()=>{
                // Pending credits across all scopes in this popup
                const pendingCredits = scopes.flatMap(s =>
                  bookings.filter(b => {
                    if (b.email?.toLowerCase() !== s.email.toLowerCase()) return false;
                    const res = parseCpsaResolution(b.system_notes);
                    return res?.billingState === "credit_pending";
                  })
                );
                const creditAmt = pendingCredits.length > 0
                  ? buildAdjustmentLines(pendingCredits).filter(l=>l.cost<0).reduce((s,l)=>s+l.cost,0)
                  : 0;
                return (
                  <div style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#475569",display:"flex",flexDirection:"column",gap:6}}>
                    <div style={{display:"flex",flexWrap:"wrap",gap:8,alignItems:"center"}}>
                      {invScope==="per_booker" && invSelectedEmails.size !== 1
                        ? <span><strong>{scopes.length}</strong> booker{scopes.length!==1?"s":""} · <strong>{allBkgs.length}</strong> booking{allBkgs.length!==1?"s":""} · <strong style={{color:"#15803d"}}>{fmtCost(totalCostInv)}</strong></span>
                        : <span>{docLabel} for <strong>{scopes[0]?.name||scopes[0]?.email}</strong> · <strong>{allBkgs.length}</strong> booking{allBkgs.length!==1?"s":""} · <strong style={{color:"#15803d"}}>{fmtCost(totalCostInv)}</strong></span>
                      }
                      {creditAmt < 0 && (
                        <span style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:700,color:"#15803d"}}>
                          💚 {pendingCredits.length} credit{pendingCredits.length!==1?"s":""} → {fmtCost(creditAmt)} applied
                        </span>
                      )}
                    </div>
                    <div style={{fontSize:10,color:"#94a3b8"}}>
                      From summary filter: {dateFrom||"…"} → {dateTo||"…"}
                      {emailFilterSet.size>0?` · ${emailFilterSet.size} booker${emailFilterSet.size!==1?"s":""}`:" · all bookers"}
                      {invIncludeInvoiced?"":" · invoiced bookings excluded"}
                      {creditAmt<0?" · pending credits will be deducted from invoice total":""}
                    </div>
                    {allBkgs.length===0&&(
                      <div style={{color:"#f43f5e",fontSize:11,fontWeight:600}}>
                        No bookings match. {!invIncludeInvoiced&&"Try enabling \"Include previously-invoiced\" — "}adjust the date preset or booker filter in the summary view.
                      </div>
                    )}
                  </div>
                );
              })()}

              {invMode==="draft" && (
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  <OptionRow label="Document">
                    <Pill active={invDocType==="invoice"} onClick={()=>setInvDocType("invoice")}>Invoice</Pill>
                    <Pill active={invDocType==="purchase_order"} onClick={()=>setInvDocType("purchase_order")}>Purchase Order</Pill>
                  </OptionRow>
                  <OptionRow label="Name">
                    <input value={invName} onChange={e=>setInvName(e.target.value)} placeholder="e.g. Pilot"
                      style={{...S.inp,fontSize:12,maxWidth:200}}/>
                    <span style={{fontSize:11,color:"#94a3b8",alignSelf:"center",wordBreak:"break-all"}}>
                      {`AMUA ${invDocType==="purchase_order"?"PO":"Invoice"}${invName.trim()?` - ${invName.trim()}`:""} - ${(dateFrom||"…").replace(/-/g,"")}-${(dateTo||"…").replace(/-/g,"")}`}
                    </span>
                  </OptionRow>
                  {invSelectedEmails.size !== 1 && allInvoiceEmails.length > 1 && (
                    <OptionRow label="Output">
                      <Pill active={invScope==="combined"} onClick={()=>setInvScope("combined")}>Combined</Pill>
                      <Pill active={invScope==="per_booker"} onClick={()=>setInvScope("per_booker")}>Per booker</Pill>
                    </OptionRow>
                  )}
                  <OptionRow label="Line items">
                    <Pill active={invDetail==="grouped"} onClick={()=>setInvDetail("grouped")}>Grouped</Pill>
                    <Pill active={invDetail==="individual"} onClick={()=>setInvDetail("individual")}>Individual</Pill>
                  </OptionRow>
                  <OptionRow label="GST">
                    <Pill active={invGst==="inclusive"} onClick={()=>setInvGst("inclusive")}>Inclusive</Pill>
                    <Pill active={invGst==="exclusive"} onClick={()=>setInvGst("exclusive")}>Exclusive (add on)</Pill>
                    <Pill active={invGst==="note"} onClick={()=>setInvGst("note")}>Note only</Pill>
                  </OptionRow>
                  {isAdmin&&(
                    <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#5b21b6",cursor:"pointer",background:"#f5f3ff",border:"1px solid #ddd6fe",borderRadius:8,padding:"8px 12px"}}>
                        <input type="checkbox" checked={invMarkInvoiced} onChange={e=>setInvMarkInvoiced(e.target.checked)} style={{accentColor:"#7c3aed"}}/>
                        Mark {allBkgs.length} booking{allBkgs.length!==1?"s":""} as <strong>invoiced</strong> on export
                      </label>
                      {mismatchAdjustments.length>0&&(
                        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,color:"#92400e",cursor:"pointer",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"8px 12px"}}>
                          <input type="checkbox" checked={invIncludeAdjustments} onChange={e=>setInvIncludeAdjustments(e.target.checked)} style={{accentColor:"#f59e0b"}}/>
                          Include {mismatchAdjustments.length} GTEC mismatch adjustment{mismatchAdjustments.length!==1?"s":""}
                        </label>
                      )}
                    </div>
                  )}
                  <div style={{borderTop:"1px solid #f1f5f9",paddingTop:12}}>
                    <div style={{fontSize:12,fontWeight:600,color:"#64748b",marginBottom:8}}>Export as:</div>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      {[{fmt:"html",label:"Open HTML",icon:"🌐"},{fmt:"print",label:"Print / PDF",icon:"🖨"},{fmt:"csv",label:"CSV",icon:"📊"}].map(({fmt,label,icon})=>(
                        <button key={fmt} onClick={()=>{ scopes.forEach(s => exportInvoice(fmt, s.bkgs, s.name, s.email)); }}
                          style={S.btn({background:"#0f172a",color:"#fff",gap:6,display:"flex",alignItems:"center"})}>
                          {icon} {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {invMode==="official" && isAdmin && onCreateOfficialInvoice && (
                <div style={{display:"flex",flexDirection:"column",gap:12}}>
                  <OptionRow label="Order name">
                    <input value={invOrderName} onChange={e=>setInvOrderName(e.target.value)} placeholder="e.g. Term 1 2026 (required)"
                      style={{...S.inp,fontSize:12,maxWidth:260,border:invOrderName.trim()?"1.5px solid #e2e8f0":"1.5px solid #f43f5e"}}/>
                  </OptionRow>
                  <OptionRow label="GST">
                    <Pill active={invGst==="inclusive"} onClick={()=>setInvGst("inclusive")}>Inclusive (extract)</Pill>
                    <Pill active={invGst==="exclusive"} onClick={()=>setInvGst("exclusive")}>Exclusive (add on)</Pill>
                    <Pill active={invGst==="note"} onClick={()=>setInvGst("note")}>Note only</Pill>
                  </OptionRow>
                  {/* Document structure preview */}
                  {(()=>{
                    const sel = invSelectedEmails.size>0 ? [...invSelectedEmails] : allInvoiceEmails;
                    return (
                      <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:8,padding:"10px 12px",fontSize:12,color:"#075985",display:"flex",flexDirection:"column",gap:6}}>
                        <div style={{fontWeight:700,fontSize:11,color:"#0369a1",marginBottom:2}}>Documents to be created:</div>
                        {sel.map(e=>(
                          <div key={e} style={{display:"flex",gap:6,alignItems:"center"}}>
                            <span style={{fontFamily:"monospace",fontSize:10,background:"#e0f2fe",padding:"1px 5px",borderRadius:4,color:"#0369a1"}}>INV</span>
                            <span style={{fontWeight:600}}>{officialBookerName(e)}</span>
                            <span style={{color:"#64748b",fontSize:11}}>← AMUA invoice to booker</span>
                          </div>
                        ))}
                        <div style={{display:"flex",gap:6,alignItems:"center",marginTop:2,paddingTop:6,borderTop:"1px dashed #bae6fd"}}>
                          <span style={{fontFamily:"monospace",fontSize:10,background:"#dbeafe",padding:"1px 5px",borderRadius:4,color:"#1d4ed8"}}>PO</span>
                          <span style={{fontWeight:600}}>{VENDOR_GTEC.name}</span>
                          <span style={{color:"#64748b",fontSize:11}}>← combined PO for all {sel.length} booker{sel.length!==1?"s":""}</span>
                        </div>
                        <div style={{fontSize:10,color:"#0369a1",marginTop:2}}>
                          Bookings remain uninvoiced until this record advances from Draft → next stage.
                        </div>
                      </div>
                    );
                  })()}
                  {!invOrderName.trim()&&<div style={{fontSize:11,color:"#f43f5e",fontWeight:600}}>Order name is required before creating an official record.</div>}
                  <div style={{borderTop:"1px solid #e0e7ff",paddingTop:12}}>
                    <button onClick={()=>{
                      if(!invOrderName.trim()) return;
                      const allRecs = [];
                      const officialScopes = invSelectedEmails.size>0
                        ? getInvoiceScopes()
                        : allInvoiceEmails.map(e=>({
                            email: e,
                            name: officialBookerName(e),
                            bkgs: activeForInvoice.filter(b=>b.email?.toLowerCase()===e.toLowerCase()),
                          })).filter(s=>s.bkgs.length>0);
                      const invoiceRecords = officialScopes.map(s=>{
                        const rec = buildInvoiceRecord(s, allRecs);
                        allRecs.push(rec);
                        return rec;
                      });
                      const poRecord = buildGtecPoRecord(officialScopes, invoiceRecords, allRecs);
                      onCreateOfficialInvoice([...invoiceRecords, poRecord], null); // pass null — no immediate invoicing
                      setShowInvoice(false);
                    }} disabled={!officialReady}
                    style={S.btn({background:officialReady?"#4338ca":"#94a3b8",color:"#fff",gap:6,display:"flex",alignItems:"center",fontWeight:700,cursor:officialReady?"pointer":"not-allowed"})}>
                      📋 Create Invoices + GTEC PO
                    </button>
                    <div style={{fontSize:10,color:"#94a3b8",marginTop:6}}>
                      Creates {invSelectedEmails.size||allInvoiceEmails.length} booker invoice{(invSelectedEmails.size||allInvoiceEmails.length)!==1?"s":""} + 1 combined GTEC PO ·
                      Bookings marked invoiced only when record leaves Draft status.
                    </div>
                  </div>
                </div>
              )}

              {/* Settle pending mismatch billing adjustments (draft mode only) */}
              {invMode==="draft" && isAdmin && invIncludeAdjustments && mismatchAdjustments.length>0 && onMarkAdjustmentSettled && (()=>{
                const visibleAdj = mismatchAdjustments.filter(b=>{
                  const sel=[...invSelectedEmails];
                  return sel.length===0 || sel.some(e=>b.email?.toLowerCase()===e.toLowerCase());
                });
                if (!visibleAdj.length) return null;
                const BILLING_COLOR = { credit_pending:"#ca8a04", invoice_pending:"#2563eb" };
                const SETTLE_LABEL = { credit_pending:"Mark credited", invoice_pending:"Mark invoiced" };
                const SETTLE_STYLE = { credit_pending:{background:"#f0fdf4",color:"#15803d",border:"1px solid #bbf7d0"}, invoice_pending:{background:"#eff6ff",color:"#2563eb",border:"1px solid #bfdbfe"} };
                return (
                  <div style={{background:"#fffbeb",border:"1.5px solid #fde68a",borderRadius:10,padding:"10px 14px",display:"flex",flexDirection:"column",gap:8}}>
                    <div style={{fontSize:12,fontWeight:700,color:"#a16207"}}>⚡ Pending billing adjustments</div>
                    {visibleAdj.map((b,i)=>{
                      const res=parseCpsaResolution(b.system_notes);
                      const bs=res?.billingState||"none";
                      const snap=parseBilledSnapshot(b.system_notes,b.notes);
                      const fac=FACILITIES.find(f=>f.id===b.facility_id);
                      if (bs!=="credit_pending"&&bs!=="invoice_pending") return null;
                      return (
                        <div key={i} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",fontSize:12,background:"#fff",border:"1px solid #fde68a",borderRadius:6,padding:"6px 10px"}}>
                          <span style={{fontWeight:600,color:"#0f172a"}}>{summaryAlias(b.email)}</span>
                          <span style={{color:"#94a3b8"}}>{fmtDate(b.date)} · {fac?.name||b.facility_id}</span>
                          <span style={{fontSize:11,fontWeight:700,color:BILLING_COLOR[bs]}}>{bs==="credit_pending"?"Credit":"Invoice"} pending</span>
                          {snap&&<span style={{color:"#94a3b8",fontSize:11}}>{snap.duration}h → {b.duration}h</span>}
                          <button onClick={()=>onMarkAdjustmentSettled(b, bs==="credit_pending"?"credited":"invoiced")}
                            style={S.btn({...SETTLE_STYLE[bs],fontSize:11,padding:"3px 10px",fontWeight:700,marginLeft:"auto"})}>
                            ✓ {SETTLE_LABEL[bs]}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        );
      })()}
    </div>
  );
}



// One newly-synced CPSA field booking, expandable to reveal the AMUA bookings it
// clashes with (same facility / same time), any simultaneous use of a different
// facility, and the CPSA-review/mismatch status of clashing bookings. Detail is
// computed live against current bookings so it reflects later resolutions.
function SyncedItemRow({ ab, bookings }) {
  const af = FACILITIES.find(x=>x.id===ab.facility_id);
  // Resolve the live booking (by id, else a field-block match) so overlap checks
  // exclude the item itself and stay accurate for older sync-log entries.
  const live = (ab.id && bookings.find(b=>b.id===ab.id))
    || bookings.find(b=>isAdminBooking(b) && b.facility_id===ab.facility_id && b.date===ab.date && b.start_hour===ab.start_hour && b.duration===ab.duration)
    || null;
  const bk = live || ab;
  const others    = bookings.filter(b => b.id!==bk.id && !["cancelled","rejected"].includes(b.status));
  const sameAll   = getSameFacilityOverlaps(bk, others);
  const sameAdmin = sameAll.filter(isAdminBooking);
  const sameUser  = sameAll.filter(b=>!isAdminBooking(b));
  const cross     = getCrossFacilityOverlaps(bk, others).filter(b=>!isAdminBooking(b));
  const mismatched= sameUser.filter(b=>b.status==="cpsa_review_needed");
  const hasIssue  = sameAdmin.length||sameUser.length||cross.length;
  const span  = b => `${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`;
  const badge = (txt,bg,fg,bd) => <span style={{fontSize:9,fontWeight:700,background:bg,color:fg,border:`1px solid ${bd}`,borderRadius:8,padding:"0 5px",whiteSpace:"nowrap"}}>{txt}</span>;
  const block = (bg,bd,children) => <div style={{background:bg,border:`1px solid ${bd}`,borderRadius:6,padding:"5px 8px",display:"flex",flexDirection:"column",gap:2}}>{children}</div>;
  return (
    <details style={{fontSize:11}}>
      <summary style={{color:"#475569",cursor:"pointer",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{width:7,height:7,borderRadius:"50%",background:af?.color||"#94a3b8",flexShrink:0}}/>
        <span>{fmtDate(ab.date)} · {span(ab)} · {af?.name||ab.facility_id}{ab.purpose ? " · "+ab.purpose : ""}</span>
        {sameUser.length>0 && badge(`⚡ ${sameUser.length} clash${sameUser.length!==1?"es":""}`,"#fecdd3","#9f1239","#fda4af")}
        {mismatched.length>0 && badge(`⚠ ${mismatched.length} mismatch${mismatched.length!==1?"es":""}`,"#fde68a","#92400e","#fcd34d")}
        {cross.length>0 && badge(`ℹ ${cross.length} other facility`,"#fef9c3","#854d0e","#fde68a")}
        {!hasIssue && badge("✓ clean","#dcfce7","#166534","#86efac")}
      </summary>
      <div style={{margin:"5px 0 7px 16px",display:"flex",flexDirection:"column",gap:5}}>
        {sameAdmin.length>0 && block("#fef2f2","#fca5a5",<>
          <div style={{fontWeight:700,color:"#b91c1c"}}>🚫 Same facility — other field block{sameAdmin.length!==1?"s":""}</div>
          {sameAdmin.map(b=><div key={b.id} style={{color:"#991b1b"}}>{span(b)} · {b.purpose||"Field block"}</div>)}
        </>)}
        {sameUser.length>0 && block("#fff7ed","#fed7aa",<>
          <div style={{fontWeight:700,color:"#c2410c"}}>⚡ Clashes — AMUA bookings on this facility at the same time</div>
          {sameUser.map(b=>{ const rs=parseMismatchNote(b.system_notes,b.notes); return (
            <div key={b.id} style={{color:"#9a3412"}}>
              <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
                <span>{span(b)} · {b.name||b.email} · {b.purpose||"—"}</span>
                {b.status==="cpsa_review_needed" && badge("⚠ GTEC mismatch","#fde68a","#92400e","#fcd34d")}
                {b.invoiced && badge("invoiced","#e0e7ff","#3730a3","#c7d2fe")}
              </div>
              {rs.length>0 && <div style={{marginLeft:10,color:"#92400e",fontSize:10}}>{rs.map((x,i)=><div key={i}>· {x}</div>)}</div>}
            </div>
          ); })}
        </>)}
        {cross.length>0 && block("#fefce8","#fde68a",<>
          <div style={{fontWeight:700,color:"#854d0e"}}>ℹ Simultaneous use of a different facility</div>
          {cross.map(b=>{ const cf=FACILITIES.find(f=>f.id===b.facility_id); return (
            <div key={b.id} style={{color:"#713f12"}}>{cf?.name||b.facility_id} · {span(b)} · {b.name||b.email}{b.purpose?` · ${b.purpose}`:""}</div>
          ); })}
        </>)}
        {!hasIssue && <div style={{color:"#16a34a",display:"flex",alignItems:"center",gap:5}}><span style={{width:7,height:7,borderRadius:"50%",background:"#22c55e",display:"inline-block"}}/>No clashes or mismatches at this time.</div>}
        {ab.id && !live && <div style={{color:"#94a3b8",fontStyle:"italic"}}>This synced item is no longer in current bookings (removed since sync).</div>}
      </div>
    </details>
  );
}

// ─── Admin Panel with action queue, bulk approve, facility rates ──────────────
function AdminPanel({bookings,onBulkStatusChange,onEdit,onView,onQueueDelete,clashes=[],deleteIds=new Set(),facilityRates={},onClearOldUnapproved,onBulkApply,onSaveMismatch,onInformCpsa,onQueueNotifications,onMarkAdjustmentSettled,loggedInEmail,syncResults=[],onClearSyncResults,showSyncResults=false,onToggleSyncResults,bookerFilter=new Set(),onToggleBooker,onSetBookerFilter,aliasNames={},emailAliases={},pricingConditions=[],onAddPricingCondition,onUpdatePricingCondition,onRemovePricingCondition}) {
  const [showSchedulePanel, setShowSchedulePanel] = useState(false);
  const [showActivityPanel, setShowActivityPanel] = useState(false);
  // Which sync-result months are expanded in the grouped dropdown (monthKey set).
  const [expandedSyncMonths, setExpandedSyncMonths] = useState(()=>new Set());
  const toggleSyncMonth = mk => setExpandedSyncMonths(prev=>{ const s=new Set(prev); s.has(mk)?s.delete(mk):s.add(mk); return s; });
  const adminAlias = em => {
    if (!em) return em;
    const primary = (emailAliases[em.toLowerCase()] || em).toLowerCase();
    return aliasNames[primary] || primary.split("@")[0];
  };
  const [sf,setSf]=useState("all"), [ff,setFf]=useState("all"), [q]=useState("");
  // Booker filter (empty Set = all). Shared with the global header pills so that
  // ALL admin content — queue, table, clashes, mismatches, track-changes — filters
  // to the selected booker(s) at once. Falls back to local state if used unwired.
  const [localBookerFilter,setLocalBookerFilter]=useState(new Set());
  const adminBookerFilter = onSetBookerFilter ? bookerFilter : localBookerFilter;
  const setAdminBookerFilter = onSetBookerFilter || setLocalBookerFilter;
  const toggleAdminBooker = onToggleBooker || (em => setLocalBookerFilter(prev => {
    const s = new Set(prev); const k = em.toLowerCase();
    if (s.has(k)) s.delete(k); else s.add(k);
    return s;
  }));
  // True when a booking's email passes the active booker filter.
  const inBookerFilter = em => adminBookerFilter.size===0 || adminBookerFilter.has((em||"").toLowerCase());
  // Clashes/mismatches narrowed to the active booker filter (drives panels + counts).
  const visibleClashes = clashes.filter(c=>inBookerFilter(c.user?.email));
  const [showBookerFilter,setShowBookerFilter]=useState(false);
  const [adminDateFrom,setAdminDateFrom]=useState(""), [adminDateTo,setAdminDateTo]=useState("");
  const [adminColPurpose,setAdminColPurpose]=useState("");
  const [sortCol,setSortCol]=useState("date"), [sortDir,setSortDir]=useState("desc");
  const [selected,setSelected]=useState(new Set());
  const [bulkNote,setBulkNote]=useState("");
  const [bulkSending,setBulkSending]=useState(false);
  const [bulkStatus,setBulkStatus]=useState("queued_cpsa");
  const [bulkSkipEmail,setBulkSkipEmail]=useState(false);
  const [showClashNotify,setShowClashNotify]=useState(false);
  const [clashNotifyUser,setClashNotifyUser]=useState(null);
  const [showMismatchNotify,setShowMismatchNotify]=useState(false);
  const [mismatchNotifyUser,setMismatchNotifyUser]=useState(null);
  // Per-row action queue: [{id, newStatus}]
  const [actionQueue,setActionQueue]=useState([]);
  const [actionNote,setActionNote]=useState("");
  const [actionSkipEmail,setActionSkipEmail]=useState(false);
  const [actionSending,setActionSending]=useState(false);
  // Clear old unapproved modal
  const [showClearModal,setShowClearModal]=useState(false);
  const [clashGrouped,setClashGrouped]=useState(true);
  const [clashPatternModal,setClashPatternModal]=useState(null);
  const [showClashPanel,setShowClashPanel]=useState(false);
  const [showMismatchPanel,setShowMismatchPanel]=useState(false);
  const [mismatchResState,setMismatchResState]=useState({}); // { [bookingId]: { resolution, billingState } }
  const [mismatchSort,setMismatchSort]=useState({key:"date",dir:"asc"});
  const [showTrackChanges,setShowTrackChanges]=useState(false);
  const [showPricingRules,setShowPricingRules]=useState(false);

  const si={padding:"7px 12px",borderRadius:8,border:"1.5px solid #e2e8f0",fontSize:13,fontFamily:"inherit",color:"#0f172a",background:"#f8fafc",outline:"none"};
  const today=todayKey();

  // Build and persist a mismatch resolution for one booking.
  async function saveMismatchResolution(booking, resolution, billingState, effectiveVals) {
    const reasons = parseMismatchNote(booking.system_notes, booking.notes);
    let sysNotes = booking.system_notes || "";
    const patch = { updated_at: new Date().toISOString() };
    if (resolution === "amended") {
      sysNotes = setCpsaOrig(sysNotes, booking);
      // Apply the per-field effective values (CPSA only where the admin switched that
      // field; ours elsewhere). Falls back to all-CPSA values for legacy callers.
      Object.assign(patch, effectiveVals || extractCpsaAmendValues(reasons, booking), { status: "cpsa_confirmed" });
      sysNotes = stripMismatchNote(sysNotes);
    } else if (resolution === "confirmed") {
      // CPSA verbally confirmed our original is correct: keep our values, mark confirmed, clear the mismatch.
      patch.status = "cpsa_confirmed";
      sysNotes = stripMismatchNote(sysNotes);
    }
    sysNotes = setCpsaResolution(sysNotes, resolution, billingState);
    patch.system_notes = sysNotes;
    const ok = await onSaveMismatch(booking, patch, { reasons: reasons.join(" | "), resolution, billing_state: billingState });
    if (ok !== false) setMismatchResState(prev => { const n={...prev}; delete n[booking.id]; return n; });
  }

  // Invoiced bookings whose current time/duration/field has drifted from the billed
  // snapshot. Framed as the mismatch view does: a costlier kept booking ⇒ deficit owed
  // by the booker, a cheaper one ⇒ credit owed to them (not raw "owing" hours).
  const trackedChanges = bookings
    .filter(b => b.invoiced && inBookerFilter(b.email))
    .map(b => { const d = getBillingDrift(b, facilityRates); return d ? { booking: b, ...d } : null; })
    .filter(Boolean);

  // Old unapproved = bookings in any review state with past dates, excluding mismatches (those need resolution, not deletion)
  const oldUnapproved=bookings.filter(b=>REVIEW_STATUSES.has(b.status)&&b.status!=="cpsa_review_needed"&&b.date<today);

  // Booker chip data
  const adminBookerMap = {};
  bookings.filter(b=>!isAdminBooking(b)&&b.email&&b.name).forEach(b=>{adminBookerMap[b.email.toLowerCase()]=b.name;});
  const adminBookerEmails = Object.keys(adminBookerMap).sort();

  function matchesQ(b) {
    const t=q.toLowerCase();
    return !t||`${b.name} ${b.email} ${b.purpose} ${b.notes||""}`.toLowerCase().includes(t);
  }

  const list=bookings.filter(b=>{
    if(isAdminBooking(b)) return false;
    if(sf!=="all"&&b.status!==sf) return false;
    if(ff!=="all"&&b.facility_id!==ff) return false;
    if(adminBookerFilter.size>0&&!adminBookerFilter.has(b.email?.toLowerCase())) return false;
    if(adminDateFrom&&b.date<adminDateFrom) return false;
    if(adminDateTo&&b.date>adminDateTo) return false;
    if(adminColPurpose&&!(b.purpose||"").toLowerCase().includes(adminColPurpose.toLowerCase())) return false;
    return true;
  }).sort((a,b)=>{
    const dir=sortDir==="asc"?1:-1;
    if(sortCol==="date") return dir*(a.date.localeCompare(b.date)||a.start_hour-b.start_hour);
    if(sortCol==="name") return dir*(a.name||"").localeCompare(b.name||"");
    if(sortCol==="facility") return dir*(a.facility_id||"").localeCompare(b.facility_id||"");
    if(sortCol==="status") return dir*(a.status||"").localeCompare(b.status||"");
    return dir*(new Date(b.created_at)-new Date(a.created_at));
  });

  function toggleSort(col) {
    if(sortCol===col) setSortDir(d=>d==="asc"?"desc":"asc");
    else { setSortCol(col); setSortDir("asc"); }
  }
  const sortArrow = (col) => sortCol===col ? (sortDir==="asc"?" ↑":" ↓") : "";

  const pendingList = list.filter(b=>REVIEW_STATUSES.has(b.status));
  const allSelected = pendingList.length>0 && pendingList.every(b=>selected.has(b.id));

  function toggleSelect(id) {
    setSelected(s=>{ const ns=new Set(s); ns.has(id)?ns.delete(id):ns.add(id); return ns; });
  }
  function toggleAll() {
    if(allSelected) setSelected(s=>{ const ns=new Set(s); pendingList.forEach(b=>ns.delete(b.id)); return ns; });
    else setSelected(s=>{ const ns=new Set(s); pendingList.forEach(b=>ns.add(b.id)); return ns; });
  }

  // Toggle a booking in/out of the per-row action queue
  function queueAction(id, newStatus) {
    setActionQueue(prev=>{
      const existing=prev.find(a=>a.id===id);
      if(existing && existing.newStatus===newStatus) return prev.filter(a=>a.id!==id); // toggle off
      return [...prev.filter(a=>a.id!==id), {id, newStatus}];
    });
  }

  async function submitActionQueue() {
    if(!actionQueue.length) return;
    setActionSending(true);
    try{
      const byStatus = {};
      actionQueue.forEach(a => {
        if(!byStatus[a.newStatus]) byStatus[a.newStatus] = [];
        byStatus[a.newStatus].push(a.id);
      });
      for(const [status, ids] of Object.entries(byStatus)) {
        await onBulkStatusChange(ids, status, actionNote, actionSkipEmail);
      }
      setActionQueue([]); setActionNote("");
    } finally { setActionSending(false); }
  }

  // Queue clash notifications into the cart (one per affected booker); emails go
  // out only when the cart is submitted.
  function handleSendClashEmails(targetEmail) {
    const byUser = {};
    clashes.forEach(c => {
      const email = c.user.email?.toLowerCase();
      if (!email) return;
      if (!byUser[email]) byUser[email] = { name: c.user.name, clashes: [] };
      byUser[email].clashes.push(c);
    });
    const entries = targetEmail
      ? (byUser[targetEmail] ? [[targetEmail, byUser[targetEmail]]] : [])
      : Object.entries(byUser);
    const items = entries.map(([email, { name, clashes: uc }]) => ({
      clashNotify:true, notifyOnly:true, email, name, clashes: uc,
    }));
    onQueueNotifications?.(items, "clash notification");
    setShowClashNotify(false); setClashNotifyUser(null);
  }

  // Queue mismatch notifications into the cart (one per affected booker). Reuses the
  // cpsa_review_needed notify path, so the cart submit sends the proper amber email.
  function handleSendMismatchEmails(targetEmail) {
    const byUser = {};
    bookings.filter(b => b.status === "cpsa_review_needed" && !isAdminBooking(b) && inBookerFilter(b.email)).forEach(b => {
      const email = b.email?.toLowerCase();
      if (!email) return;
      if (!byUser[email]) byUser[email] = { name: b.name, bkgs: [] };
      byUser[email].bkgs.push(b);
    });
    const entries = targetEmail
      ? (byUser[targetEmail] ? [[targetEmail, byUser[targetEmail]]] : [])
      : Object.entries(byUser);
    const items = entries.map(([email, { name, bkgs }]) => ({
      notifyOnly:true, newStatus:"cpsa_review_needed", email, name, drafts: bkgs,
    }));
    onQueueNotifications?.(items, "mismatch notification");
    setShowMismatchNotify(false); setMismatchNotifyUser(null);
  }

  async function handleBulkAction() {
    const ids=[...selected].filter(id=>bookings.find(b=>b.id===id));
    if(ids.length===0) return;
    setBulkSending(true);
    try {
      await onBulkStatusChange(ids, bulkStatus, bulkNote, bulkSkipEmail);
      setSelected(new Set()); setBulkNote("");
    } finally { setBulkSending(false); }
  }

  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Top action bar */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        {oldUnapproved.length>0&&(
          <button onClick={()=>setShowClearModal(true)} style={S.btn({background:"#7c3aed",color:"#fff",fontWeight:700,fontSize:12})}>
            🧹 Clear old unapproved ({oldUnapproved.length})
          </button>
        )}
        <button onClick={()=>setShowSchedulePanel(v=>!v)} style={S.btn({background:showSchedulePanel?"#f0f9ff":"#fff",color:"#0369a1",border:`1.5px solid ${showSchedulePanel?"#7dd3fc":"#bae6fd"}`,fontSize:12,fontWeight:700})}>
          📅 Schedule {showSchedulePanel?"▴":"▾"}
        </button>
        <button onClick={()=>setShowActivityPanel(v=>!v)} style={S.btn({background:showActivityPanel?"#f8fafc":"#fff",color:"#475569",border:`1.5px solid ${showActivityPanel?"#94a3b8":"#e2e8f0"}`,fontSize:12,fontWeight:700})}>
          📜 Activity Log {showActivityPanel?"▴":"▾"}
        </button>
        {<button onClick={onToggleSyncResults} style={S.btn({background:showSyncResults?"#ecfeff":"#fff",color:syncResults.length>0?"#0e7490":"#94a3b8",border:`1.5px solid ${showSyncResults?"#a5f3fc":"#e2e8f0"}`,fontSize:12,fontWeight:syncResults.length>0?700:500})}>
          🔄 Sync Results ({syncResults.length}) {showSyncResults?"▴":"▾"}
        </button>}
        <button onClick={()=>setShowClashPanel(v=>!v)} style={S.btn({border:`1.5px solid ${visibleClashes.length>0?"#fda4af":"#e2e8f0"}`,background:showClashPanel?"#fff1f2":"#fff",color:visibleClashes.length>0?"#9f1239":"#94a3b8",fontSize:12,fontWeight:visibleClashes.length>0?700:500})}>
          ⚠️ Clashes ({visibleClashes.length}) {showClashPanel?"▴":"▾"}
        </button>
        {(()=>{ const mc=bookings.filter(b=>b.status==="cpsa_review_needed"&&!isAdminBooking(b)&&inBookerFilter(b.email)).length; return (
        <button onClick={()=>setShowMismatchPanel(v=>!v)} style={S.btn({border:`1.5px solid ${mc>0?"#fde68a":"#e2e8f0"}`,background:showMismatchPanel?"#fffbeb":"#fff",color:mc>0?"#b45309":"#94a3b8",fontSize:12,fontWeight:mc>0?700:500})}>
          ⚡ Mismatches ({mc}) {showMismatchPanel?"▴":"▾"}
        </button>
        );})()}
        <button onClick={()=>setShowTrackChanges(v=>!v)} style={S.btn({border:`1.5px solid ${trackedChanges.length>0?"#ddd6fe":"#e2e8f0"}`,background:showTrackChanges?"#f5f3ff":"#fff",color:trackedChanges.length>0?"#5b21b6":"#94a3b8",fontSize:12,fontWeight:trackedChanges.length>0?700:500})}>
          🧾 Track Changes ({trackedChanges.length}) {showTrackChanges?"▴":"▾"}
        </button>
        {onAddPricingCondition&&<button onClick={()=>setShowPricingRules(v=>!v)} style={S.btn({border:`1.5px solid ${pricingConditions.length>0?"#c7d2fe":"#e2e8f0"}`,background:showPricingRules?"#eef2ff":"#fff",color:pricingConditions.length>0?"#4338ca":"#94a3b8",fontSize:12,fontWeight:pricingConditions.length>0?700:500})}>
          💲 Pricing Rules ({pricingConditions.length}) {showPricingRules?"▴":"▾"}
        </button>}
      </div>

      {/* Inline sync results panel */}
      {showSyncResults&&(
        <div style={{background:"#ecfeff",border:"1.5px solid #a5f3fc",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:8}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
            <span style={{fontWeight:700,fontSize:14,color:"#0e7490"}}>🔄 GTEC Sync Results</span>
            <span style={{fontSize:11,color:"#0891b2",marginLeft:"auto"}}>{syncResults.length>0?`${syncResults.length} month${syncResults.length!==1?"s":""} · grouped by month, tap to expand`:"No sync results yet"}</span>
            {onClearSyncResults&&syncResults.length>0&&<button onClick={onClearSyncResults} style={{padding:"3px 10px",borderRadius:6,border:"1px solid #a5f3fc",background:"#fff",color:"#0e7490",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Clear all</button>}
          </div>
          {(()=>{
            // Emphasise sync runs that surfaced new clashes or mismatches — these need action.
            const totClash = syncResults.reduce((s,r)=>s+(r.clashes||0),0);
            const totMis = syncResults.reduce((s,r)=>s+(r.cpsaReviewNeeded||0),0);
            if(totClash+totMis===0) return null;
            return (
              <div style={{background:"#fff7ed",border:"1.5px solid #fdba74",borderRadius:8,padding:"8px 12px",display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",fontSize:12,color:"#9a3412"}}>
                <span style={{fontWeight:700}}>🚩 New issues from sync —</span>
                {totClash>0&&<button onClick={()=>setShowClashPanel(true)} style={{cursor:"pointer",fontWeight:700,fontSize:11,background:"#fecdd3",color:"#9f1239",border:"1px solid #fda4af",borderRadius:10,padding:"2px 8px",fontFamily:"inherit"}}>⚡ {totClash} new clash{totClash!==1?"es":""}</button>}
                {totMis>0&&<button onClick={()=>setShowMismatchPanel(true)} style={{cursor:"pointer",fontWeight:700,fontSize:11,background:"#fde68a",color:"#92400e",border:"1px solid #fcd34d",borderRadius:10,padding:"2px 8px",fontFamily:"inherit"}}>⚠ {totMis} new mismatch{totMis!==1?"es":""}</button>}
                <span style={{fontWeight:500}}>— open the relevant panel to action them.</span>
              </div>
            );
          })()}
          {syncResults.length===0&&(
            <div style={{background:"#fff",border:"1px dashed #a5f3fc",borderRadius:8,padding:"14px",fontSize:12,color:"#64748b",textAlign:"center"}}>
              No GTEC syncs have run yet. Use <strong>Sync GTEC</strong> to pull the latest feed — results will appear here grouped by month.
            </div>
          )}
          {/* Group by month (newest first); each month collapses to a one-line summary
              and expands to the full breakdown + date of the latest exact new change. */}
          {[...syncResults].sort((a,b)=>(b.monthKey||"").localeCompare(a.monthKey||"")).map(r=>{
            const changeCount = (r.added||0)+(r.cpsaConfirmed||0)+(r.cpsaReviewNeeded||0)+(r.removed||0)+(r.clashes||0);
            const hasChanges = changeCount > 0;
            // Months that surfaced new clashes/mismatches are emphasised (tinted card + badges).
            const attention = !r.error && ((r.clashes||0)>0 || (r.cpsaReviewNeeded||0)>0);
            const open = expandedSyncMonths.has(r.monthKey);
            const fmt = iso => iso ? new Date(iso).toLocaleString("en-NZ",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}) : "—";
            return (
              <div key={r.monthKey} style={{background:attention?"#fff7ed":"#fff",border:`${attention?"1.5px":"1px"} solid ${r.error?"#fecaca":attention?"#fb923c":hasChanges?"#7dd3fc":"#cffafe"}`,borderRadius:8,overflow:"hidden"}}>
                <button onClick={()=>toggleSyncMonth(r.monthKey)} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 14px",background:"transparent",border:"none",cursor:"pointer",fontFamily:"inherit",textAlign:"left",flexWrap:"wrap"}}>
                  <span style={{fontSize:11,color:"#0891b2",width:12,flexShrink:0}}>{open?"▾":"▸"}</span>
                  <span style={{fontWeight:700,fontSize:12,color:r.error?"#b91c1c":"#0c4a6e"}}>{r.label}</span>
                  {r.error
                    ? <span style={{fontSize:10,fontWeight:700,background:"#fecaca",color:"#b91c1c",borderRadius:10,padding:"1px 6px"}}>error</span>
                    : hasChanges
                      ? <span style={{fontSize:10,fontWeight:700,background:"#0ea5e9",color:"#fff",borderRadius:10,padding:"1px 6px"}}>{changeCount} change{changeCount!==1?"s":""}</span>
                      : <span style={{fontSize:10,fontWeight:600,color:"#94a3b8"}}>no new changes</span>}
                  {(r.clashes||0)>0&&<span style={{fontSize:10,fontWeight:700,background:"#fecdd3",color:"#9f1239",borderRadius:10,padding:"1px 6px"}}>⚡ {r.clashes} new clash{r.clashes!==1?"es":""}</span>}
                  {(r.cpsaReviewNeeded||0)>0&&<span style={{fontSize:10,fontWeight:700,background:"#fde68a",color:"#92400e",borderRadius:10,padding:"1px 6px"}}>⚠ {r.cpsaReviewNeeded} new mismatch{r.cpsaReviewNeeded!==1?"es":""}</span>}
                  <span style={{fontSize:10,color:"#94a3b8",marginLeft:"auto"}}>{r.syncedAt?new Date(r.syncedAt).toLocaleString("en-NZ",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"—"}</span>
                </button>
                {open&&(
                  <div style={{padding:"0 14px 10px 38px"}}>
                    {r.error
                      ? <div style={{fontSize:12,color:"#b91c1c"}}>⚠ {r.error}</div>
                      : <div style={{display:"flex",flexDirection:"column",gap:3,paddingLeft:12,borderLeft:"2px solid #e0f2fe"}}>
                          {[
                            r.added>0 && ((r.addedBookings&&r.addedBookings.length)
                              ? <details><summary style={{color:"#0e7490",fontSize:12,cursor:"pointer"}}>＋ <strong>{r.added}</strong> booking{r.added!==1?"s":""} added <span style={{color:"#94a3b8",fontWeight:400}}>· expand each for clashes / mismatches</span></summary>
                                  <div style={{margin:"4px 0 2px 14px",display:"flex",flexDirection:"column",gap:3}}>
                                    {r.addedBookings.map((ab,abi)=><SyncedItemRow key={ab.id||abi} ab={ab} bookings={bookings}/>)}
                                  </div>
                                </details>
                              : <span style={{color:"#0e7490",fontSize:12}}>＋ <strong>{r.added}</strong> booking{r.added!==1?"s":""} added</span>),
                            r.skipped>0 && <span style={{color:"#64748b",fontSize:12}}>— <strong>{r.skipped}</strong> already existed</span>,
                            r.cpsaConfirmed>0 && <span style={{color:"#0891b2",fontSize:12}}>🌐 <strong>{r.cpsaConfirmed}</strong> GTEC-confirmed</span>,
                            r.cpsaReviewNeeded>0 && <span style={{color:"#b45309",fontSize:12}}>⚠ <strong>{r.cpsaReviewNeeded}</strong> need review</span>,
                            r.clashes>0 && <span style={{color:"#c2410c",fontSize:12}}>⚡ <strong>{r.clashes}</strong> clash{r.clashes!==1?"es":""} flagged</span>,
                            r.notified>0 && <span style={{color:"#7c3aed",fontSize:12}}>📧 <strong>{r.notified}</strong> queued to notify</span>,
                            r.removed>0 && <span style={{color:"#94a3b8",fontSize:12}}>✕ <strong>{r.removed}</strong> stale removed</span>,
                            !hasChanges && <span style={{color:"#94a3b8",fontSize:12,fontStyle:"italic"}}>No new changes in the latest sync.</span>,
                          ].filter(Boolean).map((el,i)=><div key={i}>{el}</div>)}
                          <div style={{marginTop:5,fontSize:11,color:"#64748b"}}>🕑 Latest new change: <strong>{r.lastChangeAt?fmt(r.lastChangeAt):"none yet"}</strong></div>
                          <div style={{fontSize:11,color:"#94a3b8"}}>Last checked: {fmt(r.syncedAt)}</div>
                        </div>
                    }
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Schedule Summary — inline */}
      {showSchedulePanel && (
        <ScheduleSummaryModal bookings={bookings.filter(b=>inBookerFilter(b.email))} isAdmin={true} loggedInEmail={loggedInEmail} onBulkApply={onBulkApply} onBulkStatusChange={onBulkStatusChange} aliasNames={aliasNames} emailAliases={emailAliases} inline onClose={()=>setShowSchedulePanel(false)}/>
      )}

      {/* Activity Log — inline */}
      {showActivityPanel && (
        <ActivityLogModal inline onClose={()=>setShowActivityPanel(false)}/>
      )}

      {/* Track-changes panel: invoiced bookings whose billed dimensions drifted */}
      {showTrackChanges&&(
        <div style={{background:"#f5f3ff",border:"1.5px solid #ddd6fe",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:10}}>
          <div style={{fontWeight:700,fontSize:14,color:"#5b21b6"}}>🧾 Billed-booking changes</div>
          {trackedChanges.length===0
            ? <div style={{fontSize:12,color:"#7c6aa8"}}>No changes detected since invoicing. Edits to an invoiced booking's time, duration or field appear here as a deficit (kept booking costs more than billed) or a credit (costs less).</div>
            : <div style={{display:"flex",flexDirection:"column",gap:8,maxHeight:360,overflowY:"auto"}}>
                {trackedChanges.map(({booking:b,rows,hoursDelta,costDelta,billedCost,currentCost},i)=>{
                  const cpsaRes = parseCpsaResolution(b.system_notes);
                  const isCpsaAmend = cpsaRes?.resolution === "amended";
                  const billingState = cpsaRes?.billingState || "none";
                  const BILLING_COLOR = { credit_pending:"#ca8a04", invoice_pending:"#2563eb", credited:"#15803d", invoiced:"#5b21b6", none:"#64748b" };
                  const BILLING_LABEL = { credit_pending:"Credit pending", invoice_pending:"Invoice pending", credited:"Credited ✓", invoiced:"Invoiced ✓", none:"—" };
                  return (
                    <div key={i} style={{background:"#fff",border:`1px solid ${isCpsaAmend?"#fde68a":"#e9d5ff"}`,borderRadius:8,padding:"8px 12px",fontSize:12}}>
                      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:6}}>
                        <EmailChip email={b.email}/>
                        <span style={{fontWeight:600,color:"#0f172a"}}>{b.name}</span>
                        <span style={{color:"#94a3b8"}}>{fmtDate(b.date)} · {b.purpose}</span>
                        {isCpsaAmend&&<span style={{fontSize:10,fontWeight:700,background:"#fef9c3",color:"#a16207",border:"1px solid #fde68a",borderRadius:4,padding:"1px 5px"}}>⚠ GTEC amendment</span>}
                        {(()=>{
                          // Hours change is neutral context; the financial verdict mirrors the
                          // mismatch view — deficit (booker under-billed) vs credit (over-billed).
                          const hrsLabel = hoursDelta>0?`+${hoursDelta}h`:hoursDelta<0?`−${Math.abs(hoursDelta)}h`:"field changed";
                          const credit  = billingState==="credit_pending"||billingState==="credited"||(billingState==="none"&&costDelta<0);
                          const deficit = billingState==="invoice_pending"||billingState==="invoiced"||(billingState==="none"&&costDelta>0);
                          const amt = (costDelta!=null&&costDelta!==0)?fmtCost(Math.abs(costDelta)):null;
                          return (
                            <span style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                              <span style={{fontWeight:600,fontSize:11,color:"#64748b",whiteSpace:"nowrap"}}>{hrsLabel}</span>
                              {(credit||deficit)&&(
                                <span title={deficit
                                    ? `${b.name||"Booker"} in deficit${amt?` ${amt}`:""} from invoice — billed ${fmtCost(billedCost)}, kept booking now costs ${fmtCost(currentCost)}.`
                                    : `Credit${amt?` ${amt}`:""} owed to ${b.name||"the booker"} — billed ${fmtCost(billedCost)}, kept booking now costs ${fmtCost(currentCost)}.`}
                                  style={{fontWeight:800,fontSize:12,color:deficit?"#dc2626":"#15803d",background:deficit?"#fef2f2":"#f0fdf4",border:`1px solid ${deficit?"#fecaca":"#bbf7d0"}`,borderRadius:6,padding:"2px 8px",whiteSpace:"nowrap"}}>
                                  {deficit?`📨 Deficit${amt?` ${amt}`:""}`:`💚 Credit${amt?` ${amt}`:""}`}
                                </span>
                              )}
                            </span>
                          );
                        })()}
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"auto auto auto auto",gap:"2px 10px",alignItems:"center",marginBottom:isCpsaAmend?6:0}}>
                        {rows.map((p,ri)=>(<Fragment key={ri}>
                          <span style={{fontWeight:600,color:"#5b21b6"}}>{p.label}</span>
                          <span style={{color:"#6b7280"}}>{p.old}</span>
                          <span style={{color:"#a78bfa"}}>→</span>
                          <span style={{color:"#0f172a",fontWeight:600}}>{p.next}</span>
                        </Fragment>))}
                      </div>
                      {isCpsaAmend&&(
                        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",borderTop:"1px solid #fde68a",paddingTop:6,marginTop:2}}>
                          <span style={{fontSize:11,color:BILLING_COLOR[billingState],fontWeight:700}}>{BILLING_LABEL[billingState]}</span>
                          {cpsaRes?.date&&<span style={{fontSize:10,color:"#94a3b8"}} title="When this GTEC resolution was last logged / updated">🕗 logged {fmtLoggedAt(cpsaRes.date)}</span>}
                          {billingState==="credit_pending"&&onMarkAdjustmentSettled&&(
                            <button onClick={()=>onMarkAdjustmentSettled(b,"credited")}
                              style={S.btn({background:"#f0fdf4",color:"#15803d",border:"1px solid #bbf7d0",fontSize:11,padding:"3px 10px",fontWeight:700})}>✓ Mark credited</button>
                          )}
                          {billingState==="invoice_pending"&&onMarkAdjustmentSettled&&(
                            <button onClick={()=>onMarkAdjustmentSettled(b,"invoiced")}
                              style={S.btn({background:"#eff6ff",color:"#2563eb",border:"1px solid #bfdbfe",fontSize:11,padding:"3px 10px",fontWeight:700})}>✓ Mark invoiced</button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
          }
        </div>
      )}

      {showPricingRules&&onAddPricingCondition&&(
        <PricingConditionsManager
          conditions={pricingConditions}
          bookers={[...new Map(bookings.filter(b=>!isAdminBooking(b)&&b.email).map(b=>[b.email.toLowerCase(),{email:b.email.toLowerCase(),label:aliasNames[b.email.toLowerCase()]||b.name||b.email}])).values()].sort((a,b)=>a.label.localeCompare(b.label))}
          onAdd={onAddPricingCondition} onUpdate={onUpdatePricingCondition} onRemove={onRemovePricingCondition}
          aliasFor={em=>aliasNames[(em||"").toLowerCase()]}/>
      )}
      {/* Per-row action queue submission panel */}
      {actionQueue.length>0&&(
        <div style={{background:"#f0fdf4",border:"1.5px solid #86efac",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:10}}>
          <div style={{fontWeight:700,fontSize:14,color:"#166534"}}>
            📋 Action Queue — {[
              actionQueue.filter(a=>a.newStatus==="queued_cpsa").length && `${actionQueue.filter(a=>a.newStatus==="queued_cpsa").length} queue for GTEC`,
              actionQueue.filter(a=>a.newStatus==="approved").length && `${actionQueue.filter(a=>a.newStatus==="approved").length} GTEC approved`,
              actionQueue.filter(a=>a.newStatus==="rejected").length && `${actionQueue.filter(a=>a.newStatus==="rejected").length} reject`,
            ].filter(Boolean).join(", ") || "empty"}
            <button onClick={()=>setActionQueue([])} style={{...S.btn({border:"1px solid #86efac",background:"transparent",color:"#166534",fontSize:11,padding:"2px 8px"}),marginLeft:12}}>Clear</button>
          </div>
          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <input style={{...si,flex:1,minWidth:200}} placeholder="Optional note for emails…" value={actionNote} onChange={e=>setActionNote(e.target.value)}/>
            <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:12,color:"#475569",flexShrink:0}}>
              <input type="checkbox" checked={actionSkipEmail} onChange={e=>setActionSkipEmail(e.target.checked)} style={{width:14,height:14,accentColor:"#0f172a"}}/>
              Don&apos;t email bookers for this action
            </label>
            <button onClick={submitActionQueue} disabled={actionSending}
              style={S.btn({background:"#166534",color:"#fff",fontWeight:700,opacity:actionSending?0.6:1})}>
              {actionSending?"Adding…":`Add ${actionQueue.length} action${actionQueue.length>1?"s":""} to cart`}
            </button>
          </div>
        </div>
      )}

      {/* Bulk selection action panel */}
      {pendingList.length>0&&(
        <div style={{background:"#f8fafc",border:"1.5px solid #e2e8f0",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:12}}>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:13,fontWeight:600,color:"#0f172a"}}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{width:16,height:16,accentColor:"#0f172a"}}/>
              Select all pending ({pendingList.length})
            </label>
            <span style={{fontSize:13,color:"#64748b"}}>{selected.size} selected</span>
          </div>
          {selected.size>0&&(
            <>
              <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                <select style={si} value={bulkStatus} onChange={e=>setBulkStatus(e.target.value)}>
                  <option value="queued_cpsa">Queue for GTEC</option>
                  <option value="approved">GTEC Approved</option>
                  <option value="rejected">Reject</option>
                </select>
                <input style={{...si,flex:1,minWidth:200}} placeholder="Optional note to include in email…" value={bulkNote} onChange={e=>setBulkNote(e.target.value)}/>
                <button onClick={handleBulkAction} disabled={bulkSending}
                  style={S.btn({background:bulkStatus==="rejected"?"#f43f5e":bulkStatus==="approved"?"#22c55e":"#3b82f6",color:"#fff",opacity:bulkSending?0.6:1})}>
                  {bulkSending?"Adding…":`Add ${selected.size} to cart`}
                </button>
              </div>
              <label style={{display:"flex",alignItems:"center",gap:8,cursor:"pointer",fontSize:12,color:"#64748b"}}>
                <input type="checkbox" checked={bulkSkipEmail} onChange={e=>setBulkSkipEmail(e.target.checked)} style={{width:14,height:14,accentColor:"#0f172a"}}/>
                Don&apos;t email bookers for this action
              </label>
            </>
          )}
        </div>
      )}

      {/* Clash notification panel */}
      {showClashPanel&&visibleClashes.length>0&&(()=>{
        function clashDayName(d){return["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(d+"T12:00").getDay()];}
        const filtered=visibleClashes.filter(c=>matchesQ(c.user)||matchesQ(c.admin));
        // Group by (userEmail + facilityId + dayOfWeek)
        const groupMap={};
        filtered.forEach(c=>{
          const dn=clashDayName(c.admin.date);
          const key=`${c.user.email}||${c.admin.facility_id}||${dn}`;
          if(!groupMap[key]) groupMap[key]={user:c.user,admin:c.admin,dn,instances:[],userBkgs:[]};
          groupMap[key].instances.push(c);
          if(!groupMap[key].userBkgs.find(b=>b.id===c.user.id)) groupMap[key].userBkgs.push(c.user);
        });
        const groups=Object.values(groupMap);
        const recurringGroups=groups.filter(g=>g.instances.length>=2);
        return (
          <div style={{background:"#fff1f2",border:"1.5px solid #fda4af",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"space-between",flexWrap:"wrap"}}>
              <div>
                <span style={{fontWeight:700,fontSize:14,color:"#9f1239"}}>⚠️ {visibleClashes.length} scheduling clash{visibleClashes.length>1?"es":""} detected</span>
                {recurringGroups.length>0&&<span style={{marginLeft:8,fontSize:12,fontWeight:600,background:"#fda4af",color:"#9f1239",borderRadius:6,padding:"1px 7px"}}>{recurringGroups.length} recurring</span>}
                <div style={{fontSize:12,color:"#be123c",marginTop:2}}>Future field bookings overlap with user bookings.</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <label style={{display:"flex",alignItems:"center",gap:5,fontSize:12,cursor:"pointer",color:"#9f1239"}}>
                  <input type="checkbox" checked={clashGrouped} onChange={e=>setClashGrouped(e.target.checked)} style={{accentColor:"#f43f5e"}}/>
                  Group recurring
                </label>
                <button onClick={()=>setShowClashNotify(true)}
                  style={S.btn({background:"#f43f5e",color:"#fff",fontWeight:700})}>
                  📧 Notify affected users
                </button>
              </div>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:260,overflowY:"auto"}}>
              {clashGrouped
                ? groups.map((g,i)=>{
                    const fa=FACILITIES.find(x=>x.id===g.admin.facility_id);
                    const isRecurring=g.instances.length>=2;
                    return (
                      <div key={i} style={{background:"#fff",border:`1px solid ${isRecurring?"#f43f5e44":"#fecdd3"}`,borderRadius:8,padding:"8px 12px",fontSize:12,color:"#0f172a",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                        {isRecurring&&<span style={{fontWeight:700,color:"#f43f5e",fontSize:11,background:"#fff1f2",borderRadius:4,padding:"1px 6px",whiteSpace:"nowrap"}}>×{g.instances.length} recurring</span>}
                        <span style={{fontWeight:700,color:"#9f1239"}}>🔒 {g.admin.purpose||"Admin booking"}</span>
                        <span style={{color:"#94a3b8"}}>vs</span>
                        <EmailChip email={g.user.email}/>
                        <span style={{color:"#475569"}}>{g.user.purpose||"User booking"}</span>
                        <span style={{color:"#94a3b8",marginLeft:"auto",fontSize:11}}>{fa?.name} · {g.dn} ~{fmtTime(g.admin.start_hour)}</span>
                        {isRecurring&&(
                          <button onClick={()=>setClashPatternModal({email:g.user.email,name:g.user.name||g.user.email,pk:`${g.dn}_${g.admin.start_hour}`,bkgs:g.userBkgs,canEdit:true})}
                            style={S.btn({background:"#f43f5e",color:"#fff",fontSize:11,padding:"3px 8px"})}>
                            Resolve recurring
                          </button>
                        )}
                      </div>
                    );
                  })
                : filtered.map((c,i)=>{
                    const fa=FACILITIES.find(x=>x.id===c.admin.facility_id);
                    return(
                      <div key={i} style={{background:"#fff",border:"1px solid #fecdd3",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#0f172a",display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                        <span style={{fontWeight:700,color:"#9f1239"}}>🔒 {c.admin.purpose||"Admin booking"}</span>
                        <span style={{color:"#94a3b8"}}>vs</span>
                        <EmailChip email={c.user.email}/>
                        <span style={{color:"#475569"}}>{c.user.purpose||"User booking"}</span>
                        <span style={{color:"#94a3b8",marginLeft:"auto"}}>{fa?.name} · {fmtDate(c.admin.date)} {fmtTime(c.admin.start_hour)}–{fmtTime(c.admin.start_hour+c.admin.duration)}</span>
                      </div>
                    );
                  })
              }
            </div>
            {clashPatternModal&&(
              <PatternModal {...clashPatternModal} isAdmin={true}
                onClose={()=>setClashPatternModal(null)}
                onBulkApply={args=>{onBulkApply&&onBulkApply(args);setClashPatternModal(null);}}/>
            )}
          </div>
        );
      })()}

      {/* Mismatch triage panel */}
      {showMismatchPanel&&(()=>{
        const rawMismatches=bookings.filter(b=>b.status==="cpsa_review_needed"&&!isAdminBooking(b)&&inBookerFilter(b.email));
        const sortKey=mismatchSort.key, sortDir=mismatchSort.dir;
        const facName = id => FACILITIES.find(f=>f.id===id)?.name || id;
        const valOf = (b, k) => {
          switch (k) {
            case "name": return (b.name||"").toLowerCase();
            case "date": return b.date||"";
            case "facility": return facName(b.facility_id).toLowerCase();
            case "time": return b.start_hour;
            case "duration": return b.duration;
            default: return "";
          }
        };
        const mismatches=[...rawMismatches].sort((a,b)=>{
          const av=valOf(a,sortKey), bv=valOf(b,sortKey);
          if (av<bv) return sortDir==="asc"?-1:1;
          if (av>bv) return sortDir==="asc"?1:-1;
          // tie-breaker: date asc
          if (a.date<b.date) return -1;
          if (a.date>b.date) return 1;
          return 0;
        });
        function toggleSort(key) {
          setMismatchSort(prev => prev.key===key
            ? {key, dir: prev.dir==="asc"?"desc":"asc"}
            : {key, dir:"asc"});
        }
        const thS2={padding:"7px 10px",textAlign:"left",fontWeight:700,color:"#92400e",whiteSpace:"nowrap",borderBottom:"1px solid #fde68a",fontSize:11,textTransform:"uppercase",letterSpacing:"0.04em"};
        const tdS2={padding:"7px 10px",borderBottom:"1px solid #fde68a",verticalAlign:"top"};

        // Derive overall resolution from per-field selections.
        // Returns "amended"|"to_correct"|"pending"
        function deriveResolution(changedFields, fieldSel) {
          if (!changedFields.length) return "to_correct";
          const allSelected=changedFields.every(f=>fieldSel[f]);
          if (!allSelected) return "pending";
          const allOurs=changedFields.every(f=>fieldSel[f]==="ours");
          return allOurs?"to_correct":"amended";
        }

        // Rich HTML email for clipboard, plain text fallback.
        async function copyEmailFormat() {
          const dateStr = new Date().toLocaleDateString("en-NZ",{day:"numeric",month:"long",year:"numeric"});
          // Pills reflect the DIRECTION of the current (unsaved) per-field selection:
          //  • kept ours → GTEC must change their record   → "GTEC to update"
          //  • took GTEC → our booking is amended to match  → "BOOKER to acknowledge"
          const PILL_GTEC   = `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#dbeafe;color:#1e3a8a;border:1px solid #93c5fd;font-size:10px;font-weight:700;white-space:nowrap">GTEC to update</span>`;
          const PILL_BOOKER = `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#ffedd5;color:#9a3412;border:1px solid #fdba74;font-size:10px;font-weight:700;white-space:nowrap">BOOKER to acknowledge</span>`;
          // Changed fields between our booking and GTEC's record, with display strings.
          function changedFieldsOf(b, cv) {
            const fac=FACILITIES.find(x=>x.id===b.facility_id);
            const cfac=FACILITIES.find(x=>x.id===cv.facility_id);
            const list=[];
            if (cv.facility_id!==b.facility_id) list.push({key:"facility",label:"Field",our:fac?.name||b.facility_id,gtec:cfac?.name||cv.facility_id});
            if (cv.start_hour!==b.start_hour)   list.push({key:"time",label:"Time",our:`${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`,gtec:`${fmtTime(cv.start_hour)}–${fmtTime(cv.start_hour+cv.duration)}`});
            if (cv.duration!==b.duration)       list.push({key:"duration",label:"Dur",our:`${b.duration}h`,gtec:`${cv.duration}h`});
            return list;
          }
          // Changes cell reflects the admin's current (unsaved) selections from mismatchResState.
          function changesHtml(b, cv) {
            const sel=(mismatchResState[b.id]?.fieldSel)||{};
            const fields=changedFieldsOf(b, cv);
            if(!fields.length) return `<span style="color:#94a3b8">—</span>`;
            return fields.map(f=>{
              const s=sel[f.key];
              if(s==="ours") return `<div style="margin:2px 0"><strong>${f.label}:</strong> ${f.gtec} → <span style="color:#1e3a8a;font-weight:700">${f.our}</span>${PILL_GTEC}</div>`;
              if(s==="cpsa") return `<div style="margin:2px 0"><strong>${f.label}:</strong> ${f.our} → <span style="color:#9a3412;font-weight:700">${f.gtec}</span>${PILL_BOOKER}</div>`;
              return `<div style="margin:2px 0;color:#64748b"><strong>${f.label}:</strong> ${f.our} → ${f.gtec}</div>`;
            }).join("");
          }
          function changesText(b, cv) {
            const sel=(mismatchResState[b.id]?.fieldSel)||{};
            return changedFieldsOf(b, cv).map(f=>{
              const s=sel[f.key];
              if(s==="ours") return `${f.label}: ${f.gtec} → ${f.our} [GTEC to update]`;
              if(s==="cpsa") return `${f.label}: ${f.our} → ${f.gtec} [BOOKER to acknowledge]`;
              return `${f.label}: ${f.our} → ${f.gtec}`;
            }).join("; ");
          }
          const rowsHtml = mismatches.map(b=>{
            const fac=FACILITIES.find(x=>x.id===b.facility_id);
            const reasons=parseMismatchNote(b.system_notes,b.notes);
            const cv=extractCpsaAmendValues(reasons,b);
            const cfac=FACILITIES.find(x=>x.id===cv.facility_id);
            const alias=adminAlias(b.email);
            const col=emailColor(b.email);
            return `<tr>
              <td style="padding:8px 12px;border-bottom:1px solid #fde68a"><span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${col};color:#fff;font-weight:700;font-size:11px">${alias}</span><br><span style="color:#64748b;font-size:11px">${b.email}</span></td>
              <td style="padding:8px 12px;border-bottom:1px solid #fde68a;white-space:nowrap">${fmtDate(b.date)}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #fde68a;white-space:nowrap">${fac?.name||b.facility_id}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #fde68a;white-space:nowrap"><span style="text-decoration:line-through;color:#94a3b8">${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}, ${b.duration}h${b.facility_id!==cv.facility_id?" ("+fac?.name+")":""}</span><br><span style="color:#a16207;font-weight:700">→ ${fmtTime(cv.start_hour)}–${fmtTime(cv.start_hour+cv.duration)}, ${cv.duration}h${b.facility_id!==cv.facility_id?" ("+(cfac?.name||cv.facility_id)+")":""}</span></td>
              <td style="padding:8px 12px;border-bottom:1px solid #fde68a;font-size:11px;color:#64748b">${changesHtml(b, cv)}</td>
            </tr>`;
          }).join("");
          const html=`<div style="font-family:sans-serif;font-size:13px;color:#0f172a;max-width:720px">
<h3 style="color:#a16207;margin:0 0 8px">⚡ GTEC Mismatch Report — ${dateStr}</h3>
<p style="color:#475569;margin:0 0 8px">The following ${mismatches.length} field booking${mismatches.length!==1?"s":""} have discrepancies between our records and GTEC data. The <strong>Changes</strong> column shows the proposed resolution for each field.</p>
<p style="color:#94a3b8;font-size:11px;margin:0 0 16px">${PILL_GTEC} GTEC's schedule should be corrected to the proposed value. ${PILL_BOOKER} our booking is being amended to GTEC's value — the booker should be notified.</p>
<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:12px;border:1px solid #fde68a;border-radius:8px;overflow:hidden">
<thead><tr style="background:#fef3c7">
  <th style="padding:8px 12px;text-align:left;font-weight:700;color:#92400e">Booker</th>
  <th style="padding:8px 12px;text-align:left;font-weight:700;color:#92400e">Date</th>
  <th style="padding:8px 12px;text-align:left;font-weight:700;color:#92400e">Field</th>
  <th style="padding:8px 12px;text-align:left;font-weight:700;color:#92400e">Booked → GTEC</th>
  <th style="padding:8px 12px;text-align:left;font-weight:700;color:#92400e">Changes</th>
</tr></thead>
<tbody>${rowsHtml}</tbody>
</table>
<p style="color:#94a3b8;font-size:11px;margin:12px 0 0">Generated by FacilityBook · ${dateStr}</p>
</div>`;
          const plain=["GTEC Mismatch Report — "+dateStr,"","Booker\tDate\tField\tBooked\tGTEC Says\tChanges",
            ...mismatches.map(b=>{
              const fac=FACILITIES.find(x=>x.id===b.facility_id);
              const reasons=parseMismatchNote(b.system_notes,b.notes);
              const cv=extractCpsaAmendValues(reasons,b);
              return [adminAlias(b.email),b.email,fmtDate(b.date),fac?.name||b.facility_id,
                `${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)} ${b.duration}h`,
                `${fmtTime(cv.start_hour)}–${fmtTime(cv.start_hour+cv.duration)} ${cv.duration}h`,
                changesText(b, cv)].join("\t");
            })
          ].join("\n");
          try {
            await navigator.clipboard.write([new ClipboardItem({"text/html":new Blob([html],{type:"text/html"}),"text/plain":new Blob([plain],{type:"text/plain"})})]);
          } catch { navigator.clipboard?.writeText(plain); }
        }

        // Billing display helpers
        const BILLING_COLOR = {credit_pending:"#d97706",invoice_pending:"#2563eb",credited:"#15803d",invoiced:"#5b21b6"};
        const BILLING_LABEL = {none:"—",credit_pending:"Credit pending",invoice_pending:"Invoice pending",credited:"Credited ✓",invoiced:"Invoiced ✓"};

        // Each row is a component so it can hold its own useState hooks.
        function MismatchRow({b, rowIdx}) {
          const reasons=parseMismatchNote(b.system_notes,b.notes);
          const cpsaVals=extractCpsaAmendValues(reasons,b);
          const fac=FACILITIES.find(x=>x.id===b.facility_id);
          const cpsaFac=FACILITIES.find(x=>x.id===cpsaVals.facility_id);
          const facChanged=cpsaVals.facility_id!==b.facility_id;
          const timeChanged=cpsaVals.start_hour!==b.start_hour;
          const durChanged=cpsaVals.duration!==b.duration;
          const changedFields=[
            ...(facChanged?["facility"]:[]),
            ...(timeChanged?["time"]:[]),
            ...(durChanged?["duration"]:[]),
          ];

          const saved=parseCpsaResolution(b.system_notes);
          const local=mismatchResState[b.id];
          const fieldSel=local?.fieldSel||{};
          const curBilling=local?.billingState??saved?.billingState??"none";
          const alreadySettled=saved?.billingState==="credited"||saved?.billingState==="invoiced";
          const [showWarn,setShowWarn]=useState(false);

          // Derive resolution from per-field selections
          const curRes=deriveResolution(changedFields, fieldSel);

          // CPSA submission link(s) + ref ("submission id") for this booking.
          const cpsaRefs=parseCpsaRefs(b.system_notes,b.notes);

          // Saved record reflects the per-field keep/switch choice (CPSA's value only
          // where the admin switched that field; ours elsewhere).
          function effectiveFrom(sel) {
            return {
              facility_id: sel.facility==="cpsa" ? cpsaVals.facility_id : b.facility_id,
              start_hour:  sel.time==="cpsa"     ? cpsaVals.start_hour  : b.start_hour,
              duration:    sel.duration==="cpsa" ? cpsaVals.duration    : b.duration,
            };
          }
          const rowCostOf = v => bookingCost(v, facilityRates);
          const origCost=rowCostOf(b);
          const effectiveVals=effectiveFrom(fieldSel); // what we save to the booking
          // Billing follows the KEPT (effective) values, not CPSA's full record — the booker is
          // billed for what we actually keep. A credit/deficit appears only when the kept booking
          // costs less/more than originally billed; keeping the original duration & rate (even
          // with a same-rate field swap) nets zero. <0 ⇒ credit owed, >0 ⇒ deficit owed.
          const costDelta=rowCostOf(effectiveVals)-origCost;

          function pickField(field, who) {
            if (alreadySettled && who==="cpsa") setShowWarn(true);
            const newSel={...fieldSel,[field]:who};
            const newRes=deriveResolution(changedFields,newSel);
            // Auto-arm the outcome from the cost of the values being kept (the new selection):
            // credit when they cost less than billed, deficit when more, else no adjustment.
            const cd=rowCostOf(effectiveFrom(newSel))-origCost;
            const auto=(newRes==="amended"&&b.invoiced)?(cd<0?"credit_pending":cd>0?"invoice_pending":"none"):"none";
            setMismatchResState(prev=>({
              ...prev,
              [b.id]:{
                ...prev[b.id],
                resolution:newRes,
                billingState:prev[b.id]?.billingState??auto,
                fieldSel:newSel
              }
            }));
          }
          function resetField(field) {
            const newSel={...fieldSel};delete newSel[field];
            const newRes=deriveResolution(changedFields,newSel);
            setMismatchResState(prev=>({
              ...prev,
              [b.id]:{...prev[b.id],resolution:newRes,fieldSel:newSel}
            }));
          }
          function setBilling(bs) {
            setMismatchResState(prev=>({...prev,[b.id]:{...prev[b.id],resolution:curRes,billingState:bs}}));
          }
          function doSave() { saveMismatchResolution(b,curRes,curBilling,effectiveVals); }

          const isDirty=!!local;
          const rowBg=rowIdx%2===0?"#fff":"#fffbeb";
          const btnPill={fontFamily:"inherit",fontSize:11,fontWeight:600,borderRadius:5,padding:"3px 8px",cursor:"pointer",border:"1.5px solid",display:"inline-flex",alignItems:"center",gap:3,whiteSpace:"nowrap",lineHeight:1.4};

          // Render a value pair as two clickable buttons.
          // Original (ours): light yellow + italic. CPSA (mismatch): light blue + bold.
          // who="ours"|"cpsa"|undefined (not yet selected)
          function ValPair({field, ourVal, cpsaVal, changed, prefix}) {
            if (!changed) return <span style={{color:"#475569",fontSize:12}}>{ourVal}</span>;
            const sel=fieldSel[field];
            const oursActive=sel==="ours";
            const cpsaActive=sel==="cpsa";
            const oursTooltip = oursActive
              ? "Keeping our record — GTEC will be asked to correct this on their side"
              : "Our record (original) — click to keep ours and flag GTEC to correct";
            const cpsaTooltip = cpsaActive
              ? "Accepting GTEC's value — our record will be amended to match"
              : "GTEC's value (mismatch) — click to accept and amend our record";
            return (
              <div style={{display:"flex",flexDirection:"column",gap:3}}>
                {prefix&&<span style={{fontSize:10,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.03em",fontWeight:700}}>{prefix}</span>}
                <button
                  style={{...btnPill,
                    fontStyle:"italic",
                    background:"#fef9c3",
                    borderColor:oursActive?"#a16207":"#fde68a",
                    color:"#854d0e",
                    textDecoration:cpsaActive?"line-through":undefined,
                    opacity:cpsaActive?0.55:1,
                    boxShadow:oursActive?"0 0 0 2px #fde68a":undefined
                  }}
                  title={oursTooltip}
                  onClick={()=>sel==="ours"?resetField(field):pickField(field,"ours")}
                >{oursActive?"✓ ":""}{ourVal}</button>
                <button
                  style={{...btnPill,
                    fontWeight:700,
                    background:"#dbeafe",
                    borderColor:cpsaActive?"#1d4ed8":"#bfdbfe",
                    color:"#1e3a8a",
                    opacity:oursActive?0.55:1,
                    boxShadow:cpsaActive?"0 0 0 2px #bfdbfe":undefined
                  }}
                  title={cpsaTooltip}
                  onClick={()=>sel==="cpsa"?resetField(field):pickField(field,"cpsa")}
                >{cpsaActive?"✓ ":"→ "}{cpsaVal}</button>
              </div>
            );
          }

          return (
            <tr style={{background:rowBg}}>
              {/* Booker */}
              <td style={tdS2}>
                <div style={{fontWeight:600,color:"#0f172a",whiteSpace:"nowrap"}}>{b.name}</div>
                <div style={{color:"#64748b",fontSize:10}}>{b.email}</div>
                {b.invoiced&&<span style={{fontSize:10,fontWeight:700,background:"#f5f3ff",color:"#5b21b6",border:"1px solid #ddd6fe",borderRadius:4,padding:"1px 4px",display:"inline-block",marginTop:2}}>🧾 invoiced</span>}
                {cpsaRefs.map((r,i)=>(
                  <a key={i} href={r.url} target="_blank" rel="noopener noreferrer" title={`GTEC submission ${r.ref} — open the booking on Sporty`}
                    style={{display:"flex",alignItems:"center",gap:3,marginTop:3,fontSize:10,fontWeight:700,color:"#0369a1",textDecoration:"none",width:"fit-content",background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:4,padding:"1px 5px"}}>
                    🔗 {r.ref} ↗
                  </a>
                ))}
              </td>
              {/* Date */}
              <td style={{...tdS2,whiteSpace:"nowrap",color:"#475569"}}>{fmtDate(b.date)}</td>
              {/* Field — button pair if changed */}
              <td style={tdS2}>
                <div style={{display:"inline-flex",alignItems:"flex-start",gap:4}}>
                  <span style={{width:7,height:7,borderRadius:2,background:fac?.color||"#94a3b8",display:"inline-block",flexShrink:0,marginTop:5}}/>
                  <ValPair field="facility" ourVal={fac?.name||b.facility_id} cpsaVal={cpsaFac?.name||cpsaVals.facility_id} changed={facChanged}/>
                </div>
              </td>
              {/* Time — button pair if changed */}
              <td style={tdS2}>
                <ValPair field="time"
                  ourVal={`${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`}
                  cpsaVal={`${fmtTime(cpsaVals.start_hour)}–${fmtTime(cpsaVals.start_hour+cpsaVals.duration)}`}
                  changed={timeChanged}/>
              </td>
              {/* Duration — button pair if changed */}
              <td style={tdS2}>
                <ValPair field="duration" ourVal={`${b.duration}h`} cpsaVal={`${cpsaVals.duration}h`} changed={durChanged}/>
              </td>
              {/* Actions: status indicator + billing + save */}
              <td style={{...tdS2,minWidth:170}}>
                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                  {/* Resolution status derived from field buttons */}
                  {curRes!=="pending"&&(
                    <div
                      title={curRes==="amended"
                        ? "Resolved: our record has been amended to GTEC's values."
                        : "Pending: GTEC to correct on their side. Becomes 'corrected' once GTEC acknowledges."}
                      style={{fontSize:10,fontWeight:700,
                        color:curRes==="amended"?"#a16207":"#5b21b6",
                        background:curRes==="amended"?"#fef9c3":"#f5f3ff",
                        border:`1px solid ${curRes==="amended"?"#fde68a":"#ddd6fe"}`,
                        borderRadius:4,padding:"2px 7px",display:"inline-block",cursor:"help"}}>
                      {curRes==="amended"?"✓ Amended":"↩ GTEC to correct"}
                    </div>
                  )}
                  {saved?.date&&(
                    <div style={{fontSize:9,color:"#94a3b8",marginTop:-2}} title="When this resolution was last logged / updated">
                      🕗 logged {fmtLoggedAt(saved.date)}
                    </div>
                  )}
                  {curRes==="to_correct"&&(
                    <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:2}}>
                      <div style={{fontSize:10,color:"#64748b",fontWeight:700}}>GTEC follow-up:</div>
                      <button onClick={()=>saveMismatchResolution(b,"confirmed","none")}
                        title="GTEC verbally confirmed our original is correct - keep our values and mark the booking confirmed"
                        style={{fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:5,padding:"3px 9px",cursor:"pointer",background:"#ecfdf5",border:"1.5px solid #6ee7b7",color:"#047857",whiteSpace:"nowrap",textAlign:"left"}}>✓ Confirmed by GTEC</button>
                      <button onClick={()=>onInformCpsa&&onInformCpsa(b)}
                        title="Cart an email to a vendor asking GTEC to correct their schedule to match our record. Does not resolve the mismatch."
                        style={{fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:5,padding:"3px 9px",cursor:"pointer",background:"#f0f9ff",border:"1.5px solid #7dd3fc",color:"#0369a1",whiteSpace:"nowrap",textAlign:"left"}}>📨 Inform GTEC</button>
                    </div>
                  )}
                  {curRes==="pending"&&changedFields.length>0&&(
                    <div style={{fontSize:10,color:"#94a3b8"}}>← Click values to resolve</div>
                  )}
                  {/* Warning when billing already settled */}
                  {showWarn&&alreadySettled&&(
                    <div style={{fontSize:10,background:"#fef2f2",border:"1px solid #fecaca",borderRadius:4,padding:"3px 7px",color:"#b91c1c"}}>⚠ Billing already settled from invoice view</div>
                  )}
                  {/* Billing follow-up — only relevant when amended */}
                  {curRes==="amended"&&(()=>{
                    const ghost=(col)=>({fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:5,padding:"3px 9px",cursor:"pointer",background:"transparent",border:`1.5px solid ${col}`,color:col});
                    const newCost = rowCostOf(effectiveVals);
                    const hasCostInfo = origCost > 0 || newCost > 0;
                    const absCostStr = hasCostInfo ? ` — ${fmtCost(Math.abs(costDelta))}` : "";

                    if (!b.invoiced) {
                      const settled = curBilling==="nochange";
                      return (
                        <div style={{borderTop:"1px dashed #fde68a",paddingTop:4}}>
                          <div style={{fontSize:10,fontWeight:700,color:"#92400e",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3}}>Follow-up</div>
                          {!settled
                            ? <button style={ghost("#94a3b8")}
                                title="Booking has not been invoiced yet — just update the stored record to the kept values. No billing adjustment needed."
                                onClick={()=>setBilling("nochange")}>📝 Update record</button>
                            : <div style={{display:"flex",gap:4,alignItems:"center"}}>
                                <span title="Record will be updated to the kept values on save."
                                  style={{fontSize:11,fontWeight:700,color:"#475569",cursor:"help"}}>📝 Update record</span>
                                <button style={{fontFamily:"inherit",fontSize:11,border:"1.5px solid #cbd5e1",borderRadius:4,background:"transparent",color:"#94a3b8",cursor:"pointer",padding:"1px 5px"}} onClick={()=>setBilling("none")} title="Undo">↩</button>
                              </div>
                          }
                        </div>
                      );
                    }
                    // Invoiced path — compare the cost of the values we KEEP against what we billed.
                    // <0 ⇒ kept booking costs less ⇒ credit owed to the booker; >0 ⇒ costs more ⇒
                    // deficit owed by the booker; 0 ⇒ same price (e.g. a same-rate field swap) ⇒
                    // no adjustment. Offer only the single button matching that outcome.
                    const isCredit  = costDelta < 0;
                    const isDeficit = costDelta > 0;
                    return (
                      <div style={{borderTop:"1px dashed #fde68a",paddingTop:4}}>
                        <div style={{fontSize:10,fontWeight:700,color:"#92400e",textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:3}}>Billing</div>
                        {curBilling==="none"&&(
                          <div style={{display:"flex",gap:3,flexWrap:"wrap",alignItems:"center"}}>
                            {isCredit&&<button style={ghost("#15803d")}
                              title={`Billed ${fmtCost(origCost)} but the kept booking costs ${fmtCost(newCost)} — credit ${fmtCost(Math.abs(costDelta))} owed to the booker.`}
                              onClick={()=>setBilling("credit_pending")}>💚 Credit{absCostStr}</button>}
                            {isDeficit&&<button style={ghost("#dc2626")}
                              title={`Billed ${fmtCost(origCost)} but the kept booking costs ${fmtCost(newCost)} — deficit ${fmtCost(Math.abs(costDelta))} owed by the booker.`}
                              onClick={()=>setBilling("invoice_pending")}>📨 Deficit{absCostStr}</button>}
                            {!isCredit&&!isDeficit&&(()=>{
                              const facChg=effectiveVals.facility_id!==b.facility_id;
                              const timeChg=effectiveVals.start_hour!==b.start_hour;
                              const durChg=effectiveVals.duration!==b.duration;
                              const lbl=!(facChg||timeChg||durChg)?"✓ Original — no change":(facChg&&!timeChg&&!durChg)?"✓ Field change only":"✓ No price change";
                              return <button style={ghost("#94a3b8")}
                                title={`Kept booking costs ${fmtCost(newCost)} — same as billed ${fmtCost(origCost)}. No billing adjustment.`}
                                onClick={()=>setBilling("nochange")}>{lbl}</button>;
                            })()}
                          </div>
                        )}
                        {(curBilling==="credit_pending"||curBilling==="invoice_pending")&&(
                          <div style={{display:"flex",gap:4,alignItems:"center"}}>
                            <span
                              title={curBilling==="credit_pending"
                                ? `Credit ${fmtCost(Math.abs(costDelta))} owed to the booker.`
                                : `Deficit ${fmtCost(Math.abs(costDelta))} owed by the booker.`}
                              style={{fontSize:11,fontWeight:700,color:curBilling==="credit_pending"?"#15803d":"#dc2626",cursor:"help"}}>
                              {curBilling==="credit_pending"
                                ? `💚 Credit${absCostStr}`
                                : `📨 Deficit${absCostStr}`}
                            </span>
                            <button style={{fontFamily:"inherit",fontSize:11,border:"1.5px solid #cbd5e1",borderRadius:4,background:"transparent",color:"#94a3b8",cursor:"pointer",padding:"1px 5px"}} onClick={()=>setBilling("none")} title="Undo">↩</button>
                          </div>
                        )}
                        {(curBilling==="credited"||curBilling==="invoiced")&&(
                          <span style={{fontSize:11,fontWeight:700,color:BILLING_COLOR[curBilling]}}>{BILLING_LABEL[curBilling]}</span>
                        )}
                        {curBilling==="nochange"&&(
                          <div style={{display:"flex",gap:4,alignItems:"center"}}>
                            <span title="No billing adjustment required." style={{fontSize:11,fontWeight:700,color:"#475569",cursor:"help"}}>No adjustment</span>
                            <button style={{fontFamily:"inherit",fontSize:11,border:"1.5px solid #cbd5e1",borderRadius:4,background:"transparent",color:"#94a3b8",cursor:"pointer",padding:"1px 5px"}} onClick={()=>setBilling("none")} title="Undo">↩</button>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                  {/* Save */}
                  {isDirty&&curRes!=="pending"&&(
                    <button style={{fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:6,padding:"4px 12px",cursor:"pointer",background:"#f59e0b",color:"#fff",border:"none"}}
                      onClick={doSave}>Save resolution</button>
                  )}
                </div>
              </td>
            </tr>
          );
        }

        return (
          <div style={{background:"#fffbeb",border:"1.5px solid #fde68a",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8,justifyContent:"space-between",flexWrap:"wrap"}}>
              <div>
                <span style={{fontWeight:700,fontSize:14,color:"#b45309"}}>⚡ {mismatches.length} GTEC mismatch{mismatches.length!==1?"es":""} pending review</span>
                <div style={{fontSize:12,color:"#92400e",marginTop:2}}>Click old or new values in each row to set resolution — amended bookings are updated to GTEC values.</div>
              </div>
              <div style={{display:"flex",gap:6}}>
                {mismatches.length>0&&<button onClick={()=>setShowMismatchNotify(true)} style={S.btn({background:"#b45309",color:"#fff",fontWeight:700,fontSize:12})}>📧 Notify affected users</button>}
                <button onClick={copyEmailFormat} style={S.btn({background:"#fff",border:"1.5px solid #fde68a",color:"#a16207",fontWeight:700,fontSize:12})}>📧 Copy email</button>
                <button onClick={()=>{
                  const blob=new Blob([["Name,Email,Date,Field,Booked,GTEC Says,Changes,GTEC Ref,GTEC Link",...mismatches.map(b=>{
                    const fac=FACILITIES.find(x=>x.id===b.facility_id);
                    const reasons=parseMismatchNote(b.system_notes,b.notes);
                    const cv=extractCpsaAmendValues(reasons,b);
                    const refs=parseCpsaRefs(b.system_notes,b.notes);
                    const esc=v=>`"${String(v).replace(/"/g,'""')}"`;
                    return [b.name,b.email,b.date,fac?.name||b.facility_id,
                      `${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)} ${b.duration}h`,
                      `${fmtTime(cv.start_hour)}–${fmtTime(cv.start_hour+cv.duration)} ${cv.duration}h`,
                      reasons.join("; "),
                      refs.map(r=>r.ref).join(" "),
                      refs.map(r=>r.url).join(" ")].map(esc).join(",");
                  })].join("\n")],{type:"text/csv"});
                  const url=URL.createObjectURL(blob);const a=document.createElement("a");
                  a.href=url;a.download="gtec-mismatches.csv";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
                }} style={S.btn({background:"#f59e0b",color:"#fff",fontWeight:700,fontSize:12})}>⬇ Export CSV</button>
              </div>
            </div>
            {mismatches.length===0
              ? <div style={{fontSize:12,color:"#92400e"}}>No mismatches at this time. Run a sync to refresh.</div>
              : <div style={{overflowX:"auto",borderRadius:8,border:"1px solid #fde68a"}}>
                  <CopyableTable>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead>
                      <tr style={{background:"#fef3c7"}}>
                        {[
                          ["name","Booker"],
                          ["date","Date"],
                          ["facility","Field"],
                          ["time","Time"],
                          ["duration","Dur"],
                          [null,"Resolution & Billing"],
                        ].map(([key,label])=>(
                          <th key={label} style={{...thS2,cursor:key?"pointer":"default",userSelect:"none"}}
                            onClick={key?()=>toggleSort(key):undefined}
                            title={key?"Click to sort":undefined}>
                            {label}
                            {key && sortKey===key && (
                              <span style={{marginLeft:4,color:"#a16207"}}>{sortDir==="asc"?"▲":"▼"}</span>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {mismatches.map((b,i)=><MismatchRow key={b.id} b={b} rowIdx={i}/>)}
                    </tbody>
                  </table>
                  </CopyableTable>
                </div>
            }
          </div>
        );
      })()}

      {/* Bookings table */}
      {list.length===0
        ? <div style={{textAlign:"center",padding:"40px 0",color:"#94a3b8",fontSize:14}}>No bookings found.</div>
        : (
        <div style={{overflowX:"auto",borderRadius:12,border:"1px solid #f1f5f9"}}>
          <CopyableTable>
          <table style={{width:"100%",borderCollapse:"collapse",background:"#fff",fontSize:13}}>
            <thead>
              <tr style={{background:"#f8fafc"}}>
                <th style={{padding:"8px 10px",textAlign:"center",width:32}}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{width:14,height:14,accentColor:"#6366f1"}}/>
                </th>
                {[["date","Date",null],["name","Booker",null],["facility","Fac",90],["status","Status",100]].map(([col,label,w])=>(
                  <th key={col} onClick={()=>toggleSort(col)} style={{padding:"5px 8px",textAlign:"left",cursor:"pointer",userSelect:"none",fontWeight:700,color:"#475569",whiteSpace:"nowrap",fontSize:11,...(w?{width:w}:{})}}>
                    {label}{sortArrow(col)}
                  </th>
                ))}
                <th style={{padding:"5px 8px",textAlign:"left",fontWeight:700,color:"#475569",fontSize:11,whiteSpace:"nowrap"}}>Time · Purpose</th>
                <th style={{padding:"5px 8px",textAlign:"right",fontWeight:700,color:"#475569",fontSize:11}}>Actions</th>
              </tr>
              <tr style={{background:"#f1f5f9"}}>
                <th style={{padding:"3px 4px"}}/>
                <th style={{padding:"3px 4px",position:"relative"}}>
                  <DateRangePicker from={adminDateFrom} to={adminDateTo}
                    onApply={(f,t)=>{setAdminDateFrom(f);setAdminDateTo(t);}}/>
                </th>
                <th style={{padding:"3px 4px",position:"relative"}}>
                  {(()=>{
                    const allSel = adminBookerFilter.size>0 && adminBookerEmails.every(e=>adminBookerFilter.has(e));
                    return (
                      <div style={{display:"flex",gap:3,alignItems:"center",flexWrap:"wrap"}}>
                        <button onClick={()=>setAdminBookerFilter(allSel?new Set():new Set(adminBookerEmails))}
                          title={allSel?"Clear all bookers":"Select all bookers"}
                          style={{padding:"1px 7px",fontSize:10,borderRadius:10,border:"1.5px solid #e2e8f0",background:adminBookerFilter.size===0?"#0f172a":"#fff",color:adminBookerFilter.size===0?"#fff":"#475569",cursor:"pointer",fontWeight:adminBookerFilter.size===0?700:400,lineHeight:1.6}}>{allSel?"None":"All"}</button>
                        <button onClick={()=>setShowBookerFilter(v=>!v)}
                          style={{display:"inline-flex",alignItems:"center",gap:4,padding:"1px 7px",fontSize:10,borderRadius:10,border:`1.5px solid ${adminBookerFilter.size>0?"#0f172a":"#e2e8f0"}`,background:"#fff",color:"#475569",cursor:"pointer",fontWeight:600,lineHeight:1.6}}>
                          <span>👥</span>
                          {adminBookerFilter.size>0&&<span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:14,height:14,padding:"0 4px",borderRadius:7,background:"#0f172a",color:"#fff",fontSize:9,fontWeight:700}}>{adminBookerFilter.size}</span>}
                          <span style={{fontSize:8,color:"#94a3b8"}}>▾</span>
                        </button>
                        {showBookerFilter&&(
                          <>
                            <div onClick={()=>setShowBookerFilter(false)} style={{position:"fixed",inset:0,zIndex:30}}/>
                            <div style={{position:"absolute",top:"100%",left:0,zIndex:31,marginTop:4,background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:10,boxShadow:"0 8px 24px rgba(15,23,42,0.12)",padding:8,minWidth:200,maxWidth:340,maxHeight:300,overflowY:"auto"}}>
                              <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6,padding:"0 2px"}}>Filter bookers</div>
                              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                                {adminBookerEmails.map(em=>{
                                  const active=adminBookerFilter.has(em);
                                  const c=emailColor(em);
                                  return(
                                    <button key={em} onClick={()=>toggleAdminBooker(em)}
                                      style={{padding:"3px 8px",fontSize:11,borderRadius:14,border:`1.5px solid ${active?c:"#e2e8f0"}`,background:active?c:"#fff",color:active?"#fff":"#475569",cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>
                                      {adminAlias(em)}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </th>
                <th style={{padding:"3px 4px",width:90}}>
                  <select value={ff} onChange={e=>setFf(e.target.value)}
                    style={{padding:"3px 4px",fontSize:10,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}>
                    <option value="all">All</option>
                    {FACILITIES.map(f=><option key={f.id} value={f.id}>{f.name.includes("Field")?f.name.replace("Field ","F"):f.name.split(" ")[0]}</option>)}
                  </select>
                </th>
                <th style={{padding:"3px 4px",width:100}}>
                  <select value={sf} onChange={e=>setSf(e.target.value)}
                    style={{padding:"3px 4px",fontSize:10,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}>
                    <option value="all">All</option>
                    {Object.entries(STATUS_META).filter(([k])=>!["pending","amua_submit"].includes(k)).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                  </select>
                </th>
                <th style={{padding:"3px 4px"}}>
                  <input placeholder="Search purpose…" value={adminColPurpose} onChange={e=>setAdminColPurpose(e.target.value)}
                    style={{padding:"3px 6px",fontSize:11,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}/>
                </th>
                <th style={{padding:"3px 4px"}}>
                  {(adminBookerFilter.size>0||sf!=="all"||ff!=="all"||adminDateFrom||adminDateTo||adminColPurpose)&&(
                    <button onClick={()=>{setAdminBookerFilter(new Set());setSf("all");setFf("all");setAdminDateFrom("");setAdminDateTo("");setAdminColPurpose("");}}
                      style={{padding:"2px 7px",fontSize:10,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",color:"#64748b",cursor:"pointer",whiteSpace:"nowrap"}}>
                      ✕ Clear
                    </button>
                  )}
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((b,ri)=>{
                const f=FACILITIES.find(x=>x.id===b.facility_id);
                const isPending=REVIEW_STATUSES.has(b.status);
                const isAmuaStage=b.status==="pending_amua"||b.status==="pending";
                const isCpsaStage=b.status==="queued_cpsa"||b.status==="amua_submit"||b.status==="pending_cpsa";
                const queued=actionQueue.find(a=>a.id===b.id);
                const isDeleteQueued=deleteIds.has(b.id);
                const rowBg=isDeleteQueued?"#fff1f2":queued?"#f0fdf4":selected.has(b.id)?"#f5f3ff":"#fff";
                const queueLabel = queued ? {queued_cpsa:"→ Queue for GTEC",approved:"✓ GTEC Approved",rejected:"✗ Reject"}[queued.newStatus]||queued.newStatus : null;
                return (
                  <tr key={b.id} onClick={()=>onView&&onView(b)} style={{background:rowBg,borderTop:ri>0?"1px solid #f1f5f9":"none",transition:"background 0.1s",cursor:"pointer"}}
                    onMouseEnter={e=>{if(!rowBg||rowBg==="#fff")e.currentTarget.style.background="#f8fafc";}}
                    onMouseLeave={e=>e.currentTarget.style.background=rowBg}>
                    <td style={{padding:"3px 8px",textAlign:"center"}} onClick={e=>e.stopPropagation()}>
                      {isPending&&<input type="checkbox" checked={selected.has(b.id)} onChange={()=>toggleSelect(b.id)} style={{width:13,height:13,accentColor:"#6366f1"}}/>}
                    </td>
                    <td style={{padding:"3px 6px",whiteSpace:"nowrap",fontSize:11,color:"#475569"}}>{fmtDateShort(b.date)}</td>
                    <td style={{padding:"3px 6px"}}>
                      <span onClick={e=>{e.stopPropagation();toggleAdminBooker(b.email.toLowerCase());}}
                        style={{display:"inline-block",padding:"2px 8px",borderRadius:10,background:emailColor(b.email),color:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",outline:adminBookerFilter.has(b.email.toLowerCase())?"2px solid #0f172a":"none",outlineOffset:1}}>
                        {adminAlias(b.email)}
                      </span>
                    </td>
                    <td style={{padding:"3px 6px",fontSize:11}}>
                      <span style={{display:"inline-flex",alignItems:"center",gap:3}}>
                        <span style={{width:6,height:6,borderRadius:"50%",background:f?.color,display:"inline-block",flexShrink:0}}/>
                        <span style={{color:"#0f172a"}}>{f ? (f.name.includes("Field") ? f.name.replace("Field ","F") : f.name.split(" ")[0]) : "—"}</span>
                      </span>
                    </td>
                    <td style={{padding:"3px 6px"}}>
                      <Badge status={b.status}/>
                      {b.invoiced&&<span style={{fontSize:9,fontWeight:700,background:INVOICED_META.bg,color:INVOICED_META.text,border:`1px solid ${INVOICED_META.border}`,borderRadius:4,padding:"1px 4px",marginLeft:2}}>🧾</span>}
                      {queueLabel&&<div style={{fontSize:9,fontWeight:700,color:queued.newStatus==="rejected"?"#991b1b":"#166634"}}>{queueLabel}</div>}
                      {isDeleteQueued&&<div style={{fontSize:9,fontWeight:700,color:"#991b1b"}}>🗑</div>}
                    </td>
                    <td style={{padding:"3px 6px",color:"#475569",fontSize:11}}>
                      {fmt24(b.start_hour)}–{fmt24(b.start_hour+b.duration)}
                      <div style={{fontSize:11,color:"#94a3b8",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:180}}>{b.purpose}</div>
                    </td>
                    <td style={{padding:"3px 8px"}} onClick={e=>e.stopPropagation()}>
                      <div style={{display:"flex",gap:3,justifyContent:"flex-end",flexWrap:"wrap"}}>
                        {isPending&&!isDeleteQueued&&<>
                          {isAmuaStage&&<button onClick={()=>queueAction(b.id,"queued_cpsa")} title="Queue for GTEC"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="queued_cpsa"?"#1d4ed8":"#3b82f6",color:"#fff",outline:queued?.newStatus==="queued_cpsa"?"2px solid #1d4ed8":"none"})}>GTEC →</button>}
                          {(b.status==="queued_cpsa"||b.status==="amua_submit")&&<button onClick={()=>queueAction(b.id,"pending_cpsa")} title="Mark as Pending GTEC Review (no email)"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="pending_cpsa"?"#0369a1":"#0ea5e9",color:"#fff",outline:queued?.newStatus==="pending_cpsa"?"2px solid #0369a1":"none"})}>⏳</button>}
                          {isCpsaStage&&<button onClick={()=>queueAction(b.id,"approved")} title="Mark GTEC Approved"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="approved"?"#15803d":"#22c55e",color:"#fff",outline:queued?.newStatus==="approved"?"2px solid #15803d":"none"})}>✓</button>}
                          <button onClick={()=>queueAction(b.id,"rejected")} title="Reject"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="rejected"?"#be123c":"#f43f5e",color:"#fff",outline:queued?.newStatus==="rejected"?"2px solid #be123c":"none"})}>✗</button>
                        </>}
                        {b.status==="clash"&&!isDeleteQueued&&(
                          <button onClick={()=>queueAction(b.id,"approved")} title="Resolve clash — approve booking"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="approved"?"#15803d":"#22c55e",color:"#fff",outline:queued?.newStatus==="approved"?"2px solid #15803d":"none"})}>✓ Resolve</button>
                        )}
                        <button onClick={()=>onEdit(b)} style={S.btn({padding:"3px 7px",fontSize:10,border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Edit</button>
                        <button onClick={()=>!isDeleteQueued&&onQueueDelete(b.id)}
                          style={S.btn({padding:"3px 7px",fontSize:10,border:isDeleteQueued?"1.5px solid #dc2626":"1.5px solid #fca5a5",background:isDeleteQueued?"#fee2e2":"#fff",color:isDeleteQueued?"#dc2626":"#f43f5e"})}>🗑</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </CopyableTable>
        </div>
      )}

      {/* Clear old unapproved confirmation modal */}
      {showClearModal&&(
        <div onClick={e=>e.target===e.currentTarget&&setShowClearModal(false)}
          style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,backdropFilter:"blur(2px)"}}>
          <div style={{background:"#fff",borderRadius:16,padding:28,maxWidth:520,width:"90%",maxHeight:"85vh",overflowY:"auto",boxShadow:"0 8px 40px rgba(0,0,0,0.2)"}}>
            <h2 style={{margin:"0 0 8px",fontSize:18,fontWeight:700,color:"#0f172a"}}>🧹 Clear Old Unapproved Bookings</h2>
            <p style={{margin:"0 0 16px",fontSize:13,color:"#64748b"}}>The following past pending bookings will be permanently deleted:</p>
            <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:"35vh",overflowY:"auto",marginBottom:16}}>
              {oldUnapproved.map(b=>{
                const f=FACILITIES.find(x=>x.id===b.facility_id);
                return(
                  <div key={b.id} style={{background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 12px",fontSize:12}}>
                    <div style={{fontWeight:600,color:"#0f172a"}}>{b.name} — {f?.name}</div>
                    <div style={{color:"#64748b"}}>{fmtDate(b.date)} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.purpose}</div>
                    <div style={{color:"#94a3b8"}}>{b.email}</div>
                  </div>
                );
              })}
            </div>
            <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>These move to the 🗑 Removal Queue — the actual deletion and any booker emails happen when you submit that queue.</div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowClearModal(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
              <button onClick={()=>{onClearOldUnapproved(oldUnapproved.map(b=>b.id)); setShowClearModal(false);}}
                style={S.btn({background:"#7c3aed",color:"#fff",fontWeight:700})}>
                🧹 Move {oldUnapproved.length} to removal queue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clash notify modal */}
      {showClashNotify&&(()=>{
        const byUser = {};
        clashes.forEach(c => {
          const em = c.user.email?.toLowerCase();
          if(!em) return;
          if(!byUser[em]) byUser[em] = { name:c.user.name, email:em, clashes:[] };
          byUser[em].clashes.push(c);
        });
        const users = Object.values(byUser);
        const selUser = clashNotifyUser ? byUser[clashNotifyUser] : null;
        return (
          <div onClick={e=>e.target===e.currentTarget&&(setShowClashNotify(false),setClashNotifyUser(null))}
            style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,backdropFilter:"blur(2px)"}}>
            <div style={{background:"#fff",borderRadius:16,padding:28,maxWidth:600,width:"92%",maxHeight:"88vh",overflowY:"auto",boxShadow:"0 8px 40px rgba(0,0,0,0.2)"}}>
              <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:700,color:"#9f1239"}}>📧 Notify Affected Users</h2>
              <p style={{margin:"0 0 16px",fontSize:13,color:"#64748b"}}>Select a user to preview their clashes, then send. Or notify all at once.</p>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
                {users.map(u=>(
                  <button key={u.email} onClick={()=>setClashNotifyUser(prev=>prev===u.email?null:u.email)}
                    style={{...S.btn({background:clashNotifyUser===u.email?"#fff1f2":"#f8fafc",border:clashNotifyUser===u.email?"1.5px solid #f43f5e":"1.5px solid #e2e8f0",color:"#0f172a"}),textAlign:"left",display:"flex",alignItems:"center",gap:10,padding:"10px 14px"}}>
                    <EmailChip email={u.email}/>
                    <span style={{fontWeight:600,fontSize:13}}>{u.name}</span>
                    <span style={{marginLeft:"auto",fontSize:12,color:"#94a3b8"}}>{u.clashes.length} clash{u.clashes.length>1?"es":""}</span>
                  </button>
                ))}
              </div>
              {selUser&&(
                <div style={{background:"#fff1f2",border:"1px solid #fecdd3",borderRadius:10,padding:14,marginBottom:16}}>
                  <div style={{fontWeight:700,fontSize:13,color:"#9f1239",marginBottom:8}}>Clashes for {selUser.name}:</div>
                  {selUser.clashes.map((c,i)=>{
                    const fa=FACILITIES.find(x=>x.id===c.admin.facility_id);
                    return(
                      <div key={i} style={{fontSize:12,color:"#0f172a",padding:"6px 0",borderBottom:i<selUser.clashes.length-1?"1px solid #fecdd3":"none"}}>
                        <span style={{fontWeight:600}}>🔒 {c.admin.purpose||"Admin booking"}</span>
                        {" vs "}
                        <span>{c.user.purpose||"Your booking"}</span>
                        <span style={{color:"#94a3b8",marginLeft:8}}>{fa?.name} · {fmtDate(c.admin.date)} {fmtTime(c.admin.start_hour)}–{fmtTime(c.admin.start_hour+c.admin.duration)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{display:"flex",gap:10,justifyContent:"flex-end",flexWrap:"wrap"}}>
                <button onClick={()=>{setShowClashNotify(false);setClashNotifyUser(null);}} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
                {selUser&&<button onClick={()=>handleSendClashEmails(selUser.email)}
                  style={S.btn({background:"#f43f5e",color:"#fff",fontWeight:700})}>
                  🛒 Add to cart for {selUser.name}
                </button>}
                {!selUser&&<button onClick={()=>handleSendClashEmails(null)}
                  style={S.btn({background:"#9f1239",color:"#fff",fontWeight:700})}>
                  🛒 Add all {users.length} to cart
                </button>}
              </div>
            </div>
          </div>
        );
      })()}

      {showMismatchNotify&&(()=>{
        const byUser = {};
        bookings.filter(b=>b.status==="cpsa_review_needed"&&!isAdminBooking(b)&&inBookerFilter(b.email)).forEach(b => {
          const em = b.email?.toLowerCase();
          if(!em) return;
          if(!byUser[em]) byUser[em] = { name:b.name, email:em, bkgs:[] };
          byUser[em].bkgs.push(b);
        });
        const users = Object.values(byUser);
        const selUser = mismatchNotifyUser ? byUser[mismatchNotifyUser] : null;
        return (
          <div onClick={e=>e.target===e.currentTarget&&(setShowMismatchNotify(false),setMismatchNotifyUser(null))}
            style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,backdropFilter:"blur(2px)"}}>
            <div style={{background:"#fff",borderRadius:16,padding:28,maxWidth:600,width:"92%",maxHeight:"88vh",overflowY:"auto",boxShadow:"0 8px 40px rgba(0,0,0,0.2)"}}>
              <h2 style={{margin:"0 0 4px",fontSize:18,fontWeight:700,color:"#b45309"}}>📧 Notify Affected Users</h2>
              <p style={{margin:"0 0 16px",fontSize:13,color:"#64748b"}}>Select a user to preview their mismatched bookings, then send. Or notify all at once.</p>
              <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:16}}>
                {users.map(u=>(
                  <button key={u.email} onClick={()=>setMismatchNotifyUser(prev=>prev===u.email?null:u.email)}
                    style={{...S.btn({background:mismatchNotifyUser===u.email?"#fffbeb":"#f8fafc",border:mismatchNotifyUser===u.email?"1.5px solid #f59e0b":"1.5px solid #e2e8f0",color:"#0f172a"}),textAlign:"left",display:"flex",alignItems:"center",gap:10,padding:"10px 14px"}}>
                    <EmailChip email={u.email}/>
                    <span style={{fontWeight:600,fontSize:13}}>{u.name}</span>
                    <span style={{marginLeft:"auto",fontSize:12,color:"#94a3b8"}}>{u.bkgs.length} mismatch{u.bkgs.length>1?"es":""}</span>
                  </button>
                ))}
                {users.length===0&&<div style={{fontSize:13,color:"#94a3b8",textAlign:"center",padding:16}}>No mismatched bookings to notify.</div>}
              </div>
              {selUser&&(
                <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:10,padding:14,marginBottom:16}}>
                  <div style={{fontWeight:700,fontSize:13,color:"#b45309",marginBottom:8}}>Mismatches for {selUser.name}:</div>
                  {selUser.bkgs.map((b,i)=>{
                    const fa=FACILITIES.find(x=>x.id===b.facility_id);
                    const reasons=parseMismatchNote(b.system_notes,b.notes);
                    return(
                      <div key={i} style={{fontSize:12,color:"#0f172a",padding:"6px 0",borderBottom:i<selUser.bkgs.length-1?"1px solid #fde68a":"none"}}>
                        <span style={{fontWeight:600}}>{b.purpose||"Booking"}</span>
                        <span style={{color:"#94a3b8",marginLeft:8}}>{fa?.name} · {fmtDate(b.date)} {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)}</span>
                        {reasons.length>0&&<div style={{color:"#a16207",marginTop:2}}>{reasons.join("; ")}</div>}
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{display:"flex",gap:10,justifyContent:"flex-end",flexWrap:"wrap"}}>
                <button onClick={()=>{setShowMismatchNotify(false);setMismatchNotifyUser(null);}} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
                {selUser&&<button onClick={()=>handleSendMismatchEmails(selUser.email)}
                  style={S.btn({background:"#f59e0b",color:"#fff",fontWeight:700})}>
                  🛒 Add to cart for {selUser.name}
                </button>}
                {!selUser&&users.length>0&&<button onClick={()=>handleSendMismatchEmails(null)}
                  style={S.btn({background:"#b45309",color:"#fff",fontWeight:700})}>
                  🛒 Add all {users.length} to cart
                </button>}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function Banner({type,msg}) {
  const c={info:{bg:"#f0f9ff",border:"#7dd3fc",text:"#075985"},error:{bg:"#fff1f2",border:"#fda4af",text:"#9f1239"}}[type]||{bg:"#f0f9ff",border:"#7dd3fc",text:"#075985"};
  return <div style={{background:c.bg,border:`1px solid ${c.border}`,color:c.text,borderRadius:10,padding:"10px 16px",fontSize:13,fontWeight:600,marginBottom:16}}>{msg}</div>;
}

// ─── Main App ─────────────────────────────────────────────────────────────────
// ─── CARLTON JUNIORS RUGBY SYNC ──────────────────────────────────────────────
// (sync bookings use empty email/name and are deduped by date+facility+time+purpose)
const CJR_ORG_ID = "14520";
const CJR_ICAL   = "https://ics.teamup.com/feed/ksooqhdi7ua5ucp58j/15068031.ics";

// Extract team identifier from CPSA EventName ("AU Ultimate Club (Field 3)" → "AU Ultimate Club")
function extractCPSATeam(eventName) {
  const m = (eventName||"").match(/^(.+?)\s*\(/);
  return (m ? m[1] : eventName||"").trim();
}

function normalizeId(s) { return (s||"").toLowerCase().replace(/[^a-z0-9]/g,""); }

function tokenize(s) { return (s||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(Boolean); }

// Does a CPSA team/event name look like our own organisation (AMUA)?
// When it does, the name is NOT an inconsistency even if the matched booking is
// under an individual member's name.
function resemblesAMUA(name) {
  const t = tokenize(name);
  if (t.includes("amua")) return true;
  const hasUltimate = t.includes("ultimate");
  return (hasUltimate && t.includes("mixed")) || (hasUltimate && t.includes("auckland"));
}

// Token-overlap (Jaccard) similarity between two names, 0..1, with acronym handling.
function nameSimilarity(a, b) {
  const ta = tokenize(a), tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const acr = toks => toks.map(w => w[0]).join("");
  if (ta.length === 1 && ta[0] === acr(tb)) return 1;
  if (tb.length === 1 && tb[0] === acr(ta)) return 1;
  const sa = new Set(ta), sb = new Set(tb);
  let inter = 0; sa.forEach(w => { if (sb.has(w)) inter++; });
  return inter / (sa.size + sb.size - inter);
}

// Find a user booking that this CJR event likely represents.
// Returns { booking, exact } where exact=true means tight match (auto-confirm),
// exact=false means fuzzy match (flag for AMUA review).
function findMatchingUserBooking(allBookings, ev, facilityIds) {
  const date = parseCJRDate(ev.EventStartDate);
  if (!date) return null;
  const { start_hour, duration } = parseCJRDateTime(ev.EventDateTime);
  const team = extractCPSATeam(ev.EventName);
  const teamNorm = normalizeId(team);
  if (!teamNorm) return null;

  // Eligible bookings: same date, time-overlap, non-admin, in an approvable state.
  // Facility is NOT required — any time overlap on the same date is considered a
  // potential CPSA link (99% of bookings are via Auckland Mixed Ultimate).
  const candidates = allBookings.filter(b => {
    if (b.email === "admin") return false;
    if (!["approved","cpsa_confirmed","cpsa_review_needed","clash","pending_cpsa","queued_cpsa","pending_amua","amua_submit","pending"].includes(b.status) && !b.invoiced) return false;
    if (b.date !== date) return false;
    if (b.start_hour + b.duration <= start_hour) return false;
    if (start_hour + duration <= b.start_hour) return false;
    return true;
  });
  if (!candidates.length) return null;

  // Score each candidate: identity (4) + time-exact (2) + duration-exact (1) + facility unambiguous (1)
  const scored = candidates.map(b => {
    const emailPrefix = normalizeId((b.email||"").split("@")[0]);
    const nameNorm = normalizeId(b.name);
    const purposeNorm = normalizeId(b.purpose);
    let identityScore = 0;
    if (emailPrefix === teamNorm || nameNorm === teamNorm) identityScore = 4;
    else if (emailPrefix && (emailPrefix.includes(teamNorm) || teamNorm.includes(emailPrefix))) identityScore = 3;
    else if (nameNorm && (nameNorm.includes(teamNorm) || teamNorm.includes(nameNorm))) identityScore = 2;
    else if (nameSimilarity(team, b.name) >= 0.5) identityScore = 2;
    else if (purposeNorm && (purposeNorm.includes(teamNorm) || teamNorm.includes(purposeNorm))) identityScore = 1;
    const timeExact = b.start_hour === start_hour ? 2 : 0;
    const durExact  = b.duration === duration ? 1 : 0;
    const facExact  = facilityIds.length === 1 ? 1 : 0;
    return { booking: b, score: identityScore + timeExact + durExact + facExact, identityScore };
  }).sort((a,b)=>b.score-a.score);

  const best = scored[0];
  const teamIsOurs = resemblesAMUA(team);
  // A CPSA event that is neither our own org (AMUA) nor a plausible identity match
  // to the booking is a *different tenant* renting the same field at an overlapping
  // time — do NOT link it (prevents e.g. "Auckland Girls Grammar" matching an AMUA
  // member's booking purely on time overlap).
  if (!teamIsOurs && best.identityScore < 2) return null;

  // Capture specific inconsistencies between the CPSA event and the matched booking,
  // succinctly (old → new = booked → CPSA), so the admin sees exactly what differs.
  const b = best.booking;
  const reasons = [];
  if (b.start_hour !== start_hour)
    reasons.push(`Time: ${fmtTimeShort(b.start_hour)} → ${fmtTimeShort(start_hour)}`);
  if (b.duration !== duration)
    reasons.push(`Dur: ${b.duration}h → ${duration}h`);
  if (!facilityIds.includes(b.facility_id))
    reasons.push(`Field: ${facShort(b.facility_id)} → ${facilityIds.map(facShort).join("/")}`);
  // Only flag the name when the CPSA event is NOT our own org and the identity match
  // is loose. An AMUA-named event under an individual member is not a name mismatch.
  if (!teamIsOurs && best.identityScore < 4)
    reasons.push(`Name: ${b.name} → ${team}`);

  // Exact = CPSA agrees with the booking on every dimension (no recorded drift) AND
  // the identity link is strong enough to trust. Any inconsistency → review needed,
  // so the specific reasons surface in the admin/booking views.
  const identityOk = teamIsOurs || best.identityScore >= 3;
  const exact = reasons.length === 0 && identityOk;

  return { booking: b, exact, reasons };
}

// Maps facility mentions in EventName to internal facility IDs
function mapCJRFacility(eventName) {
  const n = eventName || "";
  // Extract "(Field 1)", "(Field 2)", "Field 1, 2" style references
  if (/field\s*1.*2|field\s*2.*1/i.test(n)) return ["f3","f4"]; // both fields
  if (/field\s*1\b/i.test(n)) return ["f3"];
  if (/field\s*2\b/i.test(n)) return ["f4"];
  if (/field\s*3\b/i.test(n)) return ["f5"];
  // All-facilities events (mowing, refs, etc.) default to Field 1
  return ["f3"];
}

// Parse "08/06/2026" → "2026-06-08"
function parseCJRDate(s) {
  const [d,m,y] = (s||"").split("/");
  if (!d||!m||!y) return null;
  return `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
}

// Parse "6:30 pm" → 18.5
function parseCJRTime(t) {
  const m = (t||"").trim().match(/^(\d+):(\d+)\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1]), min = parseInt(m[2]), ampm = m[3].toLowerCase();
  if (ampm==="pm" && h!==12) h+=12;
  if (ampm==="am" && h===12) h=0;
  return h + min/60;
}

// Parse EventDateTime string for start_hour and duration
// e.g. "08/06/2026, 6:30 pm to 8:30 pm"  or  "08/06/2026" (no time = all day)
function parseCJRDateTime(dt) {
  if (!dt) return { start_hour: 8, duration: 8 };
  const timeRange = dt.replace(/^\d+\/\d+\/\d+,?\s*/,"").trim();
  const parts = timeRange.split(/\s+to\s+/i);
  if (parts.length < 2) return { start_hour: 8, duration: 8 };
  const start = parseCJRTime(parts[0]);
  const end   = parseCJRTime(parts[1]);
  if (start === null || end === null) return { start_hour: 8, duration: 8 };
  const dur = end - start;
  return { start_hour: start, duration: dur > 0 ? dur : 1 };
}

async function fetchCJREvents(year, month) {
  // month is 0-based
  const dateStr = `${year}-${String(month+1).padStart(2,"0")}-01`;
  const target = `https://www.carltonjuniorsrugby.co.nz/api/v1/calendar/MonthCalendarEvents?organisationId=%2014520&sportId=0&ical=${encodeURIComponent(CJR_ICAL)}&date=${dateStr}`;
  // Try corsproxy.io first, fall back to allorigins
  const proxies = [
    `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
  ];
  let lastErr;
  for (const url of proxies) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch(e) { lastErr = e; }
  }
  throw new Error("All proxies failed: " + lastErr?.message);
}

export default function App() {
  // ALL hooks unconditional (Rules of Hooks)
  const [session,  setSession]  =useState(undefined); // undefined = loading, null = signed out
  const realLoggedInEmail = session?.user?.email?.toLowerCase() || "";
  const realIsAdmin       = session?.user?.app_metadata?.role === "admin";
  const [viewAsEmail, setViewAsEmail] = useState(null); // admin "view as" impersonation target
  const loggedInEmail = (realIsAdmin && viewAsEmail) ? viewAsEmail : realLoggedInEmail;
  // When viewing as another profile, admin powers are dropped unless the target is also admin
  const isAdmin = (realIsAdmin && viewAsEmail)
    ? false  // explicit: viewing AS another user means seeing what they see
    : realIsAdmin;
  const userId        = session?.user?.id || null;
  const [bookings, setBookings] =useState([]);
  const [loading,  setLoading]  =useState(true);
  const [dbError,  setDbError]  =useState("");
  const [tab,      setTab]      =useState("about");
  const [selFac,   setSelFac]   =useState("all");
  const [showForm, setShowForm] =useState(false);
  const [focusedDate, setFocusedDate] = useState(new Date());
  const [dayPopupDate, setDayPopupDate] = useState(null);
  const [dayPopupFocus, setDayPopupFocus] = useState(null);
  const [showCart, setShowCart]       =useState(false);
  const [cart,     setCart]           =useState([]); // { drafts, name, email, isMultiEdit? }[]
  const [informCpsaFor, setInformCpsaFor] = useState(null); // booking awaiting vendor pick for "Inform CPSA"
  const [deleteQueue,setDeleteQueue]  =useState([]); // bookings queued for removal
  const [showDeleteCart,setShowDeleteCart]=useState(false);
  const [editing,  setEditing]  =useState(null);
  const [viewing,  setViewing]  =useState(null);
  const [prefill,  setPrefill]  =useState({date:null,startHour:9,duration:1});
  const [toast,    setToast]    =useState(null);
  const [syncingMonth, setSyncingMonth] = useState(false);
  // Cumulative sync log across all months ever synced (persisted so the monthly
  // log survives reloads; old entries are purged per the admin retention setting).
  // Each entry: { monthKey, label, added, skipped, removed, cpsaConfirmed,
  //   cpsaReviewNeeded, clashes, notified, syncedAt, lastChangeAt }
  const [syncResults, setSyncResults] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_sync_results")||"[]"); }catch{ return []; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_sync_results", JSON.stringify(syncResults)); }catch{ /* ignore */ } }, [syncResults]);
  // Admin-configurable retention (in months) for activity & sync logs. 0 = keep forever.
  const [logRetentionMonths, setLogRetentionMonthsState] = useState(()=>{
    const v = parseInt(localStorage.getItem("fb_log_retention_months"),10);
    return Number.isFinite(v) ? v : 1;
  });
  const [showRetentionModal, setShowRetentionModal] = useState(false);
  const [showSyncPanel, setShowSyncPanel] = useState(false);
  const [showActivityLog, setShowActivityLog] = useState(false);
  const [showRatesModal, setShowRatesModal] = useState(false);
  const [showPlayersModal, setShowPlayersModal] = useState(false);
  const [showUserMgmtModal, setShowUserMgmtModal] = useState(false);
  // emailAliases: { secondaryEmail: primaryEmail } — secondaries fold into the primary profile.
  const [emailAliases, setEmailAliases] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_email_aliases")||"{}"); }catch{ return {}; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_email_aliases", JSON.stringify(emailAliases)); }catch{ /* ignore */ } _emailAliases = emailAliases; }, [emailAliases]);
  // aliasNames: { primaryEmail: displayName } — overrides the default email-prefix label.
  const [aliasNames, setAliasNames] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_alias_names")||"{}"); }catch{ return {}; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_alias_names", JSON.stringify(aliasNames)); }catch{ /* ignore */ } }, [aliasNames]);
  const canonEmail = useCallback(em => {
    if (!em) return em;
    const k = em.toLowerCase();
    return (emailAliases[k] || k);
  }, [emailAliases]);
  const displayNameFor = useCallback(em => {
    if (!em) return em;
    const primary = canonEmail(em);
    return aliasNames[primary] || primary.split("@")[0];
  }, [canonEmail, aliasNames]);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [silentMode, setSilentMode] = useState(true); // admin: suppress all outgoing emails
  // fb_profiles: { [primaryEmail]: { fullName, officialName, address, gstNumber,
  //               accountNumber, accountName, profileType: "user"|"admin"|"vendor" } }
  const [profiles, setProfiles] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_profiles")||"{}"); }catch{ return {}; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_profiles", JSON.stringify(profiles)); }catch{ /* ignore */ } }, [profiles]);
  // fb_billing_records: official invoice history { id, referenceId, date, type, bookerEmails,
  //   amount, gstMode, status, gtecInvoiceNumber, clubPayment, amuaPayment, bookingIds }
  const [billingRecords, setBillingRecords] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_billing_records")||"[]"); }catch{ return []; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_billing_records", JSON.stringify(billingRecords)); }catch{ /* ignore */ } }, [billingRecords]);
  // Bumped each time the user clicks "↗ Summary" on a billing row; SummaryTab
  // reacts to the version change rather than the payload itself so repeated
  // loads of the same record still take effect.
  const [summaryLoadRequest, setSummaryLoadRequest] = useState(null);
  function handleLoadBillingToSummary(rec) {
    // Resolve which bookers to filter to. A batch payload may carry many emails;
    // a single-record payload uses bookerEmail. PO records ("gtec"/"combined")
    // fall back to all bookers covered by linked invoice records.
    let emails = [];
    if (Array.isArray(rec.emails) && rec.emails.length) {
      emails = rec.emails;
    } else if (Array.isArray(rec.linkedInvoiceIds) && rec.linkedInvoiceIds.length) {
      emails = billingRecords.filter(r=>rec.linkedInvoiceIds.includes(r.id)).map(r=>r.bookerEmail).filter(Boolean);
    } else {
      const em = (rec.bookerEmail||"").toLowerCase();
      if (em && em!=="combined" && em!=="gtec") emails = [em];
    }
    const canon = new Set(emails.map(e=>(emailAliases[e.toLowerCase()]||e).toLowerCase()).filter(Boolean));
    setListBookerFilter(canon);
    setSummaryLoadRequest({ dateFrom: rec.dateFrom||"", dateTo: rec.dateTo||"", version: Date.now() });
    setTab("summary");
  }
  const [facilityRates, setFacilityRates] = useState(()=>{
    try{return JSON.parse(localStorage.getItem("fb_facility_rates")||"{}");}catch{return {};}
  });
  // Pricing conditions: booker rate overrides (manual + invoice-locked snapshots).
  const [pricingConditions, setPricingConditions] = useState(()=>{
    try{return JSON.parse(localStorage.getItem("fb_pricing_conditions")||"[]");}catch{return [];}
  });
  const [listBookerFilter, setListBookerFilter] = useState(new Set()); // empty = all (additive multi-select)
  const [showBookerPicker, setShowBookerPicker] = useState(false);
  // Toggle a booker; if it's a primary with linked secondaries, toggle the whole profile group.
  const toggleBooker = em => setListBookerFilter(prev => {
    const s = new Set(prev);
    const group = new Set([em]);
    Object.entries(emailAliases).forEach(([sec, pri]) => { if (pri === em) group.add(sec); });
    if (s.has(em)) group.forEach(g => s.delete(g));
    else group.forEach(g => s.add(g));
    return s;
  });
  const [listShowClashes, setListShowClashes]   = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showAdminScheduleModal, setShowAdminScheduleModal] = useState(false);
  const [showExtensionModal, setShowExtensionModal] = useState(false);
  const [approxPlayers, setApproxPlayers] = useState(()=>{
    try{return JSON.parse(localStorage.getItem("fb_approx_players")||"{}");}catch{return {};}
  });
  const [approxDurations, setApproxDurations] = useState(()=>{
    try{return JSON.parse(localStorage.getItem("fb_approx_durations")||"{}");}catch{return {};}
  });
  const [pricingMode, setPricingModeState] = useState(()=>localStorage.getItem("fb_pricing_mode")||"hourly");
  const [listDateFrom,    setListDateFrom]      = useState("");
  const [listDateTo,      setListDateTo]        = useState("");
  const [listStatusFilter,setListStatusFilter]  = useState("all");
  const [listColPurpose,  setListColPurpose]    = useState("");
  const [listColFacility, setListColFacility]   = useState("all");
  const [listSortCol,     setListSortCol]       = useState("date");
  const [listSortDir,     setListSortDir]       = useState("asc");

  const isMobile = useMobile();
  const configured = !!SUPABASE_URL && !!SUPABASE_ANON;

  // Bootstrap auth session and subscribe to changes
  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      setSession(s);
      _accessToken = s?.access_token || null;
      _currentUser = s?.user ? { id: s.user.id, email: s.user.email } : null;
    });
    const { data: sub } = supabase.auth.onAuthStateChange((evt, s) => {
      if (evt === "SIGNED_OUT") logActivity("sign_out", {}); // log before clearing _currentUser
      setSession(s);
      _accessToken = s?.access_token || null;
      _currentUser = s?.user ? { id: s.user.id, email: s.user.email } : null;
      if (evt === "SIGNED_IN") logActivity("sign_in", { email: s?.user?.email });
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  function showToast(msg,type="success"){setToast({msg,type});setTimeout(()=>setToast(null),3500);}

  async function loadBookings() {
    if(!configured){setLoading(false);return;}
    try{setBookings(await sb.select("bookings"));setDbError("");}
    catch(e){setDbError("Could not connect to database. ("+e.message+")");}
    finally{setLoading(false);}
  }

  async function loadSettings() {
    if(!configured) return;
    try {
      const rows = await sb.selectAll("settings");
      const map = {};
      rows.forEach(r => { map[r.key] = r.value; });
      if (map.facility_rates && typeof map.facility_rates === "object") {
        setFacilityRates(map.facility_rates);
        try{localStorage.setItem("fb_facility_rates",JSON.stringify(map.facility_rates));}catch{ /* ignore */ }
      }
      if (Array.isArray(map.pricing_conditions)) {
        setPricingConditions(map.pricing_conditions);
        try{localStorage.setItem("fb_pricing_conditions",JSON.stringify(map.pricing_conditions));}catch{ /* ignore */ }
      }
      if (map.approx_players && typeof map.approx_players === "object") {
        setApproxPlayers(map.approx_players);
        try{localStorage.setItem("fb_approx_players",JSON.stringify(map.approx_players));}catch{ /* ignore */ }
      }
      if (map.approx_durations && typeof map.approx_durations === "object") {
        setApproxDurations(map.approx_durations);
        try{localStorage.setItem("fb_approx_durations",JSON.stringify(map.approx_durations));}catch{ /* ignore */ }
      }
      if (Number.isFinite(parseInt(map.log_retention_months,10))) {
        const m = parseInt(map.log_retention_months,10);
        setLogRetentionMonthsState(m);
        try{localStorage.setItem("fb_log_retention_months",String(m));}catch{ /* ignore */ }
      }
    } catch(e) {
      // settings table may not yet exist; silent fallback to localStorage
      console.warn("loadSettings:", e.message);
    }
  }

  async function persistSetting(key, value) {
    if(!configured) return;
    try { await sb.upsert("settings", { key, value, updated_at: new Date().toISOString() }, "key"); }
    catch(e) { console.warn("persistSetting "+key+":", e.message); }
  }

  async function handleSyncMonth(year, month) {
    setSyncingMonth(true);
    try {
      const events = await fetchCJREvents(year, month);
      let added = 0, skipped = 0, removed = 0, cpsaConfirmed = 0, cpsaReviewNeeded = 0;
      const addedBookings = []; // snapshots of bookings added this sync (for the expandable log)
      const currentBookings = configured ? (await sb.select("bookings")) : bookings;
      const matchedUserIds = new Set();
      const cpsaNotifications = []; // notify-only cart items for first-time CPSA status changes

      // Build set of canonical keys for this month's feed + a list of time slots
      // (date/start/duration) used to decide whether a booking still overlaps CPSA.
      const feedKeys = new Set();
      const feedSlots = [];
      for (const ev of events) {
        const date = parseCJRDate(ev.EventStartDate);
        if (!date) continue;
        const { start_hour, duration } = parseCJRDateTime(ev.EventDateTime);
        const purpose = ev.EventName || "External Booking";
        const facilityIds = mapCJRFacility(purpose);
        feedSlots.push({ date, start_hour, duration });
        for (const facility_id of facilityIds) {
          feedKeys.add(`${date}|${facility_id}|${start_hour}|${purpose}`);
        }
      }

      // Remove admin bookings in this month that are no longer in the feed (only future dates)
      const monthStr = `${year}-${String(month+1).padStart(2,"0")}`;
      const syncToday = todayKey();
      const staleAdminBks = currentBookings.filter(b =>
        isAdminBooking(b) &&
        b.date.startsWith(monthStr) &&
        b.date >= syncToday &&
        !feedKeys.has(`${b.date}|${b.facility_id}|${b.start_hour}|${b.purpose}`)
      );
      for (const sb_bk of staleAdminBks) {
        if (configured) {
          await sb.remove("bookings", sb_bk.id);
        } else {
          setBookings(prev => prev.filter(b => b.id !== sb_bk.id));
        }
        removed++;
        logActivity("cpsa_admin_booking_remove", { id: sb_bk.id, date: sb_bk.date, facility_id: sb_bk.facility_id, purpose: sb_bk.purpose });
      }

      for (const ev of events) {
        const date = parseCJRDate(ev.EventStartDate);
        if (!date) { skipped++; continue; }
        const { start_hour, duration } = parseCJRDateTime(ev.EventDateTime);
        const purpose = ev.EventName || "External Booking";
        const facilityIds = mapCJRFacility(purpose);

        // Check if this CPSA event matches an existing approved user booking
        const match = findMatchingUserBooking(currentBookings, ev, facilityIds);
        if (match) {
          const targetStatus = match.exact ? "cpsa_confirmed" : "cpsa_review_needed";
          matchedUserIds.add(match.booking.id);

          // Remove any pre-existing admin bookings at this slot (from prior syncs)
          for (const facility_id of facilityIds) {
            const slotBk = { date, facility_id, start_hour, duration, id: "_sentinel_" };
            const oldAdmin = currentBookings.find(b => isAdminBooking(b) && timeOverlaps(b, slotBk));
            if (oldAdmin) {
              if (configured) await sb.remove("bookings", oldAdmin.id);
              else setBookings(prev => prev.filter(b => b.id !== oldAdmin.id));
            }
          }

          // Record/clear mismatch reasons in system_notes (separate from user notes).
          const newSysNotes = targetStatus === "cpsa_review_needed"
            ? setMismatchNote(match.booking.system_notes, match.reasons)
            : stripMismatchNote(match.booking.system_notes);
          const statusChanged = match.booking.status !== targetStatus;
          const sysNotesChanged = (match.booking.system_notes || "") !== newSysNotes;
          if (statusChanged || sysNotesChanged) {
            if (configured) {
              // Always update status first — this is the critical write.
              if (statusChanged) await sb.update("bookings", match.booking.id, { status: targetStatus, updated_at: new Date().toISOString() });
              // system_notes is best-effort: silently no-ops until migration is run.
              if (sysNotesChanged) sb.update("bookings", match.booking.id, { system_notes: newSysNotes }).catch(() => {});
            } else {
              const patch = { status: targetStatus, system_notes: newSysNotes, updated_at: new Date().toISOString() };
              setBookings(prev => prev.map(b => b.id === match.booking.id ? { ...b, ...patch } : b));
            }
          }
          if (statusChanged) {
            if (match.exact) cpsaConfirmed++; else cpsaReviewNeeded++;
            logActivity(match.exact?"cpsa_confirm":"cpsa_review_flag", { booking_id: match.booking.id, from: match.booking.status, to: targetStatus, reasons: match.reasons||[] });
            // First-time transition into a CPSA status → queue a notify-only cart item.
            if (match.booking.email && !isAdminBooking(match.booking)) {
              cpsaNotifications.push({
                drafts: [{ ...match.booking, status: targetStatus, system_notes: newSysNotes }],
                name: match.booking.name, email: match.booking.email,
                notifyOnly: true, newStatus: targetStatus,
              });
            }
          }
          continue;
        }

        for (const facility_id of facilityIds) {
          const dup = currentBookings.find(b =>
            b.date === date &&
            b.facility_id === facility_id &&
            b.start_hour === start_hour &&
            b.purpose === purpose &&
            b.email === "admin"
          );
          if (dup) { skipped++; continue; }
          const newBk = {
            id: newId(),
            facility_id,
            date,
            start_hour,
            duration,
            purpose,
            name: "admin",
            email: "admin",
            status: "approved",
            created_at: new Date().toISOString(),
          };
          if (configured) {
            await sb.insert("bookings", newBk);
          } else {
            setBookings(prev => [...prev, newBk]);
          }
          added++;
          addedBookings.push({ id: newBk.id, facility_id, date, start_hour, duration, purpose });
          logActivity("cpsa_admin_booking_add", { date, facility_id, start_hour, duration, purpose });
        }
      }
      if (configured) await loadBookings();

      // Reset cpsa_confirmed/cpsa_review_needed bookings in this month only when NO
      // CPSA feed event overlaps them at all — i.e. they are genuinely gone from CPSA.
      // A booking that still overlaps a feed event keeps its flag even if it wasn't the
      // top-scored match this run, so legitimate mismatches are never silently wiped.
      const cpsaLinkedUnmatched = currentBookings.filter(b => {
        if (isAdminBooking(b)) return false;
        if (!b.date.startsWith(monthStr) || b.date < syncToday) return false;
        if (b.status !== "cpsa_confirmed" && b.status !== "cpsa_review_needed") return false;
        if (matchedUserIds.has(b.id)) return false;
        const stillOverlaps = feedSlots.some(s =>
          s.date === b.date &&
          b.start_hour < s.start_hour + s.duration &&
          s.start_hour < b.start_hour + b.duration
        );
        return !stillOverlaps;
      });
      for (const cb of cpsaLinkedUnmatched) {
        const strippedSysNotes = stripMismatchNote(cb.system_notes);
        if (configured) {
          await sb.update("bookings", cb.id, { status: "approved", updated_at: new Date().toISOString() });
          sb.update("bookings", cb.id, { system_notes: strippedSysNotes }).catch(() => {});
        } else {
          setBookings(prev => prev.map(b => b.id === cb.id ? { ...b, status: "approved", system_notes: strippedSysNotes, updated_at: new Date().toISOString() } : b));
        }
      }
      if (configured && cpsaLinkedUnmatched.length > 0) await loadBookings();

      // Auto-detect clashes with newly imported admin events and set user bookings to "clash"
      const freshBookings = configured ? (await sb.select("bookings")) : bookings;
      const today = todayKey();
      const adminBks = freshBookings.filter(b => isAdminBooking(b) && b.date >= today);
      const userBks  = freshBookings.filter(b => !isAdminBooking(b) && b.date >= today);
      let clashUpdates = 0;
      for (const ub of userBks) {
        // Skip bookings already matched/confirmed via CPSA — their admin slot was removed above
        if (matchedUserIds.has(ub.id)) continue;
        if (ub.status === "cpsa_confirmed" || ub.status === "cpsa_review_needed") continue;
        const hasClash = adminBks.some(ab => ab.facility_id === ub.facility_id && timeOverlaps(ab, ub));
        if (hasClash && ub.status !== "clash") {
          if (configured) {
            await sb.update("bookings", ub.id, { status: "clash", updated_at: new Date().toISOString() });
          } else {
            setBookings(prev => prev.map(b => b.id === ub.id ? {...b, status:"clash"} : b));
          }
          clashUpdates++;
        }
      }
      if (configured && clashUpdates > 0) await loadBookings();

      // Queue CPSA status-change notifications in the cart (notify-only, no booking edits).
      if (cpsaNotifications.length) setCart(prev => [...prev, ...cpsaNotifications]);

      const label = `${MONTHS[month]} ${year}`;
      const monthKey = `${year}-${String(month+1).padStart(2,"0")}`;
      const syncedAt = new Date().toISOString();
      const hadChanges = added + cpsaConfirmed + cpsaReviewNeeded + removed + clashUpdates > 0;
      setSyncResults(prev => {
        const existing = prev.find(r => r.monthKey === monthKey);
        const without = prev.filter(r => r.monthKey !== monthKey);
        // lastChangeAt = when this month last produced an actual new change; preserved
        // from the prior result when this sync turned up nothing new.
        const lastChangeAt = hadChanges ? syncedAt : (existing?.lastChangeAt || null);
        return [...without, { monthKey, label, added, skipped, removed, cpsaConfirmed, cpsaReviewNeeded, clashes: clashUpdates, notified: cpsaNotifications.length, addedBookings, syncedAt, lastChangeAt }];
      });
    } catch(e) {
      setSyncResults(prev => {
        const monthKey = `${year}-${String(month+1).padStart(2,"0")}`;
        const existing = prev.find(r => r.monthKey === monthKey);
        const without = prev.filter(r => r.monthKey !== monthKey);
        return [...without, { monthKey, label: `${MONTHS[month]} ${year}`, error: e.message, syncedAt: new Date().toISOString(), lastChangeAt: existing?.lastChangeAt || null }];
      });
    } finally {
      setSyncingMonth(false);
    }
  }

  async function handleSyncAll() {
    const today = todayKey();
    const future = bookings.filter(b => b.date >= today);
    const months = new Set();
    const now = new Date();
    months.add(`${now.getFullYear()}-${now.getMonth()}`);
    for (const b of future) {
      const [y,m] = b.date.split("-");
      months.add(`${parseInt(y)}-${parseInt(m)-1}`);
    }
    const sorted = [...months].map(k=>k.split("-").map(Number)).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    // Drop months that have aged out of the retention window before re-syncing.
    purgeOldLogs();
    logActivity("cpsa_sync_start", { months: sorted.length });
    for (const [y,m] of sorted) {
      await handleSyncMonth(y, m);
    }
    try{localStorage.setItem("fb_last_sync_at", String(Date.now()));}catch{ /* ignore */ }
    logActivity("cpsa_sync_complete", { months: sorted.length });
    purgeOldLogs();
    // Notify with a non-intrusive toast
    setSyncResults(cur => {
      const total = cur.reduce((s,r)=>s+(r.added||0),0);
      showToast(`🔄 Sync complete — ${sorted.length} month${sorted.length!==1?"s":""}, ${total} new booking${total!==1?"s":""}`);
      return cur;
    });
    setShowSyncPanel(true);
    setTab("admin");
  }

  // All hooks before any conditional return
  useEffect(()=>{
    if(!session) return;
    loadBookings();
    // Auto-sync CPSA if admin and last sync was more than 4 hours ago
    if(session.user?.app_metadata?.role==="admin"){
      const last=parseInt(localStorage.getItem("fb_last_sync_at")||"0",10);
      if(Date.now()-last > 4*60*60*1000) {
        // Defer slightly so bookings load first
        setTimeout(()=>handleSyncAll(),2000);
      }
    }
  },[session]);
  // If the booker filter points at an email with no bookings, fall back to "all"
  useEffect(()=>{
    if(listBookerFilter.size===0||loading) return;
    const present = new Set(bookings.filter(b=>!isAdminBooking(b)&&b.email).map(b=>b.email.toLowerCase()));
    const pruned = [...listBookerFilter].filter(em=>present.has(em));
    if(pruned.length!==listBookerFilter.size) setListBookerFilter(new Set(pruned));
  },[bookings,loading,listBookerFilter]);
  useEffect(()=>{
    (async()=>{ await loadSettings(); purgeOldLogs(); })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  const openNew=useCallback((date,startHour,duration=1,facility=null)=>{setEditing(null);setPrefill({date,startHour,duration,facility});setDayPopupDate(null);setShowForm(true);},[]);
  const openDay=useCallback((dk,focusHour=null)=>{setDayPopupDate(dk);setDayPopupFocus(focusHour);},[]);
  const openEdit=useCallback((b)=>{setEditing({...b});setViewing(null);setShowForm(true);},[]);

  bookings.forEach(b=>emailColor(b.email));
  if(loggedInEmail)emailColor(loggedInEmail);

  // Login gate — after all hooks
  if(session === undefined) return null; // auth session still loading
  if(!session) return <EmailLoginScreen/>;

  // handleSave now accepts an array of drafts + name/email for multi-booking support
  async function handleSave(drafts, bookerName, bookerEmail, { skipEmail = false } = {}) {
    skipEmail = skipEmail || silentMode;
    const draftsArr = Array.isArray(drafts) ? drafts : [drafts];
    // Strip client-only fields that don't exist in Supabase schema
    const toDb = d => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'recur'));
    const isNew = !bookings.find(b=>b.id===draftsArr[0].id);
    if(configured){
      try{
        for(const d of draftsArr){
          const exists=bookings.find(b=>b.id===d.id);
          if(exists) await sb.update("bookings",d.id,toDb(d));
          else       await sb.insert("bookings",{...toDb(d), user_id: userId});
        }
        await loadBookings();
      }catch(e){showToast("Save failed: "+e.message,"error");return;}
    } else {
      setBookings(prev=>{
        let next=[...prev];
        draftsArr.forEach(d=>{next=next.filter(b=>b.id!==d.id);next.push(d);});
        return next;
      });
    }
    setShowForm(false);setViewing(null);
    logActivity(isNew?"booking_create":"booking_edit", { count: draftsArr.length, ids: draftsArr.map(d=>d.id) });
    showToast(isNew?`${draftsArr.length} booking${draftsArr.length>1?"s":""} submitted!`:"Booking updated!");

    // Send confirmation email (skipped when caller handles its own sending, e.g. handleCartSubmit)
    if (!skipEmail) {
      const orderRef="ORD-"+Date.now().toString(36).toUpperCase();
      const name=bookerName||draftsArr[0]?.name||"";
      const email=bookerEmail||draftsArr[0]?.email||"";
      sendEmail({
        to: email,
        subject: isNew?`Booking Request Received [${orderRef}]`:`Booking Updated`,
        html: isNew
          ? buildOrderEmailHtml({name,email,bookings:draftsArr,orderRef})
          : buildApprovalEmailHtml({name,email,bookings:draftsArr,newStatus:draftsArr[0].status,adminNote:""}),
      });
    }
  }

  function handleStatusChange(booking,newStatus) {
    // Queue the whole action — the status change and its email are applied when the
    // cart is submitted, not on click.
    setCart(c => [...c, {
      statusChange:true, ids:[booking.id], newStatus, adminNote:"", skipEmail:false,
      drafts:[booking], name:booking.name, email:booking.email,
    }]);
    setViewing(null);
    showToast(`${STATUS_META[newStatus]?.label||newStatus} queued in cart.`);
  }

  function updateFacilityRate(facilityId, type, value) {
    const existing = typeof facilityRates[facilityId] === "object" ? facilityRates[facilityId] : { day: 0, evening: 0 };
    const newRates = { ...facilityRates, [facilityId]: { ...existing, [type]: parseFloat(value) || 0 } };
    setFacilityRates(newRates);
    try{localStorage.setItem("fb_facility_rates",JSON.stringify(newRates));}catch{ /* ignore */ }
    persistSetting("facility_rates", newRates);
  }

  // Pricing conditions — persisted like facility rates (local + synced setting).
  function savePricingConditions(next) {
    setPricingConditions(next);
    try{localStorage.setItem("fb_pricing_conditions",JSON.stringify(next));}catch{ /* ignore */ }
    persistSetting("pricing_conditions", next);
  }
  function addPricingCondition(cond) { savePricingConditions([...pricingConditions, cond]); }
  function updatePricingCondition(id, patch) { savePricingConditions(pricingConditions.map(c=>c.id===id?{...c,...patch}:c)); }
  function removePricingCondition(id) { savePricingConditions(pricingConditions.filter(c=>c.id!==id)); }

  function setPricingMode(mode) {
    setPricingModeState(mode);
    try{localStorage.setItem("fb_pricing_mode", mode);}catch{ /* ignore */ }
  }
  function setLogRetentionMonths(months) {
    const m = Math.max(0, parseInt(months,10) || 0);
    setLogRetentionMonthsState(m);
    try{localStorage.setItem("fb_log_retention_months", String(m));}catch{ /* ignore */ }
    persistSetting("log_retention_months", m);
    purgeOldLogs(m);
  }
  // Purge activity-log rows and sync-log months older than the retention window.
  // 0 months = keep forever. Activity-log deletes require the admin DELETE policy
  // from supabase-migration-activity-log.sql.
  async function purgeOldLogs(months = logRetentionMonths) {
    const m = Math.max(0, parseInt(months,10) || 0);
    if (!m) return;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - m);
    const cutoffISO = cutoff.toISOString();
    setSyncResults(prev => prev.filter(r => !r.syncedAt || r.syncedAt >= cutoffISO));
    if (configured && isAdmin) {
      try { await sb.removeWhere("activity_log", `created_at=lt.${cutoffISO}`); }
      catch(e) { console.warn("purgeOldLogs activity_log:", e.message); }
    }
  }
  function updateApproxPlayers(email, value) {
    const v = Math.max(0, parseInt(value) || 0);
    const next = { ...approxPlayers, [email.toLowerCase()]: v };
    setApproxPlayers(next);
    try{localStorage.setItem("fb_approx_players",JSON.stringify(next));}catch{ /* ignore */ }
    persistSetting("approx_players", next);
  }
  function updateApproxDuration(email, value) {
    const v = Math.max(0, parseFloat(value) || 0);
    const next = { ...approxDurations, [email.toLowerCase()]: v };
    setApproxDurations(next);
    try{localStorage.setItem("fb_approx_durations",JSON.stringify(next));}catch{ /* ignore */ }
    persistSetting("approx_durations", next);
  }

  async function handleSyncDB() {
    await loadBookings();
    await loadSettings();
    await persistSetting("facility_rates", facilityRates);
    await persistSetting("pricing_conditions", pricingConditions);
    await persistSetting("approx_players", approxPlayers);
    await persistSetting("approx_durations", approxDurations);
    await persistSetting("log_retention_months", logRetentionMonths);
    showToast("Synced with database.");
  }

  async function handleBulkApply({bkgs, bulkTime, bulkDur, bulkFac, cancelFrom}) {
    const toCancel = cancelFrom ? bkgs.filter(b=>b.date>=cancelFrom) : [];
    const toUpdate = bkgs.filter(b=>!cancelFrom||b.date<cancelFrom);
    // Apply edits immediately. Cancellations are NOT deleted here — they're routed
    // through the removal (email) cart so the booker gets a cancellation email on submit.
    if(toUpdate.length>0){
      if(configured){
        try{
          for(const b of toUpdate) await sb.update("bookings",b.id,{start_hour:bulkTime,duration:bulkDur,facility_id:bulkFac,updated_at:new Date().toISOString()});
          await loadBookings();
        }catch(e){showToast("Bulk apply failed: "+e.message,"error");return;}
      } else {
        const updateIds=new Set(toUpdate.map(b=>b.id));
        setBookings(prev=>prev.map(b=>updateIds.has(b.id)?{...b,start_hour:bulkTime,duration:bulkDur,facility_id:bulkFac}:b));
      }
    }
    if(toCancel.length>0){
      setDeleteQueue(prev => { const have=new Set(prev.map(b=>b.id)); return [...prev, ...toCancel.filter(b=>!have.has(b.id))]; });
      setShowDeleteCart(true);
    }
    const parts=[
      toUpdate.length>0&&`${toUpdate.length} updated`,
      toCancel.length>0&&`${toCancel.length} queued for removal`,
    ].filter(Boolean);
    showToast(parts.join(", ")||"Applied.");
  }

  function handleProposeMerge() {
    showToast("Merge proposal added — commit your cart to notify bookers.");
  }

  // Advance billing_state for a CPSA-amended booking (credit_pending→credited, invoice_pending→invoiced).
  async function handleMarkAdjustmentSettled(booking, newBillingState) {
    const res = parseCpsaResolution(booking.system_notes);
    if (!res) return;
    const sysNotes = setCpsaResolution(booking.system_notes, res.resolution, newBillingState);
    const patch = { system_notes: sysNotes, updated_at: new Date().toISOString() };
    if (configured) {
      try {
        await sb.update("bookings", booking.id, patch);
        sb.insert("mismatch_log", {
          booking_id: booking.id,
          resolution: res.resolution,
          billing_state: newBillingState,
        }).catch(()=>{});
        await loadBookings();
      } catch(e) { showToast("Update failed: "+e.message, "error"); return; }
    } else {
      setBookings(prev => prev.map(b => b.id === booking.id ? { ...b, ...patch } : b));
    }
    logActivity("mismatch_billing_settled", { booking_id: booking.id, billing_state: newBillingState });
    showToast(newBillingState === "credited" ? "Marked as credited." : "Marked as invoiced.");
  }

  // Persist a mismatch resolution — called from AdminPanel via onSaveMismatch prop.
  // Returns true on success so AdminPanel can clear its local pending state.
  async function handleSaveMismatch(booking, patch, logPayload) {
    if (configured) {
      try {
        await sb.update("bookings", booking.id, patch);
        const orig = parseCpsaOrig(patch.system_notes) || { facility_id:booking.facility_id, start_hour:booking.start_hour, duration:booking.duration };
        sb.insert("mismatch_log", {
          booking_id: booking.id,
          reasons: logPayload.reasons,
          orig_facility_id: orig.facility_id,
          orig_start_hour: orig.start_hour,
          orig_duration: orig.duration,
          resolution: logPayload.resolution,
          billing_state: logPayload.billing_state || "none",
        }).catch(()=>{}); // best-effort — silently no-ops until migration is run
        await loadBookings();
      } catch(e) { showToast("Save failed: "+e.message, "error"); return false; }
    } else {
      setBookings(prev => prev.map(b => b.id === booking.id ? { ...b, ...patch } : b));
    }
    logActivity("mismatch_resolution", { booking_id:booking.id, resolution:logPayload.resolution, billing_state:logPayload.billing_state });
    const msg = logPayload.resolution === "amended"
      ? "Booking updated to GTEC values."
      : logPayload.resolution === "to_correct"
      ? "Flagged for GTEC to correct."
      : "Resolution saved.";
    showToast(msg);
    return true;
  }

  // Flag bookings as invoiced and snapshot their billed dimensions so any later
  // change to time/duration/field can be reconciled (owing vs credit).
  async function handleMarkInvoiced(bkgs) {
    const targets = bkgs.filter(b => !isAdminBooking(b) && !b.invoiced);
    if (!targets.length) { showToast("Already invoiced."); return; }
    if (configured) {
      try {
        for (const b of targets) {
          await sb.update("bookings", b.id, { invoiced:true, updated_at:new Date().toISOString() });
          sb.update("bookings", b.id, { system_notes:setBilledSnapshot(b.system_notes, b) }).catch(()=>{});
        }
        await loadBookings();
      } catch(e) { showToast("Mark invoiced failed: "+e.message, "error"); return; }
    } else {
      const ids = new Set(targets.map(b=>b.id));
      setBookings(prev => prev.map(b => ids.has(b.id) ? { ...b, invoiced:true, system_notes:setBilledSnapshot(b.system_notes, b) } : b));
    }
    logActivity("invoiced", { count: targets.length, ids: targets.map(b=>b.id) });
    showToast(`${targets.length} booking${targets.length>1?"s":""} marked invoiced.`);
  }

  function handleCreateOfficialInvoice(newRecords) {
    // No immediate invoicing — bookings are marked invoiced when record leaves Draft.
    const batchId = `BATCH-${Date.now()}`;
    const tagged = newRecords.map(r => ({ ...r, batchId }));
    setBillingRecords(prev => [...prev, ...tagged]);
    logActivity("official_invoice_created", { count: tagged.length, ids: tagged.map(r=>r.id) });
    const invCount = tagged.filter(r=>r.type==="invoice"||!r.type).length;
    const poCount  = tagged.filter(r=>r.type==="purchase_order").length;
    showToast(`Created ${invCount} invoice${invCount!==1?"s":""} + ${poCount} PO.`);
  }

  // Update a billing record; when status advances from draft, mark linked bookings
  // invoiced and settle any credit adjustments bundled into the invoice.
  async function handleUpdateBillingRecord(patch) {
    let creditTargets = [];
    let lockedConds = [];
    setBillingRecords(prev => {
      const old = prev.find(r=>r.id===patch.id);
      if (old && (old.status||"draft")==="draft" && patch.status && patch.status!=="draft") {
        // Mark regular bookings as invoiced
        const ids = new Set(old.bookingIds||[]);
        if (ids.size) {
          const targets = bookings.filter(b=>ids.has(b.id)&&!isAdminBooking(b)&&!b.invoiced);
          if (targets.length) handleMarkInvoiced(targets);
        }
        // Collect credit bookings to settle (done outside setState to avoid async-in-setter)
        const creditIds = new Set(old.creditBookingIds||[]);
        if (creditIds.size) {
          creditTargets = bookings.filter(b=>creditIds.has(b.id));
        }
        // Pin the prices billed: one locked pricing condition per booker+facility for
        // this invoice's date range, snapshotting the rate that was actually applied.
        if ((old.type==="invoice"||!old.type) && old.bookerEmail && old.bookerEmail!=="gtec") {
          const invBkgs = bookings.filter(b=>ids.has(b.id));
          const facIds = [...new Set(invBkgs.map(b=>b.facility_id))];
          const from = old.dateFrom, to = old.dateTo, stamp = new Date().toISOString();
          const src = `invoice ${old.referenceId||old.gtecInvoiceNumber||old.id||""}`.trim();
          lockedConds = facIds.map(facId => {
            const eff = resolveRates(facilityRates, pricingConditions, facId, old.bookerEmail, from);
            return { id:newId(), bookerEmail:old.bookerEmail.toLowerCase(), facilityId:facId, period:"both",
              dayRate:eff.day, eveningRate:eff.evening, dateFrom:from, dateTo:to, locked:true, source:src, createdAt:stamp };
          });
        }
      }
      return prev.map(r=>r.id===patch.id?{...r,...patch}:r);
    });
    // Settle credits — run after setState so booking state is consistent
    for (const b of creditTargets) {
      await handleMarkAdjustmentSettled(b, "credited");
    }
    // Persist invoice-locked pricing snapshots (after setState so state is consistent)
    if (lockedConds.length) savePricingConditions([...pricingConditions, ...lockedConds]);
  }

  // Bulk approve/reject — groups by email and sends one summary per person
  function handleBulkStatusChange(ids, newStatus, adminNote, skipEmail=false) {
    const affected=bookings.filter(b=>ids.includes(b.id));
    if(!affected.length) return;
    // Queue the whole action — one cart card per booker so emails group cleanly and
    // the change is applied (and emailed) only on cart submit.
    const byEmail={};
    affected.forEach(b=>{ const k=b.email.toLowerCase(); if(!byEmail[k]) byEmail[k]={name:b.name,email:b.email,bkgs:[]}; byEmail[k].bkgs.push(b); });
    const items=Object.values(byEmail).map(({name,email,bkgs})=>({
      statusChange:true, ids:bkgs.map(b=>b.id), newStatus, adminNote, skipEmail,
      drafts:bkgs, name, email,
    }));
    setCart(c=>[...c, ...items]);
    showToast(`${ids.length} booking${ids.length>1?"s":""} queued in cart.`);
  }

  // Queue a booking for removal (shows in removal cart)
  function queueForRemoval(id) {
    const b = bookings.find(x=>x.id===id); if(!b) return;
    setDeleteQueue(prev => prev.find(x=>x.id===id) ? prev : [...prev, b]);
    setViewing(null);
    showToast("Added to removal queue.");
  }

  // Queue for removal without opening the modal (used by admin panel row delete)
  function queueForRemovalSilent(id) {
    const b = bookings.find(x=>x.id===id); if(!b) return;
    setDeleteQueue(prev => prev.find(x=>x.id===id) ? prev : [...prev, b]);
    showToast("Added to removal queue.");
  }

  // Queue multiple bookings for removal
  function queueMultiForRemoval(ids) {
    const toAdd = ids.map(id=>bookings.find(b=>b.id===id)).filter(Boolean);
    setDeleteQueue(prev => {
      const existing = new Set(prev.map(b=>b.id));
      return [...prev, ...toAdd.filter(b=>!existing.has(b.id))];
    });
    showToast(`${toAdd.length} booking${toAdd.length>1?"s":""} added to removal queue.`);
  }

  // Submit the deletion queue — delete all, optionally send email summaries grouped by email
  async function handleDeleteCartSubmit(adminNote, skipEmail=false) {
    if(deleteQueue.length === 0) return;
    const ids = deleteQueue.map(b=>b.id);
    if(configured){
      try{ await Promise.all(ids.map(id=>sb.remove("bookings",id))); await loadBookings(); }
      catch(e){showToast("Delete failed: "+e.message,"error");return;}
    } else { setBookings(prev=>prev.filter(b=>!ids.includes(b.id))); }

    if(!skipEmail){
      // Group by email and send one summary per booker via order template (deletions section)
      const byEmail = {};
      deleteQueue.forEach(b => {
        const k = b.email.toLowerCase();
        if(!byEmail[k]) byEmail[k] = {name:b.name, email:b.email, bkgs:[]};
        byEmail[k].bkgs.push(b);
      });
      await Promise.all(Object.values(byEmail).map(({name,email,bkgs})=>
        sendEmail({to:email, subject:`Your Booking${bkgs.length>1?"s have":" has"} been removed`,
          html:buildOrderEmailHtml({name, email, bookings:[], deletedBookings:bkgs, orderRef:null, isDeletionOnly:true})})
      ));
    }

    showToast(`${ids.length} booking${ids.length>1?"s":""} removed.`);
    setDeleteQueue([]);
    setShowDeleteCart(false);
  }

  // Move old unapproved (past pending) bookings into the removal queue — the actual
  // delete and the booker email happen when the removal cart is submitted.
  function handleClearOldUnapproved(ids) {
    if(!ids.length) return;
    const toRemove = bookings.filter(b=>ids.includes(b.id));
    setDeleteQueue(prev => { const have=new Set(prev.map(b=>b.id)); return [...prev, ...toRemove.filter(b=>!have.has(b.id))]; });
    setShowDeleteCart(true);
    showToast(`${toRemove.length} old booking${toRemove.length>1?"s":""} moved to the removal queue.`);
  }

  // Multi-edit from month view: create one edit-row per booking, add all to cart
  function handleMultiAddToCart(selectedBookings) {
    const ref = selectedBookings[0];
    const drafts = selectedBookings.map(b => ({
      ...b,
      updated_at: new Date().toISOString(),
    }));
    const sourceIds = selectedBookings.map(b=>b.id);
    setCart(prev => [...prev, { drafts, name: ref.name, email: ref.email, isMultiEdit: true, sourceIds }]);
    showToast(`${drafts.length} bookings added to cart for editing!`);
  }

  function handleAddToCart(drafts, name, email, sourceIds=[]) {
    const isEdit = drafts.some(d => d.id && bookings.find(b => b.id === d.id));
    setCart(prev => [...prev, { drafts, name, email, sourceIds, isEdit }]);
    setShowForm(false);
    setEditing(null);
    showToast(isEdit ? "Edit added to cart." : `${drafts.length} booking${drafts.length>1?"s":""} added to cart!`);
  }

  // "Inform CPSA": cart an email to a selected vendor carrying the booking's CPSA
  // submission link and a notification reference, asking them to correct CPSA's
  // schedule. Does NOT change the booking / resolve the mismatch.
  function addInformCpsaToCart(booking, vendorEmail, vendorName) {
    const refs = parseCpsaRefs(booking.system_notes, booking.notes);
    const submissionId = "GTEC-" + Date.now().toString(36).toUpperCase();
    setCart(c => [...c, {
      informCpsa: true, notifyOnly: true,
      drafts: [booking], name: vendorName || vendorEmail, email: vendorEmail,
      cpsaRefs: refs, submissionId,
    }]);
    setInformCpsaFor(null);
    showToast("Inform-GTEC email added to cart.");
  }

  // Generic outbox queue — admin notification actions (clash, mismatch, …) push
  // their email descriptors here instead of sending; the cart submit sends them.
  function queueNotifications(items, label) {
    const arr = (items||[]).filter(Boolean);
    if (!arr.length) return;
    setCart(c => [...c, ...arr]);
    showToast(`${arr.length} ${label||"notification"}${arr.length>1?"s":""} added to cart.`);
  }

  async function handleCartSubmit() {
    if (cart.length === 0) return;
    // The cart is the single outbox. Three kinds of work:
    //  • statusChange — deferred admin actions; the status mutation is applied here,
    //    then the booker is emailed (sync-style "mutate on submit, then notify").
    //  • save items   — new bookings + edits (notify-only items are never re-saved).
    //  • notify-only  — clash / CPSA / mismatch / inform-CPSA emails (no mutation).
    const statusItems = cart.filter(item => item.statusChange);
    const saveItems   = cart.filter(item => !item.notifyOnly && !item.statusChange);
    const notifyItems = cart.filter(item => item.notifyOnly);

    // 1. New bookings + edits.
    const allDrafts = saveItems.flatMap(item => item.drafts);
    if (allDrafts.length) {
      const name = (saveItems[0]||{}).name, email = (saveItems[0]||{}).email;
      await handleSave(allDrafts, name, email, { skipEmail: true });
    }

    // 2. Apply the queued status changes (the whole action was deferred to submit).
    if (statusItems.length) {
      const now = new Date().toISOString();
      if (configured) {
        try {
          await Promise.all(statusItems.flatMap(it => it.ids.map(id => sb.update("bookings", id, { status: it.newStatus, updated_at: now }))));
          await loadBookings();
        } catch(e) { showToast("Status update failed: "+e.message, "error"); return; }
      } else {
        setBookings(prev => prev.map(b => { const it = statusItems.find(s => s.ids.includes(b.id)); return it ? {...b, status: it.newStatus, updated_at: now} : b; }));
      }
      statusItems.forEach(it => logActivity("status_change", { ids: it.ids, to: it.newStatus, count: it.ids.length }));
    }

    if (!silentMode) {
      const noEmailStatuses = new Set(["pending_cpsa"]);
      // Status-change emails — one per booker card, unless that card opted out.
      for (const it of statusItems) {
        if (it.skipEmail || noEmailStatuses.has(it.newStatus)) continue;
        const statusLabel = STATUS_META[it.newStatus]?.label || it.newStatus;
        sendApprovalEmail({to:it.email,
          subject:`Your Booking${it.drafts.length>1?"s":""} — ${statusLabel}`,
          html:buildApprovalEmailHtml({name:it.name, email:it.email, bookings:it.drafts.map(d=>({...d,status:it.newStatus})), newStatus:it.newStatus, adminNote:it.adminNote||""})});
      }
      // Notify-only emails: clash alerts, CPSA status notices, mismatch, inform-CPSA.
      for (const item of notifyItems) {
        if (item.clashNotify) {
          sendApprovalEmail({to:item.email, subject:"⚠️ Scheduling Clash – Action Required",
            html:buildClashEmailHtml({name:item.name, email:item.email, clashes:item.clashes||[]})});
          continue;
        }
        const b = item.drafts[0];
        if (item.informCpsa) {
          // Vendor alert — asks CPSA to correct their record; booking is untouched.
          sendApprovalEmail({to:item.email, subject:`GTEC Booking Discrepancy — ${b.purpose||fmtDate(b.date)}`,
            html:buildInformCpsaEmailHtml({vendorName:item.name, booking:b, refs:item.cpsaRefs||[], submissionId:item.submissionId})});
        } else if (item.newStatus==="cpsa_review_needed") {
          // Mismatch notice → the proper amber mismatch email (not the red rejection template).
          sendApprovalEmail({to:item.email, subject:"⚡ GTEC Booking Mismatch – Please Review",
            html:buildMismatchEmailHtml({name:item.name, email:item.email, bookings:item.drafts})});
        } else {
          sendApprovalEmail({to:item.email, subject:"Booking Confirmed by GTEC",
            html:buildApprovalEmailHtml({name:item.name, email:item.email, bookings:[b], newStatus:item.newStatus, adminNote:""})});
        }
      }
      // New bookings: group by email and send one order confirmation each
      const newItems = saveItems.filter(item => !item.isEdit && !item.isMultiEdit);
      const byEmailNew = {};
      newItems.forEach(item => {
        const k = item.email.toLowerCase();
        if(!byEmailNew[k]) byEmailNew[k] = {name:item.name, email:item.email, drafts:[]};
        byEmailNew[k].drafts.push(...item.drafts);
      });
      for (const {name:n, email:e, drafts:d} of Object.values(byEmailNew)) {
        const orderRef = "ORD-"+Date.now().toString(36).toUpperCase();
        sendEmail({to:e, subject:`Booking Request Received [${orderRef}]`,
          html:buildOrderEmailHtml({name:n,email:e,bookings:d,orderRef})});
      }
      // Edits: send one "Booking Updated" per item (each is a separate edit)
      for (const item of cart.filter(item => item.isEdit)) {
        sendApprovalEmail({to:item.email, subject:"Booking Updated",
          html:buildApprovalEmailHtml({name:item.name,email:item.email,bookings:item.drafts,newStatus:item.drafts[0]?.status,adminNote:""})});
      }
    }

    setCart([]);
    setShowCart(false);
  }

  function handleLogout(){supabase?.auth.signOut();setCart([]);}

  const pendingCount=bookings.filter(b=>REVIEW_STATUSES.has(b.status)).length;

  // ─── Clash detection ──────────────────────────────────────────────────────
  const allClashes = getClashes(bookings);
  // For admin: total clash pairs; for user: clashes involving their bookings
  const myClashCount = isAdmin
    ? allClashes.length
    : allClashes.filter(c => c.user.email?.toLowerCase() === loggedInEmail?.toLowerCase()).length;

  function TabBtn({id,label,badge}){return(
    <button onClick={()=>setTab(id)} style={{padding:"8px 12px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",background:tab===id?"#0f172a":"transparent",color:tab===id?"#fff":"#64748b",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",flexShrink:0}}>
      {label}{badge>0&&<span style={{background:"#f43f5e",color:"#fff",borderRadius:999,fontSize:10,fontWeight:700,padding:"1px 6px"}}>{badge}</span>}
    </button>
  );}

  const FacilityPills=()=>(
    <div style={{display:"flex",gap:6,marginBottom:16,alignItems:"center",overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",msOverflowStyle:"none",paddingBottom:2}}>
      <button onClick={()=>setSelFac("all")} style={{padding:"5px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,borderColor:selFac==="all"?"#0f172a":"#e2e8f0",background:selFac==="all"?"#0f172a":"#fff",color:selFac==="all"?"#fff":"#475569"}}>All</button>
      {FACILITIES.map(f=>(
        <button key={f.id} onClick={()=>setSelFac(f.id===selFac?"all":f.id)} style={{padding:"5px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",display:"inline-flex",alignItems:"center",gap:5,flexShrink:0,borderColor:selFac===f.id?f.color:"#e2e8f0",background:selFac===f.id?f.color:"#fff",color:selFac===f.id?"#fff":"#475569"}}>
          <span style={{width:8,height:8,borderRadius:"50%",background:f.color}}/>{f.name}
        </button>
      ))}
    </div>
  );

  // One legend entry per canonical booker: linked secondaries fold into their
  // primary so a booker with multiple emails shows a single pill. `bookerGroups`
  // maps each primary → the full set of its addresses (primary + secondaries) so
  // selecting the pill filters/toggles every booking under that booker.
  const bookerGroups = (() => {
    const g = {};
    bookings.filter(b=>!isAdminBooking(b)).forEach(b=>{
      const em = b.email?.toLowerCase(); if(!em) return;
      const primary = canonEmail(em);
      (g[primary] ||= new Set()).add(em); g[primary].add(primary);
    });
    return g;
  })();
  const emailLegend = Object.keys(bookerGroups).sort();

  return (
    <div style={{minHeight:"100vh",background:"#f8fafc",fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif"}}>
      <style>{MOBILE_STYLE}</style>
      {toast&&<div style={{position:"fixed",top:16,right:16,zIndex:2000,background:toast.type==="error"?"#f43f5e":"#22c55e",color:"#fff",padding:"10px 18px",borderRadius:10,fontWeight:600,fontSize:13,boxShadow:"0 4px 20px rgba(0,0,0,0.15)"}}>{toast.msg}</div>}

      {/* View-as banner */}
      {realIsAdmin && viewAsEmail && (
        <div style={{background:"#4338ca",color:"#fff",padding:"8px 16px",display:"flex",alignItems:"center",gap:10,fontSize:12,fontWeight:600,boxShadow:"0 1px 4px rgba(0,0,0,0.15)"}}>
          <span style={{fontSize:14}}>👁</span>
          <span>Viewing as <strong>{aliasNames[viewAsEmail]||viewAsEmail.split("@")[0]}</strong> ({viewAsEmail})</span>
          <span style={{fontSize:11,opacity:0.8,fontWeight:400}}>— interface and settings reflect this profile</span>
          <button onClick={()=>{ setViewAsEmail(null); showToast("Exited profile view"); }}
            style={{marginLeft:"auto",background:"#fff",color:"#4338ca",border:"none",borderRadius:6,padding:"4px 12px",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>
            ✕ Exit profile view
          </button>
        </div>
      )}

      {/* Header */}
      <div style={{background:"#fff",borderBottom:"1px solid #f1f5f9",padding:"0 16px"}}>
        <div style={{maxWidth:1300,margin:"0 auto"}}>
          {/* Top row: logo + user + action buttons */}
          <div style={{display:"flex",alignItems:"center",gap:10,height:56,flexWrap:"nowrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              <img src={LOGO_SRC} alt="AMUA" style={{width:34,height:34,borderRadius:8,objectFit:"cover"}}/>
              {!isMobile&&<span style={{fontSize:15,fontWeight:800,color:"#0f172a",letterSpacing:"-0.02em"}}>FacilityBook</span>}
              {!configured&&<span style={{fontSize:10,background:"#fef3c7",color:"#92400e",padding:"2px 6px",borderRadius:6,fontWeight:600}}>Demo</span>}
            </div>
            <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexShrink:0,flexWrap:"nowrap"}}>
              {/* Cart / removal — always visible when populated */}
              {cart.length>0&&(
                <button onClick={()=>setShowCart(true)} style={S.btn({background:"#f59e0b",color:"#fff",display:"flex",alignItems:"center",gap:4,padding:"7px 10px"})}>
                  🛒{!isMobile&&" Cart"}
                  <span style={{background:"#fff",color:"#92400e",borderRadius:999,fontSize:11,fontWeight:800,padding:"1px 6px",minWidth:18,textAlign:"center"}}>{cart.reduce((s,i)=>s+i.drafts.length,0)}</span>
                </button>
              )}
              {deleteQueue.length>0&&(
                <button onClick={()=>setShowDeleteCart(true)} style={S.btn({background:"#7f1d1d",color:"#fff",display:"flex",alignItems:"center",gap:4,padding:"7px 10px"})}>
                  🗑{!isMobile&&" Removal"}
                  <span style={{background:"#fff",color:"#7f1d1d",borderRadius:999,fontSize:11,fontWeight:800,padding:"1px 6px",minWidth:18,textAlign:"center"}}>{deleteQueue.length}</span>
                </button>
              )}
              {isAdmin&&(()=>{
                const lastMs=parseInt(localStorage.getItem("fb_last_sync_at")||"0",10);
                const minsAgo=lastMs?Math.floor((Date.now()-lastMs)/60000):null;
                const syncLabel=minsAgo===null?"Never synced":minsAgo<1?"Just synced":minsAgo<60?`${minsAgo}m ago`:`${Math.floor(minsAgo/60)}h ago`;
                return(
                  <button onClick={handleSyncAll} disabled={syncingMonth}
                    title={`Sync all months with GTEC · Last: ${syncLabel}`}
                    style={S.btn({background:syncingMonth?"#e2e8f0":"#0ea5e9",color:syncingMonth?"#94a3b8":"#fff",fontSize:11,padding:"7px 10px",cursor:syncingMonth?"wait":"pointer",opacity:syncingMonth?0.7:1})}>
                    {syncingMonth?"⏳":"🔄"}{!isMobile&&(syncingMonth?` Syncing…`:` Sync`)}
                  </button>
                );
              })()}
              <button onClick={()=>openNew(todayKey(),9,1)} style={S.btn({background:"#2d4a1e",color:"#fff",padding:"7px 10px",fontSize:12})}>
                {isMobile?"+ Book":"+ New Booking"}
              </button>
              {/* User dropdown — replaces inline status pill + admin buttons */}
              <div style={{position:"relative"}}>
                <button onClick={()=>setShowUserMenu(v=>!v)} title={loggedInEmail}
                  style={{display:"flex",alignItems:"center",gap:6,background:showUserMenu?"#eef2ff":"#f8fafc",border:`1px solid ${showUserMenu?"#c7d2fe":"#e2e8f0"}`,borderRadius:20,padding:"4px 8px 4px 4px",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600,color:"#475569"}}>
                  <span style={{width:26,height:26,borderRadius:"50%",background:emailColor(loggedInEmail),display:"inline-flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:11,fontWeight:800}}>{(loggedInEmail||"?")[0]?.toUpperCase()}</span>
                  {!isMobile&&<span style={{maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{loggedInEmail?.split("@")[0]}</span>}
                  <span style={{fontSize:9,color:"#94a3b8"}}>▾</span>
                </button>
                {showUserMenu&&(
                  <>
                    <div onClick={()=>setShowUserMenu(false)} style={{position:"fixed",inset:0,zIndex:30}}/>
                    <div style={{position:"absolute",right:0,top:"calc(100% + 6px)",zIndex:31,background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:12,boxShadow:"0 8px 24px rgba(15,23,42,0.12)",minWidth:240,overflow:"hidden",fontSize:13}}>
                      <div style={{padding:"10px 14px",borderBottom:"1px solid #f1f5f9",background:"#f8fafc"}}>
                        <div style={{fontSize:11,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",fontWeight:700}}>Signed in</div>
                        <div style={{fontSize:12,color:"#0f172a",fontWeight:600,marginTop:2,wordBreak:"break-all"}}>{loggedInEmail}</div>
                        <div style={{marginTop:6,display:"flex",alignItems:"center",gap:6}}>
                          <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:10,background:isAdmin?"#f3e8ff":"#f1f5f9",color:isAdmin?"#7c3aed":"#475569",border:`1px solid ${isAdmin?"#ddd6fe":"#e2e8f0"}`}}>{isAdmin?"👑 Admin":"👤 User"}</span>
                        </div>
                      </div>
                      {isAdmin&&(
                        <div style={{padding:"6px 0",borderBottom:"1px solid #f1f5f9"}}>
                          <div style={{padding:"4px 14px 6px",fontSize:10,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",fontWeight:700}}>Admin</div>
                          <button onClick={()=>setSilentMode(v=>!v)}
                            style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"9px 14px",background:silentMode?"#fef3c7":"transparent",border:"none",fontFamily:"inherit",fontSize:13,color:silentMode?"#92400e":"#0f172a",textAlign:"left",cursor:"pointer",fontWeight:500}}>
                            <span style={{fontSize:14,width:18,textAlign:"center"}}>{silentMode?"🔇":"🔔"}</span>
                            <span style={{flex:1}}>{silentMode?"Silent mode ON":"Silent mode off"}</span>
                            <span style={{position:"relative",width:30,height:18,flexShrink:0}}>
                              <span style={{position:"absolute",inset:0,borderRadius:9,background:silentMode?"#f59e0b":"#cbd5e1",transition:"background 0.2s"}}/>
                              <span style={{position:"absolute",top:2,left:silentMode?14:2,width:14,height:14,borderRadius:"50%",background:"#fff",boxShadow:"0 1px 2px rgba(0,0,0,0.2)",transition:"left 0.2s"}}/>
                            </span>
                          </button>
                          <UserMenuItem icon="🧩" label="Install Extension" onClick={()=>{setShowUserMenu(false);setShowExtensionModal(true);}}/>
                          <UserMenuItem icon="💲" label="Facility Rates" onClick={()=>{setShowUserMenu(false);setShowRatesModal(true);}}/>
                          <UserMenuItem icon="👥" label="Player Counts" onClick={()=>{setShowUserMenu(false);setShowPlayersModal(true);}}/>
                          <UserMenuItem icon="👤" label="User Management" onClick={()=>{setShowUserMenu(false);setShowUserMgmtModal(true);}}/>
                          <UserMenuItem icon="📜" label="Activity Log" onClick={()=>{setShowUserMenu(false);setShowActivityLog(true);}}/>
                          <UserMenuItem icon="🗑" label="Log Retention" onClick={()=>{setShowUserMenu(false);setShowRetentionModal(true);}}/>
                          <UserMenuItem icon="⬇" label="Reload from DB" onClick={()=>{setShowUserMenu(false);handleSyncDB();}}/>
                        </div>
                      )}
                      <UserMenuItem icon="↪" label="Sign out" onClick={()=>{setShowUserMenu(false);handleLogout();}} danger/>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          {/* Bottom row: tabs (always visible, scrollable) */}
          <div style={{display:"flex",gap:2,overflowX:"auto",paddingBottom:8,WebkitOverflowScrolling:"touch",scrollbarWidth:"none",msOverflowStyle:"none"}}>
            <TabBtn id="about"    label={isMobile?"ℹ️":"ℹ️ About"}/>
            <TabBtn id="calendar" label={isMobile?"📅 Week":"📅 Week"}/>
            <TabBtn id="month"    label={isMobile?"🗓 Month":"🗓 Month"}/>
            <TabBtn id="list"     label={isMobile?"📋 List":"📋 Bookings"} badge={myClashCount>0?myClashCount:undefined}/>
            <TabBtn id="summary"  label={isMobile?"📊":"📊 Summary"}/>
            {(isAdmin||!!loggedInEmail)&&<TabBtn id="billing" label={isMobile?"🧾":"🧾 Billing"}/>}
            {isAdmin&&<TabBtn id="admin" label={isMobile?"⚙ Admin":"⚙ Admin"} badge={pendingCount}/>}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{maxWidth:1300,margin:"0 auto",padding:"16px 12px"}}>
        {dbError&&<Banner type="error" msg={dbError}/>}
        {!configured&&<Banner type="info" msg="⚙️  Demo Mode — add Supabase credentials to enable persistent storage."/>}

        {emailLegend.length>0&&(tab==="calendar"||tab==="month"||tab==="list"||tab==="summary"||(tab==="admin"&&isAdmin))&&(()=>{
          // Top header: one pill per canonical booker (by alias). The All/None chip
          // toggles between "everything selected" and "nothing selected". Linked
          // secondaries are folded into their primary's group.
          const allLower = [...new Set(emailLegend.flatMap(p=>[...bookerGroups[p]]))];
          const allSelected = listBookerFilter.size>0 && allLower.every(e=>listBookerFilter.has(e));
          return (
            <div style={{display:"flex",gap:6,marginBottom:12,alignItems:"center",overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",msOverflowStyle:"none",paddingBottom:2}}>
              <button onClick={()=>setListBookerFilter(allSelected?new Set():new Set(allLower))}
                title={allSelected?"Clear all bookers":"Select all bookers"}
                style={{padding:"5px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,borderColor:listBookerFilter.size===0?"#0f172a":"#e2e8f0",background:listBookerFilter.size===0?"#0f172a":"#fff",color:listBookerFilter.size===0?"#fff":"#475569"}}>
                {allSelected?"None":"All"}
              </button>
              {emailLegend.map(primary=>{
                const group=bookerGroups[primary];
                const active=[...group].every(em=>listBookerFilter.has(em));
                const c=emailColor(primary);
                const others=[...group].filter(em=>em!==primary);
                return(
                  <button key={primary} onClick={()=>toggleBooker(primary)}
                    title={others.length?`${primary} (+ ${others.join(", ")})`:primary}
                    style={{padding:"5px 12px",borderRadius:20,border:`1.5px solid ${active?c:"#e2e8f0"}`,cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,background:active?c:"#fff",color:active?"#fff":"#475569"}}>
                    {displayNameFor(primary)}
                  </button>
                );
              })}
            </div>
          );
        })()}

        {(tab==="calendar"||tab==="month"||tab==="list")&&<FacilityPills/>}

        {tab==="calendar"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<WeekCalendar bookings={bookings} selectedFacility={selFac} onNewBooking={openNew} onBookingClick={setViewing} cartSourceIds={new Set(cart.flatMap(i=>i.sourceIds||[]))} deleteIds={new Set(deleteQueue.map(b=>b.id))} cartNewDrafts={cart.flatMap(i=>!i.notifyOnly&&!i.statusChange&&(i.sourceIds||[]).length===0?i.drafts:[])} focusedDate={focusedDate} setFocusedDate={setFocusedDate} onOpenDay={openDay} bookerFilter={listBookerFilter} aliasNames={aliasNames} emailAliases={emailAliases}/>}</div>}
        {tab==="month"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<MonthCalendar bookings={bookings} selectedFacility={selFac} onBookingClick={setViewing} onNewBooking={openNew} onMultiDelete={queueMultiForRemoval} onMultiAddToCart={handleMultiAddToCart} loggedInEmail={loggedInEmail} isAdmin={isAdmin} cartSourceIds={new Set(cart.flatMap(i=>i.sourceIds||[]))} deleteIds={new Set(deleteQueue.map(b=>b.id))} cartNewDrafts={cart.flatMap(i=>!i.notifyOnly&&!i.statusChange&&(i.sourceIds||[]).length===0?i.drafts:[])} onOpenDay={openDay} onGotoWeek={dk=>{ setFocusedDate(new Date(dk+"T00:00:00")); setTab("calendar"); }} bookerFilter={listBookerFilter} aliasNames={aliasNames} emailAliases={emailAliases}/>}</div>}

        {tab==="list"&&(
          <div style={S.card}>
            {loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:(()=>{
              const bookerMap = {};
              bookings.filter(b=>!isAdminBooking(b)&&b.email&&b.name).forEach(b=>{bookerMap[b.email.toLowerCase()]=b.name;});
              const bookerEmails = Object.keys(bookerMap).sort();
              const clashAdminIds = new Set(allClashes.map(c=>c.admin.id));
              const clashUserIds  = new Set(allClashes.map(c=>c.user.id));
              const allClashIds   = new Set([...clashAdminIds,...clashUserIds]);
              const listDir = listSortDir==="asc"?1:-1;
              let visible = [...bookings]
                .filter(b => !isAdminBooking(b))
                .filter(b => selFac==="all" || b.facility_id===selFac)
                .filter(b => listColFacility==="all" || b.facility_id===listColFacility)
                .filter(b => listBookerFilter.size===0 || listBookerFilter.has(b.email?.toLowerCase()))
                .filter(b => listStatusFilter==="all" || b.status===listStatusFilter)
                .filter(b => !listShowClashes || allClashIds.has(b.id))
                .filter(b => !listDateFrom || b.date>=listDateFrom)
                .filter(b => !listDateTo   || b.date<=listDateTo)
                .filter(b => !listColPurpose || (b.purpose||"").toLowerCase().includes(listColPurpose.toLowerCase()))
                .sort((a,b)=>{
                  if(listSortCol==="date") return listDir*(a.date.localeCompare(b.date)||a.start_hour-b.start_hour);
                  if(listSortCol==="booker") return listDir*(a.name||"").localeCompare(b.name||"");
                  if(listSortCol==="facility") return listDir*(a.facility_id||"").localeCompare(b.facility_id||"");
                  if(listSortCol==="status") return listDir*(a.status||"").localeCompare(b.status||"");
                  return listDir*(a.date.localeCompare(b.date)||a.start_hour-b.start_hour);
                });

              function lToggleSort(col) {
                if(listSortCol===col) setListSortDir(d=>d==="asc"?"desc":"asc");
                else { setListSortCol(col); setListSortDir("asc"); }
              }
              const lArrow = col => listSortCol===col?(listSortDir==="asc"?" ↑":" ↓"):"";
              const anyListFilter = listDateFrom||listDateTo||listStatusFilter!=="all"||listColPurpose||listColFacility!=="all";

              return (
                <>
                  {/* Top action bar */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8,alignItems:"center"}}>
                    {allClashes.length>0&&(
                      <button onClick={()=>setListShowClashes(v=>!v)}
                        style={S.btn({background:listShowClashes?"#ef4444":"#fff",color:listShowClashes?"#fff":"#ef4444",border:"1.5px solid #ef4444",fontSize:12,fontWeight:700})}>
                        ⚠️ {listShowClashes?"All":"Clashes only"} ({allClashes.length})
                      </button>
                    )}
                    <button onClick={()=>setShowScheduleModal(true)}
                      style={S.btn({background:"#f0f9ff",color:"#0369a1",border:"1.5px solid #bae6fd",fontSize:12,fontWeight:700})}>
                      📅 Summarise
                    </button>
                  </div>
                  {visible.length===0
                    ? <div style={{textAlign:"center",padding:"40px 0",color:"#94a3b8",fontSize:14}}>No bookings match the current filters.</div>
                    : <div style={{overflowX:"auto",borderRadius:10,border:"1px solid #f1f5f9"}}>
                        <CopyableTable>
                        <table style={{width:"100%",borderCollapse:"collapse",background:"#fff",fontSize:12}}>
                          <thead>
                            <tr style={{background:"#f8fafc"}}>
                              {[["date","Date"],["booker","Booker"],["facility","Fac"],["status","Status"]].map(([col,label])=>(
                                <th key={col} onClick={()=>lToggleSort(col)}
                                  style={{padding:"4px 6px",textAlign:"left",cursor:"pointer",userSelect:"none",fontWeight:600,color:"#64748b",whiteSpace:"nowrap",borderBottom:"1px solid #e2e8f0",fontSize:11}}>
                                  {label}{lArrow(col)}
                                </th>
                              ))}
                              <th style={{padding:"4px 6px",textAlign:"left",fontWeight:600,color:"#64748b",borderBottom:"1px solid #e2e8f0",fontSize:11,whiteSpace:"nowrap"}}>Time</th>
                              <th style={{padding:"4px 6px",textAlign:"left",fontWeight:600,color:"#64748b",borderBottom:"1px solid #e2e8f0",fontSize:11}}>GTEC</th>
                              <th style={{padding:"4px 6px",textAlign:"left",fontWeight:600,color:"#64748b",borderBottom:"1px solid #e2e8f0",fontSize:11}}>Purpose</th>
                            </tr>
                            <tr style={{background:"#f1f5f9"}}>
                              <th style={{padding:"3px 4px",position:"relative"}}>
                                <DateRangePicker
                                  from={listDateFrom} to={listDateTo}
                                  onApply={(f,t)=>{setListDateFrom(f);setListDateTo(t);}}
                                />
                              </th>
                              <th style={{padding:"3px 4px",whiteSpace:"normal",position:"relative"}}>
                                {(()=>{
                                  const allSel = listBookerFilter.size>0 && bookerEmails.every(e=>listBookerFilter.has(e));
                                  return (
                                    <div style={{display:"flex",gap:3,alignItems:"center",flexWrap:"wrap"}}>
                                      <button onClick={()=>setListBookerFilter(allSel?new Set():new Set(bookerEmails))}
                                        title={allSel?"Clear all bookers":"Select all bookers"}
                                        style={{padding:"1px 7px",fontSize:10,borderRadius:10,border:"1.5px solid #e2e8f0",background:listBookerFilter.size===0?"#0f172a":"#fff",color:listBookerFilter.size===0?"#fff":"#475569",cursor:"pointer",fontWeight:listBookerFilter.size===0?700:400,lineHeight:1.6}}>{allSel?"None":"All"}</button>
                                      <button onClick={()=>setShowBookerPicker(v=>!v)}
                                        style={{display:"inline-flex",alignItems:"center",gap:4,padding:"1px 7px",fontSize:10,borderRadius:10,border:`1.5px solid ${listBookerFilter.size>0?"#0f172a":"#e2e8f0"}`,background:"#fff",color:"#475569",cursor:"pointer",fontWeight:600,lineHeight:1.6}}>
                                        <span>👥</span>
                                        {listBookerFilter.size>0&&<span style={{display:"inline-flex",alignItems:"center",justifyContent:"center",minWidth:14,height:14,padding:"0 4px",borderRadius:7,background:"#0f172a",color:"#fff",fontSize:9,fontWeight:700}}>{listBookerFilter.size}</span>}
                                        <span style={{fontSize:8,color:"#94a3b8"}}>▾</span>
                                      </button>
                                      {showBookerPicker&&(
                                        <>
                                          <div onClick={()=>setShowBookerPicker(false)} style={{position:"fixed",inset:0,zIndex:30}}/>
                                          <div style={{position:"absolute",top:"100%",left:0,zIndex:31,marginTop:4,background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:10,boxShadow:"0 8px 24px rgba(15,23,42,0.12)",padding:8,minWidth:200,maxWidth:340,maxHeight:300,overflowY:"auto"}}>
                                            <div style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:6,padding:"0 2px"}}>Filter bookers</div>
                                            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                                              {bookerEmails.map(em=>{
                                                const active=listBookerFilter.has(em);
                                                const c=emailColor(em);
                                                return(
                                                  <button key={em} onClick={()=>toggleBooker(em)}
                                                    style={{padding:"3px 8px",fontSize:11,borderRadius:14,border:`1.5px solid ${active?c:"#e2e8f0"}`,background:active?c:"#fff",color:active?"#fff":"#475569",cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>
                                                    {displayNameFor(em)}
                                                  </button>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  );
                                })()}
                              </th>
                              <th style={{padding:"3px 4px"}}>
                                <select value={listColFacility} onChange={e=>setListColFacility(e.target.value)}
                                  style={{padding:"3px 4px",fontSize:11,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}>
                                  <option value="all">All</option>
                                  {FACILITIES.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
                                </select>
                              </th>
                              <th style={{padding:"3px 4px"}}>
                                <select value={listStatusFilter} onChange={e=>setListStatusFilter(e.target.value)}
                                  style={{padding:"3px 4px",fontSize:11,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}>
                                  <option value="all">All</option>
                                  {Object.entries(STATUS_META).filter(([k])=>!["pending","amua_submit"].includes(k)).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
                                </select>
                              </th>
                              <th style={{padding:"3px 4px"}}/>
                              <th style={{padding:"3px 4px"}}/>
                              <th style={{padding:"3px 4px"}}>
                                <div style={{display:"flex",gap:2,alignItems:"center"}}>
                                  <input placeholder="Search purpose…" value={listColPurpose} onChange={e=>setListColPurpose(e.target.value)}
                                    style={{padding:"3px 6px",fontSize:11,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",flex:1}}/>
                                  {anyListFilter&&(
                                    <button onClick={()=>{setListDateFrom("");setListDateTo("");setListStatusFilter("all");setListColPurpose("");setListColFacility("all");}}
                                      title="Clear all column filters"
                                      style={{padding:"2px 5px",fontSize:10,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",color:"#64748b",cursor:"pointer",flexShrink:0}}>✕</button>
                                  )}
                                </div>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {visible.map((b,ri)=>{
                              const f=FACILITIES.find(x=>x.id===b.facility_id);
                              const isAdmin_bk=isAdminBooking(b);
                              const isClash=allClashIds.has(b.id);
                              const facShort = f ? (f.name.includes("Field") ? f.name.replace("Field ","F") : f.name.split("–")[0].trim().split(" ")[0]) : "—";
                              return(
                                <tr key={b.id} onClick={()=>setViewing(b)} style={{background:isAdmin_bk?"#f8fafc":isClash?"#fff5f5":"#fff",borderTop:ri>0?"1px solid #f1f5f9":"none",cursor:"pointer"}}
                                  onMouseEnter={e=>e.currentTarget.style.background=isAdmin_bk?"#f1f5f9":"#f8fafc"}
                                  onMouseLeave={e=>e.currentTarget.style.background=isAdmin_bk?"#f8fafc":isClash?"#fff5f5":"#fff"}>
                                  <td style={{padding:"3px 6px",whiteSpace:"nowrap",color:"#475569",fontSize:11}}>{fmtDateShort(b.date)}</td>
                                  <td style={{padding:"3px 6px"}}>
                                    {isAdmin_bk
                                      ? <span style={{fontSize:10,fontWeight:700,color:"#94a3b8",background:"#f1f5f9",borderRadius:10,padding:"2px 6px"}}>🔒</span>
                                      : <span onClick={e=>{e.stopPropagation();toggleBooker(b.email.toLowerCase());}} style={{display:"inline-block",padding:"2px 8px",borderRadius:10,background:emailColor(b.email),color:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",outline:listBookerFilter.has(b.email.toLowerCase())?"2px solid #0f172a":"none",outlineOffset:1}}>
                                          {displayNameFor(b.email)}
                                        </span>
                                    }
                                  </td>
                                  <td style={{padding:"3px 6px",whiteSpace:"nowrap"}}>
                                    <span style={{display:"inline-flex",alignItems:"center",gap:3}}>
                                      <span style={{width:6,height:6,borderRadius:"50%",background:f?.color,display:"inline-block",flexShrink:0}}/>
                                      <span style={{fontSize:11,color:"#475569"}}>{facShort}</span>
                                    </span>
                                  </td>
                                  <td style={{padding:"3px 6px"}}>
                                    <Badge status={b.status}/>
                                    {isClash&&<span style={{display:"block",fontSize:9,fontWeight:700,color:"#ef4444"}}>⚡clash</span>}
                                  </td>
                                  <td style={{padding:"3px 6px",whiteSpace:"nowrap",color:"#475569",fontSize:11}}>{fmt24(b.start_hour)}–{fmt24(b.start_hour+b.duration)}</td>
                                  <td style={{padding:"3px 6px",fontSize:11,maxWidth:150}}>{(()=>{
                                    const reasons=parseMismatchNote(b.system_notes,b.notes);
                                    const drift=getBillingDrift(b, facilityRates);
                                    // Parse CPSA submission URL from system_notes (or legacy notes)
                                    const cpsaUrlMatch=(b.system_notes||b.notes||"").match(/\[CPSA [^\]]+\]\s*Ref\s+(\S+)\s*·\s*(https?:\/\/\S+)/);
                                    const cpsaUrl=cpsaUrlMatch?cpsaUrlMatch[2]:null;
                                    if(b.status==="cpsa_confirmed"){
                                      return cpsaUrl
                                        ? <a href={cpsaUrl} target="_blank" rel="noopener noreferrer" style={{color:"#0891b2",fontWeight:600,textDecoration:"none"}} title="View GTEC booking">🌐 confirmed ↗</a>
                                        : <span style={{color:"#94a3b8",fontWeight:600}} title="GTEC confirmed — no submission URL recorded">🌐 confirmed</span>;
                                    }
                                    if(b.status==="approved" && CPSA_FIELD_IDS.has(b.facility_id)){
                                      return <span style={{color:"#94a3b8",fontSize:11}} title="Field booking — run sync to check GTEC status">⏳ awaiting sync</span>;
                                    }
                                    if(b.status==="cpsa_review_needed"&&reasons.length){
                                      return <span title={reasons.join("\n")} style={{color:"#a16207",cursor:"help",display:"inline-block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>⚠ {reasons.join(", ")}</span>;
                                    }
                                    if(drift){
                                      const cd=drift.costDelta;
                                      const deficit=cd!=null&&cd>0, credit=cd!=null&&cd<0;
                                      const amt=(cd!=null&&cd!==0)?fmtCost(Math.abs(cd)):null;
                                      const hrs=drift.hoursDelta>0?`+${drift.hoursDelta}h`:drift.hoursDelta<0?`−${Math.abs(drift.hoursDelta)}h`:"field Δ";
                                      const fin=deficit?` deficit${amt?` ${amt}`:""}`:credit?` credit${amt?` ${amt}`:""}`:"";
                                      return <span title={`${drift.rows.map(r=>`${r.label}: ${r.old} → ${r.next}`).join("\n")}${amt?`\nBilled ${fmtCost(drift.billedCost)} → now ${fmtCost(drift.currentCost)}`:""}`} style={{color:deficit?"#b91c1c":credit?"#15803d":"#5b21b6",cursor:"help",fontWeight:600}}>🧾 {hrs}{fin}</span>;
                                    }
                                    return <span style={{color:"#cbd5e1"}}>—</span>;
                                  })()}</td>
                                  <td style={{padding:"3px 6px",color:"#64748b",maxWidth:180,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:11}}>{b.purpose}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        </CopyableTable>
                      </div>
                  }
                  <div style={{marginTop:8,fontSize:12,color:"#94a3b8"}}>{visible.length} booking{visible.length!==1?"s":""} shown</div>
                </>
              );
            })()}
          </div>
        )}

        {tab==="summary"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<SummaryTab bookings={bookings} loggedInEmail={loggedInEmail} facilityRates={facilityRates} pricingConditions={pricingConditions} onAddPricingCondition={addPricingCondition} onUpdatePricingCondition={updatePricingCondition} onRemovePricingCondition={removePricingCondition} isAdmin={isAdmin} approxPlayers={approxPlayers} onUpdateApproxPlayers={updateApproxPlayers} approxDurations={approxDurations} onUpdateApproxDuration={updateApproxDuration} onUpdateFacilityRate={updateFacilityRate} pricingMode={pricingMode} onSetPricingMode={setPricingMode} onProposeMerge={handleProposeMerge} onBulkApply={handleBulkApply} onMarkInvoiced={handleMarkInvoiced} onMarkAdjustmentSettled={handleMarkAdjustmentSettled} bookerFilter={listBookerFilter} profiles={profiles} emailAliases={emailAliases} aliasNames={aliasNames} onCreateOfficialInvoice={handleCreateOfficialInvoice} onFilterChange={s=>setListBookerFilter(s)} loadRequest={summaryLoadRequest}/>}</div>}
        {tab==="billing"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<BillingTab billingRecords={billingRecords} onUpdateRecord={handleUpdateBillingRecord} onDeleteRecord={id=>setBillingRecords(prev=>prev.filter(r=>r.id!==id))} onLoadToSummary={handleLoadBillingToSummary} isAdmin={isAdmin} loggedInEmail={loggedInEmail} emailAliases={emailAliases} aliasNames={aliasNames} profiles={profiles}/>}</div>}
        {tab==="about"&&<div style={{padding:"8px 0"}}><AboutTab/></div>}
        {tab==="admin"&&isAdmin&&<div style={S.card}>
          {loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<AdminPanel bookings={bookings} onBulkStatusChange={handleBulkStatusChange} onEdit={openEdit} onView={setViewing} onQueueDelete={queueForRemovalSilent} clashes={allClashes} deleteIds={new Set(deleteQueue.map(b=>b.id))} facilityRates={facilityRates} onUpdateFacilityRate={updateFacilityRate} onClearOldUnapproved={handleClearOldUnapproved} approxPlayers={approxPlayers} onUpdateApproxPlayers={updateApproxPlayers} approxDurations={approxDurations} onUpdateApproxDuration={updateApproxDuration} onSyncDB={handleSyncDB} onBulkApply={handleBulkApply} onSaveMismatch={handleSaveMismatch} onInformCpsa={setInformCpsaFor} onQueueNotifications={queueNotifications} onMarkAdjustmentSettled={handleMarkAdjustmentSettled} loggedInEmail={loggedInEmail} syncResults={syncResults} onClearSyncResults={()=>setSyncResults([])} showSyncResults={showSyncPanel} onToggleSyncResults={()=>setShowSyncPanel(v=>!v)} bookerFilter={listBookerFilter} onToggleBooker={toggleBooker} onSetBookerFilter={setListBookerFilter} aliasNames={aliasNames} emailAliases={emailAliases} pricingConditions={pricingConditions} onAddPricingCondition={addPricingCondition} onUpdatePricingCondition={updatePricingCondition} onRemovePricingCondition={removePricingCondition}/>}
        </div>}
      </div>

      {/* Modals */}
      {showScheduleModal && <ScheduleSummaryModal bookings={bookings} isAdmin={isAdmin} loggedInEmail={loggedInEmail} onBulkApply={handleBulkApply} onBulkStatusChange={handleBulkStatusChange} aliasNames={aliasNames} emailAliases={emailAliases} onClose={()=>setShowScheduleModal(false)}/>}
      {showAdminScheduleModal && <ScheduleSummaryModal bookings={bookings} isAdmin={true} loggedInEmail={loggedInEmail} onBulkApply={handleBulkApply} onBulkStatusChange={handleBulkStatusChange} aliasNames={aliasNames} emailAliases={emailAliases} onClose={()=>setShowAdminScheduleModal(false)}/>}
      {showExtensionModal&&(
        <Modal title="🧩 Install AMUA Booking Extension" onClose={()=>setShowExtensionModal(false)} width={560}>
          <div style={{display:"flex",flexDirection:"column",gap:16,fontSize:14,color:"#0f172a"}}>
            <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#166534"}}>
              The browser extension lets you submit bookings to GTEC (Sporty) directly from this app and syncs confirmation links back automatically.
            </div>
            <a href="https://github.com/aucklandmixedultimate/amua-booking-extension/releases/download/v2.1.0/amua-booking-extension-v2.1.0.zip" target="_blank" rel="noopener noreferrer"
              style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"#7c3aed",color:"#fff",borderRadius:10,padding:"12px 16px",textDecoration:"none",fontWeight:700,fontSize:14}}>
              ⬇ Download latest build (.zip)
            </a>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {[
                ["1","Download the latest build", <>Click the button above to open the <a href="https://github.com/aucklandmixedultimate/amua-booking-extension/releases/download/v2.1.0/amua-booking-extension-v2.1.0.zip" target="_blank" rel="noopener noreferrer" style={{color:"#7c3aed",fontWeight:600}}>latest release</a>, download the attached <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>.zip</code>, and unzip it.</>],
                ["2","Open Chrome Extensions", <>Navigate to <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>chrome://extensions</code> and enable <strong>Developer mode</strong> (toggle top-right).</>],
                ["3","Load unpacked", <>Click <strong>Load unpacked</strong> and select the unzipped folder (the one containing <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>manifest.json</code>).</>],
                ["4","Pin & use", "Pin the extension from the Chrome toolbar. Open a GTEC booking page on Sporty and the extension will detect it automatically."],
                ["•","Building from source?", <>If you cloned the repo instead, run <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>build.bat</code> (Windows) or <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>npm run build</code> first, then load the generated <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>dist/</code> folder.</>],
              ].map(([num,title,desc])=>(
                <div key={num} style={{display:"flex",gap:12,alignItems:"flex-start"}}>
                  <span style={{minWidth:24,height:24,background:"#7c3aed",color:"#fff",borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:12,flexShrink:0}}>{num}</span>
                  <div>
                    <div style={{fontWeight:600,marginBottom:2}}>{title}</div>
                    <div style={{fontSize:13,color:"#475569"}}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{borderTop:"1px solid #f1f5f9",paddingTop:12,display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowExtensionModal(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Close</button>
            </div>
          </div>
        </Modal>
      )}

      {showActivityLog&&isAdmin&&(
        <ActivityLogModal onClose={()=>setShowActivityLog(false)}/>
      )}

      {showRetentionModal&&isAdmin&&(
        <Modal title="🗑 Log Retention" onClose={()=>setShowRetentionModal(false)} width={460}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:14}}>
            How long to keep <strong>activity-log entries</strong> and <strong>monthly sync results</strong> before
            they're automatically purged. Purging runs when an admin loads the app and after each GTEC sync.
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
            <span style={{fontSize:13,color:"#0f172a",fontWeight:600}}>Keep logs for</span>
            <input type="number" min="0" step="1" value={logRetentionMonths}
              onChange={e=>setLogRetentionMonths(e.target.value)}
              style={{width:80,padding:"5px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:14,textAlign:"right",fontFamily:"inherit",outline:"none"}}/>
            <span style={{fontSize:13,color:"#64748b"}}>month{logRetentionMonths===1?"":"s"}</span>
          </div>
          <div style={{fontSize:11,color:"#94a3b8",marginTop:8}}>Set to 0 to keep logs forever (no automatic purge).</div>
          {configured&&(
            <div style={{fontSize:11,color:"#94a3b8",marginTop:10,background:"#f8fafc",border:"1px solid #f1f5f9",borderRadius:6,padding:"6px 10px"}}>
              Activity-log purging needs the admin <code>DELETE</code> policy from <code>supabase-migration-activity-log.sql</code>.
            </div>
          )}
          <div style={{marginTop:16,display:"flex",justifyContent:"flex-end",gap:8}}>
            <button onClick={()=>{purgeOldLogs();setShowRetentionModal(false);showToast("Old logs purged.");}} style={S.btn({background:"#fff",color:"#0f172a",border:"1.5px solid #e2e8f0",fontSize:12})}>Purge now</button>
            <button onClick={()=>setShowRetentionModal(false)} style={S.btn({background:"#0f172a",color:"#fff",fontSize:12})}>Done</button>
          </div>
        </Modal>
      )}

      {showRatesModal&&isAdmin&&(
        <Modal title="💲 Facility Rates" onClose={()=>setShowRatesModal(false)} width={620}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12}}>Day rate = before 5:30 pm · Evening rate = 5:30 pm onwards.</div>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {FACILITIES.map(fac => {
              const r = typeof facilityRates[fac.id]==="object" ? facilityRates[fac.id] : { day: facilityRates[fac.id]||0, evening: 50 };
              return (
                <div key={fac.id} style={{background:"#fff",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 14px"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:7}}>
                    <span className={fac.kind==="social"?"fac-social-tex":undefined}
                      title={fac.kind==="social"?"Social space":"Field"}
                      style={{display:"inline-block",width:28,height:16,borderRadius:4,background:fac.color,flexShrink:0,border:"1px solid rgba(0,0,0,0.08)"}}/>
                    <span style={{fontSize:13,fontWeight:700,color:"#0f172a"}}>{fac.name}</span>
                    <span style={{fontSize:10,fontWeight:700,padding:"1px 6px",borderRadius:10,background:fac.kind==="social"?"#f3e8ff":"#dcfce7",color:fac.kind==="social"?"#7c3aed":"#166534",marginLeft:"auto"}}>{fac.kind==="social"?"Social":"Field"}</span>
                  </div>
                  <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                    <span style={{fontSize:12,color:"#64748b"}}>Day $</span>
                    <input type="number" min="0" step="0.5" value={r.day||""} placeholder="0"
                      onChange={e=>updateFacilityRate(fac.id,"day",e.target.value)}
                      style={{width:80,padding:"4px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:13,textAlign:"right",fontFamily:"inherit",outline:"none"}}/>
                    <span style={{fontSize:12,color:"#64748b"}}>/hr</span>
                    <span style={{fontSize:12,color:"#7c3aed",marginLeft:8}}>Evening $</span>
                    <input type="number" min="0" step="0.5" value={r.evening||""} placeholder="0"
                      onChange={e=>updateFacilityRate(fac.id,"evening",e.target.value)}
                      style={{width:80,padding:"4px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:13,textAlign:"right",fontFamily:"inherit",outline:"none"}}/>
                    <span style={{fontSize:12,color:"#64748b"}}>/hr</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
            <button onClick={()=>setShowRatesModal(false)} style={S.btn({background:"#0f172a",color:"#fff",fontSize:12})}>Done</button>
          </div>
        </Modal>
      )}

      {showPlayersModal&&isAdmin&&(
        <Modal title="👥 Player Counts (per booker)" onClose={()=>setShowPlayersModal(false)} width={520}>
          <div style={{fontSize:12,color:"#64748b",marginBottom:12}}>Approximate player counts drive per-booking cost estimates.</div>
          {(()=>{
            const emails = [...new Set(bookings.filter(b=>!isAdminBooking(b)).map(b=>b.email).filter(Boolean))].sort();
            if(emails.length===0) return <div style={{color:"#94a3b8",fontSize:13,textAlign:"center",padding:20}}>No bookers yet.</div>;
            return (
              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:"55vh",overflowY:"auto"}}>
                {emails.map(em=>{
                  const cur = approxPlayers[em.toLowerCase()]||0;
                  return (
                    <div key={em} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 10px",background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:6}}>
                      <span style={{width:9,height:9,borderRadius:"50%",background:emailColor(em),flexShrink:0}}/>
                      <span style={{fontSize:12,fontWeight:600,color:"#0f172a",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{em}</span>
                      <input type="number" min="0" value={cur||""} placeholder="0"
                        onChange={e=>updateApproxPlayers(em,parseInt(e.target.value)||0)}
                        style={{width:70,padding:"4px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:13,textAlign:"right",fontFamily:"inherit",outline:"none"}}/>
                      <span style={{fontSize:11,color:"#94a3b8"}}>players</span>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
            <button onClick={()=>setShowPlayersModal(false)} style={S.btn({background:"#0f172a",color:"#fff",fontSize:12})}>Done</button>
          </div>
        </Modal>
      )}

      {showUserMgmtModal&&realIsAdmin&&(
        <UserMgmtModal
          bookings={bookings}
          aliases={emailAliases}
          aliasNames={aliasNames}
          onChange={setEmailAliases}
          onChangeNames={setAliasNames}
          profiles={profiles}
          onUpdateProfile={setProfiles}
          adminEmail={realLoggedInEmail}
          onViewAs={em=>{ setViewAsEmail(em); setShowUserMgmtModal(false); setTab("calendar"); showToast(`Viewing as ${em}`); }}
          onClose={()=>setShowUserMgmtModal(false)}
        />
      )}

      {showForm&&(
        <Modal title={editing?"Edit Booking":"New Booking Request"} onClose={()=>{setShowForm(false);setEditing(null);}} width={620}>
          <BookingForm
            booking={editing!==null?editing:(prefill.date?{date:prefill.date,start_hour:prefill.startHour,duration:prefill.duration,...(prefill.facility?{facility_id:prefill.facility}:{})}:null)}
            allBookings={bookings}
            onSave={handleSave}
            onAddToCart={handleAddToCart}
            onClose={()=>{setShowForm(false);setEditing(null);}}
            isAdmin={isAdmin}
            loggedInEmail={loggedInEmail}
          />
        </Modal>
      )}

      {showCart&&(
        <Modal title="🛒 Booking Cart" onClose={()=>setShowCart(false)} width={660}>
          <CartModal cart={cart} setCart={setCart} onClose={()=>setShowCart(false)} onSubmit={handleCartSubmit} openNew={openNew} silentMode={silentMode} onToggleSilent={isAdmin?setSilentMode:undefined}/>
        </Modal>
      )}
      {informCpsaFor&&(
        <Modal title="📨 Inform GTEC — select vendor" onClose={()=>setInformCpsaFor(null)} width={520}>
          {(()=>{
            const vendors = Object.entries(profiles||{}).filter(([,p])=>p?.profileType==="vendor");
            const b = informCpsaFor;
            const fac = FACILITIES.find(x=>x.id===b.facility_id);
            const refs = parseCpsaRefs(b.system_notes, b.notes);
            return (
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#0c4a6e"}}>
                  <div style={{fontWeight:700,marginBottom:4}}>{fac?.name||b.facility_id} · {fmtDate(b.date)}</div>
                  <div style={{color:"#475569"}}>{b.name} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)}</div>
                  <div style={{marginTop:6,fontSize:12,color:refs.length?"#0891b2":"#b45309"}}>{refs.length?`🔗 GTEC link: ${refs.map(r=>r.ref).join(", ")}`:"⚠ No GTEC submission link on file — the email will note this."}</div>
                </div>
                <div style={{fontSize:12,color:"#64748b"}}>Choose the vendor to notify. This adds an email to your cart asking GTEC to correct their schedule to match our record — it does <strong>not</strong> resolve the mismatch.</div>
                {vendors.length===0
                  ? <div style={{fontSize:13,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"10px 14px"}}>No vendor profiles yet. Create one in <strong>👤 User Management</strong> first.</div>
                  : <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      {vendors.map(([email,p])=>(
                        <button key={email} onClick={()=>addInformCpsaToCart(b, email, p.fullName||email)}
                          style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:2,padding:"10px 14px",borderRadius:10,border:"1.5px solid #e2e8f0",background:"#fff",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                          <span style={{fontSize:14,fontWeight:700,color:"#0f172a"}}>{p.fullName||email}</span>
                          <span style={{fontSize:12,color:"#64748b"}}>{email}</span>
                        </button>
                      ))}
                    </div>
                }
              </div>
            );
          })()}
        </Modal>
      )}

      {showDeleteCart&&(
        <Modal title="🗑 Removal Queue" onClose={()=>setShowDeleteCart(false)} width={580}>
          <DeleteCartModal deleteQueue={deleteQueue} setDeleteQueue={setDeleteQueue} onClose={()=>setShowDeleteCart(false)} onSubmit={handleDeleteCartSubmit} isAdmin={isAdmin} silentMode={silentMode} onToggleSilent={setSilentMode}/>
        </Modal>
      )}

      {viewing&&(
        <Modal title="Booking Details" onClose={()=>setViewing(null)}>
          <BookingDetail booking={viewing} onEdit={()=>openEdit(viewing)} onClose={()=>setViewing(null)} onCancel={()=>queueForRemoval(viewing.id)} isAdmin={isAdmin} onStatusChange={status=>handleStatusChange(viewing,status)} loggedInEmail={loggedInEmail} allClashes={allClashes}/>
        </Modal>
      )}

      {dayPopupDate&&(
        <DayTimelinePopup date={dayPopupDate} focusHour={dayPopupFocus} bookings={bookings} onClose={()=>{setDayPopupDate(null);setDayPopupFocus(null);}}
          onBookingClick={b=>{ setDayPopupDate(null);setDayPopupFocus(null); setViewing(b); }}
          onNewBooking={openNew}
          cartNewDrafts={cart.flatMap(i=>!i.notifyOnly&&!i.statusChange&&(i.sourceIds||[]).length===0?i.drafts:[])}
          deleteIds={new Set(deleteQueue.map(b=>b.id))} cartSourceIds={new Set(cart.flatMap(i=>i.sourceIds||[]))}/>
      )}
    </div>
  );
}
