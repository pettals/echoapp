create table if not exists public.billing_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_entitlements (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'free' check (tier in ('free', 'pro_lifetime')),
  active boolean not null default false,
  source text not null default 'stripe',
  stripe_checkout_session_id text,
  stripe_customer_id text,
  granted_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  livemode boolean not null default false,
  processed_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists billing_customers_set_updated_at on public.billing_customers;
create trigger billing_customers_set_updated_at
before update on public.billing_customers
for each row execute function public.set_updated_at();

drop trigger if exists billing_entitlements_set_updated_at on public.billing_entitlements;
create trigger billing_entitlements_set_updated_at
before update on public.billing_entitlements
for each row execute function public.set_updated_at();

alter table public.billing_customers enable row level security;
alter table public.billing_entitlements enable row level security;
alter table public.stripe_webhook_events enable row level security;

drop policy if exists "Users can read their own billing customer" on public.billing_customers;
create policy "Users can read their own billing customer"
on public.billing_customers
for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "Users can read their own entitlement" on public.billing_entitlements;
create policy "Users can read their own entitlement"
on public.billing_entitlements
for select
to authenticated
using (auth.uid() = user_id);
