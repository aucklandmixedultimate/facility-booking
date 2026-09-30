-- Booker contact details for council applications. The person booking a council field is
-- listed as the application's key holder, so council fields can only be booked once the
-- booker has added their name and phone (booking site → User menu → 📇 My council contact).
-- Run once in the Supabase SQL editor. Safe to re-run; it drops nothing but its own policies.

create table if not exists public.booker_contacts (
  email          text primary key,               -- the booker's sign-in email, lowercase
  full_name      text not null default '',
  phone          text not null default '',
  contact_email  text not null default '',       -- if different from the sign-in email
  updated_at     timestamptz not null default now()
);

alter table public.booker_contacts enable row level security;

-- A booker sees and edits only their own row; admins see and edit everyone's.
drop policy if exists "booker_contacts select own or admin" on public.booker_contacts;
create policy "booker_contacts select own or admin" on public.booker_contacts
  for select to authenticated using (email = lower(auth.jwt() ->> 'email') or public.is_admin());

drop policy if exists "booker_contacts insert own or admin" on public.booker_contacts;
create policy "booker_contacts insert own or admin" on public.booker_contacts
  for insert to authenticated with check (email = lower(auth.jwt() ->> 'email') or public.is_admin());

drop policy if exists "booker_contacts update own or admin" on public.booker_contacts;
create policy "booker_contacts update own or admin" on public.booker_contacts
  for update to authenticated using (email = lower(auth.jwt() ->> 'email') or public.is_admin())
  with check (email = lower(auth.jwt() ->> 'email') or public.is_admin());
