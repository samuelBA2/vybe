/*
  Ajout de la colonne `reference` (numéro public lisible, ex. "VYBE-67XC6F")
  sur `Event`, en NOT NULL + UNIQUE.

  La table contient déjà des lignes : on ne peut pas ajouter directement une
  colonne NOT NULL sans défaut. On procède donc en 4 temps :
    1. ajout de la colonne en nullable ;
    2. backfill des lignes existantes avec une référence unique dérivée de
       l'id (md5 de l'uuid → 6 caractères) ;
    3. passage en NOT NULL ;
    4. création de l'index unique.
*/

-- 1. Colonne nullable
ALTER TABLE "Event" ADD COLUMN "reference" TEXT;

-- 2. Backfill des lignes existantes (référence unique par ligne, dérivée de l'id)
UPDATE "Event"
SET "reference" = 'VYBE-' || upper(substr(md5("id"::text), 1, 6))
WHERE "reference" IS NULL;

-- 3. Passage en NOT NULL
ALTER TABLE "Event" ALTER COLUMN "reference" SET NOT NULL;

-- 4. Index unique
CREATE UNIQUE INDEX "Event_reference_key" ON "Event"("reference");
