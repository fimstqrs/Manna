-- Manna friends: run this once in Supabase > SQL Editor > New query > Run.
-- Needs schema.sql to have been run first. Safe to run again.
--
-- How it stays private:
--   * Nobody can read these tables directly. Everything goes through the functions below,
--     which always use the signed-in person (auth.uid()) and check friendship first.
--   * You only ever see a friend's shared summary, and only the parts they switched on.
--   * There is no search: you need someone's exact username to send a request.

-- 1. Usernames (3 to 20 characters: lowercase letters, numbers, underscore).
create table if not exists public.handles (
  id          uuid primary key references auth.users(id) on delete cascade,
  username    text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display     text not null default '' check (char_length(display) <= 40),
  updated_at  timestamptz not null default now()
);

-- 2. Friendships. a = who asked, b = who was asked.
create table if not exists public.friendships (
  a           uuid not null references auth.users(id) on delete cascade,
  b           uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  blocked_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (a, b),
  check (a <> b)
);
create unique index if not exists friendships_pair on public.friendships (least(a, b), greatest(a, b));

-- 3. What each person shares, and the small summary their friends can see.
create table if not exists public.shares (
  id          uuid primary key references auth.users(id) on delete cascade,
  allow       jsonb not null default '{"workouts": true, "meals": false, "weight": false}'::jsonb,
  summary     jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

-- 4. Cheers (🙏 💪 🔥) between friends.
create table if not exists public.cheers (
  id          bigserial primary key,
  from_id     uuid not null references auth.users(id) on delete cascade,
  to_id       uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('pray', 'strong', 'fire')),
  day         date not null default ((now() at time zone 'America/New_York')::date),
  created_at  timestamptz not null default now(),
  unique (from_id, to_id, kind, day)
);

-- Lock the tables: no direct access at all, only through the functions below.
alter table public.handles     enable row level security;
alter table public.friendships enable row level security;
alter table public.shares      enable row level security;
alter table public.cheers      enable row level security;
revoke all on public.handles, public.friendships, public.shares, public.cheers from anon, authenticated;

-- Are these two people accepted friends?
create or replace function public.are_friends(x uuid, y uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from friendships
                 where status = 'accepted' and ((a = x and b = y) or (a = y and b = x)));
$$;
revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;

-- My username (or null).
create or replace function public.my_handle()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('username', username, 'display', display) from handles where id = auth.uid();
$$;

-- Pick or change my username. Returns {ok:true} or {ok:false, error:'taken'|'invalid'}.
create or replace function public.set_username(p_username text, p_display text default '')
returns json language plpgsql security definer set search_path = public as $$
declare u text := lower(trim(coalesce(p_username, '')));
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  if u !~ '^[a-z0-9_]{3,20}$' then return json_build_object('ok', false, 'error', 'invalid'); end if;
  if exists (select 1 from handles where username = u and id <> auth.uid()) then
    return json_build_object('ok', false, 'error', 'taken');
  end if;
  insert into handles (id, username, display, updated_at)
  values (auth.uid(), u, left(coalesce(p_display, ''), 40), now())
  on conflict (id) do update set username = excluded.username, display = excluded.display, updated_at = now();
  insert into shares (id) values (auth.uid()) on conflict (id) do nothing;
  return json_build_object('ok', true, 'username', u);
exception when unique_violation then
  return json_build_object('ok', false, 'error', 'taken');
end $$;

-- Send a friend request by exact username.
-- Returns {ok:true, status:'sent'|'accepted'|'already'} or {ok:false, error:'not_found'|'self'|'no_username'}.
create or replace function public.friend_request(p_username text)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); them uuid; r friendships;
begin
  if me is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  if not exists (select 1 from handles where id = me) then return json_build_object('ok', false, 'error', 'no_username'); end if;
  select id into them from handles where username = lower(trim(coalesce(p_username, '')));
  if them is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if them = me then return json_build_object('ok', false, 'error', 'self'); end if;
  select * into r from friendships where (a = me and b = them) or (a = them and b = me);
  if found then
    if r.status = 'blocked' then return json_build_object('ok', false, 'error', 'not_found'); end if;
    if r.status = 'accepted' then return json_build_object('ok', true, 'status', 'already'); end if;
    if r.a = them then  -- they already asked me, so this accepts it
      update friendships set status = 'accepted' where a = them and b = me;
      return json_build_object('ok', true, 'status', 'accepted');
    end if;
    return json_build_object('ok', true, 'status', 'already');
  end if;
  if (select count(*) from friendships where a = me and status = 'pending') >= 50 then
    return json_build_object('ok', false, 'error', 'too_many');
  end if;
  insert into friendships (a, b) values (me, them);
  return json_build_object('ok', true, 'status', 'sent');
end $$;

-- Accept, decline, cancel, remove, block or unblock. p_action: accept | remove | block | unblock
create or replace function public.friend_update(p_username text, p_action text)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); them uuid; r friendships;
begin
  if me is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  select id into them from handles where username = lower(trim(coalesce(p_username, '')));
  if them is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  select * into r from friendships where (a = me and b = them) or (a = them and b = me);
  if p_action = 'accept' then
    update friendships set status = 'accepted' where a = them and b = me and status = 'pending';
  elsif p_action = 'remove' then
    delete from friendships where ((a = me and b = them) or (a = them and b = me)) and status <> 'blocked';
    delete from friendships where ((a = me and b = them) or (a = them and b = me)) and status = 'blocked' and blocked_by = me;
  elsif p_action = 'block' then
    delete from friendships where (a = me and b = them) or (a = them and b = me);
    insert into friendships (a, b, status, blocked_by) values (me, them, 'blocked', me);
  elsif p_action = 'unblock' then
    delete from friendships where a = me and b = them and status = 'blocked' and blocked_by = me;
  else
    return json_build_object('ok', false, 'error', 'action');
  end if;
  return json_build_object('ok', true);
end $$;

-- Save what I share and my summary. Only the parts I allow are ever shown to friends.
create or replace function public.set_share(p_allow jsonb, p_summary jsonb)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  if octet_length(coalesce(p_summary, '{}'::jsonb)::text) > 20000 then
    return json_build_object('ok', false, 'error', 'too_big');
  end if;
  insert into shares (id, allow, summary, updated_at)
  values (auth.uid(),
          jsonb_build_object('workouts', coalesce((p_allow->>'workouts')::boolean, true),
                             'meals',    coalesce((p_allow->>'meals')::boolean, false),
                             'weight',   coalesce((p_allow->>'weight')::boolean, false)),
          coalesce(p_summary, '{}'::jsonb), now())
  on conflict (id) do update set allow = excluded.allow, summary = excluded.summary, updated_at = now();
  return json_build_object('ok', true);
end $$;

-- Everything the Friends page needs in one call:
-- friends (with only the parts of their summary they allow), requests in and out, people I blocked,
-- and cheers I got in the last 7 days.
create or replace function public.friends_list()
returns json language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  return json_build_object(
    'ok', true,
    'friends', coalesce((
      select json_agg(json_build_object(
        'username', h.username, 'display', h.display,
        'since', f.created_at,
        'updated', s.updated_at,
        'name',     s.summary->'name',
        'workouts', case when coalesce((s.allow->>'workouts')::boolean, true) then s.summary->'workouts' end,
        'streak',   case when coalesce((s.allow->>'workouts')::boolean, true) then s.summary->'streak' end,
        'meals',    case when coalesce((s.allow->>'meals')::boolean, false)   then s.summary->'meals' end,
        'weight',   case when coalesce((s.allow->>'weight')::boolean, false)  then s.summary->'weight' end,
        'cheered',  coalesce((select json_agg(c.kind) from cheers c where c.from_id = me and c.to_id = h.id
                               and c.day = (now() at time zone 'America/New_York')::date), '[]'::json)
      ) order by h.username)
      from friendships f
      join handles h on h.id = case when f.a = me then f.b else f.a end
      left join shares s on s.id = h.id
      where f.status = 'accepted' and (f.a = me or f.b = me)), '[]'::json),
    'incoming', coalesce((select json_agg(json_build_object('username', h.username, 'display', h.display, 'at', f.created_at))
      from friendships f join handles h on h.id = f.a where f.b = me and f.status = 'pending'), '[]'::json),
    'outgoing', coalesce((select json_agg(json_build_object('username', h.username, 'at', f.created_at))
      from friendships f join handles h on h.id = f.b where f.a = me and f.status = 'pending'), '[]'::json),
    'blocked', coalesce((select json_agg(json_build_object('username', h.username))
      from friendships f join handles h on h.id = f.b where f.a = me and f.status = 'blocked' and f.blocked_by = me), '[]'::json),
    'cheers', coalesce((select json_agg(json_build_object('username', h.username, 'kind', c.kind, 'at', c.created_at) order by c.created_at desc)
      from (select * from cheers where to_id = me and created_at > now() - interval '7 days' order by created_at desc limit 30) c
      join handles h on h.id = c.from_id
      where public.are_friends(me, c.from_id)), '[]'::json),
    'allow', (select allow from shares where id = me)
  );
end $$;

-- Cheer a friend (once per kind per day).
create or replace function public.send_cheer(p_username text, p_kind text)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); them uuid;
begin
  if me is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  if p_kind not in ('pray', 'strong', 'fire') then return json_build_object('ok', false, 'error', 'kind'); end if;
  select id into them from handles where username = lower(trim(coalesce(p_username, '')));
  if them is null or not public.are_friends(me, them) then return json_build_object('ok', false, 'error', 'not_friends'); end if;
  insert into cheers (from_id, to_id, kind) values (me, them, p_kind) on conflict do nothing;
  return json_build_object('ok', true);
end $$;

revoke execute on function public.my_handle()                   from public, anon;
revoke execute on function public.set_username(text, text)      from public, anon;
revoke execute on function public.friend_request(text)          from public, anon;
revoke execute on function public.friend_update(text, text)     from public, anon;
revoke execute on function public.set_share(jsonb, jsonb)       from public, anon;
revoke execute on function public.friends_list()                from public, anon;
revoke execute on function public.send_cheer(text, text)        from public, anon;
grant  execute on function public.my_handle()                   to authenticated;
grant  execute on function public.set_username(text, text)      to authenticated;
grant  execute on function public.friend_request(text)          to authenticated;
grant  execute on function public.friend_update(text, text)     to authenticated;
grant  execute on function public.set_share(jsonb, jsonb)       to authenticated;
grant  execute on function public.friends_list()                to authenticated;
grant  execute on function public.send_cheer(text, text)        to authenticated;
