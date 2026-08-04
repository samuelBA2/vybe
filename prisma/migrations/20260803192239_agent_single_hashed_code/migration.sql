/*
  Warnings:

  - You are about to drop the column `hashedPin` on the `Agent` table. All the data in the column will be lost.

*/


-- AlterTable
-- NB: `hashedPin` avait été ajouté à la base hors migration (db push) ; on utilise
-- IF EXISTS pour que l'historique reste rejouable sur une base neuve (shadow DB).
ALTER TABLE "Agent" DROP COLUMN IF EXISTS "hashedPin";
