-- QBTec Urenregistratie — schema (SPEC sectie 4)
-- Voer als eerste uit in Supabase SQL Editor.

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
