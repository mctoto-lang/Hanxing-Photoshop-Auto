/**
 * 外部 API - 字体管理（全局共享字体库）
 *
 * GET  /v1/fonts                已发布字体列表（文字绑定选择 defaultFontVersionId 用）
 * POST /v1/fonts/upload?fileName=xxx  上传字体（原始二进制 body）
 *
 * 字体为全局库（不按租户隔离，多企业共用实例时共享）；上传后自动发布
 * （FONT_LICENSE_REQUIRED 开启时见 fontService.register 的许可证逻辑）。
 * 格式仅 .ttf/.otf/.ttc，单文件 ≤50MB（fontService 校验）。
 */
import { FastifyInstance } from 'fastify';
import { prisma } from '../../lib/prisma.js';
import { fontService } from '../../services/font/font-service.js';

export async function fontRoutes(app: FastifyInstance) {
  // 字体列表（仅已发布：渲染任务只下发已发布字体，未发布的不允许绑定）
  app.get('/v1/fonts', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['fonts'],
      summary: '字体列表',
      description: '返回全局字体库中所有已发布字体。字体不按租户隔离（多企业共享），用于文字图层绑定选择 defaultFontVersionId。',
      security: [{ apiKey: [] }],
      response: {
        200: {
          type: 'object',
          required: ['fonts'],
          properties: {
            fonts: {
              type: 'array',
              items: {
                type: 'object',
                required: ['fontId', 'familyName', 'postscriptName', 'style', 'createdAt'],
                properties: {
                  fontId: { type: 'string', description: '字体版本 ID（绑定 defaultFontVersionId 用）' },
                  familyName: { type: 'string', description: '字体家族名' },
                  postscriptName: { type: 'string', description: 'PostScript 名称' },
                  style: { type: 'string', description: '字体样式（Regular / Bold 等）' },
                  createdAt: { type: 'string', format: 'date-time', description: '上传时间' },
                },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#' },
        429: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (_req, reply) => {
    const fonts = await prisma.fontVersion.findMany({
      where: { published: true },
      orderBy: [{ familyName: 'asc' }, { style: 'asc' }],
      select: {
        id: true,
        familyName: true,
        postscriptName: true,
        style: true,
        createdAt: true,
      },
    });
    return reply.send({
      fonts: fonts.map((f) => ({
        fontId: f.id,
        familyName: f.familyName,
        postscriptName: f.postscriptName,
        style: f.style,
        createdAt: f.createdAt,
      })),
    });
  });

  // 上传字体（原始二进制 body；fileName 走 query）
  app.post('/v1/fonts/upload', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['fonts'],
      summary: '上传字体',
      description:
        '上传字体文件并注册到全局字体库（立即安装到 API 服务器本机，Worker 经 manifest 同步）。' +
        '请求体为原始字体二进制。仅支持 .ttf / .otf / .ttc，单文件 ≤50MB。上传后自动发布，可用于文字图层绑定。',
      security: [{ apiKey: [] }],
      querystring: {
        type: 'object',
        required: ['fileName'],
        properties: {
          fileName: { type: 'string', description: '字体文件名（含 .otf / .ttf / .ttc 扩展名）' },
        },
      },
      response: {
        201: {
          type: 'object',
          required: ['fontId', 'familyName', 'postscriptName', 'style', 'published', 'installed'],
          properties: {
            fontId: { type: 'string', description: '字体版本 ID' },
            familyName: { type: 'string' },
            postscriptName: { type: 'string' },
            style: { type: 'string' },
            published: { type: 'boolean', description: '是否已发布' },
            installed: { type: 'boolean', description: '是否已安装到 API 服务器系统' },
            installMessage: { type: 'string', description: '安装失败原因（installed=false 时）' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '格式不支持 / 超过 50MB / 字体解析失败' },
        401: { $ref: 'ErrorResponse#' },
        403: { $ref: 'ErrorResponse#' },
        429: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const fileName = String((req.query as any).fileName ?? '');
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
      });
      return reply.code(201).send(result);
    } catch (error: any) {
      return reply.code(400).send({
        error: error.code ?? 'FONT_UPLOAD_ERROR',
        message: error.message,
      });
    }
  });
}
