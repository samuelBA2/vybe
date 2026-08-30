-- CreateIndex
CREATE INDEX "Event_status_startDate_idx" ON "Event"("status", "startDate");

-- CreateIndex
CREATE INDEX "Event_createdById_createdAt_idx" ON "Event"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_ticketCategoryId_qrStatus_scannedAt_idx" ON "Ticket"("ticketCategoryId", "qrStatus", "scannedAt");
