/**
 * 外部 API - 资产上传
 * POST /v1/assets/upload-url
 *   获取输入文件 COS 预签名上传地址，返回 assetId
 *
 * 输入限制：JPG / PNG / JPEG，单张 ≤ env.MAX_INPUT_SIZE_MB，累计 ≤ env.MAX_INPUT_SIZE_MB，输入保留 env.INPUT_RETENTION_DAYS 天
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getStorage } from '../../services/storage/index.js';
import { prisma } from '../../lib/prisma.js';
import { genArtifactCode } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { sha256 } from '../../lib/crypto.js';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
]);

const bodySchema = z.object({
  // P2-5：fileName 限制长度 ≤ 255，且仅允许安全字符集（字母/数字/点/下划线/连字符）
  // 防止路径遍历攻击（如 ../etc/passwd）和特殊字符导致的存储路径异常
  fileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._\-]+$/, '文件名仅允许字母、数字、点、下划线、连字符'),
  mimeType: z.string().max(128).optional(),
  // 单张图片声明大小上限与存储层 putObject 保持同源（env.MAX_INPUT_SIZE_MB），
  //   避免路由层允许 500MB 但存储层实际只允许 150MB 造成客户端浪费带宽
  sizeBytes: z.number().int().positive().max(env.MAX_INPUT_SIZE_MB * 1024 * 1024).optional(),
});

export async function assetsRoutes(app: FastifyInstance) {
  app.post('/v1/assets/upload-url', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['assets'],
      summary: '获取资产上传地址',
      description: `获取输入文件预签名上传地址与 assetId。仅支持 JPG/PNG/JPEG，累计 ≤${env.MAX_INPUT_SIZE_MB}MB，输入保留 ${env.INPUT_RETENTION_DAYS} 天。`,
      security: [{ apiKey: [] }],
      body: {
        type: 'object',
        required: ['fileName'],
        properties: {
          // P0 修复（严重1）：OpenAPI body schema 与 zod 保持一致——补齐 maxLength / 正则 / maximum
          fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[a-zA-Z0-9._\\-]+$', description: '原始文件名（含扩展名，仅允许字母/数字/点/下划线/连字符，≤255 字符）' },
          mimeType: { type: 'string', maxLength: 128, description: '可选，未提供则按扩展名推断（image/jpeg / image/png），≤128 字符' },
          sizeBytes: { type: 'integer', format: 'int64', minimum: 1, maximum: env.MAX_INPUT_SIZE_MB * 1024 * 1024, description: `可选，文件大小（字节，上限 ${env.MAX_INPUT_SIZE_MB}MB）` },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['assetId', 'uploadUrl', 'method', 'headers', 'objectKey', 'expiresAt'],
          properties: {
            assetId: { type: 'string', description: '资产 ID（art_xxx），后续提交任务时使用' },
            uploadUrl: { type: 'string', description: '预签名 PUT 上传地址（有效期 10 分钟）' },
            method: { type: 'string', description: '上传方法（PUT）' },
            headers: { type: 'object', description: '上传时必须携带的请求头（如 Content-Type）' },
            objectKey: { type: 'string', description: '存储对象 key' },
            expiresAt: { type: 'string', format: 'date-time', description: '上传地址过期时间' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺失' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        429: { $ref: 'ErrorResponse#', description: '触发限流（rateLimitPerMin）或日配额耗尽（quotaPerDay）' },
      },
    },
  }, async (req, reply) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    const { fileName, mimeType, sizeBytes } = parsed.data;

    const mime = mimeType ?? guessMime(fileName);
    if (!ALLOWED_MIME.has(mime.toLowerCase())) {
      throw Errors.invalidInputAsset(`不支持的文件类型 ${mime}，仅支持 JPG/PNG/JPEG`);
    }

    // 文件扩展名校验（双重防伪造：魔数检测在上传完成后由后端 sharp 验证）
    const ext = fileName.toLowerCase().split('.').pop();
    if (!ext || !['jpg', 'jpeg', 'png'].includes(ext)) {
      throw Errors.invalidInputAsset('文件扩展名不合规');
    }

    const storage = await getStorage();
    const objectKey = `input/${Date.now()}_${fileName}`;
    const up = await storage.generateUploadUrl({
      objectKey,
      mimeType: mime,
      expiresInSec: 600,
    });

    // 预创建 artifact 记录（kind=input，保留 INPUT_RETENTION_DAYS 天）
    const expiresAt = new Date(
      Date.now() + env.INPUT_RETENTION_DAYS * 86400 * 1000,
    );
    // P0 安全修复（高危7）：写入调用方 tenantId，查询时按 tenantId 隔离
    const tenantId = (req as any).user?.tenantId ?? 'default';
    const artifact = await prisma.artifact.create({
      data: {
        code: genArtifactCode(),
        jobId: null, // 任务提交时回填
        kind: 'input',
        objectKey,
        sha256: '', // 上传完成后由 PUT /storage/upload 返回；任务提交时校验
        mimeType: mime,
        sizeBytes: sizeBytes ?? 0,
        originalName: fileName,
        expiresAt,
        tenantId,
      },
    });

    return reply.code(200).send({
      assetId: artifact.code,
      uploadUrl: up.uploadUrl,
      method: up.method,
      headers: up.headers,
      objectKey: up.objectKey,
      expiresAt: up.expiresAt,
    });
  });

  app.post('/v1/assets/:assetId/complete', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['assets'],
      summary: '确认资产上传完成',
      description: '客户端通过 `POST /v1/assets/upload-url` 拿到预签名地址并 PUT 上传完成后，调用本接口回填实际 sha256/sizeBytes/mime。\n\n服务端会校验：\n- 资产存在且属于当前租户（jobId 为 null，即未被任何任务占用）\n- 存储中对象已存在（HEAD 检查）\n- 大小不超过 `MAX_INPUT_SIZE_MB`\n\n校验通过后将资产标记为可用，提交渲染任务时即可在 `input.{bindingId}.assetId` 引用。\n\n注意：资产不存在 / 未上传完成 / 大小超限 / 已被其他任务使用 等情况均统一返回 422 `INVALID_INPUT_ASSET`，详见各响应描述。',
      security: [{ apiKey: [] }],
      params: { type: 'object', required: ['assetId'], properties: { assetId: { type: 'string', description: '资产编码（art_xxx），由 upload-url 接口返回' } } },
      response: {
        200: {
          type: 'object',
          description: '回填成功，返回资产的实际 sha256 与字节数',
          required: ['assetId', 'sha256', 'sizeBytes'],
          properties: {
            assetId: { type: 'string', description: '资产编码（art_xxx）' },
            sha256: { type: 'string', description: '资产实际 SHA-256（hex）' },
            sizeBytes: { type: 'integer', description: '资产实际字节数' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '路径参数校验失败' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        422: { $ref: 'ErrorResponse#', description: 'INVALID_INPUT_ASSET：资产不存在/不属于当前租户/未上传完成/大小不符限制/已被其他任务使用' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const tenantId = req.user?.tenantId;
    const assetId = (req.params as { assetId: string }).assetId;
    const artifact = await prisma.artifact.findFirst({ where: { code: assetId, tenantId, kind: 'input', jobId: null } });
    if (!artifact) throw Errors.invalidInputAsset('资产不存在或不属于当前租户');
    const storage = await getStorage();
    const meta = await storage.headObject(artifact.objectKey);
    if (!meta) throw Errors.invalidInputAsset('资产尚未上传完成');
    if (meta.size <= 0 || meta.size > env.MAX_INPUT_SIZE_MB * 1024 * 1024) {
      throw Errors.invalidInputAsset('资产大小不符合限制');
    }
    const digest = meta.sha256 ?? sha256(await storage.getObject(artifact.objectKey));
    const updated = await prisma.artifact.updateMany({
      where: { id: artifact.id, jobId: null },
      data: { sha256: digest, sizeBytes: meta.size, mimeType: meta.mimeType },
    });
    if (updated.count !== 1) throw Errors.invalidInputAsset('资产已被其他任务使用');
    return reply.send({ assetId, sha256: digest, sizeBytes: meta.size });
  });
}

function guessMime(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}
