-- Manna accounts: run this once in Supabase > SQL Editor > New query > Run.
-- Safe to run again; it only creates what is missing and resets the rules.

-- 1. One row per person: their Manna data and their plan.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  data        jsonb       not null default '{}'::jsonb,
  plan        text        not null default 'free' check (plan in ('free', 'paid')),
  updated_at  timestamptz not null default now()
);

-- 2. AI uses per person per day (Eastern time).
create table if not exists public.ai_usage (
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  n        int  not null default 0,
  primary key (user_id, day)
);

-- 3. Row-level security: people can only ever reach their own rows.
alter table public.profiles enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists "own profile: read"   on public.profiles;
drop policy if exists "own profile: insert" on public.profiles;
drop policy if exists "own profile: update" on public.profiles;
drop policy if exists "own usage: read"     on public.ai_usage;

create policy "own profile: read"   on public.profiles for select to authenticated using (auth.uid() = id);
create policy "own profile: insert" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "own profile: update" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "own usage: read"     on public.ai_usage for select to authenticated using (auth.uid() = user_id);

-- People may save their data, but never change their own plan or AI count.
revoke all on public.profiles from anon, authenticated;
revoke all on public.ai_usage from anon, authenticated;
grant select on public.profiles to authenticated;
grant insert (id, data, updated_at) on public.profiles to authenticated;
grant update (data, updated_at) on public.profiles to authenticated;
grant select on public.ai_usage to authenticated;

-- 4. Count one AI use if the person still has some left today. Server only.
create or replace function public.use_ai(p_user uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_plan  text;
  v_limit int;
  v_n     int;
  v_day   date := (now() at time zone 'America/New_York')::date;
begin
  select plan into v_plan from profiles where id = p_user;
  v_plan  := coalesce(v_plan, 'free');
  v_limit := case when v_plan = 'paid' then 100 else 5 end;
  insert into ai_usage (user_id, day, n) values (p_user, v_day, 1)
  on conflict (user_id, day) do update set n = ai_usage.n + 1 where ai_usage.n < v_limit
  returning n into v_n;
  if v_n is null then
    return json_build_object('allowed', false, 'used', v_limit, 'limit', v_limit, 'plan', v_plan);
  end if;
  return json_build_object('allowed', true, 'used', v_n, 'limit', v_limit, 'plan', v_plan);
end $$;

-- Give a use back when the AI itself failed. Server only.
create or replace function public.refund_ai(p_user uuid)
returns void language sql security definer set search_path = public as $$
  update ai_usage set n = greatest(0, n - 1)
  where user_id = p_user and day = (now() at time zone 'America/New_York')::date;
$$;

-- How many uses today, for showing "3 of 5 left". Server only.
create or replace function public.ai_today(p_user uuid)
returns json language sql security definer set search_path = public as $$
  select json_build_object(
    'used',  coalesce((select n from ai_usage where user_id = p_user and day = (now() at time zone 'America/New_York')::date), 0),
    'limit', case when coalesce((select plan from profiles where id = p_user), 'free') = 'paid' then 100 else 5 end,
    'plan',  coalesce((select plan from profiles where id = p_user), 'free'));
$$;

revoke execute on function public.use_ai(uuid)    from public, anon, authenticated;
revoke execute on function public.refund_ai(uuid) from public, anon, authenticated;
revoke execute on function public.ai_today(uuid)  from public, anon, authenticated;
grant  execute on function public.use_ai(uuid)    to service_role;
grant  execute on function public.refund_ai(uuid) to service_role;
grant  execute on function public.ai_today(uuid)  to service_role;

-- To give someone the paid plan (until payments are added):
--   update public.profiles set plan = 'paid' where id = '<their user id>';
