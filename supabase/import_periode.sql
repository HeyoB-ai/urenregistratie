-- RPC voor atomaire Excel-import.
-- Voer eenmalig uit in Supabase SQL Editor na het schema (SPEC sectie 4) en RLS (sectie 5).

DROP FUNCTION IF EXISTS public.import_periode(TEXT, INT, INT, UUID, TEXT[], JSONB, JSONB);

CREATE OR REPLACE FUNCTION public.import_periode(
  p_label       TEXT,
  p_week        INT,
  p_jaar        INT,
  p_user_id     UUID,
  p_afdelingen  TEXT[],     -- unieke afdelingsnamen uit Excel
  p_medewerkers JSONB,      -- [{mdwnr, naam, afdeling}]
  p_regels      JSONB       -- [{mdwnr, afdeling, datum (ISO), tijd_in, tijd_uit, gepland, gepresteerd, ow100, ow125, ziek, verlof}]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_periode_id UUID;
  v_afd_map JSONB := '{}'::jsonb;
  v_mdw_map JSONB := '{}'::jsonb;
  v_afd_id UUID;
  v_mdw_id UUID;
  r_afd TEXT;
  r_mdw JSONB;
  r_reg JSONB;
BEGIN
  -- Geen tweede import zolang er een open periode bestaat
  IF EXISTS (SELECT 1 FROM perioden WHERE status = 'open') THEN
    RAISE EXCEPTION 'Er is al een open periode. Sluit deze eerst af voor u een nieuwe upload doet.'
      USING ERRCODE = 'P0001';
  END IF;

  -- Periode aanmaken
  INSERT INTO perioden (label, week_nummer, jaar, uploaded_by, status)
  VALUES (p_label, p_week, p_jaar, p_user_id, 'open')
  RETURNING id INTO v_periode_id;

  -- Afdelingen: hergebruik bestaande of insert; bouw naam -> id map
  IF p_afdelingen IS NOT NULL THEN
    FOREACH r_afd IN ARRAY p_afdelingen LOOP
      SELECT id INTO v_afd_id FROM afdelingen WHERE naam = r_afd;
      IF v_afd_id IS NULL THEN
        INSERT INTO afdelingen (naam) VALUES (r_afd) RETURNING id INTO v_afd_id;
      END IF;
      v_afd_map := v_afd_map || jsonb_build_object(r_afd, v_afd_id::text);
    END LOOP;
  END IF;

  -- Medewerkers: hergebruik bestaande (afdeling_id NIET bijwerken) of insert
  FOR r_mdw IN SELECT * FROM jsonb_array_elements(p_medewerkers) LOOP
    SELECT id INTO v_mdw_id FROM medewerkers WHERE mdwnr = r_mdw->>'mdwnr';
    IF v_mdw_id IS NULL THEN
      INSERT INTO medewerkers (mdwnr, naam, afdeling_id)
      VALUES (
        r_mdw->>'mdwnr',
        NULLIF(r_mdw->>'naam', ''),
        (v_afd_map->>(r_mdw->>'afdeling'))::uuid
      )
      RETURNING id INTO v_mdw_id;
    END IF;
    v_mdw_map := v_mdw_map || jsonb_build_object(r_mdw->>'mdwnr', v_mdw_id::text);
  END LOOP;

  -- Uren regels (alleen originele Immotix-velden; corr_* blijven NULL)
  FOR r_reg IN SELECT * FROM jsonb_array_elements(p_regels) LOOP
    INSERT INTO uren_regels (
      periode_id, medewerker_id, afdeling_id, datum,
      tijd_in, tijd_uit, gepland, gepresteerd,
      ow100, ow125, ziek, verlof
    ) VALUES (
      v_periode_id,
      (v_mdw_map->>(r_reg->>'mdwnr'))::uuid,
      (v_afd_map->>(r_reg->>'afdeling'))::uuid,
      (r_reg->>'datum')::date,
      NULLIF(r_reg->>'tijd_in', '')::numeric,
      NULLIF(r_reg->>'tijd_uit', '')::numeric,
      NULLIF(r_reg->>'gepland', '')::numeric,
      NULLIF(r_reg->>'gepresteerd', '')::numeric,
      COALESCE(NULLIF(r_reg->>'ow100', '')::numeric, 0),
      COALESCE(NULLIF(r_reg->>'ow125', '')::numeric, 0),
      COALESCE(NULLIF(r_reg->>'ziek', '')::numeric, 0),
      COALESCE(NULLIF(r_reg->>'verlof', '')::numeric, 0)
    );
  END LOOP;

  -- Lege goedkeuring per afdeling voor deze periode
  INSERT INTO goedkeuringen (periode_id, afdeling_id, goedgekeurd)
  SELECT v_periode_id, value::uuid, false
  FROM jsonb_each_text(v_afd_map);

  RETURN jsonb_build_object(
    'periode_id',       v_periode_id,
    'afdelingen_count', COALESCE(array_length(p_afdelingen, 1), 0),
    'medewerkers_count', jsonb_array_length(p_medewerkers),
    'regels_count',      jsonb_array_length(p_regels)
  );
END;
$$;

-- Service role bypass RLS sowieso, maar grant is goede praktijk:
GRANT EXECUTE ON FUNCTION public.import_periode(TEXT, INT, INT, UUID, TEXT[], JSONB, JSONB) TO authenticated, service_role;
