-- ============================================================
-- Facility Booking — Auth + RLS migration
-- Run in Supabase SQL editor (in order, one block at a time).
-- ============================================================

-- 1. Add nullable user_id FK to auth.users
alter table public.bookings
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create index if not exists bookings_user_id_idx on public.bookings (user_id);
create index if not exists bookings_email_lower_idx on public.bookings (lower(email));

-- 2. One-time backfill: link existing rows to auth users by matching email.
--    Sentinel rows (email = 'admin') match nothing → stay NULL intentionally.
update public.bookings b
set user_id = u.id
from auth.users u
where b.user_id is null
  and b.email <> 'admin'
  and lower(b.email) = lower(u.email);

-- 3. Auto-link future signups: when a new Google user is created, claim any
--    pre-existing bookings rows whose email matches.
create or replace function public.link_bookings_to_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bookings
  set user_id = new.id
  where user_id is null
    and email <> 'admin'
    and lower(email) = lower(new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_link_bookings on auth.users;
create trigger on_auth_user_created_link_bookings
  after insert on auth.users
  for each row execute function public.link_bookings_to_new_user();

-- 4. Helper to read the admin role from app_metadata (tamper-proof —
--    only writable by the service_role / Admin API, not by users).
create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin',
    false
  );
$$;

-- ============================================================
-- RLS — bookings
-- ============================================================
alter table public.bookings enable row level security;

drop policy if exists "bookings select authenticated" on public.bookings;
create policy "bookings select authenticated"
  on public.bookings for select
  to authenticated
  using (true);

drop policy if exists "bookings insert own or admin" on public.bookings;
create policy "bookings insert own or admin"
  on public.bookings for insert
  to authenticated
  with check (
    public.is_admin()
    or user_id = auth.uid()
  );

drop policy if exists "bookings update own or admin" on public.bookings;
create policy "bookings update own or admin"
  on public.bookings for update
  to authenticated
  using  (public.is_admin() or user_id = auth.uid())
  with check (public.is_admin() or user_id = auth.uid());

drop policy if exists "bookings delete own or admin" on public.bookings;
create policy "bookings delete own or admin"
  on public.bookings for delete
  to authenticated
  using (public.is_admin() or user_id = auth.uid());

-- ============================================================
-- RLS — settings (admin-only writes)
-- ============================================================
alter table public.settings enable row level security;

-- Drop the old open policies from supabase-schema.sql
drop policy if exists "settings read for all" on public.settings;
drop policy if exists "settings write for all" on public.settings;
drop policy if exists "settings update for all" on public.settings;

create policy "settings select authenticated"
  on public.settings for select
  to authenticated using (true);

create policy "settings insert admin"
  on public.settings for insert
  to authenticated with check (public.is_admin());

create policy "settings update admin"
  on public.settings for update
  to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================
-- Grant admin role to yourself (run after first Google sign-in)
-- Replace the email below with the admin's Google account email.
-- The user must sign out and back in for the new claim to take effect.
-- ============================================================
-- update auth.users
--   set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'::jsonb
--   where email = 'aucklandmixedultimate@gmail.com';
