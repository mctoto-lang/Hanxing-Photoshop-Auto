-- P0 安全修复（严重 S2）：Template 增加租户隔离字段
--
-- 背景：原 Template 表无 tenantId 字段，任意租户的 API Key 均可
--   修改/发布/查看任意模板，造成跨租户数据泄露与配置篡改。
-- 修复：新增 tenantId 字段，默认 "default"（兼容历史数据）+ 索引。
--   外部 API 路由调用 service 时强制传入 req.user.tenantId，
--   service 内查询/更新按 tenantId 过滤；Admin 路由跨租户管理不变。

ALTER TABLE "Template" ADD COLUMN "tenantId" TEXT NOT NULL DEFAULT 'default';

-- 创建 tenantId 索引（提升跨租户过滤查询性能）
CREATE INDEX "Template_tenantId_idx" ON "Template"("tenantId");
