-- CreateTable
CREATE TABLE "CheckoutRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutRequest_userId_key_key" ON "CheckoutRequest"("userId", "key");

-- CreateIndex
CREATE INDEX "CheckoutRequest_createdAt_idx" ON "CheckoutRequest"("createdAt");
