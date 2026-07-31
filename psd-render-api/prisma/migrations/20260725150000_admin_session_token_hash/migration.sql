-- P1-3：AdminSession 增加 tokenHash 字段
-- AlterTable
ALTER TABLE "AdminSession" ADD COLUMN "tokenHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- 数据迁移：为现有 session 生成 tokenHash（token 字段即明文，直接 hash）
UPDATE "AdminSession" SET "tokenHash" = md5("token") WHERE "tokenHash" IS NULL;
