-- ============================================================
-- Facility Booking — system_notes column on bookings
-- Run in Supabase SQL editor.
--
-- Adds a system_notes column to store machine-generated markers
-- separately from the user-editable notes field. Markers that
-- previously lived in notes (CPSA-MISMATCH, BILLED, and CPSA
-- submission references written by the browser extension) are
-- migrated here so users can no longer accidentally overwrite
-- them when editing a booking.
--
-- After running this migration, the browser extension must write
-- its [CPSA date] Ref … markers to system_notes, not notes.
-- See the HANDOFF_SUPABASE_AUTH.md extension section for details.
-- ============================================================

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

-- ── RLS note ────────────────────────────────────────────────
-- system_notes is part of the bookings table, so existing RLS
-- policies apply automatically (owner or admin can SELECT/UPDATE
-- the row). The app-side code never exposes system_notes in any
-- user-facing edit field, so users cannot overwrite it through
-- the normal UI. Only admin sync operations and the CPSA
-- extension write to this column.
