# Auth / SaaS setup (Supabase)

The app now requires an **app account** (Supabase: Google or email/password) and a
**linked Midnite account** (credentials encrypted at rest). Until the env vars below
are set, the login screen shows "sign-in isn't configured."

## 1. Create a Supabase project
- supabase.com → New project. Note the **Project URL** and the **anon** and
  **service_role** keys (Project Settings → API).

## 2. Auth settings
- **Authentication → Providers → Email**: enable. **Turn OFF "Confirm email"**
  (Authentication → Sign In / Providers → Email → uncheck confirm email), since the
  plan doesn't include email confirmation.
- **Authentication → Providers → Google**: enable, paste your Google OAuth client ID
  and secret (Google Cloud Console → OAuth consent + Credentials → Web client).
  - Authorized redirect URI in Google: `https://<your-project>.supabase.co/auth/v1/callback`
- **Authentication → URL Configuration**: set Site URL to `https://midnite-rose.vercel.app`
  and add it to Redirect URLs.

## 3. Run the schema
- SQL Editor → paste & run `supabase/schema.sql` (creates `profiles`,
  `midnite_accounts`, RLS, and the new-user trigger).

## 4. Make yourself an admin (admins may link multiple Midnite accounts)
```sql
update public.profiles set role = 'admin' where email = 'jason@floridasolardesigngroup.com';
```
(Run after you've signed up once so the profile row exists.)

## 5. Vercel env vars (Project → Settings → Environment Variables), then redeploy
| Var | Value |
|-----|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | your Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (server only — never expose) |
| `CREDS_ENC_KEY` | 32-byte secret for encrypting Midnite passwords. Generate: `openssl rand -hex 32` |

Keep the existing `MIDNITE_*` and `KV_*` vars. `CREDS_ENC_KEY` must never change once
accounts are linked (it decrypts stored Midnite passwords) — back it up.

## How it works
- App login → Supabase (Google/email). New users land on **Link your Midnite account**.
- Midnite password is encrypted **AES-256-GCM** with `CREDS_ENC_KEY` and stored in
  `midnite_accounts.enc_password`. Plaintext never reaches the browser or the DB.
- The `/api/midnite` proxy verifies the Supabase JWT, loads the user's linked account
  (service role), decrypts server-side, and calls Midnite.
- **Users**: one Midnite account (relink via **Settings**). **Admins**: multiple, with an
  active-account switcher in the header. A Midnite account can be linked to only one app login.
