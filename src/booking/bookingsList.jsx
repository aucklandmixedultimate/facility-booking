// One bookings list on the Bookings tab: Grouped (schedule summary) or Itemised, with its own
// column filters, sort and view. The tab shows two: "Filtered Bookings" (the page's 📍 Fields
// selection) and "All Bookings" (its own location filter). `venueOk(facilityId)` says which
// facilities a list covers; the booker pills above both lists are shared.
import { useState } from "react";
import { Badge, CPSA_FIELD_IDS, CopyableTable, FACILITIES, S, STATUS_META, T, TableViewToggle, emailColor, fmt24, fmtCost, fmtDateShort, getBillingDrift, groupStatusLabel, isAdminBooking, parseMismatchNote, todayKey, useTableView, visibleFacilities, workflowOf } from "./core.jsx";
import { DateRangePicker } from "./modals.jsx";
import { ScheduleSummaryModal } from "./schedule.jsx";

export function BookingsList({ title, filterEl, venueOk, viewKey, bookings, loading, isAdmin, isMobile, loggedInEmail, allClashes, bookerGroups, emailLegend,
  canonEmail, displayNameFor, aliasNames, emailAliases, facilityRates, knownBookers, listBookerFilter, setListBookerFilter, toggleBooker,
  addPricingCondition, handleBulkApply, handleBulkReassign, handleBulkStatusChange, queueMultiForRemoval, setViewing }) {
  const [listView, setListView] = useTableView(viewKey);   // grouped | itemised
  const [listShowClashes, setListShowClashes] = useState(false);
  const [showBookerPicker, setShowBookerPicker] = useState(false);
  // Date-range filter defaults to "today onwards"; clear From to see history.
  const [listDateFrom,    setListDateFrom]      = useState(()=>todayKey());
  const [listDateTo,      setListDateTo]        = useState("");
  const [listStatusFilter,setListStatusFilter]  = useState("all");
  const [listColPurpose,  setListColPurpose]    = useState("");
  const [listColFacility, setListColFacility]   = useState("all");
  const [listSortCol,     setListSortCol]       = useState("date");
  const [listSortDir,     setListSortDir]       = useState("asc");
  const facilityOptions = visibleFacilities().filter(f => venueOk(f.id));
  if (loading) return <div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>;

  // Canonical booker list (linked secondaries fold into their primary) — the
  // same source the header pills use, so the column filter shows one chip per booker.
  const bookerAllEmails = [...new Set(emailLegend.flatMap(p=>[...bookerGroups[p]]))];
  const clashAdminIds = new Set(allClashes.map(c=>c.admin.id));
  const clashUserIds  = new Set(allClashes.map(c=>c.user.id));
  const allClashIds   = new Set([...clashAdminIds,...clashUserIds]);
  const listDir = listSortDir==="asc"?1:-1;
  let visible = [...bookings]
    .filter(b => !isAdminBooking(b))
    .filter(b => venueOk(b.facility_id))
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
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center",marginBottom:8}}>
        <h3 style={{margin:0,fontSize:16,fontWeight:800,color:T.ink}}>{title}</h3>
        {filterEl}
      </div>
      {/* Top action bar */}
      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8,alignItems:"center"}}>
        {allClashes.length>0&&(
          <button onClick={()=>setListShowClashes(v=>!v)}
            style={S.btn({background:listShowClashes?"#ef4444":"#fff",color:listShowClashes?"#fff":"#ef4444",border:"1.5px solid #ef4444",fontSize:12,fontWeight:700})}>
            ⚠️ {listShowClashes?"All":"Clashes only"} ({allClashes.length})
          </button>
        )}
      </div>
      {/* Grouped (schedule summary, the default) or Itemised (one row per booking). */}
      <TableViewToggle value={listView} onChange={setListView}/>
      {listView==="grouped" ? (
        <ScheduleSummaryModal bookings={bookings.filter(b=>venueOk(b.facility_id)&&(listBookerFilter.size===0||listBookerFilter.has(b.email?.toLowerCase()))&&(!listShowClashes||allClashIds.has(b.id)))} isAdmin={isAdmin} loggedInEmail={loggedInEmail} onBulkApply={handleBulkApply} onBulkStatusChange={handleBulkStatusChange} onRemove={queueMultiForRemoval} onReassign={isAdmin?handleBulkReassign:undefined} onAddPricingRule={isAdmin?addPricingCondition:undefined} bookers={knownBookers} onView={setViewing} aliasNames={aliasNames} emailAliases={emailAliases}/>
      ) : isMobile ? (
        // Phones: filters in a compact grid (bookers via the pills above), then one
        // card per booking — date, time, field and status on top, booker and purpose below.
        <>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
            <div style={{gridColumn:"1 / -1",position:"relative"}}><DateRangePicker from={listDateFrom} to={listDateTo} onApply={(f,t)=>{setListDateFrom(f);setListDateTo(t);}}/></div>
            <select value={listColFacility} onChange={e=>setListColFacility(e.target.value)} aria-label="Facility"
              style={{...S.inp,fontSize:12,padding:"6px 8px",minWidth:0}}>
              <option value="all">All facilities</option>
              {facilityOptions.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <select value={listStatusFilter} onChange={e=>setListStatusFilter(e.target.value)} aria-label="Status"
              style={{...S.inp,fontSize:12,padding:"6px 8px",minWidth:0}}>
              <option value="all">All statuses</option>
              {Object.keys(STATUS_META).map(k=><option key={k} value={k}>{groupStatusLabel(k, bookings.filter(b=>b.status===k))}</option>)}
            </select>
            <input placeholder="Search purpose…" value={listColPurpose} onChange={e=>setListColPurpose(e.target.value)}
              style={{...S.inp,fontSize:12,padding:"6px 8px",minWidth:0,gridColumn:anyListFilter?"auto":"1 / -1"}}/>
            {anyListFilter&&<button onClick={()=>{setListDateFrom("");setListDateTo("");setListStatusFilter("all");setListColPurpose("");setListColFacility("all");}}
              style={S.btn({background:"#fff",color:"#64748b",border:"1.5px solid #e2e8f0",fontSize:12,padding:"6px 8px"})}>✕ Clear filters</button>}
            <div style={{gridColumn:"1 / -1",display:"flex",gap:6,alignItems:"center",fontSize:11,color:"#64748b",overflowX:"auto",scrollbarWidth:"none"}}>
              Sort:{[["date","Date"],["booker","Booker"],["facility","Facility"],["status","Status"]].map(([col,label])=>(
                <button key={col} onClick={()=>lToggleSort(col)} style={{padding:"3px 9px",borderRadius:12,border:`1.5px solid ${listSortCol===col?"#0f172a":"#e2e8f0"}`,background:listSortCol===col?"#0f172a":"#fff",color:listSortCol===col?"#fff":"#475569",fontSize:11,fontWeight:600,fontFamily:"inherit",cursor:"pointer",whiteSpace:"nowrap"}}>{label}{lArrow(col)}</button>
              ))}
            </div>
          </div>
          {visible.length===0
            ? <div style={{textAlign:"center",padding:"40px 0",color:"#94a3b8",fontSize:14}}>No bookings match the current filters.</div>
            : <div style={{borderRadius:10,border:"1px solid #f1f5f9",overflow:"hidden"}}>
                {visible.map((b,ri)=>{
                  const f=FACILITIES.find(x=>x.id===b.facility_id);
                  const isClash=allClashIds.has(b.id), isAdmin_bk=isAdminBooking(b);
                  return (
                    <div key={b.id} onClick={()=>setViewing(b)} role="button" tabIndex={0}
                      style={{padding:"8px 10px",borderTop:ri>0?"1px solid #f1f5f9":"none",background:isClash?"#fff5f5":"#fff",cursor:"pointer",display:"flex",flexDirection:"column",gap:4,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0,fontSize:12,color:"#334155"}}>
                        <b style={{whiteSpace:"nowrap"}}>{fmtDateShort(b.date)}</b>
                        <span style={{whiteSpace:"nowrap",color:"#64748b"}}>{fmt24(b.start_hour)}–{fmt24(b.start_hour+b.duration)}</span>
                        <span style={{display:"inline-flex",alignItems:"center",gap:3,minWidth:0,overflow:"hidden"}}>
                          <span style={{width:7,height:7,borderRadius:"50%",background:f?.color,flexShrink:0}}/>
                          <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"#475569"}}>{f?.name||"—"}</span>
                        </span>
                        {isClash&&<span style={{marginLeft:"auto",fontSize:10,fontWeight:700,color:"#ef4444",flexShrink:0}}>⚡clash</span>}
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0,flexWrap:"wrap"}}>
                        <Badge status={b.status} wf={workflowOf(b.facility_id)} fid={b.facility_id}/>
                        {isAdmin_bk
                          ? <span style={{fontSize:10,fontWeight:700,color:"#94a3b8",background:"#f1f5f9",borderRadius:10,padding:"2px 6px"}}>🔒</span>
                          : <span style={{padding:"1px 8px",borderRadius:10,background:emailColor(b.email),color:"#fff",fontSize:11,fontWeight:600,maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{displayNameFor(b.email)}</span>}
                      </div>
                      {b.purpose&&<div style={{fontSize:11,color:"#64748b",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{b.purpose}</div>}
                    </div>
                  );
                })}
              </div>
          }
        </>
      ) : visible.length===0
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
                      const allSel = listBookerFilter.size>0 && bookerAllEmails.every(e=>listBookerFilter.has(e));
                      return (
                        <div style={{display:"flex",gap:3,alignItems:"center",flexWrap:"wrap"}}>
                          <button onClick={()=>setListBookerFilter(allSel?new Set():new Set(bookerAllEmails))}
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
                                  {emailLegend.map(primary=>{
                                    const group=bookerGroups[primary];
                                    const active=[...group].every(em=>listBookerFilter.has(em));
                                    const c=emailColor(primary);
                                    const others=[...group].filter(em=>em!==primary);
                                    return(
                                      <button key={primary} onClick={()=>toggleBooker(primary)}
                                        title={others.length?`${primary} (+ ${others.join(", ")})`:primary}
                                        style={{padding:"3px 8px",fontSize:11,borderRadius:14,border:`1.5px solid ${active?c:"#e2e8f0"}`,background:active?c:"#fff",color:active?"#fff":"#475569",cursor:"pointer",fontWeight:600,fontFamily:"inherit"}}>
                                        {displayNameFor(primary)}
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
                      {facilityOptions.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </th>
                  <th style={{padding:"3px 4px"}}>
                    <select value={listStatusFilter} onChange={e=>setListStatusFilter(e.target.value)}
                      style={{padding:"3px 4px",fontSize:11,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}>
                      <option value="all">All</option>
                      {Object.keys(STATUS_META).map(k=><option key={k} value={k}>{groupStatusLabel(k, bookings.filter(b=>b.status===k))}</option>)}
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
                          : <span onClick={e=>{e.stopPropagation();toggleBooker(canonEmail(b.email));}} style={{display:"inline-block",padding:"2px 8px",borderRadius:10,background:emailColor(b.email),color:"#fff",fontSize:11,fontWeight:600,cursor:"pointer",outline:listBookerFilter.has(canonEmail(b.email))?"2px solid #0f172a":"none",outlineOffset:1}}>
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
                        <Badge status={b.status} wf={workflowOf(b.facility_id)} fid={b.facility_id}/>
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

}
