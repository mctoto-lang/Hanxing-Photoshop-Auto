/**
 * 业务错误类（携带错误码，路由层统一处理为 HTTP 响应）
 */
import type { ErrorCode } from '../types/index.js';
import { env } from '../config/env.js';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  invalidLayerBinding: (msg = '提交的 bindingId 不在模板版本中') =>
    new AppError('INVALID_LAYER_BINDING', msg),
  fontUnavailable: (msg = '所选字体版本无在线 Worker 支持') =>
    new AppError('FONT_UNAVAILABLE', msg),
  invalidInputAsset: (msg = '文件不合规（格式/大小/魔数）') =>
    new AppError('INVALID_INPUT_ASSET', msg),
  // 错误消息动态引用 env.MAX_INPUT_SIZE_MB，避免运维调整上限后错误提示与实际不一致
  inputSizeExceeded: (msg = `累计输入文件超过 ${env.MAX_INPUT_SIZE_MB}MB`) =>
    new AppError('INPUT_SIZE_EXCEEDED', msg),
  noCompatibleWorker: (msg = '任务已排队，等待对应能力的 Worker 上线') =>
    new AppError('NO_COMPATIBLE_WORKER', msg),
  photoshopScriptError: (msg = 'JSX 执行失败') =>
    new AppError('PHOTOSHOP_SCRIPT_ERROR', msg),
  templateLayerNotFound: (msg = 'JSX 运行时找不到绑定图层') =>
    new AppError('TEMPLATE_LAYER_NOT_FOUND', msg),
  leaseExpired: (msg = '租约已过期') => new AppError('LEASE_EXPIRED', msg),
  leaseTokenMismatch: (msg = '租约令牌不匹配') =>
    new AppError('LEASE_TOKEN_MISMATCH', msg),
  workerNotFound: (msg = 'Worker 不存在或令牌无效') =>
    new AppError('WORKER_NOT_FOUND', msg),
  templateNotPublished: (msg = '模板版本未发布') =>
    new AppError('TEMPLATE_NOT_PUBLISHED', msg),
  idempotencyConflict: (msg = '幂等键冲突') =>
    new AppError('IDEMPOTENCY_CONFLICT', msg),
  // 第二期新增
  notFound: (msg = '资源不存在') =>
    new AppError('NOT_FOUND', msg),
  jobCancelled: (msg = '任务已取消') =>
    new AppError('JOB_CANCELLED', msg),
  jobAlreadyTerminated: (msg = '任务已处于终态，无法取消') =>
    new AppError('JOB_ALREADY_TERMINATED', msg),
  // 第三期新增
  unauthorized: (msg = '未登录或会话已过期') =>
    new AppError('UNAUTHORIZED', msg),
  forbidden: (msg = '权限不足') =>
    new AppError('FORBIDDEN', msg),
  validationError: (msg = '参数校验失败') =>
    new AppError('VALIDATION_ERROR', msg),
  ipNotAllowed: (msg = 'IP 不在白名单') =>
    new AppError('IP_NOT_ALLOWED', msg),
  rateLimited: (msg = '请求过于频繁') =>
    new AppError('RATE_LIMITED', msg),
  invalidPsdFormat: (msg = 'PSD 文件格式无效或已损坏') =>
    new AppError('INVALID_PSD_FORMAT', msg),
};
