// Google Drive integration — browser-side via the GIS token client.
//
// Reuses the same Google Cloud OAuth client that backs Supabase Google sign-in
// (VITE_GOOGLE_CLIENT_ID). Scope is drive.file only: the app can see and manage
// just the files/folders it created — never the rest of the Drive. Tokens are
// short-lived and kept in memory; after the first consent, re-issue is silent
// while the admin's Google session is alive.
//
// The whole feature is config-gated: without VITE_GOOGLE_CLIENT_ID nothing
// loads, renders, or runs (driveConfigured() === false).

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_ROOT_FOLDER = "AMUA Billing";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export function driveConfigured() { return !!CLIENT_ID; }

// Remembered across sessions only as a hint: whether this browser has completed
// the Drive consent before (decides silent vs consent prompt — Google still
// enforces the real grant server-side).
function grantedBefore() { try { return localStorage.getItem("fb_drive_connected") === "1"; } catch { return false; } }

let _gisLoading = null;
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (_gisLoading) return _gisLoading;
  _gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _gisLoading = null; reject(new Error("Failed to load Google Identity Services")); };
    document.head.appendChild(s);
  });
  return _gisLoading;
}

let _token = null; // { value, expiresAt }
function tokenValid() { return _token && Date.now() < _token.expiresAt - 60_000; }

// Acquire a Drive access token. interactive=false fails fast when this browser
// has never granted Drive (so background paths never pop consent unexpectedly).
export async function getDriveToken({ interactive = true } = {}) {
  if (!CLIENT_ID) throw new Error("Drive not configured (VITE_GOOGLE_CLIENT_ID missing)");
  if (tokenValid()) return _token.value;
  if (!interactive && !grantedBefore()) throw new Error("Drive not connected yet");
  await loadGis();
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPE,
        callback: (resp) => {
          if (resp.error) { done(reject, new Error(resp.error_description || resp.error)); return; }
          _token = { value: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in || 3600) * 1000 };
          try { localStorage.setItem("fb_drive_connected", "1"); } catch { /* ignore */ }
          done(resolve, _token.value);
        },
        error_callback: (err) => done(reject, new Error(err?.message || err?.type || "Drive authorisation failed")),
      });
      client.requestAccessToken({ prompt: grantedBefore() ? "" : "consent" });
    } catch (e) { done(reject, e); }
  });
}

export function disconnectDrive() {
  const tok = _token?.value;
  _token = null;
  try { localStorage.removeItem("fb_drive_connected"); } catch { /* ignore */ }
  if (tok && window.google?.accounts?.oauth2?.revoke) {
    try { window.google.accounts.oauth2.revoke(tok, () => {}); } catch { /* ignore */ }
  }
}

// ─── Drive REST helpers (plain fetch, v3) ─────────────────────────────────────
async function driveFetch(path, { method = "GET", headers = {}, body, query } = {}) {
  const token = await getDriveToken();
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const r = await fetch(`https://www.googleapis.com/drive/v3/${path}${qs}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...headers }, body,
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Drive ${method} ${path} → ${r.status}${txt ? ` · ${txt.slice(0, 240)}` : ""}`);
  }
  return r.status === 204 ? null : r.json();
}

const escQ = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

async function findChild(name, parentId, { folder = false } = {}) {
  const mimeClause = folder ? ` and mimeType='${FOLDER_MIME}'` : ` and mimeType!='${FOLDER_MIME}'`;
  const data = await driveFetch("files", { query: {
    q: `name='${escQ(name)}' and '${escQ(parentId)}' in parents and trashed=false${mimeClause}`,
    fields: "files(id,name,webViewLink)",
    pageSize: "5",
  }});
  return data.files?.[0] || null;
}

export async function findChildFile(name, parentId) { return findChild(name, parentId, { folder: false }); }

async function createFolder(name, parentId) {
  return driveFetch("files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    query: { fields: "id,name,webViewLink" },
    body: JSON.stringify({ name, parents: [parentId], mimeType: FOLDER_MIME }),
  });
}

export async function ensureFolder(name, parentId) {
  return (await findChild(name, parentId, { folder: true })) || createFolder(name, parentId);
}

// Walk/create a folder chain from My Drive root; returns the final folder.
export async function ensureFolderPath(names) {
  let parent = "root", out = null;
  for (const name of names) {
    out = await ensureFolder(name, parent);
    parent = out.id;
  }
  return out;
}

// Create (POST) or update-in-place (PATCH, preserving revision history) via
// multipart upload. Updating the same fileId is what gives Drive versioning.
export async function uploadFile({ name, parentId, blob, mimeType, fileId = null }) {
  const token = await getDriveToken();
  const meta = fileId ? { name } : { name, parents: [parentId] };
  const boundary = "fb" + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ], { type: `multipart/related; boundary=${boundary}` });
  const url = `https://www.googleapis.com/upload/drive/v3/files${fileId ? `/${fileId}` : ""}?uploadType=multipart&fields=id,name,webViewLink`;
  const r = await fetch(url, { method: fileId ? "PATCH" : "POST", headers: { Authorization: `Bearer ${token}` }, body });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Drive upload → ${r.status}${txt ? ` · ${txt.slice(0, 240)}` : ""}`);
  }
  return r.json();
}

// Pin the newest revision so Drive never auto-purges the finalised binary
// (Drive may drop old non-Docs revisions after 30 days / 100 revisions).
export async function keepLatestRevisionForever(fileId) {
  const data = await driveFetch(`files/${fileId}/revisions`, { query: { fields: "revisions(id)" } });
  const last = data.revisions?.[data.revisions.length - 1];
  if (!last) return;
  await driveFetch(`files/${fileId}/revisions/${last.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keepForever: true }),
  });
}

export async function driveAbout() {
  return driveFetch("about", { query: { fields: "user(displayName,emailAddress)" } });
}

// Fetch a Drive file's bytes and trigger a browser download.
export async function downloadDriveFile(fileId, filename) {
  const token = await getDriveToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drive download → ${r.status}`);
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename || "download";
  a.click();
  URL.revokeObjectURL(url);
}

// End-to-end diagnostic: token → who am I → create + delete a temp folder.
// Surfaces the exact failing step so misconfig is identifiable in one click.
export async function testDriveConnection() {
  const about = await driveAbout();
  const tmp = await createFolder(`FacilityBook connection test ${Date.now()}`, "root");
  await driveFetch(`files/${tmp.id}`, { method: "DELETE" });
  return { ok: true, email: about?.user?.emailAddress || "(unknown account)" };
}
