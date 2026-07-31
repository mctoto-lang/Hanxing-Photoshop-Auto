-- AlterTable
ALTER TABLE "RenderJob" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "RenderJob" ADD COLUMN "cancelRequestedAt" DATETIME;
ALTER TABLE "RenderJob" ADD COLUMN "cancelledAt" DATETIME;
ALTER TABLE "RenderJob" ADD COLUMN "requiredCapabilities" TEXT;

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARN',
    "refType" TEXT,
    "refId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metrics" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "triggeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "ackedBy" TEXT,
    "ackedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Worker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "machineFingerprint" TEXT NOT NULL,
    "psVersion" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "fontInventoryHash" TEXT,
    "accessToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "sessionActive" BOOLEAN NOT NULL DEFAULT false,
    "currentJobId" TEXT,
    "lastHeartbeatAt" DATETIME,
    "offlineSince" DATETIME,
    "psMajorVersion" INTEGER NOT NULL DEFAULT 0,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Worker" ("accessToken", "capabilities", "code", "currentJobId", "fontInventoryHash", "id", "lastHeartbeatAt", "machineFingerprint", "psVersion", "registeredAt", "sessionActive", "tokenExpiresAt") SELECT "accessToken", "capabilities", "code", "currentJobId", "fontInventoryHash", "id", "lastHeartbeatAt", "machineFingerprint", "psVersion", "registeredAt", "sessionActive", "tokenExpiresAt" FROM "Worker";
DROP TABLE "Worker";
ALTER TABLE "new_Worker" RENAME TO "Worker";
CREATE UNIQUE INDEX "Worker_code_key" ON "Worker"("code");
CREATE UNIQUE INDEX "Worker_machineFingerprint_key" ON "Worker"("machineFingerprint");
CREATE INDEX "Worker_sessionActive_idx" ON "Worker"("sessionActive");
CREATE INDEX "Worker_lastHeartbeatAt_idx" ON "Worker"("lastHeartbeatAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "AlertEvent_type_status_idx" ON "AlertEvent"("type", "status");

-- CreateIndex
CREATE INDEX "AlertEvent_triggeredAt_idx" ON "AlertEvent"("triggeredAt");

-- CreateIndex
CREATE INDEX "RenderJob_cancelRequestedAt_idx" ON "RenderJob"("cancelRequestedAt");
