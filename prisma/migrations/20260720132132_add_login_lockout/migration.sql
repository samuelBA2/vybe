-- AlterTable
ALTER TABLE "User" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginLockLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loginLockedUntil" TIMESTAMP(3);
