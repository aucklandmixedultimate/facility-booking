-- ============================================================
-- Facility Booking — activity log visible to every signed-in user
-- Run in the Supabase SQL editor after supabase-migration-activity-log.sql. Safe to re-run.
-- Admins still see everything. Everyone else sees bookers' activity only: bookings made,
-- edited or removed, shared slots, and council fields added to / made active in a cart.
-- Sign-ins, emails, syncs, invoices and admin actions stay admin-only.
-- ============================================================

drop policy if exists "activity select admin" on public.activity_log;
drop policy if exists "activity select" on public.activity_log;
create policy "activity select"
  on public.activity_log for select
  to authenticated
  using (
    public.is_admin()
    or (
      action in ('booking_create','booking_edit','booking_delete',
                 'slot_shared','slot_merged','slot_unlinked','council_fields')
      and coalesce(detail ->> 'by', 'booker') = 'booker'
    )
  );
