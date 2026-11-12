-- String (MPPT) names, sizes and daily energy. Additive: no drops, no data changes.
-- site_key = the site's inverter serials, sorted and joined with "," (same key as gen_sites).
-- RLS on with NO policies: only service-role API routes read or write these tables.

-- Per-MPPT name and optional DC size. Keyed by inverter SERIAL (INV-N labels can change).
create table if not exists public.site_mppt_labels (
  site_key   text not null,
  sn         text not null,
  mppt       integer not null check (mppt between 1 and 3),
  label      text,
  kw_dc      numeric check (kw_dc is null or (kw_dc > 0 and kw_dc <= 100)),
  updated_by uuid references auth.users on delete set null,
  updated_at timestamptz not null default now(),
  primary key (site_key, sn, mppt)
);

-- Daily energy per MPPT, integrated from the 5-minute CSV export (watts x 5 min).
create table if not exists public.mppt_daily (
  sn              text not null,
  day             date not null,
  mppt            integer not null check (mppt between 1 and 3),
  site_key        text,
  kwh             numeric not null,
  peak_w          numeric,
  peak_v          numeric,
  samples         integer,
  inverter_etoday numeric,   -- the inverter's own E-Today for the day, as a cross-check
  computed_at     timestamptz not null default now(),
  primary key (sn, day, mppt)
);
create index if not exists mppt_daily_site_day on public.mppt_daily (site_key, day desc);

alter table public.site_mppt_labels enable row level security;
alter table public.mppt_daily       enable row level security;

notify pgrst, 'reload schema';
