/*
  Warnings:

  - You are about to drop the column `twoFAsecret` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[email]` on the table `OtpVerification` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "OtpVerification" ADD COLUMN     "email" TEXT,
ALTER COLUMN "phone" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "twoFAsecret";

-- CreateIndex
CREATE UNIQUE INDEX "OtpVerification_email_key" ON "OtpVerification"("email");
