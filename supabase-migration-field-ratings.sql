-- ============================================================
-- Facility Booking — crowd-sourced park quality ratings (Council fields page)
-- Run in the Supabase SQL editor. Safe to re-run.
-- Every signed-in user (admins and bookers) can give each park 1–5 stars; the page shows
-- the average and the number of ratings in the Quality stars. One rating per user per park.
-- ============================================================

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
