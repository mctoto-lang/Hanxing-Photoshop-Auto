/**
 * 外部 API - 资产上传
 * POST /v1/assets/upload-url
 *   获取输入文件 COS 预签名上传地址，返回 assetId
 * POST /v1/assets/import-url
 *   服务端按 URL 拉取素材（sha256 秒传：同租户已有同内容未占用资产直接复用）
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
import { validateWebhookUrlDynamic } from '../../lib/ssrf-guard.js';

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

const importUrlSchema = z.object({
  url: z.string().url('URL 格式无效').max(2048),
  fileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9._\-]+$/, '文件名仅允许字母、数字、点、下划线、连字符')
    .optional(),
  mimeType: z.string().max(128).optional(),
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

  // 按 URL 导入素材：服务端拉取 + sha256 秒传（替代调用方「下载再三步上传」的双倍带宽中转）
  app.post('/v1/assets/import-url', {
    preHandler: [app.authenticateApiKey],
    schema: {
      tags: ['assets'],
      summary: '按 URL 导入素材（服务端拉取 + sha256 秒传）',
      description: [
        '服务端按 URL 拉取图片并登记为输入资产，返回与 upload-url + complete 相同结构的 `{ assetId, sha256, sizeBytes }`。',
        '',
        '**sha256 秒传**：同租户已存在未占用、未过期且内容一致（sha256 相同）的输入资产时直接复用并续期 `INPUT_RETENTION_DAYS`，跳过存储写入（`deduplicated: true`）。',
        '',
        '**SSRF 防护**：仅允许 http/https，私有/保留地址段拒绝（生产模式），重定向逐跳重新校验（最多 3 跳）。',
        '',
        '限制：仅 JPG/PNG/JPEG，单张 ≤ ' + env.MAX_INPUT_SIZE_MB + 'MB，下载超时 60s。',
      ].join('\n'),
      security: [{ apiKey: [] }],
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', format: 'uri', maxLength: 2048, description: '素材 URL（http/https，公网可达）' },
          fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[a-zA-Z0-9._\\-]+$', description: '可选，原始文件名（仅字母/数字/点/下划线/连字符）' },
          mimeType: { type: 'string', maxLength: 128, description: '可选，缺省按响应 Content-Type / 文件名推断' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['assetId', 'sha256', 'sizeBytes', 'deduplicated'],
          properties: {
            assetId: { type: 'string', description: '资产编码（art_xxx）' },
            sha256: { type: 'string', description: '内容 SHA-256（hex）' },
            sizeBytes: { type: 'integer', description: '字节数' },
            deduplicated: { type: 'boolean', description: 'true=秒传命中已有资产（未新写存储）' },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: 'API Key 无效或缺少 tenantId' },
        403: { $ref: 'ErrorResponse#', description: 'IP 白名单拒绝 / 作用域不足' },
        422: { $ref: 'ErrorResponse#', description: 'INVALID_INPUT_ASSET：URL 不允许（SSRF）/下载失败/超时/大小超限/类型不支持' },
        429: { $ref: 'ErrorResponse#', description: '触发限流或日配额耗尽' },
      },
    },
  }, async (req, reply) => {
    const parsed = importUrlSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    const tenantId = (req as any).user?.tenantId;
    if (!tenantId) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 缺少 tenantId' });
    }
    const { url, fileName, mimeType } = parsed.data;

    // SSRF：静态 + DNS 动态校验；重定向逐跳复检（最多 3 跳，防跳转到内网）
    const maxBytes = env.MAX_INPUT_SIZE_MB * 1024 * 1024;
    let buf: Buffer | undefined;
    let mime = mimeType?.toLowerCase();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      let current = url;
      try {
        for (let hop = 0; hop <= 3; hop++) {
          const check = await validateWebhookUrlDynamic(current);
          if (!check.ok) {
            throw Errors.invalidInputAsset(`素材 URL 不允许：${check.reason}`);
          }
          const res = await fetch(current, {
            signal: controller.signal,
            redirect: 'manual',
          });
          if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (!loc || hop === 3) {
              throw Errors.invalidInputAsset('素材 URL 重定向次数超限');
            }
            current = new URL(loc, current).toString();
            continue;
          }
          if (!res.ok) {
            throw Errors.invalidInputAsset(`素材下载失败 HTTP ${res.status}`);
          }
          const declared = Number(res.headers.get('content-length') ?? 0);
          if (declared > maxBytes) {
            throw Errors.invalidInputAsset(`素材超过大小上限 ${env.MAX_INPUT_SIZE_MB}MB`);
          }
          const arrayBuf = await res.arrayBuffer();
          if (arrayBuf.byteLength > maxBytes) {
            throw Errors.invalidInputAsset(`素材超过大小上限 ${env.MAX_INPUT_SIZE_MB}MB`);
          }
          buf = Buffer.from(arrayBuf);
          mime = (
            mime ??
            res.headers.get('content-type')?.split(';')[0]?.trim() ??
            guessMime(fileName ?? '')
          ).toLowerCase();
          break;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (e: any) {
      if (e?.name === 'AbortError' || e?.name === 'TimeoutError') {
        throw Errors.invalidInputAsset('素材下载超时');
      }
      throw e;
    }
    if (!buf) throw Errors.invalidInputAsset('素材下载失败');
    if (!ALLOWED_MIME.has(mime!)) {
      throw Errors.invalidInputAsset(`不支持的文件类型 ${mime}，仅支持 JPG/PNG/JPEG`);
    }

    const digest = sha256(buf);

    // sha256 秒传：同租户已有同内容、未占用、未过期的输入资产 → 续期复用
    const existing = await prisma.artifact.findFirst({
      where: {
        tenantId,
        kind: 'input',
        sha256: digest,
        jobId: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      await prisma.artifact.update({
        where: { id: existing.id },
        data: {
          expiresAt: new Date(Date.now() + env.INPUT_RETENTION_DAYS * 86400 * 1000),
        },
      });
      return reply.send({
        assetId: existing.code,
        sha256: digest,
        sizeBytes: buf.length,
        deduplicated: true,
      });
    }

    // 落存储 + 登记（与三步上传同构；sha256 已在导入时算好，无需 complete）
    const storage = await getStorage();
    const safeName = fileName ?? `import-${Date.now()}.${extFromMime(mime!)}`;
    const objectKey = `input/${Date.now()}_${safeName}`;
    await storage.putObject({
      objectKey,
      body: buf,
      mimeType: mime!,
      contentLength: buf.length,
    });
    const artifact = await prisma.artifact.create({
      data: {
        code: genArtifactCode(),
        jobId: null,
        kind: 'input',
        objectKey,
        sha256: digest,
        mimeType: mime!,
        sizeBytes: buf.length,
        originalName: safeName,
        expiresAt: new Date(Date.now() + env.INPUT_RETENTION_DAYS * 86400 * 1000),
        tenantId,
      },
    });
    return reply.send({
      assetId: artifact.code,
      sha256: digest,
      sizeBytes: buf.length,
      deduplicated: false,
    });
  });
}

function guessMime(fileName: string): string {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function extFromMime(mime: string): string {
  if (mime === 'image/png') return 'png';
  return 'jpg';
}
