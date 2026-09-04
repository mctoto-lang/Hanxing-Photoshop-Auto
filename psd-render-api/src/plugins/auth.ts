/**
 * 鉴权插件（第三期 M1 升级）
 *
 * 两种鉴权方式：
 * 1. API Key（外部调用方）：Authorization: Bearer <key>
 *    - 按 keyPrefix 索引查找（sk_live_ 后的前 12 字符）
 *    - bcrypt 校验完整 key
 *    - 限流（rateLimitPerMin，滑动窗口）
 *    - 日配额（quotaPerDay，按 quotaResetAt 滚动 24h）
 *    - IP 白名单（ipWhitelist）
 *    - 作用域校验（scopes，留空表示全部）
 * 2. Worker Token（Worker 内部接口）：Authorization: Bearer <workerToken>
 *
 * POC 回落：env.API_KEY 单密钥模式（仅当 DB 无 active ApiKey 时启用）
 */
import fp from 'fastify-plugin';
import bcrypt from 'bcryptjs';
import { timingSafeEqual } from 'node:crypto';
import { env, isIpAllowed, isProd } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sha256 } from '../lib/crypto.js';
import { ipv4InCidr } from '../lib/ssrf-guard.js';

/** 恒定时间字符串比较（防时序攻击）；长度不同时先比较自身再返回 false */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // 仍调用一次 compare 以保持时间恒定
    ab.compare(ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export interface AuthUser {
  type: 'apiKey' | 'worker';
  // API Key 模式
  apiKeyId?: string;
  tenantId?: string;
  priority?: number;
  scopes?: string[];
  // 该 API Key 配置的默认 Webhook 回调地址（Admin 维护）；提交任务未显式
  // 传 webhookUrl 时作为兜底，避免调用方每单都要带
  webhookUrlDefault?: string | null;
  // 终端用户身份（由 API Key 持有方即网页后端经请求头透传，服务间信任）：
  //   X-User-Id    操作用户 ID（模板归属人 / 私有模板可见性判断）
  //   X-User-Admin 是否企业管理员（"true"/"1"）
  userId?: string;
  userAdmin?: boolean;
  // Worker 模式
  workerId?: string;
  workerCode?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticateApiKey: (req: any, reply: any) => Promise<void>;
    authenticateWorker: (req: any, reply: any) => Promise<void>;
    requireScope: (scope: string) => (req: any, reply: any) => Promise<void>;
  }
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** 解析终端用户透传头（X-User-Id / X-User-Admin）；非法值一律忽略 */
function resolveUserHeaders(req: any): { userId: string; userAdmin: boolean } | undefined {
  const rawId = req.headers['x-user-id'];
  const rawAdmin = req.headers['x-user-admin'];
  let userId: string | undefined;
  if (typeof rawId === 'string') {
    const v = rawId.trim();
    if (v && v.length <= 64 && /^[A-Za-z0-9_.:@-]+$/.test(v)) userId = v;
  }
  let userAdmin = false;
  if (typeof rawAdmin === 'string' && ['true', '1'].includes(rawAdmin.trim().toLowerCase())) {
    userAdmin = true;
  }
  if (!userId && !userAdmin) return undefined;
  return { userId: userId ?? '', userAdmin };
}

/** 从完整 API Key 提取前缀（sk_live_ 后的前 12 字符） */
function extractKeyPrefix(fullKey: string): string | null {
  const prefix = 'sk_live_';
  if (!fullKey.startsWith(prefix)) return null;
  const rest = fullKey.slice(prefix.length);
  if (rest.length < 12) return null;
  return prefix + rest.slice(0, 12);
}

// ===== 限流：内存滑动窗口（每分钟一个桶） =====
// 生产可换 Redis；POC 内存足够
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * S-H6：API Key 鉴权失败限流。
 *   原 checkRateLimit 仅在鉴权成功后按 apiKeyId 限流，鉴权失败（keyPrefix 未命中 /
 *   bcrypt 不匹配）无任何节流，攻击者可对 12 字符前缀空间暴力枚举。
 *   现按客户端 IP 维度记录鉴权失败次数，超阈值后直接 429，不再查库/不跑 bcrypt，
 *   兼顾安全与抗 DoS（避免被暴力请求消耗 bcrypt CPU）。
 */
const API_KEY_AUTH_FAIL_LIMIT_PER_MIN = 30;
const authFailBuckets = new Map<string, { count: number; resetAt: number }>();

// L1 修复：保存定时器引用，供优雅停机清理（与 queue.backgroundTimers 模式一致）
//   原实现 setInterval(...).unref?.() 未保存引用，进程可退出但无法主动 clearInterval
let rateLimitSweeperTimer: NodeJS.Timeout | null = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitBuckets) {
    if (v.resetAt < now) rateLimitBuckets.delete(k);
  }
  for (const [k, v] of authFailBuckets) {
    if (v.resetAt < now) authFailBuckets.delete(k);
  }
}, 60_000);
rateLimitSweeperTimer.unref?.();

/** 优雅停机时由 server.ts 调用 */
export function stopAuthTimers(): void {
  if (rateLimitSweeperTimer) {
    clearInterval(rateLimitSweeperTimer);
    rateLimitSweeperTimer = null;
  }
}

function checkRateLimit(apiKeyId: string, limit: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const bucketKey = `${apiKeyId}:${Math.floor(now / RATE_LIMIT_WINDOW_MS)}`;
  const bucket = rateLimitBuckets.get(bucketKey);
  if (!bucket) {
    rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (bucket.count >= limit) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
  }
  bucket.count++;
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * S-H6：检查 IP 是否已因鉴权失败过多被临时封锁。
 *   返回 null 表示放行；返回数字表示需等待的秒数（用于 Retry-After 头）。
 */
function checkAuthFailLimit(ip: string): number | null {
  const now = Date.now();
  const bucket = authFailBuckets.get(ip);
  if (!bucket) return null;
  if (bucket.resetAt < now) {
    authFailBuckets.delete(ip);
    return null;
  }
  if (bucket.count >= API_KEY_AUTH_FAIL_LIMIT_PER_MIN) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  }
  return null;
}

/** S-H6：记录一次鉴权失败；成功时调用 clearAuthFailures 复位 */
function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const bucket = authFailBuckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    authFailBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return;
  }
  bucket.count++;
}

/** S-H6：鉴权成功后清除该 IP 的失败计数 */
function clearAuthFailures(ip: string): void {
  authFailBuckets.delete(ip);
}

export default fp(async (app) => {
  // ===== API Key 鉴权 =====
  app.decorate('authenticateApiKey', async (req: any, reply: any) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '缺少 Authorization 头' });
    }
    const key = auth.slice(7).trim();

    // S-H6：鉴权失败限流——若该 IP 近 1 分钟内鉴权失败已达阈值，直接 429 拦截，
    //   不再查库/不跑 bcrypt，避免被暴力枚举消耗后端资源。
    const failLock = checkAuthFailLimit(req.ip);
    if (failLock !== null) {
      reply.header('Retry-After', failLock);
      return reply.code(429).send({
        error: 'RATE_LIMITED',
        message: '鉴权失败次数过多，请稍后重试',
        retryAfterSec: failLock,
      });
    }

    let authUser: AuthUser | null = null;

    // 数据库查找：按 keyPrefix 索引
    const prefix = extractKeyPrefix(key);
    if (prefix) {
      const dbKey = await prisma.apiKey.findUnique({
        where: { keyPrefix: prefix },
      });
      if (dbKey && dbKey.active && (await bcrypt.compare(key, dbKey.keyHash))) {
        // IP 白名单校验
        // P0 安全修复（中危8）：CIDR 匹配复用 ssrf-guard.ipv4InCidr，原字符串前缀匹配对
        //   非字节对齐前缀（如 /12、/20）严重错误
        if (dbKey.ipWhitelist && dbKey.ipWhitelist.trim() !== '') {
          const ip = req.ip;
          const allowed = dbKey.ipWhitelist
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .some((entry) => {
              if (entry === ip) return true;
              if (entry.includes('/')) {
                const [base, prefixStr] = entry.split('/');
                const prefix = Number(prefixStr);
                return Number.isInteger(prefix) && ipv4InCidr(ip, base, prefix);
              }
              return false;
            });
          if (!allowed) {
            return reply.code(403).send({
              error: 'IP_NOT_ALLOWED',
              message: `IP ${ip} 不在该 API Key 的白名单`,
            });
          }
        }

        // 限流校验
        // P2-3 修复：未配置 rateLimitPerMin 时使用默认限流（60 req/min），
        //   防止单个 API Key 无限调用打满后端
        const DEFAULT_RATE_LIMIT_PER_MIN = 60;
        const effectiveLimit =
          dbKey.rateLimitPerMin && dbKey.rateLimitPerMin > 0
            ? dbKey.rateLimitPerMin
            : DEFAULT_RATE_LIMIT_PER_MIN;
        const rl = checkRateLimit(dbKey.id, effectiveLimit);
        if (!rl.allowed) {
          reply.header('Retry-After', rl.retryAfterSec);
          return reply.code(429).send({
            error: 'RATE_LIMITED',
            message: `请求过于频繁，每分钟限 ${effectiveLimit} 次`,
            retryAfterSec: rl.retryAfterSec,
          });
        }

        // 日配额校验 + 滚动重置
        if (dbKey.quotaPerDay && dbKey.quotaPerDay > 0) {
          const now = new Date();
          // 过期重置
          if (!dbKey.quotaResetAt || dbKey.quotaResetAt < now) {
            const nextReset = new Date(now.getTime() + 24 * 3600 * 1000);
            await prisma.apiKey.update({
              where: { id: dbKey.id },
              data: { quotaUsedDay: 0, quotaResetAt: nextReset },
            });
            dbKey.quotaUsedDay = 0;
            dbKey.quotaResetAt = nextReset;
          }

          // P1-8 修复：原子化配额校验+递增，防止并发请求超配额
          // 原逻辑：先读 quotaUsedDay 校验，再 fire-and-forget 递增，
          //   并发请求都读到旧值，全部通过校验，最终实际调用次数超过配额。
          // 新逻辑：用 updateMany + WHERE quotaUsedDay < quotaPerDay 做条件递增，
          //   count===1 表示抢占到一个配额，count===0 表示已超配额，返回 429
          const claimResult = await prisma.apiKey.updateMany({
            where: {
              id: dbKey.id,
              quotaUsedDay: { lt: dbKey.quotaPerDay },
            },
            data: { quotaUsedDay: { increment: 1 } },
          });

          if (claimResult.count === 0) {
            const retryAfterSec = Math.ceil(
              ((dbKey.quotaResetAt?.getTime() ?? now.getTime()) - now.getTime()) / 1000,
            );
            reply.header('Retry-After', Math.max(1, retryAfterSec));
            return reply.code(429).send({
              error: 'RATE_LIMITED',
              message: `已达日配额 ${dbKey.quotaPerDay} 次，请明天再试`,
              retryAfterSec: Math.max(1, retryAfterSec),
            });
          }
        }

        authUser = {
          type: 'apiKey',
          apiKeyId: dbKey.id,
          tenantId: dbKey.tenantId,
          priority: dbKey.priority,
          scopes: dbKey.scopes
            ? dbKey.scopes.split(',').map((s) => s.trim()).filter(Boolean)
            : [],
          webhookUrlDefault: dbKey.webhookUrlDefault ?? null,
          // 终端用户透传（可选头；charset 受限防注入，长度 ≤64）
          ...(resolveUserHeaders(req) ?? {}),
        };

        // 更新最后使用时间（异步）
        // M5 修复：原 .catch(() => {}) 静默吞错，DB 写入失败不可见
        prisma.apiKey
          .update({ where: { id: dbKey.id }, data: { lastUsedAt: new Date() } })
          .catch((e) => {
            logger.warn({ err: e as Error, apiKeyId: dbKey.id, msg: '更新 lastUsedAt 失败' });
          });
      }
    }

    // 回落到 env 单密钥（POC；仅当 DB 无 active ApiKey 时）
    // P0 修复：
    //   1. 使用恒定时间比较，防时序攻击
    //   2. 生产环境禁用此回落（防止误用单密钥模式）
    if (!authUser && !isProd) {
      const hasDbKey = await prisma.apiKey.count({ where: { active: true } });
      if (hasDbKey === 0 && safeEqual(key, env.API_KEY)) {
        const hashValid =
          env.API_KEY_BCRYPT_HASH === '' ||
          (await bcrypt.compare(key, env.API_KEY_BCRYPT_HASH));
        if (hashValid) {
          authUser = {
            type: 'apiKey',
            tenantId: 'default',
            priority: 5,
            scopes: [],
          };
        }
      }
    }

    if (!authUser) {
      // S-H6：记录鉴权失败，累计超阈值后下次请求直接 429
      recordAuthFailure(req.ip);
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'API Key 无效' });
    }

    // S-H6：鉴权成功，清除该 IP 的失败计数
    clearAuthFailures(req.ip);
    req.user = authUser;
  });

  // ===== 作用域守卫 =====
  app.decorate('requireScope', (scope: string) => {
    return async (req: any, reply: any) => {
      const u = req.user as AuthUser | undefined;
      if (!u || u.type !== 'apiKey') {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '需要 API Key 鉴权' });
      }
      // 空作用域表示全部权限
      if (!u.scopes || u.scopes.length === 0) return;
      if (!u.scopes.includes(scope)) {
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: `API Key 缺少作用域: ${scope}`,
        });
      }
    };
  });

  // ===== Worker Token 鉴权 =====
  // P0 修复：
  //   1. DB 存 token 的 SHA-256 hash，按 hash 索引查询，避免明文落库
  //   2. 校验 sessionActive，防止 forceOffline 后旧 token 继续可用
  //   3. 查询命中后用恒定时间比较 hash，防止时序侧信道
  app.decorate('authenticateWorker', async (req: any, reply: any) => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '缺少 Worker 令牌' });
    }
    const token = auth.slice(7).trim();
    const tokenHash = sha256(token);

    const worker = await prisma.worker.findFirst({
      where: { accessTokenHash: tokenHash },
    });

    if (!worker) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Worker 令牌无效' });
    }

    if (!worker.sessionActive) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Worker 已被强制下线，请重新注册' });
    }

    if (worker.tokenExpiresAt && worker.tokenExpiresAt < new Date()) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Worker 令牌已过期' });
    }

    req.user = {
      type: 'worker',
      workerId: worker.id,
      workerCode: worker.code,
    } as AuthUser;
  });
});

// 用于在其他模块中抛出鉴权相关业务错误
export { Errors } from '../lib/errors.js';
