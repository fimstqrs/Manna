-- Manna Version 170: profile pictures for Friends.
-- Run once in Supabase → SQL Editor. Safe to run again.

-- A small square photo (about 128 × 128, stored as a compressed image string).
alter table public.handles add column if not exists pic text;
alter table public.handles drop constraint if exists handles_pic_check;
alter table public.handles add constraint handles_pic_check
  check (pic is null or (char_length(pic) <= 40000 and pic ~ '^data:image/(jpeg|webp|png);base64,'));

-- Set or remove your own photo.
create or replace function public.set_pic(p_pic text)
returns json language plpgsql security definer set search_path = public as $$
declare v text := nullif(trim(coalesce(p_pic, '')), '');
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'login'); end if;
  if v is not null and (char_length(v) > 40000 or v !~ '^data:image/(jpeg|webp|png);base64,') then
    return json_build_object('ok', false, 'error', 'invalid');
  end if;
  update handles set pic = v, updated_at = now() where id = auth.uid();
  if not found then return json_build_object('ok', false, 'error', 'no_username'); end if;
  return json_build_object('ok', true);
end $$;

-- Photos you are allowed to see: your own, your friends', and people with a request between you.
create or replace function public.friend_pics()
returns json language sql security definer set search_path = public stable as $$
  select coalesce(json_object_agg(h.username, h.pic), '{}'::json)
  from handles h
  where h.pic is not null and (
    h.id = auth.uid() or exists (
      select 1 from friendships f
      where ((f.a = auth.uid() and f.b = h.id) or (f.b = auth.uid() and f.a = h.id))
        and f.status in ('accepted', 'pending')));
$$;

revoke all on function public.set_pic(text), public.friend_pics() from public, anon;
grant execute on function public.set_pic(text), public.friend_pics() to authenticated;
