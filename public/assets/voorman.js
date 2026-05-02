import { supabase } from './supabase.js'
import { checkAuthAndRedirect, logout } from './auth.js'
import { renderVM, toast } from './render.js'
import { bindCorrectionHandlers } from './corrections.js'

const user = await checkAuthAndRedirect()
if (!user) { /* redirect ongoing */ }

let huidigePeriodeId = null
let cache = { periode: null, data: [], goedkeuringen: {} }
const approvedMdws = new Set() // lokale UX-state — niet gepersisteerd

const $ = (id) => document.getElementById(id)

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

async function init() {
  bindUI()
  bindCorrectionHandlers({
    root: $('vm-content'),
    getState: () => ({
      data: cache.data,
      opts: { goedkeuringen: cache.goedkeuringen, approvedMdws }
    }),
    userId: user?.id
  })
  await laadHuidigePeriode()
  abonneerRealtime()
}

function bindUI() {
  $('logout-btn').addEventListener('click', logout)

  // Klik-handlers voor de actieknoppen die renderVM in de tabel zet
  $('vm-content').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    if (action === 'approve-mdw') {
      approveMdw(btn.dataset.mdwnr)
    } else if (action === 'approve-afd') {
      approveAfd(btn.dataset.afdId, btn.dataset.afd)
    } else if (action === 'approve-all') {
      approveAfd(btn.dataset.afdId, btn.dataset.afd)
      await sendHR(btn.dataset.afdId, btn.dataset.afd)
    } else if (action === 'send-hr') {
      await sendHR(btn.dataset.afdId, btn.dataset.afd)
    }
  })
}

// === Periode laden ===

async function laadHuidigePeriode() {
  const { data: periodes, error } = await supabase
    .from('perioden')
    .select('*')
    .eq('status', 'open')
    .order('uploaded_at', { ascending: false })
    .limit(1)

  if (error) { toast('Periode laden mislukt: ' + error.message); return }

  if (!periodes || !periodes.length) {
    showLeegState()
    return
  }
  await laadPeriodeData(periodes[0].id)
}

function showLeegState() {
  huidigePeriodeId = null
  cache = { periode: null, data: [], goedkeuringen: {} }
  $('vm-content').innerHTML =
    `<div class="empty"><div class="icon">✅</div><p>Er zijn momenteel geen openstaande perioden.</p></div>`
  $('hdr-period').textContent = ''
}

async function laadPeriodeData(periode_id) {
  huidigePeriodeId = periode_id
  const [periodeR, regelsR, goedkR] = await Promise.all([
    supabase.from('perioden').select('*').eq('id', periode_id).single(),
    supabase
      .from('uren_regels')
      .select('*, medewerkers(mdwnr, naam), afdelingen(naam)')
      .eq('periode_id', periode_id)
      .order('medewerker_id, datum'),
    supabase.from('goedkeuringen').select('*').eq('periode_id', periode_id)
  ])

  if (regelsR.error) { toast('Uren laden mislukt: ' + regelsR.error.message); return }

  const periode = periodeR.data
  const data = transformNaarPrototype(regelsR.data || [])
  const goedkeuringen = {}
  ;(goedkR.data || []).forEach((g) => { goedkeuringen[g.afdeling_id] = g.goedgekeurd })

  cache = { periode, data, goedkeuringen }
  renderVM(data, periode, { goedkeuringen, approvedMdws })
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

// === Goedkeuren-flow ===

function approveMdw(mdwnr) {
  if (!mdwnr) return
  approvedMdws.add(mdwnr)
  rerender()
  toast(`Medewerker ${mdwnr} goedgekeurd ✓`)
}

function approveAfd(afdId, afdNaam) {
  if (!afdId) return
  cache.data
    .filter((m) => m.afdeling_id === afdId)
    .forEach((m) => approvedMdws.add(m.mdwnr))
  rerender()
  toast(`Afdeling "${afdNaam || ''}" goedgekeurd ✓`)
}

async function sendHR(afdId, afdNaam) {
  if (!afdId) return
  const mdws = cache.data.filter((m) => m.afdeling_id === afdId)
  const allOk = mdws.length > 0 && mdws.every((m) => approvedMdws.has(m.mdwnr))
  if (!allOk) {
    if (!confirm('Niet alle medewerkers zijn goedgekeurd. Toch doorsturen naar HR?')) return
    mdws.forEach((m) => approvedMdws.add(m.mdwnr))
  }

  const { error } = await supabase.from('goedkeuringen').upsert(
    {
      periode_id: huidigePeriodeId,
      afdeling_id: afdId,
      goedgekeurd: true,
      goedgekeurd_op: new Date().toISOString(),
      goedgekeurd_door: user.id
    },
    { onConflict: 'periode_id,afdeling_id' }
  )
  if (error) { toast('Doorsturen mislukt: ' + error.message); return }

  cache.goedkeuringen[afdId] = true
  rerender()
  toast(`✉ Afdeling "${afdNaam || ''}" doorgestuurd naar HR`)
}

function rerender() {
  renderVM(cache.data, cache.periode, {
    goedkeuringen: cache.goedkeuringen,
    approvedMdws
  })
}

// === Realtime: live status updates van andere voormannen / HR ===

function abonneerRealtime() {
  supabase.channel('voorman-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'goedkeuringen' }, () => {
      if (huidigePeriodeId) laadPeriodeData(huidigePeriodeId)
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'perioden' }, () => {
      laadHuidigePeriode()
    })
    .subscribe()
}
