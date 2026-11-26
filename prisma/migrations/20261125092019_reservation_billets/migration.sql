-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('RESERVED', 'USED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationResolution" AS ENUM ('PENDING', 'COLLECTED', 'DELETED');

-- AlterTable
ALTER TABLE "TicketCategory" ADD COLUMN     "reservationCap" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "reservationEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reservedCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'RESERVED',
    "resolution" "ReservationResolution" NOT NULL DEFAULT 'PENDING',
    "holderFirstName" TEXT NOT NULL,
    "holderLastName" TEXT NOT NULL,
    "holderPhone" TEXT NOT NULL,
    "paidAtGate" BOOLEAN NOT NULL DEFAULT false,
    "resolvedByAgentId" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GateCashCollection" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" "Currency" NOT NULL,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GateCashCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_qrToken_key" ON "Reservation"("qrToken");

-- CreateIndex
CREATE INDEX "Reservation_eventId_idx" ON "Reservation"("eventId");

-- CreateIndex
CREATE INDEX "Reservation_userId_idx" ON "Reservation"("userId");

-- CreateIndex
CREATE INDEX "Reservation_eventId_status_idx" ON "Reservation"("eventId", "status");

-- CreateIndex
CREATE INDEX "Reservation_categoryId_idx" ON "Reservation"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "GateCashCollection_reservationId_key" ON "GateCashCollection"("reservationId");

-- CreateIndex
CREATE INDEX "GateCashCollection_eventId_idx" ON "GateCashCollection"("eventId");

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TicketCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GateCashCollection" ADD CONSTRAINT "GateCashCollection_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- "1 réservation active par compte et par événement" : garantie atomique anti-course.
-- Une 2e réservation RESERVED du même user sur le même event viole cet index (P2002).
-- Dès que la réservation quitte RESERVED (encaissée=USED ou supprimée=CANCELLED), la ligne
-- sort de l'index → le user peut réserver à nouveau.
CREATE UNIQUE INDEX "one_active_reservation_per_user"
  ON "Reservation" ("eventId", "userId")
  WHERE "status" = 'RESERVED';
