import { useState, useMemo, useEffect } from "react";
import { LEAGUE_SEASONS, seasonOfBooker } from "../seasons.js";
import { ACTIVITY_LABELS, ACTIVITY_PUBLIC_ACTIONS, AMUA_CONTACT_ROLES, AMUA_DEFAULT_NAME, Badge, CopyableTable, EMAIL_COLORS, FACILITIES, Modal, PROVIDERS, PROVIDER_GROUPS, S, SUPABASE_URL, VENDOR_GTEC, activityActor, activitySlot, authHeaders, deriveRecipientCode, describeActivity, emailColor, fmtDate, fmtDateShort, fmtDateShortDow, fmtTime, isAdminBooking, providerGroupOf, providerLabel, sb, useMobile, workflowOf } from "./core.jsx";
export function ActivityLogModal({onClose, inline=false, bookers=[], isAdmin=true}) {
  const isMobile = useMobile();
  const [showFilters, setShowFilters] = useState(false);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all"); // all | sync | admin | booker
  const [logFrom, setLogFrom] = useState("");  // created_at lower bound (yyyy-mm-dd)
  const [logTo, setLogTo]     = useState("");  // created_at upper bound
  const [who, setWho]         = useState("");  // free text — refs, dates, anything
  const [bookerSel, setBookerSel] = useState(""); // canonical booker email, "" = all
  const [actionFilter, setActionFilter] = useState("all");
  const [limit, setLimit]     = useState(1000);
  // Entries whose full booking list is open — any number at once.
  const [openRows, setOpenRows] = useState(()=>new Set());
  const toggleRow = id => setOpenRows(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  // The detail line, plus an expander listing every booking when the summary cut some off.
  const detail = r => {
    const text = describeActivity(r); if (!text) return null;
    const items = Array.isArray(r.detail?.items) ? r.detail.items : [];
    if (items.length <= 3) return text;
    const open = openRows.has(r.id);
    return (<>
      {text}{" "}
      <button onClick={()=>toggleRow(r.id)} data-nocopy=""
        style={{border:"none",background:"none",padding:0,color:"#2563eb",cursor:"pointer",fontSize:"inherit",fontWeight:600,fontFamily:"inherit"}}>{open?"▴ less":`▾ all ${items.length}`}</button>
      {open&&<ul style={{margin:"4px 0 0",paddingLeft:16}}>
        {[...items].sort((a,b)=>(a.date||"").localeCompare(b.date||"")||(a.start_hour||0)-(b.start_hour||0)).map((it,i)=><li key={i}>{activitySlot(it)}</li>)}
      </ul>}
    </>);
  };
  const [truncated, setTruncated] = useState(false);
  const SYNC_ACTIONS = useMemo(()=>new Set([
    "cpsa_sync_start","cpsa_sync_complete","cpsa_confirm","cpsa_review_flag",
    "cpsa_admin_booking_add","cpsa_admin_booking_remove","cpsa_admin_convert","mismatch_resolution","mismatch_billing_settled"
  ]),[]);
  // The date range is applied server-side, not to an already-truncated page. The old
  // fetch took the most recent 200 rows full stop — one sync writes dozens, so anything
  // more than a few days old fell off the end and looked like it had never happened.
  useEffect(()=>{
    let cancelled = false;
    (async ()=>{
      setRows(null);
      const q = ["select=*", `limit=${limit}`];
      if (logFrom) q.push(`created_at=gte.${logFrom}T00:00:00`);
      if (logTo)   q.push(`created_at=lte.${logTo}T23:59:59`);
      try {
        const data = await sb.select("activity_log", q.join("&"));
        // Admins also see the Council fields page's vetting history here, so there's one
        // place to review what changed (rejecting a change stays on that page).
        let vet = [];
        if (isAdmin) try {
          const vq = [`select=*`, `order=at.desc`, `limit=${Math.min(limit, 500)}`];
          if (logFrom) vq.push(`at=gte.${logFrom}T00:00:00`);
          if (logTo)   vq.push(`at=lte.${logTo}T23:59:59`);
          const r = await fetch(`${SUPABASE_URL}/rest/v1/vetting_history?${vq.join("&")}`, { headers: authHeaders() });
          if (r.ok) vet = (await r.json()).map(h => ({ id:"vh-"+h.id, created_at:h.at, user_email:h.by_email, action:"vetting_change",
            detail:{ by:"admin", park:h.park, kind:h.kind, status:h.status, ...(h.by_name?{actor:h.by_name}:{}) } }));
        } catch { /* vetting history not set up yet */ }
        if (cancelled) return;
        const all = [...(data||[]), ...vet].sort((a,b) => String(b.created_at).localeCompare(String(a.created_at)));
        setRows(all);
        setTruncated((data||[]).length >= limit);
        setError("");
      } catch(e) { if (!cancelled) { setError(e.message); setRows([]); } }
    })();
    return ()=>{ cancelled = true; };
  },[logFrom, logTo, limit, isAdmin]);
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
  // Every action present in the fetched window, so the dropdown only offers real options.
  const actionsPresent = useMemo(
    () => [...new Set((rows||[]).map(r=>r.action).filter(a=>isAdmin||ACTIVITY_PUBLIC_ACTIONS.has(a)))].sort((a,b)=>(ACTIVITY_LABELS[a]||a).localeCompare(ACTIVITY_LABELS[b]||b)),
    [rows, isAdmin]);
  // Booker match scans the whole entry, not just user_email: a deletion records the
  // affected booker inside detail, and the actor is usually the admin who did it.
  const whoQ = who.trim().toLowerCase();
  const blob = r => `${r.user_email||""} ${JSON.stringify(r.detail||{})}`.toLowerCase();
  const matchesWho = r => !whoQ || blob(r).includes(whoQ);
  // Picking a booker matches on every address they own plus their display name. Typing
  // "AUUC" would miss them entirely — their address is auultimateclub@gmail.com, which
  // doesn't contain that string — so the roster does the resolving instead of the user.
  const selBooker = bookers.find(b => b.email === bookerSel);
  const bookerNeedles = selBooker
    ? [...(selBooker.addresses||[selBooker.email]), selBooker.name].filter(Boolean).map(x=>String(x).toLowerCase())
    : [];
  const matchesBooker = r => !selBooker || bookerNeedles.some(nd => blob(r).includes(nd));
  const filtered = collapsed.filter(r => {
    if (!isAdmin && (!ACTIVITY_PUBLIC_ACTIONS.has(r.action) || activityActor(r)!=="booker")) return false;
    if (!matchesWho(r) || !matchesBooker(r)) return false;
    if (actionFilter!=="all" && r.action!==actionFilter) return false;
    if (filter==="all")   return true;
    if (filter==="sync")  return SYNC_ACTIONS.has(r.action);
    if (filter==="admin") return activityActor(r)==="admin";
    if (filter==="booker")return activityActor(r)==="booker";
    return true;
  });
  const actionStyle = a => {
    if (a.startsWith("cpsa_sync")) return {color:"#0e7490",bg:"#ecfeff",border:"#a5f3fc"};
    if (a==="cpsa_confirm") return {color:"#0e7490",bg:"#ecfeff",border:"#a5f3fc"};
    if (a==="cpsa_review_flag") return {color:"#b45309",bg:"#fffbeb",border:"#fde68a"};
    if (a.startsWith("cpsa_admin")) return {color:"#475569",bg:"#f8fafc",border:"#e2e8f0"};
    if (a.startsWith("mismatch")) return {color:"#7c3aed",bg:"#f5f3ff",border:"#ddd6fe"};
    if (a==="booking_create") return {color:"#15803d",bg:"#f0fdf4",border:"#bbf7d0"};
    if (a==="booking_edit")   return {color:"#0369a1",bg:"#f0f9ff",border:"#bae6fd"};
    if (a==="booking_delete") return {color:"#b91c1c",bg:"#fef2f2",border:"#fecaca"};
    if (a==="status_change")  return {color:"#a16207",bg:"#fefce8",border:"#fde68a"};
    if (a==="invoiced"||a==="official_invoice_created") return {color:"#3730a3",bg:"#eef2ff",border:"#c7d2fe"};
    if (a.startsWith("drive_")) return {color:"#15803d",bg:"#f0fdf4",border:"#bbf7d0"};
    if (a==="email_sent")   return {color:"#0e7490",bg:"#ecfeff",border:"#a5f3fc"};
    if (a==="email_failed") return {color:"#b91c1c",bg:"#fef2f2",border:"#fecaca"};
    if (a==="sign_in"||a==="sign_out") return {color:"#475569",bg:"#f8fafc",border:"#e2e8f0"};
    if (a==="council_fields") return {color:"#047857",bg:"#ecfdf5",border:"#a7f3d0"};
    return {color:"#475569",bg:"#fff",border:"#e2e8f0"};
  };
  const ALWrapper = children => inline
    ? <div style={{background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:12,padding:isMobile?10:16,maxHeight:520,display:"flex",flexDirection:"column"}}><div style={{fontSize:14,fontWeight:700,color:"#0f172a",marginBottom:10}}>📜 Activity Log</div>{children}</div>
    : <Modal title="📜 Activity Log" onClose={onClose} width={780}>{children}</Modal>;
  const when = r => new Date(r.created_at).toLocaleString("en-NZ",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});
  // Who: the person picked at sign-in (first name, last initial), then the account.
  const whoLabel = r => <>{r.detail?.actor?<b style={{color:"#334155"}}>{r.detail.actor} </b>:null}<span>{(r.user_email||"—").replace(/@.*/, isAdmin?"$&":"")}</span></>;
  const badge = r => { const st = actionStyle(r.action);
    return <span style={{fontSize:11,fontWeight:700,padding:"1px 7px",borderRadius:10,background:st.bg,color:st.color,border:`1px solid ${st.border}`,whiteSpace:"nowrap"}}>{ACTIVITY_LABELS[r.action]||r.action}</span>; };
  const roleChip = r => { const adm = activityActor(r)==="admin";
    return <span style={{fontSize:9,fontWeight:700,padding:"0 5px",borderRadius:8,background:adm?"#eef2ff":"#f0fdf4",color:adm?"#4338ca":"#15803d",border:`1px solid ${adm?"#c7d2fe":"#bbf7d0"}`}}>{adm?"Admin":"Booker"}</span>; };
  const tabs = isAdmin ? [["all","All"],["sync","Sync & GTEC"],["admin","Admin"],["booker","Bookers"]] : [];
  const filtersSet = !!(who||logFrom||logTo||actionFilter!=="all"||bookerSel);
  const inp = {...S.inp,fontSize:12,padding:"5px 8px",minWidth:0,boxSizing:"border-box"};
  const pill = on => ({padding:"4px 10px",borderRadius:14,border:`1.5px solid ${on?"#0f172a":"#e2e8f0"}`,background:on?"#0f172a":"#fff",color:on?"#fff":"#475569",fontSize:12,fontWeight:600,fontFamily:"inherit",cursor:"pointer",whiteSpace:"nowrap",flexShrink:0});
  const filterPanel = (
    <div style={{display:"grid",gridTemplateColumns:isMobile?"1fr 1fr":"repeat(auto-fit,minmax(150px,1fr))",gap:6,background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:8,flexShrink:0}}>
      {isAdmin&&bookers.length>0&&(
        <select value={bookerSel} onChange={e=>setBookerSel(e.target.value)} title="Match every address this booker owns, plus their display name" style={inp}>
          <option value="">All bookers</option>
          {bookers.map(b=><option key={b.email} value={b.email}>{b.name}</option>)}
        </select>
      )}
      <select value={actionFilter} onChange={e=>setActionFilter(e.target.value)} style={inp}>
        <option value="all">All actions</option>
        {actionsPresent.map(a=><option key={a} value={a}>{ACTIVITY_LABELS[a]||a}</option>)}
      </select>
      <input value={who} onChange={e=>setWho(e.target.value)} placeholder="Search: name, date, ref…"
        title="Matches who did it and anything recorded in the entry — booker addresses, references, booking dates"
        style={{...inp,gridColumn:isMobile?"1 / -1":"auto"}}/>
      <label style={{display:"flex",flexDirection:"column",gap:2,fontSize:10,color:"#64748b",fontWeight:700}}>FROM
        <input type="date" value={logFrom} onChange={e=>setLogFrom(e.target.value)} style={inp}/></label>
      <label style={{display:"flex",flexDirection:"column",gap:2,fontSize:10,color:"#64748b",fontWeight:700}}>TO
        <input type="date" value={logTo} onChange={e=>setLogTo(e.target.value)} style={inp}/></label>
      {filtersSet&&(
        <button onClick={()=>{setWho("");setLogFrom("");setLogTo("");setActionFilter("all");setBookerSel("");}}
          style={{gridColumn:isMobile?"1 / -1":"auto",padding:"5px 9px",borderRadius:6,border:"1px solid #e2e8f0",background:"#fff",color:"#64748b",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit"}}>Clear filters</button>
      )}
    </div>
  );
  const empty = <div style={{padding:24,textAlign:"center",color:"#94a3b8",fontSize:13}}>{rows===null?"Loading…":"No activity matches this filter."}</div>;
  return (
    ALWrapper(<>
      <div style={{display:"flex",flexDirection:"column",gap:8,minHeight:0,flex:1}}>
        {!isAdmin&&<div style={{fontSize:12,color:"#64748b",flexShrink:0}}>Bookings and council fields across all bookers, newest first.</div>}
        <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0,minWidth:0}}>
          <div style={{display:"flex",gap:6,flex:1,minWidth:0,overflowX:"auto",scrollbarWidth:"none"}}>
            {tabs.map(([val,label])=><button key={val} onClick={()=>setFilter(val)} style={pill(filter===val)}>{label}</button>)}
          </div>
          <span style={{fontSize:11,color:"#94a3b8",whiteSpace:"nowrap"}}>{rows===null?"…":isAdmin?`${filtered.length}/${collapsed.length}`:filtered.length}</span>
          {isMobile&&<button onClick={()=>setShowFilters(v=>!v)} title="Filters" aria-pressed={showFilters} style={pill(showFilters||filtersSet)}>⚙{filtersSet?" •":""}</button>}
        </div>
        {(!isMobile||showFilters)&&filterPanel}
        {truncated&&(
          <div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"6px 10px",fontSize:11,color:"#92400e",flexShrink:0,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
            <span>⚠ Showing the latest {limit} entries. Narrow the dates, or load more.</span>
            <button onClick={()=>setLimit(l=>l+2000)}
              style={{marginLeft:"auto",padding:"3px 9px",borderRadius:6,border:"1px solid #fcd34d",background:"#fff",color:"#92400e",cursor:"pointer",fontSize:11,fontWeight:700,fontFamily:"inherit"}}>Load more</button>
          </div>
        )}
        {error&&<div style={{background:"#fef2f2",border:"1px solid #fecaca",borderRadius:6,padding:"6px 10px",fontSize:12,color:"#b91c1c",flexShrink:0}}>⚠ {error} — has <code>supabase-setup.sql</code> been run?</div>}
        <div style={{overflowY:"auto",flex:1,minHeight:0,border:"1px solid #f1f5f9",borderRadius:8}}>
          {isMobile ? (
            filtered.length===0 ? empty :
            <ul style={{listStyle:"none",margin:0,padding:0}}>
              {filtered.map(r=>(
                <li key={r.id} style={{padding:"8px 10px",borderBottom:"1px solid #f1f5f9",display:"flex",flexDirection:"column",gap:3,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,minWidth:0}}>
                    {badge(r)}
                    <span style={{marginLeft:"auto",fontSize:11,color:"#94a3b8",whiteSpace:"nowrap"}}>{when(r)}</span>
                  </div>
                  {describeActivity(r)&&<div style={{fontSize:12,color:"#334155",overflowWrap:"anywhere",lineHeight:1.35}}>{detail(r)}</div>}
                  <div style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#64748b",minWidth:0}}>
                    {isAdmin&&roleChip(r)}<span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}} title={r.user_email||""}>{whoLabel(r)}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
          <CopyableTable>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,tableLayout:"fixed"}}>
            <colgroup><col style={{width:100}}/><col style={{width:170}}/><col style={{width:150}}/><col/></colgroup>
            <thead style={{position:"sticky",top:0,background:"#f8fafc",zIndex:1}}>
              <tr>
                {["When","Who","Action","Detail"].map(h=><th key={h} style={{textAlign:"left",padding:"7px 10px",fontWeight:700,color:"#475569",borderBottom:"1px solid #e2e8f0"}}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {filtered.length===0
                ? <tr><td colSpan={4}>{empty}</td></tr>
                : filtered.map(r=>(
                    <tr key={r.id} style={{borderBottom:"1px solid #f1f5f9",verticalAlign:"top"}}>
                      <td style={{padding:"6px 10px",color:"#64748b",whiteSpace:"nowrap",fontSize:11}}>{when(r)}</td>
                      <td style={{padding:"6px 10px",fontSize:11}}>
                        <div style={{display:"flex",flexDirection:"column",gap:2,minWidth:0}}>
                          {isAdmin&&<span>{roleChip(r)}</span>}
                          <span style={{color:"#64748b",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={r.user_email||""}>{whoLabel(r)}</span>
                        </div>
                      </td>
                      <td style={{padding:"6px 10px"}}>{badge(r)}</td>
                      <td style={{padding:"6px 10px",color:"#475569",fontSize:11,overflowWrap:"anywhere"}}>{detail(r)}</td>
                    </tr>
                  ))
              }
            </tbody>
          </table>
          </CopyableTable>
          )}
        </div>
      </div>
    </>)
  );
}

// Admin UI: map secondary emails into a primary profile + manage profile details.
// A vendor profile's provider: set in User Management, else guessed from its email / name
// (CPSA, Cornwall Park, Grammar or GTEC → GTEC / CPSA).
export function vendorProviderOf(email, prof = {}) {
  if (prof.providerId && PROVIDERS[prof.providerId]) return prof.providerId;
  const hay = `${email} ${prof.fullName || ""}`.toLowerCase();
  if (/cpsa|cornwall|gtec|grammar/.test(hay)) return "gtec";
  const hit = Object.keys(PROVIDERS).find(pid => { const p = PROVIDERS[pid]; return [p.short, p.name].filter(Boolean).some(n => hay.includes(String(n).toLowerCase())); });
  return hit || "other";
}
// Vendors grouped like the provider picker: GTEC / CPSA (with GTEC and CPSA as default
// entries), St Cuthbert's, Auckland Council (and the clubs that run council fields),
// Community / Schools, then anything else.
export function groupVendors(vendors, profiles) {
  const groups = new Map();
  const add = (id, label, sub, pid) => { if (!groups.has(id)) groups.set(id, { id, label, sub, pid, members: [], defaults: [] }); return groups.get(id); };
  add("gtec", providerLabel("gtec"), "Cornwall Park", "gtec");
  vendors.forEach(em => {
    const pid = vendorProviderOf(em, (profiles||{})[em]), g = PROVIDERS[pid] ? providerGroupOf(pid) : "other";
    const grp = PROVIDER_GROUPS[g];
    add(g, grp ? grp.label : pid === "other" ? "Other vendors" : providerLabel(pid), grp ? null : null, pid).members.push(em);
  });
  const gt = groups.get("gtec"), names = gt.members.map(em => `${em} ${(profiles||{})[em]?.fullName || ""}`.toLowerCase());
  const has = re => names.some(n => re.test(n));
  gt.defaults.push({ key: "gtec", name: "GTEC", note: `${VENDOR_GTEC.name} · GST ${VENDOR_GTEC.gstNumber} · PO recipient`, email: has(/gtec|grammar/) });
  gt.defaults.push({ key: "cpsa", name: "CPSA", note: "Cornwall Park bookings and room requests", email: has(/cpsa|cornwall/) });
  const rank = id => ({ gtec: 0, stcuthberts: 1, council: 2, community: 3, other: 9 })[id] ?? 5;
  return [...groups.values()].sort((a, b) => rank(a.id) - rank(b.id));
}
export function UserMgmtModal({ bookings, aliases, aliasNames, aliasColors={}, bookerSeasons={}, onChangeSeasons, onChange, onChangeNames, onChangeColors, profiles, onUpdateProfile, adminEmail, onClose, onViewAs }) {
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
  // Set/clear the chip colour override for a booker. Empty value reverts to the
  // auto-assigned palette colour.
  function setAliasColor(primary, value) {
    if (!onChangeColors) return;
    const next = { ...(aliasColors||{}) };
    if (!value) delete next[primary];
    else next[primary] = value;
    onChangeColors(next);
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
    // Exclude any email that is itself a secondary (aliased onto a primary) — a
    // lingering profile entry or the admin email shouldn't show as its own card;
    // it must nest under its primary instead.
    return [...s].filter(em => !aliases[em]).sort();
  }, [groups, adminEmail, profiles, aliases]);

  // Create-vendor form state
  const [newVendorEmail, setNewVendorEmail] = useState("");
  const [newVendorName, setNewVendorName] = useState("");
  const [newVendorProvider, setNewVendorProvider] = useState("gtec");
  function createVendor() {
    const em = newVendorEmail.trim().toLowerCase();
    if (!em) return;
    const next = { ...(profiles||{}) };
    next[em] = { ...(next[em]||{}), profileType:"vendor", fullName: newVendorName.trim() || next[em]?.fullName || "", providerId: newVendorProvider };
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

      {/* Create standalone vendor profile (works without a linked Google login) */}
      <div style={{background:"#f8fafc",border:"1.5px solid #e2e8f0",borderRadius:10,padding:12,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:6}}>Create vendor profile</div>
        <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>Vendor profiles can exist standalone (no Google login needed). Choose the vendor they're for.</div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <input value={newVendorEmail} onChange={e=>setNewVendorEmail(e.target.value)}
            placeholder="vendor email…"
            style={{flex:"1 1 180px",padding:"6px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}/>
          <input value={newVendorName} onChange={e=>setNewVendorName(e.target.value)}
            placeholder="display name (optional)"
            style={{flex:"1 1 180px",padding:"6px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}/>
          <select value={newVendorProvider} onChange={e=>setNewVendorProvider(e.target.value)} aria-label="Vendor"
            style={{flex:"0 1 170px",padding:"6px 8px",borderRadius:6,border:"1.5px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}>
            {Object.keys(PROVIDERS).map(pid=><option key={pid} value={pid}>{providerLabel(pid)}</option>)}
          </select>
          <button onClick={createVendor} disabled={!newVendorEmail.trim()}
            style={S.btn({background:newVendorEmail.trim()?"#15803d":"#cbd5e1",color:"#fff",fontSize:12,cursor:newVendorEmail.trim()?"pointer":"not-allowed"})}>
            + Create
          </button>
        </div>
      </div>

      {/* Profile cards: users, then vendors grouped like the provider picker */}
      {(()=>{
        const renderCard = primary => {
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
                {ptype!=="admin"&&ptype!=="vendor"&&<span title="League season" style={{fontSize:10,fontWeight:800,padding:"1px 6px",borderRadius:10,background:"#f1f5f9",color:"#334155",border:"1px dashed #94a3b8",flexShrink:0}}>{LEAGUE_SEASONS.find(x=>x.id===seasonOfBooker(primary,bookerSeasons)).name}</span>}
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
                    {/* A vendor's provider: where it's listed, and which bookings it handles */}
                    {ptype==="vendor" && fieldRow("Vendor",
                      <select value={vendorProviderOf(primary, prof)} onChange={e=>upProfile(primary,"providerId",e.target.value)} style={{...si,width:"auto"}}>
                        {Object.keys(PROVIDERS).map(pid=><option key={pid} value={pid}>{providerLabel(pid)}</option>)}
                      </select>
                    )}
                    {/* Alias / display name */}
                    {fieldRow("Alias",
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <input value={aliasName} onChange={e=>setAliasName(primary,e.target.value)}
                          placeholder={dflt}
                          style={{...si,width:"auto",flex:1}}/>
                        <span style={{fontSize:10,color:"#94a3b8",whiteSpace:"nowrap"}}>default: {dflt}</span>
                      </div>
                    )}
                    {/* League season the booker plays in */}
                    {onChangeSeasons && fieldRow("Season",
                      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                        {LEAGUE_SEASONS.map(x=>{ const on=seasonOfBooker(primary,bookerSeasons)===x.id; return (
                          <button key={x.id} onClick={()=>onChangeSeasons({...bookerSeasons,[primary]:x.id})}
                            style={{padding:"3px 10px",borderRadius:12,border:`1.5px solid ${on?"#0f172a":"#e2e8f0"}`,background:on?"#0f172a":"#fff",color:on?"#fff":"#475569",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>
                            {x.name} <span style={{fontWeight:400,opacity:.7}}>{x.span}</span>
                          </button>); })}
                      </div>
                    )}
                    {/* Chip colour override */}
                    {onChangeColors && fieldRow("Colour",
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                        <span style={{display:"inline-block",padding:"3px 10px",borderRadius:12,background:emailColor(primary),color:"#fff",fontSize:12,fontWeight:700}}>{aliasName||dflt}</span>
                        <input type="color" value={aliasColors[primary]||emailColor(primary)} onChange={e=>setAliasColor(primary,e.target.value)}
                          title="Pick a custom colour"
                          style={{width:30,height:24,padding:0,border:"1px solid #e2e8f0",borderRadius:6,cursor:"pointer",background:"none"}}/>
                        <div style={{display:"flex",gap:3,flexWrap:"wrap"}}>
                          {EMAIL_COLORS.map(c=>(
                            <button key={c} onClick={()=>setAliasColor(primary,c)} title={c}
                              style={{width:16,height:16,borderRadius:"50%",background:c,border:(aliasColors[primary]||"").toLowerCase()===c.toLowerCase()?"2px solid #0f172a":"1px solid rgba(0,0,0,0.12)",cursor:"pointer",padding:0}}/>
                          ))}
                        </div>
                        {aliasColors[primary] && <button onClick={()=>setAliasColor(primary,"")}
                          style={{fontSize:10,color:"#64748b",background:"none",border:"1px solid #e2e8f0",borderRadius:6,padding:"2px 6px",cursor:"pointer",fontFamily:"inherit"}}>Reset</button>}
                        <span style={{fontSize:10,color:"#94a3b8",flexBasis:"100%"}}>Your colour for this booker — only this login sees it.</span>
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
                    {/* Billing recipient code — the 3-char RRR segment of the 12-char document ID / bank reference */}
                    {fieldRow("Billing code",
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                        <input value={prof.billingCode||""} maxLength={3}
                          onChange={e=>upProfile(primary,"billingCode",e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,3))}
                          placeholder={deriveRecipientCode(prof.officialName||prof.fullName||(aliasNames||{})[primary]||primary.split("@")[0])}
                          style={{...si,width:90,fontFamily:"monospace",letterSpacing:"0.12em",textTransform:"uppercase"}}/>
                        <span style={{fontSize:11,color:"#94a3b8"}}>3-char code used in invoice / PO references (blank = auto)</span>
                      </div>
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
        };
        const isVendor = em => (profiles||{})[em]?.profileType === "vendor";
        const users = allPrimaries.filter(em => !isVendor(em)), vendors = allPrimaries.filter(isVendor);
        const vendorGroups = groupVendors(vendors, profiles);
        const hdr = { fontSize:12, fontWeight:700, color:"#0f172a", margin:"14px 0 6px" };
        return (<>
          <div style={{...hdr, marginTop:0}}>Users ({users.length})</div>
          <div style={{display:"flex",flexDirection:"column",gap:8,paddingRight:2}}>
            {users.map(renderCard)}
            {users.length===0 && <div style={{color:"#94a3b8",fontSize:13,textAlign:"center",padding:20}}>No users yet.</div>}
          </div>
          <div style={hdr}>Vendors ({vendors.length})</div>
          <div style={{fontSize:11,color:"#64748b",margin:"-2px 0 8px"}}>Grouped like the vendor picker. Vendor emails are never sent directly — they're drafted to AMUA's inbox.</div>
          {vendorGroups.map(g => (
            <div key={g.id} style={{marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:800,color:"#475569",textTransform:"uppercase",letterSpacing:"0.04em",margin:"0 0 5px"}}>{g.label}{g.sub?<span style={{fontWeight:500,textTransform:"none",letterSpacing:0,color:"#94a3b8"}}> · {g.sub}</span>:null}</div>
              <div style={{display:"flex",flexDirection:"column",gap:6,paddingLeft:8,borderLeft:"3px solid #e2e8f0"}}>
                {g.defaults.map(d => (
                  <div key={d.key} style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",background:"#f8fafc",border:"1px dashed #cbd5e1",borderRadius:8,padding:"7px 10px",fontSize:12,color:"#475569"}}>
                    <b style={{color:"#0f172a"}}>{d.name}</b><span>{d.note}</span>
                    {!d.email && <button onClick={()=>{ setNewVendorName(d.name); setNewVendorProvider(g.pid||"gtec"); }}
                      style={{marginLeft:"auto",border:"1px solid #bbf7d0",background:"#fff",color:"#15803d",borderRadius:6,padding:"2px 8px",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>+ Add contact</button>}
                  </div>
                ))}
                {g.members.map(renderCard)}
              </div>
            </div>
          ))}
        </>);
      })()}
      <div style={{marginTop:12,display:"flex",justifyContent:"flex-end"}}>
        <button onClick={onClose} style={S.btn({background:"#0f172a",color:"#fff",fontSize:12})}>Done</button>
      </div>
    </Modal>
  );
}

// Single chip that opens a popover with From/To date inputs and an Apply button.
// Applies only when the user clicks Apply, so partial selections don't trigger
// re-renders / refilters.
export function DateRangePicker({ from, to, onApply }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from||"");
  const [draftTo, setDraftTo] = useState(to||"");
  const label = (from||to)
    ? (fd => `${from?fd(from):"…"} – ${to?fd(to):"…"}`)(window.innerWidth<768?fmtDateShort:fmtDate)
    : "Any date";
  function apply() { onApply(draftFrom, draftTo); setOpen(false); }
  function clear() { setDraftFrom(""); setDraftTo(""); onApply("", ""); setOpen(false); }
  return (
    <div style={{position:"relative"}}>
      <button onClick={()=>{ if(!open){ setDraftFrom(from||""); setDraftTo(to||""); } setOpen(v=>!v); }}
        style={{display:"flex",alignItems:"center",gap:4,padding:"3px 8px",fontSize:11,borderRadius:5,border:`1.5px solid ${(from||to)?"#0f172a":"#cbd5e1"}`,background:"#fff",color:(from||to)?"#0f172a":"#475569",cursor:"pointer",fontFamily:"inherit",fontWeight:600,width:"100%",justifyContent:"center",minWidth:0,maxWidth:"100%"}}>
        <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>📅 {label}</span><span style={{fontSize:9,color:"#94a3b8",flexShrink:0}}>▾</span>
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

// Admin editor for AMUA's organisation details and operations contacts (the `amua_org`
// setting). Edits a local draft and saves once, so typing doesn't write every keystroke.
// Stored in the settings table, readable by every signed-in user: it is the same
// information printed on invoices, so keep it to what AMUA is happy to share.
export function AmuaDetailsModal({ value, onSave, onClose }) {
  const [d, setD] = useState(() => ({
    name: value?.name || AMUA_DEFAULT_NAME,
    address: value?.address || "", gstNumber: value?.gstNumber || "", bank: value?.bank || "",
    contacts: { ...(value?.contacts || {}) },
    council: { rso: "Auckland Ultimate", orgType: "Club/Team", ...(value?.council || {}) },
  }));
  const set = (k, v) => setD(p => ({ ...p, [k]: v }));
  const setContact = (role, k, v) => setD(p => ({ ...p, contacts: { ...p.contacts, [role]: { ...(p.contacts[role] || {}), [k]: v } } }));
  const setCouncil = (k, v) => setD(p => ({ ...p, council: { ...p.council, [k]: v } }));
  const si = {padding:"6px 8px",fontSize:12,borderRadius:6,border:"1.5px solid #e2e8f0",fontFamily:"inherit",outline:"none",width:"100%",boxSizing:"border-box"};
  const row = (label, input) => (
    <label style={{display:"grid",gridTemplateColumns:"120px 1fr",alignItems:"start",gap:8,marginBottom:6}}>
      <span style={{fontSize:11,color:"#64748b",fontWeight:600,paddingTop:6}}>{label}</span>{input}
    </label>
  );
  const box = {background:"#f8fafc",border:"1.5px solid #e2e8f0",borderRadius:10,padding:12,marginBottom:12};
  const head = t => <div style={{fontSize:12,fontWeight:700,color:"#0f172a",marginBottom:8}}>{t}</div>;
  return (
    <Modal title="🏢 AMUA details" onClose={onClose} width={620}>
      <div style={box}>
        {head("Organisation")}
        <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>Printed on every invoice, PO and receipt.</div>
        {row("Name", <input style={si} value={d.name} onChange={e=>set("name", e.target.value)}/>)}
        {row("Postal address", <textarea style={{...si,minHeight:54,resize:"vertical"}} value={d.address} onChange={e=>set("address", e.target.value)} placeholder={"PO Box …\nAuckland"}/>)}
        {row("GST number", <input style={si} value={d.gstNumber} onChange={e=>set("gstNumber", e.target.value)} placeholder="e.g. 123-456-789"/>)}
        {row("Bank account", <input style={si} value={d.bank} onChange={e=>set("bank", e.target.value)} placeholder="e.g. 12-3456-0123456-00 (AMUA)"/>)}
      </div>
      {AMUA_CONTACT_ROLES.map(r => {
        const c = d.contacts[r.key] || {};
        return (
          <div key={r.key} style={box}>
            {head(r.label)}
            <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>{r.hint}</div>
            {row("Name", <input style={si} value={c.name||""} onChange={e=>setContact(r.key,"name",e.target.value)}/>)}
            {r.key!=="keyHolder" && row("Position", <input style={si} value={c.position||""} onChange={e=>setContact(r.key,"position",e.target.value)} placeholder="e.g. Secretary"/>)}
            {row("Email", <input style={si} type="email" value={c.email||""} onChange={e=>setContact(r.key,"email",e.target.value)}/>)}
            {row("Phone", <input style={si} type="tel" value={c.phone||""} onChange={e=>setContact(r.key,"phone",e.target.value)}/>)}
          </div>
        );
      })}
      <div style={box}>
        {head("Council applications")}
        <div style={{fontSize:11,color:"#64748b",marginBottom:8}}>Answers used when filling in Auckland Council sports-park applications.</div>
        {row("Regional sports org.", <input style={si} value={d.council.rso||""} onChange={e=>setCouncil("rso", e.target.value)} placeholder="Leave blank if none"/>)}
        {row("Organisation type", (
          <select style={{...si,background:"#fff"}} value={d.council.orgType||""} onChange={e=>setCouncil("orgType", e.target.value)}>
            {["Club/Team","Regional sports organisation","School","Social","Other"].map(o=><option key={o} value={o}>{o}</option>)}
          </select>
        ))}
        {row("Address search", <input style={si} value={d.council.postalAddressSearch||""} onChange={e=>setCouncil("postalAddressSearch", e.target.value)} placeholder={d.address ? `Blank = postal address: ${d.address.split(/\n+/).join(" ")}` : "Text to type into the council's address lookup"}/>)}
        {d.council.postalAddressSearch && <div style={{fontSize:11,color:"#b45309",margin:"-4px 0 6px"}}>The council widget types this, not the postal address above. Clear it to use the postal address.</div>}
        {row("Key / access codes", <input style={si} value={d.council.keyCodes||""} onChange={e=>setCouncil("keyCodes", e.target.value)} placeholder="Council keys or codes held (blank = N/A)"/>)}
        {row("Players per team", <input style={si} type="number" min="1" value={d.council.playersPerTeam||""} onChange={e=>setCouncil("playersPerTeam", e.target.value)} placeholder="Used when a booker has no player count"/>)}
      </div>
      <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#64748b"})}>Cancel</button>
        <button onClick={()=>onSave(d)} style={S.btn({background:"#0f172a",color:"#fff",fontWeight:700})}>Save</button>
      </div>
    </Modal>
  );
}

export function UserMenuItem({icon, label, onClick, danger=false}) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
      style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"9px 14px",background:hover?(danger?"#fef2f2":"#f8fafc"):"transparent",border:"none",fontFamily:"inherit",fontSize:13,color:danger?"#b91c1c":"#0f172a",textAlign:"left",cursor:"pointer",fontWeight:500}}>
      <span style={{fontSize:14,width:18,textAlign:"center"}}>{icon}</span>{label}
    </button>
  );
}
export function OverlapWarning({title,description,bookings:bkgs,onProceed,onCancel}) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fffbeb",border:"1.5px solid #f59e0b",borderRadius:10,padding:"14px 16px",display:"flex",gap:12}}>
        <span style={{fontSize:24,lineHeight:1}}>⚠️</span>
        <div><div style={{fontWeight:700,fontSize:15,color:"#92400e",marginBottom:6}}>{title}</div>
          <div style={{fontSize:13,color:"#78350f",lineHeight:1.6}}>{description}</div></div>
      </div>
      {/* Chronological, and each row carries its date: a repeating request overlaps on
          several different days, and without the date the list read as one undated blur. */}
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {[...bkgs].sort((a,b)=>(a.date||"").localeCompare(b.date||"")||a.start_hour-b.start_hour).map(b=>{
          const f=FACILITIES.find(x=>x.id===b.facility_id);return(
          <div key={b.id} style={{display:"flex",gap:10,alignItems:"center",padding:"10px 14px",background:"#f8fafc",borderRadius:8,border:"1px solid #e2e8f0"}}>
            <span style={{width:10,height:10,borderRadius:"50%",background:f?.color,flexShrink:0,display:"inline-block"}}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:700,color:"#0f172a"}}>
                {b.date?fmtDateShortDow(b.date):""}{b.date?" · ":""}{f?.name}
              </div>
              <div style={{fontSize:12,color:"#64748b"}}>{b.purpose} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)} · {b.name}</div>
            </div>
            <Badge status={b.status} wf={workflowOf(b.facility_id)} fid={b.facility_id}/>
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

// The booker's contact details for council applications: they're the key holder on AMUA's
// application for the fields they book. Admins can enter them for any booker.
export function CouncilContactModal({ email, isAdmin, contacts, tableReady, onClose, onSave }) {
  const [who, setWho] = useState((email||"").toLowerCase());
  const cur = contacts[who] || {};
  const [d, setD] = useState({ full_name: cur.full_name||"", phone: cur.phone||"", contact_email: cur.contact_email||"" });
  const pick = e => { const w = e.toLowerCase(); setWho(w); const c = contacts[w] || {}; setD({ full_name:c.full_name||"", phone:c.phone||"", contact_email:c.contact_email||"" }); };
  const si = { ...S.inp, fontSize:13 };
  const ok = d.full_name.trim() && d.phone.trim();
  return (
    <Modal title="📇 Council contact" onClose={onClose} width={480}>
      <div style={{fontSize:13,color:"#475569",marginBottom:12}}>
        AMUA applies to Auckland Council for the council fields you book. You're listed as the <b>key holder</b> for your fields and named with your team,
        so the council's booking coordinator can reach you. Council fields can be booked once your name and phone are here.
      </div>
      {!tableReady && <div style={{fontSize:12,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"8px 10px",marginBottom:10}}>
        The contacts table isn't set up yet (an admin needs to run <code>supabase-setup.sql</code>).</div>}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        <label style={S.lbl}>Booker (sign-in email)
          {isAdmin ? <input style={si} list="ccBookers" value={who} onChange={e=>pick(e.target.value)}/> : <div style={{...si,background:"#f1f5f9"}}>{who}</div>}
          {isAdmin && <datalist id="ccBookers">{Object.keys(contacts).map(e=><option key={e} value={e}/>)}</datalist>}
        </label>
        <label style={S.lbl}>Full name *<input style={si} value={d.full_name} onChange={e=>setD({...d,full_name:e.target.value})} placeholder="As the council should address you"/></label>
        <label style={S.lbl}>Phone *<input style={si} type="tel" value={d.phone} onChange={e=>setD({...d,phone:e.target.value})} placeholder="e.g. 021 123 4567"/></label>
        <label style={S.lbl}>Contact email <span style={{textTransform:"none",fontWeight:400}}>(if not {who})</span><input style={si} type="email" value={d.contact_email} onChange={e=>setD({...d,contact_email:e.target.value})}/></label>
      </div>
      <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14}}>
        <button onClick={onClose} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Cancel</button>
        <button disabled={!ok||!tableReady||!who} onClick={()=>onSave({ email:who, full_name:d.full_name.trim(), phone:d.phone.trim(), contact_email:d.contact_email.trim() })}
          style={S.btn({background:ok&&tableReady?"#0d9488":"#94a3b8",color:"#fff"})}>Save</button>
      </div>
    </Modal>);
}

export function Banner({type,msg}) {
  const c={info:{bg:"#f0f9ff",border:"#7dd3fc",text:"#075985"},error:{bg:"#fff1f2",border:"#fda4af",text:"#9f1239"}}[type]||{bg:"#f0f9ff",border:"#7dd3fc",text:"#075985"};
  return <div style={{background:c.bg,border:`1px solid ${c.border}`,color:c.text,borderRadius:10,padding:"10px 16px",fontSize:13,fontWeight:600,marginBottom:16}}>{msg}</div>;
}