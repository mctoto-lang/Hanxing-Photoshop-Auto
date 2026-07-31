/**
 * Worker 内部接口 - 字体清单
 *
 * GET /internal/fonts/manifest  获取全量字体清单（供空闲同步使用）
 * GET /internal/fonts           字体列表（供 Admin UI）
 */
import { FastifyInstance } from 'fastify';
import { fontService } from '../../services/font/font-service.js';

export async function fontInternalRoutes(app: FastifyInstance) {
  // 全量字体清单（Worker 同步用）
  app.get('/internal/fonts/manifest', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-fonts'],
      summary: '全量字体清单',
      description: '返回所有已发布字体的清单（含下载地址、SHA-256、PostScript 名），供 Worker 启动时同步安装。',
      security: [{ workerToken: [] }],
      response: {
        200: {
          type: 'object',
          required: ['fonts'],
          properties: {
            fonts: {
              type: 'array',
              description: '已发布字体清单',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  code: { type: 'string' },
                  postscriptName: { type: 'string' },
                  familyName: { type: 'string' },
                  style: { type: 'string' },
                  sha256: { type: 'string' },
                  downloadUrl: { type: 'string' },
                  sizeBytes: { type: 'integer' },
                  status: { type: 'string', description: 'PUBLISHED | UNPUBLISHED' },
                },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效' },
        500: { $ref: 'ErrorResponse#', description: '服务器内部错误' },
      },
    },
  }, async (_req, reply) => {
    const manifest = await fontService.getManifest();
    return reply.send(manifest);
  });

  // 字体列表（P1-11 修复：Admin UI 用，需 Admin 鉴权，原 POC 无鉴权会泄露字体元数据）
  app.get('/internal/fonts', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['internal-fonts'],
      summary: '字体列表（Admin）',
      description: '返回所有已注册字体。需 Admin 鉴权。与 /admin/api/fonts 等价，保留此路径供内部调用。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          required: ['fonts'],
          properties: {
            fonts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'Admin 未登录' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
      },
    },
  }, async (_req, reply) => {
    const list = await fontService.list();
    return reply.send({ fonts: list });
  });

  // 字体上传地址（Admin UI 用）
  // S-H8：原误用 authenticateWorker，但 Worker 不调用此端点（Worker 仅拉取 manifest），
  //   字体上传是 Admin 运营操作，应与 /admin/api/fonts/upload 一致使用 Admin 鉴权 +
  //   operator 角色守卫。Worker auth 会让持有 Worker 令牌的节点绕过 Admin 权限体系上传字体。
  app.post('/internal/fonts/upload-url', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['internal-fonts'],
      summary: '获取字体上传地址（Admin）',
      description: '获取字体文件预签名上传地址与 objectKey。operator 及以上可调用。与 /admin/api/fonts/upload 配合使用（后者直接上传二进制并立即安装）。',
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        required: ['fileName'],
        properties: {
          fileName: { type: 'string', description: '字体文件名（含 .otf / .ttf 扩展名）' },
          mimeType: { type: 'string', description: '可选，默认 font/otf' },
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
        400: { $ref: 'ErrorResponse#', description: '缺少 fileName' },
        401: { $ref: 'ErrorResponse#', description: 'Admin 未登录' },
        403: { $ref: 'ErrorResponse#', description: '非 operator 角色' },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as any;
    if (!body.fileName) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '缺少 fileName' });
    }
    const result = await fontService.getUploadUrl({
      fileName: body.fileName,
      mimeType: body.mimeType,
    });
    return reply.send(result);
  });

  // 注册字体元数据
  app.post('/internal/fonts', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-fonts'],
      summary: '注册字体元数据',
      description: 'Worker 上传字体文件后调用此接口注册元数据（familyName / postscriptName / sha256 等）。需 Worker 令牌鉴权。',
      security: [{ workerToken: [] }],
      body: {
        type: 'object',
        required: ['objectKey', 'postscriptName', 'familyName'],
        properties: {
          objectKey: { type: 'string', description: '字体文件存储对象 key' },
          postscriptName: { type: 'string', description: '字体 PostScript 名称' },
          familyName: { type: 'string', description: '字体家族名' },
          style: { type: 'string', description: '可选，字体样式（Regular / Bold / Italic 等）' },
          sha256: { type: 'string', description: '可选，字体文件 SHA-256' },
          licenseNote: { type: 'string', description: '可选，许可证备注' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['fontId', 'code'],
          properties: {
            fontId: { type: 'string', description: '字体 ID' },
            code: { type: 'string', description: '字体编码' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '缺少 objectKey/postscriptName/familyName' },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效' },
      },
    },
  }, async (req, reply) => {
    const body = (req.body ?? {}) as any;
    if (!body.objectKey || !body.postscriptName || !body.familyName) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '缺少 objectKey/postscriptName/familyName',
      });
    }
    const font = await fontService.register({
      objectKey: body.objectKey,
      familyName: body.familyName,
      postscriptName: body.postscriptName,
      style: body.style,
      sha256: body.sha256,
      licenseNote: body.licenseNote,
    });
    return reply.send({ fontId: font.id, code: font.code });
  });
}
