-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "rateLimitPerMin" INTEGER,
    "quotaPerDay" INTEGER,
    "quotaUsedDay" INTEGER NOT NULL DEFAULT 0,
    "quotaResetAt" DATETIME,
    "scopes" TEXT NOT NULL DEFAULT '',
    "webhookUrlDefault" TEXT,
    "webhookSecret" TEXT,
    "ipWhitelist" TEXT,
    "disabledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);
INSERT INTO "new_ApiKey" ("active", "createdAt", "id", "keyHash", "keyPrefix", "lastUsedAt", "name", "priority", "rateLimitPerMin", "tenantId") SELECT "active", "createdAt", "id", "keyHash", "keyPrefix", "lastUsedAt", "name", "priority", "rateLimitPerMin", "tenantId" FROM "ApiKey";
DROP TABLE "ApiKey";
ALTER TABLE "new_ApiKey" RENAME TO "ApiKey";
CREATE UNIQUE INDEX "ApiKey_keyPrefix_key" ON "ApiKey"("keyPrefix");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_tenantId_active_idx" ON "ApiKey"("tenantId", "active");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
