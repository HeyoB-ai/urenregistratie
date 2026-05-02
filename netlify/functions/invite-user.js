// POST /.netlify/functions/invite-user
// Header: Authorization: Bearer <hr-jwt>
// Body:   { email, naam }
//
// Stuurt Supabase invite-mail en zet rol+naam in user_metadata.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const APP_URL              = process.env.APP_URL || 'https://urenregistratie.netlify.app'

const json = (status, obj) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
})
const text = (status, msg) => ({
  statusCode: status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  body: msg
})

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' }
  }
  if (event.httpMethod !== 'POST') return text(405, 'Method not allowed')
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return text(500, 'Server config ontbreekt: SUPABASE_URL of SUPABASE_SERVICE_KEY')
  }

  // 1. JWT + rolcheck
  const auth = event.headers.authorization || event.headers.Authorization
  if (!auth || !auth.startsWith('Bearer ')) return text(401, 'Geen sessie-token')
  const token = auth.slice(7).trim()

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data: userData, error: userErr } = await supa.auth.getUser(token)
  if (userErr || !userData?.user) return text(401, 'Ongeldige sessie')
  if (userData.user.user_metadata?.rol !== 'hr') return text(403, 'Alleen HR mag uitnodigen')

  // 2. Body
  let body
  try { body = JSON.parse(event.body || '{}') }
  catch { return text(400, 'Ongeldige JSON body') }
  const email = String(body.email || '').trim()
  const naam  = String(body.naam || '').trim()
  if (!email) return text(400, 'email ontbreekt')

  // 3. Invite
  const { data, error } = await supa.auth.admin.inviteUserByEmail(email, {
    data: { rol: 'voorman', naam },
    redirectTo: APP_URL + '/auth-callback.html'
  })
  if (error) {
    return text(400, 'Uitnodigen mislukt: ' + (error.message || String(error)))
  }
  return json(200, { success: true, user_id: data?.user?.id || null })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  }
}
