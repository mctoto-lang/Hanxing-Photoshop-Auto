/**
 * Admin API Key 管理路由（第三期 M1）
 *
 * 路由分组：
 *   - GET    /admin/api/api-keys                列表（viewer+）
 *   - GET    /admin/api/api-keys/:id            详情（viewer+）
 *   - POST   /admin/api/api-keys                创建（operator+，明文 key 仅返回一次）
 *   - PUT    /admin/api/api-keys/:id            更新配置（operator+）
 *   - GET    /admin/api/api-keys/:id/plaintext  查看明文（operator+，可反复查看）
 *   - POST   /admin/api/api-keys/:id/disable    禁用（operator+）
 *   - POST   /admin/api/api-keys/:id/enable     启用（operator+）
 *   - POST   /admin/api/api-keys/:id/reset-quota  重置日配额（operator+）
 *   - DELETE /admin/api/api-keys/:id            彻底删除（admin）
 *
 * 安全：
 *   - 创建返回的 plaintextKey 仅此一次；后续可随时经 /plaintext 查看（解密副本）
 *   - 列表/详情响应中不含 keyHash
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { apiKeyService } from '../services/admin/api-key-service.js';
import { auditService } from '../services/audit/audit-service.js';
import { AppError } from '../lib/errors.js';
import { validateWebhookUrlStatic } from '../lib/ssrf-guard.js';

// P0：Webhook URL 必须通过 SSRF 静态校验
const webhookUrlDefaultSchema = z
  .string()
  .url()
  .refine((v) => validateWebhookUrlStatic(v).ok, (v) => ({
    message: validateWebhookUrlStatic(v).reason ?? 'Webhook URL 不合法',
  }));

const createSchema = z.object({
  name: z.string().min(1).max(100),
  tenantId: z.string().max(64).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  rateLimitPerMin: z.number().int().positive().nullable().optional(),
  quotaPerDay: z.number().int().positive().nullable().optional(),
  scopes: z.array(z.string().min(1).max(64)).optional(),
  webhookUrlDefault: webhookUrlDefaultSchema.nullable().optional(),
  webhookSecret: z.string().max(256).nullable().optional(),
  ipWhitelist: z.string().max(1024).nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  priority: z.number().int().min(1).max(10).optional(),
  rateLimitPerMin: z.number().int().positive().nullable().optional(),
  quotaPerDay: z.number().int().positive().nullable().optional(),
  scopes: z.array(z.string().min(1).max(64)).optional(),
  webhookUrlDefault: webhookUrlDefaultSchema.nullable().optional(),
  webhookSecret: z.string().max(256).nullable().optional(),
  ipWhitelist: z.string().max(1024).nullable().optional(),
});

function toHttpError(e: unknown) {
  if (e instanceof AppError) {
    return {
      code: e.code,
      message: e.message,
      status: e.code === 'NOT_FOUND' ? 404 : e.code === 'VALIDATION_ERROR' ? 400 : 500,
    };
  }
  return { code: 'INTERNAL_ERROR', message: (e as Error).message, status: 500 };
}

export async function apiKeyRoutes(app: FastifyInstance) {
  // 列表
  app.get('/api/api-keys', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-api-keys'],
      summary: 'API Key 列表',
      description: '查询 API Key 列表，可按 tenantId / active 过滤。响应不含 keyHash（仅元数据）。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', description: '按租户过滤' },
          active: { type: 'string', enum: ['true', 'false'], description: '按启用状态过滤' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            apiKeys: {
              type: 'array',
              // 注意：items 必须显式声明 properties 或 additionalProperties: true，
              //   否则 fast-json-stringify 会将每个 key 序列化为空对象 {}，
              //   导致前端拿到 [{}, {}] —— 表格全部显示为"禁用"且无信息。
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string' },
                  keyPrefix: { type: 'string' },
                  name: { type: 'string' },
                  tenantId: { type: 'string' },
                  active: { type: 'boolean' },
                  priority: { type: 'integer' },
                  rateLimitPerMin: { type: 'integer', nullable: true },
                  quotaPerDay: { type: 'integer', nullable: true },
                  quotaUsedDay: { type: 'integer' },
                  quotaResetAt: { type: 'string', nullable: true },
                  scopes: { type: 'array', items: { type: 'string' } },
                  webhookUrlDefault: { type: 'string', nullable: true },
                  webhookSecret: { type: 'string', nullable: true },
                  ipWhitelist: { type: 'string', nullable: true },
                  disabledAt: { type: 'string', nullable: true },
                  createdAt: { type: 'string' },
                  lastUsedAt: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const query = req.query as { tenantId?: string; active?: string };
    const filter: { tenantId?: string; active?: boolean } = {};
    if (query.tenantId) filter.tenantId = query.tenantId;
    if (query.active === 'true') filter.active = true;
    if (query.active === 'false') filter.active = false;
    const apiKeys = await apiKeyService.list(filter);
    return reply.send({ apiKeys });
  });

  // 详情
  app.get('/api/api-keys/:id', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-api-keys'],
      summary: 'API Key 详情',
      description: '获取单个 API Key 的详细信息（不含 keyHash）。',
      security: [{ adminSession: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'API Key ID' } },
      },
      response: {
        200: {
          type: 'object',
          properties: { apiKey: { type: 'object', additionalProperties: true } },
        },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const detail = await apiKeyService.getDetail(id);
    if (!detail) return reply.code(404).send({ error: 'NOT_FOUND', message: 'API Key 不存在' });
    return reply.send({ apiKey: detail });
  });

  // 创建
  app.post('/api/api-keys', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-api-keys'],
      summary: '创建 API Key',
      description: [
        '创建新的 API Key。',
        '',
        '**重要**：响应中的 `plaintextKey` 仅此一次返回，前端必须立即提示用户保存，后续无法再次获取。',
        '',
        '可配置项：',
        '- 限流（rateLimitPerMin）',
        '- 日配额（quotaPerDay）',
        '- 作用域（scopes）',
        '- IP 白名单（ipWhitelist）',
        '- 默认 Webhook URL / Secret',
      ].join('\n'),
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'API Key 名称' },
          tenantId: { type: 'string', maxLength: 64, description: '租户 ID（可选）' },
          priority: { type: 'integer', minimum: 1, maximum: 10, description: '优先级（数字越小越高，默认 5）' },
          rateLimitPerMin: { type: 'integer', nullable: true, description: '每分钟最大请求数（null 表示不限）' },
          quotaPerDay: { type: 'integer', nullable: true, description: '每天最大请求数（null 表示不限）' },
          scopes: { type: 'array', items: { type: 'string' }, description: '作用域列表' },
          webhookUrlDefault: { type: 'string', format: 'uri', nullable: true, description: '默认 Webhook URL' },
          webhookSecret: { type: 'string', maxLength: 256, nullable: true, description: 'Webhook 签名密钥' },
          ipWhitelist: { type: 'string', maxLength: 1024, nullable: true, description: 'IP 白名单（逗号分隔 CIDR/IP）' },
        },
      },
      response: {
        201: {
          type: 'object',
          description: '创建成功，plaintextKey 仅此一次返回',
          properties: {
            apiKey: { type: 'object', additionalProperties: true },
            plaintextKey: { type: 'string', description: '明文 API Key（仅此一次返回，格式 sk_live_xxx）' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '请求参数不合法',
        details: parsed.error.issues,
      });
    }
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const result = await apiKeyService.create(parsed.data, operator);
      auditService.recordFromReq(req, {
        action: 'api_key_create',
        refType: 'api_key',
        refId: result.apiKey.id,
        message: `创建 API Key: ${result.apiKey.name}`,
        meta: { name: result.apiKey.name, keyPrefix: result.apiKey.keyPrefix, priority: result.apiKey.priority },
      });
      // 201 Created + 警告头：明文 key 仅此一次
      return reply.code(201).send(result);
    } catch (e) {
      const err = toHttpError(e);
      auditService.recordFromReq(req, {
        action: 'api_key_create',
        result: 'failure',
        message: `创建 API Key 失败: ${err.message}`,
        meta: { name: parsed.data.name },
      });
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
  });

  // 更新配置
  app.put('/api/api-keys/:id', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-api-keys'],
      summary: '更新 API Key 配置',
      description: '更新 API Key 的名称、优先级、限流、配额、scopes、默认 Webhook、IP 白名单等配置。所有字段可选，仅传需要修改的字段。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'API Key ID' } } },
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100, description: 'API Key 名称' },
          priority: { type: 'integer', minimum: 1, maximum: 10, description: '优先级（1 最高，10 最低）' },
          rateLimitPerMin: { type: 'integer', minimum: 1, nullable: true, description: '每分钟限流（null 表示不限流）' },
          quotaPerDay: { type: 'integer', minimum: 1, nullable: true, description: '每日配额（null 表示不限配额）' },
          scopes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 64 }, description: '权限 scopes 列表' },
          // C6 修复：webhookUrlDefault 类型与 zod updateSchema 中的 webhookUrlDefaultSchema
          //   (z.string().url()) 保持一致，并和 POST /admin/api/api-keys 中的同名字段统一为 string。
          //   原错误声明为 object，导致客户端按文档传 object 会被 zod 拒绝（400 VALIDATION_ERROR）。
          webhookUrlDefault: { type: 'string', format: 'uri', nullable: true, description: '默认 Webhook URL（需通过 SSRF 静态校验；null 表示清除）' },
          webhookSecret: { type: 'string', maxLength: 256, nullable: true, description: 'Webhook 签名密钥' },
          ipWhitelist: { type: 'string', maxLength: 1024, nullable: true, description: 'IP 白名单（CIDR 逗号分隔）' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            apiKey: { type: 'object', additionalProperties: true },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '请求参数不合法',
        details: parsed.error.issues,
      });
    }
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const apiKey = await apiKeyService.update(id, parsed.data, operator);
      auditService.recordFromReq(req, {
        action: 'api_key_update',
        refType: 'api_key',
        refId: id,
        message: `更新 API Key 配置: ${apiKey.name}`,
        meta: { name: apiKey.name, patch: parsed.data },
      });
      return reply.send({ apiKey });
    } catch (e) {
      const err = toHttpError(e);
      auditService.recordFromReq(req, {
        action: 'api_key_update',
        result: 'failure',
        refType: 'api_key',
        refId: id,
        message: `更新 API Key 失败: ${err.message}`,
      });
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
  });

  // 查看明文（替代已移除的轮换）
  app.get('/api/api-keys/:id/plaintext', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-api-keys'],
      summary: '查看 API Key 明文',
      description: '解密返回该密钥的完整明文（创建时保存的 AES-256-GCM 副本），可反复查看。存量旧密钥未保存副本，返回 400 提示删除重建。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'API Key ID' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            plaintextKey: { type: 'string', description: '完整明文 API Key' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const result = await apiKeyService.revealPlaintext(id, operator);
      auditService.recordFromReq(req, {
        action: 'api_key_reveal',
        refType: 'api_key',
        refId: id,
        message: `查看 API Key 明文`,
      });
      return reply.send(result);
    } catch (e) {
      const err = toHttpError(e);
      auditService.recordFromReq(req, {
        action: 'api_key_reveal',
        result: 'failure',
        refType: 'api_key',
        refId: id,
        message: `查看 API Key 明文失败: ${err.message}`,
      });
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
  });

  // 禁用
  app.post('/api/api-keys/:id/disable', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-api-keys'],
      summary: '禁用 API Key',
      description: '将 API Key 设为 active=false，立即拒绝所有后续请求。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { apiKey: { type: 'object', additionalProperties: true } } },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const apiKey = await apiKeyService.disable(id, operator);
      auditService.recordFromReq(req, {
        action: 'api_key_disable',
        refType: 'api_key',
        refId: id,
        message: `禁用 API Key: ${apiKey.name}`,
      });
      return reply.send({ apiKey });
    } catch (e) {
      const err = toHttpError(e);
      auditService.recordFromReq(req, {
        action: 'api_key_disable',
        result: 'failure',
        refType: 'api_key',
        refId: id,
        message: `禁用 API Key 失败: ${err.message}`,
      });
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
  });

  // 启用
  app.post('/api/api-keys/:id/enable', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-api-keys'],
      summary: '启用 API Key',
      description: '将 API Key 设为 active=true，恢复接受请求。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { apiKey: { type: 'object', additionalProperties: true } } },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const apiKey = await apiKeyService.enable(id, operator);
      auditService.recordFromReq(req, {
        action: 'api_key_enable',
        refType: 'api_key',
        refId: id,
        message: `启用 API Key: ${apiKey.name}`,
      });
      return reply.send({ apiKey });
    } catch (e) {
      const err = toHttpError(e);
      auditService.recordFromReq(req, {
        action: 'api_key_enable',
        result: 'failure',
        refType: 'api_key',
        refId: id,
        message: `启用 API Key 失败: ${err.message}`,
      });
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
  });

  // 重置日配额
  app.post('/api/api-keys/:id/reset-quota', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-api-keys'],
      summary: '重置 API Key 日配额',
      description: '将 API Key 当日已用配额清零，立即恢复可用额度。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'API Key ID' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            apiKey: { type: 'object', additionalProperties: true },
          },
        },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const apiKey = await apiKeyService.resetQuota(id, operator);
      auditService.recordFromReq(req, {
        action: 'api_key_reset_quota',
        refType: 'api_key',
        refId: id,
        message: `重置 API Key 日配额: ${apiKey.name}`,
      });
      return reply.send({ apiKey });
    } catch (e) {
      const err = toHttpError(e);
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
  });

  // 彻底删除（admin）
  app.delete('/api/api-keys/:id', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-api-keys'],
      summary: '彻底删除 API Key',
      description: '从数据库彻底删除 API Key 记录（不可恢复）。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const result = await apiKeyService.delete(id, operator);
      auditService.recordFromReq(req, {
        action: 'api_key_delete',
        refType: 'api_key',
        refId: id,
        message: `彻底删除 API Key: ${id}`,
      });
      return reply.send(result);
    } catch (e) {
      const err = toHttpError(e);
      auditService.recordFromReq(req, {
        action: 'api_key_delete',
        result: 'failure',
        refType: 'api_key',
        refId: id,
        message: `删除 API Key 失败: ${err.message}`,
      });
      return reply.code(err.status).send({ error: err.code, message: err.message });
    }
  });
}
