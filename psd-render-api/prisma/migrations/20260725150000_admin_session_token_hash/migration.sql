-- P1-3：AdminSession 增加 tokenHash 字段
-- AlterTable
ALTER TABLE "AdminSession" ADD COLUMN "tokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- 数据迁移：为现有 session 生成 tokenHash
-- 注:SQLite 默认无 md5() 函数;且应用代码实际使用 SHA-256(见 admin-auth-service.ts)
--     新部署时 AdminSession 表为空,无需数据迁移;已有部署应在应用层补算 hash
-- UPDATE "AdminSession" SET "tokenHash" = md5("token") WHERE "tokenHash" IS NULL;
