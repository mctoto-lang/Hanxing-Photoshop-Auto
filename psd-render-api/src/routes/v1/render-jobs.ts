/**
 * 外部 API - 渲染任务
 *
 * POST /v1/render-jobs        提交渲染任务（含 Idempotency-Key）
 * GET  /v1/render-jobs/:jobId 查询任务状态与结果下载地址
 * POST /v1/render-jobs/:jobId/cancel  请求取消任务
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { renderJobService } from '../../services/render-job/job-service.js';
import { genTraceId } from '../../lib/logger.js';
import { validateWebhookUrlStatic } from '../../lib/ssrf-guard.js';

// P0：Webhook URL 必须通过 SSRF 静态校验（投递时再做动态校验）
// P2-5：限制 URL 长度 ≤ 2048
const webhookUrlSchema = z
  .string()
  .max(2048, 'Webhook URL 长度不能超过 2048 字符')
  .url()
  .refine((v) => validateWebhookUrlStatic(v).ok, (v) => ({
    message: validateWebhookUrlStatic(v).reason ?? 'Webhook URL 不合法',
  }));

// P2-5：输入项校验——assetId 长度限制、text 长度限制防 DB 写入压力
const inputItemSchema = z.object({
  assetId: z.string().min(1).max(128).optional(),
  text: z.string().max(10000).optional(),
});

const createSchema = z.object({
  templateVersionId: z.string().min(1).max(128),
  // P2-5：input 字段数 ≤ 100，单个 key 长度 ≤ 128
  input: z.record(z.string().min(1).max(128), inputItemSchema)
    .refine((obj) => Object.keys(obj).length <= 100, 'input 字段数不能超过 100'),
  output: z.object({
    format: z.enum(['png', 'jpeg', 'psd']).default('png'),
    quality: z.number().int().min(1).max(100).optional(),
  }).default({ format: 'png' }),
  priority: z.number().int().min(1).max(10).optional(),
  jsxTimeoutSeconds: z.number().int().min(60).max(3600).optional(),
  webhookUrl: webhookUrlSchema.optional(),
  // 第二期：能力路由要求（可选；不传则任何 Worker 可领）
  requiredCapabilities: z.object({
    psMajorVersion: z.number().int().positive().optional(),
    supportsSmartObject: z.boolean().optional(),
    supportsTextLayer: z.boolean().optional(),
    os: z.string().optional(),
  }).optional(),
});

export async function renderJobRoutes(app: FastifyInstance) {
  // 提交渲染任务
  app.post('/v1/render-jobs', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['render-jobs'],
      summary: '提交渲染任务',
      description: [
        '提交渲染任务。任务入队后由空闲 Worker 领取执行，终态时回调 webhookUrl（若提供）。',
        '',
        '**幂等性**：通过 `Idempotency-Key` 请求头实现。同租户同 key 重复提交将返回相同任务，HTTP 200；首次创建返回 201。',
        '',
        '**能力路由**：可选的 `requiredCapabilities` 限定任务的 Worker 要求（如 PS 大版本、是否支持智能对象）。',
      ].join('\n'),
      security: [{ apiKey: [] }],
      headers: {
        type: 'object',
        properties: {
          // P0 修复（严重4）：补齐 maxLength 约束（与实际实现保持一致）
          'Idempotency-Key': {
            type: 'string',
            maxLength: 128,
            description: '幂等键（同租户下唯一，≤128 字符）。未提供时自动生成 `auto-{timestamp}`。',
          },
        },
      },
      body: {
        type: 'object',
        required: ['templateVersionId', 'input'],
        properties: {
          templateVersionId: { type: 'string', description: '已发布的模板版本 ID（tpv_xxx）' },
          input: {
            type: 'object',
            description: '绑定 ID 到输入值的映射。图片绑定用 `{ assetId }`，文本绑定用 `{ text }`。',
            additionalProperties: {
              type: 'object',
              properties: {
                assetId: { type: 'string', description: '上传资产后获得的 assetId（art_xxx）' },
                text: { type: 'string', description: '文本内容（仅文本绑定）' },
              },
            },
          },
          output: {
            type: 'object',
            properties: {
              format: { type: 'string', enum: ['png', 'jpeg', 'psd'], default: 'png' },
              quality: { type: 'integer', minimum: 1, maximum: 100 },
            },
            default: { format: 'png' },
          },
          priority: { type: 'integer', minimum: 1, maximum: 10, description: '优先级（数字越小优先级越高，默认 5）' },
          // C5 修复：补齐与 zod createSchema 一致的 jsxTimeoutSeconds 字段
          //   原 OpenAPI 漏掉此字段，客户端无法发现可调整 JSX 执行超时
          jsxTimeoutSeconds: { type: 'integer', minimum: 60, maximum: 3600, description: '可选，Worker 执行 JSX 脚本的超时秒数（默认 600，范围 60-3600）' },
          webhookUrl: { type: 'string', format: 'uri', description: '可选，任务终态时回调此地址' },
          requiredCapabilities: {
            type: 'object',
            description: '可选，能力路由要求',
            properties: {
              psMajorVersion: { type: 'integer', minimum: 1 },
              supportsSmartObject: { type: 'boolean' },
              supportsTextLayer: { type: 'boolean' },
              os: { type: 'string' },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          required: ['jobId', 'status', 'idempotencyKey', 'traceId', 'createdAt'],
          properties: {
            jobId: { type: 'string', description: '任务编码（job_xxx）' },
            status: { type: 'string', description: '初始状态（QUEUED）' },
            idempotencyKey: { type: 'string' },
            traceId: { type: 'string', description: '链路追踪 ID' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        200: {
          type: 'object',
          description: '幂等命中时返回已有任务',
          required: ['jobId', 'status', 'idempotencyKey', 'traceId', 'createdAt'],
          properties: {
            jobId: { type: 'string' },
            status: { type: 'string' },
            idempotencyKey: { type: 'string' },
            traceId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺失' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }

    // Idempotency-Key（规范：同租户下幂等键唯一）
    // P2-5：限制长度 ≤ 128，防止恶意超长 key 写入 DB
    const rawKey = (req.headers['idempotency-key'] as string) || `auto-${Date.now()}`;
    if (rawKey.length > 128) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Idempotency-Key 长度不能超过 128 字符',
      });
    }
    const idempotencyKey = rawKey;

    const user = req.user as any;
    const traceId = genTraceId();

    const viewer =
      typeof user.userId === 'string' && user.userId
        ? { userId: user.userId, userAdmin: user.userAdmin === true }
        : user.userAdmin === true
          ? { userAdmin: true }
          : undefined;
    const { job, created } = await renderJobService.create({
      tenantId: user.tenantId ?? 'default',
      apiKeyId: user.apiKeyId,
      viewer,
      idempotencyKey,
      templateVersionId: parsed.data.templateVersionId,
      input: parsed.data.input as any,
      output: parsed.data.output as any,
      priority: parsed.data.priority,
      webhookUrl: parsed.data.webhookUrl,
      requiredCapabilities: parsed.data.requiredCapabilities,
      jsxTimeoutSeconds: parsed.data.jsxTimeoutSeconds,
      traceId,
    });

    const status = created ? 201 : 200;
    return reply.code(status).send({
      jobId: job.code,
      status: job.status,
      idempotencyKey,
      traceId,
      createdAt: job.createdAt,
    });
  });

  // 查询任务
  app.get('/v1/render-jobs/:jobId', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['render-jobs'],
      summary: '查询任务',
      description: '查询任务状态、进度、产物下载地址。仅返回同租户下的任务。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: '任务编码（job_xxx）' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['jobId', 'status'],
          properties: {
            jobId: { type: 'string', description: '任务编码（job_xxx）' },
            status: { type: 'string', description: 'QUEUED | LEASED | PROCESSING | SUCCEEDED | FAILED | CANCELLING | CANCELLED' },
            attempt: { type: 'integer', description: '尝试次数（从 1 起，每次重试 +1）' },
            priority: { type: 'integer', description: '优先级（1-10，数字越小优先级越高）' },
            stage: { type: 'string', nullable: true, description: '当前执行阶段（DOWNLOAD / RUN_JSX / EXPORT / UPLOAD）' },
            progress: { type: 'integer', description: '执行进度（0-100）' },
            template: {
              type: 'object',
              description: '模板信息',
              properties: {
                name: { type: 'string', description: '模板名称' },
                version: { type: 'string', description: '模板版本 ID' },
              },
            },
            resultUrl: { type: 'string', description: '结果下载地址（SUCCEEDED 时返回，默认 3 天有效，由 OUTPUT_RETENTION_DAYS 控制；local 存储模式为相对路径 /storage/download?key=…' },
            resultToken: { type: 'string', nullable: true, description: '结果下载签名令牌（local 存储模式返回，调用方以 Authorization: Bearer 携带；COS 模式为 null）' },
            resultExpiresAt: { type: 'string', format: 'date-time', nullable: true, description: '结果下载地址过期时间' },
            errorCode: { type: 'string', nullable: true, description: '失败时的错误码' },
            errorMessage: { type: 'string', nullable: true, description: '失败时的错误详情' },
            createdAt: { type: 'string', format: 'date-time', description: '任务创建时间' },
            updatedAt: { type: 'string', format: 'date-time', description: '任务最后更新时间' },
            queuedAt: { type: 'string', format: 'date-time', nullable: true, description: '入队时间' },
            succeededAt: { type: 'string', format: 'date-time', nullable: true, description: '成功完成时间' },
            failedAt: { type: 'string', format: 'date-time', nullable: true, description: '失败时间' },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺失' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        404: { $ref: 'ErrorResponse#' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const jobId = (req.params as any).jobId as string;
    const user = req.user as any;
    const result = await renderJobService.get(jobId, user.tenantId ?? 'default');
    if (!result) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '任务不存在' });
    }
    return reply.send(result);
  });

  // 取消任务（第二期）
  app.post('/v1/render-jobs/:jobId/cancel', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['render-jobs'],
      summary: '取消任务',
      description: [
        '请求取消任务。',
        '',
        '状态机：',
        '- QUEUED：直接置为 CANCELLED',
        '- LEASED/PROCESSING：置为 CANCELLING，Worker 在阶段边界检测后置为 CANCELLED',
        '- SUCCEEDED/FAILED/CANCELLED：返回 409 拒绝',
      ].join('\n'),
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: '任务编码（job_xxx）' },
        },
      },
      body: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '可选，取消原因' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['jobId', 'status', 'updated', 'message'],
          properties: {
            jobId: { type: 'string' },
            status: { type: 'string' },
            updated: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺失' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        404: { $ref: 'ErrorResponse#' },
        409: {
          type: 'object',
          description: '业务级状态返回（非错误响应）：任务当前状态不允许取消（如已完成/失败）。返回当前 job 状态供客户端决策。',
          required: ['jobId', 'status', 'updated', 'message'],
          properties: {
            jobId: { type: 'string' },
            status: { type: 'string' },
            updated: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const jobId = (req.params as any).jobId as string;
    const user = req.user as any;
    const body = (req.body ?? {}) as any;
    const reason = typeof body.reason === 'string' ? body.reason : undefined;

    const result = await renderJobService.cancel(jobId, user.tenantId ?? 'default', reason);
    const status = result.updated ? 200 : 409;
    return reply.code(status).send({
      jobId,
      status: result.status,
      updated: result.updated,
      message: result.updated
        ? (result.status === 'CANCELLED' ? '任务已取消' : '取消请求已发出，等待 Worker 检测')
        : '任务已处于终态，无法取消',
    });
  });
}
