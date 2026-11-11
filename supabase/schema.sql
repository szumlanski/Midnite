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
alter table public.profiles add column if not exists display_name      text;
alter table public.profiles add column if not exists avatar_url        text;
-- Set to true once admin(s) have been notified of this signup; prevents repeat emails.
alter table public.profiles add column if not exists signup_notified   boolean not null default false;

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

-- ── notification_digests: daily recap email config (sent by the hourly cron) ──
-- One row per (user, frequency). The digest cron (pages/api/notifications/digest.js)
-- runs hourly and emails each user whose send_hour matches the current hour in
-- their timezone and who hasn't been sent today (last_sent_date guard).
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
-- Config columns (idempotent — added after the original scaffold shipped).
alter table public.notification_digests add column if not exists send_hour      integer not null default 7;   -- 0–23, local to `timezone`
alter table public.notification_digests add column if not exists timezone       text    not null default 'America/New_York';
alter table public.notification_digests add column if not exists site_name      text;        -- null = all sites in the account
alter table public.notification_digests add column if not exists last_sent_date date;        -- idempotency (in `timezone`)
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

-- ── Diagnostics captures (admin-only, read-only raw data) ────────────────────
-- One row per "Download diagnostics" click: the raw vendor responses for every inverter
-- at a site plus what the app made of them. Written and read only by the service-role
-- proxy (no RLS policies on purpose = no client access). Safe to delete old rows.
create table if not exists public.diagnostics (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users on delete set null,
  site_name   text,
  account_id  uuid references public.midnite_accounts on delete set null,
  payload     jsonb not null
);
create index if not exists diagnostics_created_at on public.diagnostics (created_at desc);
alter table public.diagnostics enable row level security;

-- ── Generator control (see docs/generator-plan.md) ──────────────────────────
-- Everything is keyed by site_key = the site's inverter serials, sorted and joined with ",".
-- The installer login and an end-user login that link the same physical site share one
-- config and one activity log. RLS on with NO policies: only the service-role API routes
-- (pages/api/generator.js and the tick cron) read or write these tables.

-- Which sites have generator control, and which inverter the generator hangs off.
create table if not exists public.gen_sites (
  site_key         text primary key,
  site_name        text not null,
  enabled          boolean not null default false,
  timezone         text not null default 'America/New_York',
  master_sn        text,
  master_auto_id   text,
  master_source    text check (master_source in ('detected','admin')),
  master_checked_at timestamptz,
  owner_account_id uuid references public.midnite_accounts on delete set null,
  enabled_by       uuid references auth.users on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One config row per site (mirrors FourScoped comm_hub_gen_config).
create table if not exists public.gen_config (
  site_key            text primary key references public.gen_sites on delete cascade,
  enabled             boolean not null default false,   -- master switch for automatic control
  auto_enabled        boolean not null default true,
  default_start_pct   integer not null default 20 check (default_start_pct between 0 and 100),
  default_stop_pct    integer not null default 80 check (default_stop_pct between 0 and 100),
  default_max_run_min integer not null default 240 check (default_max_run_min between 0 and 1440),
  force_on            boolean not null default false,
  force_until         timestamptz,
  force_max_run_min   integer not null default 120,
  force_target_pct    integer,
  force_started_by    uuid references auth.users on delete set null,
  comms_lost_action   text not null default 'stop' check (comms_lost_action in ('stop','hold')),
  alerts_enabled      boolean not null default true,
  -- What the inverter held before we touched it, so a forced run can put it back.
  saved_max_run_min   integer,
  -- Last values the server wrote, and the last observed state.
  applied_start_pct   integer,
  applied_stop_pct    integer,
  applied_ags         integer,
  observed_running    boolean,
  observed_at         timestamptz,
  config_rev          integer not null default 1,
  updated_at          timestamptz not null default now()
);

-- Daily battery windows: lowest priority wins on overlap.
create table if not exists public.gen_windows (
  id          uuid primary key default gen_random_uuid(),
  site_key    text not null references public.gen_sites on delete cascade,
  label       text,
  start_min   integer not null check (start_min between 0 and 1439),
  end_min     integer not null check (end_min between 0 and 1439),
  start_pct   integer not null check (start_pct between 0 and 100),
  stop_pct    integer not null check (stop_pct between 0 and 100),
  max_run_min integer not null default 0 check (max_run_min between 0 and 1440),
  days_mask   integer not null default 127 check (days_mask between 1 and 127),
  priority    integer not null default 100,
  enabled     boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists gen_windows_site on public.gen_windows (site_key, priority);

-- Scheduled runs: one-off (starts_at) or weekly exercise (days_mask + time_local).
create table if not exists public.gen_schedules (
  id           uuid primary key default gen_random_uuid(),
  site_key     text not null references public.gen_sites on delete cascade,
  kind         text not null default 'oneoff' check (kind in ('oneoff','exercise')),
  label        text,
  starts_at    timestamptz,                 -- oneoff
  days_mask    integer,                     -- exercise: bit 0 = Sunday
  time_local   text,                        -- exercise: 'HH:MM' in the site timezone
  duration_min integer not null default 30 check (duration_min between 1 and 1440),
  target_pct   integer check (target_pct between 0 and 100),
  enabled      boolean not null default true,
  next_run_at  timestamptz,
  last_run_at  timestamptz,
  fired        boolean not null default false,
  created_by   uuid references auth.users on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists gen_schedules_due on public.gen_schedules (enabled, next_run_at);

-- Observed runs (opened/closed from the generator actually producing power).
create table if not exists public.gen_runs (
  id           uuid primary key default gen_random_uuid(),
  site_key     text not null references public.gen_sites on delete cascade,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  source       text not null default 'auto' check (source in ('auto','force','schedule','manual')),
  duration_sec integer,
  cap_min      integer,
  target_pct   integer,
  soc_start    numeric,
  soc_end      numeric,
  peak_w       numeric,
  peak_v       numeric,
  peak_hz      numeric
);
create index if not exists gen_runs_site on public.gen_runs (site_key, started_at desc);

-- The site activity log: every user or server action, with who did it.
create table if not exists public.gen_events (
  id          uuid primary key default gen_random_uuid(),
  site_key    text not null,
  ts          timestamptz not null default now(),
  actor_id    uuid references auth.users on delete set null,
  actor_email text,
  actor_name  text,
  actor_role  text check (actor_role in ('owner','shared','admin','system')),
  action      text not null,
  source      text not null default 'user' check (source in ('user','cron')),
  before      jsonb,
  after       jsonb,
  success     boolean,
  error       text
);
create index if not exists gen_events_site on public.gen_events (site_key, ts desc);

-- Per-user generator alert choices for a site.
create table if not exists public.gen_alert_prefs (
  user_id  uuid not null references auth.users on delete cascade,
  site_key text not null references public.gen_sites on delete cascade,
  email    boolean not null default true,
  push     boolean not null default true,
  primary key (user_id, site_key)
);

-- Web Push: one row per installed browser/PWA.
create table if not exists public.push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  failure_count integer not null default 0
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);

-- The app's VAPID key pair, generated once on first use. It must never change, or every
-- existing subscription stops working.
create table if not exists public.vapid_keys (
  id          integer primary key default 1 check (id = 1),
  public_key  text not null,
  private_key text not null,
  subject     text not null default 'mailto:alerts@midnite-sentinel.app',
  created_at  timestamptz not null default now()
);

alter table public.gen_sites          enable row level security;
alter table public.gen_config         enable row level security;
alter table public.gen_windows        enable row level security;
alter table public.gen_schedules      enable row level security;
alter table public.gen_runs           enable row level security;
alter table public.gen_events         enable row level security;
alter table public.gen_alert_prefs    enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.vapid_keys         enable row level security;

-- ── Reload PostgREST's schema cache ─────────────────────────────────────────
-- Supabase's REST layer (PostgREST, which supabase-js talks to) keeps an in-memory
-- schema cache. After creating a table it can still report PGRST205 / "Could not
-- find the table in the schema cache" until that cache reloads. This NOTIFY forces
-- an immediate reload so the new tables/policies are visible right away. Harmless to
-- re-run. (If you ever see "isn't set up yet" right after running the DDL, run this
-- one line on its own.)
notify pgrst, 'reload schema';
