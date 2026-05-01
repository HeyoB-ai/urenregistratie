import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Config wordt opgehaald uit /.netlify/functions/config (zie netlify/functions/config.js).
// Waarden komen uit Netlify env vars SUPABASE_URL + SUPABASE_ANON_KEY — niet hardcoded hier.
const cfg = await fetch('/.netlify/functions/config').then((r) => {
  if (!r.ok) throw new Error('Supabase config laden mislukt: HTTP ' + r.status)
  return r.json()
})

export const supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
})
