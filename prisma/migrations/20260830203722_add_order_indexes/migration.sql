-- CreateIndex
CREATE INDEX "Order_ticketCategoryId_paymentStatus_idx" ON "Order"("ticketCategoryId", "paymentStatus");
