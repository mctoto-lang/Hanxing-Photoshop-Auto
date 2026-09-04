/**
 * Admin 写操作路由（第三期 M4）
 *
 * 路由分组：
 *   模板管理：
 *     - POST /admin/api/templates/:id/archive        归档（operator）
 *     - POST /admin/api/templates/:id/unarchive      取消归档（operator）
 *     - POST /admin/api/templates/:id/delete         软删除（admin）
 *     - POST /admin/api/templates/:id/publish        发布（operator）
 *     - PUT  /admin/api/templates/:id/layer-bindings 保存图层绑定（operator，M5）
 *     - GET  /admin/api/templates/:id                详情
 *     - GET  /admin/api/templates                    列表（已存在，仅 viewer）
 *     - POST /admin/api/fonts/upload                 上传字体并立即安装（operator）
 *     - GET  /admin/api/fonts                        列表
 *     - GET  /admin/api/fonts/:id                    详情
 *     - POST /admin/api/fonts/:id/publish            启用（operator）
 *     - POST /admin/api/fonts/:id/unpublish          禁用（operator）
 *     - PUT  /admin/api/fonts/:id/license-note       编辑许可证（operator）
 *     - DELETE /admin/api/fonts/:id                  删除字体（admin）
 *   Worker 管理：
 *     - GET    /admin/api/workers/:id                详情（含硬件画像）
 *     - POST   /admin/api/workers/:id/force-offline  强制下线（operator）
 *     - POST   /admin/api/workers/:id/reapprove      重新批准（operator）
 *     - PUT    /admin/api/workers/:id/custom-code    更新自定义编号（operator）
 *     - DELETE /admin/api/workers/:id                删除节点（operator，需先下线）
 *   任务管理：
 *     - GET  /admin/api/jobs/:code                   详情
 *     - POST /admin/api/jobs/:code/force-cancel      强制取消（operator）
 *     - POST /admin/api/jobs/:code/release-lease     强制释放租约（operator）
 *     - POST /admin/api/jobs/:code/retry             重试 FAILED（operator）
 *     - POST /admin/api/jobs/batch-cancel            批量取消（operator）
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { renderJobService } from '../services/render-job/job-service.js';
import { workerService } from '../services/worker/worker-service.js';
import { bootstrapTokenService } from '../services/worker/bootstrap-token-service.js';
import { fontService } from '../services/font/font-service.js';
import { templateService } from '../services/template/template-service.js';
import { auditService } from '../services/audit/audit-service.js';
import { storageConfigService } from '../services/storage/storage-config-service.js';
import { getStorage, resetStorage } from '../services/storage/index.js';
import { prisma } from '../lib/prisma.js';
import { genArtifactCode } from '../lib/crypto.js';
import { env } from '../config/env.js';
import { hasConfiguredBindings } from '../services/template/template-status.js';

const licenseNoteSchema = z.object({
  licenseNote: z.string().max(500).nullable(),
});

const fontSettingsSchema = z.object({
  fallbackFontVersionId: z.string().min(1).nullable(),
});

const batchCancelSchema = z.object({
  status: z.enum(['QUEUED', 'LEASED', 'PROCESSING', 'CANCELLING']).optional(),
});

const workerDisplayNameSchema = z.object({ displayName: z.string().trim().min(1).max(100).nullable() });
// Worker 自定义编号：1-50 字符，允许字母/数字/下划线/中划线/中文，或 null 清除
const workerCustomCodeSchema = z.object({
  customCode: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/u, '仅支持字母、数字、下划线、中划线、中文').nullable(),
});
const storageSettingsSchema = z.object({
  backend: z.enum(['local', 'cos']), localStorageDir: z.string().max(500).optional(),
  cosBucket: z.string().max(200).optional(), cosRegion: z.string().max(100).optional(),
  cosInternalDomain: z.string().max(500).optional(), cosPresignExpiresSec: z.number().int().min(60).max(604800).optional(),
  manifestUrlExpiresSec: z.number().int().min(60).max(604800).optional(),
  cosSecretId: z.string().max(200).optional(), cosSecretKey: z.string().max(200).optional(),
});
const testRenderSchema = z.object({
  templateVersionId: z.string().min(1), targetWorkerId: z.string().min(1),
  input: z.record(z.string(), z.object({ assetId: z.string().optional(), text: z.string().optional() })),
  output: z.object({ format: z.enum(['png', 'jpeg', 'psd']), quality: z.number().int().min(1).max(100).optional() }),
  jsxTimeoutSeconds: z.number().int().min(60).max(3600).default(600),
});

// M5：图层绑定配置保存 schema（与外部 API 一致）
// 绑定类型允许 smartObject / text / pixel；fit 默认 stretch
const layerBindingItemSchema = z.object({
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
});

const layerBindingsSchema = z.object({
  bindings: z.array(layerBindingItemSchema),
});

export async function adminWriteRoutes(app: FastifyInstance) {
  app.post('/api/templates/upload', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    // PSD 模板文件可达 300MB，路由级覆盖全局 bodyLimit（默认 150MB）
    // 实际限额由 psd-worker assertFileSize + putObject 按前缀兜底
    bodyLimit: env.MAX_PSD_SIZE_MB * 1024 * 1024,
    schema: {
      tags: ['admin-templates'],
      summary: '上传 PSD 模板',
      description: '上传 PSD 文件并触发解析，生成模板与首个版本（DRAFT 状态）。返回模板 ID 与图层树。请求体为原始 PSD 二进制（Content-Type: application/octet-stream）。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        required: ['fileName', 'name'],
        properties: {
          fileName: { type: 'string', description: 'PSD 文件名（仅支持 .psd 扩展名）' },
          name: { type: 'string', maxLength: 100, description: '模板名称' },
          psMinVersion: { type: 'string', description: '可选，最低 PS 版本要求' },
        },
      },
      response: {
        201: {
          type: 'object',
          description: '创建成功，返回模板 ID、版本 ID、画布尺寸与图层树',
          required: ['templateId', 'templateVersionId', 'canvas', 'layerTree'],
          properties: {
            // M1 修复：与 templateService.createFromUpload() 实际返回的 LayerTreeResult 对齐
            //   原错误：声明 version:integer + layerSchema:string，但 service 返回
            //   templateVersionId/canvas/layerTree（layerTree 是数组而非字符串）
            templateId: { type: 'string', description: '模板 ID（tpl_xxx）' },
            templateVersionId: { type: 'string', description: '模板版本 ID（tpv_xxx）' },
            canvas: {
              type: 'object',
              description: 'PSD 画布尺寸',
              properties: {
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
            },
            layerTree: {
              type: 'array',
              description: '解析得到的图层树（递归结构）',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const fileName = String((req.query as any).fileName ?? '');
    const name = String((req.query as any).name ?? '').trim();
    const psMinVersion = String((req.query as any).psMinVersion ?? '').trim() || undefined;
    const body = req.body as Buffer;
    if (!fileName || !name) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '模板名称和 PSD 文件名为必填项' });
    // S-H9：fileName 综合校验——长度、扩展名、路径穿越、字符白名单
    //   原仅校验非空，攻击者可传入 ../../../etc/passwd 或包含特殊字符的文件名，
    //   虽 service 层有 path.basename 兜底，但应在路由层尽早拒绝以失败快速返回并
    //   避免 objectKey 拼接出非预期路径。
    if (name.length > 100) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '模板名称长度不能超过 100 字符' });
    if (fileName.length > 255) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '文件名长度不能超过 255 字符' });
    if (!/\.psd$/i.test(fileName)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '仅支持 .psd 模板文件' });
    // 禁止路径分隔符与目录穿越符（path traversal 防护）
    if (/[\/\\]|\.\./.test(fileName)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '文件名不能包含路径分隔符或目录穿越符' });
    // 字符白名单：允许字母、数字、点、下划线、连字符和中文（与 service 层 sanitize 规则一致）
    if (!/^[a-zA-Z0-9._\u4e00-\u9fa5-]+$/.test(fileName)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '文件名仅支持字母、数字、点、下划线、连字符和中文' });
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'PSD 文件不能为空' });
    try {
      const result = await templateService.createFromUpload({ fileName, name, body, psMinVersion });
      auditService.recordFromReq(req, { action: 'template_upload', refType: 'template', refId: result.templateId, message: `上传并解析模板: ${name}` });
      return reply.code(201).send(result);
    } catch (error: any) { return reply.code(400).send({ error: error.code ?? 'TEMPLATE_UPLOAD_ERROR', message: error.message }); }
  });

  app.get('/api/test/templates', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-tests'],
      summary: '测试用模板列表',
      description: '返回所有租户中已发布且已配置图层绑定的模板版本，用于测试渲染任务的下拉选择。仅返回未软删除模板的已发布版本。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            templates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  templateVersionId: { type: 'string' },
                  templateId: { type: 'string' },
                  name: { type: 'string' },
                  version: { type: 'integer' },
                  layerSchema: { type: 'object', additionalProperties: true },
                },
              },
            },
          },
        },
      },
    },
  }, async (_req, reply) => {
    const versions = await prisma.templateVersion.findMany({
      where: { published: true, template: { status: { not: 'DELETED' } } },
      include: { template: true }, orderBy: { createdAt: 'desc' },
    });
    return reply.send({ templates: versions.filter((v) => hasConfiguredBindings(v.layerSchema)).map((v) => ({ templateVersionId: v.id, templateId: v.templateId, name: v.template.name, version: v.version, layerSchema: JSON.parse(v.layerSchema) })) });
  });

  app.post('/api/test/assets', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-tests'],
      summary: '上传测试资产',
      description: '上传测试用图片资产（PNG/JPG/JPEG/WEBP），写入指定模板版本所属租户。请求体为原始图片二进制。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        required: ['templateVersionId'],
        properties: {
          fileName: { type: 'string', description: '图片文件名（默认 image.png）' },
          templateVersionId: { type: 'string', description: '当前测试模板版本 ID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            assetId: { type: 'string', description: '资产 ID（art_xxx）' },
            originalName: { type: 'string' },
            sizeBytes: { type: 'integer' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const fileName = String((req.query as any).fileName ?? 'image.png');
    const templateVersionId = String((req.query as any).templateVersionId ?? '');
    const mimeType = String(req.headers['content-type'] ?? 'application/octet-stream').split(';')[0];
    // 允许常见图片格式（UI accept=image/png,image/jpeg，但服务端兼容更多类型避免误拒）
    if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(mimeType)) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '仅支持 PNG、JPG、JPEG、WEBP 图片' });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0 || body.length > env.MAX_INPUT_SIZE_MB * 1024 * 1024) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '图片内容为空或超过大小限制' });
    const templateVersion = await prisma.templateVersion.findUnique({
      where: { id: templateVersionId },
      include: { template: true },
    });
    if (!templateVersion || !templateVersion.published || templateVersion.template.status === 'DELETED') {
      return reply.code(400).send({ error: 'TEMPLATE_NOT_PUBLISHED', message: '模板版本不存在或未发布' });
    }
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storage = await getStorage();
    const objectKey = `input/test/${Date.now()}_${safeName}`;
    const meta = await storage.putObject({ objectKey, body, mimeType, contentLength: body.length });
    const artifact = await prisma.artifact.create({ data: { code: genArtifactCode(), kind: 'input', objectKey, sha256: meta.sha256 ?? '', mimeType, sizeBytes: meta.size, originalName: fileName, tenantId: templateVersion.template.tenantId, expiresAt: new Date(Date.now() + env.INPUT_RETENTION_DAYS * 86400 * 1000) } });
    return reply.send({ assetId: artifact.code, originalName: artifact.originalName, sizeBytes: artifact.sizeBytes });
  });

  app.post('/api/test/render-jobs', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-tests'],
      summary: '创建测试渲染任务',
      description: '创建指定 Worker 的测试渲染任务，写入所选模板版本所属租户。priority=1（最高优先级）。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        required: ['templateVersionId', 'targetWorkerId', 'input', 'output'],
        properties: {
          templateVersionId: { type: 'string', description: '已发布的模板版本 ID' },
          targetWorkerId: { type: 'string', description: '指定执行的 Worker ID' },
          input: {
            type: 'object',
            description: '绑定 ID 到输入值的映射',
            additionalProperties: {
              type: 'object',
              properties: {
                assetId: { type: 'string' },
                text: { type: 'string' },
              },
            },
          },
          output: {
            type: 'object',
            properties: {
              format: { type: 'string', enum: ['png', 'jpeg', 'psd'] },
              quality: { type: 'integer', minimum: 1, maximum: 100 },
            },
          },
          // M5 修复：与 zod testRenderSchema 中的 jsxTimeoutSeconds（默认 600）保持一致
          jsxTimeoutSeconds: { type: 'integer', minimum: 60, maximum: 3600, description: '可选，Worker 执行 JSX 脚本的超时秒数（默认 600）' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            jobId: { type: 'string' },
            status: { type: 'string' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = testRenderSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '测试任务参数无效', details: parsed.error.issues });
    try {
      const templateVersion = await prisma.templateVersion.findUnique({
        where: { id: parsed.data.templateVersionId },
        include: { template: true },
      });
      if (!templateVersion || !templateVersion.published || templateVersion.template.status === 'DELETED') {
        return reply.code(400).send({ error: 'TEMPLATE_NOT_PUBLISHED', message: '模板版本不存在或未发布' });
      }
      const tenantId = templateVersion.template.tenantId;
      const result = await renderJobService.create({ ...parsed.data, tenantId, idempotencyKey: `admin-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, priority: 1, traceId: `test-${Date.now().toString(36)}` });
      auditService.recordFromReq(req, { action: 'test_render_job_create', refType: 'render_job', refId: result.job.id, message: `创建指定 Worker 测试任务: ${result.job.code}`, meta: { targetWorkerId: parsed.data.targetWorkerId, templateVersionId: parsed.data.templateVersionId } });
      return reply.code(201).send({ jobId: result.job.code, status: result.job.status });
    } catch (error: any) { return reply.code(400).send({ error: error.code ?? 'TEST_RENDER_ERROR', message: error.message }); }
  });
  app.get('/api/storage-settings', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-storage'],
      summary: '查看存储配置',
      description: '返回当前存储配置（local/cos、桶名、区域、内网域名、预签名有效期等）。不含 COS SecretKey 完整值。审计日志会记录此次查看。',
      security: [{ adminSession: [] }],
      response: {
        200: { type: 'object', additionalProperties: true },
      },
    },
  }, async (req, reply) => {
    // P1-L：审计存储配置查看（含 COS 凭据状态等敏感信息）
    auditService.recordFromReq(req, {
      action: 'storage_settings_view', refType: 'storage', refId: 'default',
      message: '查看存储配置',
    });
    return reply.send(await storageConfigService.getPublic());
  });

  app.put('/api/storage-settings', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-storage'],
      summary: '更新存储配置',
      description: '更新存储配置（backend / local 路径 / COS 桵与凭据等）。保存后立即 reset 并重新初始化存储实例。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        required: ['backend'],
        properties: {
          backend: { type: 'string', enum: ['local', 'cos'], description: '存储后端类型' },
          localStorageDir: { type: 'string', description: 'local 模式存储目录' },
          cosBucket: { type: 'string', description: 'COS 桶名' },
          cosRegion: { type: 'string', description: 'COS 区域' },
          cosInternalDomain: { type: 'string', description: 'COS 内网域名' },
          cosPresignExpiresSec: { type: 'integer', minimum: 60, maximum: 604800, description: '预签名 URL 有效期（秒）' },
          manifestUrlExpiresSec: { type: 'integer', minimum: 60, maximum: 604800, description: '任务下载/上传 URL 有效期（秒），需大于 JSX 执行时间（默认600）' },
          cosSecretId: { type: 'string', description: 'COS SecretId' },
          cosSecretKey: { type: 'string', description: 'COS SecretKey' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = storageSettingsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '存储配置参数无效' });
    try {
      await storageConfigService.save(parsed.data);
      resetStorage();
      await getStorage();
      auditService.recordFromReq(req, { action: 'storage_settings_save', refType: 'storage', refId: 'default', message: `更新存储配置: ${parsed.data.backend}` });
      return reply.send(await storageConfigService.getPublic());
    } catch (error: any) {
      resetStorage();
      return reply.code(400).send({ error: 'STORAGE_CONFIG_ERROR', message: error.message });
    }
  });

  app.post('/api/storage-settings/test', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-storage'],
      summary: '测试存储连接',
      description: '重置存储实例并尝试初始化，验证存储配置是否可用。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (_req, reply) => {
    try { resetStorage(); await getStorage(); return reply.send({ ok: true }); }
    catch (error: any) { return reply.code(400).send({ error: 'STORAGE_CONNECTION_FAILED', message: error.message }); }
  });

  app.put('/api/workers/:id/display-name', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-workers'],
      summary: '更新 Worker 节点名称',
      description: '更新 Worker 的显示名称（displayName），便于 Admin UI 业务识别。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Worker ID' } } },
      body: {
        type: 'object',
        required: ['displayName'],
        properties: {
          displayName: { type: 'string', minLength: 1, maxLength: 100, description: '节点名称（1-100 字符），或 null 清除' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = workerDisplayNameSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '节点名称长度应为 1 至 100 个字符' });
    const id = (req.params as any).id as string;
    try {
      const result = await workerService.updateDisplayName(id, parsed.data.displayName);
      auditService.recordFromReq(req, { action: 'worker_display_name_update', refType: 'worker', refId: id, message: `更新 Worker 节点名称: ${parsed.data.displayName ?? '未命名'}` });
      return reply.send(result);
    } catch { return reply.code(404).send({ error: 'NOT_FOUND', message: 'Worker 不存在' }); }
  });

  // 更新 Worker 自定义编号（customCode）：管理员在控制台手动指定，便于业务识别
  app.put('/api/workers/:id/custom-code', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-workers'],
      summary: '更新 Worker 自定义编号',
      description: '更新 Worker 的自定义编号（customCode），便于业务识别。1-50 字符，支持字母/数字/下划线/中划线/中文，或 null 清除。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Worker ID' } } },
      body: {
        type: 'object',
        required: ['customCode'],
        properties: {
          customCode: { type: 'string', minLength: 1, maxLength: 50, description: '自定义编号（或 null 清除）' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = workerCustomCodeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '自定义编号长度应为 1 至 50 个字符，仅支持字母、数字、下划线、中划线、中文' });
    const id = (req.params as any).id as string;
    try {
      const result = await workerService.updateCustomCode(id, parsed.data.customCode);
      auditService.recordFromReq(req, {
        action: 'worker_custom_code_update', refType: 'worker', refId: id,
        message: `更新 Worker 自定义编号: ${parsed.data.customCode ?? '已清除'}`,
      });
      return reply.send(result);
    } catch (e: any) {
      if (e?.code === 'VALIDATION_ERROR') {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: e.message });
      }
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Worker 不存在' });
    }
  });
  // ============== 模板管理 ==============

  // 模板详情
  app.get('/api/templates/:id', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-templates'],
      summary: '模板详情',
      description: '获取模板详情，含图层树、绑定配置、版本列表。审计日志会记录此次查看。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '模板 ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const detail = await templateService.getDetail(id);
    if (!detail) return reply.code(404).send({ error: 'NOT_FOUND', message: '模板不存在' });
    // P1-L：审计模板详情查看（含图层 schema、PSD 内部结构等业务敏感信息）
    auditService.recordFromReq(req, {
      action: 'template_view', refType: 'template', refId: id,
      message: `查看模板详情: ${id}`,
    });
    return reply.send(detail);
  });

  // 第三期 M8：获取模板缩略图下载 URL（用于 Admin UI 显示）
  app.get('/api/templates/:id/thumbnail-url', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-templates'],
      summary: '获取模板缩略图下载 URL',
      description: '返回当前模板最新版本的缩略图下载地址（本地存储模式含签名 token，有效期 1 小时）。若 DB 中的 thumbnailObjectKey 指向的文件已丢失，会自动清空 DB 引用并返回 404。',
      security: [{ adminSession: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '模板 ID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            downloadUrl: { type: 'string', description: '缩略图下载地址（可直接用于 <img src>）' },
            expiresAt: { type: 'string', format: 'date-time', description: '下载地址过期时间' },
          },
        },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const r = await templateService.getThumbnailDownloadUrl(id);
    if (!r) return reply.code(404).send({ error: 'NOT_FOUND', message: '模板无缩略图' });
    return reply.send(r);
  });

  // 重新生成模板缩略图（operator 及以上）
  // 用于修复历史遗留的缩略图文件丢失问题（DB 有 key 但文件不存在）
  app.post('/api/templates/:id/regenerate-thumbnail', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-templates'],
      summary: '重新生成模板缩略图',
      description: '从已存储的 PSD 文件重新生成缩略图并上传到对象存储，更新 DB 中的 thumbnailObjectKey。用于修复历史遗留的缩略图文件丢失问题。若 PSD 文件也已丢失则返回 400。',
      security: [{ adminSession: [] }],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '模板 ID' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', description: '操作是否成功' },
            thumbnailObjectKey: { type: 'string', description: '新生成的缩略图对象 key' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    try {
      const result = await templateService.regenerateThumbnail(id);
      auditService.recordFromReq(req, {
        action: 'template_thumbnail_regen', refType: 'template', refId: id,
        message: `重新生成模板缩略图: ${id}`,
      });
      return reply.send(result);
    } catch (e: any) {
      return reply.code(400).send({
        error: e?.code ?? 'THUMBNAIL_REGEN_ERROR',
        message: e?.message ?? '缩略图重新生成失败',
      });
    }
  });

  // M5：保存图层绑定配置（operator 及以上）
  app.put('/api/templates/:id/layer-bindings', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-templates'],
      summary: '保存模板图层绑定',
      description: '为模板的每个可替换图层配置绑定（bindingId、类型、是否必填、接受的格式等）。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
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
                bindingId: { type: 'string' },
                layerId: { type: 'integer' },
                layerPath: { type: 'string' },
                type: { type: 'string', enum: ['smartObject', 'text', 'pixel'] },
                required: { type: 'boolean' },
                label: { type: 'string' },
                acceptedFormats: { type: 'array', items: { type: 'string' } },
                fit: { type: 'string', enum: ['cover', 'contain', 'stretch'] },
                maxLength: { type: 'integer' },
                defaultFontVersionId: { type: 'string' },
              },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, templateId: { type: 'string' }, bindingCount: { type: 'integer' } },
        },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const parsed = layerBindingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '图层绑定参数校验失败',
        details: parsed.error.issues,
      });
    }
    try {
      await templateService.saveLayerBindings(id, parsed.data);
      auditService.recordFromReq(req, {
        action: 'template_layer_bindings_save', refType: 'template', refId: id,
        message: `保存模板图层绑定: ${id}（${parsed.data.bindings.length} 项）`,
        meta: { bindingCount: parsed.data.bindings.length },
      });
      return reply.send({ ok: true, templateId: id, bindingCount: parsed.data.bindings.length });
    } catch (e: any) {
      auditService.recordFromReq(req, {
        action: 'template_layer_bindings_save', refType: 'template', refId: id, result: 'failure',
        message: `保存模板图层绑定失败: ${e.message}`,
      });
      const status = e.code === 'VALIDATION_ERROR' ? 400 : 500;
      return reply.code(status).send({
        error: e.code ?? 'INTERNAL_ERROR',
        message: e.message,
      });
    }
  });

  // 发布模板
  app.post('/api/templates/:id/publish', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-templates'],
      summary: '发布模板',
      description: '将模板当前版本从 DRAFT 切换为 PUBLISHED，发布后才能提交渲染任务。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' }, templateId: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    await templateService.publish(id);
    auditService.recordFromReq(req, {
      action: 'template_publish', refType: 'template', refId: id,
      message: `发布模板: ${id}`,
    });
    return reply.send({ ok: true, templateId: id });
  });

  // 归档模板
  app.post('/api/templates/:id/archive', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-templates'],
      summary: '归档模板',
      description: '将模板状态置为 ARCHIVED，归档后不可提交渲染任务但可取消归档。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      // P0 修复：补齐 response schema 并与 templateService.archive 实际返回对齐
      //   archive() 返回 { templateId, status: 'REPUBLISH_REQUIRED' }，而非 { ok, templateId }
      response: {
        200: {
          type: 'object',
          required: ['templateId', 'status'],
          properties: {
            templateId: { type: 'string', description: '模板 ID' },
            status: { type: 'string', description: '归档后模板状态（REPUBLISH_REQUIRED）' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '请求参数错误' },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
        404: { $ref: 'ErrorResponse#', description: '模板不存在' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const result = await templateService.archive(id);
    auditService.recordFromReq(req, {
      action: 'template_archive', refType: 'template', refId: id,
      message: `归档模板: ${id}`,
    });
    return reply.send(result);
  });

  // 取消归档
  app.post('/api/templates/:id/unarchive', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-templates'],
      summary: '取消归档模板',
      description: '将模板从 ARCHIVED 恢复为 DRAFT 或 PUBLISHED。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      // P0 修复：与 templateService.unarchive 实际返回对齐
      //   unarchive() 返回 { templateId, status: 'PUBLISHED' | 'DRAFT' }
      response: {
        200: {
          type: 'object',
          required: ['templateId', 'status'],
          properties: {
            templateId: { type: 'string', description: '模板 ID' },
            status: { type: 'string', description: '恢复后模板状态（PUBLISHED | DRAFT）' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '请求参数错误' },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
        404: { $ref: 'ErrorResponse#', description: '模板不存在' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const result = await templateService.unarchive(id);
    auditService.recordFromReq(req, {
      action: 'template_unarchive', refType: 'template', refId: id,
      message: `取消归档模板: ${id}`,
    });
    return reply.send(result);
  });

  // 软删除（admin 才能彻底删除）
  app.post('/api/templates/:id/delete', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-templates'],
      summary: '软删除模板',
      description: '将模板状态置为 DELETED（软删除）。仅 admin 角色可调用。若有关联任务会保留 PSD 文件直到任务完成。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const result = await templateService.softDelete(id);
    auditService.recordFromReq(req, {
      action: 'template_delete', refType: 'template', refId: id,
      message: `软删除模板: ${id}`,
    });
    return reply.send(result);
  });

  // ============== 字体管理 ==============

  // 字体上传（operator）：Buffer body + query fileName
  // 上传后立即安装到 API 服务器本机，并写入 DB；Worker 通过 manifest 同步安装
  app.post('/api/fonts/upload', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-fonts'],
      summary: '上传字体',
      description: '上传字体文件（OTF/TTF）并立即安装到 API 服务器本机，写入 DB；Worker 通过 manifest 同步安装。请求体为原始字体二进制。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        required: ['fileName'],
        properties: {
          fileName: { type: 'string', description: '字体文件名（含 .otf / .ttf 扩展名）' },
          licenseNote: { type: 'string', maxLength: 500, description: '可选，许可证备注' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            fontId: { type: 'string' },
            familyName: { type: 'string' },
            postscriptName: { type: 'string' },
            installed: { type: 'boolean', description: '是否已安装到系统' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const fileName = String((req.query as any).fileName ?? '');
    const licenseNote = String((req.query as any).licenseNote ?? '').trim() || undefined;
    if (!fileName) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '缺少 fileName 参数' });
    }
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '字体文件内容不能为空' });
    }
    try {
      const result = await fontService.uploadAndRegister({
        fileName,
        buffer: body,
        mimeType: String(req.headers['content-type'] ?? 'font/otf').split(';')[0],
        licenseNote,
      });
      auditService.recordFromReq(req, {
        action: 'font_upload', refType: 'font', refId: result.fontId,
        message: `上传字体: ${result.familyName} (${result.postscriptName})${result.installed ? ' 已安装' : ' 安装失败'}`,
        meta: {
          familyName: result.familyName,
          postscriptName: result.postscriptName,
          installed: result.installed,
        },
      });
      return reply.code(201).send(result);
    } catch (error: any) {
      return reply.code(400).send({
        error: error.code ?? 'FONT_UPLOAD_ERROR',
        message: error.message,
      });
    }
  });

  // 字体列表
  app.get('/api/fonts', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-fonts'],
      summary: '字体列表',
      description: '返回所有已注册的字体（含 familyName、postscriptName、发布状态、许可证备注）。',
      security: [{ adminSession: [] }],
      // P0 修复：与 fontService.list() 实际返回字段对齐。
      //   原错误：required 声明了 id/status/statusLabel/sizeBytes/publishedAt，
      //   但 service 返回 fontId/published(布尔)/无 sizeBytes 与 publishedAt，
      //   导致 fast-json-stringify 序列化时缺失必填字段 → 500 INTERNAL_ERROR。
      response: {
        200: {
          type: 'object',
          required: ['fonts'],
          properties: {
            fonts: {
              type: 'array',
              items: {
                type: 'object',
                required: ['fontId', 'code', 'familyName', 'postscriptName', 'style', 'sha256', 'published', 'licenseNote', 'createdAt'],
                properties: {
                  fontId: { type: 'string', description: '字体版本 ID' },
                  code: { type: 'string', description: '字体编码（fntv_xxx）' },
                  familyName: { type: 'string', description: '字体家族名' },
                  postscriptName: { type: 'string', description: 'PostScript 名称' },
                  style: { type: 'string', description: '字体样式（Regular / Bold 等）' },
                  sha256: { type: 'string', description: '字体文件 SHA-256' },
                  published: { type: 'boolean', description: '是否已发布' },
                  licenseNote: { type: 'string', nullable: true, description: '许可证备注' },
                  createdAt: { type: 'string', format: 'date-time', description: '创建时间' },
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
    const fonts = await fontService.list();
    return reply.send({ fonts });
  });

  // 字体详情
  app.get('/api/fonts/:id', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-fonts'],
      summary: '字体详情',
      description: '返回指定字体的详细信息（含 objectKey、SHA-256、发布状态、许可证备注等）。审计日志会记录此次查看。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '字体 ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const detail = await fontService.getDetail(id);
    if (!detail) return reply.code(404).send({ error: 'NOT_FOUND', message: '字体不存在' });
    // P1-L：审计字体详情查看（含许可证备注、sha256 等元数据）
    auditService.recordFromReq(req, {
      action: 'font_view', refType: 'font', refId: id,
      message: `查看字体详情: ${id}`,
    });
    return reply.send(detail);
  });

  // 启用字体
  app.post('/api/fonts/:id/publish', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-fonts'],
      summary: '发布字体',
      description: '将字体设为已发布（published=true），Worker 下次同步 manifest 时会下载安装。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '字体 ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const result = await fontService.setPublished(id, true);
    auditService.recordFromReq(req, {
      action: 'font_publish', refType: 'font', refId: id,
      message: `启用字体: ${id}`,
    });
    return reply.send(result);
  });

  // 禁用字体
  app.post('/api/fonts/:id/unpublish', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-fonts'],
      summary: '取消发布字体',
      description: '将字体设为未发布（published=false），Worker 下次同步 manifest 时会卸载。已运行中的任务不受影响。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '字体 ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const result = await fontService.setPublished(id, false);
    auditService.recordFromReq(req, {
      action: 'font_unpublish', refType: 'font', refId: id,
      message: `禁用字体: ${id}`,
    });
    return reply.send(result);
  });

  app.get('/api/font-settings', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-fonts'],
      summary: '查看字体全局配置',
      security: [{ adminSession: [] }],
      response: {
        200: { type: 'object', additionalProperties: true },
      },
    },
  }, async (_req, reply) => reply.send(await fontService.getFallbackConfig()));

  app.put('/api/font-settings', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-fonts'],
      summary: '更新字体全局配置',
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        required: ['fallbackFontVersionId'],
        properties: {
          fallbackFontVersionId: { type: 'string', nullable: true },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = fontSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '字体全局配置参数无效' });
    }
    try {
      const result = await fontService.setFallbackFont(parsed.data.fallbackFontVersionId);
      auditService.recordFromReq(req, {
        action: 'font_fallback_update',
        refType: 'font',
        refId: parsed.data.fallbackFontVersionId ?? 'none',
        message: `更新全局兜底字体: ${parsed.data.fallbackFontVersionId ?? '未设置'}`,
      });
      return reply.send(result);
    } catch (error: any) {
      const status = error?.code === 'NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ error: error?.code ?? 'VALIDATION_ERROR', message: error.message });
    }
  });

  // 编辑许可证备注
  app.put('/api/fonts/:id/license-note', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-fonts'],
      summary: '更新字体许可证备注',
      description: '更新字体的许可证备注（licenseNote），用于记录字体授权信息。最大 500 字符。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '字体 ID' } } },
      body: {
        type: 'object',
        required: ['licenseNote'],
        properties: {
          licenseNote: { type: 'string', maxLength: 500, description: '许可证备注（最长 500 字符）' },
        },
      },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const parsed = licenseNoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'licenseNote 不合法（最长 500 字符）',
        details: parsed.error.issues,
      });
    }
    const result = await fontService.updateLicenseNote(id, parsed.data.licenseNote);
    auditService.recordFromReq(req, {
      action: 'font_license_note', refType: 'font', refId: id,
      message: `更新字体许可证备注: ${id}`,
      meta: { licenseNote: parsed.data.licenseNote },
    });
    return reply.send(result);
  });

  // 删除字体（admin）：阻断式——被图层绑定引用时拒绝；同步卸载系统字体 + 清理对象存储
  app.delete('/api/fonts/:id', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-fonts'],
      summary: '删除字体',
      description: '永久删除字体记录、卸载系统字体并清理对象存储文件。若字体被图层绑定引用则拒绝删除。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '字体 ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const result = await fontService.delete(id, operator);
      auditService.recordFromReq(req, {
        action: 'font_delete', refType: 'font', refId: id,
        message: `删除字体: ${result.familyName} (${result.postscriptName})`,
        meta: {
          familyName: result.familyName,
          postscriptName: result.postscriptName,
          storagePurged: result.storagePurged,
          systemUninstalled: result.systemUninstalled,
        },
      });
      return reply.send(result);
    } catch (e: any) {
      const status = e?.code === 'VALIDATION_ERROR' ? 400 : e?.code === 'NOT_FOUND' ? 404 : 500;
      return reply.code(status).send({
        error: e?.code ?? 'INTERNAL_ERROR',
        message: e.message,
      });
    }
  });

  // ============== Worker 管理 ==============

  // Worker 详情
  app.get('/api/workers/:id', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-workers'],
      summary: 'Worker 详情',
      description: '获取 Worker 节点详情，含硬件画像、字体清单、能力标签等运行时信息。审计日志会记录此次查看。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Worker ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const detail = await workerService.getDetail(id);
    if (!detail) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Worker 不存在' });
    // P1-L：审计 Worker 详情查看（含 fontInventory、IP、能力清单等运行时信息）
    auditService.recordFromReq(req, {
      action: 'worker_view', refType: 'worker', refId: id,
      message: `查看 Worker 详情: ${id}`,
    });
    return reply.send(detail);
  });

  // 强制下线
  app.post('/api/workers/:id/force-offline', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-workers'],
      summary: '强制下线 Worker',
      description: '将 Worker 的 sessionActive 置为 false，立即断开其任务领取能力。已领取的任务租约不受影响。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Worker ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    const result = await workerService.forceOffline(id, operator);
    auditService.recordFromReq(req, {
      action: 'worker_force_offline', refType: 'worker', refId: id,
      message: `强制下线 Worker: ${id}`,
    });
    return reply.send(result);
  });

  // 重新批准
  app.post('/api/workers/:id/reapprove', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-workers'],
      summary: '重新批准 Worker',
      description: '将 REJECTED 状态的 Worker 恢复为 APPROVED，允许其重新领取任务。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Worker ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    const result = await workerService.reapprove(id, operator);
    auditService.recordFromReq(req, {
      action: 'worker_reapprove', refType: 'worker', refId: id,
      message: `重新批准 Worker: ${id}`,
    });
    return reply.send(result);
  });

  // 第四期 M9：删除 Worker 节点（管理员操作）
  //   - 拒绝删除在线 Worker（需先 forceOffline）
  //   - 拒绝删除有进行中任务的 Worker
  //   - 历史任务的 workerId 会被置为 null（Prisma SET NULL）
  app.delete('/api/workers/:id', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-workers'],
      summary: '删除 Worker 节点',
      description: '永久删除 Worker 记录。拒绝删除在线 Worker（需先强制下线）或有进行中任务的 Worker。历史任务的 workerId 会被置为 null。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Worker ID' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        400: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const result = await workerService.delete(id, operator);
      auditService.recordFromReq(req, {
        action: 'worker_delete', refType: 'worker', refId: id,
        message: `删除 Worker 节点: ${result.code} (${id})`,
        meta: { code: result.code },
      });
      return reply.send(result);
    } catch (e: any) {
      const status = e?.code === 'VALIDATION_ERROR' ? 400 : e?.code === 'NOT_FOUND' ? 404 : 500;
      return reply.code(status).send({
        error: e?.code ?? 'INTERNAL_ERROR',
        message: e.message,
      });
    }
  });

  // ============== Worker 授权码 ==============

  // 生成授权码（明文仅返回一次）
  app.post('/api/bootstrap-tokens', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-bootstrap-tokens'],
      summary: '生成 Worker 授权码',
      description: '生成一次性授权码和完整 token。明文仅返回一次，请立即复制到 Worker UI。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        properties: {
          note: { type: 'string', maxLength: 200, description: '备注（如"给上海渲染机 A"）' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            pairingCode: { type: 'string', description: '6 位授权码（如 K9F-2X7），Worker UI 输入此码' },
            token: { type: 'string', description: '完整 token（64 字符 hex），备选用，通常无需手动输入' },
            createdBy: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' },
            note: { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (req, reply) => {
    const note = (req.body as any)?.note as string | undefined;
    const createdBy = req.adminUser?.username ?? 'admin';
    const created = await bootstrapTokenService.create({ createdBy, note });
    auditService.recordFromReq(req, {
      action: 'bootstrap_token_create', refType: 'worker', refId: created.id,
      message: `生成 Worker 授权码${note ? `（备注: ${note}）` : ''}`,
    });
    return reply.send(created);
  });

  // 列出授权码
  app.get('/api/bootstrap-tokens', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-bootstrap-tokens'],
      summary: '列出 Worker 授权码',
      description: '列出所有授权码（按创建时间倒序，最多 100 条）。viewer 及以上可调用。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            tokens: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  pairingCode: { type: 'string' },
                  createdBy: { type: 'string' },
                  createdAt: { type: 'string', format: 'date-time' },
                  expiresAt: { type: 'string', format: 'date-time' },
                  usedAt: { type: 'string', format: 'date-time', nullable: true },
                  usedByWorkerId: { type: 'string', nullable: true },
                  revokedAt: { type: 'string', format: 'date-time', nullable: true },
                  note: { type: 'string', nullable: true },
                  status: { type: 'string', enum: ['unused', 'used', 'expired', 'revoked'] },
                },
              },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    const tokens = await bootstrapTokenService.list(100);
    return reply.send({ tokens });
  });

  // 作废授权码
  app.delete('/api/bootstrap-tokens/:id', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-bootstrap-tokens'],
      summary: '作废 Worker 授权码',
      description: '作废未使用的授权码。已使用或已作废的授权码不受影响。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    await bootstrapTokenService.revoke(id);
    auditService.recordFromReq(req, {
      action: 'bootstrap_token_revoke', refType: 'worker', refId: id,
      message: `作废 Worker 授权码: ${id}`,
    });
    return reply.send({ ok: true });
  });

  // 硬删除授权码（仅允许已作废或已过期的令牌）
  app.post('/api/bootstrap-tokens/:id/delete', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-bootstrap-tokens'],
      summary: '删除 Worker 授权码',
      description: '硬删除已作废或已过期的授权码记录。仅 revoked 或 expired 状态可删除。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    try {
      await bootstrapTokenService.delete(id);
      auditService.recordFromReq(req, {
        action: 'bootstrap_token_delete', refType: 'worker', refId: id,
        message: `删除 Worker 授权码: ${id}`,
      });
      return reply.send({ ok: true });
    } catch (e: any) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: e.message });
    }
  });

  // ============== 任务管理 ==============

  // 任务详情
  app.get('/api/jobs/:code', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-jobs'],
      summary: '任务详情',
      description: '获取任务详情（含 input 绑定、错误堆栈、worker 信息等业务敏感数据）。审计日志会记录此次查看。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { code: { type: 'string', description: '任务编码（job_xxx）' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const code = (req.params as any).code as string;
    const detail = await renderJobService.getDetail(code);
    if (!detail) return reply.code(404).send({ error: 'NOT_FOUND', message: '任务不存在' });
    // P1-L：审计任务详情查看（含 input 绑定、错误堆栈、worker 信息等业务敏感数据）
    auditService.recordFromReq(req, {
      action: 'job_view', refType: 'job', refId: code,
      message: `查看任务详情: ${code}`,
    });
    return reply.send(detail);
  });

  // 强制取消
  app.post('/api/jobs/:code/force-cancel', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-jobs'],
      summary: '强制取消任务',
      description: '管理员强制取消任务，绕过租约校验。QUEUED 直接置 CANCELLED；LEASED/PROCESSING 置 CANCELLING。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { code: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: { jobId: { type: 'string' }, status: { type: 'string' }, updated: { type: 'boolean' } },
        },
      },
    },
  }, async (req, reply) => {
    const code = (req.params as any).code as string;
    const operator = req.adminUser?.username ?? 'admin';
    const result = await renderJobService.adminForceCancel(code, operator);
    auditService.recordFromReq(req, {
      action: 'job_force_cancel', refType: 'job', refId: code,
      message: `强制取消任务: ${code}`,
      meta: { updated: result.updated },
    });
    return reply.send(result);
  });

  // 强制释放租约
  app.post('/api/jobs/:code/release-lease', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-jobs'],
      summary: '强制释放任务租约',
      description: '当 Worker 卡死（租约未过期但无心跳）时，强制释放任务租约使其回到 QUEUED 状态可被重新领取。仅对 LEASED/PROCESSING 状态的任务有效。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { code: { type: 'string', description: '任务编码（job_xxx）' } } },
      response: {
        200: { type: 'object', additionalProperties: true },
        409: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const code = (req.params as any).code as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const result = await renderJobService.adminReleaseLease(code, operator);
      auditService.recordFromReq(req, {
        action: 'job_release_lease', refType: 'job', refId: code,
        message: `释放任务租约: ${code}`,
      });
      return reply.send(result);
    } catch (e: any) {
      auditService.recordFromReq(req, {
        action: 'job_release_lease', refType: 'job', refId: code, result: 'failure',
        message: `释放任务租约失败: ${e.message}`,
      });
      return reply.code(409).send({
        error: 'JOB_ALREADY_TERMINATED',
        message: e.message,
      });
    }
  });

  // 重试 FAILED 任务
  app.post('/api/jobs/:code/retry', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-jobs'],
      summary: '重试失败任务',
      description: '将 FAILED 状态的任务重置为 QUEUED 重新入队，attempt +1。超过 MAX_ATTEMPTS 时返回 409。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { code: { type: 'string' } } },
      response: {
        200: {
          type: 'object',
          properties: { jobId: { type: 'string' }, status: { type: 'string' }, attempt: { type: 'integer' } },
        },
        409: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const code = (req.params as any).code as string;
    const operator = req.adminUser?.username ?? 'admin';
    try {
      const result = await renderJobService.adminRetry(code, operator);
      auditService.recordFromReq(req, {
        action: 'job_retry', refType: 'job', refId: code,
        message: `重试任务: ${code}`,
        meta: { attempt: result.attempt },
      });
      return reply.send(result);
    } catch (e: any) {
      const status = e.code === 'VALIDATION_ERROR' ? 400 : 409;
      auditService.recordFromReq(req, {
        action: 'job_retry', refType: 'job', refId: code, result: 'failure',
        message: `重试任务失败: ${e.message}`,
      });
      return reply.code(status).send({
        error: e.code ?? 'INTERNAL_ERROR',
        message: e.message,
      });
    }
  });

  // 批量取消
  app.post('/api/jobs/batch-cancel', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-jobs'],
      summary: '批量取消任务',
      // P0 修复：移除 body schema 中强制 type: 'object' 的声明。
      //   handler 使用 req.body ?? {} 兼容空 body（无 body 时取消全部活跃任务），
      //   但 OpenAPI body schema 声明 type:'object' 会让 Fastify 在 body 缺失时
      //   抛出 "body must be object" 校验错误（400）。改为不声明 body schema，
      //   与 batch-delete 保持一致，由 handler 内 zod（batchCancelSchema）兜底校验。
      description: '按状态批量取消任务（默认取消所有活跃任务：QUEUED/LEASED/PROCESSING/CANCELLING）。请求体可选，传 { "status": "QUEUED" } 仅取消指定状态的任务。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: { cancelled: { type: 'integer', description: '实际取消的任务数' } },
        },
      },
    },
  }, async (req, reply) => {
    const parsed = batchCancelSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'status 参数不合法',
        details: parsed.error.issues,
      });
    }
    const operator = req.adminUser?.username ?? 'admin';
    const result = await renderJobService.adminBatchCancel(
      { status: parsed.data.status },
      operator,
    );
    auditService.recordFromReq(req, {
      action: 'job_batch_cancel', refType: 'job',
      message: `批量取消任务（${parsed.data.status ?? 'all-active'}）`,
      meta: { cancelled: result.cancelled, filter: parsed.data.status },
    });
    return reply.send(result);
  });

  // 批量删除已完成的任务（SUCCEEDED/FAILED/CANCELLED）及其关联数据
  app.post('/api/jobs/batch-delete', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-jobs'],
      summary: '批量删除已完成任务',
      description: '删除所有已完成（SUCCEEDED/FAILED/CANCELLED）的任务记录，同时清理关联的心跳记录（输入素材可多任务共享，不随任务删除，由过期清理器按保留期回收）。进行中的任务不受影响。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: { deleted: { type: 'integer', description: '实际删除的任务数' } },
        },
      },
    },
  }, async (req, reply) => {
    // 仅删除已完成的任务，不删除活跃任务（QUEUED/LEASED/PROCESSING/CANCELLING）
    const finishedStatuses = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
    const jobs = await prisma.renderJob.findMany({
      where: { status: { in: finishedStatuses } },
      select: { id: true },
    });
    const jobIds = jobs.map((j) => j.id);
    let deleted = 0;
    if (jobIds.length > 0) {
      // 事务：先删关联数据，再删任务。
      // 输入素材（Artifact）不随任务删除：素材允许多任务共享，且可能仍被
      // 在途任务引用；统一由过期清理器（startArtifactReaper）按 expiresAt 回收
      const result = await prisma.$transaction([
        prisma.jobHeartbeat.deleteMany({ where: { jobId: { in: jobIds } } }),
        prisma.renderJob.deleteMany({ where: { id: { in: jobIds } } }),
      ]);
      deleted = result[1].count;
    }
    auditService.recordFromReq(req, {
      action: 'job_batch_delete', refType: 'job',
      message: `批量删除已完成任务（${deleted} 条）`,
      meta: { deleted },
    });
    return reply.send({ deleted });
  });

  // 批量清除告警日志
  app.post('/api/alerts/batch-clear', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-alerts'],
      summary: '批量清除告警日志',
      description: '删除所有告警记录。ACTIVE 状态的告警也会被删除。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: { deleted: { type: 'integer', description: '实际删除的告警数' } },
        },
      },
    },
  }, async (req, reply) => {
    const result = await prisma.alertEvent.deleteMany({});
    auditService.recordFromReq(req, {
      action: 'alert_batch_clear', refType: 'alert',
      message: `批量清除告警日志（${result.count} 条）`,
      meta: { deleted: result.count },
    });
    return reply.send({ deleted: result.count });
  });
}
