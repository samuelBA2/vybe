/*
  Warnings:

  - The values [ORGANIZER,SPECTATOR] on the enum `Role` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `createdBy` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `organizerId` on the `Agent` table. All the data in the column will be lost.
  - You are about to drop the column `organizerId` on the `Event` table. All the data in the column will be lost.
  - You are about to drop the column `spectatorId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `password` on the `User` table. All the data in the column will be lost.
  - You are about to drop the `Organizer` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OtpVerication` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Spectator` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `createdById` to the `Event` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Role_new" AS ENUM ('ADMIN', 'AGENT');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role_new" USING ("role"::text::"Role_new");
ALTER TYPE "Role" RENAME TO "Role_old";
ALTER TYPE "Role_new" RENAME TO "Role";
DROP TYPE "Role_old";
COMMIT;

-- DropForeignKey
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_organizerId_fkey";

-- DropForeignKey
ALTER TABLE "Agent" DROP CONSTRAINT "Agent_userId_fkey";

-- DropForeignKey
ALTER TABLE "Event" DROP CONSTRAINT "Event_organizerId_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_spectatorId_fkey";

-- DropForeignKey
ALTER TABLE "Organizer" DROP CONSTRAINT "Organizer_userId_fkey";

-- DropForeignKey
ALTER TABLE "OtpVerication" DROP CONSTRAINT "OtpVerication_userId_fkey";

-- DropForeignKey
ALTER TABLE "Spectator" DROP CONSTRAINT "Spectator_userId_fkey";

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "createdBy",
DROP COLUMN "organizerId",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "usedAt" TIMESTAMP(3),
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Event" DROP COLUMN "organizerId",
ADD COLUMN     "createdById" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "spectatorId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "password",
ADD COLUMN     "hashedPassword" TEXT,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "firstname" DROP NOT NULL,
ALTER COLUMN "lastname" DROP NOT NULL,
ALTER COLUMN "phone" DROP NOT NULL;

-- DropTable
DROP TABLE "Organizer";

-- DropTable
DROP TABLE "OtpVerication";

-- DropTable
DROP TABLE "Spectator";

-- CreateTable
CREATE TABLE "EventParticipant" (
    "id" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventId" TEXT NOT NULL,
    "UserId" TEXT NOT NULL,

    CONSTRAINT "EventParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OtpVerification" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,

    CONSTRAINT "OtpVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventParticipant_eventId_UserId_key" ON "EventParticipant"("eventId", "UserId");

-- CreateIndex
CREATE UNIQUE INDEX "OtpVerification_phone_key" ON "OtpVerification"("phone");

-- AddForeignKey
ALTER TABLE "EventParticipant" ADD CONSTRAINT "EventParticipant_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventParticipant" ADD CONSTRAINT "EventParticipant_UserId_fkey" FOREIGN KEY ("UserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OtpVerification" ADD CONSTRAINT "OtpVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
