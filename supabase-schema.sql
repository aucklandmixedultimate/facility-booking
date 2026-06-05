-- =============================================================================
-- Facility Booking — Supabase schema
-- =============================================================================
-- Run this in the Supabase SQL editor when first setting up a project, or to
-- apply new persistence (settings table). The bookings table existed prior.

-- ── settings (key/value store for app configuration) ─────────────────────────
-- Holds:
--   facility_rates    → { "<facility_id>": { day, evening }, ... }
--   approx_players    → { "<email_lc>": <int>, ... }
--   approx_durations  → { "<email_lc>": <float hours>, ... }
--   email_aliases     → { "<secondary_email>": "<primary_email>", ... }
--   alias_names       → { "<primary_email>": "<display name>", ... }
--   alias_colors      → { "<primary_email>": "#hex", ... }
-- (profiles are NOT stored here — they hold sensitive billing/bank details and
--  this table is anon-readable; they remain device-local for now.)
create table if not exists settings (
  key         text primary key,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

alter table settings enable row level security;

-- Anyone (anon role) can read settings (used by Summary tab for all users).
drop policy if exists "settings read for all" on settings;
create policy "settings read for all"
  on settings for select
  using (true);

-- Anyone can upsert settings. The app gates writes by isAdmin / email match
-- at the UI layer; tighten this with a Supabase auth setup later if needed.
drop policy if exists "settings write for all" on settings;
create policy "settings write for all"
  on settings for insert
  with check (true);

drop policy if exists "settings update for all" on settings;
create policy "settings update for all"
  on settings for update
  using (true) with check (true);
