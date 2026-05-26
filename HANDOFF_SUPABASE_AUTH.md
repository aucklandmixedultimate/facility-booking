# Handoff: Supabase Auth + RLS migration

Read this before touching Supabase or the app's data logic. These contract changes
will break writes if ignored. Source of truth for the SQL is `supabase-migration-auth.sql`.

## TL;DR

The app moved from "anon key does everything" to "Google OAuth + Row Level Security".
Anon-key-only writes are being locked out. Every Supabase write must now carry a
logged-in user's JWT.

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
- Set via Supabase dashboard SQL:
  `update auth.users set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'::jsonb where email = '<admin email>';`
  The user must sign out and back in for the claim to appear in their JWT.
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

## CPSA browser extension — WILL BREAK at cutover

The `amua-booking-extension` writes confirmation notes/links back to `bookings`.
Once RLS is enabled, its anon-key writes get denied. It needs one of:

1. Carry a logged-in admin's session access_token in its requests, OR
2. Route writes through the app instead of writing to Supabase directly, OR
3. A server-side Edge Function that holds the `service_role` key (never shipped
   inside the extension).

Resolve this BEFORE enabling RLS.

## Cutover order (so nobody gets locked out mid-migration)

1. Create Google Cloud OAuth client (redirect URI =
   `https://bowfbamsjgozigcaygqq.supabase.co/auth/v1/callback`).
2. Supabase: enable Google provider; set Site URL + redirect allow-list.
3. Fill `.env.local` with the anon key.
4. Run `supabase-migration-auth.sql` (schema + helper + backfill) — keep RLS off for now.
5. `npm run deploy` the new OAuth bundle.
6. Enable RLS (the policy blocks in the SQL file) — only after the extension is sorted.
7. Set the admin user's `app_metadata.role` and have them re-login.
8. Rotate the anon key (Supabase Settings -> API), update `.env.local`, redeploy.
