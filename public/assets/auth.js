import { supabase } from './supabase.js'

export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + '/auth-callback.html'
    }
  })
  return error
}

export async function checkAuthAndRedirect() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    window.location.href = '/index.html'
    return null
  }
  const rol = user.user_metadata?.rol
  const path = window.location.pathname
  if (rol === 'hr' && !path.includes('hr.html')) {
    window.location.href = '/hr.html'
    return user
  }
  if (rol === 'voorman' && !path.includes('voorman.html')) {
    window.location.href = '/voorman.html'
    return user
  }
  return user
}

export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function logout() {
  await supabase.auth.signOut()
  window.location.href = '/index.html'
}
