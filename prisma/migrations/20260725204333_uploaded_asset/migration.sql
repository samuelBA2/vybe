-- CreateTable
CREATE TABLE "UploadedAsset" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "ownerId" TEXT NOT NULL,
    "attached" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadedAsset_publicId_key" ON "UploadedAsset"("publicId");

-- CreateIndex
CREATE INDEX "UploadedAsset_attached_createdAt_idx" ON "UploadedAsset"("attached", "createdAt");

-- CreateIndex
CREATE INDEX "UploadedAsset_ownerId_idx" ON "UploadedAsset"("ownerId");
