import { supabase } from './supabase.js'
import { checkAuthAndRedirect, logout } from './auth.js'
import { renderHR, renderVM, calcTot, getNote, toast } from './render.js'
import { bindCorrectionHandlers } from './corrections.js'

const user = await checkAuthAndRedirect()
if (!user) { /* redirect ongoing */ }

let huidigePeriodeId = null
let activeTab = 'overzicht'
let cache = { periode: null, data: [], goedkeuringen: {} }

const $ = (id) => document.getElementById(id)

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

async function init() {
  bindUI()
  // Event delegation voor correcties op tab 2 (HR kan corrigeren op niet-goedgekeurde afdelingen)
  bindCorrectionHandlers({
    root: $('vm-content'),
    getState: () => ({
      data: cache.data,
      opts: { goedkeuringen: cache.goedkeuringen, hideApproval: true }
    }),
    userId: user?.id
  })
  await laadHuidigePeriode()
  abonneerRealtime()
}

function bindUI() {
  $('logout-btn').addEventListener('click', logout)

  // Upload via klik / drag-drop
  const zone = $('upload-zone')
  const input = $('file-input')
  zone.addEventListener('click', () => input.click())
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag') })
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('drag')
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0])
  })
  input.addEventListener('change', () => {
    if (input.files[0]) handleFile(input.files[0])
  })

  // Tabs
  $('nav-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn')
    if (!btn) return
    switchTab(btn.dataset.tab)
  })

  // Acties
  $('btn-sluit').addEventListener('click', sluitPeriode)
  $('btn-nmbrs').addEventListener('click', exportNMBRS)
  $('btn-emails').addEventListener('click', verstuurWeekmail)
}

function switchTab(name) {
  activeTab = name
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name)
  })
  $('tab-overzicht').hidden = name !== 'overzicht'
  $('tab-urenstaat').hidden = name !== 'urenstaat'
  // Hertekenen om er zeker van te zijn dat de actieve tab actuele state heeft
  if (cache.periode) renderActiveTab()
}

// === Periode laden — alleen meest recente met status='open' ===

async function laadHuidigePeriode() {
  const { data: periodes, error } = await supabase
    .from('perioden')
    .select('*')
    .eq('status', 'open')
    .order('uploaded_at', { ascending: false })
    .limit(1)

  if (error) { toast('Periode laden mislukt: ' + error.message); return }

  if (!periodes || !periodes.length) {
    // Geen open periode -> upload-zone tonen
    showLeegState()
    return
  }
  await laadPeriodeData(periodes[0].id)
}

function showLeegState() {
  huidigePeriodeId = null
  cache = { periode: null, data: [], goedkeuringen: {} }
  $('upload-zone-wrap').hidden = false
  $('nav-tabs').hidden = true
  $('periode-info-bar').hidden = true
  $('hr-content').innerHTML = `<div class="empty"><div class="icon">📂</div><p>Upload eerst de Immotix Excel.</p></div>`
  $('vm-content').innerHTML = `<div class="empty"><div class="icon">📂</div><p>Geen urenstaat beschikbaar.</p></div>`
  setHdrPeriod('')
}

async function laadPeriodeData(periode_id) {
  huidigePeriodeId = periode_id
  const [periodeR, regelsR, goedkR] = await Promise.all([
    supabase.from('perioden').select('*').eq('id', periode_id).single(),
    supabase
      .from('uren_regels')
      .select('*, medewerkers(mdwnr, naam), afdelingen(naam)')
      .eq('periode_id', periode_id)
      .order('afdeling_id, medewerker_id, datum'),
    supabase.from('goedkeuringen').select('*').eq('periode_id', periode_id)
  ])

  if (regelsR.error) { toast('Uren laden mislukt: ' + regelsR.error.message); return }

  const periode = periodeR.data
  const data = transformNaarPrototype(regelsR.data || [])
  const goedkeuringen = {}
  ;(goedkR.data || []).forEach((g) => { goedkeuringen[g.afdeling_id] = g.goedgekeurd })

  cache = { periode, data, goedkeuringen }

  // Periode geladen -> upload-zone weg, tabs aan
  $('upload-zone-wrap').hidden = true
  $('nav-tabs').hidden = false
  $('periode-info-bar').hidden = false
  updatePeriodeInfoBar(periode, data, goedkeuringen)
  setHdrPeriod(periode.label || '')

  renderActiveTab()
}

function renderActiveTab() {
  const { data, periode, goedkeuringen } = cache
  if (activeTab === 'overzicht') {
    renderHR(data, periode, { goedkeuringen })
  } else {
    renderVM(data, periode, { goedkeuringen, hideApproval: true })
  }
}

function updatePeriodeInfoBar(periode, data, goedkeuringen) {
  const wk = periode.week_nummer ? `Week ${periode.week_nummer}` : 'Periode'
  const jr = periode.jaar ? `, ${periode.jaar}` : ''
  $('periode-info-label').textContent = `${wk}${jr} — ${periode.label}`

  const afdIds = [...new Set(data.map((m) => m.afdeling_id).filter(Boolean))]
  const allOk = afdIds.length > 0 && afdIds.every((id) => goedkeuringen[id])
  const isOpen = periode.status === 'open'

  const badge = $('periode-info-status')
  if (!isOpen) {
    badge.textContent = 'Gesloten'
    badge.className = 'badge b-ok'
  } else if (allOk) {
    badge.textContent = 'Alle afdelingen akkoord'
    badge.className = 'badge b-ok'
  } else {
    badge.textContent = 'In behandeling'
    badge.className = 'badge b-open'
  }

  $('btn-emails').hidden = !isOpen
  $('btn-sluit').hidden  = !(isOpen && allOk)
}

function setHdrPeriod(text) {
  const el = $('hdr-period')
  if (el) el.textContent = text
}

// === Transform: Supabase rijen -> prototype-formaat ===

function transformNaarPrototype(regels) {
  const map = {}
  for (const r of regels) {
    const mdwnr = r.medewerkers?.mdwnr
    if (!mdwnr) continue
    if (!map[mdwnr]) {
      map[mdwnr] = {
        mdwnr,
        naam: r.medewerkers?.naam || `Mdw. ${mdwnr}`,
        afdeling: r.afdelingen?.naam || '',
        afdeling_id: r.afdeling_id,
        dagen: [],
        totaal: null
      }
    }
    map[mdwnr].dagen.push({
      regel_id:         r.id,
      datum:            r.datum,
      tijdIn:           r.tijd_in,
      tijdUit:          r.tijd_uit,
      gepland:          r.gepland,
      gep:              r.gepresteerd,
      ow100:            r.ow100,
      ow125:            r.ow125,
      ziek:             r.ziek,
      verlof:           r.verlof,
      corr_gepresteerd: r.corr_gepresteerd,
      corr_ow100:       r.corr_ow100,
      corr_ow125:       r.corr_ow125,
      corr_ow150:       r.corr_ow150,
      corr_ow200:       r.corr_ow200,
      corr_ziek:        r.corr_ziek,
      corr_verlof:      r.corr_verlof,
      corr_reiskosten:  r.corr_reiskosten,
      opmerking:        r.opmerking
    })
  }
  Object.values(map).forEach((m) => {
    const gpl = m.dagen.reduce((s, d) => s + (d.gepland ?? 0), 0)
    m.totaal = { gepland: gpl }
  })
  return Object.values(map)
}

// === Excel upload ===

function showZoneSpinner() {
  $('upload-error').hidden = true
  $('upload-zone-spinner').hidden = false
}
function hideZoneSpinner() {
  $('upload-zone-spinner').hidden = true
}
function showZoneError(msg) {
  $('upload-error').textContent = msg
  $('upload-error').hidden = false
}

async function handleFile(file) {
  if (!file) return
  if (!/\.xlsx?$/i.test(file.name)) {
    showZoneError('Alleen .xlsx of .xls bestanden zijn toegestaan.')
    return
  }
  showZoneSpinner()
  try {
    const formData = new FormData()
    formData.append('excel', file, file.name)
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Geen actieve sessie — log opnieuw in')

    const resp = await fetch('/.netlify/functions/parse-excel', {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}` },
      body: formData
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(text || `HTTP ${resp.status}`)

    let result
    try { result = JSON.parse(text) }
    catch { throw new Error('Onverwacht antwoord van server: ' + text.slice(0, 200)) }

    toast(`Excel geïmporteerd: ${result.afdelingen_count || 0} afdelingen, ${result.medewerkers_count || 0} medewerkers ✓`)
    $('file-input').value = ''
    if (result.periode_id) {
      await laadPeriodeData(result.periode_id)
    } else {
      await laadHuidigePeriode()
    }
  } catch (e) {
    showZoneError('Verwerking mislukt — controleer of dit een geldig Immotix bestand is. (' + (e.message || e) + ')')
  } finally {
    hideZoneSpinner()
  }
}

// === Sluit periode ===

async function sluitPeriode() {
  if (!huidigePeriodeId) return
  const periode = cache.periode
  if (!periode || periode.status === 'gesloten') { toast('Periode is al gesloten'); return }
  const wk = periode.week_nummer ? `week ${periode.week_nummer}` : 'deze periode'
  if (!confirm(`Weet u zeker dat u ${wk} wilt sluiten? Dit kan niet ongedaan worden gemaakt.`)) return

  const { error } = await supabase
    .from('perioden')
    .update({ status: 'gesloten' })
    .eq('id', huidigePeriodeId)
  if (error) { toast('Sluiten mislukt: ' + error.message); return }
  toast('Periode gesloten 🔒')
  await laadHuidigePeriode()
}

// === Verstuur weekmail (handmatig) ===

async function verstuurWeekmail() {
  if (!confirm('Magic-link e-mails versturen naar alle leidinggevenden voor de huidige open periode?')) return
  showOverlay('Weekmail versturen…')
  try {
    const { data: { session } } = await supabase.auth.getSession()
    const resp = await fetch('/.netlify/functions/send-weekly-emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ trigger: 'manual' })
    })
    const text = await resp.text()
    if (!resp.ok) throw new Error(text || `HTTP ${resp.status}`)
    toast('Weekmail verstuurd ✓')
  } catch (e) {
    toast('Versturen mislukt: ' + (e.message || e))
  } finally {
    hideOverlay()
  }
}

function showOverlay(text) {
  $('upload-overlay-text').textContent = text || 'Bezig…'
  $('upload-overlay').hidden = false
}
function hideOverlay() { $('upload-overlay').hidden = true }

// === NMBRS Excel export (client-side via SheetJS) ===

function exportNMBRS() {
  if (!cache.data || !cache.data.length) { toast('Geen data om te exporteren'); return }
  const { periode, data } = cache

  const header = [
    'Medewerkersnummer', 'Naam', 'Periode',
    'Gepland', 'Gepresteerd', 'Dagsaldo',
    'Overwerk 100%', 'Overwerk 125%', 'Overwerk 150%', 'Overwerk 200%',
    'Ziek', 'Verlof', 'Reiskosten', 'Opmerking'
  ]
  const rows = [header]
  const periodLabel = (periode?.week_nummer && periode?.jaar)
    ? `${periode.week_nummer}/${periode.jaar}`
    : (periode?.label || '')

  const sorted = [...data].sort((a, b) =>
    (a.afdeling || '').localeCompare(b.afdeling || '') ||
    String(a.mdwnr).localeCompare(String(b.mdwnr))
  )
  for (const m of sorted) {
    const t = calcTot(m)
    rows.push([
      m.mdwnr, m.naam, periodLabel,
      round2(m.totaal?.gepland ?? 0),
      round2(t.gep), round2(t.dag),
      round2(t.ow100), round2(t.ow125), round2(t.ow150), round2(t.ow200),
      round2(t.ziek), round2(t.verlof), round2(t.reiskosten),
      getNote(m) || ''
    ])
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [
    { wch: 14 }, { wch: 28 }, { wch: 12 },
    { wch: 9 },  { wch: 11 }, { wch: 10 },
    { wch: 13 }, { wch: 13 }, { wch: 13 }, { wch: 13 },
    { wch: 8 },  { wch: 9 },  { wch: 11 }, { wch: 30 }
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'NMBRS')

  const wk = periode?.week_nummer ? String(periode.week_nummer).padStart(2, '0') : 'XX'
  const jr = periode?.jaar || new Date().getFullYear()
  const fname = `NMBRS_export_week${wk}_${jr}.xlsx`
  XLSX.writeFile(wb, fname)
  toast(`Export gemaakt: ${fname}`)
}

function round2(n) {
  if (n === null || n === undefined || isNaN(n)) return 0
  return Math.round(Number(n) * 100) / 100
}

// === Realtime: live status updates ===

function abonneerRealtime() {
  supabase.channel('hr-goedkeuringen')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'goedkeuringen' }, () => {
      if (huidigePeriodeId) laadPeriodeData(huidigePeriodeId)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'uren_regels' }, () => {
      if (huidigePeriodeId) laadPeriodeData(huidigePeriodeId)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'perioden' }, () => {
      laadHuidigePeriode()
    })
    .subscribe()
}
