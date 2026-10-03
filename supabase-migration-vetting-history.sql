-- ============================================================
-- Facility Booking — vetting history (Council fields page → profile menu → 📜 Vetting history)
-- Run in the Supabase SQL editor. Safe to re-run.
-- A global log of vetting changes: field ratings and decisions (field_reviews), provider
-- amendments (field_flags) and crowd quality stars (field_ratings). Everyone signed in sees
-- every entry. Entries are accepted by default; an admin can reject one, which restores the
-- value it replaced (and can accept it again). Requires public.is_admin()
-- (supabase-migration-auth.sql).
-- ============================================================

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
