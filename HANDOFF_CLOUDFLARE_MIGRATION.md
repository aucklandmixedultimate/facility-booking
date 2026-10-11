# Handoff: Move to a private, org-owned repo on Cloudflare Pages

Status: **SPEC ONLY — not started.** No code has been changed. This document is the
plan; an agent picking it up should execute the stages in order and tick the boxes.

## TL;DR

- The repo is **public** and the app is served from **GitHub Pages**. Making the repo
  private on the current free personal account would **take the live site down**, because
  Pages only serves from private repos on a paid plan.
- End state: repo **private**, owned by a **GitHub organisation**, built and served by
  **Cloudflare Pages** (free for private repos) on a **custom domain**, with a small
  public **redirect stub** keeping the old bookmarked URL alive.
- Cost: **$0/month** plus the domain registration.
- The ordering below is not arbitrary. **Cloudflare must be live before the repo goes
  private**, or there is a window with no working site.

---

## Decisions already made

These were settled before this spec was written. Don't reopen them without the owner.

| Question | Decision | Why |
|---|---|---|
| Stay on GitHub Pages and pay for Pro? | **No** | $4/mo forever to solve a problem Cloudflare solves free. |
| Transfer to an org, or convert the user account into an org? | **Transfer** | Conversion retains the namespace but unlinks ~50 commits and all PR comments to the ghost user, uninstalls all GitHub Apps, and is irreversible. |
| Keep the `github.io` URL? | **No — redirect stub instead** | Repo transfers redirect web/git URLs but **not** Pages URLs. A stub at the old path is the accepted workaround. |
| Custom domain now or later? | **Now** | It is the only address that survives this move and any future one, and it is the only origin Google will let you domain-verify. |

### Accepted trade-off

Creating the stub repo at the old path **breaks the automatic redirect** on
`github.com/aucklandmixedultimate/facility-booking`, because that path is then occupied
by the stub rather than forwarding to the org. This is deliberate: the Pages URL is the
one real users have bookmarked. Put a one-line README in the stub saying where the
source moved.

### What this migration does *not* fix

The repo has been public since 2026-03-04. Privatising is **not retroactive** — the DB
schema, all 19 RLS policies, the Supabase project ref and the full business logic have
been readable for months. Exposure looks low in practice (0 forks, 0 stars, 0 watchers),
and no credentials were ever committed, but **RLS remains the only real control** over
the data, since the anon key ships in the client bundle by design. Reviewing the RLS
policies is a separate workstream and is out of scope here.

---

## Current state (verified 2026-08-27)

| | |
|---|---|
| Repo | `aucklandmixedultimate/facility-booking` — **public**, owned by a personal account |
| Live URL | `https://aucklandmixedultimate.github.io/facility-booking/` |
| Build/deploy | `.github/workflows/deploy.yml` → builds Vite → pushes `dist/` to the `gh-pages` branch |
| Vite `base` | `/facility-booking/` (`vite.config.js`) |
| Node | 22 (set in the workflow) |
| Build secrets | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON` (required), `VITE_GOOGLE_CLIENT_ID` (optional) |
| Auth | Supabase Google OAuth; app calls `signInWithOAuth` with `redirectTo: window.location.origin + import.meta.env.BASE_URL` (`src/booking-system.jsx:1097`) |
| Drive export | Browser-side GIS `initTokenClient` (`src/drive-client.js:53`) — validates against **Authorized JavaScript origins** |
| Email | Server-side `send-email` Supabase Edge Function — no client keys, unaffected by this migration |

---

## Placeholders

Fill these in before starting; they appear throughout.

- `<ORG>` — the new GitHub organisation name. **`aucklandmixedultimate` is not
  available** (the personal account holds that namespace).
- `<DOMAIN>` — the custom domain, e.g. `bookings.amua.nz`.

---

## Stage 0 — Prerequisites

**Owner: human.** Nothing here can be done by an agent.

- [ ] Create a **free GitHub organisation** `<ORG>`. Free orgs give unlimited private repos.
- [ ] Add the committee members as org members with their **own personal accounts** —
      the point of the org is to stop sharing one login.
- [ ] Register `<DOMAIN>` and put its DNS on Cloudflare.
- [ ] Confirm you have admin on the repo (you do) and repo-create rights in `<ORG>`.

⚠️ **Branch protection on private repos is restricted on GitHub Free orgs.** If `main`
currently relies on protection rules, check whether they survive, and budget for Team
if they matter.

---

## Stage 1 — Transfer the repo to the org (stays public)

**Owner: human.** Settings → General → Danger Zone → Transfer ownership.

- [ ] Transfer `facility-booking` to `<ORG>`. **Do not change visibility yet.**
- [ ] Verify the three Actions secrets survived the transfer
      (Settings → Secrets and variables → Actions). Re-add any that didn't.
- [ ] Re-enable **Pages** on the new owner: source = *Deploy from branch* → `gh-pages`.
      Pages settings do not survive a transfer; the branch itself does.
- [ ] Install the **Claude GitHub App** on `<ORG>` — agent access is scoped to the owner
      and is lost at transfer.
- [ ] Locally: `git remote set-url origin https://github.com/<ORG>/facility-booking`

**Working state at end of stage:** app live at `https://<ORG>.github.io/facility-booking/`.
The old `aucklandmixedultimate.github.io` URL now 404s — this is expected and is fixed in
Stage 4.

---

## Stage 2 — Stand up Cloudflare Pages (old site still live)

**Owner: human** (dashboard work), with the agent available for build debugging.

- [ ] Install the **Cloudflare GitHub App** on `<ORG>` and create a Pages project against
      `<ORG>/facility-booking`.
- [ ] Build settings: production branch `main`, build command `npm run build`, output
      directory `dist`, Node version `22`.
- [ ] Add environment variables to **both** Production and Preview:
      `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON`, `VITE_GOOGLE_CLIENT_ID`.
- [ ] **Enable the preview access policy** — Settings → General → *Enable access policy*.
      Preview deployments are **public by default**, which would partly undo the point of
      privatising the repo. Note this protects previews only, not `*.pages.dev` or the
      custom domain.
- [ ] Let the agent push the Stage 3 code change **to a branch first** and confirm the
      preview build renders correctly before touching `main`.

**Working state at end of stage:** old GitHub Pages site still live and correct; a verified
Cloudflare preview build exists.

---

## Stage 3 — Cut over

**Owner: agent** for the code, **human** for the dashboards. Do the external config
*before* merging, so nothing is broken between the merge and the config change.

### External config (agent cannot do this)

Add the new values **alongside** the existing ones — every list below accepts multiple
entries, so there is no downtime. Remove the stale entries only in Stage 5.

- [ ] **Supabase → Auth → URL Configuration**: set Site URL to `https://<DOMAIN>` and add
      it to the Redirect URLs allowlist. *This is the one that breaks sign-in.* Without
      it Supabase rejects the app's `redirectTo` and falls back to the old Site URL, so
      users authenticate successfully and land on a dead address.
- [ ] **Google Cloud → OAuth client → Authorized JavaScript origins**: add
      `https://<DOMAIN>`. Required for the **Drive export only**. Missing this gives a
      confusing partial failure — sign-in works, Drive export dies with an origin error.
- [ ] **Cloudflare Pages → Custom domains**: attach `<DOMAIN>`.

> **Do not touch the Google *redirect URI*** — it is
> `https://bowfbamsjgozigcaygqq.supabase.co/auth/v1/callback` and points at Supabase, not
> at this app. Host changes never affect it.
>
> Register `<DOMAIN>` as the Google origin, **not** `*.pages.dev`. You cannot
> domain-verify `pages.dev` or `github.io` in Search Console, which is what gates
> publishing the consent screen out of testing mode.

### Code change (one commit)

`base` and `deploy.yml` must change **together**. Changing `base` alone while the workflow
is live would republish `gh-pages` with a root base and break the fallback site.

- [ ] `vite.config.js` — `base: '/facility-booking/'` → `base: '/'`.
      This also fixes `redirectTo`, which is derived from `BASE_URL`. Leaving it stale
      sends users to `https://<DOMAIN>/facility-booking/` after login, which 404s.
- [ ] Delete `.github/workflows/deploy.yml`.
- [ ] `package.json` — remove the `deploy` and `predeploy` scripts and the `gh-pages`
      devDependency.
- [ ] Delete `scripts/check-deploy-env.js` — it exists solely to guard the
      `gh-pages -d dist` path being removed. Cloudflare has no equivalent hole: its build
      always injects the dashboard env vars.
- [ ] Rewrite the **Deployment** section of `README.md` for Cloudflare (build command,
      output dir, where env vars live, preview access policy). Leave the Supabase Edge
      Function subsection alone.
- [ ] Merge to `main`.

**Working state at end of stage:** app live at `https://<DOMAIN>`.
`https://<ORG>.github.io/facility-booking/` keeps working as a fallback, serving the
frozen last-good `gh-pages` build, until Stage 5.

---

## Stage 4 — Redirect stub

**Owner: human** to create the repo; agent can write the file.

- [ ] On the **personal** account, create a new public repo named exactly
      `facility-booking` (the path is free now that the real repo has moved).
- [ ] Add an `index.html` with a meta-refresh plus a `<link rel="canonical">` to
      `https://<DOMAIN>`, and a `README.md` saying where the source moved.
- [ ] Enable Pages on it.
- [ ] Point the stub at **`<DOMAIN>`, not at `pages.dev`** — so it never needs editing
      again if the host changes.
- [ ] Verify `https://aucklandmixedultimate.github.io/facility-booking/` redirects.

---

## Stage 5 — Privatise and clean up

Do this only once Stage 3's verification checklist passes in full.

- [ ] **Human:** set the repo to **Private** (Settings → General → Danger Zone).
      `https://<ORG>.github.io/facility-booking/` dies here — expected, it has been
      replaced.
- [ ] **Agent:** delete the now-unused `gh-pages` branch.
- [ ] **Human:** remove the stale `github.io` entries from the Supabase redirect allowlist
      and the Google authorized origins.
- [ ] **Human:** delete the three Actions secrets — Cloudflare holds the build env now,
      and there is no workflow left to consume them.
- [ ] **Human:** confirm the CPSA browser extension still authenticates, and that it has
      no old app URL baked in. That extension lives in a different repo.

---

## Verification checklist

Run against `https://<DOMAIN>` after Stage 3, and again after Stage 5.

- [ ] Page loads with no 404s on assets (catches a stale `base`).
- [ ] **Sign in with Google** completes and returns to `https://<DOMAIN>/` — not to a
      `/facility-booking/` path, and not to the old host.
- [ ] Submit a booking request as a normal user; it appears as **Pending**.
- [ ] Admin can approve it, and the approval email sends (Edge Function path — should be
      entirely unaffected).
- [ ] **Billing → Drive export** completes (catches a missing Google JS origin).
- [ ] PDF/CSV export downloads.
- [ ] Activity log writes.
- [ ] A preview deployment URL prompts for Cloudflare Access rather than loading openly.

---

## Rollback

| Stage | Rollback |
|---|---|
| 1 | Transfer the repo back. The `github.io` URL under the personal account returns once no stub occupies the path. |
| 2 | Delete the Cloudflare project. Nothing user-facing has changed. |
| 3 | Revert the commit and restore `deploy.yml`; `gh-pages` still holds the last good build, so `<ORG>.github.io` recovers on the next workflow run. Leave the Supabase/Google entries in place — extra allowlist entries are harmless. |
| 4 | Delete the stub repo. |
| 5 | Set the repo back to public; Pages resumes. **Re-add the Actions secrets** if they were already deleted. |

The point of no return is Stage 5, and only because deleting secrets and the `gh-pages`
branch is destructive. Everything before it is reversible within minutes.

---

## Open questions for the owner

1. **Org name** — `aucklandmixedultimate` is unavailable. `amua`?
2. **Domain** — which registrar, and what hostname?
3. **Who holds org ownership** besides the current account? Naming a second owner is the
   entire bus-factor argument for doing this.
4. Does anything besides the CPSA extension link to the `github.io` URL — bookmarks in a
   committee doc, a club website, an email footer?
