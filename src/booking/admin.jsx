import { useState, Fragment } from "react";
import { AMUA_INBOX, AMUA_INFO, Badge, bareStatusLabel, groupStatusLabel, COUNCIL_APPLICATION_FEE, ClashPair, CopyableTable, EmailChip, FACILITIES, INVOICED_META, Modal, PROVIDERS, REVIEW_STATUSES, S, STATUS_META, SUPABASE_URL, TableViewToggle, _contactReviews, _currentUser, _sessionStartIso, authHeaders, bookingCost, buildCouncilPayload, canSendToCouncil, councilFeeSplit, councilOverlaps, emailColor, extractCpsaAmendValues, facCellLabel, fmt24, fmtCost, fmtDate, fmtDateShort, fmtDateShortDow, fmtDuration, fmtGtecEvent, fmtLoggedAt, fmtTime, getBillingDrift, getCrossFacilityOverlaps, getSameFacilityOverlaps, isAdminBooking, isCouncilBooking, isSocialFac, nextWorkflowStatus, parseClashPrevStatus, parseCouncilApp, parseCpsaRefs, parseCpsaResolution, parseGtecSnapshot, parseMismatchNote, parseSlotLink, providerOfFacility, sb, setCpsaOrig, setCpsaResolution, setModuleState, stripMismatchNote, todayKey, useTableView, vendorShortFor, vendorsIn, visibleFacilities, workflowOf, workflowStep } from "./core.jsx";
import { councilAppBookings } from "./councilData.jsx";
import { ActivityLogModal, DateRangePicker } from "./modals.jsx";
import { PatternModal, PricingConditionsManager, ReassignControl, ScheduleSummaryModal } from "./schedule.jsx";
import { InlineDayPicker, VendorTimesFields, vendorTimesDefault } from "./forms.jsx";
import { isClosed } from "../statuses.js";
// One newly-synced CPSA field booking, expandable to reveal the AMUA bookings it
// clashes with (same facility / same time), any simultaneous use of a different
// facility, and the CPSA-review/mismatch status of clashing bookings. Detail is
// computed live against current bookings so it reflects later resolutions.
// One flagged user booking (mismatch or clash) surfaced by a sync, with a link to
// open it. Snapshot fields are stored on the sync result; the live row is resolved
// by id so "View" opens the current booking (and shows if it's since been resolved).
export function SyncFlaggedRow({ snap, bookings, onView, kind }) {
  const f = FACILITIES.find(x=>x.id===snap.facility_id);
  const live = snap.id ? bookings.find(b=>b.id===snap.id) : null;
  const span = `${fmtTime(snap.start_hour)}–${fmtTime(snap.start_hour+snap.duration)}`;
  return (
    <div style={{display:"flex",gap:6,alignItems:"flex-start",flexWrap:"wrap",fontSize:11,color:"#475569"}}>
      <span style={{width:7,height:7,borderRadius:"50%",background:f?.color||"#94a3b8",flexShrink:0,marginTop:4}}/>
      <div style={{display:"flex",flexDirection:"column",minWidth:0}}>
        <span>{fmtDate(snap.date)} · {span} · {f?.name||snap.facility_id} · {snap.name||snap.email}{snap.purpose?` · ${snap.purpose}`:""}</span>
        {kind==="review" && snap.reasons?.length>0 && <span style={{color:"#b45309"}}>{snap.reasons.join(" · ")}</span>}
        {/* Full details of the incoming GTEC event(s) this booking was matched/clashed against. */}
        {kind==="review" && snap.gtec && <span style={{color:"#0e7490"}}>↳ GTEC event: {fmtGtecEvent(snap.gtec)}</span>}
        {kind==="clash" && Array.isArray(snap.gtec) && snap.gtec.map((g,i)=>(
          <span key={i} style={{color:"#9f1239"}}>↳ 🔒 GTEC event: {fmtGtecEvent(g)}</span>
        ))}
      </div>
      {live && onView
        ? <button onClick={()=>onView(live)} style={{marginLeft:"auto",fontSize:10,fontWeight:700,color:"#0369a1",background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:6,padding:"1px 7px",cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap"}}>View ↗</button>
        : <span style={{marginLeft:"auto",fontSize:10,color:"#94a3b8"}}>(resolved)</span>}
    </div>
  );
}
export function SyncedItemRow({ ab, bookings }) {
  const af = FACILITIES.find(x=>x.id===ab.facility_id);
  // Resolve the live booking (by id, else a field-block match) so overlap checks
  // exclude the item itself and stay accurate for older sync-log entries.
  const live = (ab.id && bookings.find(b=>b.id===ab.id))
    || bookings.find(b=>isAdminBooking(b) && b.facility_id===ab.facility_id && b.date===ab.date && b.start_hour===ab.start_hour && b.duration===ab.duration)
    || null;
  const bk = live || ab;
  const others    = bookings.filter(b => b.id!==bk.id && !isClosed(b.status));
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
        {sameAdmin.length>0 && block("#eff6ff","#bfdbfe",<>
          <div style={{fontWeight:700,color:"#1d4ed8"}}>❗ Same facility — other field block{sameAdmin.length!==1?"s":""}</div>
          {sameAdmin.map(b=><div key={b.id} style={{color:"#1e40af"}}>{span(b)} · {b.purpose||"Field block"}</div>)}
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

// Under a council batch or application: multi-field areas with spare frisbee fields, and
// fields shared by more than one booker (the first to book is the parent).
export function CouncilOccupancyNotes({ bookings, ids, who = e => e }) {
  const all = councilOverlaps(bookings).filter(c => c.bookings.some(b => ids.has(b.id)));
  const spare = all.filter(c => c.cap > c.used), shared = all.filter(c => new Set(c.bookings.map(b => (b.email || "").toLowerCase())).size > 1);
  if (!spare.length && !shared.length) return null;
  const when = c => `${fmtDate(c.date)} ${fmtTime(c.start)}–${fmtTime(c.end)}`, fac = c => FACILITIES.find(f => f.id === c.facility_id)?.name || c.facility_id;
  return <div style={{flexBasis:"100%",display:"flex",flexDirection:"column",gap:3,fontSize:12}}>
    {spare.map((c,i)=><div key={"x"+i} style={{color:"#166534"}}>🟢 <b>Extra occupancy available</b> — {fac(c)} · {when(c)}: the slot holds {c.cap} field areas; {c.used === 1 ? "one booking uses it" : `${c.used} bookings share it`}</div>)}
    {shared.map((c,i)=>{ const m=[...c.bookings].sort((a,b)=>(a.created_at||"").localeCompare(b.created_at||""));
      return <div key={"s"+i} style={{color:"#1e3a8a"}}>👥 Shared field — {fac(c)} · {when(c)}: parent <b>{who((m[0].email||"").toLowerCase())}</b> (booked first){m.slice(1).map(b=>`, child ${who((b.email||"").toLowerCase())}`).join("")}</div>; })}
  </div>;
}
// ─── Council allocation (🏛 Allocation tab) ──────────────────────────────────────
// Outcomes per council application number, merged from the council's emails (see
// src/councilMail.js): { id, outcome: "action"|"confirmed"|"declined"|"info", park, fields,
// start, end, reason, coordinator:{name,email}, threadId, subject, outcomeAt, history[],
// replied:{kind,at,by}, manual }.
export const COUNCIL_OUTCOME_META = {
  action:    { label: "Offer — AMUA to confirm", bg: "#ffedd5", border: "#ea580c", text: "#7c2d12", rank: 0 },
  confirmed: { label: "Granted — allocate",      bg: "#ecfccb", border: "#65a30d", text: "#365314", rank: 1 },
  declined:  { label: "Declined",                bg: "#fff1f2", border: "#f43f5e", text: "#881337", rank: 2 },
  info:      { label: "Update",                  bg: "#f1f5f9", border: "#94a3b8", text: "#334155", rank: 3 },
};
export const escHtml = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// AMUA's reply to the council about an offer, drafted to AMUA's own inbox (the app never
// emails the council: see the email rule at sendEmail). AMUA sends it from Gmail, in the thread.
export function buildCouncilReplyItem(o, kind, rationale) {
  const ops = AMUA_INFO.contacts?.operations || {}, first = (o.coordinator?.name || "").split(/[\s,]+/)[0];
  const what = [o.park, o.fields, o.start && o.end ? `${o.start} – ${o.end}` : o.start].filter(Boolean).map(escHtml).join(", ");
  const why = String(rationale || "").trim() ? `<p>${escHtml(rationale.trim()).replace(/\n+/g, "<br>")}</p>` : "";
  const body = kind === "accept"
    ? `<p>Thank you for the update on application # ${escHtml(o.id)}. Auckland Mixed Ultimate Association confirms it would like to go ahead with the booking${what ? `: ${what}` : ""}.</p>${why}<p>Please let us know if you need anything else from us to complete it.</p>`
    : `<p>Thank you for the update on application # ${escHtml(o.id)}. Auckland Mixed Ultimate Association no longer needs this booking${what ? ` (${what})` : ""}, so please withdraw it from our request.</p>${why}`;
  const html = `${o.threadId ? `<p style="font-size:12px;color:#64748b">AMUA: send this as a reply in the council's thread — <a href="https://mail.google.com/mail/u/0/#all/${o.threadId}">open the thread in Gmail</a>.</p>` : ""}
    <p>Kia ora${first ? " " + escHtml(first) : ""},</p>${body}
    <p>Ngā mihi,<br>${escHtml(ops.name || "AMUA")}${ops.position ? `, ${escHtml(ops.position)}` : ""}<br>${escHtml(AMUA_INFO.name || "Auckland Mixed Ultimate Association")}${ops.phone ? `<br>${escHtml(ops.phone)}` : ""}<br>${AMUA_INBOX}</p>`;
  return { notifyOnly: true, invoiceEmail: true, amuaDraft: true, email: o.coordinator?.email || AMUA_INBOX, name: o.coordinator?.name || "Auckland Council",
    drafts: [], count: 1, refs: [o.id], total: 0, subject: `Re: Application # ${o.id}${kind === "accept" ? " — AMUA confirms" : " — AMUA withdraws"}`, html };
}
export function CouncilAllocationTab({ outcomes = {}, bookings = [], syncing, syncLog = [], onSync, onSaveOutcomes, onBulkStatusChange, onQueueNotifications, onLinkApp, aliasNames = {}, loggedInEmail }) {
  const [filter, setFilter] = useState("open");
  const [sel, setSel] = useState({});        // appId → Set of booking ids picked for allocation
  const [notes, setNotes] = useState({});    // appId → rationale for the reply to the council
  const [linkSel, setLinkSel] = useState({}); // appId → Set of booking ids to link
  const [showLog, setShowLog] = useState(false);
  const apps = Object.values(outcomes).sort((a, b) => (COUNCIL_OUTCOME_META[a.outcome]?.rank ?? 9) - (COUNCIL_OUTCOME_META[b.outcome]?.rank ?? 9) || (b.outcomeAt || b.date || "").localeCompare(a.outcomeAt || a.date || ""));
  const count = k => apps.filter(a => k === "open" ? a.outcome === "action" || a.outcome === "confirmed" : k === "all" || a.outcome === k).length;
  const shown = apps.filter(a => filter === "all" ? true : filter === "open" ? a.outcome === "action" || a.outcome === "confirmed" : a.outcome === filter);
  const live = b => !isClosed(b.status);
  const who = b => aliasNames[(b.email || "").toLowerCase()] || b.name || b.email;
  const facName = b => FACILITIES.find(f => f.id === b.facility_id)?.name || b.facility_id;
  const picked = (o, linked) => sel[o.id] || new Set(linked.filter(live).map(b => b.id));
  const toggle = (setter, id, bid, base) => setter(s => { const n = new Set(s[id] || base); n.has(bid) ? n.delete(bid) : n.add(bid); return { ...s, [id]: n }; });
  const mark = (o, patch) => onSaveOutcomes({ ...outcomes, [o.id]: { ...o, ...patch } });
  const stamp = () => ({ at: new Date().toISOString(), by: loggedInEmail || "" });
  // Council bookings still waiting on the council that aren't on a council number yet
  // (no application, or a local CA-… reference), at the same park first.
  const unlinked = o => bookings.filter(b => isCouncilBooking(b) && ["council_apply", "council_pending", "council_action", "council_granted"].includes(b.status)
    && (() => { const a = parseCouncilApp(b.system_notes)?.id; return !a || /^CA-/.test(a); })())
    .sort((a, b) => (o.park && facName(b).toLowerCase().includes(o.park.toLowerCase()) ? 1 : 0) - (o.park && facName(a).toLowerCase().includes(o.park.toLowerCase()) ? 1 : 0) || a.date.localeCompare(b.date));
  function reply(o, kind, linked) {
    const ids = [...picked(o, linked)];
    onQueueNotifications([buildCouncilReplyItem(o, kind, notes[o.id])], "council reply draft");
    if (kind === "decline" && ids.length) onBulkStatusChange(ids, "rejected", `AMUA withdrew application ${o.id}${o.park ? ` (${o.park})` : ""} with the council.${notes[o.id]?.trim() ? " " + notes[o.id].trim() : ""}`);
    mark(o, { replied: { kind, ...stamp() }, ...(kind === "decline" ? { outcome: "declined", manual: true, reason: `AMUA withdrew: ${notes[o.id]?.trim() || "not needed"}` } : {}) });
  }
  function allocate(o, linked) {
    const pick = picked(o, linked), open = linked.filter(b => ["council_pending", "council_action", "council_granted"].includes(b.status));
    const yes = open.filter(b => pick.has(b.id)), no = open.filter(b => !pick.has(b.id));
    const note = `Auckland Council granted application ${o.id}${o.park ? ` (${o.park}${o.fields ? ", " + o.fields : ""})` : ""}.`;
    const direct = yes.filter(b => workflowOf(b.facility_id) !== "council_private").map(b => b.id), viaOp = yes.filter(b => workflowOf(b.facility_id) === "council_private").map(b => b.id);
    if (direct.length) onBulkStatusChange(direct, "approved", note);
    if (viaOp.length) onBulkStatusChange(viaOp, "op_confirm", note, true);
    if (no.length) onBulkStatusChange(no.map(b => b.id), "rejected", `Not allocated from council application ${o.id}${o.park ? ` (${o.park})` : ""}: the granted fields went to other bookings.`);
    mark(o, { allocated: { ...stamp(), ids: yes.map(b => b.id) } });
  }
  const box = { border: "1px solid #e2e8f0", borderRadius: 12, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 };
  const small = { fontSize: 12, color: "#64748b" };
  const lastRun = syncLog[0];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#0f172a" }}>🏛 Council allocation</h2>
        <button onClick={onSync} disabled={syncing} style={S.btn({ background: "#0d9488", color: "#fff", opacity: syncing ? 0.6 : 1, cursor: syncing ? "wait" : "pointer" })}>{syncing ? "Reading council emails…" : "🔄 Sync council emails"}</button>
        <span style={small}>{lastRun ? (lastRun.error ? `Last sync failed: ${lastRun.error}` : `Last sync ${new Date(lastRun.at).toLocaleString("en-NZ")} · ${lastRun.emails} email${lastRun.emails !== 1 ? "s" : ""} read · ${lastRun.queued} booking change${lastRun.queued !== 1 ? "s" : ""} queued`) : "Not synced yet: sign in with the AMUA Google account when asked (read-only Gmail access)."}</span>
      </div>
      <p style={{ margin: 0, fontSize: 13, color: "#475569" }}>
        Reads Auckland Council's replies about AMUA's field applications from the AMUA Gmail. An <b>offer</b> needs AMUA's answer: draft an acceptance or a withdrawal below.
        Replies are drafted to AMUA's own inbox with the council's address on top (the app never emails the council) — send them from Gmail in the thread.
        Once the council <b>grants</b> an application, allocate its fields to the bookers who applied: they're approved and emailed; the rest are told it wasn't allocated.
        Booking changes go to the cart for you to submit.
      </p>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {[["open", "Needs AMUA"], ["action", "Offers"], ["confirmed", "Granted"], ["declined", "Declined"], ["info", "Updates"], ["all", "All"]].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)} style={S.btn({ padding: "5px 12px", fontSize: 12, background: filter === k ? "#0f172a" : "#fff", color: filter === k ? "#fff" : "#334155", border: "1px solid #e2e8f0" })}>{l} ({count(k)})</button>))}
      </div>
      {!shown.length && <div style={{ ...small, padding: 20, textAlign: "center" }}>{apps.length ? "Nothing here." : "No council applications yet. Press 🔄 Sync council emails."}</div>}
      {shown.map(o => {
        const m = COUNCIL_OUTCOME_META[o.outcome] || COUNCIL_OUTCOME_META.info, linked = councilAppBookings(bookings, o.id), pick = picked(o, linked);
        const cands = linked.length ? [] : unlinked(o), lpick = linkSel[o.id] || new Set();
        return (
          <div key={o.id} style={{ ...box, borderLeft: `4px solid ${m.border}` }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <b style={{ fontSize: 15, color: "#0f172a" }}>Application # {o.id}</b>
              <span style={{ padding: "2px 10px", borderRadius: 999, background: m.bg, border: `1px solid ${m.border}`, color: m.text, fontSize: 12, fontWeight: 700 }}>{m.label}{o.manual ? " · set by AMUA" : ""}</span>
              {o.replied && <span style={{ ...small, fontWeight: 600 }}>✉ {o.replied.kind === "accept" ? "Acceptance" : "Withdrawal"} drafted {new Date(o.replied.at).toLocaleDateString("en-NZ")}</span>}
              {o.allocated && <span style={{ ...small, fontWeight: 600, color: "#166534" }}>✅ Allocated {new Date(o.allocated.at).toLocaleDateString("en-NZ")}</span>}
              {o.threadId && <a href={`https://mail.google.com/mail/u/0/#all/${o.threadId}`} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", fontSize: 12, color: "#0e7490" }}>Gmail thread ↗</a>}
            </div>
            <div style={{ fontSize: 13, color: "#0f172a" }}><b>{o.park || "Park not given"}</b>{o.fields ? ` · ${o.fields}` : ""}{o.start ? ` · ${o.start}${o.end ? " – " + o.end : ""}` : ""}</div>
            <div style={small}>{o.coordinator?.name || o.coordinator?.email ? `From ${o.coordinator.name || ""}${o.coordinator.email ? ` <${o.coordinator.email}>` : ""} · ` : ""}{(o.outcomeAt || o.date) ? new Date(o.outcomeAt || o.date).toLocaleDateString("en-NZ", { day: "numeric", month: "short", year: "numeric" }) : ""}{o.history?.length > 1 ? ` · ${o.history.length} emails` : ""}</div>
            {o.reason && <div style={{ fontSize: 13, color: "#881337", background: "#fff1f2", borderRadius: 8, padding: "6px 10px" }}>{o.reason}</div>}
            {linked.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ ...small, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>Bookers on this application</div>
                {linked.map(b => { const sl = parseSlotLink(b.system_notes); return (
                  <label key={b.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13, opacity: live(b) ? 1 : 0.55 }}>
                    <input type="checkbox" disabled={!live(b)} checked={pick.has(b.id)} onChange={() => toggle(setSel, o.id, b.id, pick)}/>
                    <b>{who(b)}</b><span style={{ color: "#475569" }}>{facName(b)} · {fmtDate(b.date)} {fmtTime(b.start_hour)}–{fmtTime(b.start_hour + b.duration)}</span>
                    <Badge status={b.status} wf={workflowOf(b.facility_id)} fid={b.facility_id}/>
                    {sl && sl.role !== "peer" && <span style={{ fontSize: 11, fontWeight: 700, color: "#1e3a8a", background: "#dbeafe", borderRadius: 999, padding: "1px 8px" }}>{sl.role === "parent" ? "👥 parent" : "👥 child"}</span>}
                  </label>); })}
                <CouncilOccupancyNotes bookings={bookings} ids={new Set(linked.map(b => b.id))} who={e => aliasNames[e] || e}/>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={small}>No bookings are on this application number{cands.length ? ". Link the bookings it covers:" : " (an older application, or none waiting on the council)."}</div>
                {cands.slice(0, 12).map(b => (
                  <label key={b.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
                    <input type="checkbox" checked={lpick.has(b.id)} onChange={() => toggle(setLinkSel, o.id, b.id, lpick)}/>
                    <b>{who(b)}</b><span style={{ color: "#475569" }}>{facName(b)} · {fmtDate(b.date)}{parseCouncilApp(b.system_notes)?.id ? ` · ${parseCouncilApp(b.system_notes).id}` : ""}</span>
                    <Badge status={b.status} wf={workflowOf(b.facility_id)} fid={b.facility_id}/>
                  </label>))}
                {cands.length > 0 && <div><button disabled={!lpick.size} onClick={() => { onLinkApp(o.id, [...lpick]); setLinkSel(s => ({ ...s, [o.id]: new Set() })); }} style={S.btn({ padding: "5px 12px", fontSize: 12, background: lpick.size ? "#0d9488" : "#e2e8f0", color: lpick.size ? "#fff" : "#94a3b8" })}>🔗 Link {lpick.size || ""} to # {o.id}</button></div>}
              </div>
            )}
            {o.outcome === "action" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <textarea value={notes[o.id] || ""} onChange={e => setNotes(n => ({ ...n, [o.id]: e.target.value }))} rows={2} placeholder="Rationale for the council (optional): e.g. which fields or nights AMUA needs, or why it's not needed" style={{ ...S.inp, fontSize: 13 }}/>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button onClick={() => reply(o, "accept", linked)} style={S.btn({ background: "#15803d", color: "#fff" })}>✉ Draft acceptance</button>
                  <button onClick={() => reply(o, "decline", linked)} style={S.btn({ background: "#fff", color: "#b91c1c", border: "1px solid #fecaca" })}>✉ Draft withdrawal{pick.size ? ` · decline ${pick.size} booking${pick.size !== 1 ? "s" : ""}` : ""}</button>
                </div>
              </div>
            )}
            {o.outcome === "confirmed" && linked.some(b => ["council_pending", "council_action", "council_granted"].includes(b.status)) && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={() => allocate(o, linked)} disabled={!pick.size} style={S.btn({ background: pick.size ? "#15803d" : "#e2e8f0", color: pick.size ? "#fff" : "#94a3b8" })}>✅ Allocate to {pick.size} booking{pick.size !== 1 ? "s" : ""}</button>
                <span style={small}>Ticked bookings are approved and the bookers emailed (council + operator bookings go to the operator first); unticked ones are declined.</span>
              </div>
            )}
            <div style={{ display: "flex", gap: 6, alignItems: "center", ...small }}>
              Outcome:
              <select value={o.outcome} onChange={e => mark(o, { outcome: e.target.value, manual: true, manualAt: new Date().toISOString() })} style={{ fontSize: 12, padding: "2px 6px", borderRadius: 6, border: "1px solid #e2e8f0" }}>
                {Object.entries(COUNCIL_OUTCOME_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              {o.manual && <button onClick={() => mark(o, { manual: false })} style={{ fontSize: 11, border: "none", background: "none", color: "#0e7490", cursor: "pointer", padding: 0 }}>use the emails' outcome on the next sync</button>}
            </div>
          </div>
        );
      })}
      <div>
        <button onClick={() => setShowLog(v => !v)} style={S.btn({ padding: "5px 12px", fontSize: 12, background: "#fff", color: "#334155", border: "1px solid #e2e8f0" })}>Sync log ({syncLog.length}) {showLog ? "▴" : "▾"}</button>
        {showLog && <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
          {syncLog.map((r, i) => <div key={i} style={{ fontSize: 12, color: r.error ? "#b91c1c" : "#475569" }}>{new Date(r.at).toLocaleString("en-NZ")} — {r.error ? r.error : `${r.emails} emails · ${r.changed.length} updated${r.changed.length ? ` (${r.changed.join(", ")})` : ""} · ${r.queued} booking change${r.queued !== 1 ? "s" : ""} queued`}</div>)}
        </div>}
      </div>
    </div>
  );
}

// ─── Admin Panel with action queue, bulk approve, facility rates ──────────────
// The request to a community facility, drafted for AMUA's inbox (the app never emails
// facilities: see the email rule at sendEmail). Queued in the email cart as a pre-rendered item.
export function buildCommunityRequestItem(b) {
  const pid = providerOfFacility(b.facility_id), pr = PROVIDERS[pid] || {}, rv = _contactReviews[pid] || {}, c = pr.contact || {};
  const f = FACILITIES.find(x => x.id === b.facility_id), to = rv.email || c.email || AMUA_INBOX;
  const when = `${fmtDate(b.date)} ${fmtTime(b.start_hour)}–${fmtTime(b.start_hour + b.duration)}`;
  const rate = f?.defaultRate ? `$${f.defaultRate}/hr` : "your usual rate";
  const ops = AMUA_INFO.contacts?.operations || {};
  const html = `<p>Kia ora ${rv.contact_name || c.contact_name || pr.name || ""},</p>
    <p>Auckland Mixed Ultimate Association would like to hire <b>${f?.name || "your field"}</b> for ultimate frisbee training:</p>
    <ul><li><b>${when}</b> (${fmtDuration(b.duration)})</li><li>Group: ${b.name || ""}${b.purpose ? ` — ${b.purpose}` : ""}</li><li>Rate: ${rate}</li></ul>
    <p>Could you let us know if that slot is available?</p>
    <p>Ngā mihi,<br>${ops.name || "AMUA"}${ops.position ? `, ${ops.position}` : ""}<br>${AMUA_INFO.name || "Auckland Mixed Ultimate Association"}${ops.phone ? `<br>${ops.phone}` : ""}<br>${AMUA_INBOX}</p>`;
  return { notifyOnly: true, invoiceEmail: true, amuaDraft: true, email: to, name: pr.name || pid, drafts: [], count: 1, refs: [b.id.slice(0, 8)], total: 0,
    subject: `Field hire request — ${pr.short || pr.name || ""} — ${when}`, html };
}
// Saves the reviewed contact for a community facility (settings "provider_contact_reviews").
export async function saveContactReview(pid, data) {
  const entry = { ...data, by: _currentUser?.email || "", at: new Date().toISOString() };
  let cur = {};
  try { const r = await fetch(`${SUPABASE_URL}/rest/v1/settings?key=eq.provider_contact_reviews&select=value`, { headers: authHeaders() });
    if (r.ok) cur = (await r.json())?.[0]?.value || {}; } catch { /* use local */ }
  const next = { ...cur, [pid]: entry };
  await sb.upsert("settings", { key: "provider_contact_reviews", value: next, updated_at: entry.at });
  setModuleState({ _contactReviews: next });
}
// First request to a community facility: review its contact before anything is drafted.
export function ContactReviewModal({ booking, onClose, onConfirm }) {
  const pid = providerOfFacility(booking.facility_id), pr = PROVIDERS[pid] || {}, c = pr.contact || {};
  const [d, setD] = useState({ contact_name: c.contact_name || c.name || "", email: c.email || "", phone: c.phone || "" });
  const si = { ...S.inp, fontSize: 13 };
  return (
    <Modal title={`🔎 Review contact — ${pr.name || pid}`} onClose={onClose} width={460}>
      <div style={{fontSize:13,color:"#475569",marginBottom:12}}>This is AMUA's first request to this facility. Check the contact before the request is drafted.
        The draft goes to AMUA's inbox ({AMUA_INBOX}) with these details listed as the recipient — the app never emails the facility.</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        <label style={S.lbl}>Contact person<input style={si} value={d.contact_name} onChange={e=>setD({...d,contact_name:e.target.value})}/></label>
        <label style={S.lbl}>Email<input style={si} type="email" value={d.email} onChange={e=>setD({...d,email:e.target.value})}/></label>
        <label style={S.lbl}>Phone<input style={si} type="tel" value={d.phone} onChange={e=>setD({...d,phone:e.target.value})}/></label>
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14}}>
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
        <button disabled={!d.email.trim()} onClick={()=>onConfirm(pid, { contact_name:d.contact_name.trim(), email:d.email.trim(), phone:d.phone.trim() })}
          style={S.btn({background:d.email.trim()?"#2563eb":"#94a3b8",color:"#fff"})}>Contact reviewed — draft request</button>
      </div>
    </Modal>);
}
export function AdminPanel({bookings,onBulkStatusChange,onEdit,onView,onQueueDelete,clashes=[],deleteIds=new Set(),facilityRates={},onResolveOldUnapproved,onReassign,bookers=[],onBulkApply,onSaveMismatch,onInformCpsa,onRequestRoom,onQueueNotifications,onMarkAdjustmentSettled,onLinkClash,loggedInEmail,syncResults=[],onClearSyncResults,showSyncResults=false,onToggleSyncResults,bookerFilter=new Set(),onToggleBooker,onSetBookerFilter,aliasNames={},emailAliases={},pricingConditions=[],onAddPricingCondition,onUpdatePricingCondition,onRemovePricingCondition,cpsaDeleteLog=[],onClearDeleteLogEntry,onClearDeleteLog,onSendToCouncil,approxPlayers={}}) {
  const [showSchedulePanel, setShowSchedulePanel] = useState(false);
  // The bookings table: Grouped (schedule summary, the default) or Itemised; and a vendor filter.
  const [adminView, setAdminView] = useTableView("fb_admin_view");
  const [adminVendor, setAdminVendor] = useState("all");
  const [reviewFor, setReviewFor] = useState(null);   // community booking awaiting a first-request contact review
  const [showActivityPanel, setShowActivityPanel] = useState(false);
  // Which sync-result months are expanded in the grouped dropdown (monthKey set).
  const [expandedSyncMonths, setExpandedSyncMonths] = useState(()=>new Set());
  // Months the admin has expanded this session. Once a month's results are viewed,
  // they stop reading as "new" (drop the new badges + the top "new issues" rollup).
  const [seenSyncMonths, setSeenSyncMonths] = useState(()=>new Set());
  const toggleSyncMonth = mk => {
    setExpandedSyncMonths(prev=>{ const s=new Set(prev); s.has(mk)?s.delete(mk):s.add(mk); return s; });
    setSeenSyncMonths(prev=> prev.has(mk) ? prev : new Set(prev).add(mk));
  };
  const adminAlias = em => {
    if (!em) return em;
    const primary = (emailAliases[em.toLowerCase()] || em).toLowerCase();
    return aliasNames[primary] || primary.split("@")[0];
  };
  const [ff,setFf]=useState("all"), [q]=useState("");
  // Status filter as an EXCLUSION set: empty shows everything, and unticking a status
  // hides it. The old single-value select could only ever isolate one status, so
  // "everything except cancelled and rejected" was impossible to express.
  const [sfHidden,setSfHidden]=useState(()=>new Set());
  const [sfOpen,setSfOpen]=useState(false);
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
  const [adminDateFrom,setAdminDateFrom]=useState(()=>todayKey()), [adminDateTo,setAdminDateTo]=useState("");
  const [adminColPurpose,setAdminColPurpose]=useState("");
  const [sortCol,setSortCol]=useState("date"), [sortDir,setSortDir]=useState("asc");
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
  // Resolve old unapproved modal: per-booking decision {action, variance}
  const [showClearModal,setShowClearModal]=useState(false);
  const [resolveDec,setResolveDec]=useState({});
  const [clashGrouped,setClashGrouped]=useState(true);
  const [clashPatternModal,setClashPatternModal]=useState(null);
  const [showClashPanel,setShowClashPanel]=useState(false);
  const [showMismatchPanel,setShowMismatchPanel]=useState(false);
  const [mismatchResState,setMismatchResState]=useState({}); // { [bookingId]: { resolution, billingState } }
  // Transient per-row UI flags (propose-modal open, settled-billing warning). Lifted out
  // of the row so the row can be a plain keyed render function instead of a component
  // defined during render — the latter remounts every row on each click, snapping the
  // table scroll back to the top. { [bookingId]: { showWarn, showPropose } }
  const [mismatchRowUI,setMismatchRowUI]=useState({});
  const [mismatchSort,setMismatchSort]=useState({key:"date",dir:"asc"});
  const [showTrackChanges,setShowTrackChanges]=useState(false);
  const [showPricingRules,setShowPricingRules]=useState(false);
  const [showDeleteLogPanel,setShowDeleteLogPanel]=useState(false);

  // Collapsible admin sections — only one open at a time, unless Ctrl/⌘ is held.
  // Sync Results is parent-controlled (toggle-only), so its setter toggles to reach
  // the desired open/closed state.
  const sectionPanels = [
    { open: showSchedulePanel, set: v => setShowSchedulePanel(v) },
    { open: showActivityPanel, set: v => setShowActivityPanel(v) },
    { open: showSyncResults,   set: v => { if (v !== showSyncResults) onToggleSyncResults?.(); } },
    { open: showClashPanel,    set: v => setShowClashPanel(v) },
    { open: showMismatchPanel, set: v => setShowMismatchPanel(v) },
    { open: showTrackChanges,  set: v => setShowTrackChanges(v) },
    { open: showPricingRules,  set: v => setShowPricingRules(v) },
    { open: showDeleteLogPanel, set: v => setShowDeleteLogPanel(v) },
  ];
  // Each section opens and closes on its own; Alt-click shows only that one.
  function toggleSection(idx, e) {
    const only = e && e.altKey;
    const willOpen = only ? true : !sectionPanels[idx].open;
    sectionPanels.forEach((p, i) => {
      if (i === idx) p.set(willOpen);
      else if (only && p.open) p.set(false);
    });
  }

  const si={padding:"7px 12px",borderRadius:8,border:"1.5px solid #e2e8f0",fontSize:13,fontFamily:"inherit",color:"#0f172a",background:"#f8fafc",outline:"none"};
  const today=todayKey();

  // Build and persist a mismatch resolution for one booking.
  async function saveMismatchResolution(booking, resolution, billingState, effectiveVals, opts={}) {
    const reasons = parseMismatchNote(booking.system_notes, booking.notes);
    let sysNotes = booking.system_notes || "";
    const patch = { updated_at: new Date().toISOString() };
    if (resolution === "swapped" && opts.swapTo?.email) {
      // The slot was handed to another club — GTEC now lists them. Reassign our record
      // to the new booker (and accept GTEC's dimensions), then mark confirmed. The old
      // booker is left untouched on GTEC's own schedule, as expected for a swap.
      sysNotes = setCpsaOrig(sysNotes, booking);
      Object.assign(patch, effectiveVals || extractCpsaAmendValues(reasons, booking), {
        status: "cpsa_confirmed", email: opts.swapTo.email, name: opts.swapTo.name || opts.swapTo.email,
      });
      sysNotes = stripMismatchNote(sysNotes);
    } else if (resolution === "amended") {
      sysNotes = setCpsaOrig(sysNotes, booking);
      // Apply the per-field effective values (CPSA only where the admin switched that
      // field; ours elsewhere). Falls back to all-CPSA values for legacy callers.
      Object.assign(patch, effectiveVals || extractCpsaAmendValues(reasons, booking), { status: "cpsa_confirmed" });
      sysNotes = stripMismatchNote(sysNotes);
    } else if (resolution === "proposed") {
      // Manual proposal: amend our record to admin-proposed values (neither ours nor
      // GTEC's). GTEC and the booker still need to confirm, so we KEEP the mismatch
      // flag/snapshot and leave the booking in review — it stays in the queue with a
      // "proposed" chip and the usual GTEC follow-up (Inform GTEC / Confirmed by GTEC).
      sysNotes = setCpsaOrig(sysNotes, booking);
      Object.assign(patch, effectiveVals || {});
    } else if (resolution === "confirmed") {
      // CPSA verbally confirmed our original is correct: keep our values, mark confirmed, clear the mismatch.
      patch.status = "cpsa_confirmed";
      sysNotes = stripMismatchNote(sysNotes);
    }
    sysNotes = setCpsaResolution(sysNotes, resolution, billingState);
    patch.system_notes = sysNotes;
    const ok = await onSaveMismatch(booking, patch, { reasons: reasons.join(" | "), resolution, billing_state: billingState, ...(opts.swapTo?.email ? { swap_from: booking.email, swap_to: opts.swapTo.email } : {}) });
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

  // Booker chip data — canonical groups so linked secondaries fold into one chip.
  const adminCanonEmail = em => (emailAliases[(em||"").toLowerCase()] || (em||"").toLowerCase());
  const adminBookerGroups = {};
  bookings.filter(b=>!isAdminBooking(b)&&b.email).forEach(b=>{
    const em=b.email.toLowerCase(); const primary=adminCanonEmail(em);
    (adminBookerGroups[primary] ||= new Set()).add(em); adminBookerGroups[primary].add(primary);
  });
  const adminBookerPrimaries = Object.keys(adminBookerGroups).sort();
  // Every address across all groups — used for select-all / all-selected checks.
  const adminBookerEmails = [...new Set(adminBookerPrimaries.flatMap(p=>[...adminBookerGroups[p]]))];
  // Roster for the inline activity log's booker picker — each primary with every address
  // that resolves to it, so a search catches entries logged against a secondary too.
  const adminBookerRoster = adminBookerPrimaries.map(pri=>({
    email: pri, name: aliasNames[pri] || pri.split("@")[0], addresses: [...adminBookerGroups[pri]],
  })).sort((a,b)=>a.name.localeCompare(b.name));

  function matchesQ(b) {
    const t=q.toLowerCase();
    return !t||`${b.name} ${b.email} ${b.purpose} ${b.notes||""}`.toLowerCase().includes(t);
  }

  const vendorOk = b => adminVendor==="all" || vendorShortFor(b.facility_id)===adminVendor;
  const list=bookings.filter(b=>{
    if(isAdminBooking(b)) return false;
    if(!vendorOk(b)) return false;
    if(sfHidden.has(b.status)) return false;
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

  // Community facility: queue "Requested from facility" and add the AMUA-inbox draft to the cart.
  function requestCommunity(b) {
    if (actionQueue.some(a => a.id === b.id && a.newStatus === "community_request")) { queueAction(b.id, "community_request"); return; }
    queueAction(b.id, "community_request");
    onQueueNotifications?.([buildCommunityRequestItem(b)], "draft request for AMUA's inbox");
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
      {reviewFor&&<ContactReviewModal booking={reviewFor} onClose={()=>setReviewFor(null)}
        onConfirm={async (pid, data)=>{ try { await saveContactReview(pid, data); } catch(e) { alert("Couldn't save the reviewed contact: "+(e.message||e)); return; }
          const b=reviewFor; setReviewFor(null); requestCommunity(b); }}/>}
      {/* Top action bar: on phones an even two-column grid of section toggles. */}
      <div style={window.innerWidth<768?{display:"grid",gridTemplateColumns:"repeat(2,minmax(0,1fr))",gap:6}:{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        {oldUnapproved.length>0&&(
          <button onClick={()=>{setResolveDec({});setShowClearModal(true);}} style={S.btn({background:"#7c3aed",color:"#fff",fontWeight:700,fontSize:12})}>
            🧭 Resolve old unapproved ({oldUnapproved.length})
          </button>
        )}
        <button onClick={e=>toggleSection(1,e)} title="Open or close this section (Alt-click: show only this one)" style={S.btn({background:showActivityPanel?"#f8fafc":"#fff",color:"#475569",border:`1.5px solid ${showActivityPanel?"#94a3b8":"#e2e8f0"}`,fontSize:12,fontWeight:700})}>
          📜 Activity Log {showActivityPanel?"▴":"▾"}
        </button>
        {<button onClick={e=>toggleSection(2,e)} title="Open or close this section (Alt-click: show only this one)" style={S.btn({background:showSyncResults?"#ecfeff":"#fff",color:syncResults.length>0?"#0e7490":"#94a3b8",border:`1.5px solid ${showSyncResults?"#a5f3fc":"#e2e8f0"}`,fontSize:12,fontWeight:syncResults.length>0?700:500})}>
          🔄 Sync Results ({syncResults.length}) {showSyncResults?"▴":"▾"}
        </button>}
        <button onClick={e=>toggleSection(3,e)} title="Open or close this section (Alt-click: show only this one)" style={S.btn({border:`1.5px solid ${visibleClashes.length>0?"#fda4af":"#e2e8f0"}`,background:showClashPanel?"#fff1f2":"#fff",color:visibleClashes.length>0?"#9f1239":"#94a3b8",fontSize:12,fontWeight:visibleClashes.length>0?700:500})}>
          ⚠️ Clashes ({visibleClashes.length}) {showClashPanel?"▴":"▾"}
        </button>
        {(()=>{ const mc=bookings.filter(b=>b.status==="cpsa_review_needed"&&!isAdminBooking(b)&&inBookerFilter(b.email)).length; return (
        <button onClick={e=>toggleSection(4,e)} title="Open or close this section (Alt-click: show only this one)" style={S.btn({border:`1.5px solid ${mc>0?"#fde68a":"#e2e8f0"}`,background:showMismatchPanel?"#fffbeb":"#fff",color:mc>0?"#b45309":"#94a3b8",fontSize:12,fontWeight:mc>0?700:500})}>
          ⚡ Mismatches ({mc}) {showMismatchPanel?"▴":"▾"}
        </button>
        );})()}
        <button onClick={e=>toggleSection(5,e)} title="Open or close this section (Alt-click: show only this one)" style={S.btn({border:`1.5px solid ${trackedChanges.length>0?"#ddd6fe":"#e2e8f0"}`,background:showTrackChanges?"#f5f3ff":"#fff",color:trackedChanges.length>0?"#5b21b6":"#94a3b8",fontSize:12,fontWeight:trackedChanges.length>0?700:500})}>
          🧾 Track Changes ({trackedChanges.length}) {showTrackChanges?"▴":"▾"}
        </button>
        {onAddPricingCondition&&<button onClick={e=>toggleSection(6,e)} title="Open or close this section (Alt-click: show only this one)" style={S.btn({border:`1.5px solid ${pricingConditions.length>0?"#c7d2fe":"#e2e8f0"}`,background:showPricingRules?"#eef2ff":"#fff",color:pricingConditions.length>0?"#4338ca":"#94a3b8",fontSize:12,fontWeight:pricingConditions.length>0?700:500})}>
          💲 Pricing Rules ({pricingConditions.length}) {showPricingRules?"▴":"▾"}
        </button>}
        <button onClick={e=>toggleSection(7,e)} title="Cancellations of bookings already submitted to GTEC — request GTEC to purge these. Ctrl/⌘-click to keep other sections open" style={S.btn({border:`1.5px solid ${cpsaDeleteLog.length>0?"#fecaca":"#e2e8f0"}`,background:showDeleteLogPanel?"#fef2f2":"#fff",color:cpsaDeleteLog.length>0?"#b91c1c":"#94a3b8",fontSize:12,fontWeight:cpsaDeleteLog.length>0?700:500})}>
          🗑 GTEC Purge Requests ({cpsaDeleteLog.length}) {showDeleteLogPanel?"▴":"▾"}
        </button>
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
            // Emphasise only clashes/mismatches surfaced THIS session — anything from a
            // previous session reads as old/seen once the page is reloaded.
            const isNewRun = r => !!r.syncedAt && r.syncedAt >= _sessionStartIso && !seenSyncMonths.has(r.monthKey);
            const totClash = syncResults.reduce((s,r)=>s+(isNewRun(r)?(r.clashes||0):0),0);
            const totMis = syncResults.reduce((s,r)=>s+(isNewRun(r)?(r.cpsaReviewNeeded||0):0),0);
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
            const changeCount = (r.added||0)+(r.cpsaConfirmed||0)+(r.cpsaReviewNeeded||0)+(r.removed||0)+(r.clashes||0)+(r.clashesResolved||0);
            const hasChanges = changeCount > 0;
            // Only emphasise (tint + "new" badges) when the run happened this session.
            const isNew = !!r.syncedAt && r.syncedAt >= _sessionStartIso && !seenSyncMonths.has(r.monthKey);
            const attention = !r.error && isNew && ((r.clashes||0)>0 || (r.cpsaReviewNeeded||0)>0);
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
                  {(r.clashes||0)>0&&<span style={{fontSize:10,fontWeight:700,background:isNew?"#fecdd3":"#f1f5f9",color:isNew?"#9f1239":"#94a3b8",borderRadius:10,padding:"1px 6px"}}>⚡ {r.clashes}{isNew?" new":""} clash{r.clashes!==1?"es":""}</span>}
                  {(r.cpsaReviewNeeded||0)>0&&<span style={{fontSize:10,fontWeight:700,background:isNew?"#fde68a":"#f1f5f9",color:isNew?"#92400e":"#94a3b8",borderRadius:10,padding:"1px 6px"}}>⚠ {r.cpsaReviewNeeded}{isNew?" new":""} mismatch{r.cpsaReviewNeeded!==1?"es":""}</span>}
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
                            r.cpsaReviewNeeded>0 && ((r.reviewBookings&&r.reviewBookings.length)
                              ? <details><summary style={{color:"#b45309",fontSize:12,cursor:"pointer"}}>⚠ <strong>{r.cpsaReviewNeeded}</strong> need review <span style={{color:"#94a3b8",fontWeight:400}}>· expand to see which</span></summary>
                                  <div style={{margin:"4px 0 2px 14px",display:"flex",flexDirection:"column",gap:4}}>
                                    {r.reviewBookings.map((s,i)=><SyncFlaggedRow key={s.id||i} snap={s} bookings={bookings} onView={onView} kind="review"/>)}
                                  </div>
                                </details>
                              : <span style={{color:"#b45309",fontSize:12}}>⚠ <strong>{r.cpsaReviewNeeded}</strong> need review</span>),
                            r.clashes>0 && ((r.clashBookings&&r.clashBookings.length)
                              ? <details><summary style={{color:"#c2410c",fontSize:12,cursor:"pointer"}}>⚡ <strong>{r.clashes}</strong> clash{r.clashes!==1?"es":""} flagged <span style={{color:"#94a3b8",fontWeight:400}}>· expand to see which</span></summary>
                                  <div style={{margin:"4px 0 2px 14px",display:"flex",flexDirection:"column",gap:4}}>
                                    {r.clashBookings.map((s,i)=><SyncFlaggedRow key={s.id||i} snap={s} bookings={bookings} onView={onView} kind="clash"/>)}
                                  </div>
                                </details>
                              : <span style={{color:"#c2410c",fontSize:12}}>⚡ <strong>{r.clashes}</strong> clash{r.clashes!==1?"es":""} flagged</span>),
                            r.clashesResolved>0 && <span style={{color:"#16a34a",fontSize:12}}>↩ <strong>{r.clashesResolved}</strong> clash{r.clashesResolved!==1?"es":""} restored</span>,
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


      {/* Activity Log — inline */}
      {showActivityPanel && (
        <ActivityLogModal inline onClose={()=>setShowActivityPanel(false)} bookers={adminBookerRoster}/>
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
      {/* GTEC purge-request delete log — cancellations of bookings GTEC already holds.
          Light-red theme; copy as a table to email GTEC asking them to purge the slots. */}
      {showDeleteLogPanel&&(()=>{
        const canon = em => (emailAliases[(em||"").toLowerCase()] || (em||"").toLowerCase());
        const clubOf = b => aliasNames[canon(b.email)] || b.name || (b.email||"").split("@")[0];
        const DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
        const dayOf = d => { const dt = new Date(`${d}T00:00:00`); return Number.isNaN(dt.getTime()) ? "" : DAYS[dt.getDay()]; };
        const facName = id => FACILITIES.find(f=>f.id===id)?.name || id;
        const rows = [...cpsaDeleteLog].sort((a,b)=>(a.date||"").localeCompare(b.date||"")||(a.start_hour||0)-(b.start_hour||0));
        return (
          <div style={{background:"#fef2f2",border:"1.5px solid #fecaca",borderRadius:12,padding:16,display:"flex",flexDirection:"column",gap:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              <span style={{fontWeight:700,fontSize:14,color:"#b91c1c"}}>🗑 GTEC Purge Requests ({rows.length})</span>
              <span style={{fontSize:11,color:"#dc2626"}}>Bookings cancelled after reaching GTEC&apos;s schedule — copy this table and email GTEC to purge the slots.</span>
              {rows.length>0&&onClearDeleteLog&&<button onClick={()=>{ if(window.confirm(`Clear all ${rows.length} purge request${rows.length!==1?"s":""}? Do this once GTEC has confirmed the slots are purged.`)) onClearDeleteLog(); }} style={{marginLeft:"auto",padding:"3px 10px",borderRadius:6,border:"1px solid #fca5a5",background:"#fff",color:"#b91c1c",cursor:"pointer",fontSize:11,fontWeight:600,fontFamily:"inherit"}}>Clear all</button>}
            </div>
            {rows.length===0
              ? <div style={{background:"#fff",border:"1px dashed #fecaca",borderRadius:8,padding:14,fontSize:12,color:"#94a3b8",textAlign:"center"}}>No purge requests. Cancelling a booking that has reached &ldquo;Queued for GTEC&rdquo; or later adds it here.</div>
              : (
                <CopyableTable align="right">
                  <table style={{borderCollapse:"collapse",width:"100%",fontSize:12,background:"#fff"}}>
                    <thead>
                      <tr style={{background:"#fee2e2",color:"#991b1b"}}>
                        {["Club","Email","Day","Date","Facility","Start","End","Action"].map(h=>(
                          <th key={h} style={{border:"1px solid #fecaca",padding:"5px 8px",textAlign:"left",fontWeight:700}}>{h}</th>
                        ))}
                        <th data-nocopy="" style={{border:"1px solid #fecaca",padding:"5px 8px"}}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r=>(
                        <tr key={r.id}>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px",fontWeight:600}}>{clubOf(r)}</td>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px"}}>{r.email}</td>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px"}}>{dayOf(r.date)}</td>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px"}}>{fmtDateShort(r.date)}</td>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px"}}>{facName(r.facility_id)}</td>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px"}}>{fmtTime(r.start_hour)}</td>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px"}}>{fmtTime((r.start_hour||0)+(r.duration||0))}</td>
                          <td style={{border:"1px solid #fecaca",padding:"5px 8px",color:"#b91c1c",fontWeight:600}}>Cancel - Delete</td>
                          <td data-nocopy="" style={{border:"1px solid #fecaca",padding:"5px 8px",textAlign:"center"}}>
                            {onClearDeleteLogEntry&&<button onClick={()=>onClearDeleteLogEntry(r.id)} title="Remove from purge list (GTEC has purged this slot)" style={{cursor:"pointer",border:"none",background:"transparent",color:"#dc2626",fontSize:13,fontFamily:"inherit"}}>✕</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CopyableTable>
              )}
          </div>
        );
      })()}
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
              {/* Council bookings go to the council as one batch application; the $10-per-field
                  fee is fixed then, split by the bookers sharing each field. */}
              {onSendToCouncil&&(()=>{ const ready=bookings.filter(b=>selected.has(b.id)&&canSendToCouncil(b)); if(!ready.length) return null;
                const sp=councilFeeSplit(ready);
                return <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",background:"#f0fdfa",border:"1px solid #99f6e4",borderRadius:10,padding:"8px 10px"}}>
                  <button onClick={async()=>{ const txt=JSON.stringify(buildCouncilPayload(ready, approxPlayers)); try{ await navigator.clipboard.writeText(txt); alert("Copied. On the council's application form, open the AMUA Council panel and paste it in."); }catch{ window.prompt("Copy this, then paste it into the AMUA Council panel on the council form:", txt); } }}
                    title="Copy this batch for the AMUA Council Application extension, which fills the council's form" style={S.btn({background:"#fff",color:"#0f766e",border:"1.5px solid #0d9488"})}>📋 Copy for council form</button>
                  <button onClick={()=>onSendToCouncil(ready.map(b=>b.id))} style={S.btn({background:"#0d9488",color:"#fff"})}>🏛 Send {ready.length} to council</button>
                  <span style={{fontSize:12,color:"#115e59"}}>{sp.fields} field{sp.fields!==1?"s":""} · fee ${sp.total.toFixed(2)} ({Object.entries(sp.byBooker).map(([e,v])=>`${adminAlias(e)} $${v.toFixed(2)}`).join(", ")})</span>
                  <CouncilOccupancyNotes bookings={bookings} ids={new Set(ready.map(b=>b.id))} who={adminAlias}/>
                </div>; })()}
              {onReassign&&<ReassignControl count={selected.size} bookers={bookers} onReassign={to=>{ onReassign([...selected].filter(id=>bookings.find(b=>b.id===id)), to); setSelected(new Set()); }}/>}
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
                    const isRecurring=g.instances.length>=2;
                    return (
                      <div key={i} style={{background:"#fff",border:`1px solid ${isRecurring?"#f43f5e44":"#fecdd3"}`,borderRadius:8,padding:"8px 12px",fontSize:12,color:"#0f172a",display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                        {isRecurring&&<span style={{fontWeight:700,color:"#f43f5e",fontSize:11,background:"#fff1f2",borderRadius:4,padding:"1px 6px",whiteSpace:"nowrap",marginTop:2}}>×{g.instances.length} recurring · {g.dn}</span>}
                        <ClashPair admin={g.admin} user={g.user}/>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                          {onLinkClash&&(
                            <button title={`Confirm this is the same booking — mark it GTEC-confirmed, remove the field block${isRecurring?` (all ${g.instances.length})`:""}, and teach the matcher this org`}
                              onClick={()=>{ if(window.confirm(`Link ${g.instances.length} booking${g.instances.length!==1?"s":""} to GTEC event "${g.admin.purpose}"?\n\nThey'll be marked GTEC-confirmed and future syncs will auto-link this org.`)) onLinkClash(g.instances.map(c=>({admin:c.admin,user:c.user}))); }}
                              style={S.btn({background:"#15803d",color:"#fff",fontSize:11,padding:"3px 8px",fontWeight:700})}>
                              🔗 Link{isRecurring?` all ×${g.instances.length}`:""}
                            </button>
                          )}
                          {isRecurring&&(
                            <button onClick={()=>setClashPatternModal({email:g.user.email,name:g.user.name||g.user.email,pk:`${g.dn}_${g.admin.start_hour}`,bkgs:g.userBkgs,canEdit:true})}
                              style={S.btn({background:"#f43f5e",color:"#fff",fontSize:11,padding:"3px 8px"})}>
                              Resolve recurring
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                : filtered.map((c,i)=>(
                    <div key={i} style={{background:"#fff",border:"1px solid #fecdd3",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#0f172a",display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                      <ClashPair admin={c.admin} user={c.user}/>
                      {onLinkClash&&(
                        <button title="Confirm this is the same booking — mark it GTEC-confirmed, remove the field block, and teach the matcher this org"
                          onClick={()=>{ if(window.confirm(`Link this booking to GTEC event "${c.admin.purpose}"?\n\nIt'll be marked GTEC-confirmed and future syncs will auto-link this org.`)) onLinkClash([{admin:c.admin,user:c.user}]); }}
                          style={S.btn({background:"#15803d",color:"#fff",fontSize:11,padding:"3px 8px",fontWeight:700})}>
                          🔗 Link to GTEC
                        </button>
                      )}
                    </div>
                  ))
              }
            </div>
            {clashPatternModal&&(
              <PatternModal {...clashPatternModal} isAdmin={true} onView={onView} onBulkStatusChange={onBulkStatusChange} onRemove={ids=>ids.forEach(id=>onQueueDelete&&onQueueDelete(id))}
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
        // Every booker already recognised in the system (canonical email → display name).
        // Used by the swap control: a mismatch can be reassigned to any of these.
        const canonOf = em => (emailAliases[(em||"").toLowerCase()] || (em||"").toLowerCase());
        const bookerOptions = [...new Map(
          bookings.filter(b=>!isAdminBooking(b)&&b.email).map(b=>{
            const primary = canonOf(b.email);
            return [primary, { email: primary, name: aliasNames[primary] || b.name || primary.split("@")[0] }];
          })
        ).values()].sort((a,b)=>a.name.localeCompare(b.name));
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
          // Manual proposal: a new value neither ours nor GTEC's — both sides confirm.
          const PILL_PROPOSED = `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#ffedd5;color:#9a3412;border:1px solid #fdba74;font-size:10px;font-weight:700;white-space:nowrap">PROPOSED — GTEC &amp; booker to confirm</span>`;
          // The BOOKER pill carries the booker's own coloured chip (alias + colour) so
          // it's clear which booker needs to acknowledge the change.
          const bookerPill = b => {
            const chip = `<span style="display:inline-block;padding:0 6px;border-radius:8px;background:${emailColor(b.email)};color:#fff;font-weight:700">${adminAlias(b.email)}</span>`;
            return `<span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#ffedd5;color:#9a3412;border:1px solid #fdba74;font-size:10px;font-weight:700;white-space:nowrap">${chip} to acknowledge</span>`;
          };
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
          // Fields that differ between our booking and an admin proposal.
          function proposalFieldsOf(b, prop) {
            const facName=id=>FACILITIES.find(x=>x.id===id)?.name||id;
            const list=[];
            if(prop.facility_id!==b.facility_id) list.push({label:"Field",our:facName(b.facility_id),val:facName(prop.facility_id)});
            if(prop.start_hour!==b.start_hour)   list.push({label:"Time",our:`${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`,val:`${fmtTime(prop.start_hour)}–${fmtTime(prop.start_hour+prop.duration)}`});
            if(prop.duration!==b.duration)       list.push({label:"Dur",our:`${b.duration}h`,val:`${prop.duration}h`});
            return list;
          }
          // Changes cell reflects the admin's current (unsaved) selections from mismatchResState
          // — a manual proposal takes precedence over the per-field keep/switch choices.
          function changesHtml(b, cv) {
            const prop=mismatchResState[b.id]?.proposal;
            if(prop){
              const pf=proposalFieldsOf(b,prop);
              if(!pf.length) return `<span style="color:#94a3b8">—</span>`;
              return pf.map(f=>`<div style="margin:2px 0"><strong>${f.label}:</strong> ${f.our} → <span style="color:#9a3412;font-weight:700">${f.val}</span>${PILL_PROPOSED}</div>`).join("");
            }
            const sel=(mismatchResState[b.id]?.fieldSel)||{};
            const fields=changedFieldsOf(b, cv);
            if(!fields.length) return `<span style="color:#94a3b8">—</span>`;
            return fields.map(f=>{
              const s=sel[f.key];
              if(s==="ours") return `<div style="margin:2px 0"><strong>${f.label}:</strong> ${f.gtec} → <span style="color:#1e3a8a;font-weight:700">${f.our}</span>${PILL_GTEC}</div>`;
              if(s==="cpsa") return `<div style="margin:2px 0"><strong>${f.label}:</strong> ${f.our} → <span style="color:#9a3412;font-weight:700">${f.gtec}</span>${bookerPill(b)}</div>`;
              return `<div style="margin:2px 0;color:#64748b"><strong>${f.label}:</strong> ${f.our} → ${f.gtec}</div>`;
            }).join("");
          }
          function changesText(b, cv) {
            const prop=mismatchResState[b.id]?.proposal;
            if(prop){
              return proposalFieldsOf(b,prop).map(f=>`${f.label}: ${f.our} → ${f.val} [PROPOSED — GTEC & ${adminAlias(b.email)} to confirm]`).join("; ");
            }
            const sel=(mismatchResState[b.id]?.fieldSel)||{};
            return changedFieldsOf(b, cv).map(f=>{
              const s=sel[f.key];
              if(s==="ours") return `${f.label}: ${f.gtec} → ${f.our} [GTEC to update]`;
              if(s==="cpsa") return `${f.label}: ${f.our} → ${f.gtec} [${adminAlias(b.email)} to acknowledge]`;
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
<p style="color:#94a3b8;font-size:11px;margin:0 0 16px">${PILL_GTEC} GTEC's schedule should be corrected to the proposed value. <span style="display:inline-block;margin-left:6px;padding:1px 6px;border-radius:8px;background:#ffedd5;color:#9a3412;border:1px solid #fdba74;font-size:10px;font-weight:700;white-space:nowrap">BOOKER to acknowledge</span> our booking is being amended to GTEC's value — the named booker should be notified.</p>
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
        const renderMismatchRow = (b, rowIdx) => {
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
          const proposal=local?.proposal||null; // admin-proposed {facility_id,start_hour,duration}
          const curBilling=local?.billingState??saved?.billingState??"none";
          const alreadySettled=saved?.billingState==="credited"||saved?.billingState==="invoiced";
          const showWarn=!!mismatchRowUI[b.id]?.showWarn;
          const showPropose=!!mismatchRowUI[b.id]?.showPropose;
          const setShowWarn=v=>setMismatchRowUI(prev=>({...prev,[b.id]:{...prev[b.id],showWarn:v}}));
          const setShowPropose=v=>setMismatchRowUI(prev=>({...prev,[b.id]:{...prev[b.id],showPropose:v}}));

          // A swap reassigns the booking to another known booker; a manual proposal amends
          // to admin values; otherwise the resolution derives from the per-field buttons.
          const swapTo=local?.swapTo||null; // { email, name } the booking is being reassigned to
          const curRes=swapTo?"swapped":proposal?"proposed":deriveResolution(changedFields, fieldSel);

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
          const effectiveVals=proposal||effectiveFrom(fieldSel); // what we save to the booking
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
          // Capture an admin-proposed change (from the day grid) as the resolution.
          // Auto-arm billing from the proposed cost vs what was billed (invoiced rows).
          function setProposal(vals) {
            const cd=rowCostOf(vals)-origCost;
            const auto=b.invoiced?(cd<0?"credit_pending":cd>0?"invoice_pending":"nochange"):"none";
            setMismatchResState(prev=>({...prev,[b.id]:{...prev[b.id],resolution:"proposed",proposal:vals,billingState:prev[b.id]?.billingState??auto}}));
            setShowPropose(false);
          }
          function clearProposal() {
            setMismatchResState(prev=>{
              const n={...prev}; const cur=n[b.id]; if(!cur) return n;
              const c={...cur}; delete c.proposal;
              c.resolution=deriveResolution(changedFields,c.fieldSel||{});
              if(Object.keys(c.fieldSel||{}).length===0 && c.billingState==null) delete n[b.id]; else n[b.id]=c;
              return n;
            });
          }
          // Reassign (swap) the booking to another known booker, or clear the selection.
          function setSwap(email) {
            if (!email) {
              setMismatchResState(prev=>{
                const n={...prev}; const c={...(n[b.id]||{})}; delete c.swapTo;
                if(Object.keys(c.fieldSel||{}).length===0 && !c.proposal && c.billingState==null) delete n[b.id]; else n[b.id]=c;
                return n;
              });
              return;
            }
            const opt=bookerOptions.find(o=>o.email===email);
            setMismatchResState(prev=>({...prev,[b.id]:{...prev[b.id],swapTo:opt,resolution:"swapped"}}));
          }
          function doSave() { saveMismatchResolution(b,curRes,curBilling,effectiveVals,{swapTo}); }

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
            <tr key={b.id} style={{background:rowBg}}>
              {/* Booker */}
              <td style={tdS2}>
                <div style={{fontWeight:600,color:"#0f172a",whiteSpace:"nowrap"}}>{b.name}</div>
                <div style={{color:"#64748b",fontSize:10}}>{b.email}</div>
                {(()=>{ const g=parseGtecSnapshot(b.system_notes); return g ? (
                  <div title="The incoming GTEC event this booking was matched against" style={{marginTop:3,fontSize:10,color:"#0e7490",background:"#ecfeff",border:"1px solid #a5f3fc",borderRadius:4,padding:"1px 5px",display:"inline-block",maxWidth:200,whiteSpace:"normal"}}>
                    🌐 GTEC: {fmtGtecEvent(g)}
                  </div>
                ) : null; })()}
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
                  {ValPair({field:"facility", ourVal:fac?.name||b.facility_id, cpsaVal:cpsaFac?.name||cpsaVals.facility_id, changed:facChanged})}
                </div>
              </td>
              {/* Time — button pair if changed */}
              <td style={tdS2}>
                {ValPair({field:"time",
                  ourVal:`${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`,
                  cpsaVal:`${fmtTime(cpsaVals.start_hour)}–${fmtTime(cpsaVals.start_hour+cpsaVals.duration)}`,
                  changed:timeChanged})}
              </td>
              {/* Duration — button pair if changed */}
              <td style={tdS2}>
                {ValPair({field:"duration", ourVal:`${b.duration}h`, cpsaVal:`${cpsaVals.duration}h`, changed:durChanged})}
              </td>
              {/* Actions: status indicator + billing + save */}
              <td style={{...tdS2,minWidth:170}}>
                <div style={{display:"flex",flexDirection:"column",gap:5}}>
                  {/* Resolution status derived from field buttons or a manual proposal */}
                  {curRes!=="pending"&&(()=>{
                    const meta=curRes==="amended"
                      ? {label:"✓ Amended",color:"#a16207",bg:"#fef9c3",bd:"#fde68a",tip:"Resolved: our record has been amended to GTEC's values."}
                      : curRes==="swapped"
                      ? {label:`🔄 Reassign → ${swapTo?.name||swapTo?.email||""}`,color:"#7c3aed",bg:"#f5f3ff",bd:"#ddd6fe",tip:"The booking will be reassigned to this booker and marked GTEC-confirmed. The previous booker is left on GTEC's own schedule (a swap)."}
                      : curRes==="proposed"
                      ? {label:"📅 Proposed change",color:"#9a3412",bg:"#ffedd5",bd:"#fdba74",tip:"Our record will be amended to the admin-proposed values. GTEC and the booker still need to confirm."}
                      : {label:"↩ GTEC to correct",color:"#5b21b6",bg:"#f5f3ff",bd:"#ddd6fe",tip:"Pending: GTEC to correct on their side. Becomes 'corrected' once GTEC acknowledges."};
                    return (
                      <div title={meta.tip} style={{fontSize:10,fontWeight:700,color:meta.color,background:meta.bg,border:`1px solid ${meta.bd}`,borderRadius:4,padding:"2px 7px",display:"inline-block",cursor:"help"}}>
                        {meta.label}
                      </div>
                    );
                  })()}
                  {/* Proposed values summary + edit/clear */}
                  {proposal&&(()=>{
                    const pf=FACILITIES.find(x=>x.id===proposal.facility_id);
                    return (
                      <div style={{fontSize:10,color:"#9a3412",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:4,padding:"3px 7px"}}>
                        <div style={{fontWeight:700}}>{pf?.name||proposal.facility_id} · {fmtTime(proposal.start_hour)}–{fmtTime(proposal.start_hour+proposal.duration)} · {proposal.duration}h</div>
                        <div style={{display:"flex",gap:6,marginTop:3}}>
                          <button onClick={()=>setShowPropose(true)} style={{fontFamily:"inherit",fontSize:10,fontWeight:700,border:"none",background:"transparent",color:"#c2410c",cursor:"pointer",padding:0,textDecoration:"underline"}}>edit</button>
                          <button onClick={clearProposal} style={{fontFamily:"inherit",fontSize:10,fontWeight:700,border:"none",background:"transparent",color:"#94a3b8",cursor:"pointer",padding:0,textDecoration:"underline"}}>clear</button>
                        </div>
                      </div>
                    );
                  })()}
                  {saved?.date&&(
                    <div style={{fontSize:9,color:"#94a3b8",marginTop:-2}} title="When this resolution was last logged / updated">
                      🕗 logged {fmtLoggedAt(saved.date)}
                    </div>
                  )}
                  {(curRes==="to_correct"||curRes==="proposed")&&(
                    <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:2}}>
                      <div style={{fontSize:10,color:"#64748b",fontWeight:700}}>GTEC follow-up:</div>
                      <button onClick={()=>saveMismatchResolution(b,"confirmed","none")}
                        title={curRes==="proposed"?"GTEC accepted the proposed change — keep the proposed values and mark the booking confirmed":"GTEC verbally confirmed our original is correct - keep our values and mark the booking confirmed"}
                        style={{fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:5,padding:"3px 9px",cursor:"pointer",background:"#ecfdf5",border:"1.5px solid #6ee7b7",color:"#047857",whiteSpace:"nowrap",textAlign:"left"}}>✓ Confirmed by GTEC</button>
                      <button onClick={()=>onInformCpsa&&onInformCpsa(b)}
                        title={curRes==="proposed"?"Cart an email asking GTEC to update their schedule to the proposed values. Does not resolve the mismatch.":"Cart an email to a vendor asking GTEC to correct their schedule to match our record. Does not resolve the mismatch."}
                        style={{fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:5,padding:"3px 9px",cursor:"pointer",background:"#f0f9ff",border:"1.5px solid #7dd3fc",color:"#0369a1",whiteSpace:"nowrap",textAlign:"left"}}>📨 Inform GTEC</button>
                    </div>
                  )}
                  {curRes==="pending"&&changedFields.length>0&&(
                    <div style={{fontSize:10,color:"#94a3b8"}}>← Click values to resolve</div>
                  )}
                  {!proposal&&!swapTo&&(
                    <button onClick={()=>setShowPropose(true)}
                      title="Manually propose a different field/time/duration (neither ours nor GTEC's) on the day grid. Amends our record and is flagged for GTEC + the booker to confirm."
                      style={{fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:5,padding:"3px 9px",cursor:"pointer",background:"#fff7ed",border:"1.5px solid #fdba74",color:"#c2410c",whiteSpace:"nowrap",textAlign:"left"}}>📅 Propose change…</button>
                  )}
                  {/* Swap — reassign this slot to another club already known to the system.
                      The previous booker remains on GTEC's own schedule (a genuine swap). */}
                  {!proposal&&(
                    <div style={{display:"flex",alignItems:"center",gap:4}}>
                      <select value={swapTo?.email||""} onChange={e=>setSwap(e.target.value)}
                        title="Reassign this booking to another club already in the system (a swap). The previous booker remains on GTEC's schedule."
                        style={{fontFamily:"inherit",fontSize:11,borderRadius:5,padding:"3px 6px",border:`1.5px solid ${swapTo?"#a78bfa":"#ddd6fe"}`,background:swapTo?"#f5f3ff":"#fff",color:"#5b21b6",maxWidth:160}}>
                        <option value="">🔄 Reassign booker…</option>
                        {bookerOptions.filter(o=>o.email!==canonOf(b.email)).map(o=>(
                          <option key={o.email} value={o.email}>{o.name}</option>
                        ))}
                      </select>
                      {swapTo&&<button onClick={()=>setSwap("")} title="Cancel reassignment" style={{fontFamily:"inherit",fontSize:11,border:"1.5px solid #cbd5e1",borderRadius:4,background:"transparent",color:"#94a3b8",cursor:"pointer",padding:"1px 5px"}}>↩</button>}
                    </div>
                  )}
                  {showPropose&&(
                    <Modal title={`📅 Propose a change — ${fmtDate(b.date)}`} onClose={()=>setShowPropose(false)} width={760}>
                      <div style={{fontSize:12,color:"#9a3412",background:"#fff7ed",border:"1px solid #fed7aa",borderRadius:8,padding:"8px 12px",marginBottom:10}}>
                        Drag a slot to propose a new field, start time and duration for <strong>{b.name||b.email}</strong>. Our record will be amended to this proposal, and GTEC &amp; the booker flagged to confirm.
                      </div>
                      <InlineDayPicker date={b.date} bookings={bookings} onPick={(facId,start,dur)=>setProposal({facility_id:facId,start_hour:start,duration:dur})}/>
                      <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
                        <button onClick={()=>setShowPropose(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:12})}>Close</button>
                      </div>
                    </Modal>
                  )}
                  {/* Warning when billing already settled */}
                  {showWarn&&alreadySettled&&(
                    <div style={{fontSize:10,background:"#fef2f2",border:"1px solid #fecaca",borderRadius:4,padding:"3px 7px",color:"#b91c1c"}}>⚠ Billing already settled from invoice view</div>
                  )}
                  {/* Billing follow-up — relevant when our record changes (amended or proposed) */}
                  {(curRes==="amended"||curRes==="proposed")&&(()=>{
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
                      {mismatches.map((b,i)=>renderMismatchRow(b,i))}
                    </tbody>
                  </table>
                  </CopyableTable>
                </div>
            }
          </div>
        );
      })()}

      {/* Bookings: Grouped (schedule summary) or Itemised, with a vendor filter for both. */}
      <TableViewToggle value={adminView} onChange={setAdminView}>
        <span style={{width:1,height:18,background:"#e2e8f0",flexShrink:0,margin:"0 4px"}}/>
        <span style={{color:"#64748b",fontWeight:600}}>Vendor:</span>
        <select value={adminVendor} onChange={e=>setAdminVendor(e.target.value)} aria-label="Vendor"
          style={{padding:"3px 8px",borderRadius:6,border:"1px solid #e2e8f0",fontSize:11,fontWeight:600,fontFamily:"inherit",background:adminVendor==="all"?"#fff":"#0f172a",color:adminVendor==="all"?"#475569":"#fff"}}>
          <option value="all">All vendors</option>
          {vendorsIn(bookings.filter(b=>!isAdminBooking(b))).map(v=><option key={v} value={v}>{v}</option>)}
        </select>
      </TableViewToggle>
      {adminView==="grouped"
        ? <ScheduleSummaryModal bookings={bookings.filter(b=>inBookerFilter(b.email)&&vendorOk(b))} isAdmin={true} loggedInEmail={loggedInEmail} onBulkApply={onBulkApply} onBulkStatusChange={onBulkStatusChange} onRemove={ids=>ids.forEach(id=>onQueueDelete&&onQueueDelete(id))} onReassign={onReassign} bookers={bookers} onView={onView} aliasNames={aliasNames} emailAliases={emailAliases} embedded/>
      : list.length===0
        ? <div style={{textAlign:"center",padding:"40px 0",color:"#94a3b8",fontSize:14}}>No bookings found.</div>
        : (
        <div style={{overflowX:"auto",borderRadius:12,border:"1px solid #f1f5f9"}}>
          <CopyableTable>
          <table className="admin-bk" style={{width:"100%",borderCollapse:"collapse",background:"#fff",fontSize:13}}>
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
                                {adminBookerPrimaries.map(primary=>{
                                  const group=adminBookerGroups[primary];
                                  const active=[...group].every(em=>adminBookerFilter.has(em));
                                  const c=emailColor(primary);
                                  const others=[...group].filter(em=>em!==primary);
                                  return(
                                    <button key={primary}
                                      onClick={e=>{ if(e.ctrlKey||e.metaKey) toggleAdminBooker(primary); else setAdminBookerFilter(new Set(group)); }}
                                      title={`Click to show only this booker · Ctrl/⌘-click to add/remove${others.length?`\n${primary} (+ ${others.join(", ")})`:`\n${primary}`}`}
                                      style={{padding:"3px 8px",fontSize:11,borderRadius:14,border:`1.5px solid ${active?c:"#e2e8f0"}`,background:active?c:"#fff",color:active?"#fff":"#475569",cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>
                                      {adminAlias(primary)}
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
                    {visibleFacilities().map(f=><option key={f.id} value={f.id}>{facCellLabel(f)}</option>)}
                  </select>
                </th>
                <th style={{padding:"3px 4px",width:100,position:"relative"}}>
                  {(()=>{
                    // "pending" and "amua_submit" are legacy aliases of statuses already
                    // listed, so they are not offered — but they follow whatever their
                    // modern equivalent is set to, or nothing would ever hide them.
                    const ALIAS = { pending:"pending_amua", amua_submit:"queued_cpsa" };
                    const keys = Object.keys(STATUS_META).filter(k=>!ALIAS[k]);
                    const shown = keys.filter(k=>!sfHidden.has(k));
                    const label = sfHidden.size===0 ? "All"
                      : shown.length===0 ? "None"
                      : shown.length===1 ? groupStatusLabel(shown[0], bookings.filter(b=>b.status===shown[0]))
                      : `${shown.length}/${keys.length}`;
                    // Hiding a status hides its legacy alias with it.
                    const withAliases = set => {
                      const n2 = new Set(set);
                      Object.entries(ALIAS).forEach(([legacy,modern]) => n2.has(modern) ? n2.add(legacy) : n2.delete(legacy));
                      return n2;
                    };
                    const toggle = k => setSfHidden(prev => {
                      const n2 = new Set(prev); n2.has(k) ? n2.delete(k) : n2.add(k);
                      return withAliases(n2);
                    });
                    const only = k => setSfHidden(withAliases(new Set(keys.filter(x=>x!==k))));
                    return (<>
                      <button onClick={()=>setSfOpen(o2=>!o2)} title="Show or hide statuses"
                        style={{padding:"3px 4px",fontSize:10,border:`1px solid ${sfHidden.size?"#0f172a":"#cbd5e1"}`,borderRadius:4,
                          background:sfHidden.size?"#0f172a":"#fff",color:sfHidden.size?"#fff":"#475569",width:"100%",
                          cursor:"pointer",fontFamily:"inherit",fontWeight:sfHidden.size?700:400,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
                        {label} ▾
                      </button>
                      {sfOpen&&(<>
                        <div onClick={()=>setSfOpen(false)} style={{position:"fixed",inset:0,zIndex:29}}/>
                        <div style={{position:"absolute",top:"100%",left:0,zIndex:30,background:"#fff",border:"1.5px solid #cbd5e1",
                          borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,0.14)",padding:6,minWidth:210,textAlign:"left"}}>
                          <div style={{display:"flex",gap:5,marginBottom:5}}>
                            <button onClick={()=>setSfHidden(new Set())}
                              style={{flex:1,padding:"3px 6px",fontSize:10,border:"1px solid #e2e8f0",borderRadius:4,background:"#fff",color:"#475569",cursor:"pointer",fontFamily:"inherit"}}>Show all</button>
                            <button onClick={()=>setSfOpen(false)}
                              style={{flex:1,padding:"3px 6px",fontSize:10,border:"1px solid #0f172a",borderRadius:4,background:"#0f172a",color:"#fff",cursor:"pointer",fontFamily:"inherit",fontWeight:700}}>Done</button>
                          </div>
                          {keys.map(k=>{
                            const m = STATUS_META[k];
                            return (
                              <div key={k} style={{display:"flex",alignItems:"center",gap:6,padding:"2px 3px",fontSize:11}}>
                                <input type="checkbox" checked={!sfHidden.has(k)} onChange={()=>toggle(k)}
                                  style={{accentColor:"#0f172a",cursor:"pointer",flexShrink:0}}/>
                                <span style={{width:8,height:8,borderRadius:"50%",background:m?.dot||"#94a3b8",flexShrink:0}}/>
                                <span onClick={()=>toggle(k)} style={{cursor:"pointer",color:sfHidden.has(k)?"#94a3b8":"#0f172a",
                                  textDecoration:sfHidden.has(k)?"line-through":"none",whiteSpace:"nowrap"}}>
                                  {groupStatusLabel(k, bookings.filter(b=>b.status===k))}
                                </span>
                                <button onClick={()=>only(k)} title={`Show only ${bareStatusLabel(k)}`}
                                  style={{marginLeft:"auto",padding:"0 5px",fontSize:9,border:"1px solid #e2e8f0",borderRadius:3,
                                    background:"#f8fafc",color:"#64748b",cursor:"pointer",fontFamily:"inherit"}}>only</button>
                              </div>
                            );
                          })}
                        </div>
                      </>)}
                    </>);
                  })()}
                </th>
                <th style={{padding:"3px 4px"}}>
                  <input placeholder="Search purpose…" value={adminColPurpose} onChange={e=>setAdminColPurpose(e.target.value)}
                    style={{padding:"3px 6px",fontSize:11,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}/>
                </th>
                <th style={{padding:"3px 4px"}}>
                  {(adminBookerFilter.size>0||sfHidden.size>0||ff!=="all"||adminDateFrom||adminDateTo||adminColPurpose)&&(
                    <button onClick={()=>{setAdminBookerFilter(new Set());setSfHidden(new Set());setFf("all");setAdminDateFrom("");setAdminDateTo("");setAdminColPurpose("");}}
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
                const queueLabel = queued ? {queued_cpsa:`→ Queue for ${vendorShortFor(b.facility_id)}`,approved:"✓ Approve",rejected:"✗ Reject"}[queued.newStatus]||("→ "+(STATUS_META[queued.newStatus]?.label||queued.newStatus)) : null;
                const wf=workflowOf(b.facility_id), isCouncilWf=wf==="council"||wf==="council_private"||wf==="community", nxt=nextWorkflowStatus(b);
                const opContact=PROVIDERS[providerOfFacility(b.facility_id)]?.contact;
                const opHint=(opContact&&(nxt==="op_permission"||nxt==="op_confirm")?` — ${[opContact.contact_name||opContact.name,opContact.email,opContact.phone].filter(Boolean).join(" · ")}`:"")
                  +(nxt==="council_apply"?` — council application fee $${COUNCIL_APPLICATION_FEE} per field (pay later)`:"");
                return (
                  <tr key={b.id} onClick={()=>onView&&onView(b)} style={{background:rowBg,borderTop:ri>0?"1px solid #f1f5f9":"none",transition:"background 0.1s",cursor:"pointer"}}
                    onMouseEnter={e=>{if(!rowBg||rowBg==="#fff")e.currentTarget.style.background="#f8fafc";}}
                    onMouseLeave={e=>e.currentTarget.style.background=rowBg}>
                    <td style={{padding:"3px 8px",textAlign:"center"}} onClick={e=>e.stopPropagation()}>
                      {isPending&&<input type="checkbox" checked={selected.has(b.id)} onChange={()=>toggleSelect(b.id)} style={{width:13,height:13,accentColor:"#6366f1"}}/>}
                    </td>
                    <td style={{padding:"3px 6px",whiteSpace:"nowrap",fontSize:11,color:"#475569"}}>{fmtDateShortDow(b.date)}</td>
                    <td style={{padding:"3px 6px"}}>
                      <span onClick={e=>{e.stopPropagation();toggleAdminBooker(adminCanonEmail(b.email));}}
                        style={{display:"inline-block",padding:"2px 8px",borderRadius:10,background:emailColor(b.email),color:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",outline:adminBookerFilter.has(adminCanonEmail(b.email))?"2px solid #0f172a":"none",outlineOffset:1}}>
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
                      <Badge status={b.status} wf={workflowOf(b.facility_id)} fid={b.facility_id}/>
                      {workflowStep(b)&&<span title="Step in the council workflow" style={{fontSize:9,fontWeight:700,color:"#0f766e",marginLeft:3}}>{workflowStep(b)}</span>}
                      {isCouncilBooking(b)&&!isClosed(b.status)&&(()=>{ const app=parseCouncilApp(b.system_notes);
                        return <span title={app?`Council application ${app.id} (sent ${fmtDate(app.at.slice(0,10))}): this booking's share of the $${COUNCIL_APPLICATION_FEE}-per-field fee`:`Council application fee: pending until AMUA sends the application ($${COUNCIL_APPLICATION_FEE} per field, shared)`}
                          style={{fontSize:9,fontWeight:700,marginLeft:3,padding:"0 4px",borderRadius:4,background:app?"#ccfbf1":"#f1f5f9",color:app?"#115e59":"#64748b"}}>🏛 {app?`$${app.fee.toFixed(2)}`:"fee pending"}</span>; })()}
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
                          {/* One "<vendor> →" button: rooms send CPSA a room request (an AMUA draft) and go
                              to Pending CPSA review; Cornwall Park fields queue for GTEC. */}
                          {providerOfFacility(b.facility_id)==="gtec"&&(isSocialFac(b.facility_id)
                            ? (onRequestRoom&&(isAmuaStage||b.status==="queued_cpsa"||b.status==="amua_submit")&&<button onClick={()=>onRequestRoom(b)} title={`Email ${vendorShortFor(b.facility_id)} a room request (it lands as a draft in AMUA's inbox)`}
                                style={S.btn({padding:"3px 7px",fontSize:10,background:"#7c3aed",color:"#fff"})}>{vendorShortFor(b.facility_id)} →</button>)
                            : isAmuaStage&&<button onClick={()=>queueAction(b.id,"queued_cpsa")} title={`Queue for ${vendorShortFor(b.facility_id)}`}
                                style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="queued_cpsa"?"#1d4ed8":"#3b82f6",color:"#fff",outline:queued?.newStatus==="queued_cpsa"?"2px solid #1d4ed8":"none"})}>{vendorShortFor(b.facility_id)} →</button>)}
                          {(b.status==="queued_cpsa"||b.status==="amua_submit")&&<button onClick={()=>queueAction(b.id,"pending_cpsa")} title="Mark as Pending GTEC Review (no email)"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="pending_cpsa"?"#0369a1":"#0ea5e9",color:"#fff",outline:queued?.newStatus==="pending_cpsa"?"2px solid #0369a1":"none"})}>⏳</button>}
                          {/* Council workflows step through their stages one at a time. */}
                          {isCouncilWf&&nxt&&nxt!=="approved"&&<button onClick={()=>nxt==="contact_review"?setReviewFor(b):nxt==="community_request"?requestCommunity(b):queueAction(b.id,nxt)} title={`Next step: ${STATUS_META[nxt]?.label}${opHint}`}
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus===nxt?"#0f766e":STATUS_META[nxt]?.dot,color:"#fff",outline:queued?.newStatus===nxt?"2px solid #0f766e":"none"})}>{STATUS_META[nxt]?.label.split(" ")[0]} →</button>}
                          {/* Non-GTEC facilities skip the GTEC queue: AMUA approves them directly;
                              council workflows approve only from their last step. */}
                          {(isCpsaStage||(isAmuaStage&&wf==="direct")||(isCouncilWf&&nxt==="approved"))&&<button onClick={()=>queueAction(b.id,"approved")} title={isCpsaStage?"Mark GTEC Approved":"Approve"}
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="approved"?"#15803d":"#22c55e",color:"#fff",outline:queued?.newStatus==="approved"?"2px solid #15803d":"none"})}>✓</button>}
                          <button onClick={()=>queueAction(b.id,"rejected")} title="Reject"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="rejected"?"#be123c":"#f43f5e",color:"#fff",outline:queued?.newStatus==="rejected"?"2px solid #be123c":"none"})}>✗</button>
                        </>}
                        {b.status==="clash"&&!isDeleteQueued&&(<>
                          <button onClick={()=>queueAction(b.id,"approved")} title="Resolve clash — approve booking"
                            style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="approved"?"#15803d":"#22c55e",color:"#fff",outline:queued?.newStatus==="approved"?"2px solid #15803d":"none"})}>✓ Resolve</button>
                          {/* A clash hides the stage the booking was at, and REVIEW_STATUSES
                              doesn't contain "clash" — so a booking that clashed while still
                              awaiting review lost its reject action and could only be approved
                              or deleted. Offer reject wherever the pre-clash stage was a review
                              stage, which is the pending-AMUA case. */}
                          {REVIEW_STATUSES.has(parseClashPrevStatus(b.system_notes)||"pending_amua")&&(
                            <button onClick={()=>queueAction(b.id,"rejected")}
                              title={`Reject — clashed while at ${STATUS_META[parseClashPrevStatus(b.system_notes)||"pending_amua"]?.label||"review"}`}
                              style={S.btn({padding:"3px 7px",fontSize:10,background:queued?.newStatus==="rejected"?"#be123c":"#f43f5e",color:"#fff",outline:queued?.newStatus==="rejected"?"2px solid #be123c":"none"})}>✗</button>
                          )}
                        </>)}
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

      {/* Resolve old unapproved: past bookings still awaiting approval — remove each, or record
          that the vendor approved it (optionally with a mismatch, kept for invoice footnotes). */}
      {showClearModal&&(()=>{
        const ACTIONS=[["","— leave —"],["remove","🗑 Remove (removal queue)"],["vendor","✓ Vendor approved"],["vendor_var","⚠ Vendor approved (with mismatch)"]];
        const decOf=b=>resolveDec[b.id]||{action:""};
        const setDec=(b,d)=>setResolveDec(prev=>({...prev,[b.id]:{...decOf(b),...d}}));
        const setAll=action=>setResolveDec(Object.fromEntries(oldUnapproved.map(b=>[b.id,{...decOf(b),action,variance:decOf(b).variance||vendorTimesDefault(b)}])));
        const chosen=oldUnapproved.filter(b=>decOf(b).action);
        const count=a=>chosen.filter(b=>decOf(b).action===a).length;
        const si={border:"1px solid #e2e8f0",borderRadius:6,padding:"3px 6px",fontSize:12,fontFamily:"inherit",background:"#fff"};
        return (
        <div onClick={e=>e.target===e.currentTarget&&setShowClearModal(false)}
          style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:2000,backdropFilter:"blur(2px)"}}>
          <div style={{background:"#fff",borderRadius:16,padding:24,maxWidth:640,width:"94%",maxHeight:"88vh",overflowY:"auto",boxShadow:"0 8px 40px rgba(0,0,0,0.2)"}}>
            <h2 style={{margin:"0 0 6px",fontSize:18,fontWeight:700,color:"#0f172a"}}>🧭 Resolve Old Unapproved Bookings</h2>
            <p style={{margin:"0 0 12px",fontSize:13,color:"#64748b"}}>Past bookings still awaiting approval. Choose what happened to each — remove it, or record that the vendor approved it (with the vendor's times if they differed from the request).</p>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10,fontSize:12,color:"#475569"}}>
              Set all to
              <select value="" onChange={e=>e.target.value&&setAll(e.target.value==="none"?"":e.target.value)} style={si}>
                <option value="">…</option>
                {ACTIONS.map(([k,l])=><option key={k||"none"} value={k||"none"}>{l}</option>)}
              </select>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:"48vh",overflowY:"auto",marginBottom:12}}>
              {oldUnapproved.map(b=>{
                const f=FACILITIES.find(x=>x.id===b.facility_id); const d=decOf(b);
                return(
                  <div key={b.id} style={{background:d.action==="remove"?"#fff1f2":d.action?"#f0fdf4":"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"8px 12px",fontSize:12,display:"flex",flexDirection:"column",gap:6}}>
                    <div style={{display:"flex",gap:8,alignItems:"flex-start",flexWrap:"wrap"}}>
                      <div style={{flex:"1 1 220px",minWidth:0}}>
                        <div style={{fontWeight:600,color:"#0f172a"}}>{b.name} — {f?.name}</div>
                        <div style={{color:"#64748b"}}>{fmtDate(b.date)} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.purpose}</div>
                        <div style={{marginTop:3}}><Badge status={b.status} fid={b.facility_id}/></div>
                      </div>
                      <select aria-label={`Resolve ${fmtDate(b.date)}`} value={d.action} onChange={e=>setDec(b,{action:e.target.value,variance:d.variance||vendorTimesDefault(b)})} style={si}>
                        {ACTIONS.map(([k,l])=><option key={k} value={k}>{l}</option>)}
                      </select>
                    </div>
                    {d.action==="vendor_var"&&<VendorTimesFields booking={b} value={d.variance||vendorTimesDefault(b)} onChange={v=>setDec(b,{variance:v})}/>}
                  </div>
                );
              })}
            </div>
            <div style={{fontSize:12,color:"#64748b",marginBottom:14}}>
              Removals go to the 🗑 Removal Queue; approvals are queued in the cart without emailing the booker (they're in the past) and apply when you submit it. A recorded mismatch stays on the booking and can be asterisked on invoices.
            </div>
            <div style={{display:"flex",gap:10,justifyContent:"flex-end",flexWrap:"wrap"}}>
              <button onClick={()=>setShowClearModal(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
              <button disabled={!chosen.length} onClick={()=>{
                  onResolveOldUnapproved(chosen.map(b=>{const d=decOf(b);return {id:b.id,action:d.action,
                    variance:d.action==="vendor_var"?{...(d.variance||vendorTimesDefault(b)),reqStart:b.start_hour,reqDur:b.duration}:null};}));
                  setShowClearModal(false);}}
                style={S.btn({background:chosen.length?"#7c3aed":"#cbd5e1",color:"#fff",fontWeight:700,cursor:chosen.length?"pointer":"not-allowed"})}>
                Resolve {chosen.length}{chosen.length?` (${[count("remove")&&`${count("remove")} remove`,(count("vendor")+count("vendor_var"))&&`${count("vendor")+count("vendor_var")} approve`].filter(Boolean).join(", ")})`:""}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

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