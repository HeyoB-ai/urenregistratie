// Twee triggers:
//   1. Cron — Netlify scheduled function (ma t/m vr 07:00 UTC, zie netlify.toml).
//      Pad: GEEN auth check. Netlify roept dit pad zelf aan; er is geen Authorization header.
//   2. HTTP POST vanuit hr.js (knop "Verstuur weekmail").
//      Pad: valideer Bearer JWT en check rol === 'hr'.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL         = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY
const BREVO_API_KEY        = process.env.BREVO_API_KEY
// TODO: vervang door custom domain zodra DNS geconfigureerd is (zie .env.example)
const APP_URL              = process.env.APP_URL || 'https://urenregistratie.netlify.app'

// Verzender. TODO: verifieer qbtec.nl in Brevo (Senders & IP > Domains) vóór deploy.
const FROM_NAME  = 'Urenregistratie QBTec'
const FROM_EMAIL = 'noreply@qbtec.nl'
const REPLY_TO   = 'hr@qbtec.nl'

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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !BREVO_API_KEY) {
    return text(500, 'Server config ontbreekt: SUPABASE_URL, SUPABASE_SERVICE_KEY, BREVO_API_KEY')
  }

  const auth = event?.headers?.authorization || event?.headers?.Authorization

  // === HTTP pad: handmatige trigger door HR ===
  if (auth) {
    if (!auth.startsWith('Bearer ')) return text(401, 'Geen sessie-token')
    const token = auth.slice(7).trim()
    const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    })
    const { data, error } = await supa.auth.getUser(token)
    if (error || !data?.user)            return text(401, 'Ongeldige sessie')
    if (data.user.user_metadata?.rol !== 'hr')
      return text(403, 'Alleen HR mag deze functie aanroepen')
    return await runJob('manual')
  }

  // === Cron pad: Netlify scheduled function — geen auth check ===
  // Netlify roept de scheduled function zelf aan; externe POSTs zonder Authorization
  // doen hetzelfde, maar dat is acceptabel voor een intranet-app (zie discussie in spec).
  return await runJob('cron')
}

async function runJob(trigger) {
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })

  // 1. Huidige open periode
  const { data: periodes, error: pErr } = await supa
    .from('perioden')
    .select('*')
    .eq('status', 'open')
    .order('uploaded_at', { ascending: false })
    .limit(1)
  if (pErr) {
    console.error('[send-weekly-emails] periode laden mislukt:', pErr)
    return text(500, 'Periode laden mislukt: ' + pErr.message)
  }
  if (!periodes || !periodes.length) {
    console.log('[send-weekly-emails] geen open periode — niets verstuurd', { trigger })
    return json(200, { sent: 0, reason: 'no_open_period', trigger })
  }
  const periode = periodes[0]

  // 2. Leidinggevenden + afdeling-naam (incl. reserves)
  const { data: lgvs, error: lErr } = await supa
    .from('leidinggevenden')
    .select('id, naam, email, afdeling_id, is_reserve, afdelingen(naam)')
  if (lErr) {
    console.error('[send-weekly-emails] leidinggevenden laden mislukt:', lErr)
    return text(500, 'Leidinggevenden laden mislukt: ' + lErr.message)
  }

  // 3. Goedkeuringen voor deze periode
  const { data: gk } = await supa
    .from('goedkeuringen')
    .select('afdeling_id, goedgekeurd')
    .eq('periode_id', periode.id)
  const approvedAfd = new Set(
    (gk || []).filter((g) => g.goedgekeurd).map((g) => g.afdeling_id)
  )

  // 4. Filter: niet-goedgekeurde afdelingen, geldige email
  const ontvangers = (lgvs || []).filter(
    (lg) => lg.afdeling_id && lg.email && !approvedAfd.has(lg.afdeling_id)
  )
  if (!ontvangers.length) {
    console.log('[send-weekly-emails] alle afdelingen al goedgekeurd — niets verstuurd', {
      trigger, periode_id: periode.id
    })
    return json(200, { sent: 0, reason: 'all_approved', trigger, periode_id: periode.id })
  }

  // 5. Onderwerpregels (NL tz) — hoofd; reserve hangt af van afdelingsnaam (per ontvanger)
  const subjectMain = subjectForToday(periode)
  const deadlineStr = fridayDeadlineStr(periode)

  // 6. Per ontvanger: magic link + e-mail (reserve krijgt eigen template + onderwerp)
  const results = []
  for (const lg of ontvangers) {
    const afdNaam = lg.afdelingen?.naam || ''
    const isReserve = !!lg.is_reserve
    try {
      const { data: linkData, error: linkErr } = await supa.auth.admin.generateLink({
        type: 'magiclink',
        email: lg.email,
        options: { redirectTo: APP_URL + '/auth-callback.html' }
      })
      if (linkErr || !linkData?.properties?.action_link) {
        results.push({ email: lg.email, ok: false, error: 'magiclink: ' + (linkErr?.message || 'geen action_link') })
        continue
      }
      const magicLink = linkData.properties.action_link
      const tplArgs = { naam: lg.naam, afdeling: afdNaam, periode, deadlineStr, magicLink }

      await stuurMail({
        to: lg.email,
        toNaam: lg.naam,
        subject: isReserve ? subjectForReserve(periode, afdNaam) : subjectMain,
        html: isReserve ? renderReserveHTML(tplArgs) : renderEmailHTML(tplArgs),
        text: isReserve ? renderReserveText(tplArgs) : renderEmailText(tplArgs)
      })
      results.push({ email: lg.email, ok: true, reserve: isReserve })
    } catch (e) {
      results.push({ email: lg.email, ok: false, error: e.message || String(e) })
    }
  }

  const sent   = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log(`[send-weekly-emails] verstuurd: ${sent}/${ontvangers.length}`, {
    trigger, periode_id: periode.id, subject: subjectMain, failures: failed
  })

  return json(200, {
    sent,
    failed: failed.length,
    failures: failed,
    periode_id: periode.id,
    subject: subjectMain,
    trigger
  })
}

// === Brevo transactional e-mail via REST API ===

async function stuurMail({ to, toNaam, subject, html, text }) {
  const response = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      sender:      { name: FROM_NAME, email: FROM_EMAIL },
      to:          [{ email: to, name: toNaam }],
      replyTo:     { email: REPLY_TO },
      subject,
      htmlContent: html,
      textContent: text
    })
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Brevo ${response.status}: ${body || response.statusText}`)
  }
}

// === Onderwerpregels per dag (NL-tijdzone) ===

function subjectForToday(periode) {
  const wkText = periode.week_nummer ? `week ${periode.week_nummer}` : (periode.label || '')
  const dow = nlDayOfWeek()
  if (dow === 1) return `Urenregistratie ${wkText} — actie vereist`
  if (dow === 5) return `Laatste kans: urenregistratie ${wkText} — deadline vandaag 17:00`
  return `Herinnering: urenregistratie ${wkText} nog niet goedgekeurd`
}

function subjectForReserve(periode, afdeling) {
  const wk = periode.week_nummer ? String(periode.week_nummer).padStart(2, '0') : 'XX'
  return `Ter info: urenregistratie ${afdeling} week ${wk} nog niet goedgekeurd`
}

function nlDayOfWeek() {
  const map = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 }
  const dayName = new Date().toLocaleDateString('en-US', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'long'
  })
  return map[dayName] ?? new Date().getDay()
}

// === Deadline string ("vrijdag DD-MM-YYYY 17:00") ===

function fridayDeadlineStr(periode) {
  if (!periode?.uploaded_at) return ''
  const uploaded = new Date(periode.uploaded_at)
  const dow = uploaded.getUTCDay()
  const daysToFriday = ((5 - dow) + 7) % 7
  const friday = new Date(uploaded)
  friday.setUTCDate(uploaded.getUTCDate() + daysToFriday)
  const dd = String(friday.getUTCDate()).padStart(2, '0')
  const mm = String(friday.getUTCMonth() + 1).padStart(2, '0')
  const yy = friday.getUTCFullYear()
  return `vrijdag ${dd}-${mm}-${yy} 17:00`
}

// === Email templates ===

function renderEmailHTML({ naam, afdeling, periode, deadlineStr, magicLink }) {
  const wk = periode.week_nummer ? `week ${periode.week_nummer}` : 'deze week'
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Urenregistratie</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f4f5f7;color:#1a1a2e">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;padding:24px 0">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="background:#fff;border:1px solid #dde2ea;border-radius:10px;overflow:hidden;max-width:560px">
      <tr>
        <td style="background:#1a3a5c;padding:18px 24px;color:#fff;font-size:16px;font-weight:600;font-family:Arial,sans-serif">
          QBTec — Urenregistratie
        </td>
      </tr>
      <tr><td style="padding:28px 28px 8px;font-size:14px;line-height:1.55;font-family:Arial,sans-serif;color:#1a1a2e">
        <p style="margin:0 0 16px">Hallo ${esc(naam)},</p>
        <p style="margin:0 0 16px">
          De urenregistratie van afdeling <strong>${esc(afdeling)}</strong> voor
          <strong>${esc(wk)}</strong> (${esc(periode.label || '')}) staat klaar voor uw controle.
        </p>
        <p style="margin:0 0 24px">
          <strong>Deadline:</strong> graag goedkeuren vóór ${esc(deadlineStr)}.
        </p>
      </td></tr>
      <tr><td align="center" style="padding:0 28px 24px">
        <a href="${esc(magicLink)}" style="display:inline-block;background:#1a3a5c;color:#fff;text-decoration:none;padding:13px 28px;border-radius:6px;font-size:14px;font-weight:600;font-family:Arial,sans-serif">Open urenregistratie</a>
      </td></tr>
      <tr><td style="padding:0 28px 24px;font-size:12px;color:#5a6a7e;line-height:1.5;font-family:Arial,sans-serif">
        Deze link logt u automatisch in en is 24 uur geldig.<br>
        Werkt de knop niet? Kopieer en plak deze URL in uw browser:<br>
        <span style="word-break:break-all;color:#1a3a5c">${esc(magicLink)}</span>
      </td></tr>
      <tr><td style="background:#f8f9fb;padding:14px 28px;font-size:11px;color:#5a6a7e;border-top:1px solid #dde2ea;font-family:Arial,sans-serif">
        Heeft u vragen? Antwoord op deze e-mail of mail naar hr@qbtec.nl.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

function renderEmailText({ naam, afdeling, periode, deadlineStr, magicLink }) {
  const wk = periode.week_nummer ? `week ${periode.week_nummer}` : 'deze week'
  return `Hallo ${naam},

De urenregistratie van afdeling ${afdeling} voor ${wk} (${periode.label || ''}) staat klaar voor uw controle.

Deadline: graag goedkeuren vóór ${deadlineStr}.

Open de urenregistratie via deze link (24 uur geldig):
${magicLink}

Heeft u vragen? Antwoord op deze e-mail of mail naar hr@qbtec.nl.

— QBTec Urenregistratie`
}

function renderReserveHTML({ naam, afdeling, periode, deadlineStr, magicLink }) {
  const wk = periode.week_nummer ? `week ${periode.week_nummer}` : 'deze week'
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Urenregistratie — reserve</title>
</head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f4f5f7;color:#1a1a2e">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;padding:24px 0">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="background:#fff;border:1px solid #dde2ea;border-radius:10px;overflow:hidden;max-width:560px">
      <tr>
        <td style="background:#1a3a5c;padding:18px 24px;color:#fff;font-size:16px;font-weight:600;font-family:Arial,sans-serif">
          QBTec — Urenregistratie (reserve)
        </td>
      </tr>
      <tr><td style="padding:28px 28px 8px;font-size:14px;line-height:1.55;font-family:Arial,sans-serif;color:#1a1a2e">
        <p style="margin:0 0 16px">Hallo ${esc(naam)},</p>
        <p style="margin:0 0 16px">
          U ontvangt deze mail omdat u reserve bent voor afdeling <strong>${esc(afdeling)}</strong>.
          Actie is alleen vereist als de leidinggevende niet beschikbaar is.
        </p>
        <p style="margin:0 0 16px">
          De urenregistratie van afdeling <strong>${esc(afdeling)}</strong> voor
          <strong>${esc(wk)}</strong> (${esc(periode.label || '')}) is nog niet goedgekeurd.
          Deadline: ${esc(deadlineStr)}.
        </p>
      </td></tr>
      <tr><td align="center" style="padding:0 28px 24px">
        <a href="${esc(magicLink)}" style="display:inline-block;background:#1a3a5c;color:#fff;text-decoration:none;padding:13px 28px;border-radius:6px;font-size:14px;font-weight:600;font-family:Arial,sans-serif">Open urenregistratie</a>
      </td></tr>
      <tr><td style="padding:0 28px 24px;font-size:12px;color:#5a6a7e;line-height:1.5;font-family:Arial,sans-serif">
        Deze link logt u automatisch in en is 24 uur geldig.<br>
        Werkt de knop niet? Kopieer en plak deze URL in uw browser:<br>
        <span style="word-break:break-all;color:#1a3a5c">${esc(magicLink)}</span>
      </td></tr>
      <tr><td style="background:#f8f9fb;padding:14px 28px;font-size:11px;color:#5a6a7e;border-top:1px solid #dde2ea;font-family:Arial,sans-serif">
        Heeft u vragen? Antwoord op deze e-mail of mail naar hr@qbtec.nl.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

function renderReserveText({ naam, afdeling, periode, deadlineStr, magicLink }) {
  const wk = periode.week_nummer ? `week ${periode.week_nummer}` : 'deze week'
  return `Hallo ${naam},

U ontvangt deze mail omdat u reserve bent voor afdeling ${afdeling}. Actie is alleen vereist als de leidinggevende niet beschikbaar is.

De urenregistratie van afdeling ${afdeling} voor ${wk} (${periode.label || ''}) is nog niet goedgekeurd. Deadline: ${deadlineStr}.

Open de urenregistratie via deze link (24 uur geldig):
${magicLink}

Heeft u vragen? Antwoord op deze e-mail of mail naar hr@qbtec.nl.

— QBTec Urenregistratie`
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
