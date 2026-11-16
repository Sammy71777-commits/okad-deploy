-- ============================================================
--   OKAD Africa — Supabase Schema (Free Tier)
-- ============================================================
-- Run this in Supabase → SQL Editor (one-time setup).
-- Creates: users / orders / cooperation / kyc_logs
-- Indexes + RLS policies for anon key access (development).
-- ============================================================

-- 1. users (real-name registered customers)
create table if not exists public.users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  name        text,
  phone       text default '',
  country     text,
  id_type     text default 'national_id',
  id_number   text,
  ip          text,
  kyc_status  text default 'pending',
  kyc_reason  text default '',
  kyc_ts      bigint default 0,
  kyc_by      text default '',
  reg_ts      bigint,
  last_login  bigint,
  orders_count int default 0,
  total_spent  numeric default 0,
  created_at  timestamptz default now()
);

-- 2. orders (each user's cargo shipment orders)
create table if not exists public.orders (
  id          text primary key,
  user_email  text references public.users(email) on delete cascade,
  data        jsonb not null,
  status      text default 'review_pending',
  created_at  timestamptz default now()
);

-- 3. cooperation (business cooperation inquiries)
create table if not exists public.cooperation (
  id          text primary key,
  data        jsonb not null,
  created_at  timestamptz default now()
);

-- 4. kyc_logs (audit trail for KYC review actions)
create table if not exists public.kyc_logs (
  id          uuid primary key default gen_random_uuid(),
  user_email  text,
  action      text not null,    -- approved | rejected | resubmit | pending
  reason      text,
  operator    text,
  created_at  timestamptz default now()
);

-- 5. config (site-wide configuration: WhatsApp number, referral, contact)
create table if not exists public.config (
  key         text primary key,    -- 'site' = all-in-one config
  data        jsonb not null       -- { whatsapp:{...}, referral:{...}, contact:{...} }
);

-- Seed default config
insert into public.config (key, data) values ('site', '{"whatsapp":{"number":"233505615533","label":"Chat on WhatsApp","text":"Hello OKAD AFRICA, I want a shipping quote from China to Africa."},"referral":{"code":"OKAD-NEW10","reward":"$10","title":"Share OKAD & Earn $10","desc":"Invite friends — they get $10 off first order, you earn $10 credit"},"contact":{"email":"support@okad.africa","hours":"Mon-Fri 9:00-18:00 GMT"}}'::jsonb)
on conflict (key) do nothing;

-- ============================================================
--   Indexes
-- ============================================================
create index if not exists idx_orders_user        on public.orders(user_email);
create index if not exists idx_orders_status      on public.orders(status);
create index if not exists idx_orders_created     on public.orders(created_at desc);
create index if not exists idx_users_kyc          on public.users(kyc_status);
create index if not exists idx_users_reg          on public.users(reg_ts desc);
create index if not exists idx_kyc_logs_user      on public.kyc_logs(user_email);
create index if not exists idx_kyc_logs_created   on public.kyc_logs(created_at desc);
create index if not exists idx_cooperation_created on public.cooperation(created_at desc);
create index if not exists idx_config_key on public.config(key);

-- ============================================================
--   Row-Level Security (RLS)
-- ============================================================
-- Development: anon key has full access. Production should restrict.
-- Switch policies to use auth.uid() once you add Supabase Auth.

alter table public.users        enable row level security;
alter table public.orders       enable row level security;
alter table public.cooperation  enable row level security;
alter table public.kyc_logs     enable row level security;
alter table public.config       enable row level security;

create policy "anon_all_users"
  on public.users for all
  using (true) with check (true);

create policy "anon_all_orders"
  on public.orders for all
  using (true) with check (true);

create policy "anon_all_cooperation"
  on public.cooperation for all
  using (true) with check (true);

create policy "anon_all_kyc_logs"
  on public.kyc_logs for all
  using (true) with check (true);

create policy "anon_all_config"
  on public.config for all
  using (true) with check (true);

-- ============================================================
--   Optional: helpful views
-- ============================================================
create or replace view public.v_kyc_pending as
  select email, name, country, id_type, id_number, ip, reg_ts, kyc_status
  from public.users
  where kyc_status = 'pending'
  order by reg_ts asc;

create or replace view public.v_order_stats as
  select
    user_email,
    count(*) as order_count,
    sum(case when status='paid' then 1 else 0 end) as paid_count,
    sum(case when status='completed' then 1 else 0 end) as completed_count,
    max(created_at) as last_order_at
  from public.orders
  group by user_email;

-- ============================================================
--   Done. Verify with:
-- ============================================================
-- select count(*) from public.users;
-- select * from public.v_kyc_pending limit 5;