/**
 * P0 SSRF 防护：Webhook 目标 URL 校验
 *
 * 攻击面：
 *   - 用户提交渲染任务时通过 webhookUrl 字段指定回调地址
 *   - Admin 配置 API Key 默认 webhookUrlDefault
 *   - 系统在任务终态时主动 POST 到这些地址
 *
 * 风险：
 *   - 攻击者提交 http://169.254.169.254/... 探测云元数据
 *   - 提交 http://127.0.0.1:xxxx/... 访问内部接口
 *   - 提交 http://10.0.0.x/... 扫描内网
 *   - 通过 DNS rebinding 绕过静态校验
 *
 * 防护策略：
 *   - ingress（提交时）：sync 静态校验，挡掉 IP 字面量与已知恶意主机名
 *   - egress（投递时）：async 动态校验，DNS 解析后逐 IP 比对，挡 rebinding
 *   - 生产环境严格模式：禁止任何私有/保留地址
 *   - 开发模式宽松：允许私有地址，方便本地联调
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isProd } from '../config/env.js';

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
}

export interface SsrfOptions {
  /** 允许私有/保留 IP（开发模式默认 true，生产模式默认 false） */
  allowPrivate?: boolean;
}

/** 被禁止的主机名（除 IP 字面量外） */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
  'metadata.google.internal', // GCP 元数据
]);

/**
 * B-S1 修复：云元数据 link-local 段（169.254.0.0/16）必须无条件拒绝。
 *
 * 原实现把 169.254.0.0/16 与其它私有段放在同一个 IPV4_BLOCKED_CIDRS 中，
 *   仅在 allowPrivate=false（即生产环境）时生效。dev 模式下 allowPrivate=true，
 *   整段校验被跳过，导致攻击者可注册 http://169.254.169.254/latest/meta-data/
 *   作为 Webhook URL，若 dev 环境误暴露公网即可窃取云实例元数据凭证。
 *
 * 修复策略：将 169.254.0.0/16 拆到独立的 IPV4_CRITICAL_BLOCKED_CIDRS，
 *   无论 dev / prod 都强制拒绝；其余私有段仍按 allowPrivate 控制（便于本地联调）。
 */
const IPV4_CRITICAL_BLOCKED_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['169.254.0.0', 16],   // 169.254.0.0/16 link-local + 云元数据（强制拒绝）
];

/** IPv4 私有/保留 CIDR 列表（allowPrivate=false 时拒绝；dev 模式允许） */
const IPV4_BLOCKED_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],        // 0.0.0.0/8 "本机"
  ['10.0.0.0', 8],       // 10.0.0.0/8 私有
  ['100.64.0.0', 10],    // 100.64.0.0/10 CGNAT
  ['127.0.0.0', 8],      // 127.0.0.0/8 loopback
  ['172.16.0.0', 12],    // 172.16.0.0/12 私有
  ['192.0.0.0', 24],     // 192.0.0.0/24 IETF 协议分配
  ['192.168.0.0', 16],   // 192.168.0.0/16 私有
  ['198.18.0.0', 15],    // 198.18.0.0/15 基准测试
  ['224.0.0.0', 4],      // 224.0.0.0/4 多播
  ['240.0.0.0', 4],      // 240.0.0.0/4 保留
];

/** IPv4 字面量 → 无符号 32 位整数 */
function ip4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return -1;
  // 使用乘法避免位运算的符号位问题
  return (((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0);
}

/** 判断 IPv4 是否落在 CIDR 内 */
export function ipv4InCidr(ip: string, base: string, prefix: number): boolean {
  const ipInt = ip4ToInt(ip);
  const baseInt = ip4ToInt(base);
  if (ipInt < 0 || baseInt < 0) return false;
  if (prefix === 0) return true;
  if (prefix > 32) return false;
  // 掩码：高 prefix 位为 1
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

/** 判断 IPv4 是否属于强制拒绝段（云元数据 link-local） */
function isCriticalBlockedIpv4(ip: string): boolean {
  for (const [base, prefix] of IPV4_CRITICAL_BLOCKED_CIDRS) {
    if (ipv4InCidr(ip, base, prefix)) return true;
  }
  return false;
}

/** 判断 IPv4 是否属于私有/保留段（不含强制拒绝段） */
function isBlockedIpv4(ip: string): boolean {
  for (const [base, prefix] of IPV4_BLOCKED_CIDRS) {
    if (ipv4InCidr(ip, base, prefix)) return true;
  }
  return false;
}

/** 判断 IPv6 是否属于私有/保留段（覆盖常见情形） */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;            // loopback
  if (lower === '::') return true;             // unspecified
  if (lower.startsWith('ff')) return true;     // ff00::/8 multicast
  // ULA: fc00::/7（fc.. 与 fd..）
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // link-local: fe80::/10（fe8x / fe9x / feax / febx）
  if (
    lower.startsWith('fe8') || lower.startsWith('fe9') ||
    lower.startsWith('fea') || lower.startsWith('feb')
  ) {
    return true;
  }
  // IPv4-mapped: ::ffff:a.b.c.d
  const v4MappedMatch = lower.match(/^::ffff:([0-9.]+)$/);
  if (v4MappedMatch) {
    return isBlockedIpv4(v4MappedMatch[1]);
  }
  // IPv4-compatible: ::a.b.c.d
  const v4CompatMatch = lower.match(/^::([0-9.]+)$/);
  if (v4CompatMatch) {
    return isBlockedIpv4(v4CompatMatch[1]);
  }
  return false;
}

/** 判断 IP 字面量是否属于私有/保留段 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return false;
}

/** 解析 URL，规范化主机名（去方括号、小写） */
function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * 静态校验（同步，无 DNS）：
 *   - 仅允许 http/https
 *   - 拒绝空主机名
 *   - 拒绝 localhost 等已知主机名
 *   - 拒绝 *.localhost
 *   - 主机名为 IP 字面量时检查是否私有/保留
 *   - B-S1 修复：169.254.0.0/16（云元数据 link-local）无论 dev/prod 都强制拒绝
 *
 * 注意：无法挡 DNS rebinding，需配合 validateWebhookUrlDynamic 使用
 */
export function validateWebhookUrlStatic(url: string, opts?: SsrfOptions): SsrfCheckResult {
  const allowPrivate = opts?.allowPrivate ?? !isProd;
  const parsed = parseUrl(url);
  if (!parsed) return { ok: false, reason: 'URL 格式无效' };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `仅允许 http/https 协议，禁止 ${parsed.protocol}` };
  }
  // 去端口、去 IPv6 方括号、小写
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) return { ok: false, reason: 'URL 缺少主机名' };
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `主机名 ${hostname} 被禁止` };
  }
  if (hostname.endsWith('.localhost')) {
    return { ok: false, reason: `主机名 ${hostname} 被禁止` };
  }
  if (isIP(hostname)) {
    // B-S1：云元数据 link-local 段无论 allowPrivate 与否都强制拒绝
    if (isCriticalBlockedIpv4(hostname)) {
      return {
        ok: false,
        reason: `目标 IP ${hostname} 属于云元数据/链路本地地址段（169.254.0.0/16），无论开发/生产环境均拒绝`,
      };
    }
    if (!allowPrivate && isBlockedIp(hostname)) {
      return { ok: false, reason: `目标 IP ${hostname} 属于私有/保留地址，已拒绝` };
    }
  }
  // 拒绝携带用户信息（user:pass@host）
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URL 不允许携带用户信息' };
  }
  return { ok: true };
}

/**
 * 动态校验（异步，含 DNS 解析）：
 *   - 先做静态校验
 *   - 主机名为域名时解析 DNS，逐 IP 比对私有/保留段
 *
 * 用于投递前最终校验，防止 DNS rebinding
 *
 * S-H2：注意此函数仅做校验，不防止校验后到 fetch 之间的 DNS rebinding。
 *   生产环境防 rebinding 需使用 validateAndResolveWebhookUrl 获取已校验的 IP，
 *   再用 pinnedFetch 强制连接到该 IP（agent.lookup 固定返回已校验 IP）。
 */
export async function validateWebhookUrlDynamic(url: string, opts?: SsrfOptions): Promise<SsrfCheckResult> {
  const r = await validateAndResolveWebhookUrl(url, opts);
  return { ok: r.ok, reason: r.reason };
}

export interface ResolvedIp {
  address: string;
  family: number;
}

export interface SsrfResolveResult extends SsrfCheckResult {
  /** 已校验的解析 IP 列表（ok=true 时非空）。用于 IP pinning 防 DNS rebinding */
  ips?: ResolvedIp[];
}

/**
 * 校验并解析 URL，返回已通过 SSRF 校验的 IP 列表。
 *
 * S-H2（DNS Rebinding IP pinning）：
 *   单次 DNS 解析 + 校验 + 返回 IP，调用方用该 IP 建立 pinned 连接，
 *   避免「校验时解析 → fetch 时再解析」之间的 TOCTOU rebinding 攻击。
 *
 * 流程：
 *   1. 静态校验（协议/主机名/IP 字面量）
 *   2. allowPrivate=true（开发模式）直接返回，不解析
 *   3. IP 字面量：静态校验已通过，返回 [{address: hostname, family}]
 *   4. 域名：DNS 解析一次，逐 IP 校验，全部通过则返回 IP 列表
 */
export async function validateAndResolveWebhookUrl(
  url: string,
  opts?: SsrfOptions,
): Promise<SsrfResolveResult> {
  const allowPrivate = opts?.allowPrivate ?? !isProd;
  const staticCheck = validateWebhookUrlStatic(url, opts);
  if (!staticCheck.ok) return staticCheck;
  if (allowPrivate) return { ok: true };

  const parsed = parseUrl(url)!;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // IP 字面量：静态校验中已确认非私有/保留
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    return { ok: true, ips: [{ address: hostname, family: literalFamily }] };
  }

  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(hostname, { all: true });
  } catch (e) {
    return { ok: false, reason: `DNS 解析失败: ${(e as Error).message}` };
  }
  if (addrs.length === 0) {
    return { ok: false, reason: 'DNS 解析无结果' };
  }
  for (const a of addrs) {
    // B-S1：云元数据 link-local 段无论 allowPrivate 与否都强制拒绝
    if (isCriticalBlockedIpv4(a.address)) {
      return {
        ok: false,
        reason: `主机名 ${hostname} 解析到云元数据/链路本地地址 ${a.address}，无论开发/生产环境均拒绝`,
      };
    }
    if (isBlockedIp(a.address)) {
      return {
        ok: false,
        reason: `主机名 ${hostname} 解析到私有/保留 IP ${a.address}，已拒绝`,
      };
    }
  }
  return { ok: true, ips: addrs.map((a) => ({ address: a.address, family: a.family })) };
}

/**
 * 断言式校验：失败抛错（用于 zod refine / 路由参数校验）
 */
export function assertSafeWebhookUrl(url: string, opts?: SsrfOptions): void {
  const r = validateWebhookUrlStatic(url, opts);
  if (!r.ok) throw new Error(r.reason ?? 'URL 校验失败');
}

/* ─── 素材导入专用：可信对象存储域名放行 ─── */

/**
 * 腾讯云同地域机器上，COS 桶公网域名经内网 DNS 解析到 169.254.0.0/16、
 * 10.x 等内网路由地址（如 169.254.0.47），会被「解析到私有地址即拒绝」的
 * 动态 SSRF 校验误杀，导致调用方被迫走「下载再上传」的三步中转。
 *
 * COS 桶域名（*.myqcloud.com / *.tencentcos.cn）由腾讯统一分配，A 记录
 * 指向腾讯自家服务入口，不可能被注册成指向调用方内网的别名，因此按
 * 域名模式放行其 DNS 解析结果（跳过逐 IP 私有段比对）：
 *   <bucket>.cos.<region>.myqcloud.com           公网 endpoint
 *   <bucket>.cos.<region>.tencentcos.cn          内网 endpoint
 *   <bucket>.cos-internal.<region>.myqcloud.com  旧版内网形式
 *
 * 另支持 SSRF_TRUSTED_ASSET_HOSTS 环境变量补充自定义可信域名（逗号分隔；
 * ".example.com" 后缀匹配或 "img.example.com" 精确匹配），供调用方使用
 * 自有 CDN / 其它对象存储时放行。直接读 process.env 以避免与 env.ts 循环依赖。
 */
const TRUSTED_OBJECT_STORAGE_HOST_RE =
  /^[a-z0-9][a-z0-9-]*\.cos(-internal)?\.[a-z0-9-]+(\.myqcloud\.com|\.tencentcos\.cn)$/i;

function envTrustedAssetHosts(): string[] {
  return (process.env.SSRF_TRUSTED_ASSET_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 素材导入域名是否可信（COS 桶模式命中或环境变量白名单命中） */
export function isTrustedAssetImportHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (TRUSTED_OBJECT_STORAGE_HOST_RE.test(host)) return true;
  for (const allow of envTrustedAssetHosts()) {
    if (allow.startsWith('.') ? host.endsWith(allow) : host === allow) {
      return true;
    }
  }
  return false;
}

/**
 * 素材导入 URL 校验（/v1/assets/import-url 专用）：
 * 静态 + DNS 动态校验与 validateWebhookUrlDynamic 一致，仅对可信对象存储
 * 域名跳过「解析到私有地址」拒绝（同地域 COS 内网路由属预期行为）。
 * 协议限制、IP 字面量、用户信息、重定向逐跳复检等其余 SSRF 规则不受影响。
 */
export async function validateAssetImportUrl(
  url: string,
  opts?: SsrfOptions,
): Promise<SsrfCheckResult> {
  const staticCheck = validateWebhookUrlStatic(url, opts);
  if (!staticCheck.ok) return staticCheck;
  const allowPrivate = opts?.allowPrivate ?? !isProd;
  if (allowPrivate) return { ok: true };

  const parsed = parseUrl(url)!;
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isTrustedAssetImportHost(hostname)) return { ok: true };

  return validateWebhookUrlDynamic(url, opts);
}
