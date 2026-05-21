/*
  Warnings:

  - A unique constraint covering the columns `[code]` on the table `Agent` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `code` to the `Agent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `eventId` to the `Agent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `firstname` to the `Agent` table without a default value. This is not possible if the table is not empty.
  - Added the required column `lastname` to the `Agent` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Agent_userId_key";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "createdBy" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "eventId" TEXT NOT NULL,
ADD COLUMN     "firstname" TEXT NOT NULL,
ADD COLUMN     "lastname" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Agent_code_key" ON "Agent"("code");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
