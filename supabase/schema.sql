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
