-- Vider la table
TRUNCATE TABLE "OtpVerification";

-- Supprimer les index uniques
DROP INDEX "OtpVerification_email_key";
DROP INDEX "OtpVerification_phone_key";

-- Modifier la table
ALTER TABLE "OtpVerification" DROP COLUMN "email",
DROP COLUMN "otp",
DROP COLUMN "phone",
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "used" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "code" TEXT NOT NULL DEFAULT '',
ADD COLUMN "identifier" TEXT NOT NULL DEFAULT '';

-- Retirer les valeurs par défaut temporaires
ALTER TABLE "OtpVerification" ALTER COLUMN "code" DROP DEFAULT;
ALTER TABLE "OtpVerification" ALTER COLUMN "identifier" DROP DEFAULT;