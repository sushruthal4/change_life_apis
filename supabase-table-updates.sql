create extension if not exists "uuid-ossp";

create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  first_name text,
  last_name text,
  email text unique not null,
  mobile text,
  role text default 'admin',
  twofactorsecret text,
  twofactorenabled boolean default false,
  is_active boolean default true,
  created_at timestamp default now()
);

alter table users add column if not exists first_name text;
alter table users add column if not exists last_name text;
alter table users add column if not exists mobile text;
alter table users add column if not exists role text default 'admin';
alter table users add column if not exists twofactorsecret text;
alter table users add column if not exists twofactorenabled boolean default false;
alter table users add column if not exists is_active boolean default true;
alter table users add column if not exists created_at timestamp default now();

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'users' and column_name = 'twoFactorSecret'
  ) then
    execute 'update users set twofactorsecret = coalesce(twofactorsecret, "twoFactorSecret")';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_name = 'users' and column_name = 'two_factor_secret'
  ) then
    execute 'update users set twofactorsecret = coalesce(twofactorsecret, two_factor_secret)';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_name = 'users' and column_name = 'twoFactorEnabled'
  ) then
    execute 'update users set twofactorenabled = coalesce("twoFactorEnabled", twofactorenabled)';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_name = 'users' and column_name = 'two_factor_enabled'
  ) then
    execute 'update users set twofactorenabled = coalesce(two_factor_enabled, twofactorenabled)';
  end if;
end $$;

create table if not exists donation_causes (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  slug text unique,
  short_description text,
  full_description text,
  target_amount numeric(12,2) default 0,
  raised_amount numeric(12,2) default 0,
  category text,
  city text,
  beneficiaries text,
  cover_image text,
  images jsonb default '[]'::jsonb,
  videos jsonb default '[]'::jsonb,
  is_featured boolean default false,
  is_active boolean default true,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

alter table donation_causes add column if not exists slug text;
alter table donation_causes add column if not exists short_description text;
alter table donation_causes add column if not exists full_description text;
alter table donation_causes add column if not exists target_amount numeric(12,2) default 0;
alter table donation_causes add column if not exists raised_amount numeric(12,2) default 0;
alter table donation_causes add column if not exists category text;
alter table donation_causes add column if not exists city text;
alter table donation_causes add column if not exists beneficiaries text;
alter table donation_causes add column if not exists cover_image text;
alter table donation_causes add column if not exists images jsonb default '[]'::jsonb;
alter table donation_causes add column if not exists videos jsonb default '[]'::jsonb;
alter table donation_causes add column if not exists is_featured boolean default false;
alter table donation_causes add column if not exists is_active boolean default true;
alter table donation_causes add column if not exists updated_at timestamp default now();

create table if not exists payment_settings (
  id uuid primary key default uuid_generate_v4(),
  payment_name text not null,
  upi_id text,
  upi_payee_name text,
  qr_image text,
  bank_name text,
  account_name text,
  account_number text,
  ifsc_code text,
  branch_name text,
  is_active boolean default true,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

alter table payment_settings add column if not exists upi_id text;
alter table payment_settings add column if not exists upi_payee_name text;
alter table payment_settings add column if not exists qr_image text;
alter table payment_settings add column if not exists bank_name text;
alter table payment_settings add column if not exists account_name text;
alter table payment_settings add column if not exists account_number text;
alter table payment_settings add column if not exists ifsc_code text;
alter table payment_settings add column if not exists branch_name text;
alter table payment_settings add column if not exists is_active boolean default true;
alter table payment_settings add column if not exists updated_at timestamp default now();

create table if not exists site_content (
  id uuid primary key default uuid_generate_v4(),
  key text unique not null,
  content jsonb not null default '{}'::jsonb,
  created_at timestamp default now(),
  updated_at timestamp default now()
);

insert into storage.buckets (id, name, public)
values
  ('images', 'images', true),
  ('videos', 'videos', true),
  ('documents', 'documents', true)
on conflict (id) do update set public = excluded.public;

insert into site_content (key, content)
values (
  'main',
  '{
    "organizationName": "Heart Fuel Foundation",
    "tagline": "Give with heart. See real impact.",
    "supportEmail": "",
    "supportPhone": "",
    "whatsappNumber": "",
    "address": "",
    "hero": {
      "eyebrow": "Transparent donations with photo and video proof",
      "title": "Heart Fuel Foundation",
      "description": "Support verified causes, donate directly, and see the real people your kindness reaches.",
      "image": ""
    },
    "about": {
      "title": "Giving with proof, care, and accountability",
      "description": "Heart Fuel makes giving simple, transparent, and meaningful.",
      "missionTitle": "Our Mission",
      "mission": "Turn every donation into verified action.",
      "visionTitle": "Our Vision",
      "vision": "Giving rooted in empathy, transparency, and human connection.",
      "primaryImage": "",
      "secondaryImage": ""
    },
    "homeImpact": [
      {
        "label": "Families Reached",
        "value": "9899+",
        "text": "Help delivered through verified campaigns."
      },
      {
        "label": "Proof Updates",
        "value": "Photo + Video",
        "text": "Impact media uploaded by the team."
      },
      {
        "label": "Direct Giving",
        "value": "UPI + Bank",
        "text": "Donors pay through configured payment settings."
      },
      {
        "label": "Local Drives",
        "value": "On Ground",
        "text": "Causes tracked with real progress."
      }
    ],
    "impact": {
      "donors": "",
      "raised": "",
      "lives": "",
      "meals": "",
      "proof": "Photos and videos are shared after every verified drive."
    },
    "footer": {
      "title": "Give with trust. See every step.",
      "note": "Every contribution helps create visible, verifiable impact.",
      "image": "",
      "mapImage": ""
    },
    "socials": {},
    "donationActivity": []
  }'::jsonb
)
on conflict (key) do nothing;
