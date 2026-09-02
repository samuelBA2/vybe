-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'GIFT';

-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "giftDownloadedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TicketCategory" ADD COLUMN     "giftedCount" INTEGER NOT NULL DEFAULT 0;
