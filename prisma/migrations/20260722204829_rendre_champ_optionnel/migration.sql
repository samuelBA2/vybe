/*
  Warnings:

  - You are about to drop the column `fileKey` on the `EventMedia` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `EventMedia` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "EventMedia" DROP COLUMN "fileKey",
ADD COLUMN     "publicId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "url" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "EventMedia_eventId_idx" ON "EventMedia"("eventId");

-- CreateIndex
CREATE INDEX "EventMedia_eventId_isPoster_idx" ON "EventMedia"("eventId", "isPoster");
