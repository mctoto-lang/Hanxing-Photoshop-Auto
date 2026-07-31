/**
 * 共享类型定义（与 Electron Worker 共享）
 */

// ===== 图层树 =====
// 图层树节点类型：psd-parser 检测时仍用全部 5 种用于展示
export type LayerType = 'smartObject' | 'text' | 'group' | 'pixel' | 'adjustment';

// 绑定配置专用类型：允许 smartObject / text / pixel 可被绑定替换
// pixel 类型用于像素图层替换（也兼容 PSD 解析器将智能对象误判为 pixel 的情况）
export type BindingLayerType = 'smartObject' | 'text' | 'pixel';

export interface LayerNode {
  /** Photoshop 内部 layer.id（稳定，运行时优先使用） */
  layerId: number;
  /** 从根到该图层的名称链（降级定位） */
  layerPath: string;
  name: string;
  type: LayerType;
  bounds?: { top: number; left: number; bottom: number; right: number };
  visible: boolean;
  /** 文本图层默认文本 */
  defaultText?: string;
  /** 智能对象内部文档尺寸（用于替换前预处理图片到目标尺寸） */
  smartObjectSize?: { width: number; height: number };
  /** 子图层 */
  children?: LayerNode[];
}

export interface LayerTreeResult {
  templateId: string;
  templateVersionId: string;
  canvas: { width: number; height: number };
  layerTree: LayerNode[];
}

// ===== 图层绑定配置 =====
export interface LayerBindingConfig {
  bindingId: string;
  layerId: number;
  layerPath: string;
  /** 绑定类型允许 smartObject / text / pixel */
  type: BindingLayerType;
  required: boolean;
  label?: string;
  acceptedFormats?: string[];
  /** 填充方式，默认 stretch */
  fit?: 'cover' | 'contain' | 'stretch';
  /** text 类型：最大字符数 */
  maxLength?: number;
  /** text 类型：关联 FontVersion.id（用户上传并安装的字体） */
  defaultFontVersionId?: string;
}

export interface LayerSchema {
  bindings: LayerBindingConfig[];
}

// ===== 渲染任务输入 =====
export interface RenderJobInputItem {
  bindingId: string;
  /** 图片输入：关联的 assetId */
  assetId?: string;
  /** 文本输入 */
  text?: string;
}

export interface RenderJobInput {
  [bindingId: string]: {
    assetId?: string;
    text?: string;
  };
}

export interface RenderJobOutput {
  format: 'png' | 'jpeg' | 'psd';
  quality?: number;
}

// ===== 任务状态机 =====
export type JobStatus =
  | 'QUEUED'
  | 'LEASED'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLING'
  | 'CANCELLED';

export type JobStage = 'DOWNLOAD' | 'RUN_JSX' | 'EXPORT' | 'UPLOAD';

// ===== 错误码 =====
export type ErrorCode =
  | 'INVALID_LAYER_BINDING'
  | 'FONT_UNAVAILABLE'
  | 'INVALID_INPUT_ASSET'
  | 'INPUT_SIZE_EXCEEDED'
  | 'NO_COMPATIBLE_WORKER'
  | 'WORKER_LOST'
  | 'PHOTOSHOP_SCRIPT_ERROR'
  | 'TEMPLATE_LAYER_NOT_FOUND'
  | 'LEASE_EXPIRED'
  | 'LEASE_TOKEN_MISMATCH'
  | 'WORKER_NOT_FOUND'
  | 'TEMPLATE_NOT_PUBLISHED'
  | 'IDEMPOTENCY_CONFLICT'
  // 第三期新增：PSD 文件格式无效或损坏
  | 'INVALID_PSD_FORMAT'
  // 第二期新增
  | 'NOT_FOUND'
  | 'JOB_CANCELLED'
  | 'JOB_ALREADY_TERMINATED'
  // 第三期新增
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'VALIDATION_ERROR'
  | 'IP_NOT_ALLOWED'
  | 'RATE_LIMITED'
  // 第三期 M3+：配置错误（密文解密失败等）
  | 'CONFIG_ERROR';

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_LAYER_BINDING: 422,
  FONT_UNAVAILABLE: 422,
  INVALID_INPUT_ASSET: 422,
  INPUT_SIZE_EXCEEDED: 422,
  NO_COMPATIBLE_WORKER: 202,
  WORKER_LOST: 202,
  PHOTOSHOP_SCRIPT_ERROR: 500,
  TEMPLATE_LAYER_NOT_FOUND: 500,
  LEASE_EXPIRED: 409,
  LEASE_TOKEN_MISMATCH: 403,
  WORKER_NOT_FOUND: 404,
  TEMPLATE_NOT_PUBLISHED: 422,
  IDEMPOTENCY_CONFLICT: 409,
  INVALID_PSD_FORMAT: 422,
  NOT_FOUND: 404,
  JOB_CANCELLED: 410,
  JOB_ALREADY_TERMINATED: 409,
  // 第三期新增
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_ERROR: 400,
  IP_NOT_ALLOWED: 403,
  RATE_LIMITED: 429,
  CONFIG_ERROR: 500,
};

// ===== Admin 角色（第三期 M3） =====
export type AdminRole = 'admin' | 'operator' | 'viewer';

export const ADMIN_ROLE_HIERARCHY: Record<AdminRole, number> = {
  admin: 3,
  operator: 2,
  viewer: 1,
};

/** 判断 actual 角色是否满足 required 最低要求 */
export function hasAdminRole(actual: AdminRole, required: AdminRole): boolean {
  return ADMIN_ROLE_HIERARCHY[actual] >= ADMIN_ROLE_HIERARCHY[required];
}

// ===== Worker 能力声明 =====
export interface WorkerCapabilities {
  psVersion: string;
  psMajorVersion: number;
  os: 'windows';
  supportsSmartObject: boolean;
  supportsTextLayer: boolean;
  fonts: string[]; // postscriptName 列表
}

// ===== Worker 注册响应 =====
export interface WorkerRegisterResponse {
  workerId: string;
  workerCode: string;
  accessToken: string;
  tokenExpiresAt: string;
}

// ===== Claim 响应 =====
export interface ClaimResult {
  jobId: string;
  jobCode: string;
  leaseToken: string;
  leaseExpiresAt: string;
  manifest: JobManifest;
}

export interface JobManifest {
  jobId: string;
  jobCode: string;
  templateVersionId: string;
  psdObjectKey: string;
  psdSha256: string;
  /** PSD 下载地址（Worker 下载模板用） */
  psdDownloadUrl: string;
  /**
   * P2-D：PSD 下载令牌（local 模式），Worker 通过 Authorization: Bearer 头携带，
   *   不再嵌入 URL query string（避免进入日志/Referer）。COS 模式为空字符串。
   */
  psdDownloadToken?: string;
  layerSchema: LayerSchema;
  input: RenderJobInput;
  output: RenderJobOutput;
  artifacts: Array<{
    bindingId: string;
    objectKey: string;
    sha256: string;
    mimeType: string;
    downloadUrl: string;
    /** P2-D：下载令牌，Authorization: Bearer 头携带 */
    downloadToken?: string;
  }>;
  fonts: Array<{
    fontId: string;
    postscriptName: string;
    fileObjectKey: string;
    sha256: string;
    downloadUrl: string;
    /** P2-D：下载令牌，Authorization: Bearer 头携带 */
    downloadToken?: string;
  }>;
  /**
   * 图片替换图层的目标尺寸列表（供 Worker 预处理图片到目标尺寸）
   * 包含被绑定的 smartObject 图层（内部文档尺寸）和 pixel 图层（边界尺寸）
   */
  layerSizes: Array<{
    layerId: number;
    width: number;
    height: number;
  }>;
  /** 结果文件上传地址（Worker 直接 PUT 文件到此 URL） */
  resultUploadUrl: string;
  /** 结果文件应使用的 objectKey（complete 时回传） */
  resultObjectKey: string;
  /** 结果上传令牌（local 模式） */
  resultUploadToken?: string;
  /**
   * P2-D：结果上传请求头（含 Authorization: Bearer），Worker 直接作为 fetch headers 使用。
   *   local 模式下由 LocalStorageService.generateUploadUrl 注入；COS 模式为空对象。
   */
  resultUploadHeaders?: Record<string, string>;
}
