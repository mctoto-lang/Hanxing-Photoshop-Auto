/**
 * 外部 API - 模板管理
 *
 * POST /v1/templates/upload-url    获取 PSD 文件上传地址
 * POST /v1/templates               触发 PSD 解析，返回图层树
 * PUT  /v1/templates/:id/layer-bindings  保存图层绑定配置
 * POST /v1/templates/:id/publish   发布模板版本
 * POST /v1/templates/:id/delete    删除模板（软删除；已发布自动先归档）
 * GET  /v1/templates               模板列表
 * GET  /v1/templates/:id           模板详情（含图层树、绑定）
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  templateService,
  templateViewerFrom,
} from '../../services/template/template-service.js';
import { getStorage } from '../../services/storage/index.js';
import { env } from '../../config/env.js';
import type { LayerSchema } from '../../types/index.js';

/**
 * 缩略图字节级 LRU 缓存（模块级，进程内共享）
 *
 * 缩略图按版本生成（objectKey 内含版本号，不可变），缓存无失效问题；
 * regenerate-thumbnail 会产生新 objectKey，旧条目自然被淘汰。
 * 网页端每个模板一格高频拉取，命中后免存储层（COS/磁盘）回源。
 */
const THUMB_CACHE_MAX_ENTRIES = 100;
const THUMB_CACHE_MAX_BYTES = 50 * 1024 * 1024;
const thumbCache = new Map<string, { buf: Buffer; mime: string; bytes: number }>();
let thumbCacheBytes = 0;

function thumbCacheGet(objectKey: string) {
  const hit = thumbCache.get(objectKey);
  if (!hit) return undefined;
  // Map 迭代顺序按插入时间：删掉重插实现 LRU 新鲜度
  thumbCache.delete(objectKey);
  thumbCache.set(objectKey, hit);
  return hit;
}

function thumbCacheSet(objectKey: string, value: { buf: Buffer; mime: string }) {
  if (thumbCache.has(objectKey)) return;
  thumbCache.set(objectKey, { ...value, bytes: value.buf.length });
  thumbCacheBytes += value.buf.length;
  while (
    (thumbCache.size > THUMB_CACHE_MAX_ENTRIES || thumbCacheBytes > THUMB_CACHE_MAX_BYTES) &&
    thumbCache.size > 0
  ) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = thumbCache.get(oldest);
    thumbCache.delete(oldest);
    if (evicted) thumbCacheBytes -= evicted.bytes;
  }
}

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
          // 可选：声明文件大小（字节），超限直接 400，避免客户端传完才在存储层报错
          sizeBytes: { type: 'integer', format: 'int64', minimum: 1, maximum: env.MAX_PSD_SIZE_MB * 1024 * 1024, description: `可选，文件大小（字节，上限 ${env.MAX_PSD_SIZE_MB}MB）` },
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
    // P2-36 修复：使用 zod 严格校验 fileName（长度、字符集），防止路径遍历
    const uploadUrlSchema = z.object({
      fileName: z.string().min(1).max(255).regex(/^[^<>:"|?*\\/\u0000]+$/, '文件名含非法字符'),
      mimeType: z.string().optional(),
      sizeBytes: z.number().int().positive().max(300 * 1024 * 1024).optional(),
    });
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '参数校验失败', details: parsed.error.issues });
    }
    const { fileName, mimeType, sizeBytes } = parsed.data;
    const result = await templateService.getUploadUrl({
      fileName,
      mimeType,
      tenantId: req.user?.tenantId,
    });
    return reply.send(result);
  });

  // 触发 PSD 解析
  const createSchema = z.object({
    objectKey: z.string().min(1),
    name: z.string().min(1),
    psMinVersion: z.string().optional(),
    visibility: z.enum(['public', 'private']).optional(),
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
          visibility: { type: 'string', enum: ['public', 'private'], description: '可见性：public=企业内可见（默认）/ private=仅归属人、企业管理员、平台超管' },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      // C2 修复：与 templateService.createFromPsd() 实际返回的 LayerTreeResult 对齐
      //   原错误：声明 version/layerSchema 字段，但 service 返回 templateVersionId/canvas/layerTree
      response: {
        200: {
          type: 'object',
          description: '创建成功，返回模板 ID、版本 ID、画布尺寸与图层树',
          required: ['templateId', 'templateVersionId', 'canvas', 'layerTree'],
          properties: {
            templateId: { type: 'string', description: '模板 ID（tpl_xxx）' },
            templateVersionId: { type: 'string', description: '模板版本 ID（tpv_xxx），后续提交渲染任务时使用' },
            canvas: {
              type: 'object',
              description: 'PSD 画布尺寸',
              properties: {
                width: { type: 'integer', description: '画布宽度（像素）' },
                height: { type: 'integer', description: '画布高度（像素）' },
              },
            },
            layerTree: {
              type: 'array',
              description: '解析得到的图层树（递归结构，每个节点含 layerId/layerPath/name/type/bounds/visible/children 等）',
              items: { type: 'object', additionalProperties: true },
            },
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
    const result = await templateService.createFromPsd({
      ...parsed.data,
      tenantId,
      ownerUserId: req.user?.userId,
      visibility: parsed.data.visibility,
    });
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
    await templateService.saveLayerBindings(
      templateId,
      parsed.data as LayerSchema,
      tenantId,
      templateViewerFrom(req.user),
    );
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
    await templateService.publish(templateId, tenantId, templateViewerFrom(req.user));
    return reply.send({ ok: true, templateId });
  });

  // 模板列表
  app.get('/v1/templates', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '模板列表',
      description: '获取当前租户下所有未软删除的模板（含状态、最新版本号、发布标志、缩略图 key）。',
      security: [{ apiKey: [] }],
      response: {
        200: {
          type: 'object',
          required: ['templates'],
          properties: {
            templates: {
              type: 'array',
              items: {
                type: 'object',
                required: ['templateId', 'code', 'name', 'status', 'statusLabel', 'latestVersion', 'published', 'thumbnailObjectKey', 'thumbnailUrl', 'createdAt'],
                properties: {
                  templateId: { type: 'string', description: '模板 ID（tpl_xxx）' },
                  code: { type: 'string', description: '模板编码' },
                  name: { type: 'string', description: '模板名称' },
                  status: { type: 'string', description: '模板状态' },
                  statusLabel: { type: 'string', description: '状态中文标签' },
                  latestVersion: { type: 'integer', description: '最新版本号（从 1 起，无版本时为 0）' },
                  published: { type: 'boolean', description: '最新版本是否已发布' },
                  thumbnailObjectKey: { type: 'string', nullable: true, description: '缩略图对象 key（无缩略图时为 null）' },
                  thumbnailUrl: { type: 'string', nullable: true, description: '缩略图预签名直链（浏览器 <img> 直接加载，默认 1 小时有效；local 模式为相对地址 /storage/thumb?...，由调用方拼接自身基址；无缩略图或签名失败时为 null，调用方可回退 GET /v1/templates/:id/thumbnail 鉴权代理）' },
                  ownerUserId: { type: 'string', nullable: true, description: '归属用户（X-User-Id 透传；null=平台共享）' },
                  visibility: { type: 'string', enum: ['public', 'private'], description: '可见性：public=企业内 / private=仅归属人、企业管理员、平台超管' },
                  createdAt: { type: 'string', format: 'date-time', description: '模板创建时间' },
                },
              },
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
    const list = await templateService.list(tenantId, templateViewerFrom(req.user));
    return reply.send({ templates: list });
  });

  // 模板详情
  app.get('/v1/templates/:id', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '模板详情',
      description: '获取模板详情，含最新版本的图层树、绑定配置、画布尺寸与缩略图。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '模板 ID（tpl_xxx）' },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      // C3 修复：与 templateService.getDetail() 实际返回对齐
      //   原错误：声明 versions:array + 顶层 layerSchema，但 service 返回 latestVersion:object|null
      //   且 layerSchema 嵌套在 latestVersion 内部，并非版本列表
      response: {
        200: {
          type: 'object',
          description: '模板详情，含最新版本的图层树、绑定配置、画布尺寸与缩略图',
          required: ['templateId', 'code', 'name', 'status', 'latestVersion'],
          properties: {
            templateId: { type: 'string', description: '模板 ID（tpl_xxx）' },
            code: { type: 'string', description: '模板编码' },
            name: { type: 'string', description: '模板名称' },
            status: { type: 'string', description: '模板状态（DRAFT / PUBLISHED / REPUBLISH_REQUIRED / ARCHIVED / DELETED 等）' },
            ownerUserId: { type: 'string', nullable: true, description: '归属用户（null=平台共享）' },
            visibility: { type: 'string', enum: ['public', 'private'], description: '可见性' },
            latestVersion: {
              type: 'object',
              nullable: true,
              description: '最新版本详情；模板刚创建无版本时为 null',
              properties: {
                versionId: { type: 'string', description: '模板版本 ID（tpv_xxx）' },
                version: { type: 'integer', description: '版本号（从 1 起）' },
                published: { type: 'boolean', description: '该版本是否已发布' },
                canvas: {
                  type: 'object',
                  description: '画布尺寸',
                  properties: {
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                  },
                },
                psMinVersion: { type: 'string', description: '最低 PS 版本要求' },
                layerTree: {
                  type: 'array',
                  description: '图层树（递归结构）',
                  items: { type: 'object', additionalProperties: true },
                },
                layerSchema: {
                  type: 'object',
                  additionalProperties: true,
                  description: '图层绑定配置（含 bindings 数组）',
                },
                thumbnailObjectKey: { type: 'string', nullable: true, description: '缩略图对象 key（无缩略图时为 null）' },
                createdAt: { type: 'string', format: 'date-time', description: '版本创建时间' },
              },
            },
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
    const detail = await templateService.getDetail(templateId, tenantId, templateViewerFrom(req.user));
    if (!detail) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '模板不存在或无权访问' });
    }
    return reply.send(detail);
  });

  // 模板缩略图（供外部调用方（如瀚星 Super Image 网页端）展示模板预览）
  // Bearer API Key 鉴权，返回最新版本的缩略图二进制；无缩略图 404（调用方降级占位）
  app.get('/v1/templates/:id/thumbnail', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '获取模板缩略图',
      description: '返回模板最新版本缩略图的二进制流（image/png 或 image/jpeg）。模板无缩略图或不存在时返回 404，调用方应降级为占位展示。支持 ETag/If-None-Match 协商缓存（304）。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: '模板 ID（tpl_xxx）' },
        },
      },
      response: {
        200: {
          type: 'string',
          format: 'binary',
          description: '缩略图二进制流',
        },
        304: { type: 'string', description: 'If-None-Match 命中，缩略图未变化' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        404: { $ref: 'ErrorResponse#', description: '模板不存在或无缩略图' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const templateId = (req.params as any).id as string;
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    // 轻量查询：只取最新版本的 objectKey（getDetail 会拉全部版本的
    // layerTree/layerSchema 大 JSON，缩略图高频端点承担不起）
    const meta = await templateService.getThumbnailMeta(templateId, tenantId, templateViewerFrom(req.user));
    if (!meta) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '模板不存在或无缩略图' });
    }
    const mime = /\.(jpe?g)$/i.test(meta.objectKey) ? 'image/jpeg' : 'image/png';
    // ETag 取自 objectKey（内含版本号，按版本不可变）→ 协商缓存 304
    const etag = `"${meta.objectKey}"`;
    reply.header('ETag', etag);
    reply.header('Cache-Control', 'private, max-age=600');
    if (req.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }
    const cached = thumbCacheGet(meta.objectKey);
    if (cached) {
      reply.header('Content-Type', cached.mime);
      return reply.send(cached.buf);
    }
    const storage = await getStorage();
    let buf: Buffer;
    try {
      buf = await storage.getObject(meta.objectKey);
    } catch {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '缩略图对象不存在' });
    }
    thumbCacheSet(meta.objectKey, { buf, mime });
    reply.header('Content-Type', mime);
    return reply.send(buf);
  });

  // 重新生成缩略图（解析时未生成成功的情况下由外部调用方手动补生成）
  app.post('/v1/templates/:id/regenerate-thumbnail', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '重新生成模板缩略图',
      description: '基于最新版本的 PSD 重新生成缩略图。私有模板仅归属人/企业管理员可调用（X-User-Id / X-User-Admin）。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: '模板 ID' } },
      },
      response: {
        200: {
          type: 'object',
          required: ['ok', 'thumbnailObjectKey'],
          properties: {
            ok: { type: 'boolean' },
            thumbnailObjectKey: { type: 'string' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#' },
        403: { $ref: 'ErrorResponse#', description: '非公开模板无权操作' },
        404: { $ref: 'ErrorResponse#' },
        429: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const templateId = (req.params as any).id as string;
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    const result = await templateService.regenerateThumbnail(
      templateId,
      tenantId,
      templateViewerFrom(req.user),
    );
    return reply.send(result);
  });

  // 删除模板（软删除；已发布自动先归档，单次调用完成）
  app.post('/v1/templates/:id/delete', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '删除模板',
      description:
        '软删除模板（状态置为 DELETED，列表不再显示）。仅模板归属人（X-User-Id）或企业管理员（X-User-Admin）可删除，无论公开/私有。' +
        '已发布（PUBLISHED）模板自动先归档再删除。无关联渲染任务时同步清理存储中的 PSD 与缩略图文件，否则保留给在途任务，由后台清理器善后。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: '模板 ID（tpl_xxx）' } },
      },
      response: {
        200: {
          type: 'object',
          required: ['templateId', 'status', 'storagePurged'],
          properties: {
            templateId: { type: 'string' },
            status: { type: 'string', description: '固定为 DELETED' },
            storagePurged: {
              type: 'boolean',
              description: '是否已同步清理存储文件（false=有关联任务，文件延后清理）',
            },
          },
        },
        401: { $ref: 'ErrorResponse#' },
        403: { $ref: 'ErrorResponse#', description: '非归属人且非企业管理员' },
        404: { $ref: 'ErrorResponse#' },
        429: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const templateId = (req.params as any).id as string;
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    const result = await templateService.deleteForTenant(
      templateId,
      tenantId,
      templateViewerFrom(req.user),
    );
    return reply.send(result);
  });

  // 修改模板可见性
  app.post('/v1/templates/:id/visibility', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['templates'],
      summary: '修改模板可见性',
      description:
        '修改模板可见性：public=企业内可见可渲染 / private=仅归属人、企业管理员可见。' +
        '仅模板归属人（X-User-Id）或企业管理员（X-User-Admin）可修改。',
      security: [{ apiKey: [] }],
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', description: '模板 ID' } },
      },
      body: {
        type: 'object',
        required: ['visibility'],
        properties: {
          visibility: { type: 'string', enum: ['public', 'private'] },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['templateId', 'visibility'],
          properties: {
            templateId: { type: 'string' },
            visibility: { type: 'string', enum: ['public', 'private'] },
          },
        },
        401: { $ref: 'ErrorResponse#' },
        403: { $ref: 'ErrorResponse#', description: '非归属人且非企业管理员' },
        404: { $ref: 'ErrorResponse#' },
        429: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const templateId = (req.params as any).id as string;
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    const body = (req.body ?? {}) as { visibility?: string };
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'visibility 仅支持 public / private' });
    }
    const result = await templateService.updateVisibilityForTenant(
      templateId,
      tenantId,
      body.visibility,
      templateViewerFrom(req.user),
    );
    return reply.send(result);
  });
}
