-- Manna Version 159. Paste all of this into Supabase › SQL Editor and press Run.
-- Safe to run more than once.

-- 1) A daily count of free AI food lookups per account, so the free cap holds on any network.
create table if not exists public.food_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  n       int  not null default 0,
  primary key (user_id, day)
);
alter table public.food_usage enable row level security;

create or replace function public.use_food(p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int; v_day date := (now() at time zone 'America/New_York')::date;
begin
  insert into food_usage (user_id, day, n) values (p_user, v_day, 1)
  on conflict (user_id, day) do update set n = food_usage.n + 1
  returning n into v_n;
  delete from food_usage where day < v_day - 7;
  return v_n;
end $$;
revoke execute on function public.use_food(uuid) from public, anon, authenticated;
grant  execute on function public.use_food(uuid) to service_role;

-- 2) Phones that asked for reminders. Only the server reads or writes this table.
create table if not exists public.push_subs (
  endpoint   text primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  sub        jsonb not null,
  prefs      jsonb not null default '{}',
  last       jsonb not null default '{}',
  tz         text not null default 'America/New_York',
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;

alter table public.push_subs add column if not exists prefs jsonb not null default '{}';
alter table public.push_subs add column if not exists last  jsonb not null default '{}';

-- 3) Every 5 minutes, ask Manna to send any reminders that are due (each person picks their own times).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule('manna-reminders', '*/5 * * * *',
  $$select net.http_get('https://manna-beta-five.vercel.app/api/push?run=tick')$$);
