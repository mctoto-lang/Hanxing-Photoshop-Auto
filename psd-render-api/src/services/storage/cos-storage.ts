/**
 * 腾讯云 COS 存储后端（第二期）
 *
 * 设计要点：
 *   - 预签名 URL：cos-nodejs-sdk-v5 的 getObjectUrl 工具生成上传/下载签名 URL
 *   - 客户端直传：调用方拿到 uploadUrl 后直接 PUT 到 COS，不经后端中转
 *   - 内网域名：与 CVM 同地域走 cos.ap-guangzhou.myqcloud.com 内网，免流量费
 *   - 后端内部 getObject：通过 SDK 直接读取（走内网）
 *   - 生命周期：COS 桶配置规则自动删除过期对象（也由后端 deleteObject 主动清理）
 *
 * 安全：
 *   - 不向前端暴露 SecretId/SecretKey
 *   - 预签名 URL 限定 method、objectKey、expires
 *   - 内网域名仅后端使用，前端下载用公网域名
 */
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type {
  StorageService,
  UploadUrlResult,
  DownloadUrlResult,
  ObjectMeta,
} from './storage.js';

// cos-nodejs-sdk-v5 无 TS 类型，使用 any 容错
type CosClient = any;

export interface CosConfig {
  SecretId: string;
  SecretKey: string;
  Bucket: string;
  Region: string;
}

export class CosStorageService implements StorageService {
  private client: CosClient | null = null;
  private clientPromise: Promise<CosClient> | null = null;
  private config?: Partial<CosConfig> & { internalDomain?: string; presignExpiresSec?: number };
  private bucket: string;
  private region: string;
  /** 后端内部访问域名（内网），空则用公网 */
  private internalDomain: string;
  /** 预签名 URL 默认有效期 */
  private defaultExpiresSec: number;

  constructor(config?: Partial<CosConfig> & { internalDomain?: string; presignExpiresSec?: number }) {
    this.config = config;
    this.bucket = config?.Bucket ?? env.COS_BUCKET;
    this.region = config?.Region ?? env.COS_REGION;
    this.internalDomain = config?.internalDomain ?? env.COS_INTERNAL_DOMAIN ?? '';
    this.defaultExpiresSec = config?.presignExpiresSec ?? env.COS_PRESIGN_EXPIRES_SECONDS;
    logger.info({
      bucket: this.bucket,
      region: this.region,
      internalDomain: this.internalDomain || '(public)',
      msg: 'COS 存储后端已初始化',
    });
  }

  /**
   * 懒加载 COS SDK（避免 local 模式下加载，且避免 ESM require 问题）
   */
  private async getClient(): Promise<CosClient> {
    if (this.client) return this.client;
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const mod = await import('cos-nodejs-sdk-v5');
        const COS = (mod as any).default ?? mod;
        const client = new COS({
          SecretId: this.config?.SecretId ?? env.COS_SECRET_ID,
          SecretKey: this.config?.SecretKey ?? env.COS_SECRET_KEY,
        });
        this.client = client;
        return client;
      })();
    }
    return this.clientPromise;
  }

  /**
   * 生成上传预签名 URL
   * 客户端用 PUT 方法直传，Content-Type 须匹配
   */
  async generateUploadUrl(opts: {
    objectKey: string;
    mimeType?: string;
    expiresInSec?: number;
  }): Promise<UploadUrlResult> {
    const client = await this.getClient();
    const expires = opts.expiresInSec ?? this.defaultExpiresSec;
    const url = client.getObjectUrl({
      Bucket: this.bucket,
      Region: this.region,
      Key: opts.objectKey,
      Sign: true,
      Method: 'PUT',
      Expires: expires,
      Headers: opts.mimeType ? { 'Content-Type': opts.mimeType } : undefined,
    });
    const expiresAt = new Date(Date.now() + expires * 1000).toISOString();
    return {
      uploadUrl: url,
      method: 'PUT',
      headers: opts.mimeType ? { 'Content-Type': opts.mimeType } : undefined,
      objectKey: opts.objectKey,
      // COS 模式不需要 uploadToken（签名已嵌入 URL）
      uploadToken: '',
      expiresAt,
    };
  }

  /**
   * 接收上传内容（后端内部使用，如解析 PSD 时由后端下载到本地）
   * 客户端直传场景下不会调用此方法
   *
   * P1-I 修复：新增大小限制，与 LocalStorageService 行为对齐。
   *   原实现无任何大小校验，流式 body 可被恶意超大流打满内存。
   *   现统一以 env.MAX_INPUT_SIZE_MB 为上限，超限即拒绝。
   */
  async putObject(opts: {
    objectKey: string;
    body: Buffer | NodeJS.ReadableStream;
    mimeType?: string;
    contentLength?: number;
  }): Promise<ObjectMeta> {
    const maxBytes = env.MAX_INPUT_SIZE_MB * 1024 * 1024;

    // Buffer 模式：直接校验大小
    let bodyToUpload: Buffer | NodeJS.ReadableStream = opts.body;
    let computedSize = opts.contentLength ?? 0;
    let computedSha256: string | undefined;

    if (Buffer.isBuffer(opts.body)) {
      if (opts.body.length > maxBytes) {
        throw new Error(`对象大小 ${opts.body.length} 超过上限 ${maxBytes} 字节`);
      }
      computedSize = opts.body.length;
      computedSha256 = crypto.createHash('sha256').update(opts.body).digest('hex');
    } else {
      // 流式 body：先读入内存并累计大小，超限即拒绝
      // COS SDK 的 putObject 对流式 body 不支持 content-length 自动计算，
      // 且无法中途中止上传，因此先消费到 Buffer 再上传
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of opts.body as NodeJS.ReadableStream) {
        const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += c.length;
        if (total > maxBytes) {
          throw new Error(`对象大小超过上限 ${maxBytes} 字节`);
        }
        chunks.push(c);
      }
      bodyToUpload = Buffer.concat(chunks);
      computedSize = total;
      computedSha256 = crypto.createHash('sha256').update(bodyToUpload).digest('hex');
    }

    const client = await this.getClient();
    return new Promise((resolve, reject) => {
      const params: any = {
        Bucket: this.bucket,
        Region: this.region,
        Key: opts.objectKey,
        Body: bodyToUpload,
        ContentType: opts.mimeType,
        ContentLength: computedSize,
      };
      client.putObject(params, (err: Error, _data: any) => {
        if (err) return reject(err);
        resolve({
          size: computedSize,
          mimeType: opts.mimeType ?? 'application/octet-stream',
          sha256: computedSha256,
        });
      });
    });
  }

  /**
   * 生成下载预签名 URL
   * 调用方用 GET 方法访问
   *
   * 默认强制 Content-Disposition: inline，让浏览器内联显示（图片/PDF 直接预览），
   * 而非 COS 默认的 attachment（强制下载）。用户如需下载可右键「另存为」。
   * 对二进制文件（如 PSD）无副作用——浏览器无法内联显示时仍会下载。
   */
  async generateDownloadUrl(opts: {
    objectKey: string;
    expiresInSec?: number;
  }): Promise<DownloadUrlResult> {
    const client = await this.getClient();
    const expires = opts.expiresInSec ?? this.defaultExpiresSec;
    const url = client.getObjectUrl({
      Bucket: this.bucket,
      Region: this.region,
      Key: opts.objectKey,
      Sign: true,
      Method: 'GET',
      Expires: expires,
      ResponseHeaders: {
        'Content-Disposition': 'inline',
      },
    });
    return {
      downloadUrl: url,
      expiresAt: new Date(Date.now() + expires * 1000).toISOString(),
    };
  }

  /**
   * 直接读取对象内容（后端内部使用）
   * 内网域名走 cos.ap-<region>.myqcloud.com
   */
  async getObject(objectKey: string): Promise<Buffer> {
    const client = await this.getClient();
    return new Promise((resolve, reject) => {
      client.getObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: objectKey,
        },
        (err: Error, data: any) => {
          if (err) return reject(err);
          resolve(Buffer.from(data.Body));
        },
      );
    });
  }

  /**
   * 读取对象为流（大文件场景）
   * 注意：返回同步流，COS SDK 内部处理
   */
  async getObjectStream(objectKey: string): Promise<NodeJS.ReadableStream> {
    const client = await this.getClient();
    return client.getObjectStream({
      Bucket: this.bucket,
      Region: this.region,
      Key: objectKey,
    });
  }

  /**
   * 获取对象元信息
   */
  async headObject(objectKey: string): Promise<ObjectMeta | null> {
    const client = await this.getClient();
    return new Promise((resolve) => {
      client.headObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: objectKey,
        },
        (err: Error, data: any) => {
          if (err) {
            return resolve(null);
          }
          resolve({
            size: parseInt(data?.headers?.['content-length'] ?? '0', 10),
            mimeType: data?.headers?.['content-type'] ?? 'application/octet-stream',
          });
        },
      );
    });
  }

  /**
   * 删除对象
   * 用于产物到期清理、取消任务的中间文件清理
   */
  async deleteObject(objectKey: string): Promise<void> {
    const client = await this.getClient();
    return new Promise((resolve, reject) => {
      client.deleteObject(
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: objectKey,
        },
        (err: Error) => {
          if (err) return reject(err);
          resolve();
        },
      );
    });
  }

  /**
   * 校验上传令牌（COS 模式无令牌，签名嵌入 URL，恒返回 true）
   * local 模式专用接口，COS 模式为空实现
   */
  verifyUploadToken(_objectKey: string, _token: string): boolean {
    return true;
  }
}
