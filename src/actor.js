// Who's using a login: a booker's Google account is often shared by a few people, so after
// sign-in each person picks (or types) their name — first name and last initial only, e.g.
// "Rory H." — and their actions are stamped with it. The last 5 names are kept on the account
// (Supabase user metadata, so every device sees them) and can be edited from the profile menu.
// Plain DOM so the booking site (React) and the Council fields page share it.
const MAX = 5;
const curKey = email => "amua-actor:" + String(email || "").toLowerCase();
const listKey = email => "amua-actors:" + String(email || "").toLowerCase();
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const cap = s => s ? s[0].toUpperCase() + s.slice(1) : "";
export const actorName = (first, initial) => {
  const f = String(first || "").trim().split(/\s+/)[0] || "", i = String(initial || "").trim().replace(/[^a-z]/gi, "")[0] || "";
  return f && i ? `${cap(f)} ${i.toUpperCase()}.` : "";
};
const splitName = n => { const m = /^(\S+)\s+([A-Za-z])\.?$/.exec(String(n || "").trim()); return m ? [m[1], m[2]] : [String(n || "").trim(), ""]; };

// Someone who doesn't want to give a name: their actions are stamped "Guest".
export const GUEST = "Guest";
export const getActor = email => email ? ls.get(curKey(email)) || "" : "";
export function setActor(email, name) { ls.set(curKey(email), name || null); window.dispatchEvent(new CustomEvent("amua-actor", { detail: name || "" })); }
export const clearActor = email => setActor(email, "");

export function recentActors(user) {
  const meta = user?.user_metadata?.actors;
  if (Array.isArray(meta)) return meta.filter(n => typeof n === "string" && n).slice(0, MAX);
  try { return JSON.parse(ls.get(listKey(user?.email)) || "[]").slice(0, MAX); } catch { return []; }
}
async function saveRecents(supabase, user, list) {
  list = [...new Set(list.filter(Boolean))].slice(0, MAX);
  ls.set(listKey(user?.email), JSON.stringify(list));
  if (user) user.user_metadata = { ...(user.user_metadata || {}), actors: list };
  try { await supabase?.auth.updateUser({ data: { actors: list } }); } catch { /* kept on this device */ }
  return list;
}

const CSS = `.actor-ov{position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.actor-ov button,.actor-ov input{font-family:inherit}
.actor-box{background:#fff;color:#0f172a;border-radius:14px;box-shadow:0 12px 40px rgba(15,23,42,.3);padding:20px;width:100%;max-width:380px;font-size:14px}
.actor-box h3{margin:0 0 4px;font-size:19px}.actor-box p{margin:0 0 14px;color:#64748b;font-size:13px;line-height:1.4}
.actor-recent{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.actor-chip{display:inline-flex;align-items:center;border:1.5px solid #c7d2fe;background:#eef2ff;border-radius:999px;overflow:hidden}
.actor-chip.cur{border-color:#6366f1;background:#e0e7ff}
.actor-chip button{border:0;background:none;font:inherit;cursor:pointer;color:#3730a3;padding:5px 4px}
.actor-chip .pick{font-weight:700;padding-left:11px}.actor-chip.guest{border-color:#e2e8f0;background:#f8fafc}.actor-chip.guest .pick{color:#475569;padding-right:11px}.actor-chip .x{color:#94a3b8;padding-right:9px}.actor-chip .x:hover,.actor-chip .ed:hover{color:#0f172a}
.actor-k{font-size:11px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;margin:0 0 6px}
.actor-row{display:flex;gap:8px;margin:0 0 6px}.actor-row label{display:flex;flex-direction:column;gap:3px;font-size:12px;font-weight:600;color:#475569}
.actor-row label:first-child{flex:1}.actor-row input{font:inherit;padding:8px 10px;border:1.5px solid #cbd5e1;border-radius:8px;width:100%;box-sizing:border-box}
.actor-row input.ini{width:64px;text-align:center;text-transform:uppercase}
.actor-err{color:#b91c1c;font-size:12px;min-height:16px;margin:0 0 8px}
.actor-acts{display:flex;justify-content:flex-end;gap:8px}
.actor-acts button{font:inherit;font-weight:700;border-radius:8px;padding:8px 14px;cursor:pointer;border:1.5px solid #e2e8f0;background:#fff;color:#475569}
.actor-acts .go{background:#6366f1;border-color:#6366f1;color:#fff}`;
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Ask who's using the login. edit: opened from the profile menu (can be cancelled; names can
// be renamed ✎ or removed ✕). Resolves with the chosen name, or null when cancelled / signed out.
export function askActor({ supabase, user, edit = false, onSignOut } = {}) {
  if (!document.getElementById("actor-css")) { const st = document.createElement("style"); st.id = "actor-css"; st.textContent = CSS; document.head.appendChild(st); }
  document.querySelector(".actor-ov")?.remove();
  const email = user?.email || "";
  let list = recentActors(user), renaming = null;
  const ov = document.createElement("div"); ov.className = "actor-ov";
  ov.innerHTML = `<form class="actor-box" role="dialog" aria-modal="true" aria-labelledby="actorTitle" novalidate>
      <h3 id="actorTitle">${edit ? "Who's using this login?" : "Who's signing in?"}</h3>
      <p>${esc(email)} can be shared, so pick your name and what you do is linked to you. First name and last initial only.</p>
      <div class="actor-k" data-recent-k>Recent</div><div class="actor-recent"></div>
      <div class="actor-k" data-new-k>New name</div>
      <div class="actor-row"><label>First name<input name="first" autocomplete="given-name" required maxlength="30"></label>
        <label>Last initial<input name="ini" class="ini" required maxlength="1" pattern="[A-Za-z]" autocomplete="off"></label></div>
      <div class="actor-err" aria-live="polite"></div>
      <div class="actor-acts">${edit ? `<button type="button" data-cancel>Cancel</button>` : onSignOut ? `<button type="button" data-out>Sign out</button>` : ""}<button class="go" type="submit">Continue</button></div>
    </form>`;
  document.body.appendChild(ov);
  const f = ov.querySelector("form"), first = f.first, ini = f.ini, err = ov.querySelector(".actor-err");
  const cur = getActor(email);
  const draw = () => {
    ov.querySelector(".actor-recent").innerHTML = list.map((n, i) => `<span class="actor-chip${n === cur ? " cur" : ""}"><button type="button" class="pick" data-i="${i}" title="Continue as ${esc(n)}">${esc(n)}</button>`
      + `<button type="button" class="ed" data-ed="${i}" title="Rename">✎</button><button type="button" class="x" data-x="${i}" title="Remove">✕</button></span>`).join("")
      + `<span class="actor-chip guest${cur === GUEST ? " cur" : ""}"><button type="button" class="pick" data-guest title="Continue without a name">👤 ${GUEST}</button></span>`;
    ov.querySelector("[data-recent-k]").textContent = list.length ? "Recent" : "Continue as";
    ov.querySelector("[data-new-k]").textContent = renaming != null ? `Rename ${list[renaming]}` : list.length ? "Or a new name" : "Or your name";
  };
  draw();
  ini.addEventListener("input", () => { ini.value = ini.value.replace(/[^a-z]/gi, "").slice(0, 1).toUpperCase(); });
  first.addEventListener("input", () => { if (/\s/.test(first.value)) { const [a, b] = first.value.trim().split(/\s+/); first.value = a || ""; if (b) { ini.value = b[0].toUpperCase(); } ini.focus(); } });
  setTimeout(() => (list.length ? ov.querySelector(".pick") : first)?.focus(), 0);
  return new Promise(resolve => {
    const done = async name => {
      if (name === GUEST) setActor(email, name);   // not kept among the recent names
      else if (name) {
        list = await saveRecents(supabase, user, [name, ...list.filter(n => n !== name)]);
        setActor(email, name);
      }
      ov.remove(); resolve(name);
    };
    ov.addEventListener("click", async e => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.guest != null) done(GUEST);
      else if (b.dataset.i != null) done(list[+b.dataset.i]);
      else if (b.dataset.ed != null) { renaming = +b.dataset.ed; [first.value, ini.value] = splitName(list[renaming]); draw(); first.focus(); }
      else if (b.dataset.x != null) {
        const gone = list[+b.dataset.x]; list = await saveRecents(supabase, user, list.filter((_, i) => i !== +b.dataset.x));
        if (gone === getActor(email) && edit) clearActor(email);
        if (renaming != null) renaming = null;
        draw();
      }
      else if (b.dataset.cancel != null) { ov.remove(); resolve(null); }
      else if (b.dataset.out != null) { ov.remove(); resolve(null); onSignOut?.(); }
    });
    f.addEventListener("submit", async e => {
      e.preventDefault();
      if (!first.value.trim()) { err.textContent = "Your first name is required."; first.focus(); return; }
      if (!/^[a-z]$/i.test(ini.value)) { err.textContent = "Your last initial is required (one letter)."; ini.focus(); return; }
      const name = actorName(first.value, ini.value);
      if (renaming != null) {
        const old = list[renaming]; list = list.map((n, i) => i === renaming ? name : n).filter((n, i, a) => a.indexOf(n) === i);
        if (old === getActor(email)) setActor(email, name);
        list = await saveRecents(supabase, user, list); renaming = null; first.value = ini.value = ""; err.textContent = ""; draw();
        return;
      }
      done(name);
    });
  });
}
