// Council email sync: reads Auckland Council's replies about AMUA's field applications from
// the AMUA Gmail (read-only), and turns each into an outcome per application number.
//
// Sign-in: Google Identity Services in the browser (OAuth client "AMUA Facility Booking",
// scope gmail.readonly). The admin signs in with the AMUA account when pressing Sync; the
// token lives only in memory for about an hour. The client ID is public, not a secret.
//
// What the council sends (from the parks booking coordinator, subject "Application # <id>",
// a table of APP # / PARK / FIELDS / START DATE / END DATE):
//   - an offer that needs AMUA's answer: "I have been provided approval to complete bookings
//     … Can you please confirm you are requesting use of all parks?"
//   - a decline: "your request for <park> on application <id> has been declined", often with
//     a reason (spring renovation, allocated to cricket) and suggestions;
//   - a confirmation once the booking is made (booking confirmed / permit / invoice).

export const GOOGLE_CLIENT_ID = "812224293255-g0rst80pg5f072im787g50h54euq67ig.apps.googleusercontent.com";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

let gisReady = null, token = null, tokenExp = 0;
function loadGis() {
  if (gisReady) return gisReady;
  gisReady = new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client"; s.async = true;
    s.onload = () => res(); s.onerror = () => { gisReady = null; rej(new Error("Couldn't load Google sign-in")); };
    document.head.appendChild(s);
  });
  return gisReady;
}
// A Gmail read-only token, asking the admin to sign in (with the AMUA account) when needed.
export async function gmailToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  await loadGis();
  return new Promise((res, rej) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: SCOPE, hint: "aucklandmixedultimate@gmail.com",
      callback: r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return rej(new Error("Gmail read access wasn't granted"));
        token = r.access_token; tokenExp = Date.now() + (r.expires_in || 3600) * 1000; res(token);
      },
      error_callback: e => rej(new Error(e?.message || e?.type || "Google sign-in was closed")),
    });
    client.requestAccessToken({ prompt: token ? "" : "consent" });
  });
}

async function gget(path, tok) {
  const r = await fetch(`${GMAIL}/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
  return r.json();
}
const b64 = s => { try { return decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))); } catch { return ""; } };
function bodyOf(payload) {
  let plain = "", html = "";
  (function walk(p) {
    if (!p) return;
    if (p.mimeType === "text/plain" && p.body?.data) plain += b64(p.body.data) + "\n";
    else if (p.mimeType === "text/html" && p.body?.data) html += b64(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  if (plain.trim()) return plain;
  return html.replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}
const header = (m, name) => (m.payload?.headers || []).find(h => h.name.toLowerCase() === name)?.value || "";

// Council emails about applications (including ones forwarded to AMUA), newest first.
export async function fetchCouncilEmails(tok, { days = 400, max = 60 } = {}) {
  const q = encodeURIComponent(`aucklandcouncil.govt.nz (subject:application OR "application #") newer_than:${days}d`);
  const list = await gget(`messages?q=${q}&maxResults=${max}`, tok);
  const out = [];
  for (const { id } of list.messages || []) {
    const m = await gget(`messages/${id}?format=full`, tok);
    out.push({ id, threadId: m.threadId, subject: header(m, "subject"), from: header(m, "from"), date: new Date(+m.internalDate).toISOString(), body: bodyOf(m.payload) });
  }
  return out;
}

// ── Parsing ───────────────────────────────────────────────────────────────────
const APP_RE = /\b[0-9a-f]{8}\b/gi;
// The newest message only: drop quoted replies ("> …", "On … wrote:", Outlook "From: … Sent:").
function topMessage(body) {
  let t = body.replace(/\r/g, "");
  const fwd = t.search(/-{5,}\s*Forwarded message\s*-{5,}/i);
  if (fwd >= 0) t = t.slice(fwd);
  const lines = t.split("\n"), out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) break;
    if (/^On .{6,120}wrote:\s*$/.test(l.trim()) || (/^\*?From:\*?/.test(l.trim()) && /^\*?Sent:\*?/.test((lines[i + 1] || "").trim()))) break;
    out.push(l);
  }
  return out.join("\n");
}
// The forwarded (original) sender and date, when AMUA was forwarded the email.
function original(t) {
  const from = t.match(/From:\s*([^<\n]*?)\s*<([^>\n]+@aucklandcouncil\.govt\.nz)>/i);
  const date = t.match(/Date:\s*([^\n]+)/i);
  return { name: from?.[1]?.trim() || "", email: from?.[2]?.trim() || "", date: date ? new Date(date[1].replace(/ at /, " ")) : null };
}
const sentences = t => t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
function classify(text) {
  if (/\bdeclin(e|ed|ing)\b|unable to accommodate|not able to accommodate/i.test(text)) return "declined";
  if (/(booking|permit|reservation)s?\s+(has|have)\s+been\s+(confirmed|completed|made|processed)|confirm(ed|ation)\s+of\s+(your\s+)?booking|please find (attached )?your (permit|booking)|bookings? (are|is) now confirmed/i.test(text)) return "confirmed";
  if (/approval to complete bookings?|can you (please )?confirm|please confirm|did you have a preference|let me know and i can complete/i.test(text)) return "action";
  return "info";
}
// One email → { msgId, date, subject, coordinator, outcome, reason, apps: {id: {outcome, park, fields, start, end}} }
export function parseCouncilEmail(mail) {
  const top = topMessage(mail.body || ""), orig = original(top);
  const fromHdr = mail.from.match(/<([^>]+)>/)?.[1] || mail.from;
  const coordinator = orig.email ? { name: orig.name, email: orig.email }
    : /aucklandcouncil\.govt\.nz/i.test(fromHdr) ? { name: mail.from.replace(/<.*>/, "").replace(/"/g, "").trim(), email: fromHdr } : null;
  const ids = [...new Set([...(mail.subject.match(APP_RE) || []), ...(top.match(/(?:app(?:lication)?\s*#?\s*)([0-9a-f]{8})/gi) || []).map(s => s.slice(-8))].map(s => s.toLowerCase()))];
  const outcome = classify(top);
  // The table: an app id on its own line, then park, fields, start date, end date.
  const lines = top.split("\n").map(l => l.replace(/\*/g, "").trim()).filter(Boolean);
  const apps = {};
  for (let i = 0; i < lines.length; i++) {
    const id = lines[i].match(/^([0-9a-f]{8})$/i)?.[1]?.toLowerCase(); if (!id) continue;
    apps[id] = { park: lines[i + 1] || "", fields: lines[i + 2] || "", start: lines[i + 3] || "", end: lines[i + 4] || "" };
    if (!ids.includes(id)) ids.push(id);
  }
  // No table (e.g. a decline): "your request for <park> on application <id>".
  for (const m of top.replace(/\s+/g, " ").matchAll(/request for (?:the )?(.{3,60}?) (?:on|under|for) application #?\s*([0-9a-f]{8})/gi)) {
    const id = m[2].toLowerCase(); (apps[id] ||= {}); if (!apps[id].park) apps[id].park = m[1].trim();
    if (!ids.includes(id)) ids.push(id);
  }
  // Per application: a sentence naming it decides; otherwise the email's overall outcome.
  const ss = sentences(top);
  ids.forEach(id => {
    const mine = ss.filter(s => s.toLowerCase().includes(id)).join(" ");
    (apps[id] ||= {}).outcome = mine && /declin/i.test(mine) ? "declined" : outcome;
  });
  // "Also as has the application <id>…" follows a decline: carry it.
  ss.forEach((s, k) => { if (/also/i.test(s) && /declin/i.test(ss[k - 1] || "")) (s.match(APP_RE) || []).forEach(id => { if (apps[id.toLowerCase()]) apps[id.toLowerCase()].outcome = "declined"; }); });
  const reason = ss.find(s => /renovation|allocated|unable to|not available|unavailable|rest and recovery|season/i.test(s)) || "";
  return { msgId: mail.id, threadId: mail.threadId, date: (orig.date && !isNaN(orig.date) ? orig.date : new Date(mail.date)).toISOString(), received: mail.date,
    subject: mail.subject.replace(/^(fwd?|re):\s*/i, ""), coordinator, outcome, reason: reason.slice(0, 300), apps };
}
