-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'PAYOUT_ORGANIZER';

-- CreateEnum
CREATE TYPE "PayoutClaimStatus" AS ENUM ('SENT', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PayoutClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "mmoNumber" TEXT NOT NULL,
    "status" "PayoutClaimStatus" NOT NULL DEFAULT 'SENT',
    "jti" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "PayoutClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayoutClaim_jti_key" ON "PayoutClaim"("jti");
CREATE INDEX "PayoutClaim_userId_currency_status_idx" ON "PayoutClaim"("userId", "currency", "status");
CREATE INDEX "PayoutClaim_userId_createdAt_idx" ON "PayoutClaim"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PayoutClaim" ADD CONSTRAINT "PayoutClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
