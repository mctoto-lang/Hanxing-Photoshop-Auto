-- P0 安全修复（高危7）：Artifact 增加租户隔离字段
--
-- 背景：原 Artifact 表无 tenantId 字段，租户 A 可在提交任务时使用租户 B 的
--   assetId（仅凭 art_ 编码）访问他人上传的图片。
-- 修复：新增 tenantId 字段，默认 "default"（兼容历史数据）+ 索引。

ALTER TABLE "Artifact" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';

CREATE INDEX "Artifact_tenantId_idx" ON "Artifact"("tenantId");
