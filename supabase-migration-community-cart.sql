-- Community facilities (schools, trusts) in the Council / Community fields cart.
-- Bookers' cart entries for community facilities use "cm-<operator id>" ids; this lets
-- set_my_council_facilities() accept them alongside council "cf-…" ids. Run once in the
-- Supabase SQL editor after supabase-migration-council-fields-access.sql. Safe to re-run.

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
             where jsonb_typeof(e) <> 'object' or (coalesce(e ->> 'id', '') not like 'cf-%' and coalesce(e ->> 'id', '') not like 'cm-%')) then
    raise exception 'each entry needs a cf-… (council) or cm-… (community) id';
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

