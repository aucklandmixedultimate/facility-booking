-- ============================================================
-- Facility Booking — council field vetting reviews
-- Run in the Supabase SQL editor. Safe to re-run.
-- Used by vetting.html (Admin menu → Field vetting). Admin-only: requires
-- public.is_admin() from supabase-migration-auth.sql.
-- ============================================================

create table if not exists public.field_reviews (
  park_id      text primary key,                 -- slug of region + council park name (public/council-maps/parks.json)
  region       text not null,
  park         text not null,
  decision     text not null check (decision in ('top','yes','no')),  -- top pick / shortlist / reject
  lights       text not null default 'unknown' check (lights in ('unknown','none','training','full')),
  fit          text not null default 'unknown',           -- reduced / full (one field) / multi (2+ fields); check below
  quality      smallint check (quality between 1 and 5),
  fields       text not null default '',          -- which council fields suit, free text
  notes        text not null default '',
  placement    jsonb,                             -- {lat, lon, angle, len, wid, ez, lights: [[lat, lon], …]}: field position + marked light poles
  reviewed_by  uuid references auth.users(id) on delete set null,
  reviewer_email text,
  updated_at   timestamptz not null default now()
);

-- Fit ratings: reduced size, one full field, or two or more fields.
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
