// POST /.netlify/functions/parse-excel
// Header: Authorization: Bearer <hr-jwt>
// Body:   multipart/form-data with field "excel" = .xlsx
//
// Flow: JWT -> parse multipart -> SheetJS -> parseImmotix() -> RPC import_periode -> JSON.

import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import busboy from 'busboy'
import { Buffer } from 'node:buffer'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

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
  if (event.httpMethod !== 'POST') {
    return text(405, 'Method not allowed')
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return text(500, 'Server config ontbreekt: SUPABASE_URL of SUPABASE_SERVICE_KEY')
  }

  // === 1. JWT validatie + rolcheck ===
  const auth = event.headers.authorization || event.headers.Authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return text(401, 'Geen sessie-token')
  }
  const token = auth.slice(7).trim()

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data: userData, error: userErr } = await supa.auth.getUser(token)
  if (userErr || !userData?.user) {
    return text(401, 'Ongeldige sessie')
  }
  const user = userData.user
  if (user.user_metadata?.rol !== 'hr') {
    return text(403, 'Alleen HR kan uploaden')
  }

  // === 2. Multipart parsen ===
  let buf
  try {
    buf = await parseMultipart(event)
  } catch (e) {
    return text(400, 'Upload lezen mislukt: ' + (e.message || e))
  }
  if (!buf || !buf.length) {
    return text(400, 'Geen bestand ontvangen')
  }

  // === 3. Excel parsen ===
  let parsed
  try {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
    const ws = wb.Sheets[wb.SheetNames[0]]
    if (!ws) throw new Error('Werkblad ontbreekt')
    console.log('[parse-excel] Bytes ontvangen:', buf.length, '— sheets:', wb.SheetNames)
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true })
    console.log('[parse-excel] Aantal rijen:', rows.length)
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      console.log(`[parse-excel] Rij ${i}:`, JSON.stringify(rows[i]))
    }
    parsed = parseImmotix(rows)
  } catch (e) {
    console.error('[parse-excel] Parse fout:', e.message)
    return text(422, e.message || String(e))
  }

  // === 4. RPC ===
  const { data: result, error: rpcErr } = await supa.rpc('import_periode', {
    p_label:       parsed.label,
    p_week:        parsed.week,
    p_jaar:        parsed.jaar,
    p_user_id:     user.id,
    p_afdelingen:  parsed.afdelingen,
    p_medewerkers: parsed.medewerkers,
    p_regels:      parsed.regels
  })

  if (rpcErr) {
    const msg = String(rpcErr.message || rpcErr)
    if (/al een open periode/i.test(msg)) {
      return text(409, 'Er is al een open periode. Sluit deze eerst af voor u een nieuwe upload doet.')
    }
    return text(500, 'Import mislukt: ' + msg)
  }

  return json(200, result)
}

// === Helpers ===

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  }
}

function parseMultipart(event) {
  return new Promise((resolve, reject) => {
    const ct = event.headers['content-type'] || event.headers['Content-Type']
    if (!ct || !ct.startsWith('multipart/form-data')) {
      return reject(new Error('Geen multipart body'))
    }
    const bb = busboy({ headers: { 'content-type': ct } })
    const chunks = []
    let found = false
    bb.on('file', (_name, file) => {
      found = true
      file.on('data', (d) => chunks.push(d))
    })
    bb.on('error', reject)
    bb.on('finish', () => {
      if (!found) return reject(new Error('Geen bestand in multipart'))
      resolve(Buffer.concat(chunks))
    })
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'binary')
    bb.end(body)
  })
}

function parseImmotix(rows) {
  if (!rows || !rows.length) throw new Error('Leeg bestand')

  // Zoek "Selectie: ..." in eerste 10 rijen × 5 kolommen (fallback voor andere lay-out / merged cells)
  let label = null
  let labelFoundAt = null
  outer: for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i] || []
    for (let j = 0; j < Math.min(5, r.length); j++) {
      const v = String(r[j] ?? '')
      const m = v.match(/Selectie:\s*(.+)/i)
      if (m) {
        label = m[1].trim()
        labelFoundAt = `rij ${i}, kolom ${j}`
        break outer
      }
    }
  }
  console.log('[parse-excel] "Selectie:" gevonden op:', labelFoundAt, '→ label:', label)

  if (!label) {
    const peek = JSON.stringify(rows.slice(0, 3))
    throw new Error(
      'Kan periode niet bepalen uit bestandsnaam — controleer of dit een geldig Immotix bestand is. ' +
      `(debug: eerste 3 rijen = ${peek.slice(0, 400)})`
    )
  }

  // Eerste datum uit het label voor week + jaar
  const startDate = parseLabelStartDate(label)
  if (!startDate) {
    throw new Error(
      `Kan periode niet bepalen uit bestandsnaam — geen datum gevonden in label '${label}'.`
    )
  }
  const { week, year } = isoWeek(startDate)

  const afdelingenSet = new Set()
  const medewerkersMap = {}
  const regels = []
  let cur = null

  // Datarijen beginnen op index 3 (zoals in prototype)
  for (let i = 3; i < rows.length; i++) {
    const rowNo = i + 1 // 1-based voor foutmeldingen
    const r = rows[i]
    if (!r || r.every((c) => c === null || c === '')) continue

    const mdwnr = r[0] != null ? String(r[0]).trim() : null
    const col1  = r[1] != null ? String(r[1]).trim() : null
    const afd   = r[2] != null ? String(r[2]).trim() : null
    const datumRaw = r[3]

    if (col1 === 'Totaal') { cur = null; continue }

    if (mdwnr && mdwnr !== '') {
      cur = { mdwnr, naam: col1 || `Mdw. ${mdwnr}`, afdeling: afd || '' }
      if (cur.afdeling && !medewerkersMap[mdwnr]) {
        medewerkersMap[mdwnr] = { ...cur }
      } else if (!medewerkersMap[mdwnr]) {
        medewerkersMap[mdwnr] = { ...cur }
      }
      if (cur.afdeling) afdelingenSet.add(cur.afdeling)
    }

    if (datumRaw !== null && datumRaw !== '' && cur) {
      const d = toDate(datumRaw)
      if (!d) {
        throw new Error(`Import mislukt op rij ${rowNo} — ongeldige datum '${String(datumRaw)}'. Geen data opgeslagen.`)
      }
      if (!cur.afdeling) {
        throw new Error(`Import mislukt op rij ${rowNo} — geen afdeling bekend voor medewerker '${cur.mdwnr}'. Geen data opgeslagen.`)
      }
      regels.push({
        mdwnr:        cur.mdwnr,
        afdeling:     cur.afdeling,
        datum:        toISODate(d),
        tijd_in:      numStr(r[4]),
        tijd_uit:     numStr(r[5]),
        gepland:      numStr(r[6]),
        gepresteerd:  numStr(r[7]),
        ow100:        numStr(r[11]),
        ow125:        numStr(r[12]),
        ziek:         numStr(r[13]),
        verlof:       numStr(r[14])
      })
    }
  }

  if (!regels.length) {
    throw new Error('Geen geldige uren-regels in dit Excel bestand')
  }

  return {
    label,
    week,
    jaar: year,
    afdelingen: [...afdelingenSet],
    medewerkers: Object.values(medewerkersMap),
    regels
  }
}

const NL_MAANDEN = {
  jan: 1, feb: 2, mrt: 3, apr: 4, mei: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12
}

function parseLabelStartDate(label) {
  // Formaat 1: "DD-MM-YYYY t/m DD-MM-YYYY"
  const m1 = label.match(/(\d{1,2})-(\d{1,2})-(\d{4})/)
  if (m1) {
    const d = makeDateUTC(+m1[1], +m1[2], +m1[3])
    if (d) return d
  }
  // Formaat 2: "mrt 23, 2026 - mrt 29, 2026" (SheetJS server-side output)
  const m2 = label.match(/([a-zA-Z]{3})\s+(\d{1,2}),\s*(\d{4})/)
  if (m2) {
    const maand = NL_MAANDEN[m2[1].toLowerCase()]
    if (maand) {
      const d = makeDateUTC(+m2[2], maand, +m2[3])
      if (d) return d
    }
  }
  return null
}

function makeDateUTC(day, month, year) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null
  return d
}

function toDate(v) {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? null : new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()))
  }
  // String "DD-MM-YYYY"
  const s = String(v).trim()
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (!m) return null
  return makeDateUTC(+m[1], +m[2], +m[3])
}

function toISODate(d) {
  return d.toISOString().slice(0, 10)
}

function numStr(v) {
  if (v === null || v === undefined || v === '-' || v === '') return ''
  const x = parseFloat(v)
  return isNaN(x) ? '' : String(x)
}

function isoWeek(d) {
  // d is een UTC datum
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((date - yearStart) / 86400000 + 1) / 7)
  return { week: weekNo, year: date.getUTCFullYear() }
}
