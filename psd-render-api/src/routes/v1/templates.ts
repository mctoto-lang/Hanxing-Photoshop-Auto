/**
 * 外部 API - 模板管理
 *
 * POST /v1/templates/upload-url    获取 PSD 文件上传地址
 * POST /v1/templates               触发 PSD 解析，返回图层树
 * PUT  /v1/templates/:id/layer-bindings  保存图层绑定配置
 * POST /v1/templates/:id/publish   发布模板版本
 * GET  /v1/templates               模板列表
 * GET  /v1/templates/:id           模板详情（含图层树、绑定）
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { templateService } from '../../services/template/template-service.js';
import type { LayerSchema } from '../../types/index.js';

export async function templateRoutes(app: FastifyInstance) {
  // 获取 PSD 上传地址
  app.post('/v1/templates/upload-url', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '获取 PSD 文件上传地址',
      description: '获取 PSD 文件预签名上传地址。PSD 文件将作为模板版本底稿，触发解析后生成图层树。',
      security: [{ apiKey: [] }],
      body: {
        type: 'object',
        required: ['fileName'],
        properties: {
          fileName: { type: 'string', minLength: 1, description: 'PSD 文件名（含 .psd 扩展名）' },
          mimeType: { type: 'string', description: '可选，默认 image/vnd.adobe.photoshop' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['uploadUrl', 'method', 'headers', 'objectKey', 'expiresAt'],
          properties: {
            uploadUrl: { type: 'string' },
            method: { type: 'string' },
            headers: { type: 'object', additionalProperties: true },
            objectKey: { type: 'string' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺失' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const fileName = body.fileName;
    if (!fileName || typeof fileName !== 'string') {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '缺少 fileName' });
    }
    const result = await templateService.getUploadUrl({
      fileName,
      mimeType: body.mimeType,
    });
    return reply.send(result);
  });

  // 触发 PSD 解析
  const createSchema = z.object({
    objectKey: z.string().min(1),
    name: z.string().min(1),
    psMinVersion: z.string().optional(),
  });

  app.post('/v1/templates', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '触发 PSD 解析并创建模板',
      description: '基于已上传的 PSD 文件 objectKey 触发解析，生成模板与首个版本（DRAFT 状态），返回模板 ID 与图层树。',
      security: [{ apiKey: [] }],
      body: {
        type: 'object',
        required: ['objectKey', 'name'],
        properties: {
          objectKey: { type: 'string', minLength: 1, description: '上传 PSD 后获得的 objectKey' },
          name: { type: 'string', minLength: 1, description: '模板名称' },
          psMinVersion: { type: 'string', description: '可选，最低 PS 版本要求，默认 25.0' },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          description: '创建成功，返回模板 ID 与解析得到的图层树',
          properties: {
            templateId: { type: 'string', description: '模板 ID（tpl_xxx）' },
            version: { type: 'integer', description: '版本号（首个版本为 1）' },
            layerSchema: { type: 'object', additionalProperties: true, description: '解析得到的图层树结构' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        422: { $ref: 'ErrorResponse#', description: 'PSD 解析失败（非 PSD 文件 / 损坏 / 无图层）' },
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
    // P0 安全修复（严重 S2）：从鉴权上下文取 tenantId，禁止回落 default
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    const result = await templateService.createFromPsd({ ...parsed.data, tenantId });
    return reply.send(result);
  });

  // 保存图层绑定配置
  // 绑定类型允许 smartObject / text / pixel；fit 默认 stretch
  const bindingsSchema = z.object({
    bindings: z.array(
      z.object({
        bindingId: z.string().min(1),
        layerId: z.number().int(),
        layerPath: z.string().min(1),
        type: z.enum(['smartObject', 'text', 'pixel']),
        required: z.boolean().default(true),
        label: z.string().optional(),
        acceptedFormats: z.array(z.string()).optional(),
        fit: z.enum(['cover', 'contain', 'stretch']).default('stretch'),
        maxLength: z.number().int().positive().optional(),
        defaultFontVersionId: z.string().optional(),
      }),
    ),
  });

  app.put('/v1/templates/:id/layer-bindings', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '保存图层绑定配置',
      description: '为模板的每个可替换图层配置绑定（bindingId、类型、是否必填、接受的格式等）。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '模板 ID（tpl_xxx）' },
        },
      },
      body: {
        type: 'object',
        required: ['bindings'],
        properties: {
          bindings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['bindingId', 'layerId', 'layerPath', 'type'],
              properties: {
                bindingId: { type: 'string', description: '业务侧自定义的绑定 ID（如图层别名）' },
                layerId: { type: 'integer', description: 'PSD 图层 ID' },
                layerPath: { type: 'string', description: 'PSD 图层路径' },
                type: { type: 'string', enum: ['smartObject', 'text', 'pixel'], description: '绑定类型允许智能对象、文字和像素图层' },
                required: { type: 'boolean', default: true },
                label: { type: 'string' },
                acceptedFormats: { type: 'array', items: { type: 'string' } },
                fit: { type: 'string', enum: ['cover', 'contain', 'stretch'] },
                maxLength: { type: 'integer', minimum: 1 },
                defaultFontVersionId: { type: 'string' },
              },
            },
          },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          required: ['ok', 'templateId'],
          properties: {
            ok: { type: 'boolean', description: '操作是否成功' },
            templateId: { type: 'string', description: '模板 ID（tpl_xxx）' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        404: { $ref: 'ErrorResponse#', description: '模板不存在' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const templateId = (req.params as any).id as string;
    const parsed = bindingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    // P0 安全修复（严重 S2）：从鉴权上下文取 tenantId
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    await templateService.saveLayerBindings(templateId, parsed.data as LayerSchema, tenantId);
    return reply.send({ ok: true, templateId });
  });

  // 发布模板版本
  app.post('/v1/templates/:id/publish', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '发布模板版本',
      description: '将模板当前版本从 DRAFT 切换为 PUBLISHED，发布后才能提交渲染任务。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '模板 ID（tpl_xxx）' },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          required: ['ok', 'templateId'],
          properties: {
            ok: { type: 'boolean', description: '操作是否成功' },
            templateId: { type: 'string', description: '模板 ID（tpl_xxx）' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        404: { $ref: 'ErrorResponse#', description: '模板不存在' },
        409: { $ref: 'ErrorResponse#', description: '模板版本非 DRAFT 状态，无法发布' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const templateId = (req.params as any).id as string;
    // P0 安全修复（严重 S2）：从鉴权上下文取 tenantId
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    await templateService.publish(templateId, tenantId);
    return reply.send({ ok: true, templateId });
  });

  // 模板列表
  app.get('/v1/templates', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '模板列表',
      description: '获取所有模板（含状态、版本数量）。',
      security: [{ apiKey: [] }],
      response: {
        200: {
          type: 'object',
          required: ['templates'],
          properties: {
            templates: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    // P0 安全修复（严重 S2）：从鉴权上下文取 tenantId，仅列出当前租户的模板
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    const list = await templateService.list(tenantId);
    return reply.send({ templates: list });
  });

  // 模板详情
  app.get('/v1/templates/:id', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '模板详情',
      description: '获取模板详情，含图层树、绑定配置、版本列表。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '模板 ID（tpl_xxx）' },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          description: '模板详情，含图层树、绑定配置、版本列表',
          properties: {
            templateId: { type: 'string' },
            code: { type: 'string' },
            name: { type: 'string' },
            status: { type: 'string', description: 'DRAFT | PUBLISHED | ARCHIVED | DELETED' },
            versions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
            layerSchema: { type: 'object', additionalProperties: true },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        404: { $ref: 'ErrorResponse#', description: '模板不存在' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const templateId = (req.params as any).id as string;
    // P0 安全修复（严重 S2）：从鉴权上下文取 tenantId
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    const detail = await templateService.getDetail(templateId, tenantId);
    if (!detail) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '模板不存在' });
    }
    return reply.send(detail);
  });
}
