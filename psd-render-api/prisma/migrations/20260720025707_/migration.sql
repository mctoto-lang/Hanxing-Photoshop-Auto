-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WebhookLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "nextAttemptAt" DATETIME,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "lastError" TEXT,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_WebhookLog" ("apiKeyId", "attempt", "createdAt", "deliveredAt", "event", "eventId", "id", "jobId", "lastError", "maxAttempts", "nextAttemptAt", "payload", "responseBody", "responseCode", "status", "targetUrl", "updatedAt") SELECT "apiKeyId", "attempt", "createdAt", "deliveredAt", "event", "eventId", "id", "jobId", "lastError", "maxAttempts", "nextAttemptAt", "payload", "responseBody", "responseCode", "status", "targetUrl", "updatedAt" FROM "WebhookLog";
DROP TABLE "WebhookLog";
ALTER TABLE "new_WebhookLog" RENAME TO "WebhookLog";
CREATE UNIQUE INDEX "WebhookLog_eventId_key" ON "WebhookLog"("eventId");
CREATE INDEX "WebhookLog_jobId_idx" ON "WebhookLog"("jobId");
CREATE INDEX "WebhookLog_status_nextAttemptAt_idx" ON "WebhookLog"("status", "nextAttemptAt");
CREATE INDEX "WebhookLog_createdAt_idx" ON "WebhookLog"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
