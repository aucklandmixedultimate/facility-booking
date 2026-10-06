// The facility strip above the Week / Month / List views: the facilities shown, one chip each
// (click to show just that one, again for all), a "📍 Fields" menu to add or remove fields and
// locations, and Reset back to Cornwall Park (the default venue, nothing removed).
import { useState, useRef, useEffect } from "react";
import { ALL_VENUES, PROVIDERS, VENUE_SEP, activeVenueKeys, defaultVenueKey, listVenues, venueFacilities, venueKeyOf, visibleFacilities } from "./core.jsx";


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
`;

const vendorLabel = pid => PROVIDERS[pid]?.label || PROVIDERS[pid]?.short || PROVIDERS[pid]?.name || pid;

export function FacilityStrip({ isMobile, isAdmin, selFac, setSelFac, setVenue, hiddenFacs, setHiddenFacs }) {
  const [open, setOpen] = useState(false), [exp, setExp] = useState(null), ref = useRef(null);
  useEffect(() => { if (!open) return;
    const off = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("touchstart", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("touchstart", off); document.removeEventListener("keydown", esc); }; }, [open]);

  const venues = listVenues(), vis = visibleFacilities(), facs = venueFacilities();
  const ks = activeVenueKeys(), all = ks === ALL_VENUES, shownKeys = all ? venues.map(v => v.key) : ks;
  const facsAt = k => vis.filter(f => venueKeyOf(f) === k);
  const isShown = f => shownKeys.includes(venueKeyOf(f)) && !hiddenFacs.has(f.id);
  const isDefault = !all && ks.length === 1 && ks[0] === defaultVenueKey() && !facsAt(ks[0]).some(f => hiddenFacs.has(f.id));

  const saveKeys = list => setVenue(list.length === 1 && list[0] === defaultVenueKey() ? null : list.join(VENUE_SEP));
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
  const reset = () => { setVenue(null); setHiddenFacs(new Set()); setSelFac("all"); setOpen(false); };

  // Menu: vendor › location (tick = shown; ▸ lists its fields) › fields.
  const pids = [...new Set(venues.map(v => v.providerId))];
  const box = (on, part) => <span aria-hidden className={`fs-box${on ? " on" : ""}${part ? " part" : ""}`}>{on ? (part ? "–" : "✓") : ""}</span>;
  const menu = open && (
    <div className="fs-menu" role="menu">
      {pids.map(pid => (
        <div key={pid} className="fs-vendor">
          <div className="fs-vh">{vendorLabel(pid)}</div>
          {venues.filter(v => v.providerId === pid).map(v => { const fs = facsAt(v.key), n = fs.filter(isShown).length, on = shownKeys.includes(v.key), ex = exp === v.key;
            return (
              <div key={v.key}>
                <div className="fs-site">
                  <button type="button" role="menuitemcheckbox" aria-checked={on} onClick={() => toggleSite(v.key)} title={on ? `Remove ${v.site}` : `Add every field at ${v.site}`}>
                    {box(on, on && n < fs.length)}<b>📍 {v.site}</b>{on && <span className="fs-n">{n}/{fs.length}</span>}
                  </button>
                  <button type="button" className="fs-exp" aria-expanded={ex} onClick={() => setExp(ex ? null : v.key)} title={ex ? "Hide its fields" : "Choose its fields"}>{fs.length} {ex ? "▾" : "▸"}</button>
                </div>
                {ex && fs.map(f => (
                  <button key={f.id} type="button" role="menuitemcheckbox" aria-checked={isShown(f)} className="fs-fac" onClick={() => toggleFac(f)} title={f.name}>
                    {box(isShown(f))}<span className="fs-dot" style={{ background: f.color }}/><span className="fs-t">{f.name}</span>
                  </button>))}
              </div>); })}
        </div>))}
      {isAdmin && <button type="button" className="fs-allv" onClick={() => { setVenue(ALL_VENUES); setOpen(false); }}>Show every vendor &amp; location</button>}
    </div>);

  const openMenu = () => { if (!open) setExp(shownKeys[0] || null); setOpen(!open); };
  return (
    <div className={`fstrip${isMobile ? " phone" : ""}`}>
      <style>{STYLE}</style>
      <div className="fs-chips">
        <button type="button" className={`fs-chip${selFac === "all" ? " on" : ""}`} onClick={() => setSelFac("all")}>All</button>
        {facs.map(f => { const on = selFac === f.id; return (
          <button key={f.id} type="button" className={`fs-chip${on ? " on" : ""}`} onClick={() => setSelFac(on ? "all" : f.id)} title={f.name}
            style={on ? { background: f.color, borderColor: f.color } : undefined}>
            <span className="fs-dot" style={{ background: on ? "#fff" : f.color }}/><span className="fs-t">{f.name}</span>
          </button>); })}
      </div>
      <div className="fs-tools" ref={ref}>
        <button type="button" className="fs-btn" aria-haspopup="menu" aria-expanded={open} onClick={openMenu} title="Add or remove fields and locations">📍 Fields ▾</button>
        {!isDefault && <button type="button" className="fs-btn ghost" onClick={reset} title="Back to the Cornwall Park facilities">↺ Reset</button>}
        {menu}
      </div>
    </div>
  );
}
