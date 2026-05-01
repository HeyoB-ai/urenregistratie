// Gedeelde event-delegation voor uren_regels correcties.
// Gebruikt door voorman.js (eigen afdeling) en hr.js tab 2 (alle afdelingen
// die nog niet zijn goedgekeurd). RLS bepaalt of de UPDATE doorgaat.

import { supabase } from './supabase.js'
import { herbereken, updateBadge, updateDagsaldo, validateOverwerk } from './render.js'

export function bindCorrectionHandlers({ root, getState, userId }) {
  if (!root) return
  root.addEventListener('change', async (e) => {
    const t = e.target
    if (t.matches('input.ci'))         await handleGepresteerd(t, getState, userId)
    else if (t.matches('input.ui'))    await handleNumeric(t, getState, userId)
    else if (t.matches('textarea.oi')) await handleOpmerking(t, getState, userId)
  })
}

const F = (v, d = 2) =>
  v === null || v === undefined ? '' : Number(v).toFixed(d).replace('.', ',')

async function handleGepresteerd(el, getState, userId) {
  const state = getState() || {}
  const data  = state.data || []
  const opts  = state.opts || {}

  const regelId = el.dataset.regelId
  const mdwnr   = el.dataset.mdwnr
  const datum   = el.dataset.datum
  const origStr = el.dataset.origval || ''
  const origval = origStr === '' ? null : parseFloat(origStr)
  const nieuw   = parseFloat(String(el.value).replace(',', '.'))

  if (isNaN(nieuw)) {
    el.value = origval !== null ? F(origval) : ''
    return
  }

  const corrected = origval !== null && Math.abs(nieuw - origval) > 0.001
  el.classList.toggle('red', corrected)

  const dag = findDag(data, mdwnr, datum)
  if (dag) dag.corr_gepresteerd = corrected ? nieuw : null

  await persist(regelId, 'corr_gepresteerd', corrected ? nieuw : null, userId)

  const row = el.closest('tr')
  if (row) updateDagsaldo(row, nieuw)
  herbereken(mdwnr, data)
  updateBadge(mdwnr, data, opts)
}

async function handleNumeric(el, getState, userId) {
  const state = getState() || {}
  const data  = state.data || []
  const opts  = state.opts || {}

  const regelId = el.dataset.regelId
  const mdwnr   = el.dataset.mdwnr
  const datum   = el.dataset.datum
  const veld    = el.dataset.veld          // bijv. 'corr_ow100'
  const field   = el.dataset.field         // bijv. 'ow100' (voor selectors)

  const v   = parseFloat(String(el.value).replace(',', '.'))
  const val = isNaN(v) ? null : v
  el.classList.toggle('hv', (val ?? 0) > 0)

  const dag = findDag(data, mdwnr, datum)
  if (dag) dag[veld] = val

  await persist(regelId, veld, val, userId)

  if (field && field.startsWith('ow')) {
    validateOverwerk(mdwnr, datum, data)
  }

  herbereken(mdwnr, data)
  updateBadge(mdwnr, data, opts)
}

async function handleOpmerking(el, getState, userId) {
  const state = getState() || {}
  const data  = state.data || []
  const opts  = state.opts || {}

  const regelId = el.dataset.regelId
  const mdwnr   = el.dataset.mdwnr
  const text    = el.value

  const m = data.find((x) => x.mdwnr === mdwnr)
  if (m && m.dagen[0]) m.dagen[0].opmerking = text || null

  await persist(regelId, 'opmerking', text || null, userId)
  updateBadge(mdwnr, data, opts)
}

async function persist(regelId, veld, waarde, userId) {
  if (!regelId) return
  const update = {
    [veld]: waarde,
    gecorrigeerd_op: new Date().toISOString(),
    gecorrigeerd_door: userId
  }
  const { error } = await supabase.from('uren_regels').update(update).eq('id', regelId)
  if (error) console.error('Correctie opslaan mislukt:', error)
}

function findDag(data, mdwnr, datum) {
  const m = data.find((x) => x.mdwnr === mdwnr)
  if (!m) return null
  return m.dagen.find((d) => d.datum === datum)
}
