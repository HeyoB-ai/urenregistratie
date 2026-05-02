-- Test voorman aanmaken voor development.
--
-- VOORWAARDE: maak eerst de auth user aan via Supabase dashboard:
--   Authentication -> Users -> Invite user -> voorman.test@qbtec.nl
-- en stel daarna een wachtwoord in via Update password (bv. Test1234!).
--
-- Voer daarna onderstaande blokken in volgorde uit in de SQL Editor.

-- 1. Rol + naam in user_metadata
UPDATE auth.users
SET raw_user_meta_data = '{"rol":"voorman","naam":"Test Voorman"}'
WHERE email = 'voorman.test@qbtec.nl';

-- 2. E-mail bevestigen (mag de Invite-flow overslaan)
UPDATE auth.users
SET email_confirmed_at = now()
WHERE email = 'voorman.test@qbtec.nl';

-- 3. Koppelen aan afdeling 'Pre-assemblage'
INSERT INTO leidinggevenden (user_id, naam, email, afdeling_id)
SELECT
  u.id,
  'Test Voorman',
  'voorman.test@qbtec.nl',
  a.id
FROM auth.users u, afdelingen a
WHERE u.email = 'voorman.test@qbtec.nl'
  AND a.naam = 'Pre-assemblage';
