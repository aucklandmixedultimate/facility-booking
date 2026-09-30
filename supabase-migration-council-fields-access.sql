-- Council fields page for every signed-in booker (not just admins).
-- Run once in the Supabase SQL editor. Safe to re-run. Nothing is dropped except the one
-- select policy it replaces.
--
-- 1. Anyone signed in can read the field ratings and club-run flags (admins still do all
--    the writing).
-- 2. A booker can change their own council-field cart (settings "council_facilities",
--    keyed by their email) through set_my_council_facilities(); the settings table itself
--    stays admin-write only.

drop policy if exists "field_reviews admin select" on public.field_reviews;
drop policy if exists "field_reviews select authenticated" on public.field_reviews;
create policy "field_reviews select authenticated" on public.field_reviews
  for select to authenticated using (true);

drop policy if exists "field_flags select authenticated" on public.field_flags;
create policy "field_flags select authenticated" on public.field_flags
  for select to authenticated using (true);

create or replace function public.set_my_council_facilities(entries jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  who text := lower(coalesce(auth.jwt() ->> 'email', ''));
  result jsonb;
begin
  if who = '' then raise exception 'not signed in'; end if;
  if entries is null or jsonb_typeof(entries) <> 'array' then raise exception 'entries must be an array'; end if;
  if jsonb_array_length(entries) > 200 then raise exception 'too many fields'; end if;
  if exists (select 1 from jsonb_array_elements(entries) e
             where jsonb_typeof(e) <> 'object' or coalesce(e ->> 'id', '') not like 'cf-%') then
    raise exception 'each entry needs a cf-… id';
  end if;

  insert into public.settings (key, value, updated_at)
  values ('council_facilities',
          case when jsonb_array_length(entries) = 0 then '{}'::jsonb else jsonb_build_object(who, entries) end,
          now())
  on conflict (key) do update
    set value = case when jsonb_array_length(entries) = 0
                     then coalesce(public.settings.value, '{}'::jsonb) - who
                     else jsonb_set(coalesce(public.settings.value, '{}'::jsonb), array[who], entries) end,
        updated_at = now()
  returning value into result;
  return result;
end;
$$;

revoke all on function public.set_my_council_facilities(jsonb) from public, anon;
grant execute on function public.set_my_council_facilities(jsonb) to authenticated;
