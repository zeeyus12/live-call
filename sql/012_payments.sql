-- Payments, for the admin Revenue page. Provider-agnostic: whichever payment
-- provider you connect, its webhook should insert one row per successful
-- payment (status 'paid'). provider_ref is unique so a retried webhook cannot
-- record the same payment twice. Service-role only (RLS on, no policies).

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'USD',
  status text not null default 'paid' check (status in ('paid', 'refunded', 'failed')),
  provider text,
  provider_ref text unique,
  description text,
  paid_at timestamptz not null default now()
);
create index if not exists payments_paid_idx on payments (status, paid_at desc);
alter table payments enable row level security;
