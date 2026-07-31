-- P0 安全修复：Worker accessToken 改为存储 SHA-256 hash
-- 历史明文 token 已无对应 hash 无法回填，强制所有 Worker 重新注册
-- 旧字段 accessToken 保留以便回滚，新增 accessTokenHash 唯一索引

-- SQLite: ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，重复执行需捕获错误
ALTER TABLE "Worker" ADD COLUMN "accessTokenHash" TEXT;

-- 创建唯一索引（如果存在历史重复 hash 会失败，可手动清理后再建）
CREATE UNIQUE INDEX IF NOT EXISTS "Worker_accessTokenHash_key" ON "Worker"("accessTokenHash");

-- 失效所有历史明文 token，强制 Worker 重新注册（hash 字段为 NULL 时无法鉴权）
UPDATE "Worker" SET "accessToken" = NULL, "tokenExpiresAt" = NULL;
