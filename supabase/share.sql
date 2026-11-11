-- Manna: share workouts with friends. Run this once in Supabase > SQL Editor > New query > Run.
-- Needs friends.sql to have been run first. Safe to run again.
--
-- How it stays private:
--   * Nobody can read the table directly. Everything goes through the functions below,
--     which always use the signed-in person (auth.uid()).
--   * You can only send to people who are already your friends.
--   * You only ever see what was sent to you, and you can remove it.

create table if not exists public.shared_items (
  id          bigserial primary key,
  from_id     uuid not null references auth.users(id) on delete cascade,
  to_id       uuid not null references auth.users(id) on delete cascade,
  kind        text not null default 'workout' check (kind in ('workout', 'session')),
  payload     jsonb not null check (octet_length(payload::text) <= 20000),
  created_at  timestamptz not null default now(),
  seen        boolean not null default false
);
create index if not exists shared_items_to on public.shared_items (to_id, created_at desc);

alter table public.shared_items enable row level security;
revoke all on public.shared_items from anon, authenticated;

-- Send one or more workouts to one or more friends.
-- p_items is a JSON array of {kind, payload}. Returns {ok:true, sent:n} or {ok:false, error}.
create or replace function public.share_items(p_usernames text[], p_items jsonb)
returns json language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); u text; them uuid; it jsonb; n int := 0;
begin
  if me is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  if p_usernames is null or array_length(p_usernames, 1) is null then return json_build_object('ok', false, 'error', 'nobody'); end if;
  if array_length(p_usernames, 1) > 20 then return json_build_object('ok', false, 'error', 'too_many'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 20 then
    return json_build_object('ok', false, 'error', 'items');
  end if;
  -- a gentle limit so nobody can flood their friends
  if (select count(*) from shared_items where from_id = me and created_at > now() - interval '1 day') > 200 then
    return json_build_object('ok', false, 'error', 'too_many');
  end if;
  foreach u in array p_usernames loop
    select id into them from handles where username = lower(trim(coalesce(u, '')));
    if them is null or not public.are_friends(me, them) then continue; end if;
    for it in select * from jsonb_array_elements(p_items) loop
      if octet_length((it->'payload')::text) > 20000 then continue; end if;
      insert into shared_items (from_id, to_id, kind, payload)
      values (me, them, case when it->>'kind' = 'session' then 'session' else 'workout' end, it->'payload');
      n := n + 1;
    end loop;
  end loop;
  return json_build_object('ok', true, 'sent', n);
end $$;

-- What friends have sent me in the last 30 days.
create or replace function public.shared_inbox()
returns json language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  return json_build_object('ok', true, 'items', coalesce((
    select json_agg(json_build_object('id', s.id, 'kind', s.kind, 'payload', s.payload, 'at', s.created_at,
                                      'seen', s.seen, 'from', h.username, 'display', h.display) order by s.created_at desc)
    from (select * from shared_items where to_id = me and created_at > now() - interval '30 days'
          order by created_at desc limit 50) s
    join handles h on h.id = s.from_id), '[]'::json));
end $$;

-- Mark as seen, or remove something that was sent to me. p_action: seen | remove
create or replace function public.shared_update(p_id bigint, p_action text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'signin'); end if;
  if p_action = 'remove' then
    delete from shared_items where id = p_id and to_id = auth.uid();
  elsif p_action = 'seen' then
    update shared_items set seen = true where id = p_id and to_id = auth.uid();
  else
    return json_build_object('ok', false, 'error', 'action');
  end if;
  return json_build_object('ok', true);
end $$;

revoke execute on function public.share_items(text[], jsonb)   from public, anon;
revoke execute on function public.shared_inbox()               from public, anon;
revoke execute on function public.shared_update(bigint, text)  from public, anon;
grant  execute on function public.share_items(text[], jsonb)   to authenticated;
grant  execute on function public.shared_inbox()               to authenticated;
grant  execute on function public.shared_update(bigint, text)  to authenticated;
