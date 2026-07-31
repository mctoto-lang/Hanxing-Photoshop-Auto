-- P0 安全修复（高危7）：Artifact 增加租户隔离字段
--
-- 背景：原 Artifact 表无 tenantId 字段，租户 A 可在提交任务时使用租户 B 的
--   assetId（仅凭 art_ 编码）访问他人上传的图片。
-- 修复：新增 tenantId 字段，默认 "default"（兼容历史数据）+ 索引。
--
-- SQLite ALTER TABLE ADD COLUMN 支持，且 Prisma 默认值会被应用：

ALTER TABLE "Artifact" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';

-- 创建 tenantId 索引（提升跨租户过滤查询性能）
CREATE INDEX "Artifact_tenantId_idx" ON "Artifact"("tenantId");
