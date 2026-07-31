/**
 * 环境变量配置（dotenv + zod 类型校验，启动时 fail-fast）
 *
 * P2-1 修复：z.coerce.boolean 对字符串 "false" 会转为 true（仅空串/0/false 为 false），
 *   反直觉行为可能导致 ADMIN_AUTH_ENABLED / FONT_LICENSE_REQUIRED 配置失效。
 *   改为显式字符串解析 + 默认值。
 * P2-6 修复：补充各数值字段的 min/max 范围校验，防止误配导致 OOM 或功能异常。
 */
import dotenv from 'dotenv';
import { z } from 'zod';
import { ipv4InCidr, validateWebhookUrlStatic } from '../lib/ssrf-guard.js';

dotenv.config();

/**
 * P2-1：布尔环境变量解析
 * 接受：true/false（不区分大小写）、1/0、"yes"/"no"
 * 与 z.coerce.boolean 不同，"false" 字符串会正确解析为 false
 */
const booleanSchema = z
  .union([z.boolean(), z.string(), z.number()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    const s = v.toLowerCase().trim();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off', ''].includes(s)) return false;
    // 未知值默认 true（向后兼容）
    return true;
  });

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),

  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().default('file:./dev.db'),

  API_KEY: z.string().min(8, 'API_KEY 至少 8 位'),
  API_KEY_BCRYPT_HASH: z.string().optional().default(''),

  WORKER_TOKEN_SECRET: z.string().min(8, 'WORKER_TOKEN_SECRET 至少 8 位'),
  // P0：Worker 注册预共享密钥（生产强制非空；development 下留空表示开放注册）
  WORKER_REGISTER_SECRET: z.string().default(''),

  STORAGE_BACKEND: z.enum(['local', 'cos']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  // P2-6：保留期至少 1 天，防止误配 0 立即过期
  INPUT_RETENTION_DAYS: z.coerce.number().int().min(1).default(1),
  OUTPUT_RETENTION_DAYS: z.coerce.number().int().min(1).default(3),
  // P2-6：输入大小上限 500MB，防止误配过大导致 OOM
  MAX_INPUT_SIZE_MB: z.coerce.number().int().min(1).max(500).default(150),

  COS_SECRET_ID: z.string().optional().default(''),
  COS_SECRET_KEY: z.string().optional().default(''),
  COS_BUCKET: z.string().optional().default(''),
  COS_REGION: z.string().optional().default('ap-guangzhou'),
  // 第二期：COS 内网域名（与 CVM 同地域走内网，免公网流量费）
  COS_INTERNAL_DOMAIN: z.string().optional().default(''),
  // 第二期：COS 预签名 URL 有效期（秒）；COS 上限 7 天
  COS_PRESIGN_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(604800).default(3600),

  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:3000'),

  // P2-6：LOG_LEVEL 改为 enum，防止传入无效级别被 pino 静默接受
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // 第三期改造：项目改为纯 SQLite 部署，移除 Redis/BullMQ 依赖
  //   保留 QUEUE_BACKEND 枚举仅为向后兼容老 .env；新部署一律用 memory
  //   若误设 bullmq，启动时会自动降级为 memory 并打印警告
  QUEUE_BACKEND: z.enum(['memory', 'bullmq']).default('memory'),
  // 已废弃：保留字段以兼容老 .env，不再使用
  REDIS_URL: z.string().optional().default(''),
  // P2-6：租约 TTL 至少 30 秒，防止误配过小导致任务频繁失败
  LEASE_TTL_SECONDS: z.coerce.number().int().min(30).default(90),
  // P2-6：心跳间隔 10-300 秒
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  // P2-6：长轮询等待 5-60 秒
  CLAIM_MAX_WAIT_SECONDS: z.coerce.number().int().min(5).max(60).default(20),

  // 第二期：监控告警阈值
  ALERT_WORKER_OFFLINE_SECONDS: z.coerce.number().int().default(120),
  ALERT_JOB_FAILED_RATE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  ALERT_QUEUE_BACKLOG_THRESHOLD: z.coerce.number().int().default(50),
  ALERT_PS_STUCK_SECONDS: z.coerce.number().int().default(300),
  ALERT_EVAL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(60),
  ALERT_REAP_MIN_AGE_SECONDS: z.coerce.number().int().default(600),

  // 第二期：任务取消 - Worker 阶段边界检查取消信号间隔
  CANCEL_CHECK_INTERVAL_SECONDS: z.coerce.number().int().min(1).default(5),

  // ===== P2-F 修复：PSD 解析 worker_threads 环境变量 =====
  // 原实现 psd-worker.ts 直接 Number(process.env.MAX_PSD_SIZE_MB ?? '50') 读取，
  //   误设为 'abc' 时 Number('abc')=NaN，size > NaN 恒为 false，大小保护失效，
  //   恶意 PSD 可绕过大小限制导致 worker_threads OOM 或主进程内存耗尽。
  //   现纳入 zod schema，启动时 fail-fast 阻止非法值。
  // PSD 文件大小上限（MB）：1-500MB，默认 50MB
  MAX_PSD_SIZE_MB: z.coerce.number().int().min(1).max(500).default(50),
  // PSD 图层嵌套深度上限：1-1000，默认 100（防止恶意嵌套导致栈溢出）
  PSD_MAX_LAYER_DEPTH: z.coerce.number().int().min(1).max(1000).default(100),
  // PSD 图层总数上限：1-50000，默认 5000（防止恶意 PSD 导致 OOM）
  PSD_MAX_LAYER_COUNT: z.coerce.number().int().min(1).max(50000).default(5000),

  // ===== 第三期 M3：Admin UI 鉴权 =====
  // Admin session 有效期（小时）；上限 72h 防止 session 被劫持后长期可用
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(8),
  // Admin IP 白名单（CIDR 或单 IP，逗号分隔；留空表示不限制）
  ADMIN_IP_WHITELIST: z.string().default(''),
  // 启动时引导创建的初始管理员账号（仅当 DB 无管理员时生效）
  ADMIN_BOOTSTRAP_USERNAME: z.string().default('admin'),
  ADMIN_BOOTSTRAP_PASSWORD: z.string().default(''),
  // Cookie 域（留空则不设置 domain，仅限当前 host）
  ADMIN_COOKIE_DOMAIN: z.string().default(''),
  // 是否启用 Admin 鉴权（false 时降级为 POC 模式无鉴权；生产必须为 true）
  // P2-1 修复：使用 booleanSchema 替代 z.coerce.boolean
  ADMIN_AUTH_ENABLED: booleanSchema.default(true),
  // Admin 会话 Cookie 是否带 Secure 标志（仅 HTTPS 才能发送）
  // - 留空（默认）：production 自动启用，development/test 自动禁用（向后兼容）
  // - 显式设为 true/false（或 1/0、yes/no、on/off）可强制覆盖：
  //   * Docker 容器内直接 HTTP 访问、且无 HTTPS 反代时设为 false，否则浏览器会拒绝该 cookie，
  //     导致登录成功后跳转 /admin 时无 cookie 被认为是未登录，又跳回 /admin/login
  //   * 已有 HTTPS 反代（Nginx/Caddy 终止 TLS）时保持默认即可
  ADMIN_COOKIE_SECURE: z.string().optional().default(''),

  // ===== 第三期 M9：字体许可证管理 =====
  // 是否强制要求字体许可证备注（true 时：注册无 licenseNote 不自动发布；发布前必须设置）
  // P2-1 修复：使用 booleanSchema 替代 z.coerce.boolean
  FONT_LICENSE_REQUIRED: booleanSchema.default(true),

  // ===== 第三期 M10：告警通知渠道扩展 =====
  // 通用 webhook URL（POST JSON：{ title, message, severity, type, refId, triggeredAt }）
  // 留空表示不启用
  ALERT_WEBHOOK_URL: z.string().default(''),
  // 飞书机器人 webhook URL（https://open.feishu.cn/open-apis/bot/v2/hook/xxx）
  ALERT_FEISHU_WEBHOOK_URL: z.string().default(''),
  // 钉钉机器人 webhook URL（https://oapi.dingtalk.com/robot/send?access_token=xxx）
  ALERT_DINGTALK_WEBHOOK_URL: z.string().default(''),
  // 触发通知的最低告警级别（INFO / WARN / ERROR / CRITICAL）
  // 默认 WARN：仅 WARN 及以上级别触发通知（INFO 不通知）
  ALERT_MIN_SEVERITY: z.enum(['INFO', 'WARN', 'ERROR', 'CRITICAL']).default('WARN'),
  // 通知超时（毫秒）
  ALERT_NOTIFY_TIMEOUT_MS: z.coerce.number().default(5000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ 环境变量校验失败：');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

// 第三期改造：QUEUE_BACKEND=bullmq 已废弃，自动降级为 memory
if (parsed.data.QUEUE_BACKEND === 'bullmq') {
  // eslint-disable-next-line no-console
  console.warn('⚠️ QUEUE_BACKEND=bullmq 已废弃（项目改为纯 SQLite + 内存队列），自动降级为 memory');
  (parsed.data as { QUEUE_BACKEND: string }).QUEUE_BACKEND = 'memory';
}
if (parsed.data.STORAGE_BACKEND === 'cos') {
  if (!parsed.data.COS_SECRET_ID || !parsed.data.COS_SECRET_KEY || !parsed.data.COS_BUCKET) {
    console.error('❌ STORAGE_BACKEND=cos 时必须配置 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET');
    process.exit(1);
  }
}
// Worker 注册鉴权：生产环境必须配置 WORKER_REGISTER_SECRET 或使用配对码模式
//   - 配对码模式（推荐）：管理员在 Admin UI 生成一次性配对码，Worker UI 输入注册
//   - 长期密钥模式：配置 WORKER_REGISTER_SECRET，与 Worker config.json 一致
//   两种模式可共存，配对码优先校验。生产环境不再强制配置 WORKER_REGISTER_SECRET。
// P0 高危修复（H2）：生产环境必须启用 Admin 鉴权，禁止降级为 POC 无鉴权模式。
//   原实现仅在 ADMIN_AUTH_ENABLED=true 时校验 ADMIN_BOOTSTRAP_PASSWORD，
//   运维若误设 ADMIN_AUTH_ENABLED=false 会跳过校验导致生产环境 Admin UI 完全无鉴权。
if (parsed.data.NODE_ENV === 'production' && !parsed.data.ADMIN_AUTH_ENABLED) {
  console.error('❌ 生产环境必须启用 Admin 鉴权（ADMIN_AUTH_ENABLED=true），禁止降级为 POC 无鉴权模式');
  process.exit(1);
}
// P0：生产环境必须配置 Admin 引导密码，防止首次启动创建空密码管理员
if (
  parsed.data.NODE_ENV === 'production' &&
  parsed.data.ADMIN_AUTH_ENABLED &&
  !parsed.data.ADMIN_BOOTSTRAP_PASSWORD
) {
  console.error('❌ 生产环境启用 Admin 鉴权时必须配置 ADMIN_BOOTSTRAP_PASSWORD');
  process.exit(1);
}
// P2-6：生产环境禁止 CORS_ORIGINS 使用 * 通配，防止跨域攻击
if (parsed.data.NODE_ENV === 'production' && parsed.data.CORS_ORIGINS.trim() === '*') {
  console.error('❌ 生产环境禁止 CORS_ORIGINS=* 通配，请配置具体允许的源');
  process.exit(1);
}
// P2-6：生产环境禁止使用 POC 示例 API_KEY
if (
  parsed.data.NODE_ENV === 'production' &&
  parsed.data.API_KEY.startsWith('sk_live_poc_demo')
) {
  console.error('❌ 生产环境禁止使用 POC 示例 API_KEY，请配置真实密钥');
  process.exit(1);
}
// P2-6：告警 Webhook URL 启动时做 SSRF 静态校验（防止误配内网/元数据地址）
for (const [name, url] of [
  ['ALERT_WEBHOOK_URL', parsed.data.ALERT_WEBHOOK_URL],
  ['ALERT_FEISHU_WEBHOOK_URL', parsed.data.ALERT_FEISHU_WEBHOOK_URL],
  ['ALERT_DINGTALK_WEBHOOK_URL', parsed.data.ALERT_DINGTALK_WEBHOOK_URL],
] as const) {
  if (url && url.trim()) {
    const r = validateWebhookUrlStatic(url, { allowPrivate: false });
    if (!r.ok) {
      console.error(`❌ ${name} SSRF 校验失败: ${r.reason}`);
      process.exit(1);
    }
  }
}

export const env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isDev = env.NODE_ENV === 'development';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const maxInputSizeBytes = env.MAX_INPUT_SIZE_MB * 1024 * 1024;

/**
 * Admin IP 白名单解析（CIDR 或单 IP，逗号分隔）
 * - 留空表示不限制
 * - 单 IP 视为 /32（IPv4）或 /128（IPv6）
 */
export const adminIpWhitelist: string[] = env.ADMIN_IP_WHITELIST
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * 判断 IP 是否在白名单内（空白名单表示不限制）
 *
 * P0 安全修复（中危8）：原实现按"去尾 0 后字符串前缀匹配"判断 CIDR，
 *   对 /12、/20 等非字节对齐前缀严重错误（如 172.16.0.0/12 会漏放 172.17.x.x,
 *   也会误判）。改为复用 ssrf-guard 中已实现且经过测试的 ipv4InCidr 函数。
 */
export function isIpAllowed(ip: string): boolean {
  if (adminIpWhitelist.length === 0) return true;
  for (const entry of adminIpWhitelist) {
    if (entry === ip) return true;
    if (entry.includes('/')) {
      const [base, prefixStr] = entry.split('/');
      const prefix = Number(prefixStr);
      if (Number.isInteger(prefix) && ipv4InCidr(ip, base, prefix)) {
        return true;
      }
    }
  }
  return false;
}
