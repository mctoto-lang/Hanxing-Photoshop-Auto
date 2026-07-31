-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "rateLimitPerMin" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "TemplateVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "psdObjectKey" TEXT NOT NULL,
    "psdSha256" TEXT NOT NULL,
    "canvasWidth" INTEGER,
    "canvasHeight" INTEGER,
    "layerSchema" TEXT NOT NULL,
    "layerTree" TEXT NOT NULL,
    "psMinVersion" TEXT NOT NULL DEFAULT '25.0',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LayerBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "templateId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "layerId" INTEGER NOT NULL,
    "layerPath" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "label" TEXT,
    "acceptedFormats" TEXT NOT NULL DEFAULT 'jpg,png,jpeg',
    "fit" TEXT,
    "maxLength" INTEGER,
    "defaultFontVersionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LayerBinding_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FontVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "familyName" TEXT NOT NULL,
    "postscriptName" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'Regular',
    "fileObjectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "licenseNote" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "machineFingerprint" TEXT NOT NULL,
    "psVersion" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "fontInventoryHash" TEXT,
    "accessToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "sessionActive" BOOLEAN NOT NULL DEFAULT false,
    "currentJobId" TEXT,
    "lastHeartbeatAt" DATETIME,
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RenderJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "apiKeyId" TEXT,
    "templateVersionId" TEXT NOT NULL,
    "inputJson" TEXT NOT NULL,
    "outputFormat" TEXT NOT NULL DEFAULT 'png',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "workerId" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" DATETIME,
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "traceId" TEXT,
    "webhookUrl" TEXT,
    "webhookDelivered" BOOLEAN NOT NULL DEFAULT false,
    "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedAt" DATETIME,
    "processingAt" DATETIME,
    "succeededAt" DATETIME,
    "failedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RenderJob_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RenderJob_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "TemplateVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RenderJob_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "JobHeartbeat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "workerId" TEXT,
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JobHeartbeat_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JobHeartbeat_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "Worker" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "bindingId" TEXT,
    "originalName" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Artifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "RenderJob" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WebhookLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "deliveredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyPrefix_key" ON "ApiKey"("keyPrefix");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_active_idx" ON "ApiKey"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Template_code_key" ON "Template"("code");

-- CreateIndex
CREATE INDEX "Template_status_idx" ON "Template"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_code_key" ON "TemplateVersion"("code");

-- CreateIndex
CREATE INDEX "TemplateVersion_templateId_published_idx" ON "TemplateVersion"("templateId", "published");

-- CreateIndex
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "LayerBinding_templateId_idx" ON "LayerBinding"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "LayerBinding_templateId_bindingId_key" ON "LayerBinding"("templateId", "bindingId");

-- CreateIndex
CREATE UNIQUE INDEX "FontVersion_code_key" ON "FontVersion"("code");

-- CreateIndex
CREATE INDEX "FontVersion_familyName_idx" ON "FontVersion"("familyName");

-- CreateIndex
CREATE UNIQUE INDEX "FontVersion_postscriptName_style_key" ON "FontVersion"("postscriptName", "style");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_code_key" ON "Worker"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Worker_machineFingerprint_key" ON "Worker"("machineFingerprint");

-- CreateIndex
CREATE INDEX "Worker_sessionActive_idx" ON "Worker"("sessionActive");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_code_key" ON "RenderJob"("code");

-- CreateIndex
CREATE INDEX "RenderJob_status_priority_queuedAt_idx" ON "RenderJob"("status", "priority", "queuedAt");

-- CreateIndex
CREATE INDEX "RenderJob_workerId_idx" ON "RenderJob"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "RenderJob_tenantId_idempotencyKey_key" ON "RenderJob"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "JobHeartbeat_jobId_createdAt_idx" ON "JobHeartbeat"("jobId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_code_key" ON "Artifact"("code");

-- CreateIndex
CREATE INDEX "Artifact_jobId_kind_idx" ON "Artifact"("jobId", "kind");

-- CreateIndex
CREATE INDEX "Artifact_expiresAt_idx" ON "Artifact"("expiresAt");

-- CreateIndex
CREATE INDEX "WebhookLog_jobId_idx" ON "WebhookLog"("jobId");
