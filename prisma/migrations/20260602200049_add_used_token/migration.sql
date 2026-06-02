-- CreateTable
CREATE TABLE "UsedToken" (
    "jti" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsedToken_pkey" PRIMARY KEY ("jti")
);
