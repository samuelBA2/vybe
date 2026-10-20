-- Ajoute le code agent chiffré (AES-256-GCM) pour le réafficher à l'organisateur.
-- Nullable : les agents créés avant cette migration n'ont pas de code récupérable.
ALTER TABLE "Agent" ADD COLUMN "codeEnc" TEXT;
