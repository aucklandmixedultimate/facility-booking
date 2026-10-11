// The facility strip above the Week / Month / List views: the facilities shown, one chip each
// (click to show just that one, again for all), a "📍 Fields" menu to add or remove fields and
// locations, and Reset back to Cornwall Park (the default venue, nothing removed).
import { useState, useRef, useEffect } from "react";
import { ALL_VENUES, PROVIDERS, VENUE_SEP, activeFacilities, activeVenueKeys, defaultVenueKey, listVenues, previewEntries, setPreviewEntries, venueFacilities, venueKeyOf, visibleFacilities } from "./core.jsx";
import { loadTopVenues } from "./topVenues.js";
import { ownerTypeMeta, suitWord } from "../venues.js";


// Fixed-width chips (name cut with …, in full on hover via title) that wrap on desktop and
// scroll sideways on a phone; the tools stay at the end, the menu drops below them.
const STYLE = `
.fstrip{display:flex;align-items:flex-start;gap:var(--sp-2);margin-bottom:var(--sp-4)}
.fs-chips{display:flex;flex-wrap:wrap;gap:6px;flex:1;min-width:0}
.fstrip.phone{flex-direction:column;align-items:stretch;gap:6px}
.fstrip.phone .fs-chips{flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;padding-bottom:2px}
.fstrip.phone .fs-chips::-webkit-scrollbar{display:none}
.fs-chip{display:inline-flex;align-items:center;gap:6px;flex:none;max-width:170px;padding:5px 12px;border-radius:var(--r-pill);border:1.5px solid var(--c-line);background:var(--c-surface);color:var(--c-ink-2);font:600 12px/1.2 inherit;cursor:pointer}
.fs-chip.on{background:var(--c-ink);border-color:var(--c-ink);color:#fff}
.fs-t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.fs-dot{width:8px;height:8px;border-radius:50%;flex:none}
.fs-tools{position:relative;display:flex;gap:6px;flex:none}
.fs-btn{padding:5px 12px;border-radius:var(--r-pill);border:1.5px solid var(--c-ink);background:var(--c-surface);color:var(--c-ink);font:700 12px/1.2 inherit;cursor:pointer;white-space:nowrap}
.fs-btn.ghost{border:1.5px dashed var(--c-faint);color:var(--c-muted);font-weight:600}
.fs-menu{position:absolute;top:calc(100% + 4px);right:0;z-index:1200;width:290px;max-width:calc(100vw - 32px);max-height:min(70vh,520px);overflow-y:auto;background:var(--c-surface);border:1px solid var(--c-line);border-radius:var(--r-lg);box-shadow:0 10px 30px rgba(15,23,42,.15);padding:4px 0}
.fstrip.phone .fs-menu{left:0;right:auto}
.fs-vendor+.fs-vendor{border-top:1px solid var(--c-line-soft)}
.fs-vh{padding:8px 12px 2px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted)}
.fs-site{display:flex;align-items:center}
.fs-menu button{display:flex;align-items:center;gap:8px;border:0;background:none;font:13px/1.3 inherit;color:var(--c-ink);cursor:pointer;text-align:left;padding:7px 12px}
.fs-menu button:hover{background:var(--c-surface-2)}
.fs-site>button:first-child{flex:1;min-width:0}
.fs-n{color:var(--c-muted);font-size:11px;margin-left:auto}
.fs-exp{color:var(--c-muted)!important;font-size:12px!important;white-space:nowrap}
.fs-fac{width:100%;padding-left:34px!important;font-size:12.5px!important}
.fs-allv{width:100%;border-top:1px solid var(--c-line-soft)!important;color:var(--c-muted)!important;font-size:12px!important}
.fs-box{width:16px;height:16px;flex:none;border-radius:4px;border:1.5px solid var(--c-faint);display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#fff}
.fs-box.on{background:var(--c-ink);border-color:var(--c-ink)}
.fs-box.part{background:var(--c-muted);border-color:var(--c-muted)}
.fs-top{background:var(--c-surface-2)}
.fstrip.menuonly{margin-bottom:0}
.fstrip.menuonly .fs-menu{left:0;right:auto}
.fs-menu button.fs-toph{width:100%;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted);padding:8px 12px}
.fs-note{padding:4px 12px 8px;font-size:12px;color:var(--c-muted)}
.fs-tag{font-size:10px;font-weight:700;color:var(--c-muted);border:1px solid var(--c-line);border-radius:var(--r-pill);padding:0 6px;margin-left:6px}
`;

const vendorLabel = pid => PROVIDERS[pid]?.label || PROVIDERS[pid]?.short || PROVIDERS[pid]?.name || pid;

// Controlled mode (the Bookings tab's "All Bookings" list): `venueKeys` (keys or ALL_VENUES),
// `onVenueKeys`, `onReset` and `isDefault` replace the page's venue, and `menuOnly` shows just
// the 📍 menu and Reset, without the facility chips. It lists every active venue (any booker's
// active fields) in place of the page's venues and the top-rated list.
export function FacilityStrip({ isMobile, isAdmin, selFac = "all", setSelFac = () => {}, setVenue, hiddenFacs, setHiddenFacs, venueKeys, onVenueKeys, onReset, isDefault: isDefaultProp, menuOnly = false }) {
  const [open, setOpen] = useState(false), [exp, setExp] = useState(null), ref = useRef(null);
  // "All venues (top rated)": null = not loaded yet.
  const [topOpen, setTopOpen] = useState(false), [top, setTop] = useState(null);
  const toggleTop = () => { const o = !topOpen; setTopOpen(o); if (o && top === null) loadTopVenues().then(setTop); };
  useEffect(() => { if (!open) return;
    const off = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("touchstart", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("touchstart", off); document.removeEventListener("keydown", esc); }; }, [open]);

  const vis = venueKeys ? activeFacilities() : visibleFacilities(), venues = listVenues(vis);
  const ks = venueKeys ?? activeVenueKeys(), all = ks === ALL_VENUES, shownKeys = all ? venues.map(v => v.key) : ks;
  const facs = venueKeys ? vis.filter(f => shownKeys.includes(venueKeyOf(f)) && !hiddenFacs.has(f.id)) : venueFacilities();
  const facsAt = k => vis.filter(f => venueKeyOf(f) === k);
  const isShown = f => shownKeys.includes(venueKeyOf(f)) && !hiddenFacs.has(f.id);
  const isDefault = isDefaultProp ?? (!all && ks.length === 1 && ks[0] === defaultVenueKey() && !facsAt(ks[0]).some(f => hiddenFacs.has(f.id)));

  const saveKeys = list => onVenueKeys ? onVenueKeys(list) : setVenue(list.length === 1 && list[0] === defaultVenueKey() ? null : list.join(VENUE_SEP));
  const unhide = ids => { const next = new Set(hiddenFacs); ids.forEach(id => next.delete(id)); return next; };
  // A location goes in with every field, or out (never the last one).
  const toggleSite = k => {
    if (shownKeys.includes(k)) { if (shownKeys.length > 1) saveKeys(shownKeys.filter(x => x !== k)); return; }
    setHiddenFacs(unhide(facsAt(k).map(f => f.id))); saveKeys([...shownKeys, k]); };
  // A field goes in alone (its location joins with only that field) or out; the last field of
  // a location takes the location out with it, and the very last field stays.
  const toggleFac = f => { const k = venueKeyOf(f), next = new Set(hiddenFacs);
    if (!shownKeys.includes(k)) { facsAt(k).forEach(x => next.add(x.id)); next.delete(f.id); setHiddenFacs(next); saveKeys([...shownKeys, k]); return; }
    if (next.has(f.id)) { next.delete(f.id); setHiddenFacs(next); return; }
    if (facs.length <= 1) return;
    next.add(f.id);
    if (selFac === f.id) setSelFac("all");
    if (facsAt(k).every(x => next.has(x.id)) && shownKeys.length > 1) { facsAt(k).forEach(x => next.delete(x.id)); setHiddenFacs(next); saveKeys(shownKeys.filter(x => x !== k)); return; }
    setHiddenFacs(next); };
  const reset = () => { if (onReset) { onReset(); setOpen(false); return; } if (previewEntries().length) setPreviewEntries([]); setVenue(null); setHiddenFacs(new Set()); setSelFac("all"); setOpen(false); };
  // Show a top-rated venue's fields on the calendars, alongside what's shown now.
  const preview = x => {
    setPreviewEntries([...previewEntries().filter(e => e.park_id !== x.park.id), ...x.entries]);
    const k = `${x.provider}|${x.park.name}`;
    setHiddenFacs(unhide(x.entries.map(e => e.id))); saveKeys([...shownKeys.filter(y => y !== k), k]); setOpen(false);
  };

  // Menu: vendor › location (tick = shown; ▸ lists its fields) › fields.
  const pids = [...new Set(venues.map(v => v.providerId))];
  const box = (on, part) => <span aria-hidden className={`fs-box${on ? " on" : ""}${part ? " part" : ""}`}>{on ? (part ? "–" : "✓") : ""}</span>;
  const menu = open && (
    <div className="fs-menu" role="menu">
      {onVenueKeys ? <div className="fs-vendor fs-top"><div className="fs-vh" title="Every location with active fields, whichever booker added them">Active venues · {venues.length}</div></div>
      : <div className="fs-vendor fs-top">
        <button type="button" className="fs-toph" aria-expanded={topOpen} onClick={toggleTop} title="The best-rated venues of every type on All Auckland fields, bookable or not">
          ⭐ All venues · top rated <span className="fs-n">{topOpen ? "▾" : "▸"}</span>
        </button>
        {topOpen && (top === null ? <div className="fs-note">Loading…</div>
          : !top.length ? <div className="fs-note">No rated venues yet: rate them on All Auckland fields.</div>
          : top.map(x => { const t = ownerTypeMeta(x.owner); return (
            <button key={x.park.id} type="button" role="menuitem" className="fs-fac" onClick={() => preview(x)} title={`${t.label} · ${suitWord(x.score)}: show its fields on the calendars`}>
              <span aria-hidden>{t.icon}</span><span className="fs-t">{x.park.name}</span><span className="fs-n">{suitWord(x.score)}</span>
            </button>); }))}
      </div>}
      {pids.map(pid => (
        <div key={pid} className="fs-vendor">
          <div className="fs-vh">{vendorLabel(pid)}</div>
          {venues.filter(v => v.providerId === pid).map(v => { const fs = facsAt(v.key), n = fs.filter(isShown).length, on = shownKeys.includes(v.key), ex = exp === v.key;
            return (
              <div key={v.key}>
                <div className="fs-site">
                  <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => toggleSite(v.key)} title={on ? `Remove ${v.site}` : `Add every field at ${v.site}`}>
                    {box(on, on && n < fs.length)}<b>📍 {v.site}</b>{fs.some(f => f.preview) && <span className="fs-tag" title="From the top-rated list: not in anyone's My fields yet">preview</span>}{on && <span className="fs-n">{n}/{fs.length}</span>}
                  </button>
                  <button type="button" className="fs-exp" aria-expanded={ex} onClick={() => setExp(ex ? null : v.key)} title={ex ? "Hide its fields" : "Choose its fields"}>{fs.length} {ex ? "▾" : "▸"}</button>
                </div>
                {ex && fs.map(f => (
                  <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={isShown(f)} className="fs-fac" onClick={() => toggleFac(f)} title={f.name}>
                    {box(isShown(f))}<span className="fs-dot" style={{ background: f.color }}/><span className="fs-t">{f.name}</span>
                  </button>))}
              </div>); })}
        </div>))}
      {(isAdmin || onVenueKeys) && <button type="button" className="fs-allv" onClick={() => { onVenueKeys ? onVenueKeys(ALL_VENUES) : setVenue(ALL_VENUES); setOpen(false); }}>Show every vendor &amp; location</button>}
    </div>);

  const openMenu = () => { if (!open) setExp(shownKeys[0] || null); setOpen(!open); };
  return (
    <div className={`fstrip${isMobile ? " phone" : ""}${menuOnly ? " menuonly" : ""}`}>
      <style>{STYLE}</style>
      {!menuOnly && <div className="fs-chips">
        <button type="button" className={`fs-chip${selFac === "all" ? " on" : ""}`} onClick={() => setSelFac("all")}>All</button>
        {facs.map(f => { const on = selFac === f.id; return (
          <button key={f.id} type="button" className={`fs-chip${on ? " on" : ""}`} onClick={() => setSelFac(on ? "all" : f.id)} title={f.name}
            style={on ? { background: f.color, borderColor: f.color } : undefined}>
            <span className="fs-dot" style={{ background: on ? "#fff" : f.color }}/><span className="fs-t">{f.name}</span>
          </button>); })}
      </div>}
      <div className="fs-tools" ref={ref}>
        <button type="button" className="fs-btn" aria-haspopup="menu" aria-expanded={open} onClick={openMenu} title="Add or remove fields and locations">📍 Fields ▾</button>
        {(!isDefault || (!onReset && previewEntries().length > 0)) && <button type="button" className="fs-btn ghost" onClick={reset} title={onReset ? "Back to every active location" : "Back to the Cornwall Park facilities"}>↺ Reset</button>}
        {menu}
      </div>
    </div>
  );
}
