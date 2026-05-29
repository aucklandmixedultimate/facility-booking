-- ============================================================
-- Facility Booking — invoiced flag on bookings
-- Run in Supabase SQL editor.
--
-- Separates "invoiced" from the workflow status column.
-- Previously booking.status could be set to "invoiced", which
-- would overwrite the real workflow state (e.g. cpsa_confirmed).
-- Now booking.invoiced is an independent boolean flag — the
-- status column is never set to "invoiced" again.
--
-- After migration: old rows with status='invoiced' are reset
-- to status='approved' and invoiced=true.
-- ============================================================

alter table public.bookings
  add column if not exists invoiced boolean not null default false;

-- Migrate rows whose status was "invoiced" to the new flag.
update public.bookings
set invoiced = true,
    status   = 'approved'
where status = 'invoiced';

create index if not exists bookings_invoiced_idx on public.bookings (invoiced) where invoiced = true;
