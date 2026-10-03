import { useState, useRef, Fragment } from "react";
import { BILLED_RE, Badge, CAL_SLOTS, CAL_START, CAL_TOTAL, DAY_EVENING_CUTOFF, DURATIONS, EmailChip, FACILITIES, FACILITY_TINT, FLOODLIT_FIELD_ID, FacilityOptions, INVOICED_META, Modal, ProviderVenuePicker, REVIEW_STATUSES, S, SLOTS_PER_HOUR, SLOT_HOURS, START_TIMES, STATUS_META, addDays, councilContactOk, emailColor, facColLabel, facShort, fmtCost, fmtDate, fmtDuration, fmtLoggedAt, fmtRefDate, fmtTime, fmtTimeShort, getCrossFacilityOverlaps, getSameFacilityOverlaps, isAdminBooking, newGroupRef, newId, parseCouncilInfo, parseFunctionCost, parseGroupRef, parseGtecSnapshot, parseMismatchNote, parseSlotLink, parseSplit, setCouncilInfo, setFunctionCost, setGroupRef, setSplit, slotGroupMembers, slotGroupName, splitReason, stripMismatchNote, timeOverlaps, todayKey, useMobile, venueFacilities, workflowOf } from "./core.jsx";
import { OverlapWarning } from "./modals.jsx";
// ─── Single Booking Row Form ──────────────────────────────────────────────────
// Used inside BookingForm to represent one item in the cart
// onPick(facId,start,dur) fires immediately on release (single-pick / auto-complete).
// In `multi` mode, releases accumulate into a list across any facility column instead;
// onConfirm(picks) is called with all staged {facility_id,start_hour,duration} slots so
// the caller can create several separate bookings at once.
export function InlineDayPicker({ date, bookings, onPick, onConfirm, multi=false }) {
  const [drag, setDrag] = useState(null); // { startCol,endCol,startSlot,endSlot }
  const [picks, setPicks] = useState([]); // multi mode: staged slots across facilities
  const [inspect, setInspect] = useState(null); // booking whose details are expanded below
  // Roomier than the old half-hour grid so a quarter-hour slot stays comfortably
  // clickable (12px rather than the 7px a 28px hour would give). The picker sits in a
  // scrollable modal, so the extra height costs nothing but a little scrolling.
  const INLINE_HOUR_H = 48;
  const SH = INLINE_HOUR_H/SLOTS_PER_HOUR; // one slot's height
  const HEAD_H = 18;   // facility-header height above each column's grid
  const colsRef = useRef(null);
  const slotToHour = s => CAL_START + s*SLOT_HOURS;
  // Map a pointer event to a facility column + slot within the columns area.
  function geom(e) {
    const r = colsRef.current?.getBoundingClientRect();
    if (!r) return null;
    const col  = Math.max(0, Math.min(venueFacilities().length-1, Math.floor((e.clientX - r.left) / (r.width / venueFacilities().length))));
    const slot = Math.max(0, Math.min(Math.floor((e.clientY - r.top - HEAD_H) / SH), CAL_SLOTS-1));
    return { col, slot };
  }
  function gridDown(e) {
    if (e.button !== 0) return;
    const g = geom(e); if (!g) return;
    e.preventDefault();
    setDrag({ startCol:g.col, endCol:g.col, startSlot:g.slot, endSlot:g.slot });
  }
  function gridMove(e) {
    if (!drag) return;
    const g = geom(e); if (!g) return;
    if (g.col !== drag.endCol || g.slot !== drag.endSlot) setDrag(d => ({ ...d, endCol:g.col, endSlot:g.slot }));
  }
  function gridUp() {
    if (!drag) return;
    const loC = Math.min(drag.startCol,drag.endCol), hiC = Math.max(drag.startCol,drag.endCol);
    const loS = Math.min(drag.startSlot,drag.endSlot), hiS = Math.max(drag.startSlot,drag.endSlot);
    setDrag(null);
    const start_hour = slotToHour(loS), duration = Math.max(SLOT_HOURS, (hiS-loS+1)*SLOT_HOURS);
    if (multi) {
      // One pick per facility column the drag spans — same time in several fields at once.
      const added = [];
      for (let c=loC; c<=hiC; c++) added.push({ facility_id:FACILITIES[c].id, start_hour, duration });
      setPicks(ps => [...ps, ...added]);
    } else {
      onPick(FACILITIES[loC].id, start_hour, duration);
    }
  }
  function removePick(i) { setPicks(ps => ps.filter((_,k)=>k!==i)); }
  const span = drag ? {
    loC: Math.min(drag.startCol,drag.endCol), hiC: Math.max(drag.startCol,drag.endCol),
    loS: Math.min(drag.startSlot,drag.endSlot), hiS: Math.max(drag.startSlot,drag.endSlot),
  } : null;
  const dayBkgs = bookings.filter(b=>b.date===date && !["cancelled","rejected"].includes(b.status));
  return (
    <div style={{border:"1.5px solid #e2e8f0",borderRadius:8,background:"#fff",padding:8}}>
      <div style={{fontSize:11,color:"#64748b",marginBottom:6,display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
        <span style={{fontWeight:700,color:"#0f172a"}}>📅 Pick {multi?"slots":"a slot"}</span>
        <span>{multi?"Drag a slot — drag across columns to pick the same time in several fields. Each becomes a separate booking.":"Click or drag a column to set facility, start time and duration."}</span>
        <span style={{color:"#475569"}}>· Existing bookings stay click-through so you can book over them — tap <strong>⤢</strong> on one to see its details.</span>
        <span style={{color:"#b45309"}}>· 💡 Field #1 is the only floodlit field — its shaded daytime hours are a last resort; use another field during the day.</span>
      </div>
      <div style={{display:"flex",overflowX:"auto"}}>
        {/* Hour labels */}
        <div style={{width:36,flexShrink:0}}>
          <div style={{height:18}}/>
          {Array.from({length:CAL_TOTAL+1},(_,i)=>CAL_START+i).map(h=>(
            <div key={h} style={{height:INLINE_HOUR_H,fontSize:9,color:"#94a3b8",textAlign:"right",paddingRight:4}}>{fmtTime(h)}</div>
          ))}
        </div>
        <div ref={colsRef} style={{display:"flex",flex:1,position:"relative"}}
          onMouseDown={gridDown} onMouseMove={gridMove} onMouseUp={gridUp} onMouseLeave={()=>setDrag(null)}>
        {span&&(
          <div style={{position:"absolute",zIndex:5,pointerEvents:"none",
            left:`${span.loC/venueFacilities().length*100}%`, width:`${(span.hiC-span.loC+1)/venueFacilities().length*100}%`,
            top:HEAD_H+span.loS*SH, height:(span.hiS-span.loS+1)*SH,
            background:"rgba(99,102,241,0.20)",border:"1.5px solid #6366f1",borderRadius:4,
            display:"flex",alignItems:"flex-start",justifyContent:"center",fontSize:8,fontWeight:700,color:"#4338ca",paddingTop:1}}>
            {fmtTime(slotToHour(span.loS))}–{fmtTime(slotToHour(span.hiS+1))}{span.hiC>span.loC?` · ${span.hiC-span.loC+1} fields`:""}
          </div>
        )}
        {venueFacilities().map(fac=>{
          const facBkgs = dayBkgs.filter(b=>b.facility_id===fac.id);
          const colTint = FACILITY_TINT[fac.id] || "#fff";
          const isFloodlit = fac.id===FLOODLIT_FIELD_ID;
          // Daytime band (07:00 → cutoff) where the only floodlit field should be a last resort.
          const daylightH = Math.max(0, (DAY_EVENING_CUTOFF-CAL_START))*INLINE_HOUR_H;
          return (
            <div key={fac.id} style={{flex:1,minWidth:64}}>
              <div title={isFloodlit?`${fac.name} — only floodlit field; avoid daytime use (book only as a last resort)`:fac.name} style={{height:18,display:"flex",alignItems:"center",justifyContent:"center",gap:3,fontSize:9,fontWeight:700,color:fac.color,background:colTint,borderTopLeftRadius:4,borderTopRightRadius:4,borderBottom:`2px solid ${fac.color}`,overflow:"hidden",whiteSpace:"nowrap"}}>
                <span style={{width:6,height:6,borderRadius:"50%",background:fac.color,flexShrink:0}}/>
                {facColLabel(fac)}
                {isFloodlit&&<span title="Only floodlit field — avoid daytime use">💡</span>}
              </div>
              <div style={{position:"relative",cursor:"crosshair",background:colTint,height:CAL_TOTAL*INLINE_HOUR_H,borderLeft:"1px solid #f1f5f9"}}>
                {Array.from({length:CAL_TOTAL},(_,i)=>(
                  <div key={i} style={{height:INLINE_HOUR_H,borderBottom:"1px solid rgba(0,0,0,0.05)"}}>
                    <div style={{height:"50%",borderBottom:"1px dashed rgba(0,0,0,0.03)"}}/>
                  </div>
                ))}
                {isFloodlit&&daylightH>0&&(
                  <div title="Daylight hours — Field #1 is the only floodlit field. Use another field during the day; book here only as a last resort."
                    style={{position:"absolute",left:0,right:0,top:0,height:daylightH,pointerEvents:"none",zIndex:1,
                      background:"repeating-linear-gradient(45deg,rgba(217,119,6,0.13) 0 6px,rgba(217,119,6,0) 6px 12px)",
                      borderBottom:"1.5px dashed rgba(217,119,6,0.6)"}}>
                    <div style={{position:"sticky",top:0,fontSize:8,fontWeight:700,color:"#b45309",textAlign:"center",padding:"2px 1px",lineHeight:1.2}}>☀️ daylight — last resort</div>
                  </div>
                )}
                {facBkgs.map(b=>(
                  <Fragment key={b.id}>
                    <div title={`${b.name||"booking"} · ${fmtTime(b.start_hour)}`}
                      style={{position:"absolute",left:1,right:1,top:(b.start_hour-CAL_START)*INLINE_HOUR_H,height:Math.max(b.duration*INLINE_HOUR_H-1,12),background:fac.color,opacity:0.75,borderRadius:3,pointerEvents:"none",overflow:"hidden",fontSize:8,color:"#fff",padding:"1px 3px"}}>
                      {b.purpose?b.purpose.slice(0,18):""}
                    </div>
                    {/* The block itself stays click-through so a drag can run straight over it to
                        book an overlapping slot. This corner handle is the one hit target that
                        does respond — it expands the booking's details below the grid. Uses
                        mousedown (not click) so the grid's drag never starts underneath it. */}
                    <button type="button" title={`Inspect: ${b.purpose||b.name||"booking"} · ${fmtTime(b.start_hour)}–${fmtTime(b.start_hour+b.duration)}`}
                      onMouseDown={e=>{e.stopPropagation();e.preventDefault();setInspect(prev=>prev?.id===b.id?null:b);}}
                      style={{position:"absolute",right:1,top:(b.start_hour-CAL_START)*INLINE_HOUR_H+1,width:13,height:13,padding:0,lineHeight:"11px",textAlign:"center",borderRadius:3,cursor:"pointer",zIndex:3,pointerEvents:"auto",fontSize:8,fontFamily:"inherit",fontWeight:700,color:"#fff",background:inspect?.id===b.id?"rgba(15,23,42,0.9)":"rgba(15,23,42,0.45)",border:"1px solid rgba(255,255,255,0.65)"}}>⤢</button>
                  </Fragment>
                ))}
                {/* Staged picks (multi mode) — click a block to remove it */}
                {picks.map((p,pi)=>({p,pi})).filter(({p})=>p.facility_id===fac.id).map(({p,pi})=>(
                  <div key={"pick"+pi} title="Click to remove this slot"
                    onMouseDown={e=>{e.stopPropagation();e.preventDefault();removePick(pi);}}
                    style={{position:"absolute",left:1,right:1,top:(p.start_hour-CAL_START)*INLINE_HOUR_H,height:Math.max(p.duration*INLINE_HOUR_H-1,12),background:"rgba(99,102,241,0.85)",border:"1.5px solid #4338ca",borderRadius:4,cursor:"pointer",zIndex:4,overflow:"hidden",fontSize:8,fontWeight:700,color:"#fff",padding:"1px 3px",display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:2}}>
                    <span>{fmtTimeShort(p.start_hour)}</span><span>✕</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        </div>
      </div>
      {/* Expanded booking details. Rendered in normal flow below the grid rather than as a
          popover — the grid scrolls horizontally, which would clip an overlay. */}
      {inspect&&(()=>{
        const f=FACILITIES.find(x=>x.id===inspect.facility_id);
        const meta=STATUS_META[inspect.status];
        const rows=[
          ["Field", f?.name||inspect.facility_id],
          ["Time", `${fmtTime(inspect.start_hour)} – ${fmtTime(inspect.start_hour+inspect.duration)}`],
          ["Duration", fmtDuration(inspect.duration)],
          ["Purpose", inspect.purpose||"—"],
          ["Booked by", isAdminBooking(inspect) ? "GTEC (external)" : (inspect.name||"—")],
          ...(isAdminBooking(inspect) ? [] : [["Email", inspect.email||"—"]]),
          ...(inspect.created_at ? [["Created", fmtLoggedAt(inspect.created_at)]] : []),
        ];
        return (
          <div style={{marginTop:8,border:"1.5px solid #e2e8f0",borderRadius:8,background:"#f8fafc",padding:"8px 10px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6,flexWrap:"wrap"}}>
              <span style={{width:8,height:8,borderRadius:2,background:f?.color||"#94a3b8",display:"inline-block",flexShrink:0}}/>
              <span style={{fontSize:12,fontWeight:700,color:"#0f172a"}}>{inspect.purpose||inspect.name||"Booking"}</span>
              {meta&&<span style={{fontSize:10,fontWeight:700,color:meta.text,background:meta.bg,border:`1px solid ${meta.border}`,borderRadius:5,padding:"1px 6px"}}>{meta.label}</span>}
              <button onClick={()=>setInspect(null)} title="Close details"
                style={{marginLeft:"auto",border:"1px solid #e2e8f0",background:"#fff",color:"#64748b",cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:700,borderRadius:5,padding:"1px 7px"}}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:"2px 10px"}}>
              {rows.map(([k,v])=>(<Fragment key={k}>
                <span style={{fontSize:10,fontWeight:700,color:"#94a3b8",textTransform:"uppercase",letterSpacing:"0.04em",whiteSpace:"nowrap"}}>{k}</span>
                <span style={{fontSize:11,color:"#0f172a",wordBreak:"break-word"}}>{v}</span>
              </Fragment>))}
            </div>
          </div>
        );
      })()}
      {multi&&(
        <div style={{marginTop:8,borderTop:"1px solid #f1f5f9",paddingTop:8,display:"flex",flexWrap:"wrap",alignItems:"center",gap:6}}>
          {picks.length===0
            ? <span style={{fontSize:11,color:"#94a3b8"}}>No slots staged yet — drag in any field column to add one.</span>
            : picks.map((p,pi)=>{
                const f=FACILITIES.find(x=>x.id===p.facility_id);
                return (
                  <span key={pi} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,fontWeight:700,color:"#3730a3",background:"#eef2ff",border:"1px solid #c7d2fe",borderRadius:6,padding:"2px 6px"}}>
                    <span style={{width:7,height:7,borderRadius:2,background:f?.color||"#6366f1",display:"inline-block"}}/>
                    {facShort(p.facility_id)} {fmtTime(p.start_hour)}–{fmtTime(p.start_hour+p.duration)}
                    <button onClick={()=>removePick(pi)} title="Remove" style={{border:"none",background:"transparent",color:"#6366f1",cursor:"pointer",fontWeight:700,fontSize:12,lineHeight:1,padding:0}}>✕</button>
                  </span>
                );
              })}
          <div style={{marginLeft:"auto",display:"flex",gap:6}}>
            {picks.length>0&&<button onClick={()=>setPicks([])} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:12})}>Clear</button>}
            <button onClick={()=>onConfirm&&onConfirm(picks)} disabled={!picks.length}
              style={S.btn({background:picks.length?"#4338ca":"#cbd5e1",color:"#fff",fontSize:12,fontWeight:700,cursor:picks.length?"pointer":"not-allowed"})}>
              ✓ Add {picks.length||""} {picks.length===1?"booking":"bookings"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
// One slot (facility/date/time/duration) within a grouped booking request. Shared
// purpose / notes / repetition live on the parent form, so this row stays compact.
export function SlotRow({ slot, idx, onChange, onRemove, canRemove, allBookings }) {
  const isMobile = useMobile();
  const upd = (k,v) => onChange(idx, { ...slot, [k]:v });
  const facName = FACILITIES.find(f=>f.id===slot.facility_id)?.name || slot.facility_id;
  const ready = !!(slot.date && slot.facility_id && slot.duration);
  const draft = { id: slot.id||"__draft__", facility_id:slot.facility_id, date:slot.date, start_hour:slot.start_hour, duration:slot.duration, status:"pending_amua" };
  const others = ready ? allBookings.filter(b=>b.id!==draft.id && !["cancelled","rejected"].includes(b.status)) : [];
  const sameClashes = ready ? getSameFacilityOverlaps(draft, others) : [];
  const adminClashes = sameClashes.filter(isAdminBooking);
  const userClashes  = sameClashes.filter(b=>!isAdminBooking(b));
  const timeStr = `${fmtTime(slot.start_hour)}–${fmtTime(slot.start_hour+slot.duration)}`;
  return (
    <div style={{border:"1.5px solid #e2e8f0",borderRadius:10,padding:12,background:"#fafafa",display:"flex",flexDirection:"column",gap:8,position:"relative"}}>
      {canRemove && <button onClick={()=>onRemove(idx)} title="Remove slot" style={{position:"absolute",top:8,right:8,background:"#fff1f2",border:"1px solid #fda4af",borderRadius:6,color:"#f43f5e",cursor:"pointer",fontSize:12,fontWeight:700,padding:"1px 7px",lineHeight:1.5}}>✕</button>}
      <ProviderVenuePicker facilityId={slot.facility_id} onPick={id=>upd("facility_id",id)}/>
      <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"1.5fr 1.3fr 1fr 1fr",gap:8}}>
        <div>
          <label style={S.lbl}>Facility *</label>
          <select style={S.inp} value={slot.facility_id} onChange={e=>upd("facility_id",e.target.value)}>
            <FacilityOptions keepId={slot.facility_id}/>
          </select>
        </div>
        <div>
          <label style={S.lbl}>Date *</label>
          <input style={S.inp} type="date" value={slot.date} min={todayKey()} onChange={e=>upd("date",e.target.value)}/>
        </div>
        <div>
          <label style={S.lbl}>Start</label>
          <select style={S.inp} value={slot.start_hour} onChange={e=>upd("start_hour",parseFloat(e.target.value))}>
            {START_TIMES.map(h=><option key={h} value={h}>{fmtTime(h)}</option>)}
          </select>
        </div>
        <div>
          <label style={S.lbl}>Duration</label>
          <select style={S.inp} value={slot.duration} onChange={e=>upd("duration",parseFloat(e.target.value))}>
            {(DURATIONS.some(d=>d.value===slot.duration)?DURATIONS:[...DURATIONS,{value:slot.duration,label:slot.duration+" hrs"}].sort((a,b)=>a.value-b.value)).map(d=><option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </div>
      </div>
      {ready && (
        adminClashes.length>0
          ? <div style={{fontSize:12,color:"#b91c1c",fontWeight:600,display:"flex",alignItems:"center",gap:5}}><span style={{width:7,height:7,borderRadius:"50%",background:"#ef4444",display:"inline-block",flexShrink:0}}/>🚫 {facName} is blocked {timeStr} ({adminClashes[0].purpose||"facility block"})</div>
          : userClashes.length>0
          ? <div style={{fontSize:12,color:"#c2410c",fontWeight:600,display:"flex",alignItems:"center",gap:5}}><span style={{width:7,height:7,borderRadius:"50%",background:"#f59e0b",display:"inline-block",flexShrink:0}}/>⚠ {facName} overlaps {userClashes.length} booking{userClashes.length>1?"s":""} {timeStr} — shared use allowed</div>
          : <div style={{fontSize:12,color:"#16a34a",display:"flex",alignItems:"center",gap:5}}><span style={{width:7,height:7,borderRadius:"50%",background:"#22c55e",display:"inline-block",flexShrink:0}}/>{facName} available {timeStr} · {fmtDate(slot.date)}</div>
      )}
    </div>
  );
}

// ─── Multi-Edit Form ──────────────────────────────────────────────────────────
// Edits the shared start_time/duration across a set of same-weekday bookings.
// The new dates are calculated by keeping each booking's original calendar week
// but shifting to a new weekday if changed.
// ─── Cart Modal ───────────────────────────────────────────────────────────────
export function CartModal({ cart, setCart, onClose, onSubmit, openNew, silentMode=false, onToggleSilent }) {
  const [editingDraft, setEditingDraft] = useState(null); // {gi, di, draft}
  const [expandedNotify, setExpandedNotify] = useState(new Set()); // email keys that are open
  const totalNew    = cart.filter(i=>!i.isEdit&&!i.isMultiEdit&&!i.notifyOnly&&!i.statusChange).reduce((s,i)=>s+i.drafts.length,0);
  const totalEdits  = cart.filter(i=>i.isEdit||i.isMultiEdit).reduce((s,i)=>s+i.drafts.length,0);
  const totalStatus = cart.filter(i=>i.statusChange).reduce((s,i)=>s+(i.ids?.length||i.drafts?.length||0),0);
  const totalNotify = cart.filter(i=>i.notifyOnly&&!i.informCpsa&&!i.clashNotify&&!i.invoiceEmail).reduce((s,i)=>s+(i.drafts?.length||0),0);
  const totalInvoice = cart.filter(i=>i.invoiceEmail).reduce((s,i)=>s+(i.count||1),0);
  const totalSlot    = cart.filter(i=>i.slotChange).length;
  const totalClash  = cart.filter(i=>i.clashNotify).length;
  const totalInform = cart.filter(i=>i.informCpsa).reduce((s,i)=>s+(i.drafts?.length||0),0);
  // Group CPSA status notify-only items by booker email so the cart doesn't explode
  // into one row per booking. Status-change, clash and inform-CPSA items are rendered
  // separately below (clash/inform have no drafts to group).
  const notifyByEmail = {};
  cart.forEach((item, gi) => {
    if (item.slotChange) return;
    if (!item.notifyOnly || item.informCpsa || item.clashNotify || item.invoiceEmail) return;
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

  // Group drafts for compact display: first by a shared group id (any grouped variant —
  // recurrence / multi-day / multi-facility), then fall back to the legacy weekly
  // heuristic (consecutive weekly drafts with same facility/time) for untagged drafts.
  function groupDrafts(drafts) {
    const groups = [];
    let i = 0;
    while(i < drafts.length) {
      const d = drafts[i];
      const gid = parseGroupRef(d.system_notes);
      if(gid) {
        let j = i+1;
        while(j < drafts.length && parseGroupRef(drafts[j].system_notes) === gid) j++;
        groups.push({type:'group', drafts:drafts.slice(i,j), startIdx:i});
        i = j; continue;
      }
      let j = i+1;
      while(j < drafts.length) {
        const next = drafts[j];
        if(parseGroupRef(next.system_notes)) break;
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
              {[totalNew>0&&`${totalNew} new booking${totalNew>1?'s':''}`, totalEdits>0&&`${totalEdits} edit${totalEdits>1?'s':''}`, totalStatus>0&&`${totalStatus} status change${totalStatus>1?'s':''}`, totalClash>0&&`${totalClash} clash alert${totalClash>1?'s':''}`, totalNotify>0&&`${totalNotify} GTEC notification${totalNotify>1?'s':''}`, totalInform>0&&`${totalInform} Inform-GTEC email${totalInform>1?'s':''}`, totalInvoice>0&&`${totalInvoice} invoice email${totalInvoice>1?'s':''}`, totalSlot>0&&`${totalSlot} shared-slot change${totalSlot>1?'s':''}`].filter(Boolean).join(' · ')} ready to submit.
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
                      if(g.type==='recur'||g.type==='group') {
                        const first=g.drafts[0];
                        const f=FACILITIES.find(x=>x.id===first.facility_id);
                        const n=g.drafts.length;
                        const uniform=g.drafts.every(x=>x.facility_id===first.facility_id&&x.start_hour===first.start_hour&&x.duration===first.duration);
                        const facs=[...new Set(g.drafts.map(x=>x.facility_id))];
                        const dates=g.drafts.map(x=>x.date).filter(Boolean).sort();
                        const label=g.type==='recur'?`🔁 ${n}× weekly`:uniform?`🔁 ${n}× repeat`:`🔗 ${n} grouped`;
                        return (
                          <div key={gi2} style={{background:'#f0fdf4',borderBottom:'1px solid #e2e8f0',padding:'10px 14px'}}>
                            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:4}}>
                              <span style={{width:8,height:8,borderRadius:'50%',background:facs.length===1?f?.color:'#16a34a',flexShrink:0,display:'inline-block'}}/>
                              <span style={{fontSize:11,fontWeight:700,color:'#16a34a',background:'#dcfce7',border:'1px solid #bbf7d0',borderRadius:4,padding:'1px 7px'}}>{label}</span>
                              <span style={{fontSize:12,fontWeight:600,color:'#0f172a',flex:1}}>{facs.length===1?f?.name:`${facs.length} fields`}</span>
                            </div>
                            <div style={{fontSize:12,color:'#64748b',paddingLeft:16}}>
                              {fmtDate(dates[0])} → {fmtDate(dates[dates.length-1])}{uniform?` · ${fmtTime(first.start_hour)}–${fmtTime(first.start_hour+first.duration)}`:''} · {first.purpose}
                            </div>
                            <div style={{paddingLeft:16,marginTop:6,display:'flex',flexDirection:'column',gap:3}}>
                              {g.drafts.map((d,k)=>{
                                const di = g.startIdx+k;
                                const isEditing2 = editingDraft?.gi===gi && editingDraft?.di===di;
                                const df=FACILITIES.find(x=>x.id===d.facility_id);
                                return (
                                  <div key={k} style={{display:'flex',alignItems:'center',gap:6}}>
                                    {isEditing2 ? (
                                      <InlineDraftEditor draft={d} onSave={p=>updateDraft(gi,di,p)} onCancel={()=>setEditingDraft(null)}/>
                                    ) : (
                                      <>
                                        <span style={{fontSize:11,color:'#64748b',flex:1}}>{fmtDate(d.date)}{uniform?'':` · ${facShort(df?.id||d.facility_id)} ${fmtTime(d.start_hour)}–${fmtTime(d.start_hour+d.duration)}`}</span>
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

              {/* Shared-slot changes — a split creates a booking, a merge or unlink only
                  relinks existing ones, so the row spells out which. */}
              {cart.map((item,gi)=>{
                if(!item.slotChange) return null;
                const tone = item.kind==="share" ? {bd:"#7dd3fc",bg:"#f0f9ff",fg:"#0369a1",tag:"👥 Share slot"}
                          : item.kind==="merge" ? {bd:"#ddd6fe",bg:"#f5f3ff",fg:"#6d28d9",tag:"🔗 Merge slot"}
                          : {bd:"#fecaca",bg:"#fef2f2",fg:"#b91c1c",tag:"✂ Unshare slot"};
                return (
                  <div key={'slot-'+gi} style={{border:`1.5px solid ${tone.bd}`,borderRadius:12,overflow:'hidden'}}>
                    <div style={{background:tone.bg,padding:'10px 14px',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <span style={{fontSize:11,fontWeight:700,color:tone.fg,background:'#fff',border:`1px solid ${tone.bd}`,borderRadius:4,padding:'1px 7px'}}>{tone.tag}</span>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a',flex:1}}>{item.label}</span>
                      <button onClick={()=>removeItem(gi)} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:15,padding:'2px 4px',lineHeight:1}}>✕</button>
                    </div>
                    <div style={{padding:'8px 14px',fontSize:12,color:'#64748b',background:'#fff'}}>
                      {item.detail}
                      {item.newBooking&&<span style={{marginLeft:8,color:'#0369a1',fontWeight:600}}>· creates 1 booking</span>}
                    </div>
                  </div>
                );
              })}
              {/* Queued invoice emails — the document is already rendered; this is the
                  outbox row for it. */}
              {cart.map((item,gi)=>{
                if(!item.invoiceEmail) return null;
                return (
                  <div key={'inv-'+gi} style={{border:`1.5px solid ${item.preview?'#fde68a':'#7dd3fc'}`,borderRadius:12,overflow:'hidden'}}>
                    <div style={{background:item.preview?'#fffbeb':'#f0f9ff',padding:'10px 14px',display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
                      <EmailChip email={item.email}/>
                      <span style={{fontSize:13,fontWeight:600,color:'#0f172a',flex:1}}>{item.name}</span>
                      <span style={{fontSize:11,fontWeight:700,color:item.preview?'#92400e':'#0369a1',background:item.preview?'#fef3c7':'#e0f2fe',border:`1px solid ${item.preview?'#fcd34d':'#7dd3fc'}`,borderRadius:4,padding:'1px 7px'}}>
                        {item.amuaDraft?'✉ Draft to AMUA inbox':item.preview?'📄 Invoice preview':'🧾 Official invoice'}
                      </span>
                      <button onClick={()=>removeItem(gi)} title="Remove" style={{background:'none',border:'none',cursor:'pointer',color:'#f43f5e',fontSize:15,padding:'2px 4px',lineHeight:1}}>✕</button>
                    </div>
                    <div style={{padding:'8px 14px',fontSize:12,color:'#64748b',background:'#fff',display:'flex',gap:10,flexWrap:'wrap'}}>
                      <span>{item.count||1} document{(item.count||1)!==1?'s':''}</span>
                      <span style={{fontFamily:'monospace',color:'#475569'}}>{(item.refs||[]).join(', ')}</span>
                      <span style={{marginLeft:'auto',fontWeight:700,color:'#0f172a'}}>{fmtCost(item.total||0)}</span>
                    </div>
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
                  <div>{silentMode?'Submitting applies changes/removals but sends no emails.':"Bookers are emailed when you submit; anything for vendors, facilities or the council goes to AMUA's inbox as a draft."}</div>
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

export function InlineDraftEditor({ draft, onSave, onCancel }) {
  const [facility, setFacility] = useState(draft.facility_id);
  const [date,     setDate]     = useState(draft.date);
  const [hour,     setHour]     = useState(draft.start_hour);
  const [dur,      setDur]      = useState(draft.duration);
  const [purpose,  setPurpose]  = useState(draft.purpose);
  return (
    <div style={{background:'#f0f4ff',border:'1.5px solid #c7d2fe',borderRadius:8,padding:'10px 12px',display:'flex',flexDirection:'column',gap:8}}>
      <ProviderVenuePicker facilityId={facility} onPick={setFacility} small/>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
        <div>
          <label style={S.lbl}>Facility</label>
          <select style={{...S.inp,fontSize:12}} value={facility} onChange={e=>setFacility(e.target.value)}>
            <FacilityOptions keepId={facility}/>
          </select>
        </div>
        <div>
          <label style={S.lbl}>Date</label>
          <input style={{...S.inp,fontSize:12}} type="date" value={date} onChange={e=>setDate(e.target.value)}/>
        </div>
        <div>
          <label style={S.lbl}>Start Time</label>
          <select style={{...S.inp,fontSize:12}} value={hour} onChange={e=>setHour(parseFloat(e.target.value))}>
            {START_TIMES.map(h=><option key={h} value={h}>{fmtTime(h)}</option>)}
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

export function DeleteCartModal({ deleteQueue, setDeleteQueue, onClose, onSubmit, isAdmin, silentMode=false, onToggleSilent }) {
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

export function MultiEditForm({ bookings: srcBookings, onAddToCart, onClose, allBookings }) {
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
            {START_TIMES.map(h=><option key={h} value={h}>{fmtTime(h)}</option>)}
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


export function BookingForm({ booking, allBookings, onAddToCart, onClose, isAdmin, loggedInEmail, bookers=[], onEditContact }) {
  const isMobile = useMobile();
  const isEditing  = !!booking?.id && !booking?._multiEdit;
  const isMultiEdit = !!booking?._multiEdit;

  // A slot is just facility/date/time/duration — shared purpose/notes/repetition live
  // on the form, so creating several grouped bookings means staging several slots.
  function blankSlot(o={}) {
    return { facility_id:(venueFacilities()[0]||FACILITIES[0]).id, date:todayKey(), start_hour:9, duration:1, ...o };
  }
  const initSlots = isEditing
    ? [{ id:booking.id, facility_id:booking.facility_id, date:booking.date, start_hour:booking.start_hour, duration:booking.duration }]
    : (booking && Array.isArray(booking._dates) && booking._dates.length
        ? booking._dates.map(dt => blankSlot({ facility_id:booking.facility_id||(venueFacilities()[0]||FACILITIES[0]).id, date:dt, start_hour:booking.start_hour||9, duration:booking.duration||1 }))
        : booking && booking.date && !isMultiEdit
          ? [blankSlot({ facility_id:booking.facility_id||(venueFacilities()[0]||FACILITIES[0]).id, date:booking.date, start_hour:booking.start_hour||9, duration:booking.duration||1 })]
          : []);

  const [name,  setName]  = useState(booking?.name  || "");
  const [email, setEmail] = useState(booking?.email || loggedInEmail || "");
  const [purpose, setPurpose] = useState(booking?.purpose || "");
  const [notes,   setNotes]   = useState(booking?.notes || "");
  const [status,  setStatus]  = useState(booking?.status || "pending_amua");
  const [recurMode,  setRecurMode]  = useState("none");
  const [recurWeeks, setRecurWeeks] = useState(4);
  const [recurUntil, setRecurUntil] = useState("");
  const [slots, setSlots] = useState(initSlots);
  // Council application details (council fields only): see parseCouncilInfo.
  const ci0 = parseCouncilInfo(booking?.system_notes) || {};
  const [cPlayers, setCPlayers] = useState(ci0.players ? String(ci0.players) : "");
  const [cUse, setCUse]         = useState(ci0.use || "training");
  const [cGrade, setCGrade]     = useState(ci0.grade || "");
  const [cNotes, setCNotes]     = useState(ci0.notes || "");
  const hasCouncil = slots.some(sl => { const f = FACILITIES.find(x => x.id === sl.facility_id); return f?.council && f.council.kind !== "community"; });
  const [pickDate, setPickDate] = useState(initSlots[0]?.date || todayKey());
  const [showPicker, setShowPicker] = useState(false);
  const [error, setError] = useState("");
  const [warn,  setWarn]  = useState(null);

  // ── Multi-edit mode: simple time/weekday change across multiple bookings ──
  if (isMultiEdit) {
    return <MultiEditForm bookings={booking._bookings} onAddToCart={onAddToCart} onClose={onClose} allBookings={allBookings}/>;
  }

  function updateSlot(idx, patch) { setSlots(ss=>ss.map((s,i)=>i===idx?patch:s)); }
  function removeSlot(idx) { setSlots(ss=>ss.filter((_,i)=>i!==idx)); }
  // New manual slots inherit the previous slot's field/time/duration (propagate details).
  function addManualSlot() {
    const last = slots[slots.length-1];
    setSlots(ss=>[...ss, blankSlot({ date:pickDate, facility_id:last?.facility_id||(venueFacilities()[0]||FACILITIES[0]).id, start_hour:last?.start_hour??9, duration:last?.duration??1 })]);
  }
  function addPickedSlots(picks) {
    if (picks?.length) setSlots(ss=>[...ss, ...picks.map(p=>blankSlot({ facility_id:p.facility_id, date:pickDate, start_hour:p.start_hour, duration:p.duration }))]);
    setShowPicker(false);
  }

  // Occurrences a slot expands into under the shared repetition rule.
  function occurrencesFor(dateStr) {
    if (isEditing || recurMode==="none") return 1;
    if (recurMode==="weeks") return Math.max(1, recurWeeks);
    if (recurMode==="until" && recurUntil && dateStr) {
      const [sy,sm,sd]=dateStr.split("-").map(Number), [ey,em,ed]=recurUntil.split("-").map(Number);
      const diff=Math.round((Date.UTC(ey,em-1,ed)-Date.UTC(sy,sm-1,sd))/(7*86400000));
      return Math.max(1, diff+1);
    }
    return 1;
  }
  const totalToCreate = slots.reduce((s,sl)=>s+occurrencesFor(sl.date), 0);

  // Expand each slot (+ shared repetition) into individual booking drafts. Shared
  // purpose/notes propagate onto every draft.
  function expandRows() {
    const drafts = [];
    slots.forEach(slot => {
      const base = { facility_id:slot.facility_id, date:slot.date, start_hour:slot.start_hour, duration:slot.duration,
        purpose, notes, status:isEditing?status:"pending_amua", name, email,
        id:newId(), created_at:new Date().toISOString(), updated_at:new Date().toISOString() };
      const fc = FACILITIES.find(f => f.id === slot.facility_id)?.council;
      if (fc && fc.kind !== "community")
        base.system_notes = setCouncilInfo(isEditing ? booking.system_notes : base.system_notes,
          { players: parseInt(cPlayers, 10) || null, use: cUse, ...(cGrade.trim() ? { grade: cGrade.trim() } : {}), ...(cNotes.trim() ? { notes: cNotes.trim() } : {}) });
      drafts.push(base);
      if (!isEditing && recurMode!=="none") {
        const maxAdditional = recurMode==="weeks" ? recurWeeks-1 : 103; // 103 = safety cap for "until"
        let currentDate = slot.date;
        for (let w=0; w<maxAdditional; w++) {
          currentDate = addDays(currentDate, 7);
          if (recurMode==="until" && currentDate > recurUntil) break;
          drafts.push({ ...base, id:newId(), date:currentDate });
        }
      }
    });
    if (isEditing && drafts.length === 1) drafts[0].id = booking.id;
    // Tag multi-slot submissions (multi-day / multi-facility / mixed) with a shared group
    // id so the cart and summary present them as one group — the same treatment weekly
    // recurrences get. A single slot's weekly recurrence keeps its existing weekday-pattern
    // grouping (untagged), so that presentation is preserved.
    if (!isEditing && slots.length > 1) {
      const gid = newGroupRef();
      drafts.forEach(d => { d.system_notes = setGroupRef(d.system_notes, gid); });
    }
    return drafts;
  }

  function validate() {
    if (!name.trim()) { setError("Please enter your name."); return false; }
    if (!/\S+@\S+\.\S+/.test(email)) { setError("Please enter a valid email."); return false; }
    if (!purpose.trim()) { setError("Please enter a purpose for the booking."); return false; }
    if (slots.length === 0) { setError("Add at least one slot — pick on the day grid or add one manually."); return false; }
    for (let i=0; i<slots.length; i++) {
      if (!slots[i].facility_id || !slots[i].date) { setError(`Slot #${i+1}: choose a facility and date.`); return false; }
    }
    // Council fields: the booker is the key holder on AMUA's council application, so their
    // name and phone must be on file first.
    if (slots.some(sl => FACILITIES.find(f => f.id === sl.facility_id)?.council) && !councilContactOk(email)) {
      setError(`Council fields need the booker's contact details — they're listed as the key holder on the council application. Use "📇 Fill in council contact" below (or User menu → 📇 My council contact).`);
      return false;
    }
    if (hasCouncil && !(parseInt(cPlayers, 10) > 0)) { setError("Council application details: enter how many players you expect (the council asks for participant numbers)."); return false; }
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

  const addBtn = { border:"1.5px solid #6366f1", background:"#eef2ff", color:"#4338ca", fontSize:13, padding:"8px 14px", fontWeight:700 };

  // Main form — shared details first, then the staged slots.
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
          {/* An admin books on behalf of clubs, so the field is a roster they can pick
              from (and still type into for someone new). Everyone else stays locked to
              their own login. */}
          {isAdmin ? (()=>{
            // Chips rather than a dropdown: the admin books for the same handful of clubs
            // constantly, so they should be one tap in the booker's own colour. The admin's
            // own address leads and is the default; the field stays editable for someone new.
            const adminEmail = (loggedInEmail||"").toLowerCase();
            const rosterFor = e => bookers.find(bk => bk.email === e);
            const chips = [
              ...(adminEmail ? [{ email: adminEmail, name: rosterFor(adminEmail)?.name || "AMUA", self: true }] : []),
              ...bookers.filter(bk => bk.email !== adminEmail),
            ];
            const current = email.trim().toLowerCase();
            const pick = bk => {
              setEmail(bk.email);
              // A booker already in the roster fills their name too; for an address with
              // no bookings yet the name field is left for the admin to type.
              const r = rosterFor(bk.email);
              if (r) setName(r.name);
            };
            return (<>
              <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:6}}>
                {chips.map(bk=>{
                  const active = current === bk.email;
                  const c = emailColor(bk.email);
                  return (
                    <button key={bk.email} type="button" onClick={()=>pick(bk)} title={bk.email}
                      style={{display:"inline-flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:999,
                        border:`1.5px solid ${active?c:c+"44"}`,background:active?c:c+"18",color:active?"#fff":c,
                        fontSize:11,fontWeight:700,fontFamily:"inherit",cursor:"pointer",whiteSpace:"nowrap",
                        boxShadow:active?`0 0 0 2px ${c}33`:"none"}}>
                      <span style={{width:6,height:6,borderRadius:"50%",background:active?"#fff":c,display:"inline-block",flexShrink:0}}/>
                      {bk.name}{bk.self?" (you)":""}
                    </button>
                  );
                })}
              </div>
              <input style={S.inp} type="email" value={email}
                onChange={e=>{
                  const v = e.target.value;
                  setEmail(v);
                  const hit = rosterFor(v.trim().toLowerCase());
                  if (hit) setName(hit.name);
                }}
                placeholder="…or type a new booker's email"/>
              <div style={{fontSize:11,color:"#0369a1",marginTop:3}}>
                {current && current !== adminEmail
                  ? `👤 Booking on behalf of ${rosterFor(current)?.name || email}`
                  : "Pick a booker to book on their behalf — defaults to you"}
              </div>
            </>);
          })() : (<>
            <input style={{...S.inp,background:loggedInEmail?"#f0fdf4":S.inp.background}} type="email" value={email} readOnly={!!loggedInEmail} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com"/>
            {loggedInEmail&&<div style={{fontSize:11,color:"#16a34a",marginTop:3}}>✓ Pre-filled from your login</div>}
          </>)}
        </div>
      </div>

      {/* Shared purpose + notes — one of each for the whole grouped booking */}
      <div>
        <label style={S.lbl}>Purpose *</label>
        <input style={S.inp} value={purpose} onChange={e=>setPurpose(e.target.value)} placeholder="e.g. Training, Meeting…"/>
      </div>
      <div>
        <label style={S.lbl}>Notes</label>
        <textarea style={{...S.inp,resize:"vertical",minHeight:48}} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Any requirements… (applies to all slots)"/>
      </div>

      {/* Council fields: what AMUA's council application needs from the booker. */}
      {hasCouncil && (() => {
        const okC = councilContactOk(email);
        const half = { flex:"1 1 200px", minWidth:0 };
        return (
          <div style={{border:"1.5px solid #99f6e4",background:"#f0fdfa",borderRadius:10,padding:"10px 12px",display:"flex",flexDirection:"column",gap:8}}>
            <div style={{fontWeight:700,fontSize:13,color:"#115e59"}}>🏛 Council application details</div>
            <div style={{fontSize:12,color:"#475569"}}>AMUA applies to the council for this field and names you and your team on the application. Fields marked * are required.</div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",fontSize:13}}>
              <span>📇 Key holder (your council contact) *: {okC ? <b style={{color:"#15803d"}}>✓ on file</b> : <b style={{color:"#b91c1c"}}>missing — name and phone needed</b>}</span>
              {onEditContact && <button type="button" onClick={()=>onEditContact(email)} style={S.btn({padding:"4px 10px",fontSize:12,background:okC?"#fff":"#0d9488",color:okC?"#0f766e":"#fff",border:"1.5px solid #0d9488"})}>{okC ? "Edit council contact" : "📇 Fill in council contact"}</button>}
            </div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              <label style={{...S.lbl,...half}}>Players expected *
                <input style={S.inp} type="number" min="1" max="200" value={cPlayers} onChange={e=>setCPlayers(e.target.value)} placeholder="e.g. 14"/></label>
              <label style={{...S.lbl,...half}}>Use *
                <select style={{...S.inp,background:"#fff"}} value={cUse} onChange={e=>setCUse(e.target.value)}>
                  <option value="training">Training</option><option value="competition">Competition / games</option></select></label>
            </div>
            <label style={S.lbl}>Grade / level <span style={{textTransform:"none",fontWeight:400}}>(optional)</span>
              <input style={S.inp} value={cGrade} onChange={e=>setCGrade(e.target.value)} placeholder="e.g. Social mixed, open grade"/></label>
            <label style={S.lbl}>Notes for the council <span style={{textTransform:"none",fontWeight:400}}>(optional)</span>
              <input style={S.inp} value={cNotes} onChange={e=>setCNotes(e.target.value)} placeholder="e.g. lights needed after 6pm"/></label>
          </div>);
      })()}

      {/* Admin status (edit only) */}
      {isAdmin && isEditing && (
        <div>
          <label style={S.lbl}>Status</label>
          <select style={S.inp} value={status} onChange={e=>setStatus(e.target.value)}>
            {Object.entries(STATUS_META).filter(([k])=>!["pending","amua_submit"].includes(k)).map(([k,v])=><option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      )}

      {/* Shared repetition (new bookings only) */}
      {!isEditing && (
        <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:12}}>
          <label style={{...S.lbl,color:"#16a34a"}}>🔁 Repetition (applies to every slot)</label>
          <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
            <select style={{...S.inp,width:"auto"}} value={recurMode} onChange={e=>setRecurMode(e.target.value)}>
              <option value="none">No repetition</option>
              <option value="weeks">Repeat for N weeks</option>
              <option value="until">Repeat until date</option>
            </select>
            {recurMode==="weeks" && (
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <input type="number" min={1} max={52} value={recurWeeks} onChange={e=>setRecurWeeks(parseInt(e.target.value)||1)} style={{...S.inp,width:70}}/>
                <span style={{fontSize:13,color:"#475569"}}>weeks</span>
              </div>
            )}
            {recurMode==="until" && (
              <input type="date" value={recurUntil} min={pickDate||todayKey()} onChange={e=>setRecurUntil(e.target.value)} style={{...S.inp,width:"auto"}}/>
            )}
          </div>
          {recurMode!=="none" && <div style={{fontSize:12,color:"#16a34a",marginTop:6}}>Each slot repeats weekly on its own day/time.</div>}
        </div>
      )}

      {/* Slots */}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <span style={{fontSize:12,fontWeight:700,color:"#0f172a",textTransform:"uppercase",letterSpacing:"0.05em"}}>Slots ({slots.length})</span>
          {!isEditing && (
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginLeft:"auto"}}>
              <label style={{fontSize:11,color:"#64748b",display:"flex",alignItems:"center",gap:5}}>Day
                <input type="date" value={pickDate} min={todayKey()} onChange={e=>setPickDate(e.target.value)} style={{...S.inp,width:"auto",padding:"6px 8px",fontSize:12}}/>
              </label>
              <button type="button" onClick={()=>setShowPicker(true)} title="Pick one or more slots on the day grid" style={S.btn(addBtn)}>📅 Pick on day grid</button>
              <button type="button" onClick={addManualSlot} style={S.btn({border:"1.5px solid #cbd5e1",background:"#fff",color:"#475569",fontSize:13,padding:"8px 14px",fontWeight:700})}>✏ Add manually</button>
            </div>
          )}
        </div>

        {showPicker && (
          <Modal title={`📅 Pick slots — ${pickDate?fmtDate(pickDate):"choose a day"}`} onClose={()=>setShowPicker(false)} width={760}>
            {pickDate
              ? <InlineDayPicker date={pickDate} bookings={allBookings} multi onConfirm={addPickedSlots} onPick={(f,s,d)=>addPickedSlots([{facility_id:f,start_hour:s,duration:d}])}/>
              : <div style={{padding:24,textAlign:"center",color:"#94a3b8",fontSize:13}}>Choose a day first.</div>}
            <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
              <button onClick={()=>setShowPicker(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:12})}>Close</button>
            </div>
          </Modal>
        )}

        {slots.length === 0
          ? <div style={{border:"1.5px dashed #cbd5e1",borderRadius:10,padding:"22px 16px",textAlign:"center",color:"#64748b",fontSize:13,background:"#f8fafc"}}>
              No slots yet — <strong>Pick on day grid</strong> (select across any fields) or <strong>Add manually</strong>.
            </div>
          : slots.map((slot,i)=>(
              <SlotRow key={i} slot={slot} idx={i} onChange={updateSlot} onRemove={removeSlot} canRemove={!isEditing} allBookings={allBookings}/>
            ))}
      </div>

      <div style={{display:"flex",gap:10,justifyContent:"flex-end",alignItems:"center",paddingTop:4}}>
        {!isEditing && slots.length>0 && <span style={{fontSize:12,color:"#64748b",marginRight:"auto"}}>Will create <strong style={{color:"#0f172a"}}>{totalToCreate}</strong> booking{totalToCreate!==1?"s":""}</span>}
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
        <button onClick={handleAddToCart} style={S.btn({background:"#2d4a1e",color:"#fff"})}>
          {isEditing ? "✏ Add Edit to Cart" : "➕ Add to Cart"}
        </button>
      </div>
    </div>
  );
}

// ─── Booking Detail ───────────────────────────────────────────────────────────
export function BookingDetail({booking,onEdit,onClose,onCancel,isAdmin,onStatusChange,onPatch,loggedInEmail,allClashes=[],bookers=[],onConvertAdmin,allBookings=[],onShareSlot,onMergeSlot,onUnlinkSlot}) {
  const f=FACILITIES.find(x=>x.id===booking.facility_id);
  const m=STATUS_META[booking.status]||STATUS_META.pending;
  const isPast = booking.date < todayKey();
  const isOwn  = booking.email?.toLowerCase() === loggedInEmail?.toLowerCase();
  const isAdminBk = isAdminBooking(booking);
  const [shareEmail,setShareEmail] = useState("");
  const [sharePurpose,setSharePurpose] = useState("");
  const [mergeId,setMergeId] = useState("");
  const [convertEmail,setConvertEmail] = useState("");
  const [convertName,setConvertName]   = useState("");
  const convertValid = /\S+@\S+\.\S+/.test(convertEmail.trim());
  const clashingAdminBks = booking.status==="clash"
    ? allClashes.filter(c=>c.user.id===booking.id).map(c=>c.admin)
    : [];
  // ── Cost splitting & manual (function) pricing — admin edits, persisted to system_notes ──
  const primaryEmailLc = (booking.email||"").toLowerCase();
  const [editPricing,setEditPricing] = useState(false);
  const [splitParts,setSplitParts]   = useState(()=>parseSplit(booking.system_notes)||[{email:primaryEmailLc,weight:1}]);
  const [coEmail,setCoEmail]         = useState("");
  const [fnCost,setFnCost]           = useState(()=>{const v=parseFunctionCost(booking.system_notes);return v==null?"":String(v);});
  const splitTotalW = splitParts.reduce((s,p)=>s+(p.weight||0),0)||1;
  function addCo() {
    const e = coEmail.trim().toLowerCase();
    if (!/\S+@\S+\.\S+/.test(e)) return;
    if (!splitParts.some(p=>p.email===e)) setSplitParts([...splitParts,{email:e,weight:1}]);
    setCoEmail("");
  }
  function removeCo(email){ setSplitParts(splitParts.filter(p=>p.email!==email)); }
  function setWeight(email,w){ setSplitParts(splitParts.map(p=>p.email===email?{...p,weight:Math.max(0,parseFloat(w)||0)}:p)); }
  function equalize(){ setSplitParts(splitParts.map(p=>({...p,weight:1}))); }
  function savePricing() {
    let sn = booking.system_notes||"";
    sn = setFunctionCost(sn, fnCost===""?null:fnCost);
    const parts = splitParts.filter(p=>p.email && p.weight>0);
    sn = setSplit(sn, parts.length>=2?parts:null);
    onPatch && onPatch(booking,{system_notes:sn});
    setEditPricing(false);
  }
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
            <Badge status={booking.status} wf={workflowOf(booking.facility_id)}/>
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
      {(()=>{
        // GTEC's held record for this booking, captured at the last sync. Shown so the
        // booker/admin can see exactly what GTEC has on file alongside our own details.
        const g = parseGtecSnapshot(booking.system_notes);
        const hasTime = g && g.start_hour!=null && !Number.isNaN(g.start_hour);
        if (!g || (!g.name && !hasTime && !(g.facilityIds&&g.facilityIds.length) && !g.date)) return null;
        const gfacs = (g.facilityIds||[]).map(id=>FACILITIES.find(f=>f.id===id)?.name||id).filter(Boolean);
        const detRows = [
          g.name && ["Event", g.name],
          gfacs.length && ["Field(s)", gfacs.join(", ")],
          g.date && ["Date", fmtDate(g.date)],
          hasTime && ["Time", `${fmtTime(g.start_hour)} – ${fmtTime(g.start_hour+(g.duration||0))}`],
          (g.duration!=null && !Number.isNaN(g.duration)) && ["Duration", DURATIONS.find(d=>d.value===g.duration)?.label||`${g.duration}h`],
        ].filter(Boolean);
        return (
          <div style={{background:"#ecfeff",border:"1px solid #67e8f9",borderRadius:10,padding:"12px 16px"}}>
            <div style={{fontSize:12,fontWeight:700,color:"#155e75",textTransform:"uppercase",letterSpacing:"0.05em",marginBottom:8,display:"flex",alignItems:"center",gap:6}}>🌐 GTEC booking details</div>
            <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:"4px 12px"}}>
              {detRows.map(([label,value])=>(<Fragment key={label}>
                <span style={{fontSize:12,fontWeight:600,color:"#0e7490",whiteSpace:"nowrap"}}>{label}</span>
                <span style={{fontSize:14,color:"#0f172a"}}>{value}</span>
              </Fragment>))}
            </div>
            <div style={{fontSize:11,color:"#0e7490",marginTop:8}}>As held by GTEC at the most recent sync.</div>
          </div>
        );
      })()}
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
        booking.created_at&&["Created",fmtLoggedAt(booking.created_at)],
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
                <span style={{fontSize:12,color:"#64748b"}}>{fmtRefDate(c.date)}</span>
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
      {(()=>{
        const savedParts = parseSplit(booking.system_notes);
        const savedFixed = parseFunctionCost(booking.system_notes);
        if (!isAdmin && !savedParts && savedFixed==null) return null; // nothing to show bookers
        const aliasName = e => (e===primaryEmailLc && booking.name) ? booking.name : e.split("@")[0];
        return (
          <div style={{background:"#faf5ff",border:"1px solid #e9d5ff",borderRadius:10,padding:"12px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <span style={{fontSize:12,fontWeight:700,color:"#6b21a8",textTransform:"uppercase",letterSpacing:"0.05em"}}>💰 Cost splitting &amp; pricing</span>
              {isAdmin && !editPricing && <button onClick={()=>setEditPricing(true)} style={{marginLeft:"auto",fontFamily:"inherit",fontSize:11,fontWeight:700,border:"1.5px solid #d8b4fe",background:"#fff",color:"#7e22ce",borderRadius:6,padding:"2px 10px",cursor:"pointer"}}>Edit</button>}
            </div>
            {!editPricing ? (
              <div style={{display:"flex",flexDirection:"column",gap:6,fontSize:13,color:"#0f172a"}}>
                {savedFixed!=null
                  ? <div><strong>Fixed price:</strong> {fmtCost(savedFixed)} <span style={{color:"#7e22ce",fontSize:12}}>(overrides hourly rate)</span></div>
                  : <div style={{color:"#64748b",fontSize:12}}>Hourly facility rate (no fixed price).</div>}
                {savedParts
                  ? <div>
                      <div style={{fontSize:12,fontWeight:700,color:"#6b21a8",marginBottom:3}}>Split between {savedParts.length} bookers:</div>
                      {(()=>{const tot=savedParts.reduce((s,p)=>s+p.weight,0)||1;return savedParts.map(p=>(
                        <div key={p.email} style={{display:"flex",justifyContent:"space-between",gap:10,fontSize:12,padding:"1px 0"}}>
                          <span>{aliasName(p.email)}{p.email===primaryEmailLc?" (primary)":""}</span>
                          <span style={{fontWeight:700,color:"#7e22ce"}}>{Math.round(p.weight/tot*100)}%</span>
                        </div>));})()}
                    </div>
                  : <div style={{color:"#64748b",fontSize:12}}>Not split — billed to {aliasName(primaryEmailLc)} in full.</div>}
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {/* Fixed price */}
                <div>
                  <label style={{...S.lbl,color:"#6b21a8"}}>Fixed price — overrides hourly (for function/room bookings)</label>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:14,color:"#64748b"}}>$</span>
                    <input type="number" min={0} step="0.01" value={fnCost} onChange={e=>setFnCost(e.target.value)} placeholder="leave blank = hourly rate" style={{...S.inp,maxWidth:200}}/>
                  </div>
                </div>
                {/* Co-bookers / split */}
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                    <label style={{...S.lbl,color:"#6b21a8",margin:0}}>Split cost between bookers</label>
                    <button onClick={equalize} style={{fontFamily:"inherit",fontSize:11,fontWeight:700,border:"1.5px solid #d8b4fe",background:"#fff",color:"#7e22ce",borderRadius:6,padding:"1px 8px",cursor:"pointer"}}>Split equally</button>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {splitParts.map(p=>(
                      <div key={p.email} style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{flex:1,fontSize:13,color:"#0f172a",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.email}{p.email===primaryEmailLc?<span style={{color:"#7e22ce",fontWeight:700}}> (primary)</span>:""}</span>
                        <input type="number" min={0} step="1" value={p.weight} onChange={e=>setWeight(p.email,e.target.value)} title="Relative weight" style={{...S.inp,width:64,padding:"5px 8px"}}/>
                        <span style={{fontSize:12,fontWeight:700,color:"#7e22ce",width:42,textAlign:"right"}}>{Math.round((p.weight||0)/splitTotalW*100)}%</span>
                        {p.email!==primaryEmailLc
                          ? <button onClick={()=>removeCo(p.email)} title="Remove co-booker" style={{border:"none",background:"transparent",color:"#ef4444",cursor:"pointer",fontWeight:700,fontSize:14,lineHeight:1}}>✕</button>
                          : <span style={{width:14}}/>}
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:6,marginTop:8}}>
                    <input type="email" value={coEmail} onChange={e=>setCoEmail(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")addCo();}} placeholder="add co-booker email…" style={{...S.inp,flex:1}}/>
                    <button onClick={addCo} style={S.btn({border:"1.5px solid #d8b4fe",background:"#fff",color:"#7e22ce",fontSize:12,fontWeight:700})}>+ Add</button>
                  </div>
                  <div style={{fontSize:11,color:"#94a3b8",marginTop:6}}>Add other bookers to divide this booking's cost. Each is invoiced their share; one participant means no split.</div>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
                  <button onClick={()=>{setEditPricing(false);setSplitParts(parseSplit(booking.system_notes)||[{email:primaryEmailLc,weight:1}]);setFnCost((v=>v==null?"":String(v))(parseFunctionCost(booking.system_notes)));}} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569",fontSize:12})}>Cancel</button>
                  <button onClick={savePricing} style={S.btn({background:"#7e22ce",color:"#fff",fontSize:12,fontWeight:700})}>Save pricing</button>
                </div>
              </div>
            )}
          </div>
        );
      })()}
      {/* Shared slot — one field/time used by more than one team, held as one booking
          each so every team sees their own, linked so the slot is billed once. */}
      {isAdmin&&!isAdminBk&&(onShareSlot||onMergeSlot)&&(()=>{
        const link = parseSlotLink(booking.system_notes);
        const members = link ? slotGroupMembers(allBookings, link.id) : [];
        const shared = members.length > 1;
        const gtecName = shared ? slotGroupName(members) : "";
        // Other bookings already sitting on this exact field and time — merge candidates.
        const sameSlot = allBookings.filter(b =>
          b.id !== booking.id && !isAdminBooking(b) && b.date === booking.date &&
          b.facility_id === booking.facility_id && timeOverlaps(b, booking) &&
          !["cancelled","rejected"].includes(b.status) &&
          !members.some(m => m.id === b.id));
        return (
          <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderRadius:10,padding:"12px 16px",display:"flex",flexDirection:"column",gap:9}}>
            <div style={{fontSize:12,fontWeight:700,color:"#0369a1",textTransform:"uppercase",letterSpacing:"0.05em"}}>
              👥 Shared slot {shared?`— ${members.length} teams`:""}
            </div>
            {shared ? (<>
              <div style={{fontSize:11,color:"#0369a1"}}>
                This field and time is shared. The slot is billed <strong>once</strong>, split between the teams below — each is invoiced their share. Changes go to the <strong>cart</strong> and apply when you submit it.
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {members.map(m=>{
                  const ml = parseSlotLink(m.system_notes);
                  const isThis = m.id === booking.id;
                  return (
                    <div key={m.id} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,background:isThis?"#e0f2fe":"#fff",border:"1px solid #bae6fd",borderRadius:6,padding:"5px 9px"}}>
                      <span style={{fontSize:10,fontWeight:700,color:ml?.role==="parent"?"#7c3aed":ml?.role==="peer"?"#0369a1":"#64748b",background:"#fff",border:"1px solid #e2e8f0",borderRadius:4,padding:"0 5px"}}>
                        {ml?.role==="parent"?"parent":ml?.role==="peer"?"peer":"child"}
                      </span>
                      <span style={{fontWeight:600,color:"#0f172a"}}>{m.name||m.email}</span>
                      <span style={{color:"#64748b"}}>{m.purpose||""}</span>
                      <span style={{marginLeft:"auto",fontWeight:700,color:"#0369a1"}}>{Math.round((ml?.share||1)*100)}%</span>
                      {onUnlinkSlot&&(
                        <button onClick={()=>{ if(window.confirm(`Remove ${m.name||m.email} from this shared slot?\n\nAdded to the cart — nothing changes until you submit.`)) onUnlinkSlot(m); }}
                          title="Remove this team from the shared slot (staged in the cart)" style={{border:"none",background:"transparent",color:"#ef4444",cursor:"pointer",fontSize:13,lineHeight:1}}>✕</button>
                      )}
                    </div>
                  );
                })}
              </div>
              {gtecName&&(
                <div style={{fontSize:11,color:"#475569",background:"#fff",border:"1px solid #e2e8f0",borderRadius:6,padding:"5px 9px"}}>
                  <strong>Name GTEC sees:</strong> {gtecName}
                  <span style={{color:"#94a3b8"}}> — {members.some(m=>parseSlotLink(m.system_notes)?.role==="parent")?"the parent booking's name, unchanged by the split":"both names, since these were booked separately and merged"}</span>
                </div>
              )}
            </>) : (
              <div style={{fontSize:11,color:"#0369a1"}}>Add another team to use this same field and time. A booking is created for them and the slot&apos;s cost is split — GTEC keeps seeing this booking&apos;s name. Changes go to the <strong>cart</strong> and apply when you submit it.</div>
            )}
            {onShareSlot&&(
              <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                <select value={shareEmail} onChange={e=>setShareEmail(e.target.value)} style={{...S.inp,fontSize:12,padding:"5px 8px",flex:"1 1 150px"}}>
                  <option value="">Add a team…</option>
                  {bookers.filter(bk=>!members.some(m=>(m.email||"").toLowerCase()===bk.email)&&bk.email!==(booking.email||"").toLowerCase())
                    .map(bk=><option key={bk.email} value={bk.email}>{bk.name}</option>)}
                </select>
                <input value={sharePurpose} onChange={e=>setSharePurpose(e.target.value)} placeholder={`Purpose (default: ${booking.purpose||"same"})`}
                  style={{...S.inp,fontSize:12,padding:"5px 8px",flex:"1 1 150px"}}/>
                <button disabled={!shareEmail}
                  onClick={()=>{ onShareSlot(booking,{email:shareEmail,purpose:sharePurpose}); setShareEmail(""); setSharePurpose(""); }}
                  style={S.btn({background:shareEmail?"#0369a1":"#cbd5e1",color:"#fff",fontSize:12,fontWeight:700,cursor:shareEmail?"pointer":"not-allowed"})}>
                  🛒 Add team
                </button>
              </div>
            )}
            {onMergeSlot&&sameSlot.length>0&&(
              <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center",borderTop:"1px dashed #bae6fd",paddingTop:8}}>
                <span style={{fontSize:11,color:"#0369a1",fontWeight:600}}>Booked separately?</span>
                <select value={mergeId} onChange={e=>setMergeId(e.target.value)} style={{...S.inp,fontSize:12,padding:"5px 8px",flex:"1 1 160px"}}>
                  <option value="">Merge with an existing booking here…</option>
                  {sameSlot.map(b=><option key={b.id} value={b.id}>{b.name||b.email} — {b.purpose||"(no purpose)"}</option>)}
                </select>
                <button disabled={!mergeId}
                  onClick={()=>{ const other=sameSlot.find(b=>b.id===mergeId); if(other) onMergeSlot(booking,other); setMergeId(""); }}
                  title="Both bookings become equal partners on this slot, and GTEC sees both names. Added to the cart — nothing changes until you submit."
                  style={S.btn({background:mergeId?"#7c3aed":"#cbd5e1",color:"#fff",fontSize:12,fontWeight:700,cursor:mergeId?"pointer":"not-allowed"})}>
                  🔗 Merge
                </button>
              </div>
            )}
          </div>
        );
      })()}
      {isAdmin&&isAdminBk&&onConvertAdmin&&(
        <div style={{background:"#ecfdf5",border:"1px solid #6ee7b7",borderRadius:10,padding:"12px 16px",display:"flex",flexDirection:"column",gap:8}}>
          <div style={{fontSize:12,fontWeight:700,color:"#047857",textTransform:"uppercase",letterSpacing:"0.05em"}}>🔁 Convert to AMUA booking</div>
          <div style={{fontSize:12,color:"#065f46"}}>Assign this GTEC-held block to a booker. It becomes a GTEC-confirmed AMUA booking under their name; the next sync keeps it linked instead of re-importing the block.</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
            <input list="convert-booker-list" type="email" value={convertEmail}
              onChange={e=>{ const v=e.target.value; setConvertEmail(v); const mBk=bookers.find(bk=>bk.email===v.trim().toLowerCase()); if(mBk) setConvertName(mBk.name); }}
              placeholder="booker email…" style={{...S.inp,flex:1,minWidth:180}}/>
            <datalist id="convert-booker-list">{bookers.map(bk=><option key={bk.email} value={bk.email}>{bk.name}</option>)}</datalist>
            <input value={convertName} onChange={e=>setConvertName(e.target.value)} placeholder="booker / club name…" style={{...S.inp,flex:1,minWidth:140}}/>
            <button disabled={!convertValid}
              onClick={()=>onConvertAdmin(booking,{email:convertEmail.trim().toLowerCase(),name:convertName.trim()||convertEmail.trim()})}
              style={S.btn({background:"#059669",color:"#fff",fontWeight:700,opacity:convertValid?1:0.5,cursor:convertValid?"pointer":"not-allowed"})}>✓ Convert</button>
          </div>
        </div>
      )}
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