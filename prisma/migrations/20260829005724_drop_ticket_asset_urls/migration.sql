/*
  Warnings:

  - You are about to drop the column `pdfUrl` on the `Ticket` table. All the data in the column will be lost.
  - You are about to drop the column `ticketImageUrl` on the `Ticket` table. All the data in the column will be lost.

  Contexte : refonte « assets billet à la volée ». Le PNG/PDF n'est plus stocké
  par billet (rendu client-side + download serveur à la demande) : ces deux
  colonnes d'URL Cloudinary deviennent inutiles. Les assets Cloudinary
  correspondants sont purgés séparément (script one-shot du dossier TICKETS).
*/
-- AlterTable
ALTER TABLE "Ticket" DROP COLUMN "pdfUrl",
DROP COLUMN "ticketImageUrl";
