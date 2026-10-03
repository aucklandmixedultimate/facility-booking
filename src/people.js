// How people are named across both apps. People are often tagged without being asked, so only
// a first name and last initial is ever shown or kept: "Clare Gibson" → "Clare G.".
export const shortName = s => { const w = String(s || "").trim().split(/\s+/).filter(Boolean);
  return w.length < 2 ? (w[0] || "") : `${w[0]} ${w[w.length - 1][0].toUpperCase()}.`; };
// An account's email as a name: "rory.hughes@…" → "Rory H.", "auultimateclub@…" → "Auultimateclub".
export const personFromEmail = email => {
  const w = String(email || "").split("@")[0].split(/[._\-+]+/).filter(Boolean).map(x => x[0].toUpperCase() + x.slice(1));
  return shortName(w.join(" ")) || "Someone";
};
// Two-letter initials for tight spaces: "pirates.team" → "PT", "auultimateclub" → "AU".
export function initialsOf(name) {
  const w = String(name || "").split(/[\s._@-]+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : (w[0] || "?").slice(0, 2)).toUpperCase();
}
