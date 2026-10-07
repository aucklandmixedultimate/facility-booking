-- =============================================================================
-- Facility Booking — complete database setup (one script)
-- =============================================================================
-- Run the whole file in the Supabase SQL editor. It is safe to re-run at any time: every
-- table, column, index, function and policy is created "if not exists" or replaced, and the
-- one-off data fixes only touch rows that still need them. It replaces the separate
-- supabase-schema.sql / supabase-migration-*.sql files (kept in git history).
--
-- Sections
--   0. Version stamp
--   1. Core: settings, is_admin(), bookings (+ user link, invoiced, system_notes)
--   2. Audit: activity_log (admins see all; others see bookers' activity), mismatch_log
--   3. Bookers: booker_contacts, set_my_council_facilities()
--   4. Council fields: field_reviews, field_flags, field_ratings, vetting_history
--   5. settings_merge(): atomic partial updates of a settings value
--   6. Making someone an admin (commented out)
-- =============================================================================

-- ── 0. Version stamp ────────────────────────────────────────────────────────────
-- Records which version of this script last ran, so the app (and you) can tell.
create table if not exists public.schema_version (
  id          int primary key default 1 check (id = 1),
  version     int not null,
  applied_at  timestamptz not null default now()
);
alter table public.schema_version enable row level security;
drop policy if exists "schema_version read" on public.schema_version;
create policy "schema_version read" on public.schema_version for select to authenticated using (true);

-- ── 1. Core ─────────────────────────────────────────────────────────────────────
-- settings: key/value store for app configuration and shared lists (facility_rates,
-- email_aliases, alias_names, alias_colors, booker_seasons, council_facilities,
-- council_outcomes, vet_park_activity, …). Signed-in users read; admins write.
create table if not exists public.settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- Admin role from app_metadata (only the service role / Admin API can set it).
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

alter table public.settings enable row level security;
drop policy if exists "settings read for all" on public.settings;
drop policy if exists "settings write for all" on public.settings;
drop policy if exists "settings update for all" on public.settings;
drop policy if exists "settings select authenticated" on public.settings;
drop policy if exists "settings insert admin" on public.settings;
drop policy if exists "settings update admin" on public.settings;
create policy "settings select authenticated" on public.settings for select to authenticated using (true);
create policy "settings insert admin" on public.settings for insert to authenticated with check (public.is_admin());
create policy "settings update admin" on public.settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- bookings (already exists in the live project; created here for a fresh one).
create table if not exists public.bookings (
  id           text primary key,
  name         text,
  email        text,
  phone        text,
  facility_id  text not null,
  date         date not null,
  start_hour   numeric not null,
  duration     numeric not null,
  purpose      text,
  notes        text,
  status       text not null default 'pending_amua',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);

alter table public.bookings add column if not exists user_id uuid references auth.users(id) on delete set null;
create index if not exists bookings_user_id_idx on public.bookings (user_id);
create index if not exists bookings_email_lower_idx on public.bookings (lower(email));

-- Link bookings to accounts by email (existing rows now, new sign-ups by trigger).
update public.bookings b set user_id = u.id
from auth.users u
where b.user_id is null and b.email <> 'admin' and lower(b.email) = lower(u.email);

create or replace function public.link_bookings_to_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bookings set user_id = new.id
  where user_id is null and email <> 'admin' and lower(email) = lower(new.email);
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_link_bookings on auth.users;
create trigger on_auth_user_created_link_bookings
  after insert on auth.users
  for each row execute function public.link_bookings_to_new_user();

-- v4: a booking belongs to the account of its email. When an admin reassigns a booking to
-- another booker (or books on someone's behalf without a user_id), link it to that
-- booker's account, so they can manage it and the previous booker no longer can.
create or replace function public.bookings_link_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.user_id is not null then return new; end if;
  if tg_op = 'UPDATE' and lower(coalesce(new.email, '')) = lower(coalesce(old.email, '')) then return new; end if;
  new.user_id := (select u.id from auth.users u
                  where coalesce(new.email, '') <> 'admin' and lower(u.email) = lower(new.email) limit 1);
  return new;
end;
$$;
drop trigger if exists bookings_link_user on public.bookings;
create trigger bookings_link_user
  before insert or update of email on public.bookings
  for each row execute function public.bookings_link_user();

alter table public.bookings enable row level security;
drop policy if exists "bookings select authenticated" on public.bookings;
create policy "bookings select authenticated" on public.bookings for select to authenticated using (true);
drop policy if exists "bookings insert own or admin" on public.bookings;
create policy "bookings insert own or admin" on public.bookings for insert to authenticated
  with check (public.is_admin() or user_id = auth.uid());
drop policy if exists "bookings update own or admin" on public.bookings;
create policy "bookings update own or admin" on public.bookings for update to authenticated
  using (public.is_admin() or user_id = auth.uid()) with check (public.is_admin() or user_id = auth.uid());
drop policy if exists "bookings delete own or admin" on public.bookings;
create policy "bookings delete own or admin" on public.bookings for delete to authenticated
  using (public.is_admin() or user_id = auth.uid());

-- invoiced: a flag separate from the workflow status (old status='invoiced' rows move over).
alter table public.bookings
  add column if not exists invoiced boolean not null default false;

-- Migrate rows whose status was "invoiced" to the new flag.
update public.bookings
set invoiced = true,
    status   = 'approved'
where status = 'invoiced';

-- v3: the two legacy status keys move to their current names (src/statuses.js).
update public.bookings set status = 'pending_amua' where status = 'pending';
update public.bookings set status = 'queued_cpsa'  where status = 'amua_submit';

create index if not exists bookings_invoiced_idx on public.bookings (invoiced) where invoiced = true;

-- system_notes: machine markers kept apart from the user-editable notes.
alter table public.bookings
  add column if not exists system_notes text;

-- ── Migrate existing system markers out of notes ────────────
-- Collect [CPSA-MISMATCH], [BILLED], and [CPSA …] Ref lines
-- into system_notes, then strip them from notes.

update public.bookings
set
  system_notes = trim(
    concat_ws(E'\n',
      nullif((regexp_match(notes, '\[CPSA-MISMATCH\][^\n]*'))[1], null),
      nullif((regexp_match(notes, '\[BILLED\][^\n]*'))[1], null),
      nullif((regexp_match(notes, '\[CPSA [^\]]+\] Ref [^\n]*'))[1], null)
    )
  ),
  notes = trim(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          coalesce(notes, ''),
          '\[CPSA-MISMATCH\][^\n]*\n?', '', 'g'
        ),
        '\[BILLED\][^\n]*\n?', '', 'g'
      ),
      '\[CPSA [^\]]+\] Ref [^\n]*\n?', '', 'g'
    )
  )
where notes ~ '\[CPSA-MISMATCH\]|\[BILLED\]|\[CPSA [^\]]+\] Ref ';

-- ── Index for any future admin query on system_notes ────────
create index if not exists bookings_system_notes_idx
  on public.bookings using gin (to_tsvector('english', coalesce(system_notes, '')));

-- ── 2. Audit ────────────────────────────────────────────────────────────────────
create table if not exists public.activity_log (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete set null,
  user_email  text,
  session_id  text,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb
);

create index if not exists activity_log_created_at_idx on public.activity_log (created_at desc);
create index if not exists activity_log_user_id_idx   on public.activity_log (user_id);
create index if not exists activity_log_session_idx    on public.activity_log (session_id);

alter table public.activity_log enable row level security;
drop policy if exists "activity insert own" on public.activity_log;
create policy "activity insert own" on public.activity_log for insert to authenticated with check (user_id = auth.uid());
-- Admins see everything; everyone else sees bookers' activity (bookings, shared slots,
-- council fields) — not sign-ins, emails, syncs or admin work.
drop policy if exists "activity select admin" on public.activity_log;
drop policy if exists "activity select" on public.activity_log;
create policy "activity select" on public.activity_log for select to authenticated
  using (
    public.is_admin()
    or (
      action in ('booking_create','booking_edit','booking_delete',
                 'slot_shared','slot_merged','slot_unlinked','council_fields')
      and coalesce(detail ->> 'by', 'booker') = 'booker'
    )
  );
drop policy if exists "activity delete admin" on public.activity_log;
create policy "activity delete admin" on public.activity_log for delete to authenticated using (public.is_admin());

-- mismatch_log: GTEC mismatch resolutions (admin only). bookings.id is text, so no FK.
create table if not exists public.mismatch_log (
  id               uuid        primary key default gen_random_uuid(),
  booking_id       text        not null,
  created_at       timestamptz not null default now(),
  reasons          text,
  orig_facility_id text,
  orig_start_hour  numeric,
  orig_duration    numeric,
  resolution       text not null default 'pending',   -- pending | amended | to_correct
  billing_state    text not null default 'none'       -- none | credit_pending | invoice_pending | credited | invoiced
);
alter table public.mismatch_log enable row level security;
-- (The old policy let anyone read and write; it's now admins only.)
drop policy if exists "Admin full access on mismatch_log" on public.mismatch_log;
drop policy if exists "mismatch_log admin all" on public.mismatch_log;
create policy "mismatch_log admin all" on public.mismatch_log for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ── 3. Bookers ──────────────────────────────────────────────────────────────────
-- Contact details for council applications (the booker is the key holder).
create table if not exists public.booker_contacts (
  email          text primary key,               -- the booker's sign-in email, lowercase
  full_name      text not null default '',
  phone          text not null default '',
  contact_email  text not null default '',       -- if different from the sign-in email
  updated_at     timestamptz not null default now()
);

alter table public.booker_contacts enable row level security;

-- A booker sees and edits only their own row; admins see and edit everyone's.
drop policy if exists "booker_contacts select own or admin" on public.booker_contacts;
create policy "booker_contacts select own or admin" on public.booker_contacts
  for select to authenticated using (email = lower(auth.jwt() ->> 'email') or public.is_admin());

drop policy if exists "booker_contacts insert own or admin" on public.booker_contacts;
create policy "booker_contacts insert own or admin" on public.booker_contacts
  for insert to authenticated with check (email = lower(auth.jwt() ->> 'email') or public.is_admin());

drop policy if exists "booker_contacts update own or admin" on public.booker_contacts;
create policy "booker_contacts update own or admin" on public.booker_contacts
  for update to authenticated using (email = lower(auth.jwt() ->> 'email') or public.is_admin())
  with check (email = lower(auth.jwt() ->> 'email') or public.is_admin());

-- A booker changes only their own council-field cart (settings "council_facilities",
-- keyed by their email): council "cf-…" and community "cm-…" entries.
create or replace function public.set_my_council_facilities(entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  who text := lower(coalesce(auth.jwt() ->> 'email', ''));
  result jsonb;
begin
  if who = '' then raise exception 'not signed in'; end if;
  if entries is null or jsonb_typeof(entries) <> 'array' then raise exception 'entries must be an array'; end if;
  if jsonb_array_length(entries) > 200 then raise exception 'too many fields'; end if;
  if exists (select 1 from jsonb_array_elements(entries) e
             where jsonb_typeof(e) <> 'object' or (coalesce(e ->> 'id', '') not like 'cf-%' and coalesce(e ->> 'id', '') not like 'cm-%')) then
    raise exception 'each entry needs a cf-… (council) or cm-… (community) id';
  end if;

  insert into public.settings (key, value, updated_at)
  values ('council_facilities',
          case when jsonb_array_length(entries) = 0 then '{}'::jsonb else jsonb_build_object(who, entries) end,
          now())
  on conflict (key) do update
    set value = case when jsonb_array_length(entries) = 0
                     then coalesce(public.settings.value, '{}'::jsonb) - who
                     else jsonb_set(coalesce(public.settings.value, '{}'::jsonb), array[who], entries) end,
        updated_at = now()
  returning value into result;
  return result;
end;
$$;

revoke all on function public.set_my_council_facilities(jsonb) from public, anon;
grant execute on function public.set_my_council_facilities(jsonb) to authenticated;

-- ── 4. Council fields (vetting.html) ──────────────────────────────────────────
create table if not exists public.field_reviews (
  park_id      text primary key,                 -- slug of region + council park name (public/council-maps/parks.json)
  region       text not null,
  park         text not null,
  decision     text not null check (decision in ('top','yes','no','rating')),  -- top pick / shortlist / reject / still rating (fields saved, no decision yet)
  lights       text not null default 'unknown' check (lights in ('unknown','none','training','full')),
  fit          text not null default 'unknown',           -- reduced / full (one field) / multi (2+ fields); check below
  quality      smallint check (quality between 1 and 5),
  fields       text not null default '',          -- which council fields suit, free text
  notes        text not null default '',
  placement    jsonb,                             -- {lat, lon, angle, len, wid, ez, lights, fields: {name: {fit, lat, lon, angle, lights}}}
  reviewed_by  uuid references auth.users(id) on delete set null,
  reviewer_email text,
  updated_at   timestamptz not null default now()
);

-- Fit ratings: reduced size, one full field, or two or more fields.
-- 'rating': per-field ratings saved with "Save · next field" before a decision is made.
alter table public.field_reviews drop constraint if exists field_reviews_decision_check;
alter table public.field_reviews add constraint field_reviews_decision_check
  check (decision in ('top','yes','no','rating'));

alter table public.field_reviews drop constraint if exists field_reviews_fit_check;
alter table public.field_reviews add constraint field_reviews_fit_check
  check (fit in ('unknown','reduced','full','multi','no'));

alter table public.field_reviews enable row level security;

drop policy if exists "field_reviews admin select" on public.field_reviews;
create policy "field_reviews admin select" on public.field_reviews
  for select to authenticated using (public.is_admin());

drop policy if exists "field_reviews admin insert" on public.field_reviews;
create policy "field_reviews admin insert" on public.field_reviews
  for insert to authenticated with check (public.is_admin());

drop policy if exists "field_reviews admin update" on public.field_reviews;
create policy "field_reviews admin update" on public.field_reviews
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "field_reviews admin delete" on public.field_reviews;
create policy "field_reviews admin delete" on public.field_reviews
  for delete to authenticated using (public.is_admin());

-- ------------------------------------------------------------
-- Club-run flags: a park an admin thinks is probably run by a club but that isn't in
-- public/council-maps/private-managed.json yet. Separate from field_reviews so a park can
-- be flagged without a decision.
-- ------------------------------------------------------------
create table if not exists public.field_flags (
  park_id          text primary key,
  club             text not null default '',      -- which club, if known
  flagged_by       uuid references auth.users(id) on delete set null,
  flagged_by_email text,
  updated_at       timestamptz not null default now()
);

alter table public.field_flags enable row level security;

drop policy if exists "field_flags admin all" on public.field_flags;
create policy "field_flags admin all" on public.field_flags
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Provider amendments: what's wrong with a park's provider listing. kind 'private' = privately
-- operated by `club` (e.g. Liston Park → Ellerslie AFC); 'change' = the listed operator is wrong
-- or has changed; 'other' = another provider change. contact = the provider's contact person,
-- first name and last initial only (e.g. "Rory H.").
alter table public.field_flags add column if not exists kind text not null default 'private';
alter table public.field_flags add column if not exists contact text not null default '';
-- More about the provider, saved with an amendment: its website and other info (club phone or
-- email, booking page…). (v2)
alter table public.field_flags add column if not exists website text not null default '';
alter table public.field_flags add column if not exists details text not null default '';

-- Everyone signed in reads the reviews and provider flags (writes: see v5 below).
drop policy if exists "field_reviews admin select" on public.field_reviews;
drop policy if exists "field_reviews select authenticated" on public.field_reviews;
create policy "field_reviews select authenticated" on public.field_reviews
  for select to authenticated using (true);

drop policy if exists "field_flags select authenticated" on public.field_flags;
create policy "field_flags select authenticated" on public.field_flags
  for select to authenticated using (true);

-- (v5) Every signed-in booker rates parks the same way admins do: places and rates frisbee
-- fields, decides and amends vendors. Each change is logged in vetting_history, where admins
-- can reject it (restoring the earlier value). Deleting a review stays admin-only.
drop policy if exists "field_reviews insert authenticated" on public.field_reviews;
create policy "field_reviews insert authenticated" on public.field_reviews
  for insert to authenticated with check (true);
drop policy if exists "field_reviews update authenticated" on public.field_reviews;
create policy "field_reviews update authenticated" on public.field_reviews
  for update to authenticated using (true) with check (true);
drop policy if exists "field_flags write authenticated" on public.field_flags;
create policy "field_flags write authenticated" on public.field_flags
  for all to authenticated using (true) with check (true);

-- Crowd quality ratings: everyone signed in gives each park 1–5 stars.
create table if not exists public.field_ratings (
  park_id     text not null,                       -- slug, as in field_reviews.park_id
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  user_email  text,
  stars       smallint not null check (stars between 1 and 5),
  updated_at  timestamptz not null default now(),
  primary key (park_id, user_id)
);

alter table public.field_ratings enable row level security;

-- Everyone signed in sees all ratings (to show the average); each person writes only their own.
drop policy if exists "field_ratings read" on public.field_ratings;
create policy "field_ratings read" on public.field_ratings
  for select to authenticated using (true);

drop policy if exists "field_ratings insert own" on public.field_ratings;
create policy "field_ratings insert own" on public.field_ratings
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "field_ratings update own" on public.field_ratings;
create policy "field_ratings update own" on public.field_ratings
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "field_ratings delete own" on public.field_ratings;
create policy "field_ratings delete own" on public.field_ratings
  for delete to authenticated using (user_id = auth.uid());

-- Vetting history: a global log of vetting changes; admins can reject one (restoring the
-- earlier value) or accept it again.
create table if not exists public.vetting_history (
  id          bigint generated always as identity primary key,
  park_id     text not null,
  park        text not null default '',
  kind        text not null check (kind in ('review','flag','rating')),
  before      jsonb,                                -- the value replaced (null = there was none)
  after       jsonb,                                -- the value saved (null = removed)
  by_id       uuid references auth.users(id) on delete set null default auth.uid(),
  by_email    text,
  by_name     text,                                 -- who on a shared login: first name, last initial ("Rory H.")
  at          timestamptz not null default now(),
  status      text not null default 'accepted' check (status in ('accepted','rejected')),
  status_by_email text,
  status_at   timestamptz
);
alter table public.vetting_history add column if not exists by_name text;
create index if not exists vetting_history_at on public.vetting_history (at desc);

alter table public.vetting_history enable row level security;

drop policy if exists "vetting_history read" on public.vetting_history;
create policy "vetting_history read" on public.vetting_history
  for select to authenticated using (true);

-- Each person logs their own changes.
drop policy if exists "vetting_history insert own" on public.vetting_history;
create policy "vetting_history insert own" on public.vetting_history
  for insert to authenticated with check (by_id = auth.uid() and status = 'accepted');

-- Quick successive edits to the same park fold into one entry (own, still accepted);
-- only admins accept or reject.
drop policy if exists "vetting_history update" on public.vetting_history;
create policy "vetting_history update" on public.vetting_history
  for update to authenticated
  using (public.is_admin() or (by_id = auth.uid() and status = 'accepted'))
  with check (public.is_admin() or (by_id = auth.uid() and status = 'accepted'));

-- Rejecting someone's quality stars restores their previous rating, so admins may write any
-- field_ratings row (once supabase-migration-field-ratings.sql has made the table).
do $$
begin
  if to_regclass('public.field_ratings') is not null then
    drop policy if exists "field_ratings admin all" on public.field_ratings;
    create policy "field_ratings admin all" on public.field_ratings
      for all to authenticated using (public.is_admin()) with check (public.is_admin());
  end if;
end $$;

-- ── 5. settings_merge(): atomic partial updates ─────────────────────────────────
-- Changes some entries of a settings value without rewriting the rest, so two admins
-- saving different entries at once can't overwrite each other:
--   value := (value - remove_keys) || patch        (top-level keys)
-- Admins only. Returns the new value.
create or replace function public.settings_merge(setting_key text, patch jsonb default '{}'::jsonb, remove_keys text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  if patch is null or jsonb_typeof(patch) <> 'object' then raise exception 'patch must be an object'; end if;
  insert into public.settings (key, value, updated_at)
  values (setting_key, patch, now())
  on conflict (key) do update
    set value = (coalesce(public.settings.value, '{}'::jsonb) - remove_keys) || patch,
        updated_at = now()
  returning value into result;
  return result;
end;
$$;
revoke all on function public.settings_merge(text, jsonb, text[]) from public, anon;
grant execute on function public.settings_merge(text, jsonb, text[]) to authenticated;

-- ── Version stamp ───────────────────────────────────────────────────────────────
insert into public.schema_version (id, version, applied_at) values (1, 5, now())
on conflict (id) do update set version = excluded.version, applied_at = now();

-- ── 6. Making someone an admin ──────────────────────────────────────────────────
-- Run once per admin after their first Google sign-in; they sign out and back in after.
-- update auth.users
--   set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'::jsonb
--   where email = 'aucklandmixedultimate@gmail.com';
