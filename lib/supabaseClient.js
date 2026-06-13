import { createClient } from "@supabase/supabase-js";

// Browser Supabase client — used only for auth (sign in/up, session, Google OAuth).
// All Midnite-account data goes through the /api/midnite proxy (service role), never the client.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseReady = !!(url && anon);
export const supabase = supabaseReady
  ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
