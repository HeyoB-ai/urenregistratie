import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// TODO: vervang door echte waarden zodra Supabase project is aangemaakt
const SUPABASE_URL = 'https://xxxx.supabase.co'
const SUPABASE_ANON_KEY = 'eyJ...'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})
