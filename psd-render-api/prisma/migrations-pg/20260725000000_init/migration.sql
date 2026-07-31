-- PostgreSQL 基线迁移（P0-3）
-- 由 schema.postgres.prisma 派生，作为生产部署的迁移起点
-- 后续 schema 变更应通过 prisma migrate dev --create-only 生成增量迁移
--
-- 与 SQLite migrations 目录互斥；构建镜像时由 Dockerfile 用本目录覆盖 migrations/

-- CreateTable: ApiKey
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "rateLimitPerMin" INTEGER,
    "quotaPerDay" INTEGER,
    "quotaUsedDay" INTEGER NOT NULL DEFAULT 0,
    "quotaResetAt" TIMESTAMP(3),
    "scopes" TEXT NOT NULL DEFAULT '',
    "webhookUrlDefault" TEXT,
    "webhookSecret" TEXT,
    "ipWhitelist" TEXT,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Template
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable: TemplateVersion
CREATE TABLE "TemplateVersion" (
    "id" TEXT NOT NULL,
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
    "thumbnailObjectKey" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable: LayerBinding
CREATE TABLE "LayerBinding" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LayerBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable: FontVersion
CREATE TABLE "FontVersion" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "familyName" TEXT NOT NULL,
    "postscriptName" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'Regular',
    "fileObjectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "licenseNote" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FontVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Worker
CREATE TABLE "Worker" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customCode" TEXT,
    "displayName" TEXT,
    "machineFingerprint" TEXT NOT NULL,
    "psVersion" TEXT NOT NULL,
    "capabilities" TEXT NOT NULL DEFAULT '[]',
    "fontInventoryHash" TEXT,
    "accessToken" TEXT,
    "accessTokenHash" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "sessionActive" BOOLEAN NOT NULL DEFAULT false,
    "currentJobId" TEXT,
    "lastHeartbeatAt" TIMESTAMP(3),
    "offlineSince" TIMESTAMP(3),
    "psMajorVersion" INTEGER NOT NULL DEFAULT 0,
    "os" TEXT NOT NULL DEFAULT 'unknown',
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Worker_pkey" PRIMARY KEY ("id")
);

-- CreateTable: StorageConfig
CREATE TABLE "StorageConfig" (
    "id" SERIAL NOT NULL,
    "backend" TEXT NOT NULL DEFAULT 'local',
    "localStorageDir" TEXT,
    "cosBucket" TEXT,
    "cosRegion" TEXT,
    "cosInternalDomain" TEXT,
    "cosPresignExpiresSec" INTEGER,
    "cosSecretIdEncrypted" TEXT,
    "cosSecretKeyEncrypted" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable: RenderJob
CREATE TABLE "RenderJob" (
    "id" TEXT NOT NULL,
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
    "requiredCapabilities" TEXT,
    "targetWorkerId" TEXT,
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "workerId" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "traceId" TEXT,
    "webhookUrl" TEXT,
    "webhookDelivered" BOOLEAN NOT NULL DEFAULT false,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedAt" TIMESTAMP(3),
    "processingAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable: JobHeartbeat
CREATE TABLE "JobHeartbeat" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workerId" TEXT,
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable: Artifact
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "bindingId" TEXT,
    "originalName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable: WebhookLog
CREATE TABLE "WebhookLog" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 6,
    "nextAttemptAt" TIMESTAMP(3),
    "responseCode" INTEGER,
    "responseBody" TEXT,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AlertEvent
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'WARN',
    "refType" TEXT,
    "refId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "metrics" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "ackedBy" TEXT,
    "ackedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AdminUser
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AdminSession
CREATE TABLE "AdminSession" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenHash" TEXT,
    "adminUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AuditLog
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorIp" TEXT,
    "actorUa" TEXT,
    "result" TEXT NOT NULL DEFAULT 'success',
    "refType" TEXT,
    "refId" TEXT,
    "message" TEXT,
    "meta" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: ApiKey
CREATE UNIQUE INDEX "ApiKey_keyPrefix_key" ON "ApiKey"("keyPrefix");
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_tenantId_active_idx" ON "ApiKey"("tenantId", "active");

-- CreateIndex: Template
CREATE UNIQUE INDEX "Template_code_key" ON "Template"("code");
CREATE INDEX "Template_status_idx" ON "Template"("status");

-- CreateIndex: TemplateVersion
CREATE UNIQUE INDEX "TemplateVersion_code_key" ON "TemplateVersion"("code");
CREATE INDEX "TemplateVersion_templateId_published_idx" ON "TemplateVersion"("templateId", "published");
CREATE UNIQUE INDEX "TemplateVersion_templateId_version_key" ON "TemplateVersion"("templateId", "version");

-- CreateIndex: LayerBinding
CREATE INDEX "LayerBinding_templateId_idx" ON "LayerBinding"("templateId");
CREATE UNIQUE INDEX "LayerBinding_templateId_bindingId_key" ON "LayerBinding"("templateId", "bindingId");

-- CreateIndex: FontVersion
CREATE UNIQUE INDEX "FontVersion_code_key" ON "FontVersion"("code");
CREATE INDEX "FontVersion_familyName_idx" ON "FontVersion"("familyName");
CREATE UNIQUE INDEX "FontVersion_postscriptName_style_key" ON "FontVersion"("postscriptName", "style");

-- CreateIndex: Worker
CREATE UNIQUE INDEX "Worker_code_key" ON "Worker"("code");
CREATE UNIQUE INDEX "Worker_customCode_key" ON "Worker"("customCode");
CREATE UNIQUE INDEX "Worker_machineFingerprint_key" ON "Worker"("machineFingerprint");
CREATE UNIQUE INDEX "Worker_accessTokenHash_key" ON "Worker"("accessTokenHash");
CREATE INDEX "Worker_sessionActive_idx" ON "Worker"("sessionActive");
CREATE INDEX "Worker_lastHeartbeatAt_idx" ON "Worker"("lastHeartbeatAt");

-- CreateIndex: RenderJob
CREATE UNIQUE INDEX "RenderJob_code_key" ON "RenderJob"("code");
CREATE INDEX "RenderJob_status_priority_queuedAt_idx" ON "RenderJob"("status", "priority", "queuedAt");
CREATE INDEX "RenderJob_workerId_idx" ON "RenderJob"("workerId");
CREATE INDEX "RenderJob_targetWorkerId_idx" ON "RenderJob"("targetWorkerId");
CREATE INDEX "RenderJob_cancelRequestedAt_idx" ON "RenderJob"("cancelRequestedAt");
CREATE UNIQUE INDEX "RenderJob_tenantId_idempotencyKey_key" ON "RenderJob"("tenantId", "idempotencyKey");

-- CreateIndex: JobHeartbeat
CREATE INDEX "JobHeartbeat_jobId_createdAt_idx" ON "JobHeartbeat"("jobId", "createdAt");

-- CreateIndex: Artifact
CREATE UNIQUE INDEX "Artifact_code_key" ON "Artifact"("code");
CREATE INDEX "Artifact_jobId_kind_idx" ON "Artifact"("jobId", "kind");
CREATE INDEX "Artifact_expiresAt_idx" ON "Artifact"("expiresAt");

-- CreateIndex: WebhookLog
CREATE UNIQUE INDEX "WebhookLog_eventId_key" ON "WebhookLog"("eventId");
CREATE INDEX "WebhookLog_jobId_idx" ON "WebhookLog"("jobId");
CREATE INDEX "WebhookLog_status_nextAttemptAt_idx" ON "WebhookLog"("status", "nextAttemptAt");
CREATE INDEX "WebhookLog_createdAt_idx" ON "WebhookLog"("createdAt");

-- CreateIndex: AlertEvent
CREATE INDEX "AlertEvent_type_status_idx" ON "AlertEvent"("type", "status");
CREATE INDEX "AlertEvent_triggeredAt_idx" ON "AlertEvent"("triggeredAt");

-- CreateIndex: AdminUser
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");
CREATE INDEX "AdminUser_active_idx" ON "AdminUser"("active");

-- CreateIndex: AdminSession
CREATE UNIQUE INDEX "AdminSession_token_key" ON "AdminSession"("token");
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");
CREATE INDEX "AdminSession_adminUserId_idx" ON "AdminSession"("adminUserId");
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession"("expiresAt");

-- CreateIndex: AuditLog
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");
CREATE INDEX "AuditLog_actor_createdAt_idx" ON "AuditLog"("actor", "createdAt");
CREATE INDEX "AuditLog_refType_refId_idx" ON "AuditLog"("refType", "refId");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey: TemplateVersion -> Template
ALTER TABLE "TemplateVersion" ADD CONSTRAINT "TemplateVersion_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "Template"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: LayerBinding -> Template
ALTER TABLE "LayerBinding" ADD CONSTRAINT "LayerBinding_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "Template"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: RenderJob -> ApiKey
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_apiKeyId_fkey"
    FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: RenderJob -> TemplateVersion
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_templateVersionId_fkey"
    FOREIGN KEY ("templateVersionId") REFERENCES "TemplateVersion"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: RenderJob -> Worker
ALTER TABLE "RenderJob" ADD CONSTRAINT "RenderJob_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "Worker"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: JobHeartbeat -> RenderJob
ALTER TABLE "JobHeartbeat" ADD CONSTRAINT "JobHeartbeat_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: JobHeartbeat -> Worker
ALTER TABLE "JobHeartbeat" ADD CONSTRAINT "JobHeartbeat_workerId_fkey"
    FOREIGN KEY ("workerId") REFERENCES "Worker"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Artifact -> RenderJob
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "RenderJob"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: AdminSession -> AdminUser
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminUserId_fkey"
    FOREIGN KEY ("adminUserId") REFERENCES "AdminUser"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- P0-3：旧 token 失效（防止历史明文 token 继续可用）
-- 注：基线迁移即包含 accessTokenHash 列，无需单独 UPDATE
