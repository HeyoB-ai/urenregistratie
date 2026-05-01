import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = 'https://diwrapirtfmztiobneck.supabase.co'
// Publishable key (nieuwe Supabase formaat — vervangt de legacy anon JWT). Veilig in frontend; RLS doet het echte werk.
const SUPABASE_ANON_KEY = 'sb_publishable_0ogxR52g8JSyKtcwRf2O6g_P1bdP16o'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})
