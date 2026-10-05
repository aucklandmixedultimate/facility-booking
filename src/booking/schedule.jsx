import { useState, useRef, Fragment } from "react";
import { Badge, rowSelect, isMultiSelectClick, COUNCIL_STAGE_STATUSES, groupStatusLabel, CopyableTable, DURATIONS, FACILITIES, Modal, S, STATUS_META, T, emailColor, fmtCost, fmtDate, fmtDateShort, fmtTime, isAdminBooking, newId, parseGroupRef, todayKey, venueFacilities, visibleFacilities } from "./core.jsx";
import { DateRangePicker } from "./modals.jsx";
import { isLive, isLegacyStatus } from "../statuses.js";
// `canon` folds a (lowercased) email onto its canonical primary so linked
// secondary bookers group under one entry. Defaults to identity.
export function buildOverlapPatternMap(active, facSensitive, canon) {
  const keyOf = canon || (e=>e);
  function dayName(d){return["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(d+"T12:00").getDay()];}
  function timesOverlap(b1,b2){return b1.start_hour<b2.start_hour+b2.duration&&b2.start_hour<b1.start_hour+b1.duration;}
  const patternMap={};
  active.forEach(b=>{
    const email=keyOf((b.email||"").toLowerCase());
    const dn=dayName(b.date);
    if(!patternMap[email]) patternMap[email]={};
    const emailPats=patternMap[email];
    // Bookings tagged with a shared group id (recurrence / multi-day / multi-facility)
    // collapse into one pattern regardless of weekday — the same as a weekly recurrence.
    const gid=parseGroupRef(b.system_notes);
    if(gid){ const gk=`grp:${gid}`; (emailPats[gk]=emailPats[gk]||[]).push(b); return; }
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

// Admin: move bookings to another booker — pick from the roster or type a new email.
// onReassign({email, name}); bookers = [{email, name}].
export function ReassignControl({ count, bookers=[], onReassign, dark=false }) {
  const [to, setTo] = useState("");
  const [name, setName] = useState("");
  const em = to.trim().toLowerCase(), known = bookers.find(b => b.email === em);
  const ok = count > 0 && /\S+@\S+\.\S+/.test(em);
  const si = { border:`1px solid ${dark?"#334155":T.line}`, borderRadius:T.rSm, padding:"3px 6px", fontSize:12, fontFamily:"inherit", background:dark?"#1e293b":T.surface, color:dark?"#fff":T.ink };
  return (
    <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
      <span style={{fontSize:11,fontWeight:600,color:dark?"#94a3b8":T.muted}}>👤 Reassign to</span>
      <input list="reassign-bookers" value={to} onChange={e=>{ setTo(e.target.value); const k=bookers.find(b=>b.email===e.target.value.trim().toLowerCase()); if(k) setName(k.name); }}
        placeholder="booker email" aria-label="Reassign to booker" style={{...si,width:200}}/>
      <datalist id="reassign-bookers">{bookers.map(b=><option key={b.email} value={b.email}>{b.name}</option>)}</datalist>
      {!known&&em&&<input value={name} onChange={e=>setName(e.target.value)} placeholder="their name / team" aria-label="New booker name" style={{...si,width:150}}/>}
      <button disabled={!ok} onClick={()=>{ onReassign({ email: em, name: known?.name || name.trim() }); setTo(""); setName(""); }}
        style={S.btn({padding:"4px 12px",fontSize:12,background:ok?(dark?"#6366f1":T.ink):T.faint,color:"#fff",cursor:ok?"pointer":"not-allowed"})}>
        Reassign {count}{known?` to ${known.name}`:""}
      </button>
    </div>
  );
}

// Admin: a pricing rule from a set of bookings — their bookers and facilities over their
// first–last dates (editable), at a day and/or evening $/hr. Like every rule it then applies
// to all of those bookers' bookings on those facilities in that range.
export function PricingRuleControl({ ticked, onAdd }) {
  const dates = ticked.map(b=>b.date).sort();
  const [from, setFrom] = useState(dates[0]||"");
  const [to, setTo] = useState(dates[dates.length-1]||"");
  const [period, setPeriod] = useState("both");
  const [dayRate, setDayRate] = useState("");
  const [eveRate, setEveRate] = useState("");
  const [done, setDone] = useState(false);
  const bkrs = [...new Set(ticked.map(b=>(b.email||"").toLowerCase()).filter(Boolean))];
  const facIds = [...new Set(ticked.map(b=>b.facility_id))];
  const facNames = facIds.map(id=>FACILITIES.find(f=>f.id===id)?.name||id);
  const si = {border:`1px solid ${T.line}`,borderRadius:T.rSm,padding:"3px 6px",fontSize:12,fontFamily:"inherit",background:T.surface,color:T.ink};
  const lbl = {fontSize:11,color:T.muted,fontWeight:600};
  const ok = ticked.length && from && to && from<=to &&
    (period==="day" ? dayRate!=="" : period==="evening" ? eveRate!=="" : (dayRate!==""||eveRate!==""));
  if (done) return <div style={{fontSize:12,color:T.turf,fontWeight:600}}>✓ Pricing rule added — see ⚙ Pricing rules (Admin / Summary) to edit or remove it.</div>;
  return (
    <div style={{display:"flex",flexDirection:"column",gap:6}}>
      <div style={{fontSize:11,color:T.ink2}}>
        For <b>{bkrs.length} booker{bkrs.length!==1?"s":""}</b> on <b>{facNames.join(", ")}</b> — applies to all their bookings there in the dates below, not only the ticked ones.
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <span style={lbl}>From</span><input type="date" value={from} onChange={e=>setFrom(e.target.value)} aria-label="Rule from" style={{...si,width:140}}/>
        <span style={lbl}>to</span><input type="date" value={to} onChange={e=>setTo(e.target.value)} aria-label="Rule to" style={{...si,width:140}}/>
        <select value={period} onChange={e=>setPeriod(e.target.value)} aria-label="Rule period" style={si}>
          <option value="both">Day & evening</option><option value="day">Day only</option><option value="evening">Evening only</option>
        </select>
        {period!=="evening"&&<label style={{display:"flex",alignItems:"center",gap:4}}><span style={lbl}>Day $/hr</span>
          <input type="number" min="0" step="0.5" value={dayRate} onChange={e=>setDayRate(e.target.value)} aria-label="Day rate" style={{...si,width:70}}/></label>}
        {period!=="day"&&<label style={{display:"flex",alignItems:"center",gap:4}}><span style={lbl}>Evening $/hr</span>
          <input type="number" min="0" step="0.5" value={eveRate} onChange={e=>setEveRate(e.target.value)} aria-label="Evening rate" style={{...si,width:70}}/></label>}
        <button disabled={!ok} onClick={()=>{ onAdd({ id:newId(), bookerEmails:bkrs, facilityIds:facIds, period,
            dayRate: period==="evening"?null:(dayRate===""?null:Number(dayRate)), eveningRate: period==="day"?null:(eveRate===""?null:Number(eveRate)),
            dateFrom:from, dateTo:to, locked:false, source:"group", createdAt:new Date().toISOString() }); setDone(true); }}
          style={S.btn({padding:"4px 12px",fontSize:12,background:ok?T.ink:T.faint,color:"#fff",cursor:ok?"pointer":"not-allowed"})}>Add rule</button>
      </div>
    </div>
  );
}

// A set of bookings (a recurring pattern, a booker's status group, their one-offs…) shown
// itemised, with ticks to choose which ones the actions apply to. The same panel opens
// inline in the Grouped view and inside PatternModal / OneOffModal elsewhere.
//   onBulkStatusChange(ids, status)  admin: set the status of the ticked bookings
//   onBulkApply({email, pk, bkgs, bulkTime, bulkDur, bulkFac, cancelFrom})  change time /
//     duration / facility (undefined = keep each booking's own) or cancel from a date
//   onRemove(ids)  send the ticked bookings to the removal queue (deleted when it's submitted)
//   onReassign(ids, {email, name})  admin: move the ticked bookings to another booker
//   onAddPricingRule(rule)  admin: a pricing rule (PricingConditionsManager's shape) for the
//     ticked bookings' bookers and facilities over their date range
export function BookingSubsetPanel({ title, subtitle, email, pk, bkgs, isAdmin, canEdit, onBulkApply, onBulkStatusChange, onRemove, onReassign, onAddPricingRule, bookers=[], onView, onClose, maxHeight=260 }) {
  const sorted = [...bkgs].sort((a,b)=>a.date.localeCompare(b.date)||a.start_hour-b.start_hour);
  const [unticked, setUnticked] = useState(()=>new Set());
  const ticked = sorted.filter(b=>!unticked.has(b.id));
  const uniform = k => { const v = [...new Set(sorted.map(b=>b[k]))]; return v.length===1 ? String(v[0]) : ""; };
  const [bulkTime, setBulkTime] = useState(()=>uniform("start_hour"));
  const [bulkDur, setBulkDur] = useState(()=>uniform("duration"));
  const [bulkFac, setBulkFac] = useState(()=>uniform("facility_id"));
  const [cancelFrom, setCancelFrom] = useState("");
  const [statusTarget, setStatusTarget] = useState("approved");
  const [actTab, setActTab] = useState(null); // the action category shown (one at a time)
  const canStatus = isAdmin && onBulkStatusChange;
  const canBulk = (isAdmin || canEdit) && onBulkApply;
  const canRemove = (isAdmin || canEdit) && onRemove;
  const canReassign = isAdmin && onReassign;
  const canPrice = isAdmin && onAddPricingRule;
  const tickAnchor = useRef(null);
  // Shift-click ticks/unticks a range; Ctrl/⌘-click a row toggles it (rowSelect).
  const select = (e, id) => { const t = rowSelect(e, id, sorted.map(b=>b.id), new Set(ticked.map(b=>b.id)), tickAnchor);
    setUnticked(new Set(sorted.filter(b=>!t.has(b.id)).map(b=>b.id))); };
  const allTicked = ticked.length === sorted.length;
  const th = {textAlign:"left",padding:"5px 8px",fontWeight:600,color:T.muted,fontSize:11,whiteSpace:"nowrap"};
  const td = {padding:"4px 8px",fontSize:12,borderTop:`1px solid ${T.lineSoft}`,whiteSpace:"nowrap"};
  const si = {border:`1px solid ${T.line}`,borderRadius:T.rSm,padding:"3px 6px",fontSize:12,fontFamily:"inherit",background:T.surface,color:T.ink};
  const lbl = {fontSize:11,color:T.muted,fontWeight:600};
  const facs = [...new Map([...sorted.map(b=>FACILITIES.find(f=>f.id===b.facility_id)).filter(Boolean), ...venueFacilities(sorted[0]?.facility_id)].map(f=>[f.id,f])).values()];
  const n = ticked.length, nCancel = cancelFrom ? ticked.filter(b=>b.date>=cancelFrom).length : 0;
  const editing = bulkTime!==uniform("start_hour") || bulkDur!==uniform("duration") || bulkFac!==uniform("facility_id");
  return (
    <div style={{background:T.surface,border:`1px solid ${T.line}`,borderRadius:T.rLg,padding:"8px 10px",boxShadow:T.shadow2}}>
      {(title||onClose)&&<div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
        <div style={{minWidth:0}}>
          <div style={{fontSize:13,fontWeight:700,color:T.ink}}>{title}</div>
          {subtitle&&<div style={{fontSize:11,color:T.muted}}>{subtitle}</div>}
        </div>
        {onClose&&<button onClick={onClose} aria-label="Collapse" title="Collapse" style={{marginLeft:"auto",border:"none",background:"none",cursor:"pointer",color:T.faint,fontSize:15,padding:2}}>▴</button>}
      </div>}
      <div style={{overflow:"auto",maxHeight}}>
        <CopyableTable>
        <table style={{width:"100%",borderCollapse:"collapse"}}>
          <thead><tr style={{background:T.surface2}}>
            <th style={{...th,width:24}}><input type="checkbox" checked={allTicked} aria-label="Tick all"
              onChange={()=>setUnticked(allTicked?new Set(sorted.map(b=>b.id)):new Set())}/></th>
            <th style={th}>Date</th><th style={th}>Facility</th><th style={{...th,textAlign:"right"}}>Time</th><th style={{...th,textAlign:"right"}}>Dur</th><th style={th}>Status</th>
          </tr></thead>
          <tbody>
            {sorted.map(b=>{
              const f=FACILITIES.find(x=>x.id===b.facility_id); const on=!unticked.has(b.id);
              return (
                <tr key={b.id} style={{opacity:on?1:0.5}} onClick={e=>{ if(isMultiSelectClick(e)&&!e.target.closest("button,input")) select(e,b.id); }}
                  onMouseDown={e=>{ if(e.shiftKey) e.preventDefault(); }}>
                  <td style={td}><input type="checkbox" checked={on} readOnly onClick={e=>select(e,b.id)} aria-label={`Tick ${fmtDate(b.date)}`} title="Shift-click: tick a range"/></td>
                  <td style={td}>{onView
                    ? <button onClick={()=>onView(b)} title="Open booking" style={{border:"none",background:"none",padding:0,cursor:"pointer",color:T.focus,fontFamily:"inherit",fontSize:12,textDecoration:"underline dotted"}}>{fmtDate(b.date)}</button>
                    : fmtDate(b.date)}</td>
                  <td style={td}><span style={{fontSize:11,background:(f?.color||"#94a3b8")+"22",color:f?.color,borderRadius:4,padding:"1px 5px"}}>{f?.name.split("–")[0].trim()||b.facility_id}</span></td>
                  <td style={{...td,textAlign:"right"}}>{fmtTime(b.start_hour)}</td>
                  <td style={{...td,textAlign:"right"}}>{b.duration}h</td>
                  <td style={td}><Badge status={b.status} fid={b.facility_id}/></td>
                </tr>
              );
            })}
            {sorted.length===0&&<tr><td colSpan={6} style={{...td,textAlign:"center",color:T.faint}}>No bookings left in this group.</td></tr>}
          </tbody>
        </table>
        </CopyableTable>
      </div>
      {(canStatus||canBulk||canRemove||canReassign||canPrice)&&sorted.length>0&&(()=>{
        // One category at a time: a row of buttons, and only the chosen one's controls below.
        const cats = [
          canStatus   && ["status",   "✓ Status"],
          canBulk     && ["edit",     "🕑 Time & field"],
          canReassign && ["reassign", "👤 Reassign"],
          canPrice    && ["price",    "💲 Pricing"],
          (canRemove || canBulk) && ["remove", "🗑 Remove"],
        ].filter(Boolean);
        const tab = (k, l) => (
          <button key={k} type="button" aria-pressed={actTab===k} onClick={()=>setActTab(t=>t===k?null:k)}
            style={{padding:"3px 10px",borderRadius:T.rPill,border:`1.5px solid ${actTab===k?T.ink:T.line}`,background:actTab===k?T.ink:T.surface,
              color:actTab===k?T.surface:T.ink2,fontSize:11,fontWeight:700,fontFamily:"inherit",cursor:"pointer",whiteSpace:"nowrap"}}>{l}</button>);
        const go = (ok, label, onClick, bg=T.ink) => (
          <button disabled={!ok} onClick={onClick} style={S.btn({padding:"4px 12px",fontSize:12,background:ok?bg:T.faint,color:"#fff",cursor:ok?"pointer":"not-allowed"})}>{label}</button>);
        return (
          <div style={{marginTop:8,padding:"6px 8px",background:T.surface2,borderRadius:T.rMd,display:"flex",flexDirection:"column",gap:8}}>
            <div style={{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}}>
              <span style={{fontSize:11,fontWeight:700,color:T.muted,marginRight:2}}>⚙ {n} ticked:</span>
              {cats.map(([k,l])=>tab(k,l))}
            </div>
            {actTab==="status"&&canStatus&&(
              <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                <select value={statusTarget} onChange={e=>setStatusTarget(e.target.value)} aria-label="New status" style={si}>
                  {Object.keys(STATUS_META).filter(k=>!isLegacyStatus(k)&&k!=="clash").map(k=><option key={k} value={k}>{groupStatusLabel(k, ticked)}</option>)}
                </select>
                {go(n, `Set ${n}`, ()=>onBulkStatusChange(ticked.map(b=>b.id),statusTarget))}
              </div>
            )}
            {actTab==="edit"&&canBulk&&(
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <label style={{display:"flex",alignItems:"center",gap:4}}><span style={lbl}>Start</span>
                  <select value={bulkTime} onChange={e=>setBulkTime(e.target.value)} style={si}>
                    {!uniform("start_hour")&&<option value="">— keep each —</option>}
                    {Array.from({length:48},(_,i)=>i/2).map(h=><option key={h} value={String(h)}>{fmtTime(h)}</option>)}
                  </select></label>
                <label style={{display:"flex",alignItems:"center",gap:4}}><span style={lbl}>Duration</span>
                  <select value={bulkDur} onChange={e=>setBulkDur(e.target.value)} style={si}>
                    {!uniform("duration")&&<option value="">— keep each —</option>}
                    {DURATIONS.map(d=><option key={d.value} value={String(d.value)}>{d.label}</option>)}
                  </select></label>
                <label style={{display:"flex",alignItems:"center",gap:4}}><span style={lbl}>Facility</span>
                  <select value={bulkFac} onChange={e=>setBulkFac(e.target.value)} style={si}>
                    {!uniform("facility_id")&&<option value="">— keep each —</option>}
                    {facs.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
                  </select></label>
                {go(n&&editing, `Apply to ${n}`, ()=>onBulkApply({email,pk,bkgs:ticked,
                  bulkTime:bulkTime===""?undefined:parseFloat(bulkTime), bulkDur:bulkDur===""?undefined:parseFloat(bulkDur), bulkFac:bulkFac||undefined, cancelFrom:""}))}
              </div>
            )}
            {actTab==="price"&&canPrice&&<PricingRuleControl ticked={ticked} onAdd={onAddPricingRule}/>}
            {actTab==="reassign"&&canReassign&&<ReassignControl count={n} bookers={bookers.filter(b=>b.email!==(email||"").toLowerCase())} onReassign={to=>onReassign(ticked.map(b=>b.id), to)}/>}
            {actTab==="remove"&&(
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
                  {canRemove&&go(n, `Remove ${n} ticked`, ()=>onRemove(ticked.map(b=>b.id)), T.danger)}
                  {canBulk&&<>
                    <span style={lbl}>{canRemove?"or from":"From"}</span>
                    <input type="date" value={cancelFrom} onChange={e=>setCancelFrom(e.target.value)} aria-label="Remove from date" style={{...si,width:140}}/>
                    {go(nCancel, `Remove ${nCancel} from then`, ()=>onBulkApply({email,pk,bkgs:ticked,cancelFrom}), T.danger)}
                  </>}
                </div>
                <span style={{fontSize:11,color:T.faint}}>They go to the 🗑 removal queue — deleted (and the booker emailed) when you submit it.</span>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// A recurring pattern or grouped booking in a modal (Summary tab, admin clash list).
export function PatternModal({ email, name, pk, bkgs, isAdmin, canEdit: canEditProp, onClose, onBulkApply, onBulkStatusChange, onRemove, onAddPricingRule, onView }) {
  const canEdit = canEditProp !== undefined ? canEditProp : isAdmin;
  const isGroup = pk.startsWith("grp:");
  const parts = pk.split("_");
  const startH = parseFloat(parts[parts.length-1]);
  const dn = parts[parts.length-2]||"";
  const facId = !isGroup && parts.length>2 ? parts[0] : null;
  const fac = facId ? FACILITIES.find(f=>f.id===facId) : null;
  return (
    <Modal title={isGroup?`🔗 Grouped booking — ${name}`:`Pattern: ${dn} ${fmtTime(startH)} — ${name}`} onClose={onClose}>
      <BookingSubsetPanel subtitle={`${bkgs.length} booking${bkgs.length!==1?"s":""} · ${email}${fac?` · ${fac.name}`:""}${isGroup?" · created together":""}`}
        email={email} pk={pk} bkgs={bkgs} isAdmin={isAdmin} canEdit={canEdit} onView={onView} maxHeight={320}
        onBulkStatusChange={onBulkStatusChange&&((ids,st)=>{onBulkStatusChange(ids,st);onClose();})}
        onBulkApply={onBulkApply&&(args=>{onBulkApply(args);onClose();})}
        onRemove={onRemove&&(ids=>{onRemove(ids);onClose();})} onAddPricingRule={onAddPricingRule}/>
    </Modal>
  );
}

export function OneOffModal({ email, name, bkgs, isAdmin, canEdit, onClose, onView, onRemove, onAddPricingRule }) {
  return (
    <Modal title={`One-off Bookings — ${name}`} onClose={onClose}>
      <BookingSubsetPanel subtitle={`${bkgs.length} one-off booking${bkgs.length!==1?"s":""} · ${email}`} email={email} pk="oneoff" bkgs={bkgs} onView={onView} maxHeight={360}
        isAdmin={isAdmin} canEdit={canEdit} onRemove={onRemove&&(ids=>{onRemove(ids);onClose();})} onAddPricingRule={onAddPricingRule}/>
    </Modal>
  );
}

// embedded: rendered as a table view (Grouped) — no panel heading or close.
export function ScheduleSummaryModal({ bookings, isAdmin, loggedInEmail, onBulkApply, onBulkStatusChange, onRemove, onReassign, onAddPricingRule, bookers=[], onView, onClose, inline=false, embedded=false, aliasNames={}, emailAliases={} }) {
  const [facSensitive, setFacSensitive] = useState(false);
  const [splitPatterns, setSplitPatterns] = useState(new Set());
  // The group expanded inline into its itemised bookings (BookingSubsetPanel) — one at a time:
  // {email, kind:"pattern"|"status"|"oneoff"|"selected", pk?, sh?, status?, title}.
  const [expanded, setExpanded] = useState(null);
  const sameGroup = (a, b) => !!a && !!b && a.email===b.email && a.kind===b.kind && a.pk===b.pk && a.sh===b.sh && a.status===b.status;
  const toggleExpand = d => setExpanded(prev => sameGroup(prev, d) ? null : d);
  const openRing = d => sameGroup(expanded, d) ? {boxShadow:`0 0 0 2px ${T.ink}`} : null;
  // Date-range table filters default to "today onwards" — the common case is upcoming
  // bookings, and past ones are a deliberate lookup. Clear the From field (or pick "Any
  // date" in the picker) to see history again.
  const [schedDateFrom, setSchedDateFrom] = useState(()=>todayKey());
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

  // Everything in the table (patterns, one-offs, totals) covers the chosen date range.
  const inRange = b => (!schedDateFrom || b.date >= schedDateFrom) && (!schedDateTo || b.date <= schedDateTo);
  const pool = bookings.filter(b=>(isLive(b.status)||b.invoiced)&&!isAdminBooking(b)&&inRange(b));
  // The status filter applies to everything in a row (patterns, one-offs, status chips,
  // totals), not just which bookers are listed.
  const active = schedStatusFilter.size ? pool.filter(b=>schedStatusFilter.has(b.status)) : pool;
  const canonEmail = em => (emailAliases[(em||"").toLowerCase()] || (em||"").toLowerCase());
  const patternMap = buildOverlapPatternMap(active, facSensitive, canonEmail);

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
  const allStatuses = [...new Set(pool.map(b=>b.status))];

  const thS2={textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b",fontSize:12,borderBottom:"1px solid #e2e8f0"};
  const tdS2={padding:"6px 8px",verticalAlign:"top",fontSize:13};

  function renderChips(email, nameDisplay, recurring) {
    const ec = emailColor(email);
    const chips = [];
    for (const [pk, bkgs] of recurring) {
      if (pk.startsWith("grp:")) {
        // A grouped booking (recurrence / multi-day / multi-facility) created together.
        const dates=bkgs.map(b=>b.date).filter(Boolean).sort();
        const facIds=[...new Set(bkgs.map(b=>b.facility_id))];
        const facLabel=facIds.map(fid=>{const f=FACILITIES.find(x=>x.id===fid);return f?(f.name.includes("Field")?f.name.replace("Field ","Fld "):f.name.split("–")[0].trim().slice(0,6)):fid;}).join(", ");
        const uniform=bkgs.every(b=>b.start_hour===bkgs[0].start_hour&&b.duration===bkgs[0].duration&&b.facility_id===bkgs[0].facility_id);
        chips.push(
          <span key={pk} title="Grouped booking — click to itemise" onClick={()=>toggleExpand({email,kind:"pattern",pk,title:`🔗 Grouped booking — ${nameDisplay}`})}
            style={{display:"inline-flex",alignItems:"center",gap:3,background:ec+"22",color:ec,border:`1px solid ${ec}55`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer",...openRing({email,kind:"pattern",pk})}}>
            🔗 {fmtDateShort(dates[0])}–{fmtDateShort(dates[dates.length-1])} · {facLabel}{uniform?` · ${fmtTime(bkgs[0].start_hour)}`:""} ×{bkgs.length}
          </span>
        );
        continue;
      }
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
            <span key={`${pk}::${sh}`} title="Click to itemise" onClick={()=>toggleExpand({email,kind:"pattern",pk,sh,title:`${dn} ${fmtTime(sh)} — ${nameDisplay}`})}
              style={{display:"inline-flex",alignItems:"center",gap:3,background:ec+"22",color:ec,border:`1px solid ${ec}55`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer",...openRing({email,kind:"pattern",pk,sh})}}>
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
          <span key={pk} title="Click to itemise" onClick={()=>toggleExpand({email,kind:"pattern",pk,title:`${dn} ${fmtTime(startH)} — ${nameDisplay}`})}
            style={{display:"inline-flex",alignItems:"center",gap:3,background:ec+"22",color:ec,border:`1px solid ${ec}55`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer",...openRing({email,kind:"pattern",pk})}}>
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

  // A function (not a component) so the panel isn't remounted on every render.
  const Wrapper = children => embedded ? <div>{children}</div> : inline
    ? <div style={{background:"#f0f9ff",border:"1.5px solid #bae6fd",borderRadius:12,padding:16}}><div style={{fontSize:14,fontWeight:700,color:"#0369a1",marginBottom:10}}>📅 Schedule Summary</div>{children}</div>
    : <Modal title="📅 Schedule Summary" onClose={onClose}>{children}</Modal>;
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
  // The bookings of an expanded group, from the current data (so they refresh after an action).
  function groupBkgs(row, d) {
    if (d.kind === "status") return row.filteredBkgs.filter(b => b.status === d.status);
    if (d.kind === "oneoff") return row.oneOffs;
    const pat = (row.recurring.find(([pk]) => pk === d.pk) || [])[1] || [];
    return d.sh != null ? pat.filter(b => b.start_hour === d.sh) : pat;
  }
  function panelFor(d, bkgs, row) {
    const email = row ? row.email : "";
    const canEdit = isAdmin || (!!email && email.toLowerCase() === loggedInEmail?.toLowerCase());
    return (
      <BookingSubsetPanel key={`${d.email}|${d.kind}|${d.pk}|${d.sh}|${d.status}`} title={d.title}
        subtitle={`${bkgs.length} booking${bkgs.length!==1?"s":""}${email?` · ${email}`:""}`}
        email={email} pk={d.pk||d.kind} bkgs={bkgs} isAdmin={isAdmin} canEdit={canEdit} onView={onView}
        onBulkApply={onBulkApply} onBulkStatusChange={onBulkStatusChange} onRemove={onRemove} onReassign={onReassign} onAddPricingRule={onAddPricingRule} bookers={bookers} onClose={()=>setExpanded(null)}/>
    );
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
      {Wrapper(<>
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
                const on=schedStatusFilter.has(st);
                return(
                  <button key={st} onClick={()=>setSchedStatusFilter(prev=>{const s=new Set(prev);on?s.delete(st):s.add(st);return s;})}
                    style={{padding:"2px 7px",borderRadius:8,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:`1.5px solid ${on?m.border:"#e2e8f0"}`,background:on?m.bg:"#fff",color:on?m.text:"#64748b"}}>
                    {groupStatusLabel(st, pool.filter(b=>b.status===st))}
                  </button>
                );
              })}
              {schedStatusFilter.size>0&&<button onClick={()=>setSchedStatusFilter(new Set())} style={{padding:"2px 7px",borderRadius:8,fontSize:10,fontWeight:600,cursor:"pointer",fontFamily:"inherit",border:"1.5px solid #e2e8f0",background:"#fff",color:"#94a3b8"}}>✕ clear</button>}
            </div>
          )}
        </div>
        {isAdmin&&onBulkStatusChange&&(
          <div style={{fontSize:11,color:"#64748b",marginBottom:8,fontStyle:"italic"}}>
            Tip: click status chips to select groups for a bulk action, or ▾ (and patterns) to itemise them with their actions.
          </div>
        )}
        <div style={{overflowY:"auto",maxHeight:"60vh",overflowX:"auto"}}>
          <CopyableTable>
          <table style={{width:"100%",borderCollapse:"collapse",minWidth:560}}>
            <thead>
              <tr style={{background:"#f8fafc"}}>
                <th style={thS2}>Booker</th>
                <th style={thS2}>Recurring Patterns <span style={{fontWeight:400,fontSize:11,color:"#94a3b8"}}>(click to itemise)</span></th>
                <th style={{...thS2,minWidth:100}}>
                  <div style={{display:"flex",alignItems:"center",gap:4}}>
                    Date Range
                    {(schedDateFrom||schedDateTo)&&<span style={{fontSize:9,background:"#0f172a",color:"#fff",borderRadius:4,padding:"0 3px"}}>filtered</span>}
                  </div>
                </th>
                <th style={{...thS2,minWidth:110}}>Status <span style={{fontWeight:400,fontSize:11,color:"#94a3b8"}}>({groupSelectable?"click to select · ▾ itemise":"click to itemise"})</span></th>
                <th style={{...thS2,textAlign:"right"}}>One-offs</th>
                <th style={{...thS2,textAlign:"right"}}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row=>{
                const ec = emailColor(row.email);
                const open = expanded && expanded.email===row.email && expanded.kind!=="selected" ? expanded : null;
                return (
                  <Fragment key={row.email}>
                  <tr style={{borderBottom:open?"none":"1px solid #f1f5f9"}}>
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
                          const short=groupStatusLabel(st, row.filteredBkgs.filter(b=>b.status===st));
                          const desc={email:row.email,kind:"status",status:st,title:`${short} — ${row.nameDisplay}`};
                          const chip={display:"inline-flex",alignItems:"center",gap:3,padding:"2px 7px",background:sel?m.dot:m.bg,color:sel?"#fff":m.text,border:`1.5px solid ${sel?m.dot:m.border}`,fontSize:10,fontWeight:700,cursor:"pointer",fontFamily:"inherit",outline:"none"};
                          return(
                            <span key={st} style={{display:"inline-flex",borderRadius:8,boxShadow:sel?`0 0 0 2px ${m.dot}33`:"none",...openRing(desc)}}>
                              <button title={groupSelectable?`Click to select ${cnt} ${short}`:`Show ${cnt} ${short}`}
                                onClick={groupSelectable?()=>toggleGroup(row.email,st):()=>toggleExpand(desc)}
                                style={{...chip,borderRadius:"8px 0 0 8px",borderRight:"none"}}>
                                {sel&&<span style={{fontSize:9}}>✓</span>}
                                <span style={{width:5,height:5,borderRadius:"50%",background:sel?"#fff":m.dot,flexShrink:0}}/>
                                {short.length>22?short.slice(0,21)+"…":short} ×{cnt}
                              </button>
                              <button title={sameGroup(expanded,desc)?"Collapse":`Itemise ${cnt} ${short}${groupSelectable?" with actions":""}`} aria-expanded={sameGroup(expanded,desc)}
                                onClick={()=>toggleExpand(desc)}
                                style={{...chip,borderRadius:"0 8px 8px 0",padding:"2px 5px",borderLeft:`1px solid ${sel?"#ffffff66":m.border}`}}>{sameGroup(expanded,desc)?"▴":"▾"}</button>
                            </span>
                          );
                        })}
                        {Object.keys(row.statusCounts).length===0&&<span style={{color:"#94a3b8",fontSize:12}}>—</span>}
                      </div>
                    </td>
                    <td style={{...tdS2,textAlign:"right"}}>
                      {row.oneOffs.length>0
                        ? <span title="Click to itemise" style={{cursor:"pointer",color:"#6366f1",textDecoration:"underline dotted",fontSize:13,borderRadius:6,padding:"0 4px",...openRing({email:row.email,kind:"oneoff"})}}
                            onClick={()=>toggleExpand({email:row.email,kind:"oneoff",title:`One-off bookings — ${row.nameDisplay}`})}>
                            {row.oneOffs.length}
                          </span>
                        : <span style={{color:"#94a3b8"}}>—</span>}
                    </td>
                    <td style={{...tdS2,textAlign:"right",fontWeight:700}}>{row.totalBkgs}</td>
                  </tr>
                  {open&&(
                    <tr style={{borderBottom:"1px solid #f1f5f9"}}><td colSpan={6} style={{padding:"0 8px 10px"}}>
                      {/* Pinned to the visible width when the wide table scrolls sideways (phones). */}
                      <div style={{position:"sticky",left:0,maxWidth:"calc(100vw - 110px)"}}>{panelFor(open, groupBkgs(row, open), row)}</div>
                    </td></tr>
                  )}
                  </Fragment>
                );
              })}
              {rows.length===0&&<tr><td colSpan={colCount} style={{...tdS2,textAlign:"center",color:"#94a3b8"}}>No active bookings.</td></tr>}
            </tbody>
          </table>
          </CopyableTable>
        </div>
        {groupSelectable && selectedGroups.size>0 && expanded?.kind==="selected" && (
          <div style={{marginTop:10}}>{panelFor(expanded, selectedBkgs, null)}</div>
        )}
        {groupSelectable && selectedGroups.size>0 && (
          <div style={{marginTop:10,padding:"10px 14px",background:"#0f172a",borderRadius:10,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap",color:"#fff"}}>
            <span style={{fontSize:12,fontWeight:700}}>
              {selectedGroups.size} group{selectedGroups.size!==1?"s":""} · {selectedBkgs.length} booking{selectedBkgs.length!==1?"s":""} selected
            </span>
            <button onClick={()=>setSelectedGroups(new Set())}
              style={{padding:"3px 9px",fontSize:11,borderRadius:6,border:"1.5px solid #334155",background:"transparent",color:"#cbd5e1",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
              Clear
            </button>
            <button onClick={()=>toggleExpand({email:"",kind:"selected",title:"Selected bookings"})} aria-expanded={expanded?.kind==="selected"}
              style={{padding:"3px 9px",fontSize:11,borderRadius:6,border:"1.5px solid #334155",background:expanded?.kind==="selected"?"#334155":"transparent",color:"#cbd5e1",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>
              {expanded?.kind==="selected"?"▴ Hide itemised":"▾ Itemised"}
            </button>
            <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
              <span style={{fontSize:11,color:"#94a3b8"}}>Set status to:</span>
              <select value={bulkStatusTarget} onChange={e=>setBulkStatusTarget(e.target.value)}
                style={{fontSize:11,padding:"4px 8px",borderRadius:6,border:"1.5px solid #334155",background:"#1e293b",color:"#fff",fontFamily:"inherit",fontWeight:600}}>
                {Object.keys(STATUS_META).filter(k=>!isLegacyStatus(k) && k!=="clash").map(k=>(
                  <option key={k} value={k}>{groupStatusLabel(k, selectedBkgs)}</option>
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
      </>)}
    </>
  );
}

// ─── Pricing conditions ─────────────────────────────────────────────────────
// A condition pins a booker's rate for one facility over a date range. All
// conditions are stored even when they overlap/conflict; at price time the
// applicable one is chosen by priority — invoice-locked first, then newest.
// Each condition may override the day rate, the evening rate, or both.
// { id, bookerEmail, facilityId, period:"day"|"evening"|"both",
//   dayRate, eveningRate, dateFrom, dateTo, locked, source, createdAt }
export function defaultFacRates(facilityRates, facId) {
  // A facility can carry its own default $/hr (a ground hired at a flat rate); otherwise
  // the house default applies. Either way an explicit admin-set rate still wins.
  const own = FACILITIES.find(f => f.id === facId)?.defaultRate;
  const dflt = own != null ? { day: own, evening: own } : { day: 0, evening: 50 };
  const r = (facilityRates || {})[facId];
  if (!r) return dflt;
  if (typeof r === "object") return { day: r.day ?? dflt.day, evening: r.evening ?? dflt.evening };
  return { day: parseFloat(r) || dflt.day, evening: dflt.evening }; // backward compat (number = day rate)
}
// A rule targets one or more bookers and facilities. New rules store arrays
// (bookerEmails/facilityIds); legacy rules and invoice-locked snapshots store the
// singular bookerEmail/facilityId — both are normalised here.
export function condBookerList(c)   { return (c.bookerEmails && c.bookerEmails.length) ? c.bookerEmails : (c.bookerEmail ? [c.bookerEmail] : []); }
export function condFacilityList(c) { return (c.facilityIds  && c.facilityIds.length)  ? c.facilityIds  : (c.facilityId  ? [c.facilityId]  : []); }
export function matchingConditions(conditions, facId, bookerEmail, dateStr) {
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
export function resolveRates(facilityRates, conditions, facId, bookerEmail, dateStr) {
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
export function PricingConditionsManager({ conditions = [], bookers = [], onAdd, onUpdate, onRemove, aliasFor }) {
  const [showForm, setShowForm] = useState(false);
  const [editId,   setEditId]   = useState(null);
  const [bkrSel,   setBkrSel]   = useState([]); // lowercased emails
  const [facSel,   setFacSel]   = useState([]); // facility ids
  const [period,   setPeriod]   = useState("both");
  const [allFacs,  setAllFacs]  = useState(false); // show facilities outside the current locations
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
              {/* The current locations' facilities (and any already picked); the rest on request. */}
              {(()=>{ const shown=new Set(venueFacilities().map(f=>f.id)); facSel.forEach(id=>shown.add(id));
                const all=visibleFacilities(), list=allFacs?all:all.filter(f=>shown.has(f.id)), more=all.length-all.filter(f=>shown.has(f.id)).length;
                return <>{list.map(f=><Fragment key={f.id}>{chip(facSel.includes(f.id),()=>toggle(facSel,setFacSel,f.id),f.name,f.color,"#fff")}</Fragment>)}
                  {more>0&&<button type="button" onClick={()=>setAllFacs(v=>!v)} style={{fontFamily:"inherit",fontSize:11,fontWeight:600,cursor:"pointer",borderRadius:999,padding:"2px 9px",border:"1.5px dashed #cbd5e1",background:"#fff",color:"#64748b"}}>
                    {allFacs?"Only these locations":`+ ${more} more`}</button>}</>; })()}
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