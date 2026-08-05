/**
 * 本地文件存储实现（第一期 POC 替代 COS）
 *
 * 行为约定：
 * - 对象 key 形如 "psd/tpv_xxx/base.psd" 或 "input/art_xxx/photo.jpg"
 * - 落盘到 LOCAL_STORAGE_DIR/<objectKey>
 * - 预签名 URL：生成一个签名 token，路由层暴露 PUT /storage/upload 与 GET /storage/download 端点校验
 *
 * 第二期切换 COS 时，实现 cos-storage.ts 并在 index.ts 中按 STORAGE_BACKEND 选择即可。
 */
import { promises as fs } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { env, corsOrigins } from '../../config/env.js';
import { sha256, hmacSign } from '../../lib/crypto.js';
import type {
  StorageService,
  UploadUrlResult,
  DownloadUrlResult,
  ObjectMeta,
} from './storage.js';

export class LocalStorageService implements StorageService {
  private readonly root: string;
  private readonly secret: string;
  /** 上传令牌有效期（秒） */
  private readonly uploadTtlSec = 600;

  /**
   * @param overrideRoot 可选的自定义存储根目录（来自 Admin UI 配置），
   *                     优先级高于 env.LOCAL_STORAGE_DIR
   */
  constructor(overrideRoot?: string) {
    this.root = path.resolve(overrideRoot ?? env.LOCAL_STORAGE_DIR);
    this.secret = env.WORKER_TOKEN_SECRET;
    void this.ensureDir(this.root);
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (e) {
      // 忽略已存在
    }
  }

  /** 将 objectKey 转为安全本地路径（禁止 .. 跨目录、UNC、Windows ADS） */
  private resolvePath(objectKey: string): string {
    const safe = objectKey.replace(/\\/g, '/').replace(/^\/+/, '');
    if (safe.includes('..') || path.isAbsolute(safe)) {
      throw new Error(`非法对象 key: ${objectKey}`);
    }
    // M2 安全修复：禁止 Windows 替代数据流（ADS，如 "file.png:Zone.Identifier"）
    //   与 UNC 路径（如 "\\server\share"）。UNC 在前面 \\ -> / 替换后已变成相对路径，
    //   但仍可能通过残留的 // 前缀绕过；同时禁止盘符前缀（C:）与 NUL 字节。
    if (safe.includes(':') || safe.includes('\0') || safe.startsWith('//')) {
      throw new Error(`非法对象 key: ${objectKey}`);
    }
    const resolved = path.join(this.root, safe);
    // 二次校验：resolved 必须仍在 root 之下（防 join 后越界）
    const rootNorm = path.resolve(this.root);
    if (resolved !== rootNorm && !resolved.startsWith(rootNorm + path.sep)) {
      throw new Error(`非法对象 key: ${objectKey}`);
    }
    return resolved;
  }

  async generateUploadUrl(opts: {
    objectKey: string;
    mimeType?: string;
    expiresInSec?: number;
  }): Promise<UploadUrlResult> {
    const ttl = opts.expiresInSec ?? this.uploadTtlSec;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const token = this.signUpload(opts.objectKey, ttl);
    // P2-D：URL 仅含 key，token 通过 Authorization: Bearer 头携带
    //   原 ?key=...&token=... 形式会进入 Nginx/Fastify 访问日志、浏览器 history、Referer，
    //   令牌泄露后可在 TTL 内任意上传覆盖对象。
    const uploadUrl = `/storage/upload?key=${encodeURIComponent(opts.objectKey)}`;
    return {
      uploadUrl,
      method: 'PUT',
      headers: {
        'Content-Type': opts.mimeType ?? 'application/octet-stream',
        'Authorization': `Bearer ${token}`,
      },
      objectKey: opts.objectKey,
      uploadToken: token,
      expiresAt,
    };
  }

  async putObject(opts: {
    objectKey: string;
    body: Buffer | NodeJS.ReadableStream;
    mimeType?: string;
    contentLength?: number;
  }): Promise<ObjectMeta> {
    const filePath = this.resolvePath(opts.objectKey);
    await this.ensureDir(path.dirname(filePath));

    // B-H7 修复：putObject 内部强制大小限制。
    //   原实现仅依赖路由层 Fastify bodyLimit 兜底，但内部服务调用（如 template-service、
    //   test/assets）绕过路由层 body parser 时无任何限制，恶意超大流会把整个内容加载到内存导致 OOM。
    //   现在统一以 env.MAX_INPUT_SIZE_MB 为上限，超过即拒绝。
    // PSD 限额隔离：psd/ 前缀对象（PSD 模板）走 MAX_PSD_SIZE_MB（默认 300MB），
    //   其余（input/、output/、thumbnails/）仍走 MAX_INPUT_SIZE_MB（默认 150MB），
    //   避免 PSD 大文件限额放宽连带放宽输入资产限额。
    const maxBytes = opts.objectKey.startsWith('psd/')
      ? env.MAX_PSD_SIZE_MB * 1024 * 1024
      : env.MAX_INPUT_SIZE_MB * 1024 * 1024;

    // P2-J 修复：流式 body 改为写入临时文件，避免 chunks: Buffer[] 累计到 maxBytes（150MB）
    //   才抛错。原实现在内存中累计所有 chunks，10 并发上传就是 1.5GB 内存。
    //   现改为：流式写入同目录临时文件，边写边检查大小，完成后原子 rename 到目标路径。
    //   Buffer body 保持快速路径（一次性写入，内存占用仅 buffer 本身）。

    if (Buffer.isBuffer(opts.body)) {
      // Buffer 快速路径：已有完整数据在内存中，直接写入
      const buffer = opts.body;
      if (buffer.length > maxBytes) {
        throw new Error(`对象大小 ${buffer.length} 超过上限 ${maxBytes} 字节`);
      }
      await fs.writeFile(filePath, buffer);
      const hash = sha256(buffer);
      return {
        size: buffer.length,
        mimeType: opts.mimeType ?? 'application/octet-stream',
        sha256: hash,
      };
    }

    // 流式路径：写入临时文件，边写边计大小 + 计算 sha256
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const hash = createHash('sha256');
    let totalBytes = 0;
    let writeStream: ReturnType<typeof createWriteStream> | null = null;

    try {
      writeStream = createWriteStream(tmpPath, { flags: 'wx' });

      // 自定义 Transform：计数 + 哈希 + 超限中止
      const sizeAndHashTransform = new Transform({
        transform(chunk, _encoding, callback) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.length;
          if (totalBytes > maxBytes) {
            // 超限时销毁流，pipeline 会抛错
            const err = new Error(`对象大小超过上限 ${maxBytes} 字节`);
            callback(err);
            return;
          }
          hash.update(buf);
          callback(null, buf);
        },
      });

      // pipeline 会在出错时自动销毁所有流
      await pipeline(
        opts.body as NodeJS.ReadableStream,
        sizeAndHashTransform,
        writeStream,
      );

      // 写入完成，原子 rename 到目标路径
      await fs.rename(tmpPath, filePath);

      const digest = hash.digest('hex');
      return {
        size: totalBytes,
        mimeType: opts.mimeType ?? 'application/octet-stream',
        sha256: digest,
      };
    } catch (err) {
      // 出错时清理临时文件
      try {
        await fs.unlink(tmpPath);
      } catch {
        // 临时文件可能未创建或已被清理，忽略
      }
      // 销毁输入流防止资源泄漏
      // ReadableStream 类型不含 destroy，需用 Readable 类型断言
      const bodyStream = opts.body as Readable;
      if (bodyStream && typeof bodyStream.destroy === 'function') {
        bodyStream.destroy();
      }
      throw err;
    }
  }

  async generateDownloadUrl(opts: {
    objectKey: string;
    expiresInSec?: number;
  }): Promise<DownloadUrlResult> {
    const ttl = opts.expiresInSec ?? 86400;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const token = this.signDownload(opts.objectKey, ttl);
    // P2-D：URL 仅含 key，token 单独返回由调用方放入 Authorization 头
    const downloadUrl = `/storage/download?key=${encodeURIComponent(opts.objectKey)}`;
    return { downloadUrl, downloadToken: token, expiresAt };
  }

  async getObject(objectKey: string): Promise<Buffer> {
    const filePath = this.resolvePath(objectKey);
    return fs.readFile(filePath);
  }

  getObjectStream(objectKey: string): NodeJS.ReadableStream {
    const filePath = this.resolvePath(objectKey);
    return createReadStream(filePath);
  }

  async headObject(objectKey: string): Promise<ObjectMeta | null> {
    try {
      const filePath = this.resolvePath(objectKey);
      const stat = await fs.stat(filePath);
      return {
        size: stat.size,
        mimeType: guessMime(objectKey),
      };
    } catch {
      return null;
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(objectKey));
    } catch {
      // 忽略不存在
    }
  }

  verifyUploadToken(objectKey: string, token: string): boolean {
    // token 格式：<exp>.<sig>
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const exp = parseInt(parts[0]!, 10);
    // B-H6 修复：parseInt 非数字字符串返回 NaN，Date.now() > NaN 恒为 false 不会因过期拒绝。
    //   攻击者构造 token 形如 "abc.sig" 即可绕过过期校验（虽仍需正确签名，但属逻辑缺陷）。
    if (!Number.isFinite(exp) || exp <= 0) return false;
    if (Date.now() > exp) return false;
    // 重新生成会因时间不同导致 sig 不同，改为固定 payload 签名
    const payload = `upload:${objectKey}:${exp}`;
    const expectedSig = hmacSign(this.secret, payload);
    // P1-15 修复：使用恒定时间比较，防止时序侧信道逐字节爆破签名
    return safeSigEqual(expectedSig, parts[1]!);
  }

  /** 签发上传令牌 */
  private signUpload(objectKey: string, ttlSec: number): string {
    const exp = Date.now() + ttlSec * 1000;
    const payload = `upload:${objectKey}:${exp}`;
    const sig = hmacSign(this.secret, payload);
    return `${exp}.${sig}`;
  }

  /** 签发下载令牌 */
  private signDownload(objectKey: string, ttlSec: number): string {
    const exp = Date.now() + ttlSec * 1000;
    const payload = `download:${objectKey}:${exp}`;
    const sig = hmacSign(this.secret, payload);
    return `${exp}.${sig}`;
  }

  /** 校验下载令牌 */
  verifyDownloadToken(objectKey: string, token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const exp = parseInt(parts[0]!, 10);
    // B-H6 修复：同 verifyUploadToken，校验 NaN 防止绕过过期校验
    if (!Number.isFinite(exp) || exp <= 0) return false;
    if (Date.now() > exp) return false;
    const payload = `download:${objectKey}:${exp}`;
    const expectedSig = hmacSign(this.secret, payload);
    // P1-15 修复：使用恒定时间比较
    return safeSigEqual(expectedSig, parts[1]!);
  }
}

/**
 * P1-15：恒定时间签名比较，防止时序侧信道
 * 长度不同时先比较自身再返回 false，保持时间恒定
 */
function safeSigEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    ab.compare(ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

function guessMime(objectKey: string): string {
  const ext = path.extname(objectKey).toLowerCase();
  switch (ext) {
    case '.psd':
      return 'image/vnd.adobe.photoshop';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.otf':
      return 'font/otf';
    case '.ttf':
      return 'font/ttf';
    default:
      return 'application/octet-stream';
  }
}

// 仅用于消除未使用导入警告（corsOrigins 在 cos 实现中使用）
void corsOrigins;
