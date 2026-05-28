# Handoff: Supabase Auth + RLS migration

Status: **MIGRATION COMPLETE — RLS is LIVE in production.** Read this before touching
Supabase or the app's data logic; these contract changes break writes if ignored.
Source of truth for the SQL is `supabase-migration-auth.sql`.

## TL;DR

The app moved from "anon key does everything" to "Google OAuth + Row Level Security".
Anon-key-only writes are **now locked out** (RLS enabled). Every Supabase write must
carry a logged-in user's JWT.

## Auth contract

- Header contract for REST calls:
  - `apikey: <anon key>`
  - `Authorization: Bearer <user access_token>`
- With only the anon key in `Authorization`, RLS sees `auth.uid() = null` and denies
  all writes.
- The access token comes from a Supabase Google OAuth session:
  `supabase.auth.getSession()` -> `data.session.access_token`.
- Credentials are env-only: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON`.
  No `service_role` key may ever reach the client or the shipped bundle.

## `bookings` table schema change

- New column `user_id uuid` — nullable FK to `auth.users(id)`.
- Regular-user inserts MUST set `user_id` = their auth uid, or the RLS insert policy
  rejects the row.
- Sentinel admin rows keep `email = 'admin'` with `user_id = NULL`. Only admins can
  write those.

## RLS policies now in force

`bookings`:
- SELECT: any authenticated user (shared calendar / clash detection).
- INSERT / UPDATE / DELETE: owner (`user_id = auth.uid()`) OR admin.

`settings`:
- SELECT: any authenticated user.
- INSERT / UPDATE: admin only.

## Admin model

- Admin = `app_metadata.role === 'admin'`.
  NOT `user_metadata` — that field is user-editable and would let users self-promote.
- Current admin: `aucklandmixedultimate@gmail.com` (role granted, verified working).
- To grant another admin, run this Supabase dashboard SQL (the user must already have
  signed in once, then sign out and back in afterward for the claim to take effect):
  `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'::jsonb where email = '<admin email>';`
- SQL helper `public.is_admin()` reads `auth.jwt() -> 'app_metadata' ->> 'role'`.
- In the JSX, `isAdmin` is derived from `session.user.app_metadata.role`. There is no
  client-side admin toggle or password anymore.

## App-side specifics (`src/booking-system.jsx`, single file)

- All DB calls go through the `sb` helper. Its `authHeaders()` (top of file) is the
  single chokepoint that injects the token from a module-level `_accessToken`.
- `_accessToken` is kept in sync by `supabase.auth.onAuthStateChange` (handles
  TOKEN_REFRESHED, SIGNED_IN, SIGNED_OUT).
- `supabase` client is created with PKCE flow + `detectSessionInUrl` so the OAuth
  redirect on gh-pages is handled automatically.
- Login gate: `session === undefined` renders nothing (loading); `!session` renders
  the Google sign-in screen.

## CPSA browser extension — v2.0.0 is OAuth-compatible

The `amua-booking-extension` writes confirmation notes/links back to `bookings`.
RLS blocked the old anon-key writes; **v2.0.0 carries a logged-in admin's Google
OAuth access_token**, so its writes satisfy the bookings RLS policies again. The
in-app install modal links to the v2.0.0 release.

### Extension schema requirement (v2.1.0+)

`supabase-migration-system-notes.sql` adds a `system_notes text` column to
`bookings`. All machine-generated markers (`[CPSA-MISMATCH]`, `[BILLED]`,
`[CPSA <date>] Ref <ref> · <url>`) now live in `system_notes` instead of
`notes`. The `notes` field is reserved for user-editable free text.

**Extension writes must target `system_notes`**, not `notes`:
```json
PATCH /rest/v1/bookings?id=eq.<id>
{ "system_notes": "[CPSA 27/05/2026] Ref ABC123 · https://…" }
```
The app reads from `system_notes` first and falls back to `notes` for rows that
pre-date the migration (backward compatible). Once the migration SQL has been run
the fallback is not needed for new rows.

The `notes` column PATCH must no longer include CPSA markers — it should only
carry user-authored text that was already present (pass-through or omit the
field entirely so existing user notes are preserved).

### Full `system_notes` marker catalogue (as of 2026-05)

The app and extension both share this column. Each marker is a single bracket-
delimited token plus a payload; multiple markers concatenate, separated by
whitespace/newlines. The extension MUST preserve markers it does not own when
rewriting `system_notes`.

| Marker | Owner | Written when | Payload |
| --- | --- | --- | --- |
| `[CPSA <date>] Ref <ref> · <url>` | extension | CPSA confirms a booking | confirmation ref + link |
| `[CPSA-MISMATCH]` | extension | Sync finds CPSA values differ from our record | pipe-separated reason strings, e.g. `Time: 6p → 7p \| Dur: 2h → 3h \| Field: A → B` |
| `[BILLED] facility\|start\|duration` | app | Invoice/PO export with "mark invoiced" | snapshot of billed values; used to compute drift for credit/invoice adjustments |
| `[CPSA-ORIG] facility\|start\|duration` | app | Admin chooses **Amended** to accept CPSA values | snapshot of pre-amendment booking so the operation is reversible |
| `[CPSA-RES] <resolution>\|<billing>\|<iso-date>` | app | Admin resolves a mismatch | values: resolution = `amended` \| `to_correct`; billing = `none` \| `credit_pending` \| `invoice_pending` \| `credited` \| `invoiced` |

When the extension re-syncs a booking it should:
1. Re-read existing `system_notes`.
2. Strip and replace only `[CPSA …]` (confirmation) and `[CPSA-MISMATCH]` markers
   it owns.
3. Leave `[BILLED]`, `[CPSA-ORIG]`, `[CPSA-RES]` markers untouched — these are
   admin/audit state managed exclusively by the web app.

### Permanent audit trail: `mismatch_log`

`supabase-migration-mismatch-log.sql` adds `public.mismatch_log` — an append-only
record of every mismatch resolution (one row per Save action in the admin
Mismatches panel). Columns: `booking_id text` (no FK because `bookings.id` is
text), `reasons`, `orig_facility_id`, `orig_start_hour`, `orig_duration`,
`resolution`, `billing_state`, `created_at`. Admin-only RLS.

The extension does NOT write to `mismatch_log`; only the web app does. The
extension may safely ignore the table.

## activity_log (audit trail)

`supabase-migration-activity-log.sql` adds `public.activity_log` (append-only).
- INSERT: authenticated users may log their own rows (`user_id = auth.uid()`).
- SELECT: admins only. UPDATE/DELETE: nobody.
- The app logs via the `logActivity(action, detail)` helper (module-level, fire-and-
  forget — never throws). Captures `sign_in`/`sign_out`, `booking_create`/`_edit`,
  `status_change`, `bulk_status_change`, `invoiced`, `cpsa_sync_start`/`_complete`,
  `email_sent`/`email_failed`. Each row carries a per-page-load `session_id`.
- Run this migration in the SQL editor before relying on the trail; until then the
  inserts silently no-op.

## Invoiced state + billing-change tracking

- `invoiced` is a separate boolean column on `bookings` (requires
  `supabase-migration-invoiced-flag.sql`), orthogonal to the workflow `status`.
  A booking can be `cpsa_confirmed` AND `invoiced=true` simultaneously.
  On invoice, a `[BILLED] facility|start|duration` snapshot is written into
  `system_notes` (requires `supabase-migration-system-notes.sql`).
- If an invoiced booking's time/duration/field later changes, the admin **Track
  Changes** dropdown lists the drift (excess hours = owing, reduced = credit). Field
  changes are flagged so retroactive revaluation is possible.
- PO/Invoice file name convention: `AMUA PO - <Name> - <YYYYMMDD>-<YYYYMMDD>` where
  `<Name>` is a free-text field entered per export (drives the saved-PDF/CSV name).

## Migration status checklist

Done:
- [x] Google Cloud OAuth client created (redirect URI
      `https://bowfbamsjgozigcaygqq.supabase.co/auth/v1/callback`).
- [x] Supabase Google provider enabled; Site URL + redirect allow-list set.
- [x] `.env.local` filled with the anon key.
- [x] `supabase-migration-auth.sql` schema + helper + backfill run (sections 1-4).
- [x] New OAuth bundle deployed to gh-pages (`npm run deploy`).
- [x] RLS policies enabled on `bookings` and `settings`.
- [x] Admin role granted to `aucklandmixedultimate@gmail.com`; login/booking verified.

- [x] CPSA extension auth fixed by shipping v2.0.0 (OAuth token); install link updated.

Outstanding:
- [ ] Run `supabase-migration-activity-log.sql` in the SQL editor (creates the audit
      table + RLS). Until then `logActivity` inserts silently no-op.
- [ ] Run `supabase-migration-invoiced-flag.sql` in the SQL editor (adds `invoiced boolean`
      column; migrates old `status='invoiced'` rows to `invoiced=true, status='approved'`).
- [ ] Run `supabase-migration-system-notes.sql` in the SQL editor (adds `system_notes`
      column + migrates existing markers out of `notes` + index). Until then system
      markers continue to be written to `notes` as a fallback — app reads from both.
      After running: update CPSA browser extension to v2.1.0+ (writes to `system_notes`).
- [ ] Run `supabase-migration-mismatch-log.sql` in the SQL editor (creates the
      permanent mismatch resolution audit table). Web app only — extension does
      not touch this table.
- [ ] Rotate the anon key (Supabase Settings -> API), update `.env.local`, redeploy.
      Deferred by choice; the current key is still the original one that was committed
      to git history, so rotation is recommended eventually.
