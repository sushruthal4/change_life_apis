-- ============================================================
-- Run this in Supabase SQL Editor
-- Adds all new columns needed by the current frontend/backend
-- ============================================================

-- 1. unit_label: text label shown on donation multiplier (e.g. "Plate", "Paw")
alter table donation_causes add column if not exists unit_label text;

-- 2. unit_amount: optional per-unit amount admin can set (shown in progress block)
alter table donation_causes add column if not exists unit_amount numeric(12,2) default 0;

-- 3. raised_amount: auto-updated by trigger from successful donations
alter table donation_causes add column if not exists raised_amount numeric(12,2) default 0;

-- 4. cause_id on donations: links a donation to a cause (already in cashfree-donations-tables.sql, safe to re-run)
alter table donations add column if not exists cause_id uuid references donation_causes(id) on delete set null;

-- ============================================================
-- Trigger: auto-update raised_amount on donation_causes
-- whenever a donation is marked SUCCESS
-- ============================================================

-- Function: recalculate raised_amount for a given cause
create or replace function recalculate_raised_amount(p_cause_id uuid)
returns void as $$
begin
  update donation_causes
  set
    raised_amount = coalesce((
      select sum(amount)
      from donations
      where cause_id = p_cause_id
        and payment_status = 'SUCCESS'
    ), 0),
    updated_at = now()
  where id = p_cause_id;
end;
$$ language plpgsql;

-- Trigger function
create or replace function trg_update_cause_raised_amount()
returns trigger as $$
begin
  if (TG_OP = 'UPDATE') then
    if NEW.cause_id is not null then
      perform recalculate_raised_amount(NEW.cause_id);
    end if;
    if OLD.cause_id is distinct from NEW.cause_id and OLD.cause_id is not null then
      perform recalculate_raised_amount(OLD.cause_id);
    end if;
  end if;

  if (TG_OP = 'INSERT') then
    if NEW.cause_id is not null and NEW.payment_status = 'SUCCESS' then
      perform recalculate_raised_amount(NEW.cause_id);
    end if;
  end if;

  return NEW;
end;
$$ language plpgsql;

-- Attach trigger (drop first to avoid duplicate)
drop trigger if exists trg_donations_raised_amount on donations;
create trigger trg_donations_raised_amount
after insert or update of payment_status, cause_id
on donations
for each row
execute function trg_update_cause_raised_amount();

-- ============================================================
-- Backfill: recalculate raised_amount for all existing causes
-- ============================================================
update donation_causes dc
set raised_amount = coalesce((
  select sum(d.amount)
  from donations d
  where d.cause_id = dc.id
    and d.payment_status = 'SUCCESS'
), 0);
