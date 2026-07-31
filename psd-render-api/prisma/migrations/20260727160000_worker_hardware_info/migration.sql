-- 第四期 M9：Worker 增加硬件画像字段
-- 用于 Admin UI 查看设备 CPU/显卡/内存/IP 等详情
ALTER TABLE "Worker" ADD COLUMN "hostname" TEXT;
ALTER TABLE "Worker" ADD COLUMN "cpuModel" TEXT;
ALTER TABLE "Worker" ADD COLUMN "cpuCores" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "cpuLogicalCores" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "cpuClockMhz" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "gpuModel" TEXT;
ALTER TABLE "Worker" ADD COLUMN "gpuVramMb" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "totalMemoryMb" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "availableMemoryMb" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "osVersion" TEXT;
ALTER TABLE "Worker" ADD COLUMN "registeredIp" TEXT;
ALTER TABLE "Worker" ADD COLUMN "diskTotalMb" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "diskFreeMb" INTEGER;
ALTER TABLE "Worker" ADD COLUMN "hardwareInfo" TEXT;
