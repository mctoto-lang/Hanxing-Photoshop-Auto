/**
 * Admin UI 路由（规范：后端内嵌简单页面，内网访问）
 *
 * 第三期 M3 起所有 /admin/api/* 路由前置鉴权：
 *   - GET 类查询：需 viewer 及以上
 *   - 写操作（ack 告警等）：需 operator 及以上
 *
 * 提供：
 * - GET /admin                  首页（HTML，未登录跳转 /admin/login）
 * - GET /admin/api/stats        概览数据
 * - GET /admin/api/jobs         任务列表
 * - GET /admin/api/workers      Worker 列表
 * - GET /admin/api/templates    模板列表
 * - GET /admin/api/alerts       告警列表
 * - POST /admin/api/alerts/:id/ack 确认告警（operator）
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { adminPageHtml } from './admin-page.js';
import { alertService } from '../services/alert/alert-service.js';
import { getTemplateDisplayStatus } from '../services/template/template-status.js';
import { adminAuthService } from '../services/admin/admin-auth-service.js';
import { env } from '../config/env.js';
import { getStorage } from '../services/storage/index.js';

function extractToken(req: any): string | null {
  const cookie = req.headers.cookie;
  if (cookie && typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === 'admin_session' && v.length > 0) {
        return v.join('=').trim();
      }
    }
  }
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export async function adminRoutes(app: FastifyInstance) {
  // 首页（未登录跳转登录页）
  app.get('/', async (req, reply) => {
    // POC 模式：直接返回首页
    if (!env.ADMIN_AUTH_ENABLED) {
      return reply.type('text/html').send(adminPageHtml);
    }
    const token = extractToken(req);
    const user = token ? await adminAuthService.validateSession(token) : null;
    if (!user) {
      return reply.redirect('/admin/login', 302);
    }
    return reply.type('text/html').send(adminPageHtml);
  });

  // 概览数据
  app.get('/api/stats', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-stats'],
      summary: '概览统计',
      description: '返回首页概览数据：Worker / 模板 / 字体数量，任务按状态分组的计数。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            workers: { type: 'integer' },
            templates: { type: 'integer' },
            fonts: { type: 'integer' },
            jobs: {
              type: 'object',
              properties: {
                queued: { type: 'integer' },
                processing: { type: 'integer' },
                succeeded: { type: 'integer' },
                failed: { type: 'integer' },
                total: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (_req, reply) => {
    const [
      workers,
      templates,
      jobsQueued,
      jobsProcessing,
      jobsSucceeded,
      jobsFailed,
      fonts,
    ] = await Promise.all([
      prisma.worker.count(),
      // 仅统计未软删除的模板，避免累加已删除模板
      prisma.template.count({ where: { NOT: { status: 'DELETED' } } }),
      prisma.renderJob.count({ where: { status: 'QUEUED' } }),
      prisma.renderJob.count({ where: { status: { in: ['LEASED', 'PROCESSING'] } } }),
      prisma.renderJob.count({ where: { status: 'SUCCEEDED' } }),
      prisma.renderJob.count({ where: { status: 'FAILED' } }),
      prisma.fontVersion.count(),
    ]);
    return reply.send({
      workers,
      templates,
      fonts,
      jobs: {
        queued: jobsQueued,
        processing: jobsProcessing,
        succeeded: jobsSucceeded,
        failed: jobsFailed,
        total: jobsQueued + jobsProcessing + jobsSucceeded + jobsFailed,
      },
    });
  });

  // 任务列表
  app.get('/api/jobs', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-jobs'],
      summary: '任务列表',
      description: '返回最近的任务列表（默认 50 条，最多 200 条），按创建时间倒序。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          required: ['jobs'],
          properties: {
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                required: ['jobId', 'status', 'priority', 'attempt', 'maxAttempts', 'stage', 'progress', 'errorCode', 'template', 'worker', 'workerCustomCode', 'workerDisplayName', 'resultAvailable', 'resultMimeType', 'resultSizeBytes', 'resultExpiresAt', 'createdAt', 'succeededAt', 'failedAt'],
                properties: {
                  jobId: { type: 'string' },
                  status: { type: 'string' },
                  priority: { type: 'integer' },
                  attempt: { type: 'integer' },
                  maxAttempts: { type: 'integer' },
                  stage: { type: 'string', nullable: true },
                  progress: { type: 'integer' },
                  errorCode: { type: 'string', nullable: true },
                  // 失败原因透出给 Admin UI（数据库已存 errorMessage，外部 API 也返回，
                  // 此前 Admin 接口不返回导致管理员看不到失败原因，只能盲点重试）
                  errorMessage: { type: 'string', nullable: true },
                  // 修复：handler 实际返回 j.templateVersion.template.name（字符串），
                  //   原 schema 声明为 type:'object' 导致 fast-json-stringify 按字符索引
                  //   把字符串序列化为 {"0":"挂","1":"历",...} 对象，前端 escapeHtml 后显示 [object Object]
                  template: { type: 'string' },
                  worker: { type: 'string', nullable: true },
                  workerCustomCode: { type: 'string', nullable: true },
                  workerDisplayName: { type: 'string', nullable: true },
                  resultAvailable: { type: 'boolean' },
                  resultMimeType: { type: 'string', nullable: true },
                  resultSizeBytes: { type: 'integer', nullable: true },
                  resultExpiresAt: { type: 'string', format: 'date-time', nullable: true },
                  createdAt: { type: 'string', format: 'date-time' },
                  succeededAt: { type: 'string', format: 'date-time', nullable: true },
                  failedAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
      },
    },
  }, async (req, reply) => {
    const limit = Math.min(Number((req.query as any).limit ?? 50), 200);
    const jobs = await prisma.renderJob.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        templateVersion: { include: { template: true } },
        worker: true,
        artifacts: { where: { kind: 'output' }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return reply.send({
      jobs: jobs.map((j) => {
        const result = j.artifacts[0];
        return {
          jobId: j.code,
          status: j.status,
          priority: j.priority,
          attempt: j.attempt,
          maxAttempts: j.maxAttempts,
          stage: j.stage,
          progress: j.progress,
          errorCode: j.errorCode,
          errorMessage: j.errorMessage,
          template: j.templateVersion.template.name,
          worker: j.worker?.code ?? null,
          workerCustomCode: j.worker?.customCode ?? null,
          workerDisplayName: j.worker?.displayName ?? null,
          resultAvailable: Boolean(result && result.expiresAt.getTime() > Date.now()),
          resultMimeType: result?.mimeType ?? null,
          resultSizeBytes: result?.sizeBytes ?? null,
          resultExpiresAt: result?.expiresAt ?? null,
          createdAt: j.createdAt,
          succeededAt: j.succeededAt,
          failedAt: j.failedAt,
        };
      }),
    });
  });

  app.get('/api/jobs/:code/result', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-jobs'],
      summary: '下载任务结果',
      description: '流式下载未过期的任务结果文件。',
      security: [{ adminSession: [] }],
      params: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string' } },
      },
      response: {
        200: { type: 'string', format: 'binary' },
        404: { $ref: 'ErrorResponse#' },
        410: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const code = (req.params as { code: string }).code;
    const job = await prisma.renderJob.findUnique({
      where: { code },
      include: { artifacts: { where: { kind: 'output' }, orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const result = job?.artifacts[0];
    if (!result) {
      return reply.code(404).send({ error: 'RESULT_NOT_FOUND', message: '任务结果不存在' });
    }
    if (result.expiresAt.getTime() <= Date.now()) {
      return reply.code(410).send({ error: 'RESULT_EXPIRED', message: '任务结果已过期' });
    }
    const storage = await getStorage();
    const meta = await storage.headObject(result.objectKey);
    if (!meta) {
      return reply.code(404).send({ error: 'RESULT_NOT_FOUND', message: '任务结果不存在' });
    }
    const extension = result.mimeType === 'image/png'
      ? 'png'
      : result.mimeType === 'image/jpeg'
        ? 'jpg'
        : result.mimeType === 'image/vnd.adobe.photoshop'
          ? 'psd'
          : 'bin';
    reply.header('Content-Type', result.mimeType);
    reply.header('Content-Length', meta.size);
    reply.header('Content-Disposition', `attachment; filename="${code}.${extension}"`);
    return storage.getObjectStream(result.objectKey);
  });

  // Worker 列表
  app.get('/api/workers', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-workers'],
      summary: 'Worker 列表',
      description: '返回所有 Worker 节点，含实时状态（IDLE/BUSY/OFFLINE/HEARTBEAT_TIMEOUT）、当前执行任务、心跳年龄、硬件画像摘要。',
      security: [{ adminSession: [] }],
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          required: ['workers'],
          properties: {
            workers: {
              type: 'array',
              items: {
                type: 'object',
                required: ['workerId', 'code', 'customCode', 'displayName', 'psVersion', 'sessionActive', 'online', 'status', 'statusLabel', 'heartbeatAgeSec', 'heartbeatTimeoutSec', 'currentJobId', 'currentJob', 'fontInventoryHash', 'lastHeartbeatAt', 'registeredAt', 'hostname', 'osVersion', 'os', 'cpuModel', 'registeredIp'],
                properties: {
                  workerId: { type: 'string' },
                  code: { type: 'string' },
                  customCode: { type: 'string', nullable: true },
                  displayName: { type: 'string', nullable: true },
                  psVersion: { type: 'string', nullable: true },
                  sessionActive: { type: 'boolean' },
                  online: { type: 'boolean' },
                  status: { type: 'string' },
                  statusLabel: { type: 'string' },
                  heartbeatAgeSec: { type: 'integer', nullable: true },
                  heartbeatTimeoutSec: { type: 'integer' },
                  currentJobId: { type: 'string', nullable: true },
                  currentJob: { type: 'object', nullable: true, additionalProperties: true },
                  fontInventoryHash: { type: 'string', nullable: true },
                  lastHeartbeatAt: { type: 'string', format: 'date-time', nullable: true },
                  registeredAt: { type: 'string', format: 'date-time' },
                  hostname: { type: 'string', nullable: true },
                  osVersion: { type: 'string', nullable: true },
                  os: { type: 'string', nullable: true },
                  cpuModel: { type: 'string', nullable: true },
                  registeredIp: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
      },
    },
  }, async (_req, reply) => {
    const workers = await prisma.worker.findMany({
      orderBy: { registeredAt: 'desc' },
    });
    const activeJobs = new Map((await prisma.renderJob.findMany({
      where: { workerId: { in: workers.map((w) => w.id) }, status: { in: ['LEASED', 'PROCESSING', 'CANCELLING'] } },
      select: { id: true, workerId: true, status: true, stage: true, progress: true },
    })).map((j) => [j.workerId, j]));
    const now = Date.now();
    const heartbeatTimeoutMs = env.ALERT_WORKER_OFFLINE_SECONDS * 1000;
    return reply.send({
      workers: workers.map((w) => {
        const activeJob = activeJobs.get(w.id);
        const heartbeatAgeSec = w.lastHeartbeatAt ? Math.floor((now - w.lastHeartbeatAt.getTime()) / 1000) : null;
        const status = !w.sessionActive ? 'OFFLINE' : heartbeatAgeSec === null ? 'CONNECTING' : heartbeatAgeSec >= env.ALERT_WORKER_OFFLINE_SECONDS ? 'HEARTBEAT_TIMEOUT' : activeJob ? 'BUSY' : 'IDLE';
        return {
        workerId: w.id,
        code: w.code,
        customCode: w.customCode,
        displayName: w.displayName,
        psVersion: w.psVersion,
        sessionActive: w.sessionActive,
        online: status === 'IDLE' || status === 'BUSY',
        status,
        statusLabel: status === 'IDLE' ? '空闲' : status === 'BUSY' ? '执行中' : status === 'CONNECTING' ? '等待心跳' : status === 'HEARTBEAT_TIMEOUT' ? '心跳超时' : '已离线',
        heartbeatAgeSec,
        heartbeatTimeoutSec: Math.floor(heartbeatTimeoutMs / 1000),
        currentJobId: activeJob?.id ?? null,
        currentJob: activeJob ? { status: activeJob.status, stage: activeJob.stage, progress: activeJob.progress } : null,
        fontInventoryHash: w.fontInventoryHash?.slice(0, 8),
        lastHeartbeatAt: w.lastHeartbeatAt,
        registeredAt: w.registeredAt,
        // 第四期 M9：硬件画像摘要（详情页查看完整信息）
        hostname: w.hostname,
        osVersion: w.osVersion,
        os: w.os,
        cpuModel: w.cpuModel,
        registeredIp: w.registeredIp,
      }; }),
    });
  });

  // 模板列表
  app.get('/api/templates', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-templates'],
      summary: '模板列表',
      description: '返回所有未软删除的模板（含最新版本号、发布状态、缩略图 key），按创建时间倒序。',
      security: [{ adminSession: [] }],
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          required: ['templates'],
          properties: {
            templates: {
              type: 'array',
              items: {
                type: 'object',
                required: ['templateId', 'code', 'name', 'status', 'statusLabel', 'latestVersion', 'published', 'thumbnailObjectKey', 'createdAt'],
                properties: {
                  templateId: { type: 'string' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  status: { type: 'string' },
                  statusLabel: { type: 'string' },
                  latestVersion: { type: 'integer' },
                  published: { type: 'boolean' },
                  thumbnailObjectKey: { type: 'string', nullable: true },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
      },
    },
  }, async (_req, reply) => {
    const templates = await prisma.template.findMany({
      where: { NOT: { status: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    return reply.send({
      templates: templates.map((t) => ({
        templateId: t.id,
        code: t.code,
        name: t.name,
        status: t.status,
        statusLabel: getTemplateDisplayStatus(t.status, t.versions[0]?.published ?? false),
        latestVersion: t.versions[0]?.version ?? 0,
        published: t.versions[0]?.published ?? false,
        thumbnailObjectKey: t.versions[0]?.thumbnailObjectKey ?? null,
      tenantId: t.tenantId,
      ownerUserId: t.ownerUserId ?? null,
      visibility: t.visibility === 'private' ? 'private' : 'public',
        createdAt: t.createdAt,
      })),
    });
  });

  // 告警列表
  app.get('/api/alerts', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-alerts'],
      summary: '告警列表',
      description: '返回告警列表，可按 status 过滤（ACTIVE/ACKED/RESOLVED），默认 100 条，最多 500 条。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ACTIVE', 'ACKED', 'RESOLVED'] },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          required: ['alerts'],
          properties: {
            alerts: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'type', 'severity', 'refType', 'refId', 'title', 'message', 'metrics', 'status', 'ackedBy', 'ackedAt', 'triggeredAt', 'resolvedAt'],
                properties: {
                  id: { type: 'string' },
                  type: { type: 'string' },
                  severity: { type: 'string' },
                  refType: { type: 'string', nullable: true },
                  refId: { type: 'string', nullable: true },
                  title: { type: 'string' },
                  message: { type: 'string' },
                  metrics: { type: 'object', additionalProperties: true },
                  status: { type: 'string' },
                  ackedBy: { type: 'string', nullable: true },
                  ackedAt: { type: 'string', format: 'date-time', nullable: true },
                  triggeredAt: { type: 'string', format: 'date-time' },
                  resolvedAt: { type: 'string', format: 'date-time', nullable: true },
                },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
      },
    },
  }, async (req, reply) => {
    const status = (req.query as any).status as string | undefined;
    const limit = Math.min(Number((req.query as any).limit ?? 100), 500);
    const alerts = await alertService.list({ status, limit });
    return reply.send({
      alerts: alerts.map((a) => ({
        id: a.id,
        type: a.type,
        severity: a.severity,
        refType: a.refType,
        refId: a.refId,
        title: a.title,
        message: a.message,
        metrics: a.metrics,
        status: a.status,
        ackedBy: a.ackedBy,
        ackedAt: a.ackedAt,
        triggeredAt: a.triggeredAt,
        resolvedAt: a.resolvedAt,
      })),
    });
  });

  // 确认告警（operator 及以上）
  app.post('/api/alerts/:id/ack', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-alerts'],
      summary: '确认告警',
      description: '将 ACTIVE 告警置为 ACKED，记录确认人。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: '告警 ID' } },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    await alertService.ack(id, req.adminUser?.username ?? 'admin');
    return reply.send({ ok: true });
  });

  // 第三期 M10：告警通知渠道状态（仅展示已配置的渠道，不泄露完整 URL）
  app.get('/api/alerts/channels', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-alerts'],
      summary: '告警通知渠道状态',
      description: '返回已配置的告警通知渠道（webhook/飞书/钉钉）的启用状态，不泄露完整 URL。同时返回最低通知严重级与超时配置。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            channels: {
              type: 'object',
              properties: {
                webhook: { type: 'boolean', description: '通用 Webhook 是否已配置' },
                feishu: { type: 'boolean', description: '飞书机器人是否已配置' },
                dingtalk: { type: 'boolean', description: '钉钉机器人是否已配置' },
              },
            },
            minSeverity: { type: 'string', description: '最低通知严重级（INFO/WARN/ERROR/CRITICAL）' },
            timeoutMs: { type: 'integer', description: '单次通知超时（毫秒）' },
          },
        },
      },
    },
  }, async (_req, reply) => {
    return reply.send({
      channels: {
        webhook: !!env.ALERT_WEBHOOK_URL,
        feishu: !!env.ALERT_FEISHU_WEBHOOK_URL,
        dingtalk: !!env.ALERT_DINGTALK_WEBHOOK_URL,
      },
      minSeverity: env.ALERT_MIN_SEVERITY,
      timeoutMs: env.ALERT_NOTIFY_TIMEOUT_MS,
    });
  });
}
