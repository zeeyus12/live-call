-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
--
-- WhatsApp connect lock. Replaces the per-user "Lock Anam key" control.
--   * Locked by default: a user with no row here cannot pair WhatsApp or call.
--   * Admin opens it per user and chooses how many minutes to give.
--   * Pro (plan = 'pro') is unlimited. The payment flow comes later and will
--     just flip plan / pro_until on this row.
create table if not exists public.whatsapp_access (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  unlocked        boolean     not null default false,
  minutes_granted numeric     not null default 0 check (minutes_granted >= 0),
  minutes_used    numeric     not null default 0 check (minutes_used >= 0),
  plan            text        not null default 'free' check (plan in ('free', 'pro')),
  pro_until       timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.whatsapp_access enable row level security;

-- A signed-in user may READ their own row (to show "minutes left").
-- Nobody but the server (service role) can write it.
drop policy if exists "read own whatsapp access" on public.whatsapp_access;
create policy "read own whatsapp access"
  on public.whatsapp_access for select
  using (auth.uid() = user_id);

-- Atomic usage meter, called by the server when a call ends.
create or replace function public.whatsapp_add_minutes_used(p_user uuid, p_minutes numeric)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.whatsapp_access (user_id, minutes_used)
  values (p_user, greatest(p_minutes, 0))
  on conflict (user_id) do update
    set minutes_used = public.whatsapp_access.minutes_used + greatest(p_minutes, 0),
        updated_at = now();
$$;

revoke all on function public.whatsapp_add_minutes_used(uuid, numeric) from public, anon, authenticated;
grant execute on function public.whatsapp_add_minutes_used(uuid, numeric) to service_role;

-- The Anam key lock is gone from the admin page. Clear any existing locks so
-- nobody is left locked out with no way to be unlocked. Delete this statement
-- if you want to keep specific users locked and handle them by hand.
update public.video_call_settings set anam_key_locked = false where anam_key_locked;
