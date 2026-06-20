-- Midnite Sentinel — SaaS auth schema (run in Supabase SQL editor)
-- Auth: Supabase Auth (Google OAuth + email/password, email confirmation OFF).
-- Midnite credentials are stored ENCRYPTED (AES-256-GCM, server-side key) in enc_password.
-- All access to midnite_accounts goes through the /api/midnite proxy using the service role;
-- RLS below is defense-in-depth for the anon key.

-- ── profiles: one row per auth user, carries the app role ───────────────────
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text,
  role       text not null default 'user',   -- 'user' | 'admin'
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select using (auth.uid() = id);

-- Auto-create a profile when a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

-- ── midnite_accounts: linked Midnite logins (password encrypted) ────────────
create table if not exists public.midnite_accounts (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users on delete cascade,
  label               text,
  midnite_username    text not null,
  midnite_username_lc text generated always as (lower(midnite_username)) stored,
  enc_password        text not null,          -- AES-256-GCM ciphertext (base64 iv|tag|data)
  account_type        text,                   -- 'installer' | 'enduser'
  created_at          timestamptz not null default now()
);
-- A given Midnite account can be linked to exactly one SaaS login (globally unique).
create unique index if not exists midnite_accounts_global_unique
  on public.midnite_accounts (midnite_username_lc);
alter table public.midnite_accounts enable row level security;
drop policy if exists "own accounts read" on public.midnite_accounts;
create policy "own accounts read" on public.midnite_accounts for select using (auth.uid() = user_id);

-- Make yourself an admin (admins may link multiple Midnite accounts):
--   update public.profiles set role = 'admin' where email = 'jason@floridasolardesigngroup.com';

-- ── profile details (display name + avatar) ─────────────────────────────────
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_url   text;

-- ── per-site photos (keyed by user + the Midnite site name) ─────────────────
create table if not exists public.site_photos (
  user_id    uuid not null references auth.users on delete cascade,
  site_name  text not null,
  url        text not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, site_name)
);
alter table public.site_photos enable row level security;
drop policy if exists "own site photos read" on public.site_photos;
create policy "own site photos read" on public.site_photos for select using (auth.uid() = user_id);

-- ── storage buckets (public read) for avatars + site photos ─────────────────
insert into storage.buckets (id, name, public) values ('avatars','avatars',true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('sites','sites',true)     on conflict (id) do nothing;
-- Authenticated users may write only inside their own <uid>/ folder.
drop policy if exists "media write own folder" on storage.objects;
create policy "media write own folder" on storage.objects for all to authenticated
  using      (bucket_id in ('avatars','sites') and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id in ('avatars','sites') and (storage.foldername(name))[1] = auth.uid()::text);

-- ═══════════════════════════════════════════════════════════════════════════
-- Notifications / alerts (Settings → Notifications + the heartbeat cron).
-- Idempotent — safe to re-run. All writes go through /api/midnite (service role)
-- and pages/api/notifications/heartbeat.js; RLS below is defense-in-depth for the
-- anon key (users may only read their own rows).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── notification_rules: one alert rule per device + trigger ──────────────────
-- trigger_type values MUST match TRIGGER_TYPES in lib/notifications/triggers.js
-- (that module is the single source of truth; alertrule_save also validates
-- against it at write time). device_id = the inverter serial number.
create table if not exists public.notification_rules (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users on delete cascade,
  account_id         uuid references public.midnite_accounts on delete cascade,
  site_name          text,
  device_id          text not null,
  device_label       text,
  name               text,
  trigger_type       text not null,
  threshold_value    double precision,
  channel            text not null default 'email',
  enabled            boolean not null default true,
  cooldown_minutes   integer not null default 60,
  last_triggered_at  timestamptz,
  trigger_after_time text,            -- optional "HH:MM" time-gate (local)
  created_at         timestamptz not null default now()
);
-- Keep CHECKs in lockstep with lib/notifications/triggers.js.
alter table public.notification_rules drop constraint if exists notification_rules_trigger_chk;
alter table public.notification_rules add constraint notification_rules_trigger_chk check (trigger_type in (
  'battery_soc_below','battery_soc_above','battery_soh_below',
  'battery_temp_above','inverter_temp_above',
  'load_power_above','grid_import_above','grid_export_above',
  'grid_voltage_above','grid_voltage_below',
  'pv_today_below','device_offline'
));
alter table public.notification_rules drop constraint if exists notification_rules_channel_chk;
alter table public.notification_rules add constraint notification_rules_channel_chk check (channel in ('email'));
create index if not exists notification_rules_user_device on public.notification_rules (user_id, device_id);
create index if not exists notification_rules_device_enabled on public.notification_rules (device_id, enabled);
alter table public.notification_rules enable row level security;
drop policy if exists "own rules read" on public.notification_rules;
create policy "own rules read" on public.notification_rules for select using (auth.uid() = user_id);

-- ── notification_log: send audit (every outcome: sent/failed/skipped/capped) ──
create table if not exists public.notification_log (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  rule_id      uuid references public.notification_rules on delete set null,
  device_id    text,
  trigger_type text,
  channel      text,
  status       text not null,        -- 'sent' | 'failed' | 'skipped' | 'capped'
  value        double precision,
  detail       text,
  sent_at      timestamptz not null default now()
);
create index if not exists notification_log_user_time on public.notification_log (user_id, sent_at desc);
alter table public.notification_log enable row level security;
drop policy if exists "own log read" on public.notification_log;
create policy "own log read" on public.notification_log for select using (auth.uid() = user_id);

-- ── device_snapshots: time-series captured by the heartbeat (offline detection) ──
create table if not exists public.device_snapshots (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users on delete cascade,
  account_id  uuid references public.midnite_accounts on delete cascade,
  device_id   text not null,
  site_name   text,
  online      boolean not null default true,
  metrics     jsonb not null default '{}'::jsonb,
  captured_at timestamptz not null default now()
);
create index if not exists device_snapshots_device_time on public.device_snapshots (device_id, captured_at desc);
create index if not exists device_snapshots_device_online on public.device_snapshots (device_id, online, captured_at desc);
alter table public.device_snapshots enable row level security;
drop policy if exists "own snapshots read" on public.device_snapshots;
create policy "own snapshots read" on public.device_snapshots for select using (auth.uid() = user_id);

-- ── notification_quota: atomic per-user/day send counter (daily cap) ─────────
create table if not exists public.notification_quota (
  user_id uuid not null references auth.users on delete cascade,
  day     date not null,
  count   integer not null default 0,
  primary key (user_id, day)
);
alter table public.notification_quota enable row level security;
drop policy if exists "own quota read" on public.notification_quota;
create policy "own quota read" on public.notification_quota for select using (auth.uid() = user_id);

-- Atomic increment — inserts or bumps today's counter, returns the new count.
create or replace function public.notif_quota_increment(p_user uuid, p_day date, p_cap int)
returns int language plpgsql security definer set search_path = public as $$
declare new_count int;
begin
  insert into public.notification_quota (user_id, day, count) values (p_user, p_day, 1)
  on conflict (user_id, day) do update set count = public.notification_quota.count + 1
  returning count into new_count;
  return new_count;  -- p_cap kept for signature/forward-compat; the app compares.
end; $$;

-- ── notification_digests: scaffold for periodic summary emails (not yet sent) ─
create table if not exists public.notification_digests (
  user_id    uuid not null references auth.users on delete cascade,
  account_id uuid references public.midnite_accounts on delete cascade,
  frequency  text not null default 'daily',     -- 'daily' | 'weekly'
  channel    text not null default 'email',
  enabled    boolean not null default false,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, frequency)
);
alter table public.notification_digests enable row level security;
drop policy if exists "own digests read" on public.notification_digests;
create policy "own digests read" on public.notification_digests for select using (auth.uid() = user_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- Site sharing (per-site, VIEW-ONLY). An owner shares one of their sites with a
-- recipient by email. Credentials never move: the proxy fetches the shared site
-- using the OWNER's stored creds (service role), scoped to the shared site only.
-- Idempotent — safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.site_shares (
  id                  uuid primary key default gen_random_uuid(),
  owner_user_id       uuid not null references auth.users on delete cascade,
  owner_account_id    uuid not null references public.midnite_accounts on delete cascade,
  site_name           text not null,
  shared_with_email   text not null,                                   -- lowercased
  shared_with_user_id uuid references auth.users on delete cascade,    -- null until the recipient signs up
  role                text not null default 'viewer',
  status              text not null default 'pending',                 -- 'pending' | 'active' | 'revoked'
  created_at          timestamptz not null default now(),
  accepted_at         timestamptz,
  revoked_at          timestamptz
);
-- One live share per (owner account, site, recipient email).
create unique index if not exists site_shares_unique on public.site_shares (owner_account_id, site_name, shared_with_email);
create index if not exists site_shares_recipient on public.site_shares (shared_with_user_id);
create index if not exists site_shares_email on public.site_shares (shared_with_email);
alter table public.site_shares enable row level security;
-- Defense-in-depth (all writes go through the service-role proxy): the owner and the
-- recipient may each read a share row.
drop policy if exists "site shares read" on public.site_shares;
create policy "site shares read" on public.site_shares for select
  using (auth.uid() = owner_user_id or auth.uid() = shared_with_user_id);

