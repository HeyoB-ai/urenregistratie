# Technische Specificatie — Urenregistratie Portaal
## Versie 1.0 | Mei 2026

---

## 1. Doel

HR uploadt wekelijks de Immotix Excel export. De applicatie splitst de data automatisch per afdeling. Elke leidinggevende ontvangt maandagochtend een e-mail met een directe link naar zijn eigen afdelingspagina, waar hij uren kan controleren, corrigeren en goedkeuren. HR heeft een apart dashboard met toegang tot alle afdelingen.

De UI blijft 100% identiek aan het goedgekeurde prototype (urenregistratie.html). Alleen de datalaag verandert van lokaal naar Supabase.

---

## 2. Stack

| Onderdeel | Technologie |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (geen framework) |
| Database + Auth | Supabase (PostgreSQL + Row Level Security) |
| Hosting | Netlify (statische site + serverless functions) |
| E-mail | Brevo (transactional API) via Netlify function |
| Excel parsing | SheetJS (xlsx) — zelfde library als in prototype |
| Versiebeheer | GitHub |

---

## 3. Projectstructuur

```
urenregistratie/
├── public/
│   ├── index.html               # Login pagina (magic link)
│   ├── auth-callback.html       # Vangt magic link sessie op, redirect op rol
│   ├── hr.html                  # HR dashboard
│   ├── voorman.html             # Leidinggevende pagina
│   └── assets/
│       ├── supabase.js          # Supabase client init + exports
│       ├── auth.js              # Login / logout / sessie bewaken / redirect
│       ├── hr.js                # HR logica: upload, overzicht, status
│       ├── voorman.js           # Voorman logica: laden, corrigeren, goedkeuren
│       ├── render.js            # Render functies 1-op-1 uit prototype
│       ├── xlsx.full.min.js     # SheetJS lokale kopie
│       └── style.css            # CSS 1-op-1 uit prototype
├── netlify/
│   └── functions/
│       ├── parse-excel.js       # POST: verwerk Excel upload naar Supabase
│       └── send-weekly-emails.js # Scheduled: elke maandag 07:00 UTC
├── netlify.toml
├── package.json
├── .env.example
└── SPEC.md
```

---

## 4. Database Schema

Voer uit in Supabase SQL Editor.

```sql
-- Afdelingen
CREATE TABLE afdelingen (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  naam       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Leidinggevenden (gekoppeld aan Supabase Auth)
CREATE TABLE leidinggevenden (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  naam        TEXT NOT NULL,
  email       TEXT NOT NULL UNIQUE,
  afdeling_id UUID REFERENCES afdelingen(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Perioden (een record per Excel upload)
CREATE TABLE perioden (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label        TEXT NOT NULL,         -- bijv. "23-03-2026 t/m 29-03-2026"
  week_nummer  INT,
  jaar         INT,
  uploaded_at  TIMESTAMPTZ DEFAULT now(),
  uploaded_by  UUID REFERENCES auth.users(id),
  status       TEXT DEFAULT 'open'    -- 'open' of 'gesloten'
);

-- Medewerkers (mdwnr is uniek over alle perioden)
CREATE TABLE medewerkers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mdwnr       TEXT NOT NULL UNIQUE,
  naam        TEXT,
  afdeling_id UUID REFERENCES afdelingen(id),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Dagregels per medewerker per periode
CREATE TABLE uren_regels (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periode_id        UUID REFERENCES perioden(id) ON DELETE CASCADE,
  medewerker_id     UUID REFERENCES medewerkers(id),
  afdeling_id       UUID REFERENCES afdelingen(id),
  datum             DATE NOT NULL,

  -- Originele Immotix waarden (nooit overschrijven na import)
  tijd_in           NUMERIC,    -- decimale uren: 7.5 = 07:30
  tijd_uit          NUMERIC,
  gepland           NUMERIC,
  gepresteerd       NUMERIC,    -- netto saldo uit Immotix
  ow100             NUMERIC DEFAULT 0,
  ow125             NUMERIC DEFAULT 0,
  ziek              NUMERIC DEFAULT 0,
  verlof            NUMERIC DEFAULT 0,

  -- Correcties door leidinggevende (NULL = niet gewijzigd)
  corr_gepresteerd  NUMERIC,
  corr_ow100        NUMERIC,
  corr_ow125        NUMERIC,
  corr_ow150        NUMERIC,
  corr_ow200        NUMERIC,
  corr_ziek         NUMERIC,
  corr_verlof       NUMERIC,
  corr_reiskosten   NUMERIC,
  opmerking         TEXT,

  gecorrigeerd_op   TIMESTAMPTZ,
  gecorrigeerd_door UUID REFERENCES auth.users(id),

  UNIQUE(periode_id, medewerker_id, datum)
);

-- Goedkeuring per afdeling per periode
CREATE TABLE goedkeuringen (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  periode_id       UUID REFERENCES perioden(id) ON DELETE CASCADE,
  afdeling_id      UUID REFERENCES afdelingen(id),
  goedgekeurd      BOOLEAN DEFAULT false,
  goedgekeurd_op   TIMESTAMPTZ,
  goedgekeurd_door UUID REFERENCES auth.users(id),
  UNIQUE(periode_id, afdeling_id)
);
```

---

## 5. Row Level Security

```sql
-- RLS aanzetten
ALTER TABLE afdelingen      ENABLE ROW LEVEL SECURITY;
ALTER TABLE leidinggevenden ENABLE ROW LEVEL SECURITY;
ALTER TABLE perioden        ENABLE ROW LEVEL SECURITY;
ALTER TABLE medewerkers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE uren_regels     ENABLE ROW LEVEL SECURITY;
ALTER TABLE goedkeuringen   ENABLE ROW LEVEL SECURITY;

-- Helperfuncties
CREATE OR REPLACE FUNCTION mijn_afdeling_id()
RETURNS UUID AS $$
  SELECT afdeling_id FROM leidinggevenden
  WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION is_hr()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = auth.uid()
    AND raw_user_meta_data->>'rol' = 'hr'
  );
$$ LANGUAGE sql SECURITY DEFINER;

-- Perioden
CREATE POLICY "HR alles"       ON perioden FOR ALL    USING (is_hr());
CREATE POLICY "Voorman lezen"  ON perioden FOR SELECT USING (auth.uid() IS NOT NULL);

-- Afdelingen
CREATE POLICY "Iedereen lezen" ON afdelingen FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY "HR schrijven"   ON afdelingen FOR ALL   USING (is_hr());

-- Medewerkers
CREATE POLICY "HR alles"              ON medewerkers FOR ALL    USING (is_hr());
CREATE POLICY "Voorman eigen afdeling" ON medewerkers FOR SELECT
  USING (afdeling_id = mijn_afdeling_id());

-- Uren regels
CREATE POLICY "HR alles"             ON uren_regels FOR ALL    USING (is_hr());
CREATE POLICY "Voorman lezen eigen"  ON uren_regels FOR SELECT
  USING (afdeling_id = mijn_afdeling_id());
CREATE POLICY "Voorman corrigeren"   ON uren_regels FOR UPDATE
  USING (afdeling_id = mijn_afdeling_id())
  WITH CHECK (afdeling_id = mijn_afdeling_id());

-- Goedkeuringen
CREATE POLICY "HR alles"            ON goedkeuringen FOR ALL    USING (is_hr());
CREATE POLICY "Voorman lezen eigen" ON goedkeuringen FOR SELECT
  USING (afdeling_id = mijn_afdeling_id());
CREATE POLICY "Voorman goedkeuren"  ON goedkeuringen FOR INSERT
  WITH CHECK (afdeling_id = mijn_afdeling_id());
CREATE POLICY "Voorman bijwerken"   ON goedkeuringen FOR UPDATE
  USING (afdeling_id = mijn_afdeling_id());
```

---

## 6. Supabase Auth Setup

Gebruikersrollen worden opgeslagen in `raw_user_meta_data`:

```json
{ "rol": "hr",      "naam": "Anna de Vries" }
{ "rol": "voorman", "naam": "Jan Vermeer"    }
```

Instellen via SQL na het aanmaken van de user:
```sql
UPDATE auth.users
SET raw_user_meta_data = '{"rol":"hr","naam":"Anna de Vries"}'
WHERE email = 'hr@bedrijf.nl';
```

Magic Link activeren: Supabase dashboard > Authentication > Providers > Email > Enable Magic Link.

Leidinggevenden hoeven nooit een wachtwoord in te voeren. De wekelijkse e-mail bevat een magic link die hen direct inlogt en naar voorman.html stuurt.

---

## 7. Netlify Functions

### 7a. parse-excel.js

Trigger: POST vanuit hr.js na Excel upload
Authorisatie: Bearer JWT token van ingelogde HR gebruiker

Verwerking stap voor stap:
1. Valideer JWT (alleen rol=hr mag dit aanroepen).
2. Parse de multipart body (busboy).
3. Lees Excel bytes met SheetJS (`xlsx`).
4. Voer `parseImmotix()` logica uit (1-op-1 uit prototype): leid label/weeknummer/jaar af uit de "Selectie:" header, vang `Totaal` rijen, lees kolommen 0..14 uit elke datumrij. ISO-week + jaar uit de eerste datum.
5. Bij **één corrupte rij**: gooi error met rijnummer en reden ("Import mislukt op rij 47 — ongeldige datum '32-03-2026'. Geen data opgeslagen."). Niets opgeslagen.
6. Bij **bestaande open periode**: HTTP 409 met "Er is al een open periode. Sluit deze eerst af voor u een nieuwe upload doet."
7. Roep RPC `import_periode(label, week, jaar, user_id, afdelingen, medewerkers, regels)` aan via service-key client. De RPC doet **alles in één transactie**:
   - Insert in `perioden`.
   - Per unieke afdelingsnaam: hergebruik of insert in `afdelingen`.
   - Per uniek `mdwnr`: hergebruik of insert in `medewerkers`. **Bestaande medewerkers worden niet bijgewerkt** (drift via `uren_regels.afdeling_id`).
   - Insert alle dagregels in `uren_regels` (alleen originele Immotix-velden; `corr_*` blijven NULL).
   - Insert lege `goedkeuringen` records per afdeling voor deze periode.
8. Return `{ periode_id, afdelingen_count, medewerkers_count, regels_count }`.

De RPC SQL staat in `supabase/import_periode.sql` en moet eenmalig in de Supabase SQL Editor worden uitgevoerd na het schema (sectie 4) en RLS (sectie 5).

Gebruik de Supabase service key (niet de anon key) in server-side functions.

### 7b. send-weekly-emails.js

Trigger: Netlify Scheduled Function
Schedule in netlify.toml: `"0 7 * * 1-5"` (elke werkdag 07:00 UTC)
Ook handmatig aanroepbaar via POST vanuit hr.js (knop "Verstuur weekmail").

Verwerking stap voor stap:
1. Haal de meest recente periode met `status='open'` op.
2. Haal alle leidinggevenden op inclusief hun afdeling-id en naam.
3. Filter de leidinggevenden weg waarvan de `goedkeuringen.goedgekeurd` voor hun `afdeling_id + periode_id` al `true` is — die hoeven geen herinnering meer.
4. Genereer per overgebleven leidinggevende een magic link via `supabase.auth.admin.generateLink()` (type `magiclink`, redirectTo `/auth-callback.html?next=/voorman.html`).
5. Stuur per ontvanger een e-mail via Brevo (`POST https://api.brevo.com/v3/smtp/email`) met dag-afhankelijke onderwerpregel:
   - **Maandag** → `Urenregistratie week XX — actie vereist`
   - **Dinsdag t/m donderdag** → `Herinnering: urenregistratie week XX nog niet goedgekeurd`
   - **Vrijdag** → `Laatste kans: urenregistratie week XX — deadline vandaag 17:00`

E-mail template bevat:
- Naam leidinggevende
- Afdeling naam
- Periode label (bijv. "week 16, 23-03-2026 t/m 29-03-2026")
- Deadline-datum (vrijdag DD-MM 17:00, zie sectie 17)
- Grote call-to-action knop met magic link
- Vermelding dat de link 24 uur geldig is

---

## 8. Frontend — auth.js

```javascript
import { supabase } from './supabase.js'

// Stuur magic link
export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: window.location.origin + '/auth-callback.html'
    }
  })
  return error
}

// Controleer sessie en redirect op rol
export async function checkAuthAndRedirect() {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) { window.location.href = '/index.html'; return null }
  const rol = user.user_metadata?.rol
  if (rol === 'hr' && !window.location.pathname.includes('hr.html')) {
    window.location.href = '/hr.html'
  }
  if (rol === 'voorman' && !window.location.pathname.includes('voorman.html')) {
    window.location.href = '/voorman.html'
  }
  return user
}

// Uitloggen
export async function logout() {
  await supabase.auth.signOut()
  window.location.href = '/index.html'
}
```

---

## 9. Frontend — hr.js

```javascript
import { supabase } from './supabase.js'
import { checkAuthAndRedirect } from './auth.js'
import { renderHR } from './render.js'  // uit prototype

// Bij laden
const user = await checkAuthAndRedirect()

// Excel uploaden
async function uploadExcel(file) {
  const formData = new FormData()
  formData.append('excel', file)
  const { data: { session } } = await supabase.auth.getSession()
  const resp = await fetch('/.netlify/functions/parse-excel', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: formData
  })
  const { periode_id } = await resp.json()
  await laadPeriode(periode_id)
}

// Data laden voor een periode
async function laadPeriode(periode_id) {
  const { data } = await supabase
    .from('uren_regels')
    .select('*, medewerkers(mdwnr, naam), afdelingen(naam)')
    .eq('periode_id', periode_id)
    .order('afdeling_id, medewerker_id, datum')

  const { data: goedkeuringen } = await supabase
    .from('goedkeuringen')
    .select('*')
    .eq('periode_id', periode_id)

  renderHR(transformNaarPrototype(data, goedkeuringen))
}

// Realtime: live goedkeuringen binnenkrijgen
supabase.channel('goedkeuringen')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'goedkeuringen' },
    () => laadPeriode(huidigePeriodeId))
  .subscribe()
```

---

## 10. Frontend — voorman.js

```javascript
import { supabase } from './supabase.js'
import { checkAuthAndRedirect } from './auth.js'
import { renderVM } from './render.js'  // uit prototype

const user = await checkAuthAndRedirect()

// Data laden (RLS filtert automatisch op eigen afdeling)
async function laadMijnAfdeling() {
  const { data: periode } = await supabase
    .from('perioden')
    .select('*')
    .eq('status', 'open')
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .single()

  if (!periode) {
    // Geen open periode: toon melding
    document.getElementById('vm-content').innerHTML =
      '<div class="empty"><div class="icon">✅</div><p>Er zijn momenteel geen openstaande perioden.</p></div>'
    return
  }

  // Periode gesloten = read-only
  if (periode.status === 'gesloten') setReadOnly(true)

  const { data: regels } = await supabase
    .from('uren_regels')
    .select('*, medewerkers(mdwnr, naam)')
    .eq('periode_id', periode.id)
    .order('medewerker_id, datum')

  huidigePeriodeId = periode.id
  renderVM(transformNaarPrototype(regels), periode)
}

// Correctie opslaan (debounced, bij elke wijziging)
async function slaCorrectieOp(regel_id, veld, waarde) {
  await supabase
    .from('uren_regels')
    .update({
      [veld]: waarde,
      gecorrigeerd_op: new Date().toISOString(),
      gecorrigeerd_door: user.id
    })
    .eq('id', regel_id)
}

// Goedkeuring
async function keurGoed(afdeling_id) {
  await supabase.from('goedkeuringen').upsert({
    periode_id: huidigePeriodeId,
    afdeling_id,
    goedgekeurd: true,
    goedgekeurd_op: new Date().toISOString(),
    goedgekeurd_door: user.id
  })
}
```

---

## 11. render.js — hergebruik prototype

render.js bevat alle render functies exact gekopieerd uit het prototype:
- renderVM(data, periode)
- renderHR(data)
- calcTot(m)
- herbereken(mdwnr)
- updateBadge(mdwnr)
- toHHMM(dec)
- isLaat(dec)

Enige aanpassing: event handlers in de gegenereerde HTML roepen nu
slaCorrectieOp(regel_id, veld, waarde) aan in plaats van lokaal CORR object bijwerken.

De regel_id wordt meegegeven als data-attribuut op elk invoerveld:
data-regel-id="<uuid uit Supabase>"

---

## 12. Data Transformatie

Supabase geeft platte rijen terug. transformNaarPrototype() zet deze om
naar het geneste formaat dat de render functies verwachten:

```javascript
function transformNaarPrototype(regels) {
  const mdwMap = {}

  for (const r of regels) {
    const mdwnr = r.medewerkers.mdwnr
    if (!mdwMap[mdwnr]) {
      mdwMap[mdwnr] = {
        mdwnr,
        naam:      r.medewerkers.naam || `Mdw. ${mdwnr}`,
        afdeling:  r.afdelingen?.naam || '',
        dagen:     [],
        totaal:    null
      }
    }
    mdwMap[mdwnr].dagen.push({
      regel_id:        r.id,          // nieuw: voor Supabase updates
      datum:           r.datum,
      tijdIn:          r.tijd_in,
      tijdUit:         r.tijd_uit,
      gepland:         r.gepland,
      gep:             r.gepresteerd,
      ow100:           r.ow100,
      ow125:           r.ow125,
      ziek:            r.ziek,
      verlof:          r.verlof,
      // Correcties (null = niet gewijzigd)
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

  return Object.values(mdwMap)
}
```

---

## 13. netlify.toml

```toml
[build]
  publish = "public"
  functions = "netlify/functions"

[functions]
  node_bundler = "esbuild"

[functions."send-weekly-emails"]
  schedule = "0 7 * * 1"

[[redirects]]
  from = "/auth-callback"
  to = "/auth-callback.html"
  status = 200

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

---

## 14. .env.example

```
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
RESEND_API_KEY=re_...
APP_URL=https://urenregistratie.netlify.app
```

Voeg .env toe aan .gitignore. Stel variabelen in via Netlify dashboard > Site settings > Environment variables.

---

## 15. Dataflow samenvatting

```
MAANDAG OCHTEND
  HR uploadt Excel via hr.html
  parse-excel.js verwerkt naar Supabase
  HR ziet overzicht: alle afdelingen = "Open"

MAANDAG 07:00 (automatisch of via HR knop)
  send-weekly-emails.js draait
  Magic link gegenereerd per leidinggevende
  E-mail verstuurd via Resend

LEIDINGGEVENDE (maandag t/m vrijdag)
  Klikt op link in e-mail
  Magic link logt hem in, redirect naar voorman.html
  RLS: hij ziet alleen zijn eigen afdeling
  Corrigeert uren — elke wijziging direct opgeslagen in Supabase
  Klikt "Goedkeuren" — goedkeuringen tabel bijgewerkt

HR (doorlopend, realtime)
  Ziet live op hr.html de status per afdeling veranderen
  Alle afdelingen akkoord = HR sluit de periode
  Periode status = gesloten, data bevroren
```

---

## 16. Timing van de werkweek

De Excel die HR maandagochtend uploadt bevat de uren van de **vorige werkweek**.
Flow:

- Vorige week (ma t/m zo): medewerkers werken, Immotix registreert.
- Maandag: HR exporteert Immotix Excel en uploadt op het portaal.
- Maandag 07:00: scheduled function stuurt e-mail naar elke leidinggevende met magic link.
- Maandag t/m vrijdag: leidinggevenden controleren en corrigeren hun afdeling.
- Vrijdag 17:00: deadline voor goedkeuring (zie sectie 17).
- Maandag erna: HR exporteert naar NMBRS en sluit de periode.

---

## 17. Deadline en waarschuwingen

Elke periode heeft een deadline = vrijdag 17:00 van de week waarin de Excel werd geüpload.

Berekening (in render.js):

```javascript
export function deadlineFor(periode) {
  if (!periode?.uploaded_at) return null
  const uploaded = new Date(periode.uploaded_at)
  const dow = uploaded.getDay()           // 0 = zo, 1 = ma, ..., 5 = vr, 6 = za
  const daysToFriday = ((5 - dow) + 7) % 7
  const friday = new Date(uploaded)
  friday.setDate(uploaded.getDate() + daysToFriday)
  friday.setHours(17, 0, 0, 0)
  if (friday < uploaded) friday.setDate(friday.getDate() + 7) // randgeval: na vr 17:00 geüpload
  return friday
}
```

Op de voorman-pagina toont een gele waarschuwingsbalk bovenaan zodra het **woensdag of later** is en de afdeling nog niet is goedgekeurd:

> ⚠ Goedkeuren vóór vrijdag 17:00. Daarna kan HR de uren niet meer meenemen in de salarisverwerking.

Na de deadline wordt de balk rood ("Deadline verstreken — neem contact op met HR"). De goedkeuringsknop blijft tot dan beschikbaar; daarna sluit HR de periode en is alles read-only.

De wekelijkse e-mail (sectie 7b) bevat eveneens de deadline-tekst.

---

## 18. NMBRS Export (stap 11)

Op het HR-dashboard staat naast "Sluit periode" een knop **"Exporteer naar NMBRS"**. Deze genereert client-side een Excel met één rij per medewerker met de weektotalen.

Kolomvolgorde (generiek formaat — pas aan zodra de NMBRS-beheerder van QBTec het exacte importformaat aanlevert):

1. Medewerkersnummer
2. Naam
3. Periode (weeknummer/jaar)
4. Gepland (uren)
5. Gepresteerd (`corr_gepresteerd` indien aanwezig, anders origineel)
6. Dagsaldo
7. Overwerk 100%
8. Overwerk 125%
9. Overwerk 150%
10. Overwerk 200%
11. Ziek (uren)
12. Verlof (uren)
13. Reiskosten (€)
14. Opmerking

Implementatie via SheetJS in de browser (`XLSX.utils.aoa_to_sheet` + `XLSX.writeFile`). Bestandsnaam: `NMBRS_export_week<NN>_<YYYY>.xlsx`.

**Open vraag voor QBTec**: heeft NMBRS een vast importformaat (CSV/Excel, kolomnamen, taal)? Zo ja, pas kolomnamen en volgorde aan in `hr.js` → functie `exportNMBRS()`.

---

## 19. Toekomstige verbeteringen / technische schuld

- **Postgres trigger op `uren_regels`** — voeg een trigger toe die voor de voorman-rol schrijven naar de originele Immotix-kolommen (`tijd_in`, `tijd_uit`, `gepland`, `gepresteerd`, `ow100`, `ow125`, `ziek`, `verlof`) blokkeert na de initiële import. Op dit moment wordt dit alleen door de UI afgedwongen (frontend stuurt uitsluitend `corr_*` velden + `opmerking`). Postgres RLS werkt op rijniveau, niet op kolomniveau, dus een trigger is de juiste manier om dit op datalaag-niveau te garanderen.
- **History-view voor HR** — momenteel toont het HR-dashboard alleen de meest recente open periode. Voeg een dropdown of aparte history-tab toe om gesloten perioden terug te bekijken (sectie 7 punt 2 antwoord).
- **HR-override notificaties** — wanneer HR via tab 2 corrigeert op een afdeling die nog niet is goedgekeurd, weet de leidinggevende dat niet. Overweeg een notificatie of audit-log.
