-- QBTec Urenregistratie — Row Level Security policies (SPEC sectie 5)
-- Voer als tweede uit, na 01_schema.sql.

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
CREATE POLICY "HR alles"               ON medewerkers FOR ALL    USING (is_hr());
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
