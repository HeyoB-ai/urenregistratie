-- Leidinggevenden: reserve-vlag + HR RLS policies.
-- Voer uit na 02_rls.sql.

-- 1. is_reserve kolom voor afdeling-reserves (worden ook ge-mailed bij herinnering)
ALTER TABLE leidinggevenden
  ADD COLUMN IF NOT EXISTS is_reserve BOOLEAN NOT NULL DEFAULT false;

-- 2. RLS policies — HR mag alle CRUD doen via PostgREST
DROP POLICY IF EXISTS "HR alles" ON leidinggevenden;
CREATE POLICY "HR alles" ON leidinggevenden FOR ALL USING (is_hr());

-- Voorman mag z'n eigen rij lezen (zodat mijn_afdeling_id() blijft werken)
DROP POLICY IF EXISTS "Eigen rij lezen" ON leidinggevenden;
CREATE POLICY "Eigen rij lezen" ON leidinggevenden FOR SELECT
  USING (user_id = auth.uid());
