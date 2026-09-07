/**
 * 存储服务抽象接口（第一期 local，第二期 cos）
 *
 * 设计原则：对外提供统一接口，第一期用本地文件系统模拟 COS 预签名 URL 行为，
 * 第二期切换为腾讯云 COS SDK 时只需替换实现，调用方代码不变。
 */
export interface UploadUrlResult {
  /** 上传目标 URL（客户端直接 PUT/POST 文件到此地址） */
  uploadUrl: string;
  /** HTTP 方法 */
  method: 'PUT' | 'POST';
  /** 上传时需要携带的请求头 */
  headers?: Record<string, string>;
  /** 对象 key（后续业务引用） */
  objectKey: string;
  /** 单次上传令牌（local 模式用于校验） */
  uploadToken: string;
  /** 过期时间（ISO） */
  expiresAt: string;
}

export interface DownloadUrlResult {
  downloadUrl: string;
  /**
   * P2-D：下载令牌，调用方应通过 Authorization: Bearer <token> 头携带，
   *   不要嵌入 URL query string（会进入 Nginx/Fastify 访问日志、浏览器 history、Referer）。
   *   COS 模式下为空字符串（签名已嵌入 URL，且 COS 无自定义 header 校验能力）。
   */
  downloadToken?: string;
  expiresAt: string;
}

export interface ObjectMeta {
  size: number;
  mimeType: string;
  sha256?: string;
}

/** 缩略图直链结果（浏览器 <img> 直接加载，签名即鉴权） */
export interface ThumbUrlResult {
  /** 可直接给浏览器加载的 URL（COS=SDK 签名绝对地址；local=/storage/thumb 相对地址，调用方按自身外部基址拼接） */
  url: string;
  expiresAt: string;
}

export interface StorageService {
  /** 生成上传预签名 URL（或 local 模式的上传地址 + 令牌） */
  generateUploadUrl(opts: {
    objectKey: string;
    mimeType?: string;
    expiresInSec?: number;
  }): Promise<UploadUrlResult>;

  /** 接收上传内容（local 模式：由路由层调用；cos 模式：空实现） */
  putObject(opts: {
    objectKey: string;
    body: Buffer | NodeJS.ReadableStream;
    mimeType?: string;
    contentLength?: number;
  }): Promise<ObjectMeta>;

  /** 生成下载预签名 URL */
  generateDownloadUrl(opts: {
    objectKey: string;
    expiresInSec?: number;
  }): Promise<DownloadUrlResult>;

  /**
   * 生成缩略图直链（浏览器 <img> 直接加载）。
   * 仅允许 thumbnails/ 前缀对象；COS 返回 SDK 签名地址，local 返回
   * /storage/thumb?key&exp&sig 查询签名地址（下载令牌走 Authorization 头，
   * <img> 带不了，故缩略图单独放开 query 签名，范围限定小预览图）。
   */
  generateThumbUrl(opts: {
    objectKey: string;
    expiresInSec?: number;
  }): Promise<ThumbUrlResult>;

  /** 校验缩略图直链签名参数（local 模式路由层用） */
  verifyThumbParams(objectKey: string, exp: string, sig: string): boolean;

  /** 直接读取对象内容（后端内部使用，如下载 PSD 解析） */
  getObject(objectKey: string): Promise<Buffer>;

  /** 读取对象为流（第二期：COS 模式下为异步获取 SDK 客户端后再返回流） */
  getObjectStream(objectKey: string): Promise<NodeJS.ReadableStream> | NodeJS.ReadableStream;

  /** 获取对象元信息 */
  headObject(objectKey: string): Promise<ObjectMeta | null>;

  /** 删除对象 */
  deleteObject(objectKey: string): Promise<void>;

  /** 校验上传令牌（local 模式专用） */
  verifyUploadToken(objectKey: string, token: string): boolean;
}
