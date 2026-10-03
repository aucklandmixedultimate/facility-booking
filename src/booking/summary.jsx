import { useState, useEffect, useRef, Fragment } from "react";
import { AMUA_INFO, Badge, COUNCIL_APPLICATION_FEE, COUNCIL_STAGE_STATUSES, CopyableTable, DURATIONS, FACILITIES, Modal, PROVIDERS, RECIPIENT_CODE_AMUA, S, STATUS_META, cleanRecipientCode, deriveRecipientCode, emailColor, facCellLabel, fmt24, fmtCost, fmtDate, fmtDateShort, fmtTime, genBankRef, isAdminBooking, newId, parseBilledSnapshot, parseCouncilApp, parseCpsaResolution, parseFunctionCost, parseGroupRef, parseSlotLink, parseSplit, providerOfFacility, todayKey, venueFacilities, visibleFacilities, workflowOf } from "./core.jsx";
import { InvoiceOptionRow, InvoicePill, invLineLabel, renderInvoiceDocHtml } from "./billing.jsx";
import { DateRangePicker } from "./modals.jsx";
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

export function PatternModal({ email, name, pk, bkgs, isAdmin, canEdit: canEditProp, onClose, onBulkApply }) {
  const canEdit = canEditProp !== undefined ? canEditProp : isAdmin;
  const isGroup = pk.startsWith("grp:"); // a grouped booking (multi-day/multi-facility/etc.)
  const parts = pk.split("_");
  const startH = parseFloat(parts[parts.length-1]);
  const dn = parts[parts.length-2]||"";
  const facId = !isGroup && parts.length>2 ? parts[0] : null;
  const fac = facId ? FACILITIES.find(f=>f.id===facId) : null;

  const [bulkTime, setBulkTime] = useState(Number.isNaN(startH)?(bkgs[0]?.start_hour??9):startH);
  const [bulkDur, setBulkDur] = useState(bkgs[0]?.duration ?? 2);
  const [bulkFac, setBulkFac] = useState(bkgs[0]?.facility_id ?? "");
  const [cancelFrom, setCancelFrom] = useState("");

  const sorted = [...bkgs].sort((a,b)=>a.date.localeCompare(b.date));

  const si = {border:"1px solid #e2e8f0",borderRadius:6,padding:"4px 8px",fontSize:13,fontFamily:"inherit",background:"#fff"};

  return (
    <Modal title={isGroup?`🔗 Grouped booking — ${name}`:`Pattern: ${dn} ${fmtTime(startH)} — ${name}`} onClose={onClose}>
      <div style={{fontSize:12,color:"#64748b",marginBottom:12}}>
        {bkgs.length} booking{bkgs.length!==1?"s":""} · {email}
        {fac && <span> · {fac.name}</span>}
        {isGroup && <span> · created together</span>}
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
                {venueFacilities(bulkFac).map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
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

export function OneOffModal({ email, name, bkgs, onClose }) {
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

export function ScheduleSummaryModal({ bookings, isAdmin, loggedInEmail, onBulkApply, onBulkStatusChange, onClose, inline=false, aliasNames={}, emailAliases={} }) {
  const [facSensitive, setFacSensitive] = useState(false);
  const [splitPatterns, setSplitPatterns] = useState(new Set());
  const [patternModal, setPatternModal] = useState(null);
  const [oneOffModalData, setOneOffModalData] = useState(null);
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

  const active = bookings.filter(b=>(["approved","cpsa_confirmed","cpsa_review_needed","pending_cpsa","queued_cpsa","pending_amua","amua_submit","pending",...COUNCIL_STAGE_STATUSES].includes(b.status)||b.invoiced)&&!isAdminBooking(b));
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
  const allStatuses = [...new Set(active.map(b=>b.status))];

  const thS2={textAlign:"left",padding:"6px 8px",fontWeight:600,color:"#64748b",fontSize:12,borderBottom:"1px solid #e2e8f0"};
  const tdS2={padding:"6px 8px",verticalAlign:"top",fontSize:13};

  function renderChips(email, nameDisplay, recurring) {
    const ec = emailColor(email);
    const canEdit = isAdmin || email.toLowerCase() === loggedInEmail?.toLowerCase();
    const chips = [];
    for (const [pk, bkgs] of recurring) {
      if (pk.startsWith("grp:")) {
        // A grouped booking (recurrence / multi-day / multi-facility) created together.
        const dates=bkgs.map(b=>b.date).filter(Boolean).sort();
        const facIds=[...new Set(bkgs.map(b=>b.facility_id))];
        const facLabel=facIds.map(fid=>{const f=FACILITIES.find(x=>x.id===fid);return f?(f.name.includes("Field")?f.name.replace("Field ","Fld "):f.name.split("–")[0].trim().slice(0,6)):fid;}).join(", ");
        const uniform=bkgs.every(b=>b.start_hour===bkgs[0].start_hour&&b.duration===bkgs[0].duration&&b.facility_id===bkgs[0].facility_id);
        chips.push(
          <span key={pk} title="Grouped booking" onClick={()=>setPatternModal({email,name:nameDisplay,pk,bkgs,canEdit})}
            style={{display:"inline-flex",alignItems:"center",gap:3,background:ec+"22",color:ec,border:`1px solid ${ec}55`,borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:600,whiteSpace:"nowrap",cursor:"pointer"}}>
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

  // A function (not a component) so the panel isn't remounted on every render.
  const Wrapper = children => inline
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
      </>)}
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
              {visibleFacilities().map(f=><Fragment key={f.id}>{chip(facSel.includes(f.id),()=>toggle(facSel,setFacSel,f.id),f.name,f.color,"#fff")}</Fragment>)}
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

export function SummaryTab({ bookings, loggedInEmail, facilityRates = {}, pricingConditions = [], onAddPricingCondition, onUpdatePricingCondition, onRemovePricingCondition, isAdmin = false, approxPlayers = {}, onUpdateApproxPlayers, approxDurations = {}, onUpdateApproxDuration, onUpdateFacilityRate, pricingMode = "hourly", onSetPricingMode, onProposeMerge, onBulkApply, onMarkInvoiced, onMarkAdjustmentSettled, bookerFilter=new Set(), profiles={}, emailAliases={}, aliasNames={}, onCreateOfficialInvoice, onEmailInvoice, onFilterChange=null, loadRequest=null }) {
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
  const [showUnusedFacs, setShowUnusedFacs] = useState(false);   // facilities with no bookings in the period
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
  // Invoices are keyed by a booker's main email, which may never have booked itself.
  bookings.filter(b=>!isAdminBooking(b)&&b.email).forEach(b=>{
    const k = ((emailAliases||{})[b.email.toLowerCase()] || "").toLowerCase();
    if (k && !bookerNameMap[k]) bookerNameMap[k] = (aliasNames||{})[k] || b.name;
  });
  // A booker with linked secondary emails is invoiced once, under their main email: every
  // invoicing comparison goes through invKey so bookings made from any linked address
  // land on the same invoice. (A hoisted declaration: used before canonEmail is defined.)
  function invKey(em) { return ((emailAliases||{})[(em||"").toLowerCase()] || em || "").toLowerCase(); }
  // Fraction (0..1) of a cost-split booking allocated to a booker, counting weights listed
  // under any of their linked emails. null ⇒ booking isn't split (the primary pays in full).
  function invSplitShare(b, key) {
    const parts = parseSplit(b.system_notes);
    if (!parts) return null;
    const total = parts.reduce((t,p)=>t+p.weight,0) || 1;
    return parts.filter(p=>invKey(p.email)===key).reduce((t,p)=>t+p.weight,0) / total;
  }
  const allInvoiceEmails = [...new Set(activeForInvoice.map(b=>b.email).filter(Boolean).map(invKey))].sort();

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
  // Canonical primary email — folds linked secondary bookers onto their primary so
  // the summary groups them as one booker (matches the rest of the app).
  const canonEmail = em => (emailAliases[(em||"").toLowerCase()] || (em||"").toLowerCase());

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
    // A manually-set function/room price overrides the hourly calculation entirely.
    const fixed = parseFunctionCost(b.system_notes);
    if (fixed != null) return fixed;
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
    const key = canonEmail(b.email);
    if (!byEmail[key]) byEmail[key] = { email:key, name:b.name, daytime:0, evening:0, total:0, bookings:0, dayBkgs:0, eveBkgs:0, cost:0, dayCost:0, eveCost:0 };
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
    const k = canonEmail(b.email);
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
  visibleFacilities().forEach(fac => { byFacility[fac.id] = { fac, dayHrs: 0, eveningHrs: 0, bkgCount: 0, cost: 0 }; });
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
  const anyRates  = visibleFacilities().some(f => { const r = getFacRates(f.id); return r.day > 0 || r.evening > 0; });

  function fmtHrs(h) { return h===0?"0h" : h%1===0?`${h}h`:`${Math.floor(h)}h ${Math.round((h%1)*60)}m`; }
  function getPlayers(email) { return approxPlayers[email.toLowerCase()] || 0; }
  function canEditPlayers(email) { return isAdmin || (loggedInEmail && email.toLowerCase() === loggedInEmail.toLowerCase()); }
  function canEditDuration(email) { return isAdmin || (loggedInEmail && email.toLowerCase() === loggedInEmail.toLowerCase()); }

  // ── Invoice helpers ──────────────────────────────────────────────────────
  // Full (pre-share) cost of one booking: a manual function price if set, else hourly.
  function fullLineCost(b) {
    const fixed = parseFunctionCost(b.system_notes);
    if (fixed != null) return fixed;
    const { day, evening } = splitHours(b);
    const rates = bRates(b);
    return day * rates.day + evening * rates.evening;
  }
  // A booking is "special" (itemised on its own, never merged into shared day/evening
  // rate buckets) when it has a manual price or a partial cost-split share.
  function isSpecialLine(b) {
    return parseFunctionCost(b.system_notes) != null || b.__splitShare != null
      || (parseSlotLink(b.system_notes)?.share ?? 1) < 1;
  }
  // One itemised line for a fixed-price and/or cost-split booking, applying the
  // per-booker share carried on b.__splitShare (set when building per-booker scopes).
  function specialLineFor(b) {
    // Two independent reductions can apply: a shared slot (this team's fraction of a
    // field used by several teams) and a cost split (co-bookers on one booking).
    const slotShare = parseSlotLink(b.system_notes)?.share ?? 1;
    const share = b.__splitShare ?? 1;
    const full = fullLineCost(b);
    const fac = FACILITIES.find(f => f.id === b.facility_id);
    const timeStr = `${fmtTime(b.start_hour)}–${fmtTime(b.start_hour + b.duration)}`;
    const fixed = parseFunctionCost(b.system_notes) != null;
    const slotNote = slotShare < 1 ? ` · shared field, ${Math.round(slotShare*100)}% of ${fmtCost(full)}` : "";
    const shareNote = share < 1 ? ` · split ${Math.round(share*100)}%` : "";
    const cost = full * slotShare * share;
    const sharedNote = [
      slotShare < 1 ? `shared field, ${Math.round(slotShare*100)}% of ${fmtCost(full)}` : "",
      share < 1 ? `cost split, ${Math.round(share*100)}% share` : "",
    ].filter(Boolean).join("; ");
    return {
      date:   b.date,
      facilityId: b.facility_id,
      desc:   `${fac?.name||b.facility_id} · ${timeStr}`,
      detail: `${b.purpose||""}${fixed?" · fixed price":""}${slotNote}${shareNote}`,
      hours:  b.duration,
      rate:   fixed || !b.duration ? null : cost / b.duration,
      fixedPrice: fixed || undefined,
      sharedNote: sharedNote || undefined,
      cost,
    };
  }
  function buildInvoiceLines(bkgs, detail) {
    // Council application fee shares, charged once the application has been sent.
    const feeBkgs = bkgs.map(b => ({ b, app: parseCouncilApp(b.system_notes) })).filter(x => x.app && x.app.fee > 0);
    const feeLines = detail === "grouped"
      ? Object.values(feeBkgs.reduce((g, { b, app }) => {
          const k = b.facility_id; const fac = FACILITIES.find(f => f.id === k);
          g[k] ||= { desc: `Council application fee – ${fac?.name || k}`, facilityId: k, detail: "", hours: null, rate: null, fixedPrice: true, cost: 0, apps: new Set() };
          g[k].cost += app.fee; g[k].apps.add(app.id); return g; }, {}))
          .map(({ apps, ...l }) => ({ ...l, cost: Math.round(l.cost * 100) / 100, detail: `$${COUNCIL_APPLICATION_FEE} per field per application, shared · ${[...apps].join(", ")}` }))
      : feeBkgs.map(({ b, app }) => ({ date: b.date, facilityId: b.facility_id, hours: null, rate: null, fixedPrice: true,
          desc: `Council application fee · ${FACILITIES.find(f => f.id === b.facility_id)?.name || b.facility_id}`,
          detail: `Application ${app.id} ($${COUNCIL_APPLICATION_FEE} per field, shared)`, cost: Math.round(app.fee * 100) / 100 }));
    return [...buildInvoiceLinesCore(bkgs, detail), ...feeLines];
  }
  function buildInvoiceLinesCore(bkgs, detail) {
    const special = bkgs.filter(isSpecialLine);
    const plain   = bkgs.filter(b => !isSpecialLine(b));
    const specialLines = special.map(specialLineFor);
    if (detail === "grouped") {
      const groups = {};
      plain.forEach(b => {
        const { day, evening } = splitHours(b);
        const rates = bRates(b);
        const fac = FACILITIES.find(f => f.id === b.facility_id);
        const facName = fac?.name || b.facility_id;
        if (day > 0) {
          const key = b.facility_id + ":day";
          if (!groups[key]) groups[key] = { desc:`${facName} – Daytime`, facilityId:b.facility_id, hours:0, rate:rates.day, cost:0 };
          groups[key].hours += day; groups[key].cost += day * rates.day;
        }
        if (evening > 0) {
          const key = b.facility_id + ":evening";
          if (!groups[key]) groups[key] = { desc:`${facName} – Evening`, facilityId:b.facility_id, hours:0, rate:rates.evening, cost:0 };
          groups[key].hours += evening; groups[key].cost += evening * rates.evening;
        }
      });
      const groupedLines = Object.values(groups).map(g => ({
        desc:  g.desc,
        facilityId: g.facilityId,
        detail:`${fmtHrs(g.hours)} @ ${fmtCost(g.rate)}/hr`,
        hours: g.hours,
        rate:  g.rate,
        cost:  g.cost,
      }));
      return [...groupedLines, ...specialLines];
    } else {
      const indiv = plain.map(b => {
        const { day, evening } = splitHours(b);
        const rates = bRates(b);
        const fac = FACILITIES.find(f => f.id === b.facility_id);
        const cost = day * rates.day + evening * rates.evening;
        const timeStr = `${fmtTime(b.start_hour)}–${fmtTime(b.start_hour + b.duration)}`;
        const splitNote = day>0&&evening>0 ? ` (${fmtHrs(day)} day + ${fmtHrs(evening)} eve)` : "";
        return {
          date:   b.date,
          facilityId: b.facility_id,
          desc:   `${fac?.name||b.facility_id} · ${timeStr}`,
          detail: `${b.purpose}${splitNote}`,
          hours:  day + evening,
          rate:   day + evening ? cost / (day + evening) : null,
          cost,
        };
      });
      return [...indiv, ...specialLines].sort((a,b)=>(a.date||"").localeCompare(b.date||"") || a.desc.localeCompare(b.desc));
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
        date:    b.date,
        facilityId: b.facility_id,
        desc:    `[${signedCost>0?"Invoice adj.":"Credit adj."}] ${fac?.name||b.facility_id}`,
        detail:  `GTEC amendment: billed ${origTimeStr} ${snap.duration}h → amended ${timeStr} ${b.duration}h (${bs||"pending"})`,
        hours:   b.duration - snap.duration,
        rate:    null,
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

  function buildInvoiceHtml({ bookerName, bookerEmail, lines, gstMode, dateRange, invNumber, docType="invoice", docName="", preview=false, paginate=true }) {
    const docLabel = docType === "purchase_order" ? "PURCHASE ORDER" : "INVOICE";
    const { pre, gst, total } = gstAmounts(lines.reduce((s, l) => s + l.cost, 0), gstMode);
    return renderInvoiceDocHtml({
      title: docName || `${docLabel} ${invNumber}`,
      docLabel, docId: invNumber, bankRef: invNumber, dateStr: todayKey(),
      billToName: bookerName, billToEmail: bookerEmail,
      periodStr: dateRange.from && dateRange.to ? `${fmtDate(dateRange.from)} – ${fmtDate(dateRange.to)}` : "All periods",
      lines, pre, gst, total, gstMode,
      previewNotice: preview, paginate,
      footNote: `${AMUA_INFO.bank ? `Bank: ${AMUA_INFO.bank} · ` : ""}Generated by FacilityBook`,
    });
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
      ? mismatchAdjustments.filter(b => invKey(b.email) === invKey(bookerEmail))
      : [];
    const lines = [
      ...buildInvoiceLines(bkgsForInvoice, invDetail),
      ...buildAdjustmentLines(adjBkgs),
    ];
    const dateRange = { from: dateFrom, to: dateTo };
    const baseName = invoiceBaseName(bkgsForInvoice);
    const invNumber = genBankRef({ type: invDocType==="purchase_order"?"P":"I", dateFrom, dateTo, recipientCode: recipientCodeFor(bookerEmail) });
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
      const csvRows = lines.map(l => [invNumber, bookerName, bookerEmail, invLineLabel(l), l.detail, l.cost.toFixed(2)].map(esc).join(","));
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

  // Email each booker an unofficial preview of their draft invoice, so they can check it
  // before anything official is issued. Deliberately side-effect free: it never marks
  // bookings invoiced and never creates a billing record, even when "mark invoiced" is
  // ticked for the export buttons. Emailed as one continuous sheet — mail has no pages.
  async function emailInvoicePreviews(scopes) {
    if (!onEmailInvoice) return;
    const items = scopes.map(s => {
      const adjBkgs = invIncludeAdjustments
        ? mismatchAdjustments.filter(b => invKey(b.email) === invKey(s.email))
        : [];
      const lines = [...buildInvoiceLines(s.bkgs, invDetail), ...buildAdjustmentLines(adjBkgs)];
      const dateRange = { from: dateFrom, to: dateTo };
      const invNumber = genBankRef({ type: invDocType==="purchase_order"?"P":"I", dateFrom, dateTo, recipientCode: recipientCodeFor(s.email) });
      const { total } = gstAmounts(lines.reduce((a,l)=>a+l.cost,0), invGst);
      const period = dateRange.from && dateRange.to ? `${fmtDate(dateRange.from)} – ${fmtDate(dateRange.to)}` : "all periods";
      return {
        to: s.email, name: s.name, total, lineCount: lines.length,
        subject: `Draft ${invDocType==="purchase_order"?"purchase order":"invoice"} for review — ${period}`,
        html: buildInvoiceHtml({
          bookerName: s.name, bookerEmail: s.email, lines, gstMode: invGst, dateRange,
          invNumber, docType: invDocType, docName: invoiceBaseName(s.bkgs),
          preview: true, paginate: false,
        }),
      };
    }).filter(it => it.to && it.lineCount > 0);
    if (!items.length) return;
    await onEmailInvoice(items);
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
  // Resolve a 3-char recipient code for a booker/vendor. An admin override on the
  // profile (billingCode) wins; otherwise it's derived from the official name and kept
  // unique against reserved codes, every profile's code, and the rest of this batch.
  function recipientCodeFor(email, batchRecs=[]) {
    const e = (email||"").toLowerCase();
    if (PROVIDERS[e]) return PROVIDERS[e].recipientCode;
    if (e === "combined" || e === "") return "CMB";
    const canonKey = (emailAliases[e] || e);
    const prof = (profiles||{})[canonKey] || {};
    if (prof.billingCode) return cleanRecipientCode(prof.billingCode);
    const used = [RECIPIENT_CODE_AMUA, ...Object.values(PROVIDERS).map(p=>p.recipientCode),
      ...Object.values(profiles||{}).map(p=>p?.billingCode).filter(Boolean),
      ...batchRecs.map(r=>r.recipientCode).filter(Boolean)];
    const name = prof.officialName || prof.fullName || (aliasNames||{})[canonKey] || canonKey.split("@")[0];
    return deriveRecipientCode(name, used);
  }
  function buildInvoiceRecord(scope, allRecs) {
    const canonKey = (emailAliases[scope.email] || scope.email).toLowerCase();
    const prof = (profiles||{})[canonKey] || {};
    const dates = scope.bkgs.map(b=>b.date).filter(Boolean).sort();
    const periodFrom = dateFrom || dates[0] || todayKey();
    const periodTo   = dateTo   || dates[dates.length-1] || todayKey();
    const recipientCode = recipientCodeFor(scope.email, allRecs);
    const invId = genBankRef({ type:"I", dateFrom:periodFrom, dateTo:periodTo, recipientCode, existingRefs: allRecs.map(r=>r.id) });
    const groupedLines    = buildInvoiceLines(scope.bkgs, "grouped");
    const individualLines = buildInvoiceLines(scope.bkgs, "individual");

    // Pending credits for this booker — negative lines that discount the total
    const creditBkgs = bookings.filter(b => {
      if (invKey(b.email) !== invKey(scope.email)) return false;
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
    return {
      id: invId,
      bankRef: invId,
      recipientCode,
      type: "invoice",
      orderName: invOrderName || "",
      createdAt: new Date().toISOString(),
      dateFrom: periodFrom,
      dateTo:   periodTo,
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

  // Build one PO per facility provider (AMUA → GTEC, AMUA → St Cuthbert's, …) covering
  // all booker scopes. Each PO carries only the lines for its provider's facilities, as
  // one entry per booker with their subtotal plus the invoice reference.
  function buildProviderPoRecords(scopes, invoiceRecords, allRecs) {
    const lineProvider = l => providerOfFacility(l.facilityId);
    const providerIds = [...new Set(invoiceRecords.flatMap(inv => (inv.lines||[]).map(lineProvider)))];
    const pos = [];
    for (const pid of providerIds) {
      const prov = PROVIDERS[pid] || PROVIDERS.gtec;
      const bkgs = scopes.flatMap(s=>s.bkgs).filter(b => providerOfFacility(b.facility_id) === pid);
      const dates = bkgs.map(b=>b.date).filter(Boolean).sort();
      const poFrom = dateFrom || dates[0] || todayKey();
      const poTo   = dateTo   || dates[dates.length-1] || todayKey();
      const recipientCode = prov.recipientCode;
      const poId = genBankRef({ type:"P", dateFrom:poFrom, dateTo:poTo, recipientCode,
        existingRefs: [...allRecs.map(r=>r.id), ...invoiceRecords.map(r=>r.id), ...pos.map(r=>r.id)] });
      const linked = [];
      let subtotal = 0, gst = 0, total = 0;
      const poLines = scopes.map(scope => {
        const inv = invoiceRecords.find(r=>r.bookerEmail===scope.email);
        const lines = (inv?.lines||[]).filter(l => lineProvider(l) === pid);
        if (!lines.length) return null;
        linked.push(inv);
        const canonKey = (emailAliases[scope.email] || scope.email).toLowerCase();
        const prof = (profiles||{})[canonKey] || {};
        const name = prof.fullName || bookerNameMap[scope.email?.toLowerCase()] || scope.email?.split("@")[0] || "Unknown";
        const amt = gstAmounts(lines.reduce((t,l)=>t+l.cost,0), invGst);
        subtotal += amt.pre; gst += amt.gst; total += amt.total;
        const hours = lines.reduce((t,l)=>t+(l.hours||0),0);
        return { desc:`${name}${inv?.id?` · ${inv.id}`:""}`, detail: inv?.id||"", hours: hours || null, rate: null, cost: amt.pre };
      }).filter(Boolean);
      pos.push({
        id: poId,
        bankRef: poId,
        recipientCode,
        type: "purchase_order",
        provider: pid,
        orderName: invOrderName || "",
        createdAt: new Date().toISOString(),
        dateFrom: poFrom,
        dateTo:   poTo,
        bookerEmail: pid,
        bookerName:  prov.name,
        bookerAddress: prov.address,
        bookerGst:   prov.gstNumber,
        bookingIds:  bkgs.map(b=>b.id),
        linkedInvoiceIds: linked.map(r=>r.id),
        lines: poLines,
        // Itemised view: this provider's bookings across all bookers, prefixed with the
        // booker name, reusing each invoice's own per-booking lines (so totals reconcile).
        individualLines: linked.flatMap(inv =>
          (inv.individualLines||[]).filter(l => lineProvider(l) === pid)
            .map(l => ({ ...l, desc: `${inv.bookerName} · ${l.desc||l.description||l.label||""}` }))
        ),
        subtotal, gst, total, gstMode: invGst,
        status: "draft",
        gtecInvoiceNumber: "",
        notes: "",
      });
    }
    return pos;
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
    const sel = [...new Set([...invSelectedEmails].map(invKey))];
    // A booking is in scope for a selected booker if they're the primary OR a co-booker
    // on a cost-split. This lets co-bookers be invoiced their share even when they aren't
    // the primary on the booking.
    const isSelFor = (b, e) => {
      const el = invKey(e);
      if (invKey(b.email) === el) return true;
      const sh = invSplitShare(b, el);
      return sh != null && sh > 0;
    };
    const pool = sel.length > 0
      ? activeForInvoice.filter(b => sel.some(e => isSelFor(b, e)))
      : activeForInvoice;
    if (invScope === "combined" || sel.length <= 1) {
      // Combined / single invoice: everyone is billed together, so the full cost of a
      // split booking appears once (no per-booker share is applied).
      const email = sel.length === 1 ? sel[0] : "combined";
      const name = sel.length === 1 ? (invMode==="official" ? officialBookerName(sel[0]) : bookerNameMap[sel[0].toLowerCase()] || sel[0]) : "All Bookers";
      return [{ name, email, bkgs: pool }];
    }
    return sel.map(e => {
      const el = invKey(e);
      const bkgs = [];
      pool.forEach(b => {
        const share = invSplitShare(b, el);
        if (share != null) {                       // split booking → bill this booker their share
          if (share > 0) bkgs.push({ ...b, __splitShare: share });
        } else if (invKey(b.email) === el) {       // unsplit booking → primary pays in full
          bkgs.push(b);
        }
      });
      return {
        name: invMode==="official" ? officialBookerName(e) : (bookerNameMap[e.toLowerCase()] || e),
        email: e,
        bkgs,
      };
    });
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

  // Phones: the period and booker chips each scroll in one row instead of wrapping into many.
  const narrow = window.innerWidth<768;
  const chipRow = narrow ? { flexWrap:"nowrap", overflowX:"auto", scrollbarWidth:"none", WebkitOverflowScrolling:"touch", paddingBottom:2 } : { flexWrap:"wrap" };
  const thS = { textAlign:"left", padding:"10px 14px", fontSize:11, fontWeight:700, color:"#94a3b8", textTransform:"uppercase", letterSpacing:"0.06em", borderBottom:"2px solid #f1f5f9", whiteSpace:"nowrap" };
  const tdS = { padding:"10px 14px", fontSize:13, color:"#0f172a", borderBottom:"1px solid #f8fafc", verticalAlign:"middle" };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:24 }}>
      {/* Controls */}
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        {/* Date range presets */}
        <div style={{ display:"flex", alignItems:"center", gap:6, ...chipRow }}>
          <span style={{ fontSize:12, fontWeight:600, color:"#64748b", marginRight:2 }}>Period:</span>
          {PRESETS.map(p=>(
            <button key={p.key} onClick={()=>setPreset(p.key)}
              style={{ flexShrink:0, whiteSpace:"nowrap", padding:"5px 12px", borderRadius:8, border: preset===p.key?"1.5px solid #0f172a":"1.5px solid #e2e8f0",
                background: preset===p.key?"#0f172a":"#f8fafc", color: preset===p.key?"#fff":"#475569",
                fontWeight:600, fontSize:12, cursor:"pointer", fontFamily:"inherit" }}>
              {p.label}
            </button>
          ))}
          <label style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,fontSize:12,color:"#475569",cursor:"pointer",userSelect:"none",flexShrink:0,whiteSpace:"nowrap"}} title="Include or exclude already-invoiced bookings in the summary totals">
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
          <div style={{display:"flex",gap:6,alignItems:"center",minWidth:0,...(narrow?{...chipRow,width:"100%"}:{display:"contents"})}}>
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
          </div>
          <div style={{marginLeft:"auto",display:"flex",gap:6,...(narrow?{width:"100%"}:{})}}>
            <button onClick={exportCSV} style={S.btn({ background:"#0f172a", color:"#fff", display:"flex", alignItems:"center", gap:6, ...(narrow?{flex:1,justifyContent:"center"}:{}) })}>
              ⬇ Export All Data (CSV)
            </button>
            {anyRates && (
              <button onClick={openInvoice} style={S.btn({ background:"#15803d", color:"#fff", display:"flex", alignItems:"center", gap:6, ...(narrow?{flex:1,justifyContent:"center"}:{}) })}>
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
      <div style={{ display:"grid", gridTemplateColumns:window.innerWidth<768?"repeat(3,minmax(0,1fr))":"repeat(auto-fit,minmax(140px,1fr))", gap:window.innerWidth<768?6:10 }}>
        {[
          { label:"Bookings",      value:active.length,         icon:"📋" },
          { label:"Total Hours",   value:fmtHrs(totalHrs),      icon:"⏱" },
          { label:"Daytime Hrs",   value:fmtHrs(totalDaytime),  icon:"☀️",  sub:"before 5:30 PM" },
          { label:"Evening Hrs",   value:fmtHrs(totalEvening),  icon:"🌙",  sub:"from 5:30 PM" },
          { label:"Unique Bookers",value:rows.length,           icon:"👥" },
          ...(anyRates ? [{ label:"Total Cost", value:fmtCost(totalCost), icon:"💰", highlight:true }] : []),
        ].map(c=>(
          window.innerWidth<768 ? (
          // Phones: three compact tiles a row (value, then icon + label).
          <div key={c.label} title={c.sub||c.label} style={{ background: c.highlight?"#f0fdf4":"#fff", border:`1px solid ${c.highlight?"#bbf7d0":"#f1f5f9"}`, borderRadius:10, padding:"8px 9px", minWidth:0 }}>
            <div style={{ fontSize:15, fontWeight:800, color: c.highlight?"#15803d":"#0f172a", letterSpacing:"-0.03em", whiteSpace:"nowrap" }}>{c.value}</div>
            <div style={{ fontSize:10.5, fontWeight:600, color:"#64748b", lineHeight:1.25 }}>{c.icon} {c.label}</div>
          </div>
          ) : (
          // Desktop: one compact row of figures (value, then icon + label).
          <div key={c.label} title={c.sub||undefined} style={{ background: c.highlight?"#f0fdf4":"#fff", border:`1px solid ${c.highlight?"#bbf7d0":"#f1f5f9"}`, borderRadius:10, padding:"10px 14px", boxShadow:"0 1px 4px rgba(0,0,0,0.04)" }}>
            <div style={{ fontSize:20, fontWeight:800, color: c.highlight?"#15803d":"#0f172a", letterSpacing:"-0.03em", whiteSpace:"nowrap" }}>{c.value}</div>
            <div style={{ fontSize:12, fontWeight:600, color:"#64748b", whiteSpace:"nowrap" }}>{c.icon} {c.label}{c.sub&&<span style={{ fontWeight:400, color:"#94a3b8" }}> · {c.sub}</span>}</div>
          </div>
          )
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
                {visibleFacilities().map(fac => {
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
          {/* Only facilities used in the period; the rest (unused council fields etc.) on request. */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))", gap:10 }}>
            {facCosts.filter(x => showUnusedFacs || x.bkgCount > 0).map(({ fac, dayHrs, eveningHrs, hours, bkgCount, rates, cost }) => {
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
          {(()=>{ const n = facCosts.filter(x => x.bkgCount === 0).length; return n > 0 && (
            <button onClick={()=>setShowUnusedFacs(v=>!v)}
              style={{ marginTop:8, background:"none", border:"none", padding:0, color:"#64748b", fontSize:12, fontWeight:600, cursor:"pointer", fontFamily:"inherit" }}>
              {showUnusedFacs ? "Hide facilities with no bookings" : `+ ${n} facilit${n===1?"y":"ies"} with no bookings in this period`}
            </button>); })()}
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
                                          {facCellLabel(fac)}
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
                                      <td style={{padding:"3px 8px"}}><Badge status={b.status} wf={workflowOf(b.facility_id)}/>{b.invoiced&&<span style={{marginLeft:3,fontSize:9,fontWeight:700,color:"#5b21b6"}}>🧾</span>}</td>
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
          // Build pattern groups per email using overlap-aware grouping (canonical
          // primary so linked secondary bookers fold into one row).
          const canonEmail = em => (emailAliases[(em||"").toLowerCase()] || (em||"").toLowerCase());
          const patternMap = buildOverlapPatternMap(active, scheduleFacSensitive, canonEmail);

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
                                  {f.field==="facility_id"&&<select value={f.resolvedVal} onChange={e=>setRes(f.field,e.target.value)} style={si}>{visibleFacilities().map(f2=><option key={f2.id} value={f2.id}>{f2.name}</option>)}</select>}
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
                                let label;
                                if(pk.startsWith("grp:")){
                                  const dates=bkgs.map(b=>b.date).filter(Boolean).sort();
                                  const facIds=[...new Set(bkgs.map(b=>b.facility_id))];
                                  const facLabel=facIds.map(fid=>{const f=FACILITIES.find(x=>x.id===fid);return f?(f.name.includes("Field")?f.name.replace("Field ","Fld "):f.name.split("–")[0].trim().slice(0,6)):fid;}).join(", ");
                                  const uniform=bkgs.every(b=>b.start_hour===bkgs[0].start_hour);
                                  label=`🔗 ${fmtDateShort(dates[0])}–${fmtDateShort(dates[dates.length-1])} · ${facLabel}${uniform?` · ${fmtTime(bkgs[0].start_hour)}`:""} ×${bkgs.length}`;
                                } else {
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
                                  label = `${dn} ${fmtTime(startH)} · ${durLabel} · ${facLabel} ×${bkgs.length}`;
                                }
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
                                    {facCellLabel(fac)||fid}
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
                    if (invKey(b.email) !== invKey(s.email)) return false;
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
                      {onEmailInvoice&&(()=>{
                        const recipients = scopes.filter(s=>s.email&&s.bkgs.length);
                        const label = recipients.length===1 ? recipients[0].name || recipients[0].email : `${recipients.length} bookers`;
                        return (
                          <button disabled={!recipients.length}
                            title={recipients.length
                              ? `Email an unofficial preview to ${recipients.map(r=>r.email).join(", ")}. Nothing is marked invoiced and no billing record is created.`
                              : "No bookers in the current selection"}
                            onClick={()=>{
                              if(!window.confirm(`Email an unofficial invoice preview to ${label}?\n\nThis is marked "not a tax invoice" and does not mark anything invoiced.`)) return;
                              emailInvoicePreviews(recipients);
                            }}
                            style={S.btn({background:recipients.length?"#0369a1":"#cbd5e1",color:"#fff",gap:6,display:"flex",alignItems:"center",cursor:recipients.length?"pointer":"not-allowed"})}>
                            ✉ Email preview
                          </button>
                        );
                      })()}
                    </div>
                    <div style={{fontSize:11,color:"#94a3b8",marginTop:8}}>
                      Previews are clearly marked unofficial, don&apos;t mark bookings invoiced and create no billing record.
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
                        {/* One PO per provider whose facilities appear in these bookings. */}
                        {[...new Set(activeForInvoice.filter(b=>sel.includes(invKey(b.email))).map(b=>providerOfFacility(b.facility_id)))].map((pid,i)=>(
                          <div key={pid} style={{display:"flex",gap:6,alignItems:"center",marginTop:i?0:2,paddingTop:i?0:6,borderTop:i?"none":"1px dashed #bae6fd"}}>
                            <span style={{fontFamily:"monospace",fontSize:10,background:"#dbeafe",padding:"1px 5px",borderRadius:4,color:"#1d4ed8"}}>PO</span>
                            <span style={{fontWeight:600}}>{(PROVIDERS[pid]||PROVIDERS.gtec).name}</span>
                            <span style={{color:"#64748b",fontSize:11}}>← combined PO for its facilities</span>
                          </div>
                        ))}
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
                            bkgs: activeForInvoice.filter(b=>invKey(b.email)===e),
                          })).filter(s=>s.bkgs.length>0);
                      const invoiceRecords = officialScopes.map(s=>{
                        const rec = buildInvoiceRecord(s, allRecs);
                        allRecs.push(rec);
                        return rec;
                      });
                      const poRecords = buildProviderPoRecords(officialScopes, invoiceRecords, allRecs);
                      onCreateOfficialInvoice([...invoiceRecords, ...poRecords], null); // pass null — no immediate invoicing
                      setShowInvoice(false);
                    }} disabled={!officialReady}
                    style={S.btn({background:officialReady?"#4338ca":"#94a3b8",color:"#fff",gap:6,display:"flex",alignItems:"center",fontWeight:700,cursor:officialReady?"pointer":"not-allowed"})}>
                      📋 Create Invoices + GTEC PO
                    </button>
                    <div style={{fontSize:10,color:"#94a3b8",marginTop:6}}>
                      Creates {invSelectedEmails.size||allInvoiceEmails.length} booker invoice{(invSelectedEmails.size||allInvoiceEmails.length)!==1?"s":""} + one PO per facility provider ·
                      Bookings marked invoiced only when record leaves Draft status.
                    </div>
                  </div>
                </div>
              )}

              {/* Settle pending mismatch billing adjustments (draft mode only) */}
              {invMode==="draft" && isAdmin && invIncludeAdjustments && mismatchAdjustments.length>0 && onMarkAdjustmentSettled && (()=>{
                const visibleAdj = mismatchAdjustments.filter(b=>{
                  const sel=[...invSelectedEmails];
                  return sel.length===0 || sel.some(e=>invKey(b.email)===invKey(e));
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