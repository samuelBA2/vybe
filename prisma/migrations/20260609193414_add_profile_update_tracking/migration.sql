-- AlterTable
ALTER TABLE "User" ADD COLUMN     "profileUpdateCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "profileUpdateMonth" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "profileUpdateYear" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "profileUpdatedAt" TIMESTAMP(3);
