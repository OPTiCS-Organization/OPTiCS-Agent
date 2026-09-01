-- CreateTable
CREATE TABLE "ServiceLogSessionMarker" (
    "idx" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "serviceIndex" INTEGER NOT NULL,
    "serviceName" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ServiceLogSessionMarker_serviceIndex_timestamp_idx" ON "ServiceLogSessionMarker"("serviceIndex", "timestamp");
