-- ============================================================
-- Facility Booking — activity_log table
-- Run in Supabase SQL editor after the auth/RLS migration.
-- Captures auth events, booking changes, CPSA syncs and emails.
-- ============================================================

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

-- ============================================================
-- RLS — activity_log
--   INSERT: any authenticated user may log their own rows (user_id = auth.uid()).
--   SELECT: admins only (audit trail is not exposed to regular users).
--   UPDATE/DELETE: nobody (append-only).
-- ============================================================
alter table public.activity_log enable row level security;

drop policy if exists "activity insert own" on public.activity_log;
create policy "activity insert own"
  on public.activity_log for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "activity select admin" on public.activity_log;
create policy "activity select admin"
  on public.activity_log for select
  to authenticated
  using (public.is_admin());
