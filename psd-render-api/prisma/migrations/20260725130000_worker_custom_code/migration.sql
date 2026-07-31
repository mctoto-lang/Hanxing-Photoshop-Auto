-- Worker 节点新增 customCode 字段（管理员自定义编号，唯一可空）
ALTER TABLE "Worker" ADD COLUMN "customCode" TEXT;
CREATE UNIQUE INDEX "Worker_customCode_key" ON "Worker"("customCode");
