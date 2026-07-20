-- Run this in your Supabase SQL editor

-- 1. Add unit_label column if missing
alter table donation_causes add column if not exists unit_label text;

-- 2. Add raised_amount column if missing
alter table donation_causes add column if not exists raised_amount numeric(12,2) default 0;

-- 3. Add unit_amount column (optional per-unit amount admin can set)
alter table donation_causes add column if not exists unit_amount numeric(12,2) default 0;

-- 3. Add cause_id to donations table so we can link donations to causes
alter table donations add column if not exists cause_id uuid references donation_causes(id) on delete set null;

-- 4. Function: recalculate raised_amount for a cause from successful donations
create or replace function recalculate_raised_amount(p_cause_id uuid)
returns void as $$
begin
  update donation_causes
  set raised_amount = coalesce((
    select sum(amount)
    from donations
    where cause_id = p_cause_id
      and payment_status = 'SUCCESS'
  ), 0),
  updated_at = now()
  where id = p_cause_id;
end;
$$ language plpgsql;

-- 5. Trigger function: fires after insert/update on donations
create or replace function trg_update_cause_raised_amount()
returns trigger as $$
begin
  -- handle UPDATE (status changed)
  if (TG_OP = 'UPDATE') then
    if NEW.cause_id is not null then
      perform recalculate_raised_amount(NEW.cause_id);
    end if;
    -- also recalculate old cause if cause_id changed
    if OLD.cause_id is distinct from NEW.cause_id and OLD.cause_id is not null then
      perform recalculate_raised_amount(OLD.cause_id);
    end if;
  end if;

  -- handle INSERT
  if (TG_OP = 'INSERT') then
    if NEW.cause_id is not null and NEW.payment_status = 'SUCCESS' then
      perform recalculate_raised_amount(NEW.cause_id);
    end if;
  end if;

  return NEW;
end;
$$ language plpgsql;

-- 6. Attach trigger to donations table
drop trigger if exists trg_donations_raised_amount on donations;
create trigger trg_donations_raised_amount
after insert or update of payment_status, cause_id
on donations
for each row
execute function trg_update_cause_raised_amount();

-- 7. Backfill existing data: recalculate raised_amount for all causes
update donation_causes dc
set raised_amount = coalesce((
  select sum(d.amount)
  from donations d
  where d.cause_id = dc.id
    and d.payment_status = 'SUCCESS'
), 0);
