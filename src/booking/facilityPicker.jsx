// The booking form's facility picker: one dropdown, vendor › location › field, like the
// calendars' 📍 Fields menu. For a new booking it picks several fields at once, or a whole
// location or vendor, but only fields free at the slot's date and time; a field that isn't
// free is listed under its location with what it clashes with. Editing a booking picks one.
import { useEffect, useRef, useState } from "react";
import { FACILITIES, T, bookableVenues, fmtTime, getSameFacilityOverlaps, isAdminBooking, providerLabel } from "./core.jsx";
import { isClosed } from "../statuses.js";

const STYLE = `
.fp{position:relative}
.fp-btn{width:100%;display:flex;align-items:center;gap:6px;text-align:left;padding:9px 12px;border-radius:var(--r-md);border:1.5px solid var(--c-line);background:var(--c-surface-2);color:var(--c-ink);font:14px/1.3 inherit;cursor:pointer}
.fp-btn .fp-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fp-menu{position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:1300;max-height:min(60vh,460px);overflow-y:auto;background:var(--c-surface);border:1px solid var(--c-line);border-radius:var(--r-lg);box-shadow:0 8px 24px rgba(0,0,0,.14)}
.fp-vh{display:flex;align-items:center;gap:8px;padding:8px 12px 4px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--c-muted)}
.fp-row{display:flex;align-items:center;gap:8px;width:100%;border:0;background:none;padding:7px 12px;font:13px/1.3 inherit;color:var(--c-ink);text-align:left;cursor:pointer}
.fp-row:hover:not(:disabled){background:var(--c-surface-2)}
.fp-row:disabled{cursor:not-allowed;color:var(--c-faint)}
.fp-row.fac{padding-left:34px}
.fp-row.cur{font-weight:700}
.fp-n{margin-left:auto;color:var(--c-muted);font-size:11px;white-space:nowrap}
.fp-why{display:block;font-size:11px;color:var(--c-danger)}
.fp-box{width:16px;height:16px;flex:none;border-radius:4px;border:1.5px solid var(--c-faint);display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#fff}
.fp-box.on{background:var(--c-ink);border-color:var(--c-ink)}
.fp-box.part{background:var(--c-muted);border-color:var(--c-muted)}
.fp-foot{position:sticky;bottom:0;display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:8px 12px;border-top:1px solid var(--c-line);background:var(--c-surface)}
.fp-go{padding:6px 14px;border-radius:var(--r-md);border:0;background:var(--c-ink);color:#fff;font:700 13px/1.2 inherit;cursor:pointer}
.fp-go:disabled{opacity:.4;cursor:not-allowed}
`;

// Why a field can't be booked for this slot, or null when it's free.
function clashReason(f, slot, others) {
  const c = getSameFacilityOverlaps({ facility_id: f.id, date: slot.date, start_hour: slot.start_hour, duration: slot.duration }, others)[0];
  if (!c) return null;
  const when = `${fmtTime(c.start_hour)}–${fmtTime(c.start_hour + c.duration)}`;
  return isAdminBooking(c) ? `Vendor block ${when}${c.purpose ? `: ${c.purpose}` : ""}` : `Booked ${when}${c.name ? ` by ${c.name}` : ""}`;
}

export function FacilityPicker({ value, slot, allBookings = [], multi = false, onPick, onPickMany }) {
  const [open, setOpen] = useState(false), [exp, setExp] = useState(null), [ticked, setTicked] = useState(() => new Set()), ref = useRef(null);
  useEffect(() => { if (!open) return;
    const off = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = e => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("touchstart", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("touchstart", off); document.removeEventListener("keydown", esc); }; }, [open]);

  const venues = bookableVenues(value);
  const cur = FACILITIES.find(f => f.id === value);
  const ready = !!(slot?.date && slot?.duration);
  const others = ready ? allBookings.filter(b => b.id !== slot.id && !isClosed(b.status)) : [];
  const why = f => ready ? clashReason(f, slot, others) : null;
  const free = fs => fs.filter(f => !why(f));
  const pids = [...new Set(venues.map(v => v.pid))];

  const toggle = ids => setTicked(prev => { const n = new Set(prev), all = ids.every(id => n.has(id)); ids.forEach(id => all ? n.delete(id) : n.add(id)); return n; });
  const box = (ids) => { const k = ids.filter(id => ticked.has(id)).length;
    return <span aria-hidden className={`fp-box${k ? " on" : ""}${k && k < ids.length ? " part" : ""}`}>{k ? (k < ids.length ? "–" : "✓") : ""}</span>; };
  const pick = f => { if (multi) toggle([f.id]); else { onPick(f.id); setOpen(false); } };
  const done = () => { const ids = [...ticked]; if (!ids.length) return; onPickMany(ids); setTicked(new Set()); setOpen(false); };
  const openMenu = () => { if (!open) { setExp(cur ? venues.find(v => v.facs.some(f => f.id === cur.id))?.key || null : null); setTicked(multi && cur && !why(cur) ? new Set([cur.id]) : new Set()); } setOpen(!open); };

  const label = cur ? `${providerLabel(cur.provider || "gtec")} › ${venues.find(v => v.facs.some(f => f.id === cur.id))?.site || cur.site || ""} › ${cur.name}` : "Choose a field";
  return (
    <div className="fp" ref={ref}>
      <style>{STYLE}</style>
      <button type="button" className="fp-btn" aria-haspopup="menu" aria-expanded={open} onClick={openMenu} title={label}>
        <span>📍</span><span className="fp-t">{label}</span><span>▾</span>
      </button>
      {open && (
        <div className="fp-menu" role="menu">
          {pids.map(pid => { const vs = venues.filter(v => v.pid === pid), vFree = vs.flatMap(v => free(v.facs)).map(f => f.id);
            return (
              <div key={pid}>
                {multi && vFree.length > 1
                  ? <button type="button" className="fp-row fp-vh" onClick={() => toggle(vFree)} title={`Every free field at ${providerLabel(pid)}`}>{box(vFree)}{providerLabel(pid)}<span className="fp-n">{vFree.length} free</span></button>
                  : <div className="fp-vh">{providerLabel(pid)}</div>}
                {vs.map(v => { const fs = v.facs, fr = free(fs).map(f => f.id), ex = exp === v.key;
                  return (
                    <div key={v.key}>
                      <button type="button" className="fp-row" aria-expanded={ex}
                        onClick={() => { if (multi && fr.length) toggle(fr); setExp(ex && !multi ? null : v.key); }}
                        title={multi ? `Every free field at ${v.site}` : `Fields at ${v.site}`}>
                        {multi && box(fr)}<b>📍 {v.site}</b><span className="fp-n">{ready ? `${fr.length}/${fs.length} free` : fs.length} {ex ? "▾" : "▸"}</span>
                      </button>
                      {ex && fs.map(f => { const w = why(f), isCur = f.id === value;
                        return (
                          <button key={f.id} type="button" role={multi ? "menuitemcheckbox" : "menuitem"} aria-checked={multi ? ticked.has(f.id) : undefined}
                            className={`fp-row fac${isCur ? " cur" : ""}`} disabled={!!w && !isCur} onClick={() => pick(f)} title={w || f.name}>
                            {multi && box([f.id])}<span style={{ width: 8, height: 8, borderRadius: "50%", background: f.color, flex: "none" }}/>
                            <span>{f.name}{w && <span className="fp-why">✕ {w}</span>}</span>
                          </button>); })}
                    </div>); })}
              </div>); })}
          {multi && (
            <div className="fp-foot">
              <span style={{ fontSize: 12, color: T.muted }}>{ready ? "Only fields free at this time can be ticked." : "Set the date and time to see what's free."}</span>
              <button type="button" className="fp-go" disabled={!ticked.size} onClick={done}>Use {ticked.size || ""} field{ticked.size === 1 ? "" : "s"}</button>
            </div>)}
        </div>)}
    </div>
  );
}
