-- Generator control tables only (same block as in schema.sql). Additive: no drops, no data changes.

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

notify pgrst, 'reload schema';
