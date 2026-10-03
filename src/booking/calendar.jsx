import { useState, useRef, useEffect } from "react";
import { initialsOf } from "../people.js";
import { CAL_SLOTS, CAL_START, CAL_TOTAL, FACILITIES, FACILITY_TINT, HOUR_H, MONTHS, Modal, REVIEW_STATUSES, S, SLOTS_PER_HOUR, SLOT_H, SLOT_HOURS, STATUS_CAL_COLOR, STATUS_CAL_TEXT, dateKey, emailColor, facColLabel, fmt24, fmtTime, fmtTimeShort, getDaysInMonth, getWeekDates, inActiveVenue, isAdminBooking, isSocialFac, layoutOverlapLanes, parseMismatchNote, todayKey, useMobile, venueFacilities } from "./core.jsx";
import { isClosed } from "../statuses.js";
export function WeekCalendar({ bookings, onNewBooking, onNewBookingRange, onBookingClick, selectedFacility, cartSourceIds=new Set(), deleteIds=new Set(), cartNewDrafts=[], focusedDate, setFocusedDate, onOpenDay, bookerFilter=new Set(), aliasNames={}, emailAliases={} }) {
  function calAlias(em) {
    if (!em) return "";
    const primary = (emailAliases[em.toLowerCase()] || em).toLowerCase();
    return aliasNames[primary] || primary.split("@")[0];
  }
  const [localBase, setLocalBase] = useState(new Date());
  // Phones: the whole week fits the screen (no sideways scroll) — narrow time axis, compact
  // day headers and booking blocks that show just the booker.
  const narrow = useMobile(), axisW = narrow ? 30 : 52;
  const weekBase    = focusedDate || localBase;
  const setWeekBase = setFocusedDate || setLocalBase;
  // dragState tracks the active drag; dragMoved tracks whether mouse moved
  // enough to be considered a drag (vs a plain click)
  const [dragState, setDragState] = useState(null);
  const dragMoved = useRef(false);
  const gridRef   = useRef(null);

  const days    = getWeekDates(weekBase);
  const today   = todayKey();
  const visible = (selectedFacility === "all" ? bookings.filter(b => inActiveVenue(b.facility_id)) : bookings.filter(b => b.facility_id === selectedFacility))
    .filter(b => !isClosed(b.status));

  function yToSlot(y)      { return Math.max(0, Math.min(Math.floor(y / SLOT_H), CAL_SLOTS - 1)); }
  function slotToHour(s)   { return CAL_START + s * SLOT_HOURS; }

  // Column-aware drag: a vertical drag in one column selects a time band (opens the
  // day popup); a horizontal drag across columns selects a span of days and creates one
  // grouped booking (one row per day) at the dragged time band. Coordinates are read
  // from the columns container so a drag can cross day boundaries.
  const colsRef = useRef(null);
  function colFromX(clientX) {
    const r = colsRef.current?.getBoundingClientRect(); if (!r) return 0;
    return Math.max(0, Math.min(days.length-1, Math.floor((clientX - r.left) / (r.width / days.length))));
  }
  function slotFromY(clientY) {
    const r = colsRef.current?.getBoundingClientRect(); if (!r) return 0;
    return yToSlot(clientY - r.top);
  }
  function gridDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    dragMoved.current = false;
    setDragState({ startCol:colFromX(e.clientX), endCol:colFromX(e.clientX), startSlot:slotFromY(e.clientY), endSlot:slotFromY(e.clientY), active:true });
  }
  function gridMove(e) {
    if (!dragState?.active) return;
    const col = colFromX(e.clientX), slot = slotFromY(e.clientY);
    if (col !== dragState.endCol || slot !== dragState.endSlot) {
      dragMoved.current = true;
      setDragState(ds => ({ ...ds, endCol: col, endSlot: slot }));
    }
  }
  function gridUp() {
    if (!dragState?.active) return;
    const ds = dragState, moved = dragMoved.current;
    dragMoved.current = false;
    setDragState(null);
    const loCol = Math.min(ds.startCol, ds.endCol), hiCol = Math.max(ds.startCol, ds.endCol);
    const loSlot = Math.min(ds.startSlot, ds.endSlot), hiSlot = Math.max(ds.startSlot, ds.endSlot);
    const startHour = slotToHour(loSlot);
    const duration = moved ? (hiSlot - loSlot + 1) * SLOT_HOURS : 1;
    if (loCol === hiCol) {
      // The day view opens with this time band already chosen (tap = one hour).
      const dk = dateKey(days[loCol]);
      if (onOpenDay) onOpenDay(dk, startHour, duration); else onNewBooking(dk, startHour, duration);
      return;
    }
    // Multi-day span → grouped booking (skip past days).
    const dates = [];
    for (let c=loCol; c<=hiCol; c++) { const dk = dateKey(days[c]); if (dk >= today) dates.push(dk); }
    if (dates.length > 1 && onNewBookingRange) onNewBookingRange(dates, startHour, duration);
    else if (dates.length === 1) (onOpenDay ? onOpenDay(dates[0], startHour, duration) : onNewBooking(dates[0], startHour, duration));
  }
  const dragSpan = dragState?.active ? {
    loCol: Math.min(dragState.startCol, dragState.endCol),
    hiCol: Math.max(dragState.startCol, dragState.endCol),
    loSlot: Math.min(dragState.startSlot, dragState.endSlot),
    hiSlot: Math.max(dragState.startSlot, dragState.endSlot),
  } : null;

  function getStackStyle(b, dayBkgs) {
    const ov = dayBkgs.filter(o => o.id !== b.id && o.start_hour < b.start_hour+b.duration && o.start_hour+o.duration > b.start_hour);
    if (ov.length === 0) return { left:2, right:2 };
    const all = [b,...ov].sort((a,x)=>a.start_hour-x.start_hour||a.id.localeCompare(x.id));
    const idx = all.findIndex(x=>x.id===b.id), cnt=all.length, w=96/cnt;
    return { left:`${2+idx*w}%`, width:`${w-1}%`, right:"auto" };
  }

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", gap:window.innerWidth<768?6:10, marginBottom:window.innerWidth<768?10:14, minWidth:0 }}>
        {(window.innerWidth<768?[["‹",-7,"Previous week"],["Today",0,"This week"],["›",7,"Next week"]]:[["← Prev",-7],["Today",0],["Next →",7]]).map(([lbl,delta,title])=>(
          <button key={lbl} title={title} onClick={()=>delta===0?setWeekBase(new Date()):setWeekBase(d=>{const nd=new Date(d);nd.setDate(nd.getDate()+delta);return nd;})}
            style={S.btn({ border:"1.5px solid #e2e8f0", background:"#fff", color:"#475569", ...(window.innerWidth<768?{padding:"6px 10px",minWidth:36}:{}) })}>{lbl}</button>
        ))}
        <span style={{ fontSize:15, fontWeight:700, color:"#0f172a", marginLeft:4, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", minWidth:0 }}>{days[0].toLocaleDateString("en-NZ",{month:window.innerWidth<768?"short":"long",year:"numeric"})}</span>
        {window.innerWidth>=768&&<span style={{ fontSize:12, color:"#94a3b8", marginLeft:8 }}>Click or drag a day; drag across days for a grouped booking</span>}
      </div>
      <div style={{ overflowX:narrow?"hidden":"auto" }} ref={gridRef} onMouseLeave={()=>{ dragMoved.current=false; setDragState(null); }}>
        <div style={{ minWidth:narrow?0:680 }}>
          {/* Day headers */}
          <div style={{ display:"flex", marginLeft:axisW }}>
            {days.map(d=>{
              const dk=dateKey(d), isToday=dk===today;
              return (
                <div key={dk} style={{ flex:1, minWidth:0, textAlign:"center", padding:narrow?"4px 0 6px":"6px 0 10px" }}>
                  <div style={{ fontSize:narrow?10:11, fontWeight:600, color:"#94a3b8", textTransform:"uppercase", letterSpacing:narrow?0:"0.08em" }}>{d.toLocaleDateString("en-NZ",{weekday:"short"}).slice(0, narrow?2:3)}</div>
                  <div onClick={()=>onOpenDay&&onOpenDay(dk)} title="Open day view"
                    style={{ width:narrow?28:32, height:narrow?28:32, borderRadius:"50%", margin:"4px auto 0", background:isToday?"#0f172a":"transparent", display:"flex", alignItems:"center", justifyContent:"center", fontSize:15, fontWeight:isToday?700:500, color:isToday?"#fff":"#0f172a", cursor:onOpenDay?"pointer":"default" }}>{d.getDate()}</div>
                  {onOpenDay&&!narrow&&<button onClick={()=>onOpenDay(dk)} title="Open day view"
                    style={{ marginTop:3, fontSize:9, fontWeight:700, color:"#4f46e5", background:"#eef2ff", border:"1px solid #c7d2fe", borderRadius:6, padding:"1px 6px", cursor:"pointer", fontFamily:"inherit" }}>⤢ day</button>}
                </div>
              );
            })}
          </div>
          {/* Grid */}
          <div style={{ display:"flex" }}>
            {/* Hour labels — border-box so paddingTop doesn't inflate rows past HOUR_H
                (a 3px/hour drift that pushed labels progressively below their gridlines) */}
            {/* Sticky so the times stay in view while the days scroll sideways on a phone. */}
            <div style={{ width:axisW, flexShrink:0, position:"sticky", left:0, zIndex:4, background:"#fff" }}>
              {Array.from({length:CAL_TOTAL+1},(_,i)=>CAL_START+i).map(h=>(
                <div key={h} style={{ height:HOUR_H, boxSizing:"border-box", display:"flex", alignItems:"flex-start", justifyContent:"flex-end", paddingRight:narrow?4:8, paddingTop:3 }}>
                  <span style={{ fontSize:10, color:"#94a3b8", whiteSpace:"nowrap" }}>{narrow?fmtTimeShort(h):fmtTime(h)}</span>
                </div>
              ))}
            </div>
            {/* Day columns — drag handled at the container so a drag can cross days */}
            <div ref={colsRef} style={{ flex:1, display:"flex", position:"relative", cursor:dragState?.active?"crosshair":"crosshair" }}
              onMouseDown={gridDown} onMouseMove={gridMove} onMouseUp={gridUp}>
              {/* Cross-day / time drag preview spanning the selected columns × time band */}
              {dragSpan && (
                <div style={{ position:"absolute", zIndex:3, pointerEvents:"none",
                  left:`${dragSpan.loCol/days.length*100}%`, width:`${(dragSpan.hiCol-dragSpan.loCol+1)/days.length*100}%`,
                  top:dragSpan.loSlot*SLOT_H, height:(dragSpan.hiSlot-dragSpan.loSlot+1)*SLOT_H,
                  background:"rgba(99,102,241,0.15)", border:"2px solid rgba(99,102,241,0.5)", borderRadius:6 }}>
                  <div style={{ position:"absolute", top:4, left:6, fontSize:10, fontWeight:700, color:"#4f46e5", whiteSpace:"nowrap" }}>
                    {fmtTime(slotToHour(dragSpan.loSlot))} – {fmtTime(slotToHour(dragSpan.hiSlot+1))}{dragSpan.hiCol>dragSpan.loCol?` · ${dragSpan.hiCol-dragSpan.loCol+1} days`:""}
                  </div>
                </div>
              )}
              {days.map(d=>{
                const dk=dateKey(d);
                const dayBkgs=visible.filter(b=>b.date===dk);
                return (
                  <div key={dk}
                    style={{ flex:1, minWidth:0, position:"relative", borderLeft:"1px solid #f1f5f9" }}
                  >
                    {/* Hour cells */}
                    {Array.from({length:CAL_TOTAL},(_,i)=>i).map(i=>(
                      <div key={i} style={{ height:HOUR_H, boxSizing:"border-box", borderBottom:"1px solid #f1f5f9" }}>
                        <div style={{ height:"50%", borderBottom:"1px dashed #f5f5f5" }}/>
                      </div>
                    ))}
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
                          style={{ position:"absolute", top:(b.start_hour-CAL_START)*HOUR_H, height:Math.max(b.duration*HOUR_H-2,20), background:bkBg, borderRadius:narrow?4:6, padding:narrow?"2px 2px 2px 3px":"3px 6px", cursor:isDimmed?"default":"pointer", overflow:"hidden", opacity:isDimmed?dimOpacity:REVIEW_STATUSES.has(b.status)?0.75:1, pointerEvents:isDimmed?"none":"auto", border:deleteIds.has(b.id)?"2.5px solid #ef4444":cartSourceIds.has(b.id)?"2.5px solid #f59e0b":b.status==="clash"?"2px dashed #d97706":REVIEW_STATUSES.has(b.status)?`2px dashed ${bkTxt==="#fff"?"rgba(255,255,255,0.6)":"rgba(113,63,18,0.5)"}`:b.status==="rejected"?"2px solid rgba(244,63,94,0.8)":"none", boxShadow:deleteIds.has(b.id)?"0 0 0 3px rgba(239,68,68,0.25)":cartSourceIds.has(b.id)?"0 0 0 3px rgba(245,158,11,0.25)":"0 1px 4px rgba(0,0,0,0.15)", zIndex:2, borderLeft:bkBorderLeft, ...stk }}>
                          {!isAdmin_bk&&b.email&&!narrow&&(
                            <div style={{fontSize:9,fontWeight:700,color:bkTxt,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:3,opacity:0.92}}>
                              <span style={{width:6,height:6,borderRadius:"50%",background:ec,flexShrink:0,boxShadow:"0 0 0 1px rgba(255,255,255,0.4)",display:"inline-block"}}/>
                              {calAlias(b.email)}
                            </div>
                          )}
                          <div style={{display:"flex",alignItems:"center",gap:3,overflow:"hidden"}}>
                            {b.status==="cpsa_review_needed"&&<span style={{fontSize:9,flexShrink:0,lineHeight:1}}>⚠</span>}
                            {b.status==="cpsa_confirmed"&&<span style={{fontSize:9,flexShrink:0,lineHeight:1}}>🌐</span>}
                            {narrow&&!isAdmin_bk&&b.email&&<span style={{width:5,height:5,borderRadius:"50%",background:ec,flexShrink:0,display:"inline-block",alignSelf:"flex-start",marginTop:3}}/>}
                            <div style={{ fontSize:narrow?9:11, fontWeight:700, color:bkTxt, lineHeight:1.25, overflow:"hidden", textOverflow:narrow?"clip":"ellipsis", whiteSpace:"nowrap" }}>
                              {narrow ? (isAdmin_bk ? "GTEC" : initialsOf(calAlias(b.email)||b.name)) : b.purpose||b.name}
                            </div>
                          </div>
                          {!narrow&&b.duration*HOUR_H>22&&!isAdmin_bk&&<div style={{ fontSize:9, color:bkTxtMuted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", paddingLeft:0 }}>{b.name}</div>}
                          {!narrow&&b.duration*HOUR_H>32&&<div style={{display:"flex",alignItems:"center",gap:3,marginTop:1,paddingLeft:10}}>
                            {b.invoiced&&<span style={{fontSize:9,fontWeight:700,color:bkTxt==="#fff"?"rgba(255,255,255,0.9)":bkTxt,background:bkTxt==="#fff"?"rgba(124,58,237,0.5)":"rgba(124,58,237,0.15)",borderRadius:3,padding:"1px 4px",whiteSpace:"nowrap"}}>🧾</span>}
                          </div>}
                          {!narrow&&b.duration*HOUR_H>44&&<div style={{display:"flex",alignItems:"center",gap:4,paddingLeft:10,marginTop:1}}>
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
export function MonthCalendar({ bookings, onBookingClick, onNewBooking, onNewBookingRange, selectedFacility, loggedInEmail, isAdmin, onMultiDelete, onMultiAddToCart, cartSourceIds=new Set(), deleteIds=new Set(), cartNewDrafts=[], onOpenDay, onGotoWeek, bookerFilter=new Set(), aliasNames={}, emailAliases={} }) {
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
  const visible = (selectedFacility === "all" ? bookings.filter(b => inActiveVenue(b.facility_id)) : bookings.filter(b => b.facility_id === selectedFacility))
    .filter(b => !isClosed(b.status));

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

  // ── Multi-day drag-to-create (grouped booking) ──────────────────────────────
  // Press a day cell and drag across consecutive days to create one grouped booking
  // (one row per day) in the form. A plain click (no drag) creates a single booking.
  const [dragSel, setDragSel] = useState(null); // { anchor:dk, current:dk }
  const dragMovedRef = useRef(false);
  function dragRangeKeys(sel) {
    if (!sel) return [];
    const a = new Date(sel.anchor+"T00:00:00"), b = new Date(sel.current+"T00:00:00");
    const lo = a<b?a:b, hi = a<b?b:a, out = [];
    for (let d=new Date(lo); d<=hi; d.setDate(d.getDate()+1)) out.push(dateKey(new Date(d)));
    return out;
  }
  function startCellDrag(dk) {
    if (selMode || dk < today) return;
    dragMovedRef.current = false;
    setDragSel({ anchor:dk, current:dk });
  }
  function extendCellDrag(dk) {
    setDragSel(s => { if(!s||dk===s.current) return s; dragMovedRef.current=true; return {...s, current:dk}; });
  }
  function finishCellDrag() {
    if (dragSel) {
      const keys = dragRangeKeys(dragSel).filter(k => k >= today); // never create in the past
      if (keys.length > 1 && onNewBookingRange) onNewBookingRange(keys, 9, 1);
      else if (keys.length >= 1) onNewBooking(keys[0], 9, 1);
    }
    setDragSel(null);
    dragMovedRef.current = false;
  }
  const dragKeys = new Set(dragRangeKeys(dragSel));

  // Weeks of the displayed month, for the "Jump to week" buttons. One representative
  // date per grid row; jumping focuses the week view on that week.
  const weekRows = [];
  for (let i=0; i<cells.length; i+=7) {
    const fr = cells.slice(i, i+7).find(Boolean);
    if (fr) weekRows.push(fr);
  }

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
        {!selMode&&<span style={{fontSize:11,color:"#94a3b8",marginLeft:"auto"}}>Drag across days to create a grouped booking</span>}
      </div>

      {onGotoWeek&&(
        <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:12, flexWrap:"wrap" }}>
          <span style={{ fontSize:11, fontWeight:700, color:"#64748b", textTransform:"uppercase", letterSpacing:"0.04em" }}>Jump to week:</span>
          {weekRows.map((fr,wi)=>{
            const mon = getWeekDates(fr)[0];
            return (
              <button key={wi} onClick={()=>onGotoWeek(dateKey(fr))} title={`Open the week of ${mon.toLocaleDateString("en-NZ",{day:"numeric",month:"short"})} in week view`}
                style={{ border:"1.5px solid #c7d2fe", background:"#eef2ff", color:"#4338ca", borderRadius:8, padding:"4px 10px", fontSize:12, fontWeight:700, cursor:"pointer", fontFamily:"inherit" }}>
                📅 {mon.toLocaleDateString("en-NZ",{day:"numeric",month:"short"})}
              </button>
            );
          })}
        </div>
      )}

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
      <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:2 }}
        onMouseUp={finishCellDrag} onMouseLeave={()=>setDragSel(null)}>
        {cells.map((d,ci)=>{
          if (!d) return <div key={"p"+ci} style={{ minHeight:80, background:"#fafafa", borderRadius:6 }}/>;
          const dk=dateKey(d), isToday=dk===today, isPast=dk<today;
          const inDragRange=dragKeys.has(dk);
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
              onMouseDown={e=>{ if(e.button===0) startCellDrag(dk); }}
              onMouseEnter={e=>{ if(dragSel) extendCellDrag(dk); else if(!selMode&&!isPast) e.currentTarget.style.boxShadow="0 2px 8px rgba(0,0,0,0.08)"; }}
              onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}
              style={{ minHeight:80, background:inDragRange?"#e0e7ff":cellBg, border:inDragRange?"1.5px solid #6366f1":cellBorder, borderRadius:6, padding:"4px 4px 3px", cursor:selMode||isPast?"default":"pointer", overflow:"hidden", userSelect:"none" }}>
              <div onMouseDown={e=>e.stopPropagation()} onClick={e=>{ e.stopPropagation(); onGotoWeek&&onGotoWeek(dk); }} title="Open this day in week view"
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
                      onMouseDown={e=>e.stopPropagation()}
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
                {dayBkgs.length>3&&<div onMouseDown={e=>e.stopPropagation()} onClick={e=>{ e.stopPropagation(); onOpenDay&&onOpenDay(dk); }} title="View all bookings this day"
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
export function DayTimelinePopup({ date, bookings, onClose, onBookingClick, onNewBooking, cartNewDrafts=[], focusHour=null, focusDuration=null }) {
  const [dragState, setDragState] = useState(null); // {facility, startSlot, endSlot}
  // The time chosen in the week view: shown across every column, and a tap on a column (or a
  // "free" chip below) books it — no need to pick the time again.
  const carried = focusHour!=null && focusDuration ? (() => { const lo = Math.max(0, Math.round((focusHour-CAL_START)/SLOT_HOURS));
    return { lo, hi: Math.min(CAL_SLOTS-1, lo + Math.max(1, Math.round(focusDuration/SLOT_HOURS)) - 1) }; })() : null;
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
  const dayBkgs = bookings.filter(b=>b.date===dk && !isClosed(b.status));

  const yToSlot   = y => Math.max(0, Math.min(Math.floor(y/SLOT_H), CAL_SLOTS-1));
  const slotToHour= s => CAL_START + s*SLOT_HOURS;
  const norm = ds => ds ? { ...ds, lo:Math.min(ds.startSlot,ds.endSlot), hi:Math.max(ds.startSlot,ds.endSlot) } : null;

  function down(e, facId) {
    if (e.button!==0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const slot = yToSlot(e.clientY - rect.top);
    dragMoved.current = false;
    // Start every gesture clean. justDragged suppresses the click that follows a drag's
    // mouseup, but it was only ever cleared by a booking's own click handler — so a drag
    // ending on empty grid left it set, and the next click on a booking was swallowed
    // (bookings appeared unselectable until clicked twice).
    justDragged.current = false;
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
      // A tap inside the carried band selects the whole band for this facility.
      if (carried && ndUp.lo >= carried.lo && ndUp.lo <= carried.hi) setPendingSel({ facility:facId, lo:carried.lo, hi:carried.hi });
      else setPendingSel({ facility:facId, lo:ndUp.lo, hi:Math.min(ndUp.lo+SLOTS_PER_HOUR-1, CAL_SLOTS-1) });
    }
  }

  const nd = norm(dragState);

  // Every column should fit without sideways scrolling. An admin now sees eight
  // facilities across two grounds where there were five, which overflowed a 760px modal
  // at the old 96px minimum. Widen the dialog as columns are added and narrow the columns
  // themselves once there are more than six, so the whole day stays visible at a glance.
  const dayFacs   = venueFacilities();
  const dayColMin = dayFacs.length <= 5 ? 96 : dayFacs.length <= 6 ? 84 : 68;
  const dayModalW = Math.min(1060, 760 + Math.max(0, dayFacs.length - 5) * 70);
  const dayGridW  = 96 + dayFacs.length * dayColMin;   // an hour axis at each edge

  // The hour ruler, repeated on both sides. With eight columns the right-hand ones sit a
  // long way from a single left-hand ruler, so reading a block's time meant tracking back
  // across the whole grid. Rendered from one function rather than duplicated markup, so
  // the two can't drift apart. Both stay stuck to their own edge if the grid does scroll.
  const hourAxis = side => (
    <div style={{width:48,flexShrink:0,boxSizing:"border-box",position:"sticky",[side]:0,zIndex:6,background:"#fff",
      ...(side==="right" ? {borderLeft:"1px solid #f1f5f9"} : {})}}>
      <div style={{height:24,position:"sticky",top:0,zIndex:7,background:"#fff"}}/>
      {Array.from({length:CAL_TOTAL+1},(_,i)=>CAL_START+i).map(h=>(
        <div key={h} style={{height:HOUR_H,boxSizing:"border-box",display:"flex",alignItems:"flex-start",
          justifyContent:side==="right"?"flex-start":"flex-end",
          paddingLeft:side==="right"?6:0,paddingRight:side==="right"?0:6,paddingTop:3}}>
          <span style={{fontSize:10,color:"#94a3b8",whiteSpace:"nowrap"}}>{fmtTime(h)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <Modal title={`📅 ${dObj.toLocaleDateString("en-NZ",{weekday:"long",day:"numeric",month:"long",year:"numeric"})}`} onClose={onClose} width={dayModalW}>
      <div style={{fontSize:12,color:"#94a3b8",marginBottom:8}}>{carried
        ? <>Your time from the week view is selected — tap a free facility below (or its column) to book it, or drag a different time.</>
        : <>Click a booking — or its <strong>⤢</strong> handle — to view it · click or drag an empty area to select a time, then press Create booking.</>}</div>
      <div ref={scrollRef} style={{overflow:"auto",maxHeight:"60vh"}}>
        <div style={{display:"flex",minWidth:dayGridW}}>
          {hourAxis("left")}
          {/* Facility columns */}
          {venueFacilities().map(fac=>{
            const isDragging = dragState?.facility===fac.id;
            const colSel = (isDragging && nd) ? nd : (pendingSel?.facility===fac.id ? pendingSel : null);
            const colTint = FACILITY_TINT[fac.id] || "#fff";
            return (
              <div key={fac.id} style={{flex:1,minWidth:dayColMin}}>
                <div style={{height:24,boxSizing:"border-box",position:"sticky",top:0,zIndex:5,display:"flex",alignItems:"center",justifyContent:"center",gap:4,fontSize:10,fontWeight:700,color:fac.color,whiteSpace:"nowrap",overflow:"hidden",background:colTint,borderBottom:`2px solid ${fac.color}`}}>
                  <span style={{width:7,height:7,borderRadius:"50%",background:fac.color,flexShrink:0}}/>
                  {facColLabel(fac)}
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
                  {/* The time carried from the week view, in every column until one is picked */}
                  {carried && !pendingSel && !isDragging && (
                    <div style={{position:"absolute",left:2,right:2,top:carried.lo*SLOT_H,height:(carried.hi-carried.lo+1)*SLOT_H,background:"rgba(99,102,241,0.07)",border:"1.5px dashed rgba(99,102,241,0.45)",borderRadius:6,pointerEvents:"none",zIndex:2}}/>
                  )}
                  {/* Drag / staged-selection preview */}
                  {colSel && (
                    <div style={{position:"absolute",left:2,right:2,top:colSel.lo*SLOT_H,height:(colSel.hi-colSel.lo+1)*SLOT_H,background:"rgba(99,102,241,0.15)",border:"2px solid rgba(99,102,241,0.6)",borderRadius:6,pointerEvents:"none",zIndex:4}}>
                      <div style={{position:"absolute",top:2,left:4,fontSize:9,fontWeight:700,color:"#4f46e5"}}>{fmtTime(slotToHour(colSel.lo))}-{fmtTime(slotToHour(colSel.hi+1))}</div>
                    </div>
                  )}
                  {/* Booking blocks (only this facility's own, non-admin shown in colour; admin as grey background) */}
                  {layoutOverlapLanes(dayBkgs.filter(b=>b.facility_id===fac.id)).map(({booking:b, lane, lanes})=>{
                    const ec=emailColor(b.email);
                    const isAdmin_bk=isAdminBooking(b);
                    const isCpsa=b.status==="cpsa_confirmed"||b.status==="cpsa_review_needed";
                    const bg=isAdmin_bk?"#94a3b8":isCpsa?"#78909c":fac.color;
                    // Overlapping bookings share the column width instead of covering each other.
                    const wPct = 100/lanes;
                    const laneStyle = lanes>1
                      ? { left:`calc(${lane*wPct}% + 2px)`, width:`calc(${wPct}% - 4px)` }
                      : { left:3, right:3 };
                    return (
                      <div key={b.id}
                        onMouseDown={()=>{ downBooking.current = true; }}
                        onClick={e=>{ e.stopPropagation(); if(justDragged.current){ justDragged.current=false; return; } onBookingClick(b); }}
                        title={`${b.name} · ${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}${lanes>1?` · ${lanes} overlapping bookings`:""}`}
                        style={{position:"absolute",top:(b.start_hour-CAL_START)*HOUR_H,height:Math.max(b.duration*HOUR_H-2,18),...laneStyle,background:bg,borderRadius:6,padding:"2px 5px",cursor:"pointer",overflow:"hidden",opacity:REVIEW_STATUSES.has(b.status)?0.78:0.95,borderLeft:isAdmin_bk?undefined:`4px solid ${ec}`,zIndex:2,boxShadow:"0 1px 3px rgba(0,0,0,0.15)"}}>
                        <div style={{fontSize:10,fontWeight:700,color:"#fff",lineHeight:1.2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",paddingRight:15}}>{b.purpose||b.name}</div>
                        {b.duration*HOUR_H>30&&<div style={{fontSize:9,color:"rgba(255,255,255,0.85)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.name}</div>}
                        {/* Explicit handle: opens details on mousedown, so it works regardless of
                            the drag-vs-click heuristics the block itself depends on. */}
                        <button type="button" title="Inspect booking details"
                          onMouseDown={e=>{e.stopPropagation();e.preventDefault();onBookingClick(b);}}
                          style={{position:"absolute",top:1,right:1,width:14,height:14,padding:0,lineHeight:"12px",textAlign:"center",borderRadius:3,cursor:"pointer",zIndex:3,fontSize:9,fontFamily:"inherit",fontWeight:700,color:"#fff",background:"rgba(15,23,42,0.45)",border:"1px solid rgba(255,255,255,0.65)"}}>⤢</button>
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
          {hourAxis("right")}
        </div>
      </div>
      {carried && !pendingSel && (() => {
        const sH = slotToHour(carried.lo), eH = slotToHour(carried.hi+1), dur = +(eH-sH).toFixed(2);
        const free = venueFacilities().filter(f => !dayBkgs.some(b => b.facility_id===f.id && b.start_hour < eH && b.start_hour+b.duration > sH));
        return (
          <div style={{display:"flex",alignItems:"center",gap:8,marginTop:12,padding:"10px 14px",background:"#eef2ff",border:"1.5px solid #c7d2fe",borderRadius:10,flexWrap:"wrap"}}>
            <div style={{fontSize:13,color:"#0f172a"}}><strong>{fmtTime(sH)}–{fmtTime(eH)}</strong> <span style={{color:"#64748b"}}>({+dur.toFixed(1)}h) · {free.length?"free:":"nothing free — pick another time above"}</span></div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              {free.map(f=>(
                <button key={f.id} onClick={()=>onNewBooking(dk, sH, dur, f.id)} title={`Book ${f.name}, ${fmtTime(sH)}–${fmtTime(eH)}`}
                  style={S.btn({display:"inline-flex",alignItems:"center",gap:5,background:"#fff",color:"#0f172a",border:"1.5px solid #c7d2fe",fontSize:12,padding:"5px 10px"})}>
                  <span style={{width:8,height:8,borderRadius:"50%",background:f.color}}/>{facColLabel(f)}
                </button>
              ))}
            </div>
          </div>
        );
      })()}
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