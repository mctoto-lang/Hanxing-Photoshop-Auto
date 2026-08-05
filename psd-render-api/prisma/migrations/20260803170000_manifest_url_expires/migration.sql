-- AlterTable: StorageConfig 新增 manifestUrlExpiresSec 字段
-- 用途：manifest（任务下载/上传预签名 URL）有效期（秒），默认 600。
--   原 job-service 用 LEASE_TTL_SECONDS*3（=270s），带蒙版智能对象 JSX 耗时 271s+ 会踩线过期。
ALTER TABLE "StorageConfig" ADD COLUMN "manifestUrlExpiresSec" INTEGER;
