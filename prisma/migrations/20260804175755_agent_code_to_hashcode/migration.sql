-- DropIndex
DROP INDEX "Agent_code_key";

-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "code",
ADD COLUMN     "hashCode" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Agent_hashCode_key" ON "Agent"("hashCode");

