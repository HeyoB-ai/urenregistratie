// Render functies — 1-op-1 uit public/prototype/urenregistratie.html
//
// Belangrijke afwijkingen t.o.v. prototype:
//  - Geen globals (CORR/APPR/DATA verwijderd). State + Supabase calls leven in voorman.js / hr.js.
//  - Inputs/textareas dragen data-regel-id zodat voorman.js de Supabase row kan updaten via event delegation.
//  - Inline onchange="..."/onclick="..." attributen vervangen door data-action/data-veld attributen.
//  - calcTot leest correcties uit dag.corr_* (toegevoegd door transformNaarPrototype) i.p.v. uit het CORR object.

// === Helpers (intern) ===

const F = (v, d = 2) =>
  v === null || v === undefined ? '—' : Number(v).toFixed(d).replace('.', ',')

const ESC = (s) => String(s ?? '').replace(/"/g, '&quot;').replace(/'/g, "&#39;")

// "2026-03-23" -> "23-03-2026" voor display. Laat overige formaten ongewijzigd zodat
// data-datum attributen (key voor corrections.js findDag) als ISO kunnen blijven.
export function formatDatumNL(s) {
  if (s == null || s === '') return ''
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return String(s)
  return `${m[3]}-${m[2]}-${m[1]}`
}

export function toHHMM(dec) {
  if (dec === null || dec === undefined) return '—'
  const h = Math.floor(dec)
  const m = Math.round((dec - h) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export const isLaat = (dec) => dec !== null && dec !== undefined && dec > 7.0

export function byAfd(data) {
  const map = {}
  data.forEach((m) => {
    const a = m.afdeling || 'Overig'
    if (!map[a]) map[a] = []
    map[a].push(m)
  })
  return map
}

function effGep(d)    { return d.corr_gepresteerd ?? d.gep ?? 0 }
function effOw100(d)  { return d.corr_ow100 ?? d.ow100 ?? 0 }
function effOw125(d)  { return d.corr_ow125 ?? d.ow125 ?? 0 }
function effOw150(d)  { return d.corr_ow150 ?? 0 }
function effOw200(d)  { return d.corr_ow200 ?? 0 }
function effZiek(d)   { return d.corr_ziek ?? d.ziek ?? 0 }
function effVerlof(d) { return d.corr_verlof ?? d.verlof ?? 0 }
function effReisk(d)  { return d.corr_reiskosten ?? 0 }

function isCorrected(d) {
  return d.corr_gepresteerd != null || d.corr_ow100 != null || d.corr_ow125 != null
      || d.corr_ow150 != null || d.corr_ow200 != null || d.corr_ziek != null
      || d.corr_verlof != null || d.corr_reiskosten != null
}

export function getNote(m) {
  const dag = m.dagen.find((d) => d.opmerking)
  return dag ? dag.opmerking : ''
}

function isAfdGoedgekeurd(afdeling_id, opts) {
  return !!(opts.goedkeuringen && opts.goedkeuringen[afdeling_id])
}

function isMdwApproved(m, opts) {
  if (isAfdGoedgekeurd(m.afdeling_id, opts)) return true
  return !!(opts.approvedMdws && opts.approvedMdws.has(m.mdwnr))
}

function getStatus(m, opts) {
  if (isMdwApproved(m, opts)) return 'ok'
  const note = getNote(m)
  return m.dagen.some(isCorrected) || note ? 'corr' : 'open'
}

export function calcTot(m) {
  let gep = 0, dag = 0, ow100 = 0, ow125 = 0, ow150 = 0, ow200 = 0
  let ziek = 0, verlof = 0, reiskosten = 0
  m.dagen.forEach((d) => {
    const g = effGep(d)
    gep        += g
    dag        += g - (d.gepland ?? 0)
    ow100      += effOw100(d)
    ow125      += effOw125(d)
    ow150      += effOw150(d)
    ow200      += effOw200(d)
    ziek       += effZiek(d)
    verlof     += effVerlof(d)
    reiskosten += effReisk(d)
  })
  return { gep, dag, ow100, ow125, ow150, ow200, ziek, verlof, reiskosten }
}

// === Render: Voormanportaal ===

export function renderVM(data, periode, opts = {}) {
  opts.goedkeuringen ||= {}
  opts.approvedMdws  ||= new Set()
  const readOnly = !!opts.readOnly || (periode && periode.status === 'gesloten')
  const hideApproval = !!opts.hideApproval

  const root = document.getElementById('vm-content')
  if (!root) return

  if (!data || !data.length) {
    root.innerHTML = `<div class="empty"><div class="icon">📂</div><p>Geen medewerkers in deze periode.</p></div>`
    setHeaderPeriod(periode)
    return
  }

  const afds = byAfd(data)
  const tot = data.length
  const nOk = data.filter((m) => getStatus(m, opts) === 'ok').length
  const nC  = data.filter((m) => getStatus(m, opts) === 'corr').length
  const nO  = data.filter((m) => getStatus(m, opts) === 'open').length

  let h = `
    <div class="toolbar">
      <h2>Weekoverzicht medewerkers</h2>
      <span class="period-label">${ESC(periode?.label || '')}</span>
    </div>
    <div class="stats-row">
      <div class="stat-card"><div class="lbl">Medewerkers</div><div class="val">${tot}</div></div>
      <div class="stat-card open"><div class="lbl">Open</div><div class="val">${nO}</div></div>
      <div class="stat-card corr"><div class="lbl">Gecorrigeerd</div><div class="val">${nC}</div></div>
      <div class="stat-card ok"><div class="lbl">Akkoord</div><div class="val">${nOk}</div></div>
    </div>`

  for (const [afd, mdws] of Object.entries(afds)) {
    const afdId = mdws[0]?.afdeling_id || ''
    const afdGoedgekeurd = isAfdGoedgekeurd(afdId, opts)
    const afdOk = mdws.filter((m) => isMdwApproved(m, opts)).length
    const allOk = afdOk === mdws.length

    h += `<div class="table-card">
      <div class="card-hdr">
        <span class="dept-badge">${ESC(afd)}</span>
        <h3>${mdws.length} medewerker${mdws.length !== 1 ? 's' : ''}</h3>
        <span style="font-size:11px;color:#5a6a7e">${afdOk}/${mdws.length} akkoord</span>
        ${!allOk && !readOnly && !hideApproval
          ? `<button class="btn btn-o btn-sm" data-action="approve-afd" data-afd="${ESC(afd)}" data-afd-id="${ESC(afdId)}">Afdeling goedkeuren</button>`
          : ''}
      </div>
      <div class="tbl-wrap"><table>
        <thead>
          <tr class="grp">
            <th rowspan="2"></th><th rowspan="2"></th><th rowspan="2"></th>
            <th rowspan="2" class="r">Gepland</th>
            <th colspan="2" class="sl">Tijdstip</th>
            <th rowspan="2" class="r sl">Gepresteerd<br><span style="font-weight:400;font-size:9px">(saldo)</span></th>
            <th rowspan="2" class="r sl">Dagsaldo</th>
            <th colspan="4" class="sl">Overwerk</th>
            <th colspan="2" class="sl">Absentie (invullen)</th>
            <th rowspan="2" class="sl">Reiskosten (€)</th>
            <th rowspan="2" class="sl">Opmerking</th>
            <th rowspan="2">Status</th>
          </tr>
          <tr class="cols">
            <th class="c sl">In</th><th class="c">Uit</th>
            <th class="r sl">100%</th><th class="r">125%</th><th class="r">150%</th><th class="r">200%</th>
            <th class="r sl">Ziek (u)</th><th class="r">Verlof (u)</th>
          </tr>
        </thead>
        <tbody>`

    mdws.forEach((m) => {
      const approved = readOnly || afdGoedgekeurd || isMdwApproved(m, opts)
      const status = getStatus(m, opts)
      const note = getNote(m)
      const rs = m.dagen.length + 1

      m.dagen.forEach((dag, di) => {
        const isFirst = di === 0
        const gepOrig = dag.gep
        const gepVal = dag.corr_gepresteerd ?? gepOrig
        const isCorrGep = dag.corr_gepresteerd != null && gepOrig !== null
          && Math.abs(dag.corr_gepresteerd - gepOrig) > 0.001

        const dagsaldo = (gepVal !== null && dag.gepland !== null) ? gepVal - dag.gepland : null
        const laat = isLaat(dag.tijdIn)

        const ow100 = effOw100(dag)
        const ow125 = effOw125(dag)
        const ow150 = effOw150(dag)
        const ow200 = effOw200(dag)
        const ziek  = effZiek(dag)
        const verl  = effVerlof(dag)
        const reisk = effReisk(dag)

        h += `<tr>`

        if (isFirst) {
          h += `<td rowspan="${rs}" style="font-weight:600;vertical-align:top;padding-top:9px;white-space:nowrap">${ESC(m.mdwnr)}</td>`
          h += `<td rowspan="${rs}" style="font-weight:500;vertical-align:top;padding-top:9px;white-space:nowrap">${ESC(m.naam)}</td>`
        }

        h += `<td style="color:#5a6a7e;white-space:nowrap">${ESC(formatDatumNL(dag.datum))}</td>`
        h += `<td class="r" data-col="gepland" data-val="${dag.gepland ?? ''}">${F(dag.gepland)}</td>`

        h += `<td class="c sl" style="white-space:nowrap">`
        if (laat) h += `<span class="time-laat" title="Tijdstip in na 07:00!">${toHHMM(dag.tijdIn)} ⚠</span>`
        else h += toHHMM(dag.tijdIn)
        h += `</td>`

        h += `<td class="c">${toHHMM(dag.tijdUit)}</td>`

        // Gepresteerd (saldo) — bewerkbaar
        if (approved) {
          h += `<td class="r sl">${F(gepVal)}</td>`
        } else {
          h += `<td class="sl" style="padding:4px 6px">
            <input type="text" class="ci${isCorrGep ? ' red' : ''}"
              value="${gepVal !== null ? F(gepVal) : ''}"
              data-regel-id="${ESC(dag.regel_id)}"
              data-mdwnr="${ESC(m.mdwnr)}" data-datum="${ESC(dag.datum)}"
              data-veld="corr_gepresteerd"
              data-origval="${gepOrig !== null ? gepOrig : ''}"
              title="Saldo aanpassen">
          </td>`
        }

        // Dagsaldo
        h += `<td class="r sl${dagsaldo !== null && dagsaldo < 0 ? ' neg' : ''}" data-col="dagsaldo">${F(dagsaldo)}</td>`

        // Overwerk: 100 / 125 / 150 / 200
        const owFields = [
          { veld: 'corr_ow100', field: 'ow100', val: ow100, sl: true  },
          { veld: 'corr_ow125', field: 'ow125', val: ow125, sl: false },
          { veld: 'corr_ow150', field: 'ow150', val: ow150, sl: false },
          { veld: 'corr_ow200', field: 'ow200', val: ow200, sl: false }
        ]
        owFields.forEach((f) => {
          if (approved) {
            h += `<td class="r${f.sl ? ' sl' : ''}">${f.val > 0 ? F(f.val) : '—'}</td>`
          } else {
            h += `<td class="${f.sl ? 'sl' : ''}" style="padding:4px 6px">
              <input type="text" class="ui${f.val > 0 ? ' hv' : ''}"
                value="${f.val > 0 ? F(f.val) : ''}" placeholder="0"
                data-regel-id="${ESC(dag.regel_id)}"
                data-mdwnr="${ESC(m.mdwnr)}" data-datum="${ESC(dag.datum)}"
                data-veld="${f.veld}" data-field="${f.field}">
            </td>`
          }
        })

        // Absentie: ziek / verlof
        const absFields = [
          { veld: 'corr_ziek',   field: 'ziek',   val: ziek, sl: true  },
          { veld: 'corr_verlof', field: 'verlof', val: verl, sl: false }
        ]
        absFields.forEach((f) => {
          if (approved) {
            h += `<td class="r${f.sl ? ' sl' : ''}">${f.val > 0 ? F(f.val) : '—'}</td>`
          } else {
            h += `<td class="${f.sl ? 'sl' : ''}" style="padding:4px 6px">
              <input type="text" class="ui${f.val > 0 ? ' hv' : ''}"
                value="${f.val > 0 ? F(f.val) : ''}" placeholder="0"
                data-regel-id="${ESC(dag.regel_id)}"
                data-mdwnr="${ESC(m.mdwnr)}" data-datum="${ESC(dag.datum)}"
                data-veld="${f.veld}" data-field="${f.field}">
            </td>`
          }
        })

        // Reiskosten
        if (approved) {
          h += `<td class="r sl">${reisk > 0 ? '€ ' + F(reisk) : '—'}</td>`
        } else {
          h += `<td class="sl" style="padding:4px 6px">
            <input type="text" class="ui${reisk > 0 ? ' hv' : ''}"
              value="${reisk > 0 ? F(reisk) : ''}" placeholder="0,00"
              data-regel-id="${ESC(dag.regel_id)}"
              data-mdwnr="${ESC(m.mdwnr)}" data-datum="${ESC(dag.datum)}"
              data-veld="corr_reiskosten" data-field="reiskosten">
          </td>`
        }

        // Opmerking + Status — rowspan
        if (isFirst) {
          const firstRegelId = m.dagen[0]?.regel_id || ''
          h += `<td rowspan="${rs}" class="sl" style="vertical-align:top;padding-top:6px">
            ${approved
              ? `<span style="font-size:11px;color:#5a6a7e">${ESC(note) || '—'}</span>`
              : `<textarea class="oi"
                  data-regel-id="${ESC(firstRegelId)}"
                  data-mdwnr="${ESC(m.mdwnr)}"
                  data-veld="opmerking"
                  placeholder="Opmerking...">${ESC(note)}</textarea>`
            }
          </td>`
          const bc = status === 'ok' ? 'b-ok' : status === 'corr' ? 'b-corr' : 'b-open'
          const bt = status === 'ok' ? 'Akkoord' : status === 'corr' ? 'Gecorrigeerd' : 'Open'
          h += `<td rowspan="${rs}" style="vertical-align:top;padding-top:6px;white-space:nowrap">
            <span class="badge status-badge ${bc}" data-mdwnr="${ESC(m.mdwnr)}">${bt}</span>
            ${!approved && !hideApproval
              ? `<br><button class="btn btn-sm" style="margin-top:6px;background:#e8f5e9;color:#2e7d32;border-color:#a5d6a7" data-action="approve-mdw" data-mdwnr="${ESC(m.mdwnr)}">Akkoord ✓</button>`
              : ''}
          </td>`
        }
        h += `</tr>`
      })

      // Totaalrij
      const t = calcTot(m)
      h += `<tr class="tot" data-mdwnr="${ESC(m.mdwnr)}">
        <td colspan="3" style="color:#5a6a7e;font-size:10px">Week totaal</td>
        <td class="r" data-col="gepland">${F(m.totaal?.gepland)}</td>
        <td class="c sl">—</td><td class="c">—</td>
        <td class="r sl" data-col="gepresteerd">${F(t.gep)}</td>
        <td class="r sl${t.dag < 0 ? ' neg' : ''}" data-col="dagsaldo">${F(t.dag)}</td>
        <td class="r sl" data-col="ow100">${t.ow100 > 0 ? F(t.ow100) : '—'}</td>
        <td class="r"    data-col="ow125">${t.ow125 > 0 ? F(t.ow125) : '—'}</td>
        <td class="r"    data-col="ow150">${t.ow150 > 0 ? F(t.ow150) : '—'}</td>
        <td class="r"    data-col="ow200">${t.ow200 > 0 ? F(t.ow200) : '—'}</td>
        <td class="r sl" data-col="ziek">${t.ziek > 0 ? F(t.ziek) : '—'}</td>
        <td class="r"    data-col="verlof">${t.verlof > 0 ? F(t.verlof) : '—'}</td>
        <td class="r sl" data-col="reiskosten">${t.reiskosten > 0 ? '€ ' + F(t.reiskosten) : '—'}</td>
        <td></td><td></td>
      </tr>`
    })

    h += `</tbody></table></div>
      <div class="approve-bar">
        <div class="leg">
          <span style="color:#e65c00;font-weight:700">●</span> Open &nbsp;
          <span style="color:#1565c0;font-weight:700">●</span> Gecorrigeerd &nbsp;
          <span style="color:#2e7d32;font-weight:700">●</span> Akkoord &nbsp;
          <span style="color:#c62828;font-weight:700">⚠</span> Tijdstip in na 07:00
        </div>
        <span class="as">${readOnly ? 'Periode gesloten — alleen lezen' : 'Wijzigingen worden automatisch opgeslagen'}</span>
        ${readOnly || afdGoedgekeurd || hideApproval
          ? ''
          : (allOk
              ? `<button class="btn btn-s" data-action="send-hr" data-afd="${ESC(afd)}" data-afd-id="${ESC(afdId)}">✉ Doorsturen naar HR</button>`
              : `<button class="btn btn-p" data-action="approve-all" data-afd="${ESC(afd)}" data-afd-id="${ESC(afdId)}">Alles goedkeuren &amp; doorsturen</button>`)
        }
      </div>
    </div>`
  }

  root.innerHTML = h
  setHeaderPeriod(periode)
}

// === Render: HR-overzicht ===

export function renderHR(data, periode, opts = {}) {
  opts.goedkeuringen ||= {}
  opts.approvedMdws  ||= new Set()

  const root = document.getElementById('hr-content')
  if (!root) return

  if (!data || !data.length) {
    root.innerHTML = `<div class="empty"><div class="icon">📂</div><p>Upload eerst de Immotix Excel.</p></div>`
    setHeaderPeriod(periode)
    return
  }

  const afds = byAfd(data)
  let h = `<div class="toolbar"><h2>HR-overzicht — ${ESC(periode?.label || '')}</h2></div>`

  for (const [afd, mdws] of Object.entries(afds)) {
    const afdId = mdws[0]?.afdeling_id || ''
    const afdGoedgekeurd = isAfdGoedgekeurd(afdId, opts)
    const allOk = afdGoedgekeurd || mdws.every((m) => isMdwApproved(m, opts))

    h += `<div class="table-card" style="margin-bottom:20px">
      <div class="card-hdr">
        <span class="dept-badge">${ESC(afd)}</span>
        <h3>${mdws.length} medewerker${mdws.length !== 1 ? 's' : ''}</h3>
        <span class="badge ${allOk ? 'b-ok' : 'b-open'}">${allOk ? 'Doorgestuurd' : 'In behandeling'}</span>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr class="cols">
          <th>Mdw. nr.</th><th>Naam</th>
          <th class="r">Gepland</th><th class="r">Gepresteerd</th><th class="r">Dagsaldo</th>
          <th class="r">OW 100%</th><th class="r">OW 125%</th><th class="r">OW 150%</th><th class="r">OW 200%</th>
          <th class="r">Ziek</th><th class="r">Verlof</th>
          <th class="r">Reiskosten (€)</th>
          <th>Opmerking</th><th>Status</th>
        </tr></thead><tbody>`

    mdws.forEach((m) => {
      const t = calcTot(m)
      const note = getNote(m)
      const s = getStatus(m, opts)
      const bc = s === 'ok' ? 'b-ok' : s === 'corr' ? 'b-corr' : 'b-open'
      const bt = s === 'ok' ? 'Akkoord' : s === 'corr' ? 'Gecorrigeerd' : 'Open'
      h += `<tr>
        <td>${ESC(m.mdwnr)}</td><td>${ESC(m.naam)}</td>
        <td class="r">${F(m.totaal?.gepland)}</td>
        <td class="r">${F(t.gep)}</td>
        <td class="r${t.dag < 0 ? ' neg' : ''}">${F(t.dag)}</td>
        <td class="r">${t.ow100 > 0 ? F(t.ow100) : '—'}</td>
        <td class="r">${t.ow125 > 0 ? F(t.ow125) : '—'}</td>
        <td class="r">${t.ow150 > 0 ? F(t.ow150) : '—'}</td>
        <td class="r">${t.ow200 > 0 ? F(t.ow200) : '—'}</td>
        <td class="r">${t.ziek > 0 ? F(t.ziek) : '—'}</td>
        <td class="r">${t.verlof > 0 ? F(t.verlof) : '—'}</td>
        <td class="r">${t.reiskosten > 0 ? '€ ' + F(t.reiskosten) : '—'}</td>
        <td style="font-size:11px;color:#5a6a7e">${ESC(note) || '—'}</td>
        <td><span class="badge ${bc}">${bt}</span></td>
      </tr>`
    })
    h += `</tbody></table></div></div>`
  }
  root.innerHTML = h
  setHeaderPeriod(periode)
}

// === DOM updates na correctie ===

export function herbereken(mdwnr, data) {
  const m = data.find((x) => x.mdwnr === mdwnr)
  if (!m) return
  const t = calcTot(m)
  const tr = document.querySelector(`tr.tot[data-mdwnr="${cssEsc(mdwnr)}"]`)
  if (!tr) return
  const set = (col, val, dash = false) => {
    const td = tr.querySelector(`td[data-col="${col}"]`)
    if (!td) return
    td.textContent = (dash && val === 0) ? '—' : F(val)
    if (col === 'dagsaldo') td.classList.toggle('neg', val < 0)
  }
  set('gepresteerd', t.gep)
  set('dagsaldo',    t.dag)
  set('ow100', t.ow100, true)
  set('ow125', t.ow125, true)
  set('ow150', t.ow150, true)
  set('ow200', t.ow200, true)
  set('ziek',  t.ziek,  true)
  set('verlof', t.verlof, true)
  set('reiskosten', t.reiskosten, true)
}

export function updateBadge(mdwnr, data, opts = {}) {
  const m = data.find((x) => x.mdwnr === mdwnr)
  if (!m) return
  const s = getStatus(m, opts)
  const el = document.querySelector(`.status-badge[data-mdwnr="${cssEsc(mdwnr)}"]`)
  if (!el) return
  el.className = 'badge status-badge ' + (s === 'ok' ? 'b-ok' : s === 'corr' ? 'b-corr' : 'b-open')
  el.textContent = s === 'ok' ? 'Akkoord' : s === 'corr' ? 'Gecorrigeerd' : 'Open'
}

export function updateDagsaldo(rowEl, gepNieuw) {
  const gpl = parseFloat(rowEl.querySelector('td[data-col="gepland"]')?.dataset.val || '0')
  const ds = gepNieuw - gpl
  const dsc = rowEl.querySelector('td[data-col="dagsaldo"]')
  if (!dsc) return
  dsc.textContent = F(ds)
  dsc.classList.toggle('neg', ds < 0)
}

export function validateOverwerk(mdwnr, datum, data) {
  const m = data.find((x) => x.mdwnr === mdwnr)
  if (!m) return
  const dag = m.dagen.find((d) => d.datum === datum)
  if (!dag) return
  const gep = effGep(dag)
  const gepland = dag.gepland || 0
  const dagsaldo = gep - gepland
  const owSom = effOw100(dag) + effOw125(dag) + effOw150(dag) + effOw200(dag)

  const sel = `input.ui[data-mdwnr="${cssEsc(mdwnr)}"][data-datum="${cssEsc(datum)}"][data-field^="ow"]`
  const inputs = document.querySelectorAll(sel)
  if (owSom > dagsaldo + 0.001) {
    inputs.forEach((inp) => {
      inp.classList.add('ow-over')
      inp.title = `Som overwerk (${F(owSom)}u) overschrijdt dagsaldo (${F(dagsaldo)}u)`
    })
    showOwWarn(mdwnr, datum, `⚠ Overwerk totaal ${F(owSom)}u — dagsaldo is ${F(Math.max(0, dagsaldo))}u`)
  } else {
    inputs.forEach((inp) => {
      inp.classList.remove('ow-over')
      inp.title = ''
    })
    clearOwWarn(mdwnr, datum)
  }
}

function owWarnId(mdwnr, datum) {
  return `ow-warn-${cssIdSafe(mdwnr)}-${String(datum).replace(/[^0-9]/g, '')}`
}

function showOwWarn(mdwnr, datum, msg) {
  const id = owWarnId(mdwnr, datum)
  let el = document.getElementById(id)
  if (!el) {
    const sel = `input.ui[data-mdwnr="${cssEsc(mdwnr)}"][data-datum="${cssEsc(datum)}"][data-field^="ow"]`
    const rows = document.querySelectorAll(sel)
    if (!rows.length) return
    const td = rows[rows.length - 1].closest('td')
    if (!td) return
    el = document.createElement('div')
    el.id = id
    el.style.cssText = 'position:absolute;background:#c62828;color:#fff;font-size:10px;padding:2px 7px;border-radius:4px;white-space:nowrap;z-index:99;margin-top:2px;pointer-events:none'
    td.style.position = 'relative'
    td.appendChild(el)
  }
  el.textContent = msg
  el.style.display = 'block'
}

function clearOwWarn(mdwnr, datum) {
  const el = document.getElementById(owWarnId(mdwnr, datum))
  if (el) el.style.display = 'none'
}

// CSS.escape met fallback voor oudere browsers
function cssEsc(s) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(s))
  return String(s).replace(/(["\\\]\[(){}.#:>~+*])/g, '\\$1')
}

function cssIdSafe(s) {
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_')
}

function setHeaderPeriod(periode) {
  const hp = document.getElementById('hdr-period')
  if (hp && periode) hp.textContent = periode.label || ''
}

// === Toast ===

export function toast(msg) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.style.display = 'block'
  clearTimeout(el._t)
  el._t = setTimeout(() => { el.style.display = 'none' }, 3000)
}
