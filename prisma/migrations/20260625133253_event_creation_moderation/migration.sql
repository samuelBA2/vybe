/*
  Warnings:

  - Added the required column `ticketDesignUrl` to the `TicketCategory` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "EventStatus" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "EventStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "reviewedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EventMedia" ADD COLUMN     "isPoster" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "TicketCategory" ADD COLUMN     "ticketDesignUrl" TEXT NOT NULL,
ALTER COLUMN "totalStock" DROP NOT NULL;
