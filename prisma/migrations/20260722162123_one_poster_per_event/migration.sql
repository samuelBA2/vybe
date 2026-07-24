-- Au plus une affiche (isPoster = true) par événement.
-- Index partiel unique : autorise 0 ou 1 affiche, bloque 2+.
-- (Prisma ne sait pas exprimer un index partiel dans schema.prisma,
--  d'où cette migration SQL manuelle.)
CREATE UNIQUE INDEX "one_poster_per_event"
ON "EventMedia" ("eventId")
WHERE "isPoster" = true;
