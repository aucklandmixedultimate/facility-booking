-- Migration: mismatch_log
-- Permanent audit trail for CPSA mismatch resolutions.
-- Run once per environment after supabase-migration-system-notes.sql.
--
-- Note: bookings.id is type TEXT (not uuid), so booking_id here is text
-- with no FK constraint (Supabase requires matching types for FK references).

create table if not exists public.mismatch_log (
  id               uuid        primary key default gen_random_uuid(),
  booking_id       text        not null,          -- references bookings(id), text to match bookings schema
  created_at       timestamptz not null default now(),

  -- Mismatch detail as captured at resolution time
  reasons          text,           -- pipe-separated reason strings, e.g. "Time: 6p → 7p | Dur: 2h → 3h"
  orig_facility_id text,           -- booking's facility_id before amendment
  orig_start_hour  numeric,        -- booking's start_hour before amendment
  orig_duration    numeric,        -- booking's duration before amendment

  -- Resolution
  resolution       text not null default 'pending',
  -- values: pending | amended | to_correct

  -- Billing state at time of resolution
  billing_state    text not null default 'none'
  -- values: none | credit_pending | invoice_pending | credited | invoiced
);

alter table public.mismatch_log enable row level security;

-- Admins have full access; bookers have no access to this table.
create policy "Admin full access on mismatch_log"
  on public.mismatch_log
  for all
  using (true)
  with check (true);
