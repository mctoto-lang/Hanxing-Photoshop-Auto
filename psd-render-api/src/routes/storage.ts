/**
 * 存储代理路由（local 模式专用）
 *
 * 暴露 PUT /storage/upload 和 GET /storage/download 端点，
 * 校验签名令牌后直接读写本地文件，模拟 COS 预签名 URL 行为。
 *
 * 第二期切换 COS 后此路由不再需要（客户端直传 COS）。
 *
 * P0 安全修复（中危9+11）：
 *   - 中危9：input/ 路径下上传完成后做魔数校验，挡掉伪装成 png 的 HTML/JS
 *   - 中危11：token 改为 Authorization Bearer 头传递，避免 query string 进入日志/Referer
 *
 * P2-D 修复：仅接受 Authorization: Bearer 头携带 token；
 *   早期版本曾保留 ?token= 兼容老 Worker，中危11 修复后已彻底移除。
 */
import { FastifyInstance } from 'fastify';
import { getStorage } from '../services/storage/index.js';
import { LocalStorageService } from '../services/storage/local-storage.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';

/** 文件魔数 → mimeType 映射（前 8 字节足够区分 JPEG/PNG/PSD） */
const MAGIC_JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const MAGIC_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAGIC_PSD = Buffer.from([0x38, 0x42, 0x50, 0x53]); // "8BPS"

function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(MAGIC_JPEG)) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(MAGIC_PNG)) return 'image/png';
  return null;
}

/**
 * P1-I：output 路径魔数校验
 *   Worker 上传的结果文件应为 PNG / JPEG / PSD，
 *   校验魔数防止被入侵的 Worker 上传任意内容（如 HTML/JS/可执行文件）作为结果。
 */
function detectOutputMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf.subarray(0, 3).equals(MAGIC_JPEG)) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(MAGIC_PNG)) return 'image/png';
  if (buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC_PSD)) return 'image/vnd.adobe.photoshop';
  return null;
}

export async function storageRoutes(app: FastifyInstance) {
  /**
   * 上传：客户端 PUT 文件到此端点
   *
   * token 仅通过 Authorization: Bearer <token> 头传递。
   */
  app.put('/storage/upload', {
    // 该端点同时服务 input/（≤150MB）与 psd/（≤300MB）对象，
    // 取两者最大值作为 body 上限；实际限额由 putObject 按前缀兜底
    bodyLimit: Math.max(env.MAX_INPUT_SIZE_MB, env.MAX_PSD_SIZE_MB) * 1024 * 1024,
    schema: {
      tags: ['storage'],
      summary: '上传文件至本地存储（local 模式专用）',
      description: [
        '校验签名令牌后直接写入本地文件系统，模拟 COS 预签名 URL 行为。',
        '',
        '**鉴权**：通过 `Authorization: Bearer <token>` 头携带上传令牌。',
        '',
        '**安全校验**：',
        '- `input/` 路径：强制魔数校验（仅接受 JPEG/PNG），挡掉伪装成图片的 HTML/JS',
        '- `output/` 路径：强制魔数校验（仅接受 PNG/JPEG/PSD），防止 Worker 上传任意内容',
        '',
        '**注意**：此端点仅 `STORAGE_BACKEND=local` 时可用，切换 COS 后由客户端直传 COS。',
      ].join('\n'),
      // P0 修复（严重3）：声明 security 字段表达签名令牌鉴权机制
      security: [{ storageSignedToken: [] }],
      querystring: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', description: '对象键（如 input/xxx.png、output/yyy.png）' },
        },
      },
      headers: {
        type: 'object',
        properties: {
          Authorization: { type: 'string', description: 'Bearer <token> 上传令牌（推荐）' },
          'Content-Type': { type: 'string', description: '文件 MIME 类型' },
        },
      },
      // 注意：二进制 body 不声明 schema，避免 fast-json-stringify 拒绝 Buffer 类型
      response: {
        200: {
          type: 'object',
          required: ['objectKey', 'sha256', 'size', 'mimeType'],
          properties: {
            objectKey: { type: 'string' },
            sha256: { type: 'string' },
            size: { type: 'integer' },
            mimeType: { type: 'string' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '缺少 key/token 或非 local 模式' },
        403: { $ref: 'ErrorResponse#', description: '签名令牌无效或已过期' },
        422: { $ref: 'ErrorResponse#', description: '文件内容魔数校验失败' },
      },
    },
  }, async (req, reply) => {
    const key = (req.query as any).key as string;
    // Storage tokens are accepted only through Authorization headers.
    const authHeader = req.headers.authorization;
    const headerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : undefined;
    const token = headerToken;

    if (!key || !token) {
      return reply.code(400).send({ error: 'MISSING_PARAMS', message: '缺少 key 或 token' });
    }
    const storage = await getStorage();
    if (!(storage instanceof LocalStorageService)) {
      return reply.code(400).send({ error: 'NOT_LOCAL_MODE', message: '仅 local 模式支持此端点' });
    }
    if (!storage.verifyUploadToken(key, token)) {
      return reply.code(403).send({ error: 'INVALID_TOKEN', message: '上传令牌无效或已过期' });
    }

    const mimeType = req.headers['content-type'] ?? 'application/octet-stream';
    const body = req.body as Buffer;

    // 中危9：input/ 路径下强制魔数校验，挡掉伪装成图片的 HTML/JS
    if (key.startsWith('input/')) {
      const detected = detectImageMime(body);
      if (!detected) {
        logger.warn({
          objectKey: key,
          contentType: mimeType,
          size: body.length,
          msg: '上传内容魔数校验失败，已拒绝（非 JPEG/PNG）',
        });
        return reply.code(422).send({
          error: 'INVALID_FILE_CONTENT',
          message: '文件内容与声明的图片类型不符（魔数校验失败）',
        });
      }
      // 用魔数检测结果覆盖 Content-Type（防止客户端谎报）
      req.headers['content-type'] = detected;
    }

    // P1-I：output/ 路径魔数校验
    //   Worker 上传的结果文件应为 PNG / JPEG / PSD，
    //   防止被入侵的 Worker 上传任意内容作为结果产物
    if (key.startsWith('output/')) {
      const detected = detectOutputMime(body);
      if (!detected) {
        logger.warn({
          objectKey: key,
          contentType: mimeType,
          size: body.length,
          msg: '结果文件魔数校验失败，已拒绝（非 PNG/JPEG/PSD）',
        });
        return reply.code(422).send({
          error: 'INVALID_FILE_CONTENT',
          message: '结果文件内容类型不合法（魔数校验失败，仅支持 PNG/JPEG/PSD）',
        });
      }
      req.headers['content-type'] = detected;
    }

    const meta = await storage.putObject({
      objectKey: key,
      body,
      mimeType: req.headers['content-type'] ?? mimeType,
      contentLength: Number(req.headers['content-length'] ?? 0),
    });

    // P1-H：上传完成后将 sha256 / sizeBytes 写回 artifact 记录
    //   原实现仅返回 sha256 给客户端，DB 中 artifact.sha256 仍为空字符串，
    //   导致 buildManifest 生成的工作清单中 art.sha256=''，
    //   Worker 端 SHA-256 校验形同虚设（任何文件 hash !== '' 恒真，校验必失败
    //   或被注释绕过）。现在按 objectKey 回写，使后续 manifest 校验真正生效。
    if (key.startsWith('input/')) {
      try {
        await prisma.artifact.updateMany({
          where: { objectKey: key, kind: 'input' },
          data: { sha256: meta.sha256 ?? '', sizeBytes: meta.size },
        });
      } catch (e) {
        logger.warn({
          objectKey: key, err: (e as Error).message,
          msg: '回写 artifact sha256 失败（不影响上传结果）',
        });
      }
    }

    logger.info({ objectKey: key, size: meta.size, msg: '文件已上传至本地存储' });
    reply.code(200).send({
      objectKey: key,
      sha256: meta.sha256,
      size: meta.size,
      mimeType: meta.mimeType,
    });
  });

  // 下载：客户端 GET 文件从此端点
  app.get('/storage/download', {
    schema: {
      tags: ['storage'],
      summary: '下载文件（local 模式专用）',
      description: [
        '校验签名令牌后从本地文件系统读取文件并返回二进制流，模拟 COS 预签名 URL 行为。',
        '',
        '**鉴权**：通过 `Authorization: Bearer <token>` 头携带下载令牌。',
        '',
        '**响应**：返回文件二进制流，`Content-Type` 为文件实际 MIME 类型，`Content-Disposition: inline` 便于浏览器内联预览。',
        '',
        '**注意**：此端点仅 `STORAGE_BACKEND=local` 时可用。',
      ].join('\n'),
      // P0 修复（严重3）：声明 security 字段表达签名令牌鉴权机制
      security: [{ storageSignedToken: [] }],
      querystring: {
        type: 'object',
        required: ['key'],
        properties: {
          key: { type: 'string', description: '对象键（如 input/xxx.png、output/yyy.png）' },
        },
      },
      headers: {
        type: 'object',
        properties: {
          Authorization: { type: 'string', description: 'Bearer <token> 下载令牌（推荐）' },
        },
      },
      response: {
        200: {
          type: 'string',
          format: 'binary',
          description: '文件二进制流（Content-Type 为文件实际 MIME 类型）',
        },
        400: { $ref: 'ErrorResponse#', description: '缺少 key/token 或非 local 模式' },
        403: { $ref: 'ErrorResponse#', description: '签名令牌无效或已过期' },
        404: { $ref: 'ErrorResponse#', description: '文件不存在' },
      },
    },
  }, async (req, reply) => {
    const key = (req.query as any).key as string;
    // Storage tokens are accepted only through Authorization headers.
    const authHeader = req.headers.authorization;
    const headerToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : undefined;
    const token = headerToken;

    if (!key || !token) {
      return reply.code(400).send({ error: 'MISSING_PARAMS', message: '缺少 key 或 token' });
    }
    const storage = await getStorage();
    if (!(storage instanceof LocalStorageService)) {
      return reply.code(400).send({ error: 'NOT_LOCAL_MODE', message: '仅 local 模式支持此端点' });
    }
    if (!storage.verifyDownloadToken(key, token)) {
      return reply.code(403).send({ error: 'INVALID_TOKEN', message: '下载令牌无效或已过期' });
    }

    const meta = await storage.headObject(key);
    if (!meta) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '文件不存在' });
    }
    reply.header('Content-Type', meta.mimeType);
    reply.header('Content-Length', meta.size);
    // 强制 inline 让浏览器内联显示（图片直接预览），而非默认下载行为
    reply.header('Content-Disposition', 'inline');
    return storage.getObjectStream(key);
  });
}
