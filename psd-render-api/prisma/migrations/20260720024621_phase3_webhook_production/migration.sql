-- 第三期 M6：Webhook 投递生产级升级
-- 旧表为新表让位：删除历史投递记录（POC 阶段允许）
-- 新增字段：eventId（唯一）、apiKeyId、payload、maxAttempts、nextAttemptAt、lastError、updatedAt

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
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- 保留历史记录：为旧数据填充默认值（eventId 用 id 兜底，payload 用空 JSON，updatedAt 用 createdAt）
INSERT INTO "new_WebhookLog" (
  "id", "eventId", "jobId", "event", "targetUrl", "apiKeyId", "payload",
  "status", "attempt", "maxAttempts", "nextAttemptAt",
  "responseCode", "responseBody", "lastError", "deliveredAt",
  "createdAt", "updatedAt"
)
SELECT
  "id",
  "id" || '.legacy',
  "jobId",
  "event",
  "targetUrl",
  NULL,
  '{}',
  COALESCE("status", 'PENDING'),
  COALESCE("attempt", 0),
  6,
  NULL,
  "responseCode",
  "responseBody",
  NULL,
  "deliveredAt",
  "createdAt",
  "createdAt"
FROM "WebhookLog";
DROP TABLE "WebhookLog";
ALTER TABLE "new_WebhookLog" RENAME TO "WebhookLog";
CREATE UNIQUE INDEX "WebhookLog_eventId_key" ON "WebhookLog"("eventId");
CREATE INDEX "WebhookLog_jobId_idx" ON "WebhookLog"("jobId");
CREATE INDEX "WebhookLog_status_nextAttemptAt_idx" ON "WebhookLog"("status", "nextAttemptAt");
CREATE INDEX "WebhookLog_createdAt_idx" ON "WebhookLog"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
