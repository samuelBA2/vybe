-- Retire le retrait organisateur (table Payout, lien ledger, valeurs d'enum).
DELETE FROM "LedgerEntry" WHERE "type" IN ('PAYOUT_ORGANIZER', 'PAYOUT_REVERSAL');

ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "LedgerEntry_payoutId_fkey";
DROP INDEX IF EXISTS "LedgerEntry_payoutId_idx";
ALTER TABLE "LedgerEntry" DROP COLUMN IF EXISTS "payoutId";

DROP TABLE IF EXISTS "Payout";
DROP TYPE IF EXISTS "PayoutStatus";

CREATE TYPE "LedgerEntryType_new" AS ENUM ('SALE_ORGANIZER', 'SALE_PLATFORM', 'REFUND_ORGANIZER');
ALTER TABLE "LedgerEntry"
  ALTER COLUMN "type" TYPE "LedgerEntryType_new"
  USING ("type"::text::"LedgerEntryType_new");
DROP TYPE "LedgerEntryType";
ALTER TYPE "LedgerEntryType_new" RENAME TO "LedgerEntryType";
