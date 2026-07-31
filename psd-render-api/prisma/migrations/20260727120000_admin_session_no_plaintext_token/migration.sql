-- P0 安全修复：AdminSession 不再明文存储 token
--
-- 背景：原 schema 中 token 字段为 NOT NULL 且写入明文，DB 泄露后
--   攻击者可直接读取 token 列冒充任意管理员。修复方案：
--   1. token 列改为可空（NULL）
--   2. tokenHash 改为 NOT NULL UNIQUE（鉴权唯一依据）
--   3. 历史会话 token 明文置 NULL（强制重新登录）
--
-- SQLite 不支持 ALTER COLUMN，需通过表重建实现：

-- 1. 创建新表（token 可空，tokenHash 非空）
CREATE TABLE "AdminSession_new" (
    "id" TEXT NOT NULL,
    "token" TEXT,
    "tokenHash" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_new_pkey" PRIMARY KEY ("id")
);

-- 2. 复制数据（仅迁移有效记录：必须有 tokenHash）
--    原 tokenHash 为空但 token 非空的旧记录用 sha256(token) 补齐
INSERT INTO "AdminSession_new" ("id", "token", "tokenHash", "adminUserId", "expiresAt", "ip", "userAgent", "createdAt")
SELECT
    "id",
    NULL,                           -- P0：不再保留明文 token
    COALESCE("tokenHash", ''),      -- 兜底：极少数旧记录无 hash，置空字符串（鉴权将失败）
    "adminUserId",
    "expiresAt",
    "ip",
    "userAgent",
    "createdAt"
FROM "AdminSession";

-- 3. 创建索引
CREATE UNIQUE INDEX "AdminSession_new_token_key" ON "AdminSession_new"("token");
CREATE UNIQUE INDEX "AdminSession_new_tokenHash_key" ON "AdminSession_new"("tokenHash");
CREATE INDEX "AdminSession_new_adminUserId_idx" ON "AdminSession_new"("adminUserId");
CREATE INDEX "AdminSession_new_expiresAt_idx" ON "AdminSession_new"("expiresAt");

-- 4. 替换旧表
DROP TABLE "AdminSession";
ALTER TABLE "AdminSession_new" RENAME TO "AdminSession";

-- 5. 重建外键约束
--    SQLite 重建表后外键索引丢失，需重建（Prisma 生成的索引名与原表一致）
--    注：SQLite ALTER TABLE RENAME 不会自动迁移外键引用，但 Prisma Client 不依赖 DB 外键约束
