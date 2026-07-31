ALTER TABLE "RenderJob" ADD COLUMN "targetWorkerId" TEXT;
CREATE INDEX "RenderJob_targetWorkerId_idx" ON "RenderJob"("targetWorkerId");
