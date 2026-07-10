create extension if not exists pgcrypto;

create table if not exists donations (
  id uuid primary key default gen_random_uuid(),
  order_id text unique not null,
  cashfree_payment_id text unique,
  donor_name text,
  donor_email text,
  donor_phone text,
  cause_id uuid references donation_causes(id) on delete set null,
  amount numeric(12,2) not null check (amount >= 1),
  payment_status text not null default 'PENDING'
    check (payment_status in ('PENDING', 'SUCCESS', 'FAILED', 'USER_DROPPED', 'CANCELLED')),
  donor_number bigint unique,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table donations add column if not exists cashfree_payment_id text;
alter table donations add column if not exists donor_name text;
alter table donations add column if not exists donor_email text;
alter table donations add column if not exists donor_phone text;
alter table donations add column if not exists cause_id uuid references donation_causes(id) on delete set null;
alter table donations add column if not exists amount numeric(12,2) not null default 1;
alter table donations add column if not exists payment_status text not null default 'PENDING';
alter table donations add column if not exists donor_number bigint;
alter table donations add column if not exists updated_at timestamptz default now();

create unique index if not exists donations_order_id_key on donations(order_id);
create unique index if not exists donations_cashfree_payment_id_key
  on donations(cashfree_payment_id)
  where cashfree_payment_id is not null;
create unique index if not exists donations_donor_number_key
  on donations(donor_number)
  where donor_number is not null;
create index if not exists donations_payment_status_idx on donations(payment_status);
create index if not exists donations_created_at_idx on donations(created_at desc);
create index if not exists donations_cause_id_idx on donations(cause_id);

create sequence if not exists donations_donor_number_seq;

select setval(
  'donations_donor_number_seq',
  greatest(coalesce((select max(donor_number) from donations), 0), 0) + 1,
  false
);

create table if not exists payment_webhooks (
  id uuid primary key default gen_random_uuid(),
  event_name text,
  cashfree_order_id text,
  cashfree_payment_id text,
  payment_status text,
  idempotency_key text unique,
  payload jsonb not null,
  created_at timestamptz default now()
);

alter table payment_webhooks add column if not exists payment_status text;
alter table payment_webhooks add column if not exists idempotency_key text;

create unique index if not exists payment_webhooks_idempotency_key
  on payment_webhooks(idempotency_key)
  where idempotency_key is not null;
create index if not exists payment_webhooks_order_id_idx on payment_webhooks(cashfree_order_id);
create index if not exists payment_webhooks_created_at_idx on payment_webhooks(created_at desc);

create or replace function mark_donation_success(
  p_order_id text,
  p_cashfree_payment_id text default null
)
returns table (
  id uuid,
  order_id text,
  cashfree_payment_id text,
  donor_number bigint,
  payment_status text,
  amount numeric,
  donor_name text,
  cause_id uuid,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  donation_row donations%rowtype;
  next_donor_number bigint;
begin
  select *
  into donation_row
  from donations
  where donations.order_id = p_order_id
  for update;

  if not found then
    raise exception 'Donation order % not found', p_order_id using errcode = 'P0002';
  end if;

  if donation_row.payment_status = 'SUCCESS' then
    return query
    select
      donation_row.id,
      donation_row.order_id,
      donation_row.cashfree_payment_id,
      donation_row.donor_number,
      donation_row.payment_status,
      donation_row.amount,
      donation_row.donor_name,
      donation_row.cause_id,
      donation_row.created_at,
      donation_row.updated_at;
    return;
  end if;

  if donation_row.donor_number is null then
    next_donor_number := nextval('donations_donor_number_seq');
  else
    next_donor_number := donation_row.donor_number;
  end if;

  update donations
  set
    payment_status = 'SUCCESS',
    cashfree_payment_id = coalesce(p_cashfree_payment_id, donations.cashfree_payment_id),
    donor_number = coalesce(donations.donor_number, next_donor_number),
    updated_at = now()
  where donations.id = donation_row.id
  returning *
  into donation_row;

  return query
  select
    donation_row.id,
    donation_row.order_id,
    donation_row.cashfree_payment_id,
    donation_row.donor_number,
    donation_row.payment_status,
    donation_row.amount,
    donation_row.donor_name,
    donation_row.cause_id,
    donation_row.created_at,
    donation_row.updated_at;
end;
$$;
