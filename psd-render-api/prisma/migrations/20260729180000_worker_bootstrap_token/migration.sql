-- WorkerBootstrapToken：一次性注册令牌（配对码模式）
--   管理员在 Admin UI 生成配对码，Worker UI 输入 6 位配对码完成首次注册
CREATE TABLE "WorkerBootstrapToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pairingCode" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "usedByWorkerId" TEXT,
    "revokedAt" DATETIME,
    "note" TEXT
);

-- 唯一索引：配对码、token hash
CREATE UNIQUE INDEX "WorkerBootstrapToken_pairingCode_key" ON "WorkerBootstrapToken"("pairingCode");
CREATE UNIQUE INDEX "WorkerBootstrapToken_tokenHash_key" ON "WorkerBootstrapToken"("tokenHash");

-- 普通索引：过期时间清理、已使用记录查询
CREATE INDEX "WorkerBootstrapToken_expiresAt_idx" ON "WorkerBootstrapToken"("expiresAt");
CREATE INDEX "WorkerBootstrapToken_usedAt_idx" ON "WorkerBootstrapToken"("usedAt");
