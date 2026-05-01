# QBTec Urenregistratie

Webportaal waarmee HR wekelijks de Immotix Excel-export uploadt en leidinggevenden hun afdelingsuren controleren, corrigeren en goedkeuren. Vanuit één dashboard exporteert HR de definitieve weektotalen naar NMBRS voor salarisverwerking.

Volledige technische specificatie: zie [`SPEC.md`](SPEC.md).

---

## 1. Projectoverzicht

| Onderdeel | Technologie |
|---|---|
| Frontend | Vanilla HTML / CSS / JavaScript (geen framework) |
| Database + Auth | Supabase (PostgreSQL + Row Level Security + Magic Link) |
| Hosting | Netlify (statische site + serverless functions) |
| E-mail | Brevo (transactional API) via Netlify function |
| Excel | SheetJS (`xlsx`) — server-side import, client-side NMBRS-export |
| Versiebeheer | GitHub |

**Bestandsstructuur**

```
QBtec/
├── public/
│   ├── prototype/urenregistratie.html   referentie — niet aanraken
│   ├── index.html                        login (magic link)
│   ├── auth-callback.html                vangt magic link op
│   ├── hr.html                           HR dashboard (tabs, NMBRS, sluit)
│   ├── voorman.html                      voorman portaal (deadline + tabel)
│   └── assets/
│       ├── supabase.js                   client (laadt config via /.netlify/functions/config)
│       ├── auth.js                       login / logout / rol-redirect
│       ├── render.js                     renderVM, renderHR, helpers
│       ├── corrections.js                gedeelde event delegation
│       ├── hr.js                         HR logica
│       ├── voorman.js                    voorman logica
│       ├── style.css                     login + dashboard CSS
│       └── xlsx.full.min.js              placeholder (SheetJS via CDN in HTML)
├── netlify/functions/
│   ├── config.js                         GET: publieke Supabase config (URL + anon key)
│   ├── parse-excel.js                    POST: JWT → multipart → RPC
│   └── send-weekly-emails.js             cron + handmatige trigger
├── supabase/
│   └── import_periode.sql                atomaire import RPC
├── netlify.toml                          build + cron config
├── package.json
├── .env.example                          env-template
├── SPEC.md                               technische specificatie
└── README.md                             dit bestand
```

---

## 2. Vereisten

- **Node.js 18 of hoger** — `node --version`
- **Git** — `git --version`
- Een **GitHub** account (waar deze repo gehost wordt)
- Een **Netlify** account (https://app.netlify.com)
- Een **Supabase** account met een nieuw project (https://supabase.com)
- Een **Brevo** account (https://app.brevo.com) — het free tier (300 e-mails/dag) is ruim voldoende
- DNS-toegang tot `qbtec.nl` voor:
  - Brevo SPF/DKIM records
  - Custom domain `uren.qbtec.nl` op Netlify

Lokaal installeren:

```bash
cd QBtec
npm install
```

---

## 3. Supabase setup

### 3.1. Project aanmaken

1. Log in op https://supabase.com → **New project**
2. Kies een regio in Europa (bv. `eu-central-1`)
3. Bewaar het wachtwoord en wacht tot het project is opgestart (~2 minuten)

### 3.2. SQL — drie blokken, in deze volgorde

Ga naar **SQL Editor** in het Supabase-dashboard. Voer onderstaande blokken één voor één uit met de **Run**-knop. Een blok pas draaien als het vorige zonder fout is uitgevoerd.

**Blok 1 — Schema (tabellen)**
- Open `SPEC.md` → sectie **4. Database Schema**
- Kopieer het volledige SQL-blok in een nieuwe SQL Editor-query
- Klik **Run**
- Onder *Database › Tables* moeten nu 6 tabellen zichtbaar zijn: `afdelingen`, `leidinggevenden`, `perioden`, `medewerkers`, `uren_regels`, `goedkeuringen`

**Blok 2 — Row Level Security**
- Open `SPEC.md` → sectie **5. Row Level Security**
- Kopieer het volledige SQL-blok in een nieuwe query
- Klik **Run**
- Onder *Authentication › Policies* moeten policies zichtbaar zijn per tabel

**Blok 3 — Import RPC**
- Open `supabase/import_periode.sql` in deze repo
- Kopieer de hele inhoud in een nieuwe query
- Klik **Run**
- Onder *Database › Functions* moet `import_periode` zichtbaar zijn

### 3.3. Authentication instellen

1. **Authentication › Providers › Email** → zet **Magic Link** aan, sla op
2. **Authentication › URL Configuration** → voeg toe aan *Redirect URLs*:
   - `https://uren.qbtec.nl/auth-callback.html` (productie)
   - `https://urenregistratie.netlify.app/auth-callback.html` (Netlify default, als alias)
   - `http://localhost:8888/auth-callback.html` (voor lokale `netlify dev`)

### 3.4. Eerste users aanmaken

**HR-user:**

1. **Authentication › Users › Add user** → e-mail HR-medewerker, "Auto Confirm User" aan, geen wachtwoord
2. SQL Editor:
   ```sql
   UPDATE auth.users
   SET raw_user_meta_data = '{"rol":"hr","naam":"Anna de Vries"}'
   WHERE email = 'anna@qbtec.nl';
   ```

**Voor elke leidinggevende:**

1. **Authentication › Users › Add user** → e-mail leidinggevende, "Auto Confirm User" aan
2. SQL:
   ```sql
   -- Stel rol in
   UPDATE auth.users
   SET raw_user_meta_data = '{"rol":"voorman","naam":"Jan Vermeer"}'
   WHERE email = 'jan@qbtec.nl';

   -- Maak afdeling aan (eenmalig, of laat door eerste Excel-import doen)
   INSERT INTO afdelingen (naam) VALUES ('Productie');

   -- Koppel leidinggevende aan auth-user en afdeling
   INSERT INTO leidinggevenden (user_id, naam, email, afdeling_id)
   VALUES (
     (SELECT id FROM auth.users WHERE email = 'jan@qbtec.nl'),
     'Jan Vermeer',
     'jan@qbtec.nl',
     (SELECT id FROM afdelingen WHERE naam = 'Productie')
   );
   ```

> Afdelingen worden ook automatisch aangemaakt bij de eerste Excel-import, maar `leidinggevenden.afdeling_id` moet je zelf koppelen.

### 3.5. Sleutels noteren

Ga naar **Project Settings › API** en noteer:
- `Project URL` → wordt `SUPABASE_URL`
- `anon public` → wordt `SUPABASE_ANON_KEY` (publiek, hoort in de frontend)
- `service_role` → wordt `SUPABASE_SERVICE_KEY` (geheim, alleen Netlify env vars)

---

## 4. Brevo setup

1. Maak een Brevo-account → https://app.brevo.com
2. **Senders, Domains & dedicated IPs › Domains › Add domain** → voer `qbtec.nl` in
3. Brevo toont SPF/DKIM-records. Voeg deze toe aan de DNS van `qbtec.nl`. Wacht op verificatie (kan tot enkele uren duren)
4. **SMTP & API › API Keys › Generate a new API key** (v3) — kopieer de key (begint met `xkeysib-`); deze wordt later `BREVO_API_KEY`

> Tot het domein geverifieerd is kan Brevo geen mail versturen vanaf `noreply@qbtec.nl`. Wacht op groen vinkje voor je deployt.

---

## 5. Netlify setup

### 5.1. Repo naar GitHub

```bash
cd QBtec
git add .
git commit -m "feat: initial QBTec urenregistratie portaal"
# Maak een lege repo aan op github.com/qbtec-org/urenregistratie
git remote add origin git@github.com:qbtec-org/urenregistratie.git
git branch -M main
git push -u origin main
```

### 5.2. Netlify site aanmaken

1. https://app.netlify.com → **Add new site › Import an existing project**
2. Kies GitHub, autoriseer toegang, selecteer de repo
3. Build settings worden automatisch overgenomen uit `netlify.toml`:
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
   - Geen build command nodig
4. **Deploy site** — wacht tot deploy slaagt

### 5.3. Environment variables

**Site settings › Environment variables › Add variable** — voeg toe:

| Key | Waarde |
|---|---|
| `SUPABASE_URL` | uit Supabase API settings — gebruikt door functions én frontend (via `/config`) |
| `SUPABASE_ANON_KEY` | publishable key (`sb_publishable_...`) — gebruikt door frontend via `/config` |
| `SUPABASE_SERVICE_KEY` | secret/service_role key — alleen server-side functions, nooit naar frontend |
| `BREVO_API_KEY` | uit Brevo API Keys |
| `APP_URL` | tijdelijk de Netlify URL (`https://urenregistratie.netlify.app`), na DNS de custom URL |

De frontend haalt `SUPABASE_URL` + `SUPABASE_ANON_KEY` runtime op via `GET /.netlify/functions/config`. Daardoor staan er geen hardcoded credentials in de source code en triggert de Netlify secret scanner niet.

### 5.4. Custom domain (productie)

1. **Site settings › Domain management › Add custom domain** → `uren.qbtec.nl`
2. Stel in DNS van `qbtec.nl` een CNAME `uren` → de Netlify site URL
3. Wacht op verificatie + automatische SSL
4. Update `APP_URL` env-var op Netlify naar `https://uren.qbtec.nl`
5. Voeg `https://uren.qbtec.nl/auth-callback.html` toe in Supabase Redirect URLs (3.3)
6. Trigger nieuwe deploy zodat env-var van kracht wordt

---

### 5.5. Eerste deploy

Trigger handmatig een nieuwe deploy via **Deploys › Trigger deploy › Deploy site** zodat de env-vars actief worden in de functions.

---

## 6. Eerste smoke test

Doorloop dit met twee browservensters / -profielen open: één als HR, één als leidinggevende.

1. **HR login**
   - Open `https://uren.qbtec.nl` (of de Netlify URL tijdens dev)
   - Voer het HR e-mailadres in → klik **Stuur inloglink**
   - Check de inbox → klik de link → je belandt op `/hr.html`
2. **Excel uploaden**
   - Sleep een Immotix `.xlsx` op de upload-zone
   - Spinner verschijnt "Excel verwerken…", daarna toast met aantal afdelingen + medewerkers
   - Onder tab **Overzicht** zie je elke afdeling met status "In behandeling"
3. **Voorman login** (ander venster)
   - Open de loginpagina, vraag een link aan voor een leidinggevende
   - Klik in de mail → je belandt op `/voorman.html`
   - Boven aan staat een blauwe deadline-balk: "Deadline: vrijdag DD-MM 17:00"
   - Je ziet alleen je eigen afdeling (RLS)
4. **Correctie maken**
   - Pas een gepresteerd-veld aan → het veld wordt rood, totaalrij update meteen
   - HR-venster: tab **Overzicht** toont realtime de status "Gecorrigeerd"
5. **Goedkeuren + doorsturen**
   - Voorman: klik per medewerker **Akkoord ✓** of de afdelings-knop
   - Klik **✉ Doorsturen naar HR** → confirm → toast verschijnt
   - HR-venster: status springt naar "Akkoord", deadline-balk verdwijnt
6. **Weekmail handmatig versturen**
   - HR: klik **✉ Verstuur weekmail**
   - Confirm → check de inbox van leidinggevenden waarvan de afdeling **nog niet** is goedgekeurd. Goedgekeurde afdelingen krijgen geen mail
7. **NMBRS-export**
   - HR: klik **📥 Exporteer naar NMBRS** → er download een `NMBRS_export_weekNN_YYYY.xlsx`
   - Open in Excel: 14 kolommen, één rij per medewerker
8. **Periode sluiten**
   - Wanneer alle afdelingen "Akkoord" hebben verschijnt **🔒 Sluit periode**
   - Klik → confirm "Weet u zeker dat u week NN wilt sluiten?" → toast
   - Voorman-venster: alle invoervelden zijn nu read-only (`status='gesloten'`)
   - HR-dashboard: upload-zone is weer zichtbaar voor de volgende week

---

## 7. Toekomstige verbeteringen

### Technische schuld

**Postgres trigger op `uren_regels` voor kolombescherming**
Op dit moment kan een leidinggevende — als hij rechtstreeks de Supabase-API aanroept — ook de originele Immotix-velden (`tijd_in`, `tijd_uit`, `gepland`, `gepresteerd`, `ow100`, `ow125`, `ziek`, `verlof`) overschrijven. De UI doet dit niet, maar RLS werkt op rijniveau, niet op kolomniveau. Voeg in een latere release een Postgres trigger toe die schrijfacties op deze kolommen blokkeert voor de voorman-rol na de initiële import. Voorbeeld:

```sql
CREATE OR REPLACE FUNCTION block_voorman_origineel()
RETURNS TRIGGER AS $$
BEGIN
  IF (auth.jwt()->>'rol') = 'voorman' THEN
    IF NEW.tijd_in     IS DISTINCT FROM OLD.tijd_in     OR
       NEW.tijd_uit    IS DISTINCT FROM OLD.tijd_uit    OR
       NEW.gepland     IS DISTINCT FROM OLD.gepland     OR
       NEW.gepresteerd IS DISTINCT FROM OLD.gepresteerd OR
       NEW.ow100       IS DISTINCT FROM OLD.ow100       OR
       NEW.ow125       IS DISTINCT FROM OLD.ow125       OR
       NEW.ziek        IS DISTINCT FROM OLD.ziek        OR
       NEW.verlof      IS DISTINCT FROM OLD.verlof THEN
      RAISE EXCEPTION 'Voorman mag originele Immotix-velden niet wijzigen';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_voorman_origineel
  BEFORE UPDATE ON uren_regels
  FOR EACH ROW EXECUTE FUNCTION block_voorman_origineel();
```

### Functionele uitbreidingen

- **History-view voor HR** — momenteel toont het HR-dashboard alleen de meest recente open periode. Voeg een dropdown of aparte history-tab toe om gesloten perioden terug te bekijken
- **HR-override audit log** — wanneer HR via tab 2 corrigeert op een afdeling die nog niet is goedgekeurd, weet de leidinggevende dat niet. Een audit-log of notificatie maakt dit transparant
- **NMBRS-importformaat afstemmen** — vraag de NMBRS-beheerder van QBTec naar het exacte importformaat (kolomnamen, taal, CSV vs Excel) en pas `exportNMBRS()` in `hr.js` aan
- **Email queueing** — bij grote afdelingsaantallen kan het verzenden via Brevo seriëel traag worden. Overweeg parallelle verzending of een queue voor failures

---

## Probleemoplossing

| Symptoom | Oorzaak / oplossing |
|---|---|
| Magic link werkt niet, redirect mislukt | Check Redirect URLs in Supabase Auth (3.3) |
| HR krijgt 409 bij upload | Er is al een open periode — sluit die eerst af |
| Brevo-mails komen niet aan | Check domeinverificatie + SPF/DKIM in Brevo dashboard |
| Voorman ziet niets na inloggen | Check dat `leidinggevenden.user_id` correct gekoppeld is aan de auth-user en `afdeling_id` is gezet |
| `parse-excel` 422 "Kan periode niet bepalen" | Excel komt niet uit Immotix of header is gewijzigd. Open het bestand en controleer of cel A1 begint met "Selectie:" |
