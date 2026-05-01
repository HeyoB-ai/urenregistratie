// GET /.netlify/functions/config
// Levert de publieke Supabase-config (URL + publishable key) aan de frontend.
// Waarden komen uit Netlify env vars zodat ze niet in de source code staan.

const json = (status, obj, extra = {}) => ({
  statusCode: status,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
    ...extra
  },
  body: JSON.stringify(obj)
})

export const handler = async () => {
  const url     = process.env.SUPABASE_URL
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    return json(500, {
      error: 'SUPABASE_URL of SUPABASE_ANON_KEY ontbreekt op Netlify'
    }, { 'Cache-Control': 'no-store' })
  }
  return json(200, {
    SUPABASE_URL: url,
    SUPABASE_ANON_KEY: anonKey
  })
}
