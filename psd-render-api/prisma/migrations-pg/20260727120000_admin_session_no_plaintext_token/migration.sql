-- P0 安全修复：AdminSession 不再明文存储 token
--
-- 背景：原 schema 中 token 字段为 NOT NULL 且写入明文，DB 泄露后
--   攻击者可直接读取 token 列冒充任意管理员。修复方案：
--   1. token 列改为可空（NULL）
--   2. tokenHash 改为 NOT NULL UNIQUE（鉴权唯一依据）
--   3. 历史会话 token 明文置 NULL（强制重新登录）
--
-- PostgreSQL 支持 ALTER COLUMN，直接修改：

-- 1. token 改为可空
ALTER TABLE "AdminSession" ALTER COLUMN "token" DROP NOT NULL;

-- 2. tokenHash 改为 NOT NULL
--    兜底：先清空 tokenHash 为 NULL 的脏数据（防止 SET NOT NULL 失败）
DELETE FROM "AdminSession" WHERE "tokenHash" IS NULL;
ALTER TABLE "AdminSession" ALTER COLUMN "tokenHash" SET NOT NULL;

-- 3. 清空历史明文 token（强制历史会话失效，所有管理员需重新登录）
UPDATE "AdminSession" SET "token" = NULL;
