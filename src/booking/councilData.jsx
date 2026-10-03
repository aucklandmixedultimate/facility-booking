import { parseCouncilApp } from "./core.jsx";
export function mergeCouncilOutcomes(prev, parsed) {
  const next = JSON.parse(JSON.stringify(prev || {})), changed = new Set();
  for (const m of parsed) for (const [id, a] of Object.entries(m.apps)) {
    const o = next[id] ||= { id, outcome: "info", history: [] };
    if ((o.history ||= []).some(h => h.msgId === m.msgId)) continue;
    o.history.push({ msgId: m.msgId, date: m.date, outcome: a.outcome, subject: m.subject });
    ["park", "fields", "start", "end"].forEach(k => { if (a[k]) o[k] = a[k]; });
    if (m.coordinator?.email) o.coordinator = m.coordinator;
    o.threadId = m.threadId; o.subject = m.subject; o.date ||= m.date;
    // The newest real outcome wins (emails arrive oldest first), unless AMUA set it by hand.
    if (a.outcome !== "info" && !o.manual && (!o.outcomeAt || m.date >= o.outcomeAt)) {
      o.outcome = a.outcome; o.outcomeAt = m.date;
      o.reason = a.outcome === "declined" ? (m.reason || o.reason || "") : "";
    }
    changed.add(id);
  }
  return { next, changed: [...changed] };
}
export const councilAppBookings = (bookings, id) => bookings.filter(b => (parseCouncilApp(b.system_notes)?.id || "").toLowerCase() === String(id).toLowerCase());