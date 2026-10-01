-- Run once in the Supabase SQL editor for the live-call project. Safe to re-run.
-- Saved contacts (Contacts tab), per user. Mirrors the shape app.src.js already
-- keeps on the device: name + country code + national number, and `target` =
-- cc || number as DIGITS ONLY (no "+", spaces or dashes) - exactly what the
-- WaCalls call route wants and what `startCall` strips a number down to.
create table if not exists public.contacts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  cc         text not null,
  number     text not null,
  target     text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_target_digits check (target ~ '^[0-9]{7,16}$'),
  unique (user_id, target)
);

create index if not exists contacts_user_name_idx on public.contacts (user_id, name);

create or replace function public.contacts_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists contacts_touch on public.contacts;
create trigger contacts_touch before update on public.contacts
  for each row execute function public.contacts_touch_updated_at();

alter table public.contacts enable row level security;

drop policy if exists "own contacts only" on public.contacts;
create policy "own contacts only"
  on public.contacts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
