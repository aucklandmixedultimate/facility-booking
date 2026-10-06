import { useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { askActor, getActor, clearActor } from "./actor.js";
import { gmailToken, fetchCouncilEmails, parseCouncilEmail } from "./councilMail.js";
import { driveConfigured, getDriveToken, renameFile, ensureFolderPath, DRIVE_ROOT_FOLDER, ensureFolder, findChildFile, uploadFile, keepLatestRevisionForever } from "./drive-client.js";
import { htmlToPdfBlob } from "./pdf-utils.js";
import { currentLeagueSeason, LEAGUE_SEASONS, seasonOfBooker } from "./seasons.js";
import { ALL_VENUES, Badge, COUNCIL_APPLICATION_FEE, COUNCIL_APPLICATION_URL, COUNCIL_APP_RE, CPSA_FIELD_IDS, CopyableTable, EmailLoginScreen, FACILITIES, LOGO_SRC, MOBILE_STYLE, MONTHS, Modal, PROVIDERS, ProviderMenu, REVIEW_STATUSES, VenueChipMenu, S, STATUS_META, SUPABASE_ANON, SUPABASE_URL, T, TableViewToggle, groupStatusLabel, VENUE_SEP, _emailAliases, activeVenueKeys, applyAmuaOrg, applyCouncilFacilities, authHeaders, buildApprovalEmailHtml, buildClashEmailHtml, buildInformCpsaEmailHtml, buildMismatchEmailHtml, buildOrderEmailHtml, buildRoomRequestEmailHtml, canSendToCouncil, clearSlotLink, councilFeeSplit, councilOverlaps, defaultProviderId, defaultVenueKey, emailColor, evenSlotShares, facShort, fmt24, fmtCost, fmtDate, fmtDateShort, fmtDateShortDow, fmtTime, fmtTimeShort, getBillingDrift, getClashes, inActiveVenue, isAdminBooking, linkCouncilChildren, listVenues, logActivity, newId, newSlotRef, parseClashPrevStatus, parseCouncilApp, parseCpsaOrig, parseCpsaRefs, parseCpsaResolution, parseMismatchNote, parseSlotLink, reachedGtecQueue, sb, sendApprovalEmail, sendEmail, setBilledSnapshot, setClashPrevStatus, setCpsaResolution, setGtecSnapshot, setMismatchNote, setModuleState, setSlotLink, setVendorVariance, slotGroupMembers, stripClashPrevStatus, stripMismatchNote, supabase, timeOverlaps, todayKey, useMobile, useTableView, venueFacilities, venueKeyOf, visibleFacilities, workflowOf } from "./booking/core.jsx";
import { councilAppBookings, mergeCouncilOutcomes } from "./booking/councilData.jsx";
import { cjrMonthUrl, extractCPSATeam, extractEventDetailsEmail, fetchCJREvents, parseFeedText, findMatchingUserBooking, purgeObsolete, gtecTeamKey, mapCJRFacility, parseCJRDate, parseCJRDateTime } from "./booking/gtec.jsx";
import { DRIVE_SUBFOLDERS, billingDocBaseName, buildBillingDocHtml, driveBatchFolderName, drivePoFolderName } from "./booking/billingDocs.jsx";
import { ScheduleSummaryModal, resolveRates } from "./booking/schedule.jsx";
import { ActivityLogModal, AmuaDetailsModal, Banner, CouncilContactModal, DateRangePicker, UserMenuItem, UserMgmtModal } from "./booking/modals.jsx";
import { DayTimelinePopup, MonthCalendar, WeekCalendar } from "./booking/calendar.jsx";
import { BookingDetail, BookingForm, CartModal, DeleteCartModal } from "./booking/forms.jsx";
import { isClosed, isLegacyStatus, ST } from "./statuses.js";
import { APPS, appHref } from "./appnav.js";

// Tabs loaded on first use, so the calendars open without downloading Summary, Billing,
// Admin, Allocation or About.
const SummaryTab = lazy(() => import("./booking/summary.jsx").then(m => ({ default: m.SummaryTab })));
const BillingTab = lazy(() => import("./booking/billing.jsx").then(m => ({ default: m.BillingTab })));
const AboutTab = lazy(() => import("./booking/about.jsx").then(m => ({ default: m.AboutTab })));
const AdminPanel = lazy(() => import("./booking/admin.jsx").then(m => ({ default: m.AdminPanel })));
const CouncilAllocationTab = lazy(() => import("./booking/admin.jsx").then(m => ({ default: m.CouncilAllocationTab })));
const TabLoading = () => <div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>;

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
  // Mirrored so facility pickers and calendar columns can hide admin-only grounds without
  // the flag being threaded through a dozen components. Assigned in render so it tracks
  // the latest value — including while an admin is viewing as a booker, where it
  // correctly hides the ground, matching what that booker would actually see.
  setModuleState({ _isAdminView: isAdmin });
  const userId        = session?.user?.id || null;
  const [bookings, setBookings] =useState([]);
  const [loading,  setLoading]  =useState(true);
  const [dbError,  setDbError]  =useState("");
  // The tab, facility filter and booker filter are remembered between visits.
  const remembered = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const [tab,      setTab]      =useState(()=>remembered("fb_tab","about"));
  const [selFac,   setSelFac]   =useState(()=>remembered("fb_sel_fac","all"));
  useEffect(()=>{ try{ localStorage.setItem("fb_tab",JSON.stringify(tab)); localStorage.setItem("fb_sel_fac",JSON.stringify(selFac)); }catch{ /* ignore */ } },[tab,selFac]);
  // ?venue=<provider>|<site> (from the Council fields page's "book" links) picks the venue.
  const [venue, setVenueState] = useState(()=>{
    try{
      const q = new URLSearchParams(window.location.search).get("venue");
      if (q) { localStorage.setItem("fb_venue", q); return q; }
      return localStorage.getItem("fb_venue") || null;
    }catch{ return null; } });
  // Bumped when council facilities load, so pickers and venues re-render with them.
  const [, setCouncilFacRev] = useState(()=>{
    try{ const c = JSON.parse(localStorage.getItem("fb_council_facilities")||"null"); if (c) applyCouncilFacilities(c); }catch{ /* ignore */ }
    return 0; });
  setModuleState({ _activeVenue: venue });
  // Facilities removed from the calendars' options, remembered on this device.
  const [hiddenFacs, setHiddenFacsState] = useState(()=>{ try{ return new Set(JSON.parse(localStorage.getItem("fb_hidden_facs")||"[]")); }catch{ return new Set(); } });
  setModuleState({ _hiddenFacs: hiddenFacs });
  function setHiddenFacs(next) {
    setHiddenFacsState(next); setModuleState({ _hiddenFacs: next });
    try{ localStorage.setItem("fb_hidden_facs", JSON.stringify([...next])); }catch{ /* ignore */ }
  }
  // Reset (default locations, nothing hidden) turns into Undo for the rest of the session.
  const [optionsUndo, setOptionsUndo] = useState(null);
  // What Reset shows: the CPSA fields plus every field with an upcoming (live) booking, at just
  // those fields' locations; every other facility at those locations is removed from the options.
  function resetTarget() {
    const today = todayKey();
    const active = new Set(bookings.filter(b => !isAdminBooking(b) && !isClosed(b.status) && b.date >= today).map(b => b.facility_id));
    const vis = visibleFacilities(), keep = f => CPSA_FIELD_IDS.has(f.id) || active.has(f.id);
    const venues = [defaultVenueKey()];
    vis.filter(keep).forEach(f => { const k = venueKeyOf(f); if (!venues.includes(k)) venues.push(k); });
    return { venues, hidden: vis.filter(f => !keep(f) && venues.includes(venueKeyOf(f))).map(f => f.id) };
  }
  function setVenue(v) {
    setVenueState(v); setModuleState({ _activeVenue: v });
    try{ v ? localStorage.setItem("fb_venue", v) : localStorage.removeItem("fb_venue"); }catch{ /* ignore */ }
    // A facility filter from the previous venue would hide everything in the new one.
    setSelFac(prev => prev === "all" || venueFacilities().some(f => f.id === prev) ? prev : "all");
  }
  const [showForm, setShowForm] =useState(false);
  const [focusedDate, setFocusedDate] = useState(new Date());
  const [dayPopupDate, setDayPopupDate] = useState(null);
  const [dayPopupFocus, setDayPopupFocus] = useState(null);
  const [dayPopupDur, setDayPopupDur] = useState(null);   // hours chosen in the week view, carried into the day view
  const [showCart, setShowCart]       =useState(false);
  const [cart,     setCart]           =useState([]); // { drafts, name, email, isMultiEdit? }[]
  const [informCpsaFor, setInformCpsaFor] = useState(null); // booking awaiting vendor pick for "Inform CPSA"
  const [roomRequestFor, setRoomRequestFor] = useState(null); // Meeting / Function Room booking awaiting a CPSA vendor pick
  const [deleteQueue,setDeleteQueue]  =useState([]); // bookings queued for removal
  const [showDeleteCart,setShowDeleteCart]=useState(false);
  const [editing,  setEditing]  =useState(null);
  const [viewing,  setViewing]  =useState(null);
  const [prefill,  setPrefill]  =useState({date:null,startHour:9,duration:1});
  const [toast,    setToast]    =useState(null);
  const [syncingMonth, setSyncingMonth] = useState(false);
  // Sync-all progress for the header button: { done, total, label, phase } while running.
  const [syncProgress, setSyncProgress] = useState(null);
  // Synchronous re-entrancy guard for the GTEC sync. The `syncingMonth` state can't
  // gate concurrent runs — a manual click and the on-mount auto-sync (or a double
  // click) both read the old state before React commits the update, so both proceed
  // and each creates its own copy of every admin block. A ref flips synchronously, so
  // the second caller sees it immediately and bails.
  const syncRunningRef = useRef(false);
  // Cumulative sync log across all months ever synced (persisted so the monthly
  // log survives reloads; old entries are purged per the admin retention setting).
  // Each entry: { monthKey, label, added, skipped, removed, cpsaConfirmed,
  //   cpsaReviewNeeded, clashes, notified, syncedAt, lastChangeAt }
  // Council email sync (🏛 Allocation): outcomes per council application number, from the
  // council's replies in AMUA's Gmail (settings "council_outcomes"), and a log of sync runs.
  const [councilOutcomes, setCouncilOutcomes] = useState(()=>{ try{ return JSON.parse(localStorage.getItem("fb_council_outcomes")||"{}"); }catch{ return {}; } });
  const [councilSyncLog, setCouncilSyncLog] = useState(()=>{ try{ return JSON.parse(localStorage.getItem("fb_council_sync_log")||"[]"); }catch{ return []; } });
  const [councilSyncing, setCouncilSyncing] = useState(false);
  const councilOpenCount = Object.values(councilOutcomes).filter(o => o.outcome === "action" || (o.outcome === "confirmed" && !o.allocated)).length;
  useEffect(()=>{ try{ localStorage.setItem("fb_council_sync_log", JSON.stringify(councilSyncLog.slice(0,30))); }catch{ /* ignore */ } }, [councilSyncLog]);
  // What the last sync received from the GTEC feed, by date (admins see it on a booking's
  // details): { at, byDate: { "YYYY-MM-DD": [{ name, when, fields, start_hour, duration, facilityIds, matched }] } }.
  const [syncFeed, setSyncFeed] = useState(()=>{ try { const v = JSON.parse(localStorage.getItem("fb_sync_feed")||"null"); if (v && v.byDate) return { at: v.at||null, months: v.months||[], byDate: v.byDate }; } catch { /* ignore */ } return { at: null, months: [], byDate: {} }; });
  useEffect(()=>{ try { localStorage.setItem("fb_sync_feed", JSON.stringify(syncFeed)); } catch { /* ignore */ } }, [syncFeed]);
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
  useEffect(()=>{ try{ localStorage.setItem("fb_email_aliases", JSON.stringify(emailAliases)); }catch{ /* ignore */ } setModuleState({ _emailAliases: emailAliases }); }, [emailAliases]);
  // gtecLinks: { orgTokenKey: email } — taught by manually linking a clash to GTEC,
  // so future syncs auto-link the same org's events (acronyms etc. that can't be
  // derived from the email alone).
  const [gtecLinks, setGtecLinks] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_gtec_links")||"{}"); }catch{ return {}; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_gtec_links", JSON.stringify(gtecLinks)); }catch{ /* ignore */ } }, [gtecLinks]);
  // aliasNames: { primaryEmail: displayName } — overrides the default email-prefix label.
  const [bookerSeasons, setBookerSeasons] = useState(()=>{ try{ return JSON.parse(localStorage.getItem("fb_booker_seasons")||"{}"); }catch{ return {}; } });
  const [aliasNames, setAliasNames] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_alias_names")||"{}"); }catch{ return {}; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_alias_names", JSON.stringify(aliasNames)); }catch{ /* ignore */ } }, [aliasNames]);
  // aliasColors: { primaryEmail: "#hex" } — admin-set chip colour overrides.
  // AMUA organisation details + operations contacts (the `amua_org` setting). Mirrored into
  // the module-level AMUA_INFO, which the billing-document renderers read.
  const [amuaOrg, setAmuaOrg] = useState(()=>{
    let init = {}; try{ init = JSON.parse(localStorage.getItem("fb_amua_org")||"{}"); }catch{ /* ignore */ }
    applyAmuaOrg(init);
    return init;
  });
  const [showAmuaModal, setShowAmuaModal] = useState(false);
  const [showContactModal, setShowContactModal] = useState(()=>{ try{ return new URLSearchParams(window.location.search).get("contact")==="1"; }catch{ return false; } });
  const [contactFor, setContactFor] = useState("");   // booker whose council contact is being edited (admins booking for someone)
  const [bookerContacts, setBookerContacts] = useState(null);
  async function loadBookerContacts() {
    if (!configured) return;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/booker_contacts?select=*`, { headers: authHeaders() });
      if (!r.ok) return;   // table not set up yet: nothing is gated
      const map = {}; (await r.json()).forEach(c => { map[(c.email||"").toLowerCase()] = c; });
      setModuleState({ _bookerContacts: map }); setBookerContacts(map);
    } catch { /* offline */ }
  }
  // Booker chip colours belong to the signed-in profile, not the whole app: each login picks
  // its own (kept in its Supabase user metadata, so every device that login uses sees them,
  // with a per-login copy in this browser). Until a login has picked any, it starts from the
  // colours this browser last showed (the old shared set), and otherwise the auto palette.
  const colorKey = em => "fb_alias_colors:" + (em||"").toLowerCase();
  const [aliasColors, setAliasColors] = useState(()=>{
    let init = {}; try{ init = JSON.parse(localStorage.getItem("fb_alias_colors")||"{}"); }catch{ /* ignore */ }
    setModuleState({ _emailColorOverrides: init }); // make available to module-level emailColor on first render
    return init;
  });
  // Mirror into the module-level map synchronously so emailColor() reflects edits
  // on the very next render (no one-frame lag).
  setModuleState({ _emailColorOverrides: aliasColors });
  useEffect(()=>{
    const u = session?.user; if (!u?.email) return;
    const meta = u.user_metadata?.booker_colors;
    let mine = meta && typeof meta === "object" ? meta : null;
    if (!mine) { try { mine = JSON.parse(localStorage.getItem(colorKey(u.email)) || "null"); } catch { /* ignore */ } }
    if (mine) setAliasColors(mine);
  }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Always-current refs for the data the GTEC sync's matcher depends on. A deferred /
  // auto-triggered sync would otherwise close over stale mount-time values (before
  // loadSettings populated DB aliases), flagging false mismatches that a later manual
  // sync — running with current state — then resolves. Reading from refs makes both
  // paths identical. Assigned in render so they track the latest committed values.
  const emailAliasesRef = useRef(emailAliases); emailAliasesRef.current = emailAliases;
  const gtecLinksRef     = useRef(gtecLinks);    gtecLinksRef.current     = gtecLinks;
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
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  // Who's using this (possibly shared) login: first name + last initial, asked after sign-in
  // and editable from the user menu. Stamped on activity-log entries.
  const [actor, setActorState] = useState("");
  const askingActor = useRef(false);
  useEffect(() => {
    const on = e => setActorState(e.detail || "");
    window.addEventListener("amua-actor", on);
    return () => window.removeEventListener("amua-actor", on);
  }, []);
  async function ensureActor(edit = false) {
    const user = session?.user; if (!user || askingActor.current) return;
    askingActor.current = true;
    try {
      if (edit) await askActor({ supabase, user, edit: true });
      while (session?.user && !getActor(user.email)) {
        if (await askActor({ supabase, user, onSignOut: handleLogout }) === null) break;
      }
    } finally { askingActor.current = false; setActorState(getActor(user.email)); }
  }
  useEffect(() => {
    if (!session?.user) { setActorState(""); return; }
    if (getActor(session.user.email)) setActorState(getActor(session.user.email)); else ensureActor();
  }, [session?.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [silentMode, setSilentMode] = useState(true); // admin: suppress all outgoing emails
  // fb_profiles: { [primaryEmail]: { fullName, officialName, address, gstNumber,
  //               accountNumber, accountName, profileType: "user"|"admin"|"vendor" } }
  const [profiles, setProfiles] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_profiles")||"{}"); }catch{ return {}; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_profiles", JSON.stringify(profiles)); }catch{ /* ignore */ } }, [profiles]);
  // Who counts as a booker for the email rule (see isBookerAddress).
  useEffect(()=>{
    const b = new Set(); bookings.forEach(x => { const e = (x.email||"").toLowerCase(); if (e) { b.add(e); if (_emailAliases[e]) b.add(_emailAliases[e]); } });
    Object.entries(profiles||{}).forEach(([e, pr]) => { if (pr?.profileType !== "vendor") b.add(e.toLowerCase()); });
    setModuleState({ _bookerEmails: b });
    setModuleState({ _vendorEmails: new Set(Object.entries(profiles||{}).filter(([, pr]) => pr?.profileType === "vendor").map(([e]) => e.toLowerCase())) });
  }, [bookings, profiles]);
  // fb_billing_records: official invoice history { id, referenceId, date, type, bookerEmails,
  //   amount, gstMode, status, gtecInvoiceNumber, clubPayment, amuaPayment, bookingIds }
  const [billingRecords, setBillingRecords] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_billing_records")||"[]"); }catch{ return []; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_billing_records", JSON.stringify(billingRecords)); }catch{ /* ignore */ } }, [billingRecords]);
  // fb_cpsa_delete_log: cancellations of bookings that had already reached GTEC's
  // schedule (queued for GTEC or beyond). GTEC still holds these slots, so they must
  // be emailed to GTEC for purging. Each entry snapshots the booking at deletion:
  //   { id, name, email, date, facility_id, start_hour, duration, status, deletedAt }
  const [cpsaDeleteLog, setCpsaDeleteLog] = useState(()=>{
    try{ return JSON.parse(localStorage.getItem("fb_cpsa_delete_log")||"[]"); }catch{ return []; }
  });
  useEffect(()=>{ try{ localStorage.setItem("fb_cpsa_delete_log", JSON.stringify(cpsaDeleteLog)); }catch{ /* ignore */ } }, [cpsaDeleteLog]);
  // Drop purge requests that no longer need sending: the booker re-booked the slot, or the
  // last sync shows GTEC doesn't hold it for them. Waits for bookings to load.
  useEffect(()=>{
    if (!bookings.length || !cpsaDeleteLog.length) return;
    const canon = em => (emailAliases[(em||"").toLowerCase()] || (em||"").toLowerCase());
    const keep = cpsaDeleteLog.filter(r => !purgeObsolete(r, bookings, syncFeed, canon));
    if (keep.length !== cpsaDeleteLog.length) setCpsaDeleteLog(keep);
  }, [bookings, syncFeed, emailAliases, cpsaDeleteLog]);
  // The details panel holds the booking it was opened with; follow reloads (a sync confirming
  // it, a status change) so it never shows a stale status beside the live feed note.
  useEffect(()=>{ setViewing(v => { if (!v) return v; const cur = bookings.find(b => b.id === v.id);
    return cur && (cur.status !== v.status || cur.system_notes !== v.system_notes || cur.updated_at !== v.updated_at) ? { ...v, ...cur } : v; }); }, [bookings]);
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
      if (em && em!=="combined" && !PROVIDERS[em]) emails = [em];
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
  // Booker categories collapsed to a single chip in the filter bar (remembered per device);
  // NZU/AU starts collapsed.
  const [collapsedSeasons, setCollapsedSeasons] = useState(()=>{ try{ const v=JSON.parse(localStorage.getItem("fb_collapsed_seasons")||"null"); if(Array.isArray(v)) return new Set(v); }catch{ /* ignore */ }
    return new Set(LEAGUE_SEASONS.filter(x=>x.collapsed).map(x=>x.id)); });
  const toggleSeasonCollapsed = sid => setCollapsedSeasons(prev=>{ const n=new Set(prev); n.has(sid)?n.delete(sid):n.add(sid); try{ localStorage.setItem("fb_collapsed_seasons", JSON.stringify([...n])); }catch{ /* ignore */ } return n; });
  const [listBookerFilter, setListBookerFilter] = useState(()=>{ try{ return new Set(JSON.parse(localStorage.getItem("fb_booker_filter")||"[]")); }catch{ return new Set(); } }); // empty = all (additive multi-select)
  useEffect(()=>{ try{ localStorage.setItem("fb_booker_filter",JSON.stringify([...listBookerFilter])); }catch{ /* ignore */ } },[listBookerFilter]);
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
  const [listView, setListView] = useTableView("fb_list_view");   // Bookings tab: grouped | itemised
  const [showAdminScheduleModal, setShowAdminScheduleModal] = useState(false);
  const [showExtensionModal, setShowExtensionModal] = useState(false);
  const [approxPlayers, setApproxPlayers] = useState(()=>{
    try{return JSON.parse(localStorage.getItem("fb_approx_players")||"{}");}catch{return {};}
  });
  const [approxDurations, setApproxDurations] = useState(()=>{
    try{return JSON.parse(localStorage.getItem("fb_approx_durations")||"{}");}catch{return {};}
  });
  const [pricingMode, setPricingModeState] = useState(()=>localStorage.getItem("fb_pricing_mode")||"hourly");
  const [listDateFrom,    setListDateFrom]      = useState(()=>todayKey());
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
    // Pages on this site that signed in through here (their own URL isn't a Supabase redirect
    // URL) leave a return path; go back once the session has landed.
    const bounce = s => { try { const back = sessionStorage.getItem("amua-after-login");
      if (s && back && /^[\w.-]+\.html$/.test(back)) { sessionStorage.removeItem("amua-after-login"); location.replace(import.meta.env.BASE_URL + back); } } catch { /* storage blocked */ } };
    supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      bounce(s);
      setSession(s);
      setModuleState({ _accessToken: s?.access_token || null });
      setModuleState({ _currentUser: s?.user ? { id: s.user.id, email: s.user.email, role: s.user.app_metadata?.role } : null });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((evt, s) => {
      if (evt === "SIGNED_OUT") logActivity("sign_out", {}); // log before clearing _currentUser
      setSession(s);
      setModuleState({ _accessToken: s?.access_token || null });
      setModuleState({ _currentUser: s?.user ? { id: s.user.id, email: s.user.email, role: s.user.app_metadata?.role } : null });
      if (evt === "SIGNED_IN") { logActivity("sign_in", { email: s?.user?.email }); bounce(s); }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  function showToast(msg,type="success"){setToast({msg,type});setTimeout(()=>setToast(null),3500);}
  // Send a batch of council bookings to the council as one application: fixes each booking's
  // share of the $10-per-field fee and moves it to "awaiting council decision".
  async function handleSendToCouncil(ids) {
    const bkgs = bookings.filter(b => ids.includes(b.id) && canSendToCouncil(b));
    if (!bkgs.length) return;
    const sp = councilFeeSplit(bkgs);
    const raw = window.prompt("Council application number from the portal (e.g. fef887de). Leave blank if you haven't submitted it yet — a local reference is used.", "");
    if (raw === null) return;   // cancelled
    const ref = raw.trim().replace(/\s+/g,"");
    const appId = ref || `CA-${todayKey().replace(/-/g,"")}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    const split = Object.entries(sp.byBooker).map(([e,v])=>`${aliasNames[e]||e}: $${v.toFixed(2)}`).join("\n");
    if (!window.confirm(`Send ${bkgs.length} booking${bkgs.length!==1?"s":""} to the council as application ${appId}?\n\n${sp.fields} field${sp.fields!==1?"s":""} × $${COUNCIL_APPLICATION_FEE} = $${sp.total.toFixed(2)}, split:\n${split}`)) return;
    const at = new Date().toISOString();
    try {
      const notes = {};
      for (const b of bkgs) {
        const sys = (b.system_notes||"").replace(new RegExp(COUNCIL_APP_RE.source,"g"),"").trim();
        notes[b.id] = `${sys}${sys?"\n":""}[COUNCIL_APP ${appId} ${at} fee=${sp.fees[b.id]}]`;
      }
      // Different bookers on the same council field (or multi-field area) at overlapping
      // times share it as a parent–child slot: whoever booked first is the parent.
      const sentIds = new Set(bkgs.map(b => b.id)), extra = [];
      councilOverlaps(bookings).filter(c => c.bookings.some(b => sentIds.has(b.id)) && new Set(c.bookings.map(b => canonEmail((b.email||"").toLowerCase()))).size > 1)
        .forEach(c => { // completes a link a booker couldn't write on the parent when they booked
          const members = [...c.bookings].sort((a, b) => (a.created_at||"").localeCompare(b.created_at||""));
          const ids = new Set(members.map(b => parseSlotLink(b.system_notes)?.id || "")), id = [...ids].find(Boolean) || newSlotRef();
          if (ids.size === 1 && !ids.has("") && members.every(b => parseSlotLink(b.system_notes)?.role !== "peer")) return;   // already one group
          const shares = evenSlotShares(members.length);
          members.forEach((b, i) => { const base = notes[b.id] ?? b.system_notes ?? "";
            notes[b.id] = setSlotLink(base, id, i === 0 ? "parent" : "child", shares[i]); if (!sentIds.has(b.id)) extra.push(b.id); }); });
      for (const b of bkgs) await sb.update("bookings", b.id, { status:"council_pending", system_notes:notes[b.id], updated_at:at });
      for (const id of extra) await sb.update("bookings", id, { system_notes:notes[id], updated_at:at });
      if (extra.length || Object.values(notes).some(n => /\[SLOT\]/.test(n))) logActivity("slot_shared", { appId, ids:Object.keys(notes).filter(k => /\[SLOT\]/.test(notes[k])) });
      logActivity("council_application_sent", { appId, ids: bkgs.map(b=>b.id), fields: sp.fields, total: sp.total, split: sp.byBooker });
      await loadBookings();
      showToast(`Sent to council as ${appId} · fee $${sp.total.toFixed(2)} split across ${Object.keys(sp.byBooker).length} booker${Object.keys(sp.byBooker).length!==1?"s":""}.`);
    } catch(e) { showToast("Couldn't record the council application: "+e.message, "error"); }
  }

  // ── Council email sync ─────────────────────────────────────────────────────────
  // Same shape as the GTEC sync: read the source (the council's emails in AMUA's Gmail,
  // read-only), merge what changed into the stored outcomes, then queue the bookings'
  // status changes in the cart for the admin to submit. Nothing is ever sent to the council.
  async function saveCouncilOutcomes(next) {
    setCouncilOutcomes(next);
    try{localStorage.setItem("fb_council_outcomes",JSON.stringify(next));}catch{ /* ignore */ }
    return persistSetting("council_outcomes", next);
  }
  async function handleCouncilMailSync() {
    if (councilSyncing) return;
    setCouncilSyncing(true);
    const at = new Date().toISOString();
    try {
      const tok = await gmailToken();
      const mails = await fetchCouncilEmails(tok);
      const parsed = mails.map(parseCouncilEmail).filter(m => Object.keys(m.apps).length).sort((a,b)=>a.date.localeCompare(b.date));
      const { next, changed } = mergeCouncilOutcomes(councilOutcomes, parsed);
      if (changed.length) await saveCouncilOutcomes(next);
      const queued = queueCouncilOutcomeChanges(next);
      const entry = { at, emails: mails.length, apps: Object.keys(next).length, changed, queued };
      setCouncilSyncLog(l => [entry, ...l].slice(0, 30));
      logActivity("council_mail_sync", { emails: mails.length, changed: changed.length, queued });
      showToast(`🏛 Council emails: ${mails.length} read · ${changed.length} application update${changed.length!==1?"s":""} · ${queued} booking change${queued!==1?"s":""} queued`);
    } catch(e) {
      setCouncilSyncLog(l => [{ at, error: String(e?.message||e) }, ...l].slice(0, 30));
      showToast("Council email sync: "+(e?.message||e), "error");
    } finally { setCouncilSyncing(false); }
  }
  // Bookings on an application move with its outcome: an offer → council_action, a
  // confirmation → council_granted (both silent), a decline → rejected (the booker is told
  // why). Never backwards, and never twice: bookings already queued in the cart are skipped.
  function queueCouncilOutcomeChanges(outcomes) {
    const inCart = new Set(cart.filter(i=>i.statusChange).flatMap(i=>i.ids));
    const from = { action:["council_pending"], confirmed:["council_pending","council_action"], declined:["council_pending","council_action","council_granted"] };
    let n = 0;
    for (const o of Object.values(outcomes)) {
      const ok = from[o.outcome]; if (!ok) continue;
      const ids = councilAppBookings(bookings, o.id).filter(b => ok.includes(b.status) && !inCart.has(b.id)).map(b => b.id);
      if (!ids.length) continue;
      if (o.outcome === "action") handleBulkStatusChange(ids, "council_action", "", true);
      else if (o.outcome === "confirmed") handleBulkStatusChange(ids, "council_granted", "", true);
      else handleBulkStatusChange(ids, "rejected", `Auckland Council declined application ${o.id}${o.park ? ` (${o.park})` : ""}.${o.reason ? " " + o.reason : ""}`);
      ids.forEach(id => inCart.add(id)); n += ids.length;
    }
    return n;
  }
  // Point bookings at a council application number (e.g. a local CA-… reference once the
  // council's own number is known), keeping their recorded fee share.
  async function handleLinkCouncilApp(appId, ids) {
    const at = new Date().toISOString();
    try {
      for (const b of bookings.filter(x => ids.includes(x.id))) {
        const cur = parseCouncilApp(b.system_notes), sys = (b.system_notes||"").replace(new RegExp(COUNCIL_APP_RE.source,"g"),"").trim();
        await sb.update("bookings", b.id, { system_notes:`${sys}${sys?"\n":""}[COUNCIL_APP ${appId} ${cur?.at||at} fee=${cur?.fee ?? 0}]`, updated_at:at });
      }
      logActivity("council_application_linked", { appId, ids });
      await loadBookings();
      showToast(`Linked ${ids.length} booking${ids.length!==1?"s":""} to application ${appId}.`);
    } catch(e) { showToast("Couldn't link the bookings: "+e.message, "error"); }
  }

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
      // Booker identity settings — global, admin-managed; load for every user so the
      // merge (aliases), display names, chip colours and profiles persist across devices.
      if (map.email_aliases && typeof map.email_aliases === "object") {
        setEmailAliases(map.email_aliases); setModuleState({ _emailAliases: map.email_aliases });
        emailAliasesRef.current = map.email_aliases; // keep the sync matcher's ref current immediately
        try{localStorage.setItem("fb_email_aliases",JSON.stringify(map.email_aliases));}catch{ /* ignore */ }
      }
      if (map.alias_names && typeof map.alias_names === "object") {
        setAliasNames(map.alias_names);
        try{localStorage.setItem("fb_alias_names",JSON.stringify(map.alias_names));}catch{ /* ignore */ }
      }
      if (map.booker_seasons && typeof map.booker_seasons === "object") {
        setBookerSeasons(map.booker_seasons);
        try{localStorage.setItem("fb_booker_seasons",JSON.stringify(map.booker_seasons));}catch{ /* ignore */ }
      }
      // alias_colors is no longer shared: chip colours are per profile (see aliasColors).

      // Council fields added per booker from the Council fields page.
      if (map.provider_contact_reviews && typeof map.provider_contact_reviews === "object") setModuleState({ _contactReviews: map.provider_contact_reviews });
      if (map.council_facilities && typeof map.council_facilities === "object") {
        applyCouncilFacilities(map.council_facilities); setCouncilFacRev(n => n + 1);
        try{localStorage.setItem("fb_council_facilities",JSON.stringify(map.council_facilities));}catch{ /* ignore */ }
      }
      if (map.council_outcomes && typeof map.council_outcomes === "object") {
        setCouncilOutcomes(map.council_outcomes);
        try{localStorage.setItem("fb_council_outcomes",JSON.stringify(map.council_outcomes));}catch{ /* ignore */ }
      }
      if (map.amua_org && typeof map.amua_org === "object") {
        applyAmuaOrg(map.amua_org); setAmuaOrg(map.amua_org);
        try{localStorage.setItem("fb_amua_org",JSON.stringify(map.amua_org));}catch{ /* ignore */ }
      }
      // NB: `profiles` is intentionally NOT loaded/stored here — it holds sensitive
      // billing details (addresses, GST, admin bank account) and the settings table
      // is anon-readable. Profiles stay device-local until an admin-only store exists.
    } catch(e) {
      // settings table may not yet exist; silent fallback to localStorage
      console.warn("loadSettings:", e.message);
    }
  }

  async function persistSetting(key, value) {
    if(!configured) return true;
    try { await sb.upsert("settings", { key, value, updated_at: new Date().toISOString() }, "key"); return true; }
    catch(e) { console.warn("persistSetting "+key+":", e.message); return false; }
  }

  async function handleSyncMonth(year, month, pastedEvents = null) {
    setSyncingMonth(true);
    try {
      setSyncProgress(p => p && { ...p, phase: "Reading GTEC…" });
      const events = pastedEvents || await fetchCJREvents(year, month);
      setSyncProgress(p => p && { ...p, phase: `Matching ${events.length} entr${events.length === 1 ? "y" : "ies"}…` });
      let added = 0, skipped = 0, removed = 0, cpsaConfirmed = 0, cpsaReviewNeeded = 0;
      const addedBookings = []; // snapshots of bookings added this sync (for the expandable log)
      const reviewBookings = []; // user bookings flagged needing review (mismatch) this sync
      const clashBookings = [];  // user bookings flagged as clash this sync
      const currentBookings = configured ? (await sb.select("bookings")) : bookings;
      const matchedUserIds = new Set();
      const cpsaNotifications = []; // notify-only cart items for first-time CPSA status changes

      // Canonical key per feed event, used to spot admin blocks the feed no longer has.
      const feedKeys = new Set();
      for (const ev of events) {
        const date = parseCJRDate(ev.EventStartDate);
        if (!date) continue;
        const { start_hour } = parseCJRDateTime(ev.EventDateTime);
        const purpose = ev.EventName || "External Booking";
        const facilityIds = mapCJRFacility(purpose, ev);
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

      // Collapse duplicate admin (GTEC) bookings — the same GTEC event imported more than
      // once. Past concurrent syncs each snapshotted bookings before either inserted, so
      // both passed the "already exists?" check and inserted, leaving 2+ identical blocks
      // for one slot. Keep the first occurrence of each slot+purpose, remove the rest.
      // (The sync lock below stops new duplicates; this cleans up historical ones.)
      const adminSlotSeen = new Set();
      const dupAdminBks = currentBookings.filter(b => {
        if (!isAdminBooking(b) || !b.date.startsWith(monthStr)) return false;
        const key = `${b.date}|${b.facility_id}|${b.start_hour}|${b.duration}|${b.purpose}`;
        if (adminSlotSeen.has(key)) return true;
        adminSlotSeen.add(key);
        return false;
      });
      for (const dupBk of dupAdminBks) {
        if (configured) await sb.remove("bookings", dupBk.id);
        else setBookings(prev => prev.filter(b => b.id !== dupBk.id));
        removed++;
        logActivity("cpsa_admin_booking_remove", { id: dupBk.id, date: dupBk.date, facility_id: dupBk.facility_id, purpose: dupBk.purpose, duplicate: true });
      }

      // GTEC often lists several events that overlap one booking — a split time-slot,
      // a duplicate listing, or one booking spanning two fields. findMatchingUserBooking
      // returns that same booking for each, so resolving and writing per-event made the
      // LAST overlapping event win: a non-exact event arriving after the exact one falsely
      // flagged a mismatch. Because the proxy feed returns events in a varying order, it
      // took several manual syncs to land an order where the exact match happened to win
      // last. Resolve the BEST match per booking across all events first (exact/confirmed
      // beats mismatch; fewer reasons breaks ties), then apply once — order-independent,
      // and convergent in a single pass.
      const bestByBooking = new Map(); // bookingId -> { match, gtecSnap, effectiveExact, rank }
      const matchedSlots = [];         // every matched event's slot, for admin-booking cleanup
      const unmatchedEvents = [];      // events with no user booking → become admin bookings

      for (const ev of events) {
        const date = parseCJRDate(ev.EventStartDate);
        if (!date) { skipped++; continue; }
        const { start_hour, duration } = parseCJRDateTime(ev.EventDateTime);
        const purpose = ev.EventName || "External Booking";
        const facilityIds = mapCJRFacility(purpose, ev);

        // Check if this CPSA event matches an existing approved user booking
        const match = findMatchingUserBooking(currentBookings, ev, facilityIds, gtecLinksRef.current, emailAliasesRef.current);
        if (!match) { unmatchedEvents.push({ date, start_hour, duration, purpose, facilityIds }); continue; }

        matchedUserIds.add(match.booking.id);
        matchedSlots.push({ date, start_hour, duration, facilityIds });
        // A booking the admin has explicitly marked "✓ Confirmed by GTEC" stays confirmed:
        // its resolution is sticky, so a non-exact match must never reactivate the mismatch
        // (drop it back to cpsa_review_needed) on it.
        const confirmedByGtec = parseCpsaResolution(match.booking.system_notes)?.resolution === "confirmed";
        const effectiveExact = match.exact || confirmedByGtec;
        // Rank: exact/confirmed (2) beats mismatch (1); ties → fewest reasons wins.
        const rank = (effectiveExact ? 2 : 1) * 1000 - (match.reasons?.length || 0);
        const gtecSnap = { name: ev.EventName || "", date, start_hour, duration, facilityIds };
        const prev = bestByBooking.get(match.booking.id);
        if (!prev || rank > prev.rank) bestByBooking.set(match.booking.id, { match, gtecSnap, effectiveExact, rank });
        // The same entry's other fields ("Field 2 & 3") match the booker's booking on each.
        for (const sib of match.siblings || []) {
          matchedUserIds.add(sib.booking.id);
          const sConfirmed = parseCpsaResolution(sib.booking.system_notes)?.resolution === "confirmed";
          const sExact = sib.exact || sConfirmed, sRank = (sExact ? 2 : 1) * 1000 - (sib.reasons?.length || 0), sp = bestByBooking.get(sib.booking.id);
          if (!sp || sRank > sp.rank) bestByBooking.set(sib.booking.id, { match: sib, gtecSnap, effectiveExact: sExact, rank: sRank });
        }
        // Other bookings by the same booker this event overlaps: mismatches, ranked below any
        // direct match (so an exact match from another event still wins). A booking the
        // admin confirmed stays confirmed.
        for (const o of match.also || []) {
          if (parseCpsaResolution(o.booking.system_notes)?.resolution === "confirmed") continue;
          matchedUserIds.add(o.booking.id);
          const oRank = 500 - (o.reasons?.length || 0), op = bestByBooking.get(o.booking.id);
          if (!op || oRank > op.rank) bestByBooking.set(o.booking.id, { match: o, gtecSnap, effectiveExact: false, rank: oRank });
        }
      }

      // Duplicates: a booker's booking on another field at exactly the time of one GTEC confirmed,
      // when no entry holds that other field (e.g. a Monday Field #1 session copied onto Field #2).
      // It only matched as a leftover of the confirmed one's entry; flag it as a duplicate and queue
      // it for removal (the admin still submits the removal cart). A booking the admin marked
      // confirmed is kept.
      {
        const canonE = e => { const x = (e||"").toLowerCase(); return (emailAliasesRef.current[x] || x); };
        const entries = [...bestByBooking.values()];
        const dupes = [];
        for (const d of entries) {
          const x = d.match.booking;
          if (d.effectiveExact || d.rank >= 1000) continue;
          if (parseCpsaResolution(x.system_notes)?.resolution === "confirmed") continue;
          const twin = entries.find(o => o.effectiveExact && o.match.booking.id !== x.id && o.match.booking.date === x.date
            && o.match.booking.start_hour === x.start_hour && o.match.booking.duration === x.duration
            && o.match.booking.facility_id !== x.facility_id && canonE(o.match.booking.email) === canonE(x.email)
            && !(o.gtecSnap.facilityIds || []).includes(x.facility_id));
          if (!twin) continue;
          const fieldHeld = events.some(ev => parseCJRDate(ev.EventStartDate) === x.date && mapCJRFacility(ev.EventName || "", ev).includes(x.facility_id)
            && (() => { const t = parseCJRDateTime(ev.EventDateTime); return t.allDay || (t.start_hour < x.start_hour + x.duration && t.start_hour + t.duration > x.start_hour); })()
            && findMatchingUserBooking([x], ev, mapCJRFacility(ev.EventName || "", ev), gtecLinksRef.current, emailAliasesRef.current));
          if (fieldHeld) continue;
          d.match = { ...d.match, reasons: [`Duplicate of the GTEC-confirmed ${facShort(twin.match.booking.facility_id)} booking — GTEC holds ${(twin.gtecSnap.facilityIds||[]).map(facShort).join("/")} only; queued for removal`] };
          dupes.push(x);
        }
        if (dupes.length) {
          setDeleteQueue(prev => [...prev, ...dupes.filter(x => !prev.some(p => p.id === x.id))]);
          logActivity("cpsa_duplicates_queued", { ids: dupes.map(x => x.id) });
          showToast(`${dupes.length} duplicate booking${dupes.length !== 1 ? "s" : ""} (another field, same time as a GTEC-confirmed one) queued for removal — review the removal cart.`, "info");
        }
      }

      // Remember what the feed held for each day (shown on bookings' details for admins).
      {
        const byDate = {};
        for (const ev of events) {
          const date = parseCJRDate(ev.EventStartDate); if (!date) continue;
          const { start_hour, duration, allDay } = parseCJRDateTime(ev.EventDateTime);
          const facilityIds = mapCJRFacility(ev.EventName || "", ev);
          const m = findMatchingUserBooking(currentBookings, ev, facilityIds, gtecLinksRef.current, emailAliasesRef.current);
          (byDate[date] ||= []).push({ name: ev.EventName || "", team: extractCPSATeam(ev.EventName || ""), email: extractEventDetailsEmail(ev.EventDetails),
            when: ev.EventDateTime || ev.EventStartDate || "", start_hour, duration, allDay: !!allDay, facilityIds,
            matched: m ? { id: m.booking.id, exact: m.exact, reasons: m.reasons || [] } : null });
        }
        setSyncFeed(prev => ({ at: new Date().toISOString(), months: [...new Set([...(prev.months || []), monthStr])],
          byDate: { ...Object.fromEntries(Object.entries(prev.byDate).filter(([d]) => !d.startsWith(monthStr))), ...byDate } }));
      }

      setSyncProgress(p => p && { ...p, phase: "Saving…" });
      // Apply the winning match for each booking exactly once.
      for (const { match, gtecSnap, effectiveExact } of bestByBooking.values()) {
        const booking = match.booking;
        const targetStatus = effectiveExact ? "cpsa_confirmed" : "cpsa_review_needed";
        // Record/clear mismatch reasons + GTEC snapshot in system_notes (separate from
        // user notes). stripMismatchNote clears both on confirm; matching a previously-
        // clashing booking also clears its stale clash marker.
        const baseNotes = stripClashPrevStatus(booking.system_notes);
        const newSysNotes = targetStatus === "cpsa_review_needed"
          ? setGtecSnapshot(setMismatchNote(baseNotes, match.reasons), gtecSnap)
          : stripMismatchNote(baseNotes);
        const statusChanged = booking.status !== targetStatus;
        const sysNotesChanged = (booking.system_notes || "") !== newSysNotes;
        if (statusChanged || sysNotesChanged) {
          if (configured) {
            // Always update status first — this is the critical write.
            if (statusChanged) await sb.update("bookings", booking.id, { status: targetStatus, updated_at: new Date().toISOString() });
            // system_notes is best-effort: silently no-ops until migration is run.
            if (sysNotesChanged) sb.update("bookings", booking.id, { system_notes: newSysNotes }).catch(() => {});
          } else {
            const patch = { status: targetStatus, system_notes: newSysNotes, updated_at: new Date().toISOString() };
            setBookings(prev => prev.map(b => b.id === booking.id ? { ...b, ...patch } : b));
          }
        }
        if (statusChanged) {
          if (effectiveExact) cpsaConfirmed++; else {
            cpsaReviewNeeded++;
            reviewBookings.push({ id:booking.id, date:booking.date, facility_id:booking.facility_id, start_hour:booking.start_hour, duration:booking.duration, purpose:booking.purpose, name:booking.name, email:booking.email, reasons: match.reasons||[], gtec: gtecSnap });
          }
          logActivity(effectiveExact?"cpsa_confirm":"cpsa_review_flag", { booking_id: booking.id, from: booking.status, to: targetStatus, reasons: match.reasons||[] });
          // First-time transition into a CPSA status → queue a notify-only cart item.
          if (booking.email && !isAdminBooking(booking)) {
            cpsaNotifications.push({
              drafts: [{ ...booking, status: targetStatus, system_notes: newSysNotes }],
              name: booking.name, email: booking.email,
              notifyOnly: true, newStatus: targetStatus,
            });
          }
        }
      }

      // Remove pre-existing admin bookings at every matched slot (from prior syncs) so the
      // now-linked user booking owns the slot instead of clashing with a stale GTEC import.
      for (const slot of matchedSlots) {
        for (const facility_id of slot.facilityIds) {
          const slotBk = { date: slot.date, facility_id, start_hour: slot.start_hour, duration: slot.duration, id: "_sentinel_" };
          const oldAdmin = currentBookings.find(b => isAdminBooking(b) && timeOverlaps(b, slotBk));
          if (oldAdmin) {
            if (configured) await sb.remove("bookings", oldAdmin.id);
            else setBookings(prev => prev.filter(b => b.id !== oldAdmin.id));
          }
        }
      }

      // Events with no matching user booking become admin (GTEC-owned) bookings.
      for (const { date, start_hour, duration, purpose, facilityIds } of unmatchedEvents) {
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

      // Clear the CPSA flag on bookings nothing in the feed links to any more. The test
      // is whether some event would STILL match this booking — not whether one merely
      // overlaps it in time. That distinction matters: a booking simply outscored by
      // another this run still matches, so it keeps its flag and a legitimate mismatch is
      // never silently wiped; but a flag left by a link the matcher no longer makes can
      // now clear. Under the old overlap test it could not — the event still sat over the
      // booking in time, so the stale mismatch stuck forever and the booking showed up in
      // the mismatch panel AND as a clash at the same time.
      const cpsaLinkedUnmatched = currentBookings.filter(b => {
        if (isAdminBooking(b)) return false;
        if (!b.date.startsWith(monthStr) || b.date < syncToday) return false;
        if (b.status !== "cpsa_confirmed" && b.status !== "cpsa_review_needed") return false;
        if (matchedUserIds.has(b.id)) return false;
        const stillMatchable = events.some(ev2 => {
          if (parseCJRDate(ev2.EventStartDate) !== b.date) return false;
          return !!findMatchingUserBooking([b], ev2, mapCJRFacility(ev2.EventName || "", ev2),
            gtecLinksRef.current, emailAliasesRef.current);
        });
        return !stillMatchable;
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
      let clashUpdates = 0, clashResolved = 0;
      for (const ub of userBks) {
        // Skip bookings already matched/confirmed via CPSA — their admin slot was removed above
        if (matchedUserIds.has(ub.id)) continue;
        if (ub.status === "cpsa_confirmed" || ub.status === "cpsa_review_needed") continue;
        // The specific GTEC events this booking overlaps — captured in full so the
        // clash views can show what the incoming event actually was (informs whether
        // a match was possible).
        const clashAdmins = adminBks.filter(ab => ab.facility_id === ub.facility_id && timeOverlaps(ab, ub));
        const hasClash = clashAdmins.length > 0;
        if (hasClash && ub.status !== "clash") {
          // Flag as clash, remembering the stage it was at so it can be restored later.
          const sysNotes = setClashPrevStatus(ub.system_notes, ub.status);
          if (configured) {
            await sb.update("bookings", ub.id, { status: "clash", updated_at: new Date().toISOString() });
            sb.update("bookings", ub.id, { system_notes: sysNotes }).catch(() => {});
          } else {
            setBookings(prev => prev.map(b => b.id === ub.id ? {...b, status:"clash", system_notes: sysNotes} : b));
          }
          clashBookings.push({ id:ub.id, date:ub.date, facility_id:ub.facility_id, start_hour:ub.start_hour, duration:ub.duration, purpose:ub.purpose, name:ub.name, email:ub.email,
            gtec: clashAdmins.map(ab=>({ name: ab.purpose||"", date: ab.date, start_hour: ab.start_hour, duration: ab.duration, facilityIds: [ab.facility_id] })) });
          clashUpdates++;
        } else if (!hasClash && ub.status === "clash") {
          // Clash resolved (admin slot gone) → restore the prior workflow stage.
          const restored = parseClashPrevStatus(ub.system_notes) || "pending_amua";
          const sysNotes = stripClashPrevStatus(ub.system_notes);
          if (configured) {
            await sb.update("bookings", ub.id, { status: restored, updated_at: new Date().toISOString() });
            sb.update("bookings", ub.id, { system_notes: sysNotes }).catch(() => {});
          } else {
            setBookings(prev => prev.map(b => b.id === ub.id ? {...b, status: restored, system_notes: sysNotes} : b));
          }
          clashResolved++;
        }
      }
      if (configured && (clashUpdates > 0 || clashResolved > 0)) await loadBookings();

      // Queue CPSA status-change notifications in the cart (notify-only, no booking edits).
      if (cpsaNotifications.length) {
        // Group per booker + status so a booker whose multiple bookings transition in
        // one sync receives a single email listing them all, not one email per booking.
        const groupedNotifs = {};
        for (const it of cpsaNotifications) {
          const k = it.email.toLowerCase()+"|"+it.newStatus;
          if (!groupedNotifs[k]) groupedNotifs[k] = { ...it, drafts: [] };
          groupedNotifs[k].drafts.push(...it.drafts);
        }
        setCart(prev => [...prev, ...Object.values(groupedNotifs)]);
      }

      const label = `${MONTHS[month]} ${year}`;
      const monthKey = `${year}-${String(month+1).padStart(2,"0")}`;
      const syncedAt = new Date().toISOString();
      const hadChanges = added + cpsaConfirmed + cpsaReviewNeeded + removed + clashUpdates + clashResolved > 0;
      setSyncResults(prev => {
        const existing = prev.find(r => r.monthKey === monthKey);
        const without = prev.filter(r => r.monthKey !== monthKey);
        // lastChangeAt = when this month last produced an actual new change; preserved
        // from the prior result when this sync turned up nothing new.
        const lastChangeAt = hadChanges ? syncedAt : (existing?.lastChangeAt || null);
        return [...without, { monthKey, label, added, skipped, removed, cpsaConfirmed, cpsaReviewNeeded, clashes: clashUpdates, clashesResolved: clashResolved, notified: cpsaNotifications.length, addedBookings, reviewBookings, clashBookings, syncedAt, lastChangeAt }];
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

  // Manual fallback when no relay can reach GTEC: the admin opens the month's calendar in a tab
  // and pastes its text; the month is then synced exactly as if it had been fetched.
  async function handlePasteFeed(monthKey, text) {
    let events;
    try { events = parseFeedText(text); } catch (e) { showToast("That isn't GTEC's calendar feed: " + e.message, "error"); return false; }
    if (syncRunningRef.current) { showToast("A sync is already running…", "info"); return false; }
    const [y, m] = monthKey.split("-").map(Number);
    syncRunningRef.current = true;
    try { await handleSyncMonth(y, m - 1, events); logActivity("cpsa_sync_pasted", { month: monthKey, events: events.length }); }
    finally { syncRunningRef.current = false; }
    showToast(`Synced ${MONTHS[m-1]} ${y} from the pasted feed (${events.length} entr${events.length===1?"y":"ies"}).`);
    return true;
  }

  async function handleSyncAll() {
    // Re-entrancy guard — never let two syncs run at once (they each duplicate every
    // admin block). Covers a double-click and the on-mount auto-sync racing a manual run.
    if (syncRunningRef.current) { showToast("A sync is already running…", "info"); return; }
    syncRunningRef.current = true;
    try {
      const today = todayKey();
      // Compute the month set from a fresh booking source so a deferred/auto sync doesn't
      // miss future months due to a stale `bookings` closure.
      const srcBookings = configured ? (await sb.select("bookings")) : bookings;
      const future = srcBookings.filter(b => b.date >= today);
      // Sync a CONTIGUOUS run of months, not just the months we happen to hold bookings
      // in. The old set was {this month} ∪ {months of our future bookings}, which left
      // two holes: a month where we hold nothing was never fetched at all, and a gap
      // between two booking months (bookings in Aug and Dec, nothing between) skipped
      // the months in between. On top of that the feed's month view returns a few days
      // either side of the month, so the first sync would import a boundary event into
      // the next month, and only the sync AFTER that would notice that month existed —
      // which is why a second run sometimes turned up bookings the first one missed.
      //
      // Run from this month through the furthest month we hold a future booking in, and
      // at least LOOKAHEAD months out regardless, capped so a booking years ahead can't
      // turn one sync into hundreds of fetches.
      const LOOKAHEAD = 3, MAX_MONTHS = 18;
      const now = new Date();
      const mIdx = (y,m) => y*12 + m;                       // months since year 0
      const firstIdx = mIdx(now.getFullYear(), now.getMonth());
      let lastIdx = firstIdx + LOOKAHEAD;
      for (const b of future) {
        const [y,m] = b.date.split("-").map(Number);
        if (Number.isFinite(y) && Number.isFinite(m)) lastIdx = Math.max(lastIdx, mIdx(y, m-1));
      }
      lastIdx = Math.min(lastIdx, firstIdx + MAX_MONTHS - 1);
      const sorted = [];
      for (let i = firstIdx; i <= lastIdx; i++) sorted.push([Math.floor(i/12), i%12]);
      // Drop months that have aged out of the retention window before re-syncing.
      purgeOldLogs();
      logActivity("cpsa_sync_start", { months: sorted.length });
      for (const [i,[y,m]] of sorted.entries()) {
        setSyncProgress({ done: i, total: sorted.length, label: `${MONTHS[m].slice(0,3)} ${y}`, phase: "" });
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
    } finally {
      syncRunningRef.current = false;
      setSyncProgress(null);
    }
  }

  // All hooks before any conditional return
  useEffect(()=>{
    if(!session) return;
    loadBookings();
    // Auto-sync CPSA if admin and last sync was more than 4 hours ago.
    if(session.user?.app_metadata?.role==="admin"){
      const last=parseInt(localStorage.getItem("fb_last_sync_at")||"0",10);
      if(Date.now()-last > 4*60*60*1000) {
        // Wait for settings (booker aliases / GTEC links) before the auto-sync so the
        // matcher uses authoritative identity data. Running early — before loadSettings
        // populates DB aliases — makes the matcher flag false mismatches that a later
        // manual sync then resolves. handleSyncAll fetches fresh bookings itself.
        (async()=>{ await loadSettings(); await handleSyncAll(); })();
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
  // Settings are readable only when signed in, so load them once the session has landed
  // (a load on first render goes out before the session is restored and gets no rows).
  // Reload when the tab comes back into view, so fields added on the Council fields page
  // (another tab) show up without a refresh.
  const signedInId = session?.user?.id || null;
  useEffect(()=>{
    if(!signedInId) return;
    (async()=>{ await loadSettings(); purgeOldLogs(); loadBookerContacts(); })();
    let last = Date.now();
    const onVis = () => { if (document.visibilityState === "visible" && Date.now() - last > 15000) { last = Date.now(); loadSettings(); } };
    document.addEventListener("visibilitychange", onVis); window.addEventListener("focus", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[signedInId]);

  const openNew=useCallback((date,startHour,duration=1,facility=null)=>{setEditing(null);setPrefill({date,startHour,duration,facility});setDayPopupDate(null);setShowForm(true);},[]);
  // Open the booking form pre-seeded with one row per day (grouped multi-day booking).
  const openNewRange=useCallback((dates,startHour=9,duration=1,facility=null)=>{setEditing(null);setPrefill({dates,startHour,duration,facility});setDayPopupDate(null);setShowForm(true);},[]);
  // Desktop keyboard shortcuts (ignored while typing or with a dialog open):
  // 1–8 tabs · n new booking · [ ] previous / next week · t this week · ? list them.
  useEffect(()=>{
    const onKey = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || window.innerWidth < 768) return;
      const t = e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector(".modal-backdrop, .actor-ov")) return;
      const tabs = ["about","calendar","month","list","summary", ...(loggedInEmail?["billing"]:[]), ...(isAdmin?["admin","allocation"]:[])];
      if (/^[1-8]$/.test(e.key) && tabs[+e.key-1]) { setTab(tabs[+e.key-1]); e.preventDefault(); }
      else if (e.key === "n") { openNew(todayKey(), 18, 1); e.preventDefault(); }
      else if (e.key === "[" || e.key === "]") { setFocusedDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() + (e.key === "]" ? 7 : -7)); return nd; }); if (tab !== "calendar") setTab("calendar"); }
      else if (e.key === "t") { setFocusedDate(new Date()); }
      else if (e.key === "?") showToast("Shortcuts: 1–8 tabs · n new booking · [ ] previous/next week · t this week");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isAdmin, loggedInEmail, tab, openNew]);
  const openDay=useCallback((dk,focusHour=null,duration=null)=>{setDayPopupDate(dk);setDayPopupFocus(focusHour);setDayPopupDur(focusHour!=null?duration:null);},[]);
  const openEdit=useCallback((b)=>{setEditing({...b});setViewing(null);setShowForm(true);},[]);

  bookings.forEach(b=>emailColor(b.email));
  if(loggedInEmail)emailColor(loggedInEmail);
  // Every booker already known to the system (canonical email → display name), for the
  // admin-block "convert to AMUA booking" picker. Deduped by canonical (primary) email.
  const knownBookers = [...new Map(
    bookings.filter(b=>!isAdminBooking(b)&&b.email).map(b=>{
      const primary = emailAliases[b.email.toLowerCase()] || b.email.toLowerCase();
      return [primary, { email: primary, name: aliasNames[primary] || b.name || primary.split("@")[0] }];
    })
  ).values()].map(bk => ({
    ...bk,
    // Every address that resolves to this booker, so an activity-log search finds
    // entries recorded against a linked secondary address too.
    addresses: [bk.email, ...Object.entries(emailAliases).filter(([,pri])=>pri===bk.email).map(([sec])=>sec)],
  })).sort((a,b)=>a.name.localeCompare(b.name));

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
    // Parent–child is set when the child books: a new booking on a council slot that
    // overlaps another booker's booking there joins it as the child (the earlier booking
    // is the parent; shares split evenly). The parent's side is written here when allowed,
    // and otherwise completed when the batch goes to the council.
    const slotPatches = linkCouncilChildren(draftsArr.filter(d => !bookings.some(b => b.id === d.id)), bookings, canonEmail);
    if(configured){
      try{
        for(const pt of slotPatches){ try{ await sb.update("bookings", pt.id, { system_notes: pt.system_notes, updated_at: new Date().toISOString() }); }catch{ /* not this booker's booking: completed on send to council */ } }
        for(const d of draftsArr){
          const exists=bookings.find(b=>b.id===d.id);
          if(exists) await sb.update("bookings",d.id,toDb(d));
          else       await sb.insert("bookings",{...toDb(d), user_id: userId});
        }
        await loadBookings();
      }catch(e){showToast("Save failed: "+e.message,"error");return;}
    } else {
      setBookings(prev=>{
        let next=prev.map(b=>{ const pt=slotPatches.find(x=>x.id===b.id); return pt?{...b,system_notes:pt.system_notes}:b; });
        draftsArr.forEach(d=>{next=next.filter(b=>b.id!==d.id);next.push(d);});
        return next;
      });
    }
    setShowForm(false);setViewing(null);
    logActivity(isNew?"booking_create":"booking_edit", {
      count: draftsArr.length,
      ids: draftsArr.map(d=>d.id),
      booker: bookerEmail || draftsArr[0]?.email,
      // Flag edits/creates that touch GTEC-submitted bookings so track-changes shows
      // post-queue changes distinctly (GTEC may need notifying of the change).
      gtecQueued: draftsArr.filter(reachedGtecQueue).length,
      // Record every slot, not the first 8: the summary line shows 3, but the rest is
      // what makes a bulk change traceable afterwards (and searchable by date).
      items: draftsArr.slice(0,60).map(d=>({ date:d.date, facility_id:d.facility_id, start_hour:d.start_hour, duration:d.duration, status:d.status })),
    });
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

  // Patch a single booking's fields directly (no email, no cart) — used by the booking
  // detail's cost-splitting / fixed-price editor to persist system_notes changes.
  async function handlePatchBooking(booking, patch) {
    const full = { ...patch, updated_at: new Date().toISOString() };
    if (configured) {
      try { await sb.update("bookings", booking.id, full); await loadBookings(); }
      catch(e){ showToast("Save failed: "+e.message, "error"); return; }
    } else {
      setBookings(prev => prev.map(b => b.id===booking.id ? { ...b, ...full } : b));
    }
    setViewing(prev => prev && prev.id===booking.id ? { ...prev, ...full } : prev);
    logActivity("booking_edit", { ids:[booking.id], booker: booking.email, pricing: true });
    showToast("Booking updated.");
  }

  // Convert a GTEC-held admin block into a real, GTEC-confirmed AMUA booking assigned to
  // a booker. GTEC already holds the slot, so it lands as cpsa_confirmed. A sticky
  // "confirmed" resolution + a taught org→email link stop the next sync from re-flagging
  // it as a mismatch or re-importing the same GTEC event as a fresh duplicate admin block.
  async function handleConvertAdminBooking(booking, { email, name }) {
    const em = (email||"").trim().toLowerCase();
    if (!/\S+@\S+\.\S+/.test(em)) { showToast("Enter a valid booker email.", "error"); return; }
    const canonEm = emailAliases[em] || em;
    const bkName = (name||"").trim() || displayNameFor(canonEm);
    let sysNotes = setCpsaResolution(booking.system_notes || "", "confirmed", "none");
    sysNotes = setGtecSnapshot(sysNotes, { name: booking.purpose||"", date: booking.date, start_hour: booking.start_hour, duration: booking.duration, facilityIds: [booking.facility_id] });
    const patch = { email: canonEm, name: bkName, status: "cpsa_confirmed", system_notes: sysNotes, updated_at: new Date().toISOString() };
    if (configured) {
      try { await sb.update("bookings", booking.id, patch); await loadBookings(); }
      catch(e){ showToast("Convert failed: "+e.message, "error"); return; }
    } else {
      setBookings(prev => prev.map(b => b.id===booking.id ? { ...b, ...patch } : b));
    }
    const teachKey = gtecTeamKey(booking.purpose||"");
    if (teachKey && teachKey.length >= 3) setGtecLinks(prev => ({ ...prev, [teachKey]: canonEm }));
    logActivity("cpsa_admin_convert", { booking_id: booking.id, to: canonEm, date: booking.date, facility_id: booking.facility_id, start_hour: booking.start_hour, duration: booking.duration });
    setViewing(prev => prev && prev.id===booking.id ? { ...prev, ...patch } : prev);
    showToast(`Converted to AMUA booking for ${bkName}.`);
  }

  // Email unofficial invoice previews to bookers. Respects silent mode — that switch
  // exists so an admin can work without anything reaching bookers, and a preview is
  // still an outgoing email. Sends sequentially so one failure doesn't hide the rest.
  async function handleEmailInvoicePreview(items) {
    if (!items?.length) return;
    if (silentMode) {
      showToast("Silent mode is on — no previews sent. Turn it off in the user menu first.", "error");
      return;
    }
    showToast(`Sending ${items.length} invoice preview${items.length!==1?"s":""}…`);
    for (const it of items) {
      await sendEmail({ to: it.to, subject: it.subject, html: it.html, kind: "invoice_preview" });
    }
    logActivity("invoice_preview_emailed", {
      count: items.length,
      recipients: items.slice(0, 8).map(i => i.to),
      total: items.reduce((s, i) => s + (i.total || 0), 0),
    });
    showToast(`✉ Preview sent to ${items.length===1 ? items[0].to : `${items.length} bookers`}.`);
  }

  // Email official invoices to bookers, already bundled one email per recipient by the
  // Billing tab. Unlike previews these are real payable documents, so the send is
  // confirmed, respects silent mode, and is logged with the references sent.
  async function handleEmailOfficialInvoices(items, { preview = false } = {}) {
    if (!items?.length) return false;
    if (silentMode) {
      showToast("Silent mode is on — nothing sent. Turn it off in the user menu first.", "error");
      return false;
    }
    const totalDocs = items.reduce((s, i) => s + i.count, 0);
    const who = items.length === 1 ? items[0].to : `${items.length} bookers`;
    const noun = preview ? "invoice preview" : "official invoice";
    // Previews are harmless; a payable document going to the wrong booker is not, so the
    // official path spells out what it is before sending.
    if (!window.confirm(preview
      ? `Send ${totalDocs} ${noun}${totalDocs!==1?"s":""} to ${who}?\n\nMarked unofficial — nothing becomes payable.`
      : `Send ${totalDocs} ${noun}${totalDocs!==1?"s":""} to ${who}?\n\nThese are real payable documents, not previews.`)) return false;
    showToast(`Sending ${items.length} email${items.length!==1?"s":""}…`);
    for (const it of items) {
      await sendEmail({ to: it.to, subject: it.subject, html: it.html, kind: preview ? "invoice_preview" : "invoice" });
    }
    logActivity(preview ? "invoice_preview_emailed" : "official_invoice_emailed", {
      emails: items.length, documents: totalDocs, count: totalDocs,
      recipients: items.slice(0, 8).map(i => i.to),
      refs: items.flatMap(i => i.refs).slice(0, 20),
      total: items.reduce((s, i) => s + (i.total || 0), 0),
    });
    showToast(`✉ ${totalDocs} ${noun}${totalDocs!==1?"s":""} sent to ${who}.`);
    return true;
  }

  // Queue invoice emails into the cart instead of sending now — same philosophy as
  // bookings, removals and notifications: stage it, review it in the cart, submit once.
  function handleQueueInvoiceEmails(items, { preview = false } = {}) {
    if (!items?.length) return false;
    setCart(c => [...c, ...items.map(it => ({
      // drafts is empty (not missing) so cart code that walks every item's drafts is safe.
      notifyOnly: true, invoiceEmail: true, preview, drafts: [],
      email: it.to, name: it.name, subject: it.subject, html: it.html,
      count: it.count, refs: it.refs, total: it.total,
    }))]);
    const docs = items.reduce((s, i) => s + (i.count || 1), 0);
    showToast(`🛒 ${docs} ${preview?"preview":"invoice"}${docs!==1?"s":""} added to cart in ${items.length} email${items.length!==1?"s":""}.`);
    return true;
  }

  // Shared-slot changes are staged in the cart like every other booking change — they
  // create and edit bookings, so they belong behind the same review-then-submit step
  // rather than writing straight to the database. Each builder returns the exact patches
  // (and, for a split, the booking to insert) so the cart row can describe the change and
  // the submit can apply it without recomputing anything.
  function slotMemberPatch(b, id, role, share) {
    return { id: b.id, name: b.name, email: b.email, system_notes: setSlotLink(b.system_notes, id, role, share) };
  }

  // Retroactively share a slot with another team: a second booking on the same field,
  // date and time owned by that team, linked to this one. The original stays the parent,
  // so the name GTEC already has for the slot doesn't change.
  function buildShareSlotChange(booking, { email, name, purpose }) {
    const em = (email||"").trim().toLowerCase();
    if (!/\S+@\S+\.\S+/.test(em)) return { error: "Pick a team to share this slot with." };
    if (em === (booking.email||"").toLowerCase()) return { error: "That team already owns this booking." };
    const existing = parseSlotLink(booking.system_notes);
    const id = existing?.id || newSlotRef();
    const members = existing ? slotGroupMembers(bookings, existing.id) : [booking];
    if (members.some(b => (b.email||"").toLowerCase() === em)) return { error: "That team is already on this slot." };
    const shares = evenSlotShares(members.length + 1);
    const hasParent = members.some(m => parseSlotLink(m.system_notes)?.role === "parent");
    const patches = members.map((m, i) => {
      const role = parseSlotLink(m.system_notes)?.role
        || (!hasParent && m.id === booking.id ? "parent" : "child");
      return slotMemberPatch(m, id, role, shares[i]);
    });
    const bkName = name || displayNameFor(em);
    return {
      kind: "share", id, patches,
      newBooking: {
        id: newId(),
        facility_id: booking.facility_id, date: booking.date,
        start_hour: booking.start_hour, duration: booking.duration,
        purpose: (purpose||"").trim() || booking.purpose || "",
        name: bkName, email: em, status: booking.status,
        created_at: new Date().toISOString(),
        system_notes: setSlotLink("", id, "child", shares[shares.length-1]),
      },
      label: `Share ${fmtDateShortDow(booking.date)} ${facShort(booking.facility_id)} ${fmtTimeShort(booking.start_hour)} with ${bkName}`,
      detail: `${members.length + 1} teams · ${Math.round(100/(members.length+1))}% each`,
      meta: { booking_id: booking.id, added: em, members: members.length + 1, date: booking.date, facility_id: booking.facility_id },
    };
  }

  // Merge two bookings made independently for the same slot. Neither is the parent, so
  // the GTEC-facing name carries both.
  function buildMergeSlotChange(a, b) {
    if (!a || !b || a.id === b.id) return { error: "Pick a different booking to merge with." };
    const id = parseSlotLink(a.system_notes)?.id || parseSlotLink(b.system_notes)?.id || newSlotRef();
    const members = [...new Map([
      ...slotGroupMembers(bookings, parseSlotLink(a.system_notes)?.id),
      ...slotGroupMembers(bookings, parseSlotLink(b.system_notes)?.id),
      a, b,
    ].map(x => [x.id, x])).values()];
    const shares = evenSlotShares(members.length);
    return {
      kind: "merge", id,
      patches: members.map((m, i) => slotMemberPatch(m, id, "peer", shares[i])),
      newBooking: null,
      label: `Merge ${members.length} bookings into one slot · ${fmtDateShortDow(a.date)} ${facShort(a.facility_id)} ${fmtTimeShort(a.start_hour)}`,
      detail: `${members.map(m=>m.name||m.email).join(" + ")} · ${Math.round(100/members.length)}% each · GTEC sees both names`,
      meta: { ids: members.map(m=>m.id), members: members.length, date: a.date, facility_id: a.facility_id },
    };
  }

  // Remove one booking from a shared slot. The rest re-balance; a lone survivor is
  // unlinked entirely so it goes back to being billed in full.
  function buildUnlinkSlotChange(booking) {
    const link = parseSlotLink(booking.system_notes);
    if (!link) return { error: "That booking isn't on a shared slot." };
    const rest = slotGroupMembers(bookings, link.id).filter(b => b.id !== booking.id);
    const shares = evenSlotShares(rest.length);
    const patches = [
      { id: booking.id, name: booking.name, email: booking.email, system_notes: clearSlotLink(booking.system_notes) },
      ...(rest.length === 1
        ? [{ id: rest[0].id, name: rest[0].name, email: rest[0].email, system_notes: clearSlotLink(rest[0].system_notes) }]
        : rest.map((m, i) => slotMemberPatch(m, link.id, parseSlotLink(m.system_notes)?.role || "peer", shares[i]))),
    ];
    return {
      kind: "unlink", id: link.id, patches, newBooking: null,
      label: `Remove ${booking.name||booking.email} from a shared slot · ${fmtDateShortDow(booking.date)} ${facShort(booking.facility_id)}`,
      detail: rest.length <= 1 ? "Slot stops being shared — the remaining booking is billed in full"
                               : `${rest.length} teams remain · ${Math.round(100/rest.length)}% each`,
      meta: { booking_id: booking.id, remaining: rest.length },
    };
  }

  // Stage any of the three in the cart.
  function stageSlotChange(built) {
    if (!built) return;
    if (built.error) { showToast(built.error, "error"); return; }
    setCart(c => [...c, { slotChange: true, ...built, email: built.newBooking?.email, name: built.newBooking?.name }]);
    showToast(`🛒 ${built.label} — added to cart.`);
  }
  const handleShareSlot = (booking, opts) => stageSlotChange(buildShareSlotChange(booking, opts));
  const handleMergeSlots = (a, b) => stageSlotChange(buildMergeSlotChange(a, b));
  const handleUnlinkSlot = (booking) => stageSlotChange(buildUnlinkSlotChange(booking));

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
  // from supabase-setup.sql.
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
  // Booker identity settings — state + localStorage handled via their effects; these
  // wrappers additionally sync the change to the shared `settings` table so aliases,
  // names, chip colours and profiles persist across devices/sessions.
  function saveEmailAliases(next) { setEmailAliases(next); persistSetting("email_aliases", next); }
  function saveAliasNames(next)   { setAliasNames(next);   persistSetting("alias_names", next); }
  function saveAliasColors(next)  {
    setAliasColors(next);
    const u = session?.user;
    try{ localStorage.setItem(colorKey(u?.email), JSON.stringify(next)); }catch{ /* ignore */ }
    if (u) { u.user_metadata = { ...(u.user_metadata||{}), booker_colors: next }; supabase.auth.updateUser({ data: { booker_colors: next } }).catch(()=>{}); }
  }
  function saveBookerSeasons(next) { setBookerSeasons(next); try{localStorage.setItem("fb_booker_seasons",JSON.stringify(next));}catch{ /* ignore */ } persistSetting("booker_seasons", next); }
  function saveAmuaOrg(next) {
    applyAmuaOrg(next); setAmuaOrg(next);
    try{localStorage.setItem("fb_amua_org",JSON.stringify(next));}catch{ /* ignore */ }
    // Other devices and the council widget read the shared setting, so say if it didn't save.
    persistSetting("amua_org", next).then(ok => { if (!ok) alert("AMUA details were saved in this browser only — the shared copy (used by the council widget) couldn't be updated. Check you're signed in as an admin and try again."); });
    logActivity("settings_change", { key:"amua_org" });
  }

  async function handleSyncDB() {
    await loadBookings();
    await loadSettings();
    await persistSetting("facility_rates", facilityRates);
    await persistSetting("pricing_conditions", pricingConditions);
    await persistSetting("approx_players", approxPlayers);
    await persistSetting("approx_durations", approxDurations);
    await persistSetting("log_retention_months", logRetentionMonths);
    await persistSetting("email_aliases", emailAliases);
    await persistSetting("alias_names", aliasNames);
    await persistSetting("booker_seasons", bookerSeasons);
    showToast("Synced with database.");
  }

  // Manually link clash pair(s) to GTEC: confirm the user booking(s) against the
  // overlapping GTEC event, remove the admin field-block, and (by default) teach
  // the matcher the org-token→email mapping so future syncs auto-link this org.
  async function handleLinkClashToGtec(pairs, { remember = true } = {}) {
    const list = Array.isArray(pairs) ? pairs : [pairs];
    if (!list.length) return;
    const adminIds = new Set();
    const taught = {};
    for (const { admin, user } of list) {
      const live = bookings.find(b => b.id === user.id) || user;
      const sameFac = admin.facility_id === user.facility_id;
      const reasons = [];
      if (admin.start_hour !== user.start_hour) reasons.push(`Time: ${fmtTimeShort(user.start_hour)} → ${fmtTimeShort(admin.start_hour)}`);
      if (admin.duration !== user.duration)     reasons.push(`Dur: ${user.duration}h → ${admin.duration}h`);
      if (!sameFac)                             reasons.push(`Field: ${facShort(user.facility_id)} → ${facShort(admin.facility_id)}`);
      const targetStatus = reasons.length ? "cpsa_review_needed" : "cpsa_confirmed";
      const gtecSnap = { name: admin.purpose||"", date: admin.date, start_hour: admin.start_hour, duration: admin.duration, facilityIds: [admin.facility_id] };
      let sys = stripClashPrevStatus(live.system_notes || "");
      sys = targetStatus === "cpsa_review_needed" ? setGtecSnapshot(setMismatchNote(sys, reasons), gtecSnap) : stripMismatchNote(sys);
      if (configured) {
        await sb.update("bookings", live.id, { status: targetStatus, system_notes: sys, updated_at: new Date().toISOString() });
      } else {
        setBookings(prev => prev.map(b => b.id === live.id ? { ...b, status: targetStatus, system_notes: sys } : b));
      }
      adminIds.add(admin.id);
      const key = gtecTeamKey(admin.purpose);
      if (remember && key && live.email) taught[key] = live.email.toLowerCase();
      logActivity("clash_linked", { booking_id: live.id, gtec: admin.purpose, status: targetStatus });
    }
    for (const id of adminIds) {
      if (configured) await sb.remove("bookings", id);
      else setBookings(prev => prev.filter(b => b.id !== id));
    }
    if (remember && Object.keys(taught).length) setGtecLinks(prev => ({ ...prev, ...taught }));
    if (configured) await loadBookings();
    showToast(`Linked ${list.length} booking${list.length!==1?"s":""} to GTEC${remember?" — future syncs will auto-link this org":""}.`);
  }

  async function handleBulkApply({bkgs, bulkTime, bulkDur, bulkFac, cancelFrom}) {
    const toCancel = cancelFrom ? bkgs.filter(b=>b.date>=cancelFrom) : [];
    const toUpdate = bkgs.filter(b=>!cancelFrom||b.date<cancelFrom);
    // Apply edits immediately. Cancellations are NOT deleted here — they're routed
    // through the removal (email) cart so the booker gets a cancellation email on submit.
    // A field left undefined keeps each booking's own value (mixed groups).
    const patch={...(bulkTime!=null&&{start_hour:bulkTime}),...(bulkDur!=null&&{duration:bulkDur}),...(bulkFac&&{facility_id:bulkFac})};
    const changes=toUpdate.filter(b=>Object.entries(patch).some(([k,v])=>b[k]!==v));
    if(changes.length>0){
      if(configured){
        try{
          for(const b of changes) await sb.update("bookings",b.id,{...patch,updated_at:new Date().toISOString()});
          await loadBookings();
        }catch(e){showToast("Bulk apply failed: "+e.message,"error");return;}
      } else {
        const updateIds=new Set(changes.map(b=>b.id));
        setBookings(prev=>prev.map(b=>updateIds.has(b.id)?{...b,...patch}:b));
      }
    }
    if(toCancel.length>0){
      setDeleteQueue(prev => { const have=new Set(prev.map(b=>b.id)); return [...prev, ...toCancel.filter(b=>!have.has(b.id))]; });
      setShowDeleteCart(true);
    }
    const parts=[
      changes.length>0&&`${changes.length} updated`,
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
    logActivity("mismatch_resolution", { booking_id:booking.id, resolution:logPayload.resolution, billing_state:logPayload.billing_state, ...(logPayload.swap_to ? { swap_from: logPayload.swap_from, swap_to: logPayload.swap_to } : {}) });
    const msg = logPayload.resolution === "amended"
      ? "Booking updated to GTEC values."
      : logPayload.resolution === "swapped"
      ? `Booking reassigned to ${logPayload.swap_to}.`
      : logPayload.resolution === "proposed"
      ? "Booking amended to proposed values — GTEC & booker to confirm."
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

  // ─── Google Drive sync (config-gated; inert without VITE_GOOGLE_CLIENT_ID) ──
  // Renders billing records to faithful PDF (+ source HTML) and files them under
  // AMUA Billing/<year>/<range — order>/<PO (to GTEC) | Invoice (to Clubs)>/.
  // Re-uploading to the same fileId preserves Drive revision history (draft→final).
  const setRecordDrive = (id, patch) => setBillingRecords(prev => prev.map(r => r.id===id ? { ...r, drive: { ...(r.drive||{}), ...patch } } : r));

  async function driveSyncRecords(records, { reason="create" } = {}) {
    if (!driveConfigured() || records.length===0) return;
    try {
      await getDriveToken({ interactive:true }); // popup-needing step first, while user activation is fresh
    } catch(e) {
      records.forEach(r=>setRecordDrive(r.id, { error:`Not connected: ${e.message||e}`, erroredAt:new Date().toISOString() }));
      showToast("Drive not connected — documents kept locally. Sync from the Billing tab.", "error");
      return;
    }
    showToast(`Saving ${records.length} document${records.length!==1?"s":""} to Google Drive…`);
    let okCount = 0;
    try {
      const year = String(new Date(records[0].createdAt||Date.now()).getFullYear());
      // Reuse the batch's existing folder (renaming it if the batch was renamed) so
      // re-synced files stay alongside what's already there; fall back to name lookup.
      const folderName = driveBatchFolderName(records);
      const knownFolderId = records.find(r=>r.drive?.batchFolderId)?.drive.batchFolderId;
      let batchFolder = null;
      if (knownFolderId) { try { batchFolder = await renameFile(knownFolderId, folderName); } catch { /* deleted or inaccessible — look up by name */ } }
      if (!batchFolder) batchFolder = await ensureFolderPath([DRIVE_ROOT_FOLDER, year, folderName]);
      const poFolders = {};
      const poFolderFor = async rec => {
        const name = drivePoFolderName(rec);
        return poFolders[name] || (poFolders[name] = await ensureFolder(name, batchFolder.id));
      };
      const subClubs = await ensureFolder(DRIVE_SUBFOLDERS.toClubs, batchFolder.id);
      // Always create the drop-point for the invoice GTEC sends us, even though
      // nothing is uploaded into it here (see handleDriveAttachGtec).
      await ensureFolder(DRIVE_SUBFOLDERS.fromGtec, batchFolder.id);
      for (const rec of records) {
        try {
          const isPO = rec.type==="purchase_order";
          const docType = isPO ? "purchase_order" : rec.type==="receipt" ? "receipt" : "invoice";
          const folder = isPO ? await poFolderFor(rec) : subClubs; // receipts file with the club-facing docs
          const base = billingDocBaseName(rec);
          const html = buildBillingDocHtml(rec, docType, rec.lines||[]);
          const pdfBlob = await htmlToPdfBlob(html);
          // Prefer the stored id; fall back to name lookup so a different browser
          // updates the same files instead of duplicating them.
          const pdfId  = rec.drive?.pdfId  || (await findChildFile(`${base}.pdf`,  folder.id))?.id || null;
          const pdfFile = await uploadFile({ name:`${base}.pdf`, parentId:folder.id, blob:pdfBlob, mimeType:"application/pdf", fileId:pdfId });
          const htmlId = rec.drive?.htmlId || (await findChildFile(`${base}.html`, folder.id))?.id || null;
          const htmlFile = await uploadFile({ name:`${base}.html`, parentId:folder.id, blob:new Blob([html],{type:"text/html"}), mimeType:"text/html", fileId:htmlId });
          // Pin finalised PDFs so Drive never auto-purges that revision.
          if ((rec.status||"draft")!=="draft") { try { await keepLatestRevisionForever(pdfFile.id); } catch { /* best-effort */ } }
          setRecordDrive(rec.id, { pdfId:pdfFile.id, htmlId:htmlFile.id, folderId:folder.id, batchFolderId:batchFolder.id, webViewLink:pdfFile.webViewLink, uploadedAt:new Date().toISOString(), error:null });
          logActivity("drive_upload", { record_id: rec.id, doc: base, reason });
          okCount++;
        } catch(e) {
          setRecordDrive(rec.id, { error: String(e.message||e), erroredAt:new Date().toISOString() });
        }
      }
      if (okCount===records.length) showToast(`Saved ${okCount} document${okCount!==1?"s":""} to Drive.`);
      else showToast(`Drive: ${okCount}/${records.length} saved — open the record in Billing for the error.`, "error");
    } catch(e) {
      records.forEach(r=>setRecordDrive(r.id, { error: String(e.message||e), erroredAt:new Date().toISOString() }));
      showToast("Drive upload failed: "+(e.message||e), "error");
    }
  }

  // Manual (re-)sync from the Billing tab — group by batch so folder naming stays batch-derived.
  function handleDriveSync(recordIds) {
    const recs = billingRecords.filter(r=>recordIds.includes(r.id));
    const byBatch = {};
    recs.forEach(r=>{ const k=r.batchId||r.id; if(!byBatch[k]) byBatch[k]=[]; byBatch[k].push(r); });
    Object.values(byBatch).forEach(group=>{ driveSyncRecords(group, { reason:"manual" }); });
  }

  // Upload a received GTEC invoice into the batch's "Invoice (from GTEC)" folder
  // and remember it on the record so the Billing UI can download it later.
  // Upload one or more received GTEC invoices into the batch's "Invoice (from GTEC)"
  // folder, appending to the record's list (same-named files update in place).
  async function handleDriveAttachGtec(rec, fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    try {
      await getDriveToken({ interactive:true });
      const year = String(new Date(rec.createdAt||Date.now()).getFullYear());
      const batchRecs = billingRecords.filter(r=>r.batchId&&r.batchId===rec.batchId);
      const batchFolder = rec.drive?.batchFolderId
        ? { id: rec.drive.batchFolderId }
        : await ensureFolderPath([DRIVE_ROOT_FOLDER, year, driveBatchFolderName(batchRecs.length?batchRecs:[rec])]);
      const fromFolder = await ensureFolder(DRIVE_SUBFOLDERS.fromGtec, batchFolder.id);
      const existing = rec.drive?.gtecInvoices || (rec.drive?.gtecInvoice ? [rec.drive.gtecInvoice] : []);
      const byName = new Map(existing.map(x=>[x.name, x]));
      for (const file of files) {
        const prevId = byName.get(file.name)?.id || (await findChildFile(file.name, fromFolder.id))?.id || null;
        const up = await uploadFile({ name:file.name, parentId:fromFolder.id, blob:file, mimeType:file.type||"application/octet-stream", fileId:prevId });
        byName.set(file.name, { id:up.id, name:up.name||file.name, webViewLink:up.webViewLink, uploadedAt:new Date().toISOString() });
        logActivity("drive_attach", { record_id: rec.id, file: file.name });
      }
      setRecordDrive(rec.id, { gtecInvoices: Array.from(byName.values()), gtecInvoice: null, batchFolderId:batchFolder.id });
      showToast(`Attached ${files.length} file${files.length!==1?"s":""} to Drive (Invoice from GTEC).`);
    } catch(e) {
      showToast("Attach failed: "+(e.message||e), "error");
    }
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
    // File the batch to Google Drive (no-op when not configured; errors are
    // recorded on each record with a retry path in the Billing tab).
    if (driveConfigured()) driveSyncRecords(tagged, { reason:"create" });
  }

  // Rename a batch: its name is the orderName shared by every record in it. Drive
  // copies are re-synced so the folder, file names and document text follow.
  function handleRenameBatch(batchId, name) {
    const orderName = name.trim();
    const renamed = billingRecords.filter(r=>r.batchId===batchId).map(r=>({ ...r, orderName }));
    if (renamed.length===0) return;
    const byId = new Map(renamed.map(r=>[r.id, r]));
    setBillingRecords(prev => prev.map(r => byId.get(r.id) || r));
    logActivity("batch_renamed", { batch_id: batchId, name: orderName, ids: renamed.map(r=>r.id) });
    showToast(orderName ? `Batch renamed to "${orderName}".` : "Batch name cleared.");
    if (driveConfigured() && renamed.some(r=>r.drive?.pdfId)) driveSyncRecords(renamed, { reason:"rename" });
  }

  // Issue a receipt for a paid invoice — a standalone R-type record acknowledging
  // payment received. Files to Drive (club-facing) when Drive is configured.
  function handleCreateReceipt(receipt) {
    if (billingRecords.some(r => r.type==="receipt" && r.sourceInvoiceId===receipt.sourceInvoiceId)) {
      showToast("A receipt already exists for this invoice."); return;
    }
    setBillingRecords(prev => [...prev, receipt]);
    logActivity("receipt_created", { id: receipt.id, source: receipt.sourceInvoiceId });
    showToast(`Receipt ${receipt.id} created.`);
    if (driveConfigured()) driveSyncRecords([receipt], { reason:"create" });
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
    // Drive: refresh the filed document on pipeline transitions so the DRAFT
    // watermark clears and Drive's revision history records the change.
    const beforeRec = billingRecords.find(r=>r.id===patch.id);
    if (driveConfigured() && beforeRec && patch.status && patch.status !== (beforeRec.status||"draft")) {
      driveSyncRecords([{ ...beforeRec, ...patch }], { reason:"status_change" });
    }
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
    // Bookings that already reached GTEC's schedule need a purge request to GTEC — record
    // them in the delete log before they're gone so the admin can email GTEC to remove them.
    const purgeEntries = deleteQueue.filter(b=>!isAdminBooking(b)&&reachedGtecQueue(b)).map(b=>({
      id: b.id, name: b.name, email: b.email, date: b.date, facility_id: b.facility_id,
      start_hour: b.start_hour, duration: b.duration, status: b.status, deletedAt: new Date().toISOString(),
    }));
    if(configured){
      try{ await Promise.all(ids.map(id=>sb.remove("bookings",id))); await loadBookings(); }
      catch(e){showToast("Delete failed: "+e.message,"error");return;}
    } else { setBookings(prev=>prev.filter(b=>!ids.includes(b.id))); }
    if(purgeEntries.length){
      // De-dupe by booking id so re-deleting (shouldn't happen) can't double-list a slot.
      setCpsaDeleteLog(prev => { const have=new Set(prev.map(e=>e.id)); return [...prev, ...purgeEntries.filter(e=>!have.has(e.id))]; });
    }

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

    logActivity("booking_delete", {
      count: deleteQueue.length,
      ids,
      booker: deleteQueue[0]?.email,
      gtecPurge: purgeEntries.length,
      items: deleteQueue.slice(0,60).map(b=>({ date:b.date, facility_id:b.facility_id, start_hour:b.start_hour, duration:b.duration, status:b.status, name:b.name, email:b.email })),
    });
    showToast(`${ids.length} booking${ids.length>1?"s":""} removed.`);
    setDeleteQueue([]);
    setShowDeleteCart(false);
  }

  // Move old unapproved (past pending) bookings into the removal queue — the actual
  // delete and the booker email happen when the removal cart is submitted.
  // Reassign bookings to another booker (admin). Applied straight away, without emailing;
  // user_id is cleared so the previous booker can no longer manage them — the database
  // (supabase-setup.sql v4) links them to the new booker's account from the email.
  async function handleBulkReassign(ids, { email, name }) {
    const to = (email||"").trim().toLowerCase(); if (!/\S+@\S+\.\S+/.test(to)) return;
    ids = ids.filter(id => (bookings.find(b=>b.id===id)?.email||"").toLowerCase() !== to);
    if (!ids.length) { showToast("Those bookings are already with that booker."); return; }
    const patch = { email: to, name: name || to.split("@")[0], user_id: null, updated_at: new Date().toISOString() };
    const from = [...new Set(bookings.filter(b=>ids.includes(b.id)).map(b=>b.email))];
    if (configured) {
      try { for (const id of ids) await sb.update("bookings", id, patch); await loadBookings(); }
      catch(e){ showToast("Reassign failed: "+e.message, "error"); return; }
    } else {
      const set = new Set(ids); setBookings(prev => prev.map(b => set.has(b.id) ? { ...b, ...patch } : b));
    }
    logActivity("booking_edit", { ids, reassigned_from: from, reassigned_to: to });
    showToast(`${ids.length} booking${ids.length!==1?"s":""} reassigned to ${patch.name}.`);
  }

  // Resolve past bookings still awaiting approval. decisions: [{id, action, variance?}] with
  // action "remove" (→ removal queue), "vendor" (the vendor did approve it) or "vendor_var"
  // (approved, but the vendor's times differed — kept on record for invoice footnotes).
  // Approvals queue in the cart without emailing (they're in the past); mismatch notes save now.
  async function handleResolveOldUnapproved(decisions) {
    const byId = Object.fromEntries(bookings.map(b=>[b.id,b]));
    const removeIds = decisions.filter(d=>d.action==="remove").map(d=>d.id);
    const approve = decisions.filter(d=>d.action==="vendor"||d.action==="vendor_var");
    const notes = approve.filter(d=>d.action==="vendor_var"&&d.variance&&byId[d.id]);
    if (notes.length) {
      const now = new Date().toISOString();
      const patched = notes.map(d=>({ id:d.id, system_notes:setVendorVariance(byId[d.id].system_notes, d.variance) }));
      if (configured) {
        try { for (const p of patched) await sb.update("bookings", p.id, { system_notes:p.system_notes, updated_at:now }); await loadBookings(); }
        catch(e){ showToast("Couldn't save the mismatch notes: "+e.message, "error"); return; }
      } else {
        const m = Object.fromEntries(patched.map(p=>[p.id,p.system_notes]));
        setBookings(prev => prev.map(b => m[b.id]!=null ? { ...b, system_notes:m[b.id], updated_at:now } : b));
      }
      logActivity("booking_edit", { ids:notes.map(d=>d.id), vendorMismatch:true });
    }
    // The vendor approving means "vendor confirmed" for GTEC/CPSA facilities, "approved" elsewhere.
    const groups = {};
    approve.forEach(d => { const b = byId[d.id]; if (!b) return; const st = workflowOf(b.facility_id)==="gtec" ? "cpsa_confirmed" : "approved"; (groups[st] ||= []).push(d.id); });
    Object.entries(groups).forEach(([st, ids]) => handleBulkStatusChange(ids, st, "Resolved retroactively — the vendor approved it", true));
    if (removeIds.length) handleClearOldUnapproved(removeIds);
  }
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

  // Room request to CPSA: cart an email (a draft to AMUA's inbox, since it's vendor mail) for the
  // Meeting Room or Function Room; on submit the booking moves to Pending GTEC Review.
  // Requests to the same vendor roll up into one cart item, and so one email.
  function addRoomRequestToCart(booking, vendorEmail, vendorName) {
    setCart(c => {
      const i = c.findIndex(x => x.roomRequest && x.email.toLowerCase() === vendorEmail.toLowerCase());
      if (i >= 0) {
        if (c[i].drafts.some(d => d.id === booking.id)) return c;
        return c.map((x, j) => j === i ? { ...x, drafts: [...x.drafts, booking].sort((a, b) => a.date.localeCompare(b.date) || a.start_hour - b.start_hour) } : x);
      }
      return [...c, { roomRequest: true, notifyOnly: true, drafts: [booking], name: vendorName || vendorEmail, email: vendorEmail, ref: "ROOM-" + Date.now().toString(36).toUpperCase() }];
    });
    setRoomRequestFor(null);
    showToast(`Room request added to the ${vendorName || vendorEmail} email in the cart.`);
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
    //  • slotChange   — shared-slot split / merge / unlink: relinks members and, for a
    //    split, inserts the new team's booking.
    let statusItems = cart.filter(item => item.statusChange);
    const saveItems   = cart.filter(item => !item.notifyOnly && !item.statusChange && !item.slotChange);
    const notifyItems = cart.filter(item => item.notifyOnly);
    const slotItems   = cart.filter(item => item.slotChange);

    // 1. New bookings + edits.
    const allDrafts = saveItems.flatMap(item => item.drafts);
    if (allDrafts.length) {
      const name = (saveItems[0]||{}).name, email = (saveItems[0]||{}).email;
      await handleSave(allDrafts, name, email, { skipEmail: true });
    }

    // 1b. Shared-slot changes: insert the split's new booking, then rewrite every
    // member's link so the shares total 1 again.
    for (const it of slotItems) {
      try {
        if (it.newBooking) {
          if (configured) await sb.insert("bookings", { ...it.newBooking, user_id: userId });
          else setBookings(prev => [...prev, it.newBooking]);
        }
        const now = new Date().toISOString();
        if (configured) {
          await Promise.all((it.patches||[]).map(p2 =>
            sb.update("bookings", p2.id, { system_notes: p2.system_notes, updated_at: now })));
        } else {
          setBookings(prev => prev.map(b => {
            const p2 = (it.patches||[]).find(x => x.id === b.id);
            return p2 ? { ...b, system_notes: p2.system_notes, updated_at: now } : b;
          }));
        }
        logActivity(it.kind === "share" ? "slot_shared" : it.kind === "merge" ? "slot_merged" : "slot_unlinked", it.meta || {});
      } catch(e) { showToast("Shared-slot change failed: "+e.message, "error"); return; }
    }

    // 2. Apply the queued status changes (the whole action was deferred to submit).
    if (statusItems.length) {
      // A queued change was decided against the status the booking had when it was queued.
      // If a GTEC sync has since given it the vendor's answer (confirmed / mismatch), that
      // answer is newer than the queued change and wins — otherwise submitting the cart
      // after a sync quietly put a confirmed booking back to "Pending GTEC review".
      try {
        const ids = [...new Set(statusItems.flatMap(it => it.ids))];
        const fresh = configured ? await sb.select("bookings", `id=in.(${ids.map(id => `"${id}"`).join(",")})`) : bookings;
        const nowStatus = new Map(fresh.map(b => [b.id, b.status]));
        const vendorAnswered = new Set([ST.VENDOR_CONFIRMED, ST.VENDOR_MISMATCH]);
        const kept = [];
        statusItems = statusItems.map(it => {
          const wasStatus = new Map((it.drafts || []).map(d => [d.id, d.status]));
          const keep = new Set(it.ids.filter(id => { const cur = nowStatus.get(id);
            return cur && cur !== it.newStatus && cur !== wasStatus.get(id) && vendorAnswered.has(cur); }));
          if (!keep.size) return it;
          kept.push(...[...keep].map(id => ({ id, status: nowStatus.get(id) })));
          return { ...it, ids: it.ids.filter(id => !keep.has(id)), drafts: (it.drafts || []).filter(d => !keep.has(d.id)) };
        }).filter(it => it.ids.length);
        if (kept.length) {
          const nConf = kept.filter(k => k.status === ST.VENDOR_CONFIRMED).length;
          showToast(`Kept the sync's GTEC result on ${kept.length} booking${kept.length !== 1 ? "s" : ""} (${nConf} confirmed${kept.length - nConf ? `, ${kept.length - nConf} mismatch` : ""}) — the queued status change was older`, "info");
          logActivity("status_change_superseded", { kept });
        }
      } catch { /* couldn't re-check: apply as queued */ }
    }
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

    // Room requests move their bookings to Pending GTEC Review even in silent mode (only the
    // email is suppressed then).
    for (const item of notifyItems.filter(x => x.roomRequest)) {
      const at = new Date().toISOString();
      for (const d of item.drafts) {
        const sys = `${(d.system_notes||"").trim()}${d.system_notes?"\n":""}[ROOM-REQ ${item.ref} ${at}]`;
        if (configured) { try { await sb.update("bookings", d.id, { status: "pending_cpsa", system_notes: sys, updated_at: at }); } catch(e) { showToast("Couldn't update the booking: "+e.message, "error"); } }
        else setBookings(prev => prev.map(x => x.id===d.id ? { ...x, status: "pending_cpsa", system_notes: sys } : x));
      }
    }
    if (!silentMode) {
      const noEmailStatuses = new Set(["pending_cpsa","op_permission","council_apply","council_action","op_confirm"]);
      // Status-change emails — grouped into one email per booker + status, so a booker
      // with several bookings moving to the same status gets a single confirmation.
      const statusByKey = {};
      for (const it of statusItems) {
        if (it.skipEmail || noEmailStatuses.has(it.newStatus)) continue;
        const k = it.email.toLowerCase()+"|"+it.newStatus;
        if (!statusByKey[k]) statusByKey[k] = {name:it.name, email:it.email, newStatus:it.newStatus, drafts:[], notes:[]};
        statusByKey[k].drafts.push(...it.drafts);
        if (it.adminNote) statusByKey[k].notes.push(it.adminNote);
      }
      for (const g of Object.values(statusByKey)) {
        const statusLabel = STATUS_META[g.newStatus]?.label || g.newStatus;
        sendApprovalEmail({to:g.email,
          subject:`Your Booking${g.drafts.length>1?"s":""} — ${statusLabel}`,
          html:buildApprovalEmailHtml({name:g.name, email:g.email, bookings:g.drafts.map(d=>({...d,status:g.newStatus})), newStatus:g.newStatus, adminNote:[...new Set(g.notes)].join(" ")})});
      }
      // Notify-only emails: clash alerts, CPSA status notices, mismatch, inform-CPSA.
      for (const item of notifyItems) {
        // Invoice emails arrive with their document already rendered, so there is no
        // template to pick — just send what was queued.
        if (item.amuaDraft) {   // facility request: sendEmail turns it into a draft to AMUA's inbox
          await sendEmail({ to: item.email, subject: item.subject, html: item.html });
          logActivity("facility_request_drafted", { intended: item.email, subject: item.subject });
          continue;
        }
        if (item.roomRequest) {
          const b0 = item.drafts[0], fac = FACILITIES.find(x=>x.id===b0?.facility_id);
          const n = item.drafts.length;
          await sendEmail({ to: item.email, subject: n > 1 ? `Room booking requests — ${n} bookings from ${fmtDate(b0.date)} (${item.ref})` : `Room booking request — ${fac?.name||"room"}, ${fmtDate(b0.date)} (${item.ref})`,
            html: buildRoomRequestEmailHtml({ vendorName: item.name, bookings: item.drafts, ref: item.ref, players: approxPlayers }) });
          logActivity("room_request_drafted", { intended: item.email, ref: item.ref, ids: item.drafts.map(d=>d.id), items: item.drafts.map(d=>({ facility_id:d.facility_id, date:d.date, start_hour:d.start_hour, duration:d.duration })) });
          continue;
        }
        if (item.invoiceEmail) {
          await sendEmail({ to: item.email, subject: item.subject, html: item.html,
            kind: item.preview ? "invoice_preview" : "invoice" });
          logActivity(item.preview ? "invoice_preview_emailed" : "official_invoice_emailed", {
            emails: 1, documents: item.count || 1, count: item.count || 1,
            recipients: [item.email], refs: item.refs || [], total: item.total || 0,
          });
          continue;
        }
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
          sendApprovalEmail({to:item.email, subject:`Booking${item.drafts.length>1?"s":""} Confirmed by GTEC`,
            html:buildApprovalEmailHtml({name:item.name, email:item.email, bookings:item.drafts, newStatus:item.newStatus, adminNote:""})});
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
      // Edits: group by booker into a single "Booking(s) Updated" email.
      const editByEmail = {};
      cart.filter(item => item.isEdit).forEach(item => {
        const k = item.email.toLowerCase();
        if (!editByEmail[k]) editByEmail[k] = {name:item.name, email:item.email, drafts:[]};
        editByEmail[k].drafts.push(...item.drafts);
      });
      for (const g of Object.values(editByEmail)) {
        sendApprovalEmail({to:g.email, subject:`Booking${g.drafts.length>1?"s":""} Updated`,
          html:buildApprovalEmailHtml({name:g.name,email:g.email,bookings:g.drafts,newStatus:g.drafts[0]?.status,adminNote:""})});
      }
    }

    setCart([]);
    setShowCart(false);
  }

  // Admin → Backup / upload to Drive: every table in supabase-setup.sql (all rows, paged), plus this
  // browser's device-only data (profiles, billing records, sync logs…), as one JSON file.
  async function handleBackupDatabase() {
    if (!configured) { showToast("No database configured.", "error"); return; }
    showToast("Preparing the backup…");
    const TABLES = ["bookings","settings","activity_log","mismatch_log","booker_contacts","field_reviews","field_flags","field_ratings","vetting_history","schema_version"];
    const PAGE = 1000, tables = {}, problems = {};
    for (const t of TABLES) {
      const rows = [];
      try {
        for (let from = 0; ; from += PAGE) {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*`, { headers: authHeaders({ "Range-Unit":"items", Range:`${from}-${from+PAGE-1}` }) });
          if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0,120)}`);
          const page = await r.json(); rows.push(...page);
          if (page.length < PAGE) break;
        }
        tables[t] = rows;
      } catch(e) { problems[t] = e.message; }
    }
    const device = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("fb_")) { try { device[k] = JSON.parse(localStorage.getItem(k)); } catch { device[k] = localStorage.getItem(k); } } } } catch { /* storage blocked */ }
    const counts = Object.fromEntries(Object.entries(tables).map(([k,v]) => [k, v.length]));
    const backup = { app:"FacilityBook", exported_at:new Date().toISOString(), exported_by:realLoggedInEmail, ...(actor?{exported_by_name:actor}:{}),
      schema_version: tables.schema_version?.[0]?.version ?? null, counts, ...(Object.keys(problems).length?{problems}:{}), tables,
      device_note:"This browser's device-only data (not stored in the database): profiles, billing records, sync logs, filters.", device };
    const blob = new Blob([JSON.stringify(backup, null, 1)], { type:"application/json" });
    const fname = `facilitybook-backup-${new Date().toISOString().slice(0,16).replace(/[:T]/g,"-")}.json`;
    const total = Object.values(counts).reduce((a,b)=>a+b,0), missing = Object.keys(problems);
    // Upload to Google Drive (AMUA Billing / Backups / <year>); download it if Drive isn't
    // set up or the upload fails, so a backup is never lost.
    let driveFile = null;
    if (driveConfigured()) {
      try {
        const folder = await ensureFolderPath([DRIVE_ROOT_FOLDER, "Backups", String(new Date().getFullYear())]);
        driveFile = await uploadFile({ name: fname, parentId: folder.id, blob, mimeType: "application/json" });
      } catch(e) { showToast("Couldn't upload to Drive ("+(e.message||e)+") — downloading instead.", "error"); }
    }
    if (!driveFile) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
    logActivity("backup_downloaded", { counts, where: driveFile ? "drive" : "download", ...(driveFile ? { file: driveFile.name } : {}), ...(missing.length ? { problems: missing } : {}) });
    const where = driveFile ? `uploaded to Drive (${DRIVE_ROOT_FOLDER} / Backups)` : "downloaded";
    showToast(missing.length ? `Backup ${where} (${total} rows). Not included: ${missing.join(", ")}.` : `Backup ${where}: ${total} rows from ${Object.keys(counts).length} tables.`, missing.length ? "error" : "success");
    if (driveFile?.webViewLink) window.open(driveFile.webViewLink, "_blank", "noopener");
  }
  function handleLogout(){clearActor(session?.user?.email);supabase?.auth.signOut();setCart([]);}

  const pendingCount=bookings.filter(b=>REVIEW_STATUSES.has(b.status)).length;

  // ─── Clash detection ──────────────────────────────────────────────────────
  const allClashes = getClashes(bookings);
  // For admin: total clash pairs; for user: clashes involving their bookings
  const myClashCount = isAdmin
    ? allClashes.length
    : allClashes.filter(c => c.user.email?.toLowerCase() === loggedInEmail?.toLowerCase()).length;

  // On phones every tab fits on screen: equal widths, icon over a short label.
  function TabBtn({id,icon,label,short,badge}){
    const on=tab===id;
    return isMobile ? (
    <button onClick={()=>setTab(id)} aria-label={label} title={label} style={{flex:"1 1 0",minWidth:0,padding:"5px 2px 4px",borderRadius:8,border:"none",cursor:"pointer",fontFamily:"inherit",background:on?"#0f172a":"transparent",color:on?"#fff":"#64748b",display:"flex",flexDirection:"column",alignItems:"center",gap:1,position:"relative"}}>
      <span style={{fontSize:15,lineHeight:1.1}}>{icon}</span>
      <span style={{fontSize:9,fontWeight:700,lineHeight:1.1,letterSpacing:"-0.02em",maxWidth:"100%",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{short||label}</span>
      {badge>0&&<span style={{position:"absolute",top:1,right:"calc(50% - 20px)",background:"#f43f5e",color:"#fff",borderRadius:999,fontSize:9,fontWeight:700,padding:"0 4px",lineHeight:"14px"}}>{badge}</span>}
    </button>
    ) : (
    <button onClick={()=>setTab(id)} style={{padding:"8px 12px",borderRadius:8,border:"none",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",background:on?"#0f172a":"transparent",color:on?"#fff":"#64748b",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap",flexShrink:0}}>
      {icon} {label}{badge>0&&<span style={{background:"#f43f5e",color:"#fff",borderRadius:999,fontSize:10,fontWeight:700,padding:"1px 6px"}}>{badge}</span>}
    </button>
  );}

  const venues = listVenues();
  // Phones: one scrolling row. Desktop: wraps, so nothing is cut off.
  // Called as a function, not <FacilityPills/>: a component made afresh each render would
  // remount and close the location dropdown whenever a pick re-renders the page.
  const FacilityPills=()=>(
    <div className="facpills" style={{display:"flex",gap:6,marginBottom:16,alignItems:"center",overflowX:isMobile?"auto":"visible",flexWrap:isMobile?"nowrap":"wrap",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",msOverflowStyle:"none",paddingBottom:2}}>
      {/* Provider + 📍 location: shown only when the viewer can see more than one location. */}
      {/* Locations shown (additive): one chip per venue, ✕ to drop it; ＋ adds a provider's
          venue, or (third level) a specific council field, alongside what's already shown. */}
      {venues.length>1&&(()=>{
        const ks=activeVenueKeys(), all=ks===ALL_VENUES;
        const pids=[...new Set(venues.map(v=>v.providerId))];
        const chip={padding:"4px 6px 4px 10px",borderRadius:20,border:"1.5px solid #0f172a",fontSize:12,fontWeight:700,fontFamily:"inherit",background:"#fff",color:"#0f172a",flexShrink:0,display:"inline-flex",alignItems:"center",gap:4,whiteSpace:"nowrap"};
        const save=list=>setVenue(list.length===1&&list[0]===defaultVenueKey()?null:list.join(VENUE_SEP));
        const add=k=>{ if(!k) return; const cur=all?[]:ks; if(!cur.includes(k)) save([...cur,k]); };
        const drop=k=>save(ks.filter(x=>x!==k));
        const pickProvider=pid=>{ if(pid===ALL_VENUES) return setVenue(ALL_VENUES);
          const vs=venues.filter(v=>v.providerId===pid);
          add((vs.find(v=>v.key===`${pid}|${PROVIDERS[pid]?.defaultSite||""}`)||vs[0])?.key); };
        const pickFacility=id=>{ const f=FACILITIES.find(x=>x.id===id); if(!f) return; add(venueKeyOf(f)); setSelFac(id); };
        const siteOf=k=>venues.find(v=>v.key===k);
        // The location chip's dropdown: a vendor's locations and their fields, ticked when shown.
        const vis=visibleFacilities(), shownKeys=all?venues.map(v=>v.key):ks;
        const sitesOf=pid=>venues.filter(v=>v.providerId===pid).map(v=>({ key:v.key, site:v.site, shown:shownKeys.includes(v.key),
          facs:vis.filter(f=>venueKeyOf(f)===v.key).map(f=>({ id:f.id, name:f.name, color:f.color, shown:shownKeys.includes(v.key)&&!hiddenFacs.has(f.id) })) }));
        const facsAt=k=>vis.filter(f=>venueKeyOf(f)===k).map(f=>f.id);
        // A location goes in with all its fields, or out (unless it's the last one shown).
        const toggleSite=k=>{
          if(shownKeys.includes(k)){ if(shownKeys.length>1) save(shownKeys.filter(x=>x!==k)); return; }
          const at=new Set(facsAt(k)); setHiddenFacs(new Set([...hiddenFacs].filter(id=>!at.has(id)))); save([...shownKeys,k]); };
        // A field goes in alone (its location added with only that field) or out of the list.
        const toggleFac=id=>{ const f=vis.find(x=>x.id===id); if(!f) return; const k=venueKeyOf(f), next=new Set(hiddenFacs);
          if(!shownKeys.includes(k)){ facsAt(k).forEach(x=>x!==id&&next.add(x)); next.delete(id); setHiddenFacs(next); save([...shownKeys,k]); return; }
          if(next.has(id)) next.delete(id);
          else { next.add(id); if(selFac===id) setSelFac("all"); }
          setHiddenFacs(next); };
        return <>
          {all
            ? <span style={chip}>All locations<button onClick={()=>setVenue(null)} title="Back to the default location" style={{border:"none",background:"none",cursor:"pointer",color:"#64748b",fontSize:12,padding:"0 2px"}}>✕</button></span>
            : ks.map(k=>{ const v=siteOf(k); return (
              // Vendor first: several vendors can share a site (GTEC / CPSA and St Cuthberts at Cornwall Park).
              // Same width as the facility pills (name cut with …, in full on hover) so the row doesn't overflow.
              // ▾ opens the vendor's locations, each expandable to its fields.
              <span key={k} className="facpill" style={{...chip,justifyContent:"space-between",overflow:"hidden"}} title={v?`${v.providerName} — ${v.site}`:k}>
                <VenueChipMenu label={`📍 ${v?`${PROVIDERS[v.providerId]?.label||PROVIDERS[v.providerId]?.short||v.providerName} · ${v.site}`:k}`}
                  title={v?`${v.providerName}: choose locations and fields`:k} sites={v?sitesOf(v.providerId):[]} onToggleSite={toggleSite} onToggleFac={toggleFac}/>
                {ks.length>1&&<button onClick={()=>drop(k)} title="Stop showing this location" style={{border:"none",background:"none",cursor:"pointer",color:"#64748b",fontSize:12,padding:"0 2px"}}>✕</button>}
              </span>); })}
          <ProviderMenu pids={pids} value={null} onPick={pickProvider} label="＋ Add" sites={pid=>venues.filter(v=>v.providerId===pid).map(v=>v.site)}
            facilitiesOf={pid=>visibleFacilities().filter(f=>(f.provider||defaultProviderId())===pid)} onPickFacility={pickFacility}
            style={{...chip,padding:"4px 10px",borderStyle:"dashed",color:"#475569"}} extra={isAdmin?[{value:ALL_VENUES,label:"All vendors & locations"}]:[]}/>
        </>;
      })()}
      <button onClick={()=>setSelFac("all")} style={{padding:"5px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,borderColor:selFac==="all"?"#0f172a":"#e2e8f0",background:selFac==="all"?"#0f172a":"#fff",color:selFac==="all"?"#fff":"#475569"}}>All</button>
      {/* Facility pills: equal width (full name on hover, desktop); ✕ removes one from the options. */}
      {venueFacilities().map(f=>{ const on=selFac===f.id; return (
        <span key={f.id} className="facpill" title={f.name}
          style={{display:"inline-flex",alignItems:"center",borderRadius:20,border:`1.5px solid ${on?f.color:"#e2e8f0"}`,background:on?f.color:"#fff",color:on?"#fff":"#475569",flexShrink:0,overflow:"hidden"}}>
          <button onClick={()=>setSelFac(on?"all":f.id)} style={{display:"inline-flex",alignItems:"center",gap:5,minWidth:0,flex:1,padding:"5px 4px 5px 12px",border:"none",background:"none",color:"inherit",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit"}}>
            <span style={{width:8,height:8,borderRadius:"50%",background:on?"#fff":f.color,flexShrink:0}}/><span className="facpill-n">{f.name}</span>
          </button>
          <button onClick={()=>{ const next=new Set(hiddenFacs); next.add(f.id); setHiddenFacs(next); if(on) setSelFac("all"); }} title={`Remove ${f.name} from the options`} aria-label={`Remove ${f.name}`}
            style={{border:"none",background:"none",color:"inherit",opacity:.6,cursor:"pointer",fontSize:11,padding:"5px 9px 5px 3px",flexShrink:0}}>✕</button>
        </span>); })}
      {/* Reset: default locations (CPSA + your active fields) and nothing removed; then Undo. */}
      {optionsUndo
        ? <button onClick={()=>{ setVenue(optionsUndo.venue); setHiddenFacs(new Set(optionsUndo.hidden)); setSelFac(optionsUndo.selFac); setOptionsUndo(null); }}
            title="Put back the locations and facilities you had before Reset"
            style={{padding:"5px 12px",borderRadius:20,border:"1.5px dashed #94a3b8",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,background:"#f8fafc",color:"#334155"}}>↶ Undo reset</button>
        : <button onClick={()=>{ setOptionsUndo({ venue, hidden:[...hiddenFacs], selFac }); const t=resetTarget(); setVenue(t.venues.length===1?null:t.venues.join(VENUE_SEP)); setHiddenFacs(new Set(t.hidden)); setSelFac("all"); }}
            title="Back to the default: the GTEC / CPSA fields plus fields with upcoming bookings, and only their locations"
            style={{padding:"5px 12px",borderRadius:20,border:"1.5px dashed #94a3b8",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,background:"#fff",color:"#64748b"}}>↺ Reset</button>}
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
    <div style={{minHeight:"100vh",background:T.surface2,fontFamily:T.font}}>
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
      <div style={{background:T.surface,borderBottom:`1px solid ${T.lineSoft}`,padding:"0 16px"}}>
        <div style={{maxWidth:1300,margin:"0 auto"}}>
          {/* Top row: logo + user + action buttons */}
          <div style={{display:"flex",alignItems:"center",gap:10,height:56,flexWrap:"nowrap"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
              <img src={LOGO_SRC} alt="AMUA" style={{width:34,height:34,borderRadius:8,objectFit:"cover"}}/>
              {!isMobile&&<span style={{fontSize:15,fontWeight:800,color:T.ink,letterSpacing:"-0.02em"}}>FacilityBook</span>}
              {!configured&&<span style={{fontSize:10,background:"#fef3c7",color:"#92400e",padding:"2px 6px",borderRadius:6,fontWeight:600}}>Demo</span>}
              <nav className="appnav" aria-label="Apps">
                {APPS.map(a=><a key={a.id} href={appHref(a)} title={a.title} aria-current={a.id==="bookings"?"page":undefined}><span className="ai" aria-hidden="true">{a.icon}</span><span className="al">{a.label}</span></a>)}
              </nav>
            </div>
            <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center",flexShrink:0,flexWrap:"nowrap"}}>
              {/* Cart / removal — always visible when populated */}
              {cart.length>0&&(
                <button onClick={()=>setShowCart(true)} style={S.btn({background:"#f59e0b",color:"#fff",display:"flex",alignItems:"center",gap:4,padding:"7px 10px"})}>
                  🛒{!isMobile&&" Cart"}
                  <span style={{background:"#fff",color:"#92400e",borderRadius:999,fontSize:11,fontWeight:800,padding:"1px 6px",minWidth:18,textAlign:"center"}}>{cart.reduce((s,i)=>s+(i.invoiceEmail?(i.count||1):(i.drafts?.length||0)),0)}</span>
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
                    title={syncProgress?`Syncing ${syncProgress.label} (${syncProgress.done+1} of ${syncProgress.total})${syncProgress.phase?` — ${syncProgress.phase}`:""}`:`Sync all months with GTEC · Last: ${syncLabel}`}
                    style={S.btn({background:syncingMonth?"#e2e8f0":"#0ea5e9",color:syncingMonth?"#94a3b8":"#fff",fontSize:11,padding:"7px 10px",cursor:syncingMonth?"wait":"pointer",opacity:syncingMonth&&!syncProgress?0.7:1})}>
                    {syncProgress ? (
                      <span style={{display:"inline-flex",flexDirection:"column",gap:3,minWidth:isMobile?44:150,textAlign:"left"}}>
                        <span style={{whiteSpace:"nowrap",color:"#0f172a"}}>⏳ {isMobile ? `${syncProgress.done+1}/${syncProgress.total}` : `${syncProgress.label} · ${syncProgress.done+1}/${syncProgress.total}${syncProgress.phase?` · ${syncProgress.phase}`:""}`}</span>
                        <span style={{display:"block",height:4,borderRadius:2,background:"#cbd5e1",overflow:"hidden"}}>
                          <span style={{display:"block",height:"100%",width:`${Math.round(100*(syncProgress.done+(syncProgress.phase==="Saving…"?0.8:syncProgress.phase.startsWith("Matching")?0.5:0.1))/syncProgress.total)}%`,background:"#0ea5e9",transition:"width .3s"}}/>
                        </span>
                      </span>
                    ) : <>{syncingMonth?"⏳":"🔄"}{!isMobile&&(syncingMonth?` Syncing…`:` Sync`)}</>}
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
                  {!isMobile&&<span style={{maxWidth:120,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{actor&&!viewAsEmail?actor:loggedInEmail?.split("@")[0]}</span>}
                  <span style={{fontSize:9,color:"#94a3b8"}}>▾</span>
                </button>
                {showUserMenu&&(
                  <>
                    <div onClick={()=>setShowUserMenu(false)} style={{position:"fixed",inset:0,zIndex:30}}/>
                    <div style={{position:"absolute",right:0,top:"calc(100% + 6px)",zIndex:31,background:"#fff",border:"1.5px solid #e2e8f0",borderRadius:12,boxShadow:"0 8px 24px rgba(15,23,42,0.12)",width:280,maxWidth:"calc(100vw - 24px)",overflow:"hidden",fontSize:13}}>
                      {/* Who: account, the person using it (switch inline), role; admins' silent-mode switch. */}
                      <div style={{padding:"10px 14px",borderBottom:"1px solid #f1f5f9",background:"#f8fafc",display:"flex",flexDirection:"column",gap:4}}>
                        <div style={{display:"flex",alignItems:"center",gap:6}}>
                          <span style={{fontSize:12,color:"#0f172a",fontWeight:700,wordBreak:"break-all",flex:1}}>{loggedInEmail}</span>
                          <span style={{fontSize:10,fontWeight:700,padding:"2px 7px",borderRadius:10,background:isAdmin?"#f3e8ff":"#f1f5f9",color:isAdmin?"#7c3aed":"#475569",border:`1px solid ${isAdmin?"#ddd6fe":"#e2e8f0"}`,flexShrink:0}}>{isAdmin?"👑 Admin":"👤 User"}</span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:6,fontSize:12,color:"#64748b"}}>
                          <span>as <b style={{color:"#0f172a"}}>{actor||"—"}</b></span>
                          <button onClick={()=>{setShowUserMenu(false);ensureActor(true);}} style={{border:"none",background:"none",padding:0,color:"#4f46e5",fontWeight:600,fontSize:12,cursor:"pointer",fontFamily:"inherit"}}>Switch</button>
                          {isAdmin&&<button onClick={()=>setSilentMode(v=>!v)} title={silentMode?"Silent mode on: no emails are sent":"Silent mode off: emails are sent"}
                            style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,border:"none",background:"none",padding:0,cursor:"pointer",fontFamily:"inherit",fontSize:11,fontWeight:600,color:silentMode?"#92400e":"#64748b"}}>
                            {silentMode?"🔇 Silent":"🔔 Emails"}
                            <span style={{position:"relative",width:26,height:15,flexShrink:0}}>
                              <span style={{position:"absolute",inset:0,borderRadius:8,background:silentMode?"#f59e0b":"#cbd5e1"}}/>
                              <span style={{position:"absolute",top:2,left:silentMode?13:2,width:11,height:11,borderRadius:"50%",background:"#fff"}}/>
                            </span>
                          </button>}
                        </div>
                      </div>
                      <div style={{padding:"4px 0"}}>
                        <UserMenuItem icon="📜" label="Activity log" onClick={()=>{setShowUserMenu(false);setShowActivityLog(true);}}/>
                        <UserMenuItem icon="📇" label="My council contact" onClick={()=>{setShowUserMenu(false);setShowContactModal(true);}}/>
                      </div>
                      {/* Admin settings fold away: one line until opened. */}
                      {isAdmin&&(
                        <div style={{borderTop:"1px solid #f1f5f9",padding:"4px 0"}}>
                          <UserMenuItem icon="⚙" label={<span style={{display:"flex",flex:1}}>Admin settings<span style={{marginLeft:"auto",color:"#94a3b8"}}>{adminMenuOpen?"▴":"▾"}</span></span>} onClick={()=>setAdminMenuOpen(v=>!v)}/>
                          {adminMenuOpen&&(
                            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:2,padding:"0 8px 6px"}}>
                              {[["💲","Rates",()=>setShowRatesModal(true)],["👥","Players",()=>setShowPlayersModal(true)],["👤","Users",()=>setShowUserMgmtModal(true)],
                                ["🏢","AMUA details",()=>setShowAmuaModal(true)],["🗑","Log retention",()=>setShowRetentionModal(true)],["🧩","Extensions",()=>setShowExtensionModal(true)],
                                ["🏛","Council form",()=>window.open(COUNCIL_APPLICATION_URL,"_blank","noopener")],["⬇","Reload data",()=>handleSyncDB()],[driveConfigured()?"☁":"💾",driveConfigured()?"Backup / upload to Drive":"Backup (download)",()=>handleBackupDatabase()]].map(([ic,lbl,fn])=>(
                                <button key={lbl} onClick={()=>{setShowUserMenu(false);fn();}}
                                  style={{display:"flex",alignItems:"center",gap:6,padding:"7px 8px",border:"1px solid #f1f5f9",borderRadius:8,background:"#fff",fontFamily:"inherit",fontSize:12,color:"#0f172a",cursor:"pointer",textAlign:"left",fontWeight:500}}>
                                  <span style={{width:16,textAlign:"center"}}>{ic}</span>{lbl}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      <div style={{borderTop:"1px solid #f1f5f9",padding:"4px 0"}}>
                      <UserMenuItem icon="↪" label="Sign out" onClick={()=>{setShowUserMenu(false);handleLogout();}} danger/>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
          {/* Bottom row: tabs (always visible, scrollable) */}
          <div style={{display:"flex",gap:2,overflowX:"auto",paddingBottom:isMobile?6:8,WebkitOverflowScrolling:"touch",scrollbarWidth:"none",msOverflowStyle:"none"}}>
            <TabBtn id="about"    icon="ℹ️" label="About"/>
            <TabBtn id="calendar" icon="📅" label="Week"/>
            <TabBtn id="month"    icon="🗓" label="Month"/>
            <TabBtn id="list"     icon="📋" label="Bookings" short="List" badge={myClashCount>0?myClashCount:undefined}/>
            <TabBtn id="summary"  icon="📊" label="Summary" short="Totals"/>
            {(isAdmin||!!loggedInEmail)&&<TabBtn id="billing" icon="🧾" label="Billing"/>}
            {isAdmin&&<TabBtn id="admin" icon="⚙" label="Admin" badge={pendingCount}/>}
            {isAdmin&&<TabBtn id="allocation" icon="🏛" label="Allocation" short="Council" badge={councilOpenCount||undefined}/>}
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
          const curSeason = currentLeagueSeason(), seasonOrder = [curSeason, ...LEAGUE_SEASONS.map(x=>x.id).filter(x=>x!==curSeason)];
          return (
            <div style={{display:"flex",gap:6,marginBottom:12,alignItems:"center",overflowX:"auto",WebkitOverflowScrolling:"touch",scrollbarWidth:"none",msOverflowStyle:"none",paddingBottom:2}}>
              <button onClick={()=>setListBookerFilter(allSelected?new Set():new Set(allLower))}
                title={allSelected?"Clear all bookers":"Select all bookers"}
                style={{padding:"5px 12px",borderRadius:20,border:"1.5px solid",cursor:"pointer",fontSize:12,fontWeight:600,fontFamily:"inherit",flexShrink:0,borderColor:listBookerFilter.size===0?"#0f172a":"#e2e8f0",background:listBookerFilter.size===0?"#0f172a":"#fff",color:listBookerFilter.size===0?"#fff":"#475569"}}>
                {allSelected?"None":"All"}
              </button>
              {/* Bookers grouped by league season (current season first); a season chip
                  selects just its bookers, again to clear. */}
              {seasonOrder.flatMap(sid=>{
                const members=emailLegend.filter(pr=>seasonOfBooker(pr,bookerSeasons)===sid);
                if(!members.length) return [];
                const groupOf=pr=>bookerGroups[pr]||new Set([pr]);
                const x=LEAGUE_SEASONS.find(y=>y.id===sid), addrs=members.flatMap(pr=>[...groupOf(pr)]);
                const shut=collapsedSeasons.has(sid);
                const on=listBookerFilter.size===addrs.length&&addrs.every(e=>listBookerFilter.has(e));
                return [
                  <button key={"season-"+sid} onClick={()=>setListBookerFilter(on?new Set():new Set(addrs))}
                    title={`${x.name} (${x.span})${sid===curSeason?" — current season":x.continuous?" — continuous":" — next season"}: select its ${members.length} booker${members.length!==1?"s":""}`}
                    style={{padding:"4px 10px",borderRadius:8,border:`1.5px dashed ${on?"#0f172a":"#94a3b8"}`,cursor:"pointer",fontSize:11,fontWeight:800,fontFamily:"inherit",flexShrink:0,marginLeft:4,background:on?"#0f172a":"#f8fafc",color:on?"#fff":"#334155",letterSpacing:"0.02em"}}>
                    {x.name}{!x.continuous&&<span style={{fontWeight:500,opacity:.75,marginLeft:4}}>{sid===curSeason?"now":"next"}</span>}
                    {shut&&<span style={{fontWeight:500,opacity:.75,marginLeft:4}}>×{members.length}</span>}
                  </button>,
                  // Each category collapses to its chip alone; ▸ / ◂ shows or hides its bookers.
                  <button key={"season-open-"+sid} aria-expanded={!shut} title={shut?`Show ${x.name} bookers`:`Collapse ${x.name} to one chip`}
                    onClick={()=>toggleSeasonCollapsed(sid)}
                    style={{padding:"4px 7px",borderRadius:8,border:"1.5px dashed #94a3b8",cursor:"pointer",fontSize:11,fontWeight:800,fontFamily:"inherit",flexShrink:0,marginLeft:-2,background:"#f8fafc",color:"#334155"}}>
                    {shut?"▸":"◂"}
                  </button>,
                  ...(shut?[]:members).map(primary=>{
                const group=groupOf(primary);
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
              })];
              })}
            </div>
          );
        })()}

        {(tab==="calendar"||tab==="month"||tab==="list")&&FacilityPills()}

        {tab==="calendar"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<WeekCalendar bookings={bookings} selectedFacility={selFac} onNewBooking={openNew} onNewBookingRange={openNewRange} onBookingClick={setViewing} cartSourceIds={new Set(cart.flatMap(i=>i.sourceIds||[]))} deleteIds={new Set(deleteQueue.map(b=>b.id))} cartNewDrafts={cart.flatMap(i=>!i.notifyOnly&&!i.statusChange&&(i.sourceIds||[]).length===0?i.drafts:[])} focusedDate={focusedDate} setFocusedDate={setFocusedDate} onOpenDay={openDay} bookerFilter={listBookerFilter} aliasNames={aliasNames} emailAliases={emailAliases}/>}</div>}
        {tab==="month"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<MonthCalendar bookings={bookings} selectedFacility={selFac} onBookingClick={setViewing} onNewBooking={openNew} onNewBookingRange={openNewRange} onMultiDelete={queueMultiForRemoval} onMultiAddToCart={handleMultiAddToCart} loggedInEmail={loggedInEmail} isAdmin={isAdmin} cartSourceIds={new Set(cart.flatMap(i=>i.sourceIds||[]))} deleteIds={new Set(deleteQueue.map(b=>b.id))} cartNewDrafts={cart.flatMap(i=>!i.notifyOnly&&!i.statusChange&&(i.sourceIds||[]).length===0?i.drafts:[])} onOpenDay={openDay} onGotoWeek={dk=>{ setFocusedDate(new Date(dk+"T00:00:00")); setTab("calendar"); }} bookerFilter={listBookerFilter} aliasNames={aliasNames} emailAliases={emailAliases}/>}</div>}

        {tab==="list"&&(
          <div style={S.card}>
            {loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:(()=>{
              // Canonical booker list (linked secondaries fold into their primary) — the
              // same source the header pills use, so the column filter shows one chip per booker.
              const bookerAllEmails = [...new Set(emailLegend.flatMap(p=>[...bookerGroups[p]]))];
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
                  </div>
                  {/* Grouped (schedule summary, the default) or Itemised (one row per booking). */}
                  <TableViewToggle value={listView} onChange={setListView}/>
                  {listView==="grouped" ? (
                    <ScheduleSummaryModal bookings={bookings.filter(b=>inActiveVenue(b.facility_id)&&(selFac==="all"||b.facility_id===selFac)&&(listBookerFilter.size===0||listBookerFilter.has(b.email?.toLowerCase()))&&(!listShowClashes||allClashIds.has(b.id)))} isAdmin={isAdmin} loggedInEmail={loggedInEmail} onBulkApply={handleBulkApply} onBulkStatusChange={handleBulkStatusChange} onRemove={queueMultiForRemoval} onReassign={isAdmin?handleBulkReassign:undefined} onAddPricingRule={isAdmin?addPricingCondition:undefined} bookers={knownBookers} onView={setViewing} aliasNames={aliasNames} emailAliases={emailAliases} embedded/>
                  ) : isMobile ? (
                    // Phones: filters in a compact grid (bookers via the pills above), then one
                    // card per booking — date, time, field and status on top, booker and purpose below.
                    <>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:8}}>
                        <div style={{gridColumn:"1 / -1",position:"relative"}}><DateRangePicker from={listDateFrom} to={listDateTo} onApply={(f,t)=>{setListDateFrom(f);setListDateTo(t);}}/></div>
                        <select value={listColFacility} onChange={e=>setListColFacility(e.target.value)} aria-label="Facility"
                          style={{...S.inp,fontSize:12,padding:"6px 8px",minWidth:0}}>
                          <option value="all">All facilities</option>
                          {visibleFacilities().map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
                        </select>
                        <select value={listStatusFilter} onChange={e=>setListStatusFilter(e.target.value)} aria-label="Status"
                          style={{...S.inp,fontSize:12,padding:"6px 8px",minWidth:0}}>
                          <option value="all">All statuses</option>
                          {Object.keys(STATUS_META).filter(k=>!isLegacyStatus(k)).map(k=><option key={k} value={k}>{groupStatusLabel(k, bookings.filter(b=>b.status===k))}</option>)}
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
                                  {visibleFacilities().map(f=><option key={f.id} value={f.id}>{f.name}</option>)}
                                </select>
                              </th>
                              <th style={{padding:"3px 4px"}}>
                                <select value={listStatusFilter} onChange={e=>setListStatusFilter(e.target.value)}
                                  style={{padding:"3px 4px",fontSize:11,border:"1px solid #cbd5e1",borderRadius:4,background:"#fff",width:"100%"}}>
                                  <option value="all">All</option>
                                  {Object.keys(STATUS_META).filter(k=>!isLegacyStatus(k)).map(k=><option key={k} value={k}>{groupStatusLabel(k, bookings.filter(b=>b.status===k))}</option>)}
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
            })()}
          </div>
        )}

        {tab==="summary"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<Suspense fallback={<TabLoading/>}><SummaryTab bookings={bookings} loggedInEmail={loggedInEmail} onRemoveBookings={queueMultiForRemoval} facilityRates={facilityRates} pricingConditions={pricingConditions} onAddPricingCondition={addPricingCondition} onUpdatePricingCondition={updatePricingCondition} onRemovePricingCondition={removePricingCondition} isAdmin={isAdmin} approxPlayers={approxPlayers} onUpdateApproxPlayers={updateApproxPlayers} approxDurations={approxDurations} onUpdateApproxDuration={updateApproxDuration} onUpdateFacilityRate={updateFacilityRate} pricingMode={pricingMode} onSetPricingMode={setPricingMode} onProposeMerge={handleProposeMerge} onBulkApply={handleBulkApply} onMarkInvoiced={handleMarkInvoiced} onMarkAdjustmentSettled={handleMarkAdjustmentSettled} bookerFilter={listBookerFilter} profiles={profiles} emailAliases={emailAliases} aliasNames={aliasNames} onCreateOfficialInvoice={handleCreateOfficialInvoice} onEmailInvoice={handleEmailInvoicePreview} loadRequest={summaryLoadRequest}/></Suspense>}</div>}
        {tab==="billing"&&<div style={S.card}>{loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<Suspense fallback={<TabLoading/>}><BillingTab billingRecords={billingRecords} onUpdateRecord={handleUpdateBillingRecord} onDeleteRecord={id=>setBillingRecords(prev=>prev.filter(r=>r.id!==id))} onCreateReceipt={handleCreateReceipt} onLoadToSummary={handleLoadBillingToSummary} isAdmin={isAdmin} loggedInEmail={loggedInEmail} emailAliases={emailAliases} aliasNames={aliasNames} profiles={profiles} driveEnabled={driveConfigured()} onDriveSync={handleDriveSync} onRenameBatch={handleRenameBatch} onDriveAttach={handleDriveAttachGtec} onEmailOfficial={handleEmailOfficialInvoices} onQueueInvoiceEmails={handleQueueInvoiceEmails} silentMode={silentMode} onToggleSilent={isAdmin?setSilentMode:undefined}/></Suspense>}</div>}
        {tab==="about"&&<div style={{padding:"8px 0"}}><Suspense fallback={<TabLoading/>}><AboutTab/></Suspense></div>}
        {tab==="allocation"&&isAdmin&&<div style={S.card}><Suspense fallback={<TabLoading/>}><CouncilAllocationTab outcomes={councilOutcomes} bookings={bookings} syncing={councilSyncing} syncLog={councilSyncLog} onSync={handleCouncilMailSync} onSaveOutcomes={saveCouncilOutcomes} onBulkStatusChange={handleBulkStatusChange} onQueueNotifications={queueNotifications} onLinkApp={handleLinkCouncilApp} aliasNames={aliasNames} loggedInEmail={loggedInEmail}/></Suspense></div>}
        {tab==="admin"&&isAdmin&&<div style={S.card}>
          {loading?<div style={{textAlign:"center",padding:40,color:"#94a3b8"}}>Loading…</div>:<Suspense fallback={<TabLoading/>}><AdminPanel bookings={bookings} onBulkStatusChange={handleBulkStatusChange} onEdit={openEdit} onView={setViewing} onQueueDelete={queueForRemovalSilent} clashes={allClashes} deleteIds={new Set(deleteQueue.map(b=>b.id))} facilityRates={facilityRates} onUpdateFacilityRate={updateFacilityRate} onResolveOldUnapproved={handleResolveOldUnapproved} onReassign={handleBulkReassign} bookers={knownBookers} approxPlayers={approxPlayers} onUpdateApproxPlayers={updateApproxPlayers} approxDurations={approxDurations} onUpdateApproxDuration={updateApproxDuration} onSyncDB={handleSyncDB} onBulkApply={handleBulkApply} onSaveMismatch={handleSaveMismatch} onInformCpsa={setInformCpsaFor} onRequestRoom={setRoomRequestFor} onQueueNotifications={queueNotifications} onMarkAdjustmentSettled={handleMarkAdjustmentSettled} onLinkClash={handleLinkClashToGtec} loggedInEmail={loggedInEmail} syncResults={syncResults} onClearSyncResults={()=>setSyncResults([])} showSyncResults={showSyncPanel} onToggleSyncResults={()=>setShowSyncPanel(v=>!v)} bookerFilter={listBookerFilter} onToggleBooker={toggleBooker} onSetBookerFilter={setListBookerFilter} aliasNames={aliasNames} emailAliases={emailAliases} pricingConditions={pricingConditions} onAddPricingCondition={addPricingCondition} onUpdatePricingCondition={updatePricingCondition} onRemovePricingCondition={removePricingCondition} cpsaDeleteLog={cpsaDeleteLog} onClearDeleteLogEntry={id=>setCpsaDeleteLog(prev=>prev.filter(e=>e.id!==id))} onClearDeleteLog={()=>setCpsaDeleteLog([])} syncFeed={syncFeed} onPasteFeed={handlePasteFeed} cjrMonthUrl={cjrMonthUrl} onSendToCouncil={handleSendToCouncil}/></Suspense>}
        </div>}
      </div>

      {/* Modals */}
      {showAdminScheduleModal && <ScheduleSummaryModal bookings={bookings} isAdmin={true} loggedInEmail={loggedInEmail} onBulkApply={handleBulkApply} onBulkStatusChange={handleBulkStatusChange} onRemove={queueMultiForRemoval} onReassign={isAdmin?handleBulkReassign:undefined} onAddPricingRule={isAdmin?addPricingCondition:undefined} bookers={knownBookers} onView={b=>{setShowAdminScheduleModal(false);setViewing(b);}} aliasNames={aliasNames} emailAliases={emailAliases} onClose={()=>setShowAdminScheduleModal(false)}/>}
      {showExtensionModal&&(
        <Modal title="🧩 Install AMUA Extensions" onClose={()=>setShowExtensionModal(false)} width={560}>
          <div style={{display:"flex",flexDirection:"column",gap:16,fontSize:14,color:"#0f172a"}}>
            <div style={{background:"#f0fdf4",border:"1px solid #bbf7d0",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#166534"}}>
              The browser extension lets you submit bookings to GTEC (Sporty) directly from this app and syncs confirmation links back automatically.
            </div>
            <a href="https://github.com/aucklandmixedultimate/amua-booking-extension/releases/latest" target="_blank" rel="noopener noreferrer"
              style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"#7c3aed",color:"#fff",borderRadius:10,padding:"12px 16px",textDecoration:"none",fontWeight:700,fontSize:14}}>
              ⬇ Get the latest build (release page)
            </a>
            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {[
                ["1","Download the latest build", <>Click the button above to open the <a href="https://github.com/aucklandmixedultimate/amua-booking-extension/releases/latest" target="_blank" rel="noopener noreferrer" style={{color:"#7c3aed",fontWeight:600}}>latest release</a>, download the attached <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>.zip</code> (under <em>Assets</em>), and unzip it.</>],
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
            {/* Second extension: fills Auckland Council's sports-field application form. */}
            <div style={{borderTop:"1px solid #e2e8f0",paddingTop:14,display:"flex",flexDirection:"column",gap:10}}>
              <div style={{fontWeight:700,fontSize:15}}>🏛 AMUA Council Application</div>
              <div style={{background:"#f0fdfa",border:"1px solid #99f6e4",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#115e59"}}>
                A side panel, like the CPSA widget, for batching council bookings into one Auckland Council sports-field application. Click its 🏛 toolbar icon and sign in with the AMUA admin account. It lists the bookings waiting for AMUA by park: the fields, dates and time windows, any overlapping or shared fields, and the $10-per-field fee split between bookers. The applicant and contacts come from <strong>AMUA details</strong>. On the council&apos;s form, press <strong>Fill this page</strong> on each page, check it, tick the declarations and submit. Then press <strong>Record</strong> to save the application number and fee shares.
              </div>
              <a href="https://github.com/aucklandmixedultimate/amua-booking-extension/releases/download/council-latest/amua-council-extension.zip"
                style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,background:"#0d9488",color:"#fff",borderRadius:10,padding:"12px 16px",textDecoration:"none",fontWeight:700,fontSize:14}}>
                ⬇ Download the council extension (.zip)
              </a>
              <div style={{fontSize:13,color:"#475569"}}>Install it the same way as above: unzip, then <strong>Load unpacked</strong> in <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>chrome://extensions</code>. It only runs on <code style={{background:"#f1f5f9",padding:"1px 5px",borderRadius:4,fontSize:12}}>onlineservices.aucklandcouncil.govt.nz</code>. <a href="https://github.com/aucklandmixedultimate/amua-booking-extension/releases/tag/council-latest" target="_blank" rel="noopener noreferrer" style={{color:"#0d9488",fontWeight:600}}>Release notes</a></div>
            </div>
            <div style={{borderTop:"1px solid #f1f5f9",paddingTop:12,display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button onClick={()=>setShowExtensionModal(false)} style={S.btn({border:"1.5px solid #e2e8f0",background:"#fff",color:"#475569"})}>Close</button>
            </div>
          </div>
        </Modal>
      )}

      {showActivityLog&&(
        <ActivityLogModal onClose={()=>setShowActivityLog(false)} bookers={isAdmin?knownBookers:[]} isAdmin={isAdmin}/>
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
              Activity-log purging needs the admin <code>DELETE</code> policy from <code>supabase-setup.sql</code>.
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
            {visibleFacilities().map(fac => {
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
                  {/* Day and evening side by side; each label stays with its box. */}
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                    {[["day","☀ Day","#64748b"],["evening","🌙 Evening","#7c3aed"]].map(([k,lbl,c])=>(
                      <label key={k} style={{display:"flex",alignItems:"center",gap:5,minWidth:0,fontSize:12,color:c,fontWeight:600}}>
                        <span style={{whiteSpace:"nowrap"}}>{lbl}</span>
                        <span style={{display:"flex",alignItems:"center",flex:1,minWidth:0,border:"1.5px solid #e2e8f0",borderRadius:6,padding:"0 6px",background:"#fff"}}>
                          <span style={{color:"#94a3b8"}}>$</span>
                          <input type="number" inputMode="decimal" min="0" step="0.5" value={r[k]||""} placeholder="0"
                            onChange={e=>updateFacilityRate(fac.id,k,e.target.value)}
                            style={{flex:1,minWidth:0,width:"100%",padding:"6px 2px",border:"none",fontSize:13,textAlign:"right",fontFamily:"inherit",outline:"none",background:"transparent"}}/>
                          <span style={{color:"#94a3b8",fontWeight:500}}>/hr</span>
                        </span>
                      </label>
                    ))}
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

      {showAmuaModal&&realIsAdmin&&(
        <AmuaDetailsModal value={amuaOrg} onClose={()=>setShowAmuaModal(false)}
          onSave={next=>{ saveAmuaOrg(next); setShowAmuaModal(false); showToast("AMUA details saved."); }}/>
      )}

      {showUserMgmtModal&&realIsAdmin&&(
        <UserMgmtModal
          bookings={bookings}
          aliases={emailAliases}
          aliasNames={aliasNames}
          aliasColors={aliasColors}
          bookerSeasons={bookerSeasons}
          onChangeSeasons={saveBookerSeasons}
          onChange={saveEmailAliases}
          onChangeNames={saveAliasNames}
          onChangeColors={saveAliasColors}
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
            booking={editing!==null?editing:(Array.isArray(prefill.dates)&&prefill.dates.length?{_dates:prefill.dates,start_hour:prefill.startHour,duration:prefill.duration,...(prefill.facility?{facility_id:prefill.facility}:{})}:prefill.date?{date:prefill.date,start_hour:prefill.startHour,duration:prefill.duration,...(prefill.facility?{facility_id:prefill.facility}:{})}:null)}
            allBookings={bookings}
            onSave={handleSave}
            onAddToCart={handleAddToCart}
            onClose={()=>{setShowForm(false);setEditing(null);}}
            isAdmin={isAdmin}
            loggedInEmail={loggedInEmail}
            actorName={viewAsEmail?"":actor}
            bookers={knownBookers}
            onEditContact={session ? (em)=>{ setContactFor((em||"").toLowerCase()); setShowContactModal(true); } : undefined}
          />
        </Modal>
      )}
      {/* After the booking form so it opens on top of it. */}
      {showContactModal&&session&&(
        <CouncilContactModal key={contactFor||loggedInEmail} email={contactFor||loggedInEmail} isAdmin={isAdmin} contacts={bookerContacts||{}} tableReady={bookerContacts!==null}
          onClose={()=>{setShowContactModal(false);setContactFor("");}}
          onSave={async row=>{ try{ await sb.upsert("booker_contacts", { ...row, updated_at:new Date().toISOString() }, "email"); await loadBookerContacts(); setShowContactModal(false); setContactFor(""); showToast("Council contact saved."); }
            catch(e){ showToast("Couldn't save: "+(e.message||e).slice(0,140),"error"); } }}/>
      )}

      {showCart&&(
        <Modal title="🛒 Booking Cart" onClose={()=>setShowCart(false)} width={660}>
          <CartModal cart={cart} setCart={setCart} onClose={()=>setShowCart(false)} onSubmit={handleCartSubmit} openNew={openNew} silentMode={silentMode} onToggleSilent={isAdmin?setSilentMode:undefined}/>
        </Modal>
      )}
      {roomRequestFor&&(
        <Modal title="📨 Room request to CPSA — choose the recipient" onClose={()=>setRoomRequestFor(null)} width={520}>
          {(()=>{
            const b = roomRequestFor, fac = FACILITIES.find(x=>x.id===b.facility_id);
            // The rooms are requested from CPSA: CPSA vendors first (and suggested), then GTEC, then others.
            const rank = ([e,p]) => /cpsa|cornwall park sports/i.test(`${e} ${p.fullName||""}`) ? 2 : /gtec|grammar/i.test(`${e} ${p.fullName||""}`) ? 1 : 0;
            const isCpsa = v => rank(v) === 2;
            const vendors = Object.entries(profiles||{}).filter(([,p])=>p?.profileType==="vendor").sort((a,c)=>rank(c)-rank(a));
            return (
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div style={{background:"#f5f3ff",border:"1px solid #ddd6fe",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#4c1d95"}}>
                  <div style={{fontWeight:700,marginBottom:4}}>{fac?.name||b.facility_id} · {fmtDate(b.date)}</div>
                  <div style={{color:"#475569"}}>{b.name} · {fmtTime(b.start_hour)}–{fmtTime(b.start_hour+b.duration)}{b.purpose?` · ${b.purpose}`:""}</div>
                </div>
                <div style={{fontSize:12,color:"#64748b"}}>This adds a room request to your cart. On submit it's saved as a <strong>draft in AMUA's inbox</strong> addressed to the vendor (vendor emails are never sent directly), and the booking moves to <strong>Pending CPSA review</strong>.</div>
                {vendors.length===0
                  ? <div style={{fontSize:13,color:"#92400e",background:"#fffbeb",border:"1px solid #fde68a",borderRadius:8,padding:"10px 14px"}}>No vendor profiles yet. Create one (e.g. CPSA) in <strong>👤 User Management</strong> first.</div>
                  : <div style={{display:"flex",flexDirection:"column",gap:6}}>
                      {vendors.map(([email,p],i)=>(
                        <button key={email} onClick={()=>addRoomRequestToCart(b, email, p.fullName||email)} autoFocus={i===0}
                          style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:2,padding:"10px 14px",borderRadius:10,border:`1.5px solid ${i===0&&isCpsa([email,p])?"#a78bfa":"#e2e8f0"}`,background:"#fff",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}>
                          <span style={{fontSize:14,fontWeight:700,color:"#0f172a"}}>{p.fullName||email}{i===0&&isCpsa([email,p])?" · suggested":""}</span>
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
        <Modal title="Booking Details" onClose={()=>setViewing(null)} side>
          <BookingDetail booking={viewing} syncFeed={isAdmin&&syncFeed.at?{ at: syncFeed.at, entries: syncFeed.byDate[viewing.date]||[] }:null} onEdit={()=>openEdit(viewing)} onClose={()=>setViewing(null)} onCancel={()=>queueForRemoval(viewing.id)} isAdmin={isAdmin} onStatusChange={status=>handleStatusChange(viewing,status)} onPatch={handlePatchBooking} loggedInEmail={loggedInEmail} allClashes={allClashes} bookers={knownBookers} onConvertAdmin={handleConvertAdminBooking} allBookings={bookings} onShareSlot={handleShareSlot} onMergeSlot={handleMergeSlots} onUnlinkSlot={handleUnlinkSlot}/>
        </Modal>
      )}

      {dayPopupDate&&(
        <DayTimelinePopup date={dayPopupDate} focusHour={dayPopupFocus} focusDuration={dayPopupDur} bookings={bookings} onClose={()=>{setDayPopupDate(null);setDayPopupFocus(null);setDayPopupDur(null);}}
          onBookingClick={b=>{ setDayPopupDate(null);setDayPopupFocus(null); setViewing(b); }}
          onNewBooking={openNew}
          cartNewDrafts={cart.flatMap(i=>!i.notifyOnly&&!i.statusChange&&(i.sourceIds||[]).length===0?i.drafts:[])}
          deleteIds={new Set(deleteQueue.map(b=>b.id))} cartSourceIds={new Set(cart.flatMap(i=>i.sourceIds||[]))}/>
      )}
    </div>
  );
}