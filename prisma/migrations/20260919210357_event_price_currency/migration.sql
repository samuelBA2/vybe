/*
  Warnings:

  - You are about to drop the column `amountCDF` on the `Payout` table. All the data in the column will be lost.
  - You are about to drop the column `amountUSD` on the `Payout` table. All the data in the column will be lost.
  - You are about to drop the column `rate` on the `Payout` table. All the data in the column will be lost.
  - Added the required column `amount` to the `Payout` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "priceCurrency" "Currency" NOT NULL DEFAULT 'USD';

-- AlterTable
ALTER TABLE "Payout" DROP COLUMN "amountCDF",
DROP COLUMN "amountUSD",
DROP COLUMN "rate",
ADD COLUMN     "amount" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "currency" "Currency" NOT NULL DEFAULT 'USD';
