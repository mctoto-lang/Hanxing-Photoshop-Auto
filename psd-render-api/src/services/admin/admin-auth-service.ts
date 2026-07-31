/**
 * 管理员鉴权服务（第三期 M3）
 *
 * 职责：
 *   - 用户管理（创建/禁用/改密/列表）
 *   - 登录：bcrypt 校验 + 创建 AdminSession
 *   - session 校验：按 token 查询未过期 session
 *   - 登出：删除 session
 *   - 启动引导：DB 无管理员时按 env.ADMIN_BOOTSTRAP_* 创建初始管理员
 *
 * Session 形态：
 *   - token 为 32 字节随机 hex（64 字符）
 *   - 通过 HttpOnly Cookie 传递（admin_session=<token>）
 *   - 也支持 Authorization: Bearer <token>（API 调用场景）
 *
 * 角色层次：admin(3) > operator(2) > viewer(1)
 */
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';
import { sha256 } from '../../lib/crypto.js';
import type { AdminRole } from '../../types/index.js';

// P0 安全修复（低危12）：bcrypt rounds 从 10 提升至 12
//   10 轮约 100ms，12 轮约 300ms——对单次登录可接受，对暴力破解成本提升 4 倍
const BCRYPT_ROUNDS = 12;
const SESSION_TOKEN_BYTES = 32;

/**
 * S-H7：dummy bcrypt hash，用于「用户不存在」分支消耗与「用户存在但密码错」
 *   分支等量的 bcrypt.compare 时间，消除时序侧信道导致的管理员账号枚举。
 *
 *   原实现：用户不存在时直接 throw（<1ms），用户存在但密码错时跑 bcrypt.compare（~300ms），
 *   攻击者通过响应时间差异判断用户名是否有效。
 *   修复：不存在分支也跑一次 bcrypt.compare(input, DUMMY_HASH)，两分支耗时一致。
 *
 *   hashSync 在模块加载时执行一次（~300ms），不影响运行时每次请求的性能。
 */
const DUMMY_BCRYPT_HASH = bcrypt.hashSync('dummy-password-for-timing-equalization', BCRYPT_ROUNDS);

// P0 安全修复：管理员密码策略——最少 12 位，且包含大写/小写/数字/特殊符号中的至少 3 类
//   原 admin-auth-routes.ts 中的 strongPasswordSchema 仅在 HTTP 入口校验，
//   bootstrap / createUser / changePassword 等内部入口未校验，
//   可被绕过创建弱口令账号（典型场景：env.ADMIN_BOOTSTRAP_PASSWORD=admin12345）。
//   现抽取为纯函数，所有写入密码的入口统一调用。
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 128;

export function validatePasswordStrength(password: string): { ok: boolean; reason?: string } {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `密码至少 ${MIN_PASSWORD_LENGTH} 位` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `密码不能超过 ${MAX_PASSWORD_LENGTH} 位` };
  }
  let categoryCount = 0;
  if (/[a-z]/.test(password)) categoryCount++;
  if (/[A-Z]/.test(password)) categoryCount++;
  if (/[0-9]/.test(password)) categoryCount++;
  if (/[^a-zA-Z0-9]/.test(password)) categoryCount++;
  if (categoryCount < 3) {
    return { ok: false, reason: '密码必须包含大写/小写/数字/特殊符号中的至少 3 类' };
  }
  return { ok: true };
}

/** 断言式密码校验：不通过抛 ValidationError */
function assertPasswordStrength(password: string): void {
  const r = validatePasswordStrength(password);
  if (!r.ok) throw Errors.validationError(r.reason ?? '密码强度不足');
}

// P1-4：登录暴力破解防护
// 滑动窗口：5 分钟内同一 IP+username 组合失败 5 次则锁定 15 分钟
const LOGIN_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 5;
const LOGIN_RATE_LIMIT_LOCK_MS = 15 * 60 * 1000;
// 内存存储（单实例足够；多实例需用 Redis）
const loginFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

/**
 * P2-I：IP 维度二级登录限流
 *
 * 原限流 key 为 IP+username，攻击者从单一 IP 可对 N 个用户名各尝试 5 次
 *   （如 100 个用户名 × 5 次 = 500 次尝试），足以在弱密码场景下爆破成功。
 *
 * 新增纯 IP 维度二级限流：同一 IP 1 小时内总失败 ≥20 次即锁 30 分钟，
 *   覆盖所有用户名的失败总和，有效阻断用户名轮换爆破。
 *
 * 注意：IP 级失败计数不在登录成功时清除——防止攻击者用已知凭证周期性
 *   "成功一次"来重置计数器后继续爆破其他用户名。
 *   计数仅通过时间窗口自然过期。
 */
const LOGIN_IP_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 小时
const LOGIN_IP_RATE_LIMIT_MAX_FAILURES = 20; // 同一 IP 1h 内总失败上限
const LOGIN_IP_RATE_LIMIT_LOCK_MS = 30 * 60 * 1000; // 锁定 30 分钟
const loginIpFailures = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

/** P1-4：检查登录限流；返回 true 表示放行，false 表示已锁定 */
function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (rec && rec.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

/** P1-4：记录登录失败；达到阈值则锁定 */
function recordLoginFailure(key: string): void {
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (!rec || now - rec.firstAt > LOGIN_RATE_LIMIT_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  rec.count++;
  if (rec.count >= LOGIN_RATE_LIMIT_MAX_FAILURES) {
    rec.lockedUntil = now + LOGIN_RATE_LIMIT_LOCK_MS;
    logger.warn({ key, msg: 'Admin 登录被限流锁定', lockMs: LOGIN_RATE_LIMIT_LOCK_MS });
  }
}

/** P1-4：登录成功后清除失败计数 */
function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}

/** P2-I：检查 IP 维度二级限流 */
function checkLoginIpRateLimit(ip: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const rec = loginIpFailures.get(ip);
  if (rec && rec.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - now) / 1000) };
  }
  return { allowed: true };
}

/** P2-I：记录 IP 维度登录失败；达到阈值则锁定该 IP */
function recordLoginIpFailure(ip: string): void {
  const now = Date.now();
  const rec = loginIpFailures.get(ip);
  if (!rec || now - rec.firstAt > LOGIN_IP_RATE_LIMIT_WINDOW_MS) {
    loginIpFailures.set(ip, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }
  rec.count++;
  if (rec.count >= LOGIN_IP_RATE_LIMIT_MAX_FAILURES) {
    rec.lockedUntil = now + LOGIN_IP_RATE_LIMIT_LOCK_MS;
    logger.warn({
      ip,
      failCount: rec.count,
      msg: 'Admin 登录 IP 维度限流锁定（疑似用户名轮换爆破）',
      lockMs: LOGIN_IP_RATE_LIMIT_LOCK_MS,
    });
  }
}

export interface AdminUserPublic {
  id: string;
  username: string;
  role: AdminRole;
  active: boolean;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: Date;
}

export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: AdminUserPublic;
}

function toPublic(u: any): AdminUserPublic {
  return {
    id: u.id,
    username: u.username,
    role: u.role as AdminRole,
    active: u.active,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    lastLoginIp: u.lastLoginIp,
    createdAt: u.createdAt,
  };
}

class AdminAuthService {
  /**
   * 启动时引导创建初始管理员（仅当 DB 无 active 管理员时）
   *
   * P0 安全修复：对 ADMIN_BOOTSTRAP_PASSWORD 强制走强密码策略校验，
   *   不满足则抛错并阻止创建（server.ts 中 .catch 仅记录日志，但 env.ts
   *   的跨字段校验也会在更早阶段拦截 POC 弱口令）。
   *   防止 .env 中误配 admin12345 等弱口令被直接创建为管理员账号。
   */
  async bootstrap(): Promise<void> {
    const count = await prisma.adminUser.count({
      where: { active: true },
    });
    if (count > 0) return;

    const username = env.ADMIN_BOOTSTRAP_USERNAME || 'admin';
    const password = env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!password) {
      logger.warn({
        msg: 'Admin 引导跳过：DB 无管理员且未配置 ADMIN_BOOTSTRAP_PASSWORD',
      });
      return;
    }

    // P0：强密码策略校验，与 HTTP 入口 createUser 保持一致
    const strength = validatePasswordStrength(password);
    if (!strength.ok) {
      // 抛错而非 warn 跳过——避免运维误以为引导成功
      throw new Error(
        `ADMIN_BOOTSTRAP_PASSWORD 不满足强密码策略: ${strength.reason}（要求：≥12 位且包含大写/小写/数字/特殊符号中的至少 3 类）`,
      );
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await prisma.adminUser.create({
      data: { username, passwordHash, role: 'admin', active: true },
    });
    logger.info({ username, msg: 'Admin 引导：已创建初始管理员账号' });
  }

  /**
   * 登录
   * - 用户名 + 密码
   * - 成功：创建 AdminSession，返回 token + user
   * - 失败：抛 UNAUTHORIZED
   * - P1-4：IP+username 维度暴力破解防护
   * - P2-I：IP 维度二级限流（防用户名轮换爆破）
   */
  async login(params: {
    username: string;
    password: string;
    ip?: string;
    userAgent?: string;
  }): Promise<LoginResult> {
    const clientIp = params.ip || 'unknown';

    // P2-I：先检查 IP 维度二级限流（优先级最高，防用户名轮换爆破）
    const ipRl = checkLoginIpRateLimit(clientIp);
    if (!ipRl.allowed) {
      throw Errors.rateLimited(`该 IP 登录尝试过于频繁，请 ${ipRl.retryAfterSec}s 后重试`);
    }

    // P1-4：再检查 IP+username 维度限流
    const rlKey = `${clientIp}:${params.username}`;
    const rl = checkLoginRateLimit(rlKey);
    if (!rl.allowed) {
      throw Errors.rateLimited(`登录尝试过于频繁，请 ${rl.retryAfterSec}s 后重试`);
    }

    const user = await prisma.adminUser.findUnique({
      where: { username: params.username },
    });
    // 统一错误，避免用户枚举
    if (!user || !user.active) {
      // S-H7：跑一次 dummy bcrypt.compare，使「用户不存在」与「用户存在但密码错」
      //   两个分支的响应时间一致（均约 300ms），防时序侧信道枚举管理员账号。
      await bcrypt.compare(params.password, DUMMY_BCRYPT_HASH);
      recordLoginFailure(rlKey);
      // P2-I：同时记录 IP 维度失败
      recordLoginIpFailure(clientIp);
      throw Errors.unauthorized('用户名或密码错误');
    }
    const ok = await bcrypt.compare(params.password, user.passwordHash);
    if (!ok) {
      recordLoginFailure(rlKey);
      // P2-I：同时记录 IP 维度失败
      recordLoginIpFailure(clientIp);
      throw Errors.unauthorized('用户名或密码错误');
    }

    // P1-4：登录成功清除 IP+username 维度失败计数
    // P2-I：IP 维度失败计数不清除（防攻击者用已知凭证重置计数器后继续爆破）
    clearLoginFailures(rlKey);

    const token = randomBytes(SESSION_TOKEN_BYTES).toString('hex');
    const tokenHash = sha256(token); // P1-3：DB 存 hash
    const expiresAt = new Date(Date.now() + env.ADMIN_SESSION_TTL_HOURS * 3600 * 1000);

    await prisma.$transaction([
      prisma.adminSession.create({
        data: {
          // P0 安全修复：不再写入明文 token 字段，仅存 tokenHash。
          //   token 字段保留为 NULL（schema 已改为可空），
          //   防止 DB 泄露时攻击者直接读取 token 列冒充管理员。
          tokenHash,
          adminUserId: user.id,
          expiresAt,
          ip: params.ip ?? null,
          userAgent: params.userAgent ?? null,
        },
      }),
      prisma.adminUser.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: params.ip ?? null },
      }),
    ]);

    logger.info({ userId: user.id, username: user.username, ip: params.ip, msg: 'Admin 登录成功' });
    return { token, expiresAt, user: toPublic(user) };
  }

  /** 登出（删除 session） */
  async logout(token: string): Promise<void> {
    // P1-3：按 hash 删除，避免明文 token 在 WHERE 中传递
    const tokenHash = sha256(token);
    await prisma.adminSession.deleteMany({ where: { tokenHash } });
  }

  /**
   * 校验 session token
   * - 返回 user（含 role），失败返回 null
   * - 同时清理过期 session
   * - P1-3：按 tokenHash 索引查询，避免明文 token 落库
   */
  async validateSession(token: string): Promise<AdminUserPublic | null> {
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = await prisma.adminSession.findFirst({
      where: { tokenHash },
      include: { adminUser: true },
    });
    if (!session) return null;
    if (session.expiresAt < new Date()) {
      await prisma.adminSession.delete({ where: { id: session.id } }).catch(() => {});
      return null;
    }
    if (!session.adminUser.active) {
      return null;
    }
    return toPublic(session.adminUser);
  }

  /** 清理过期 session（定时调用） */
  async reapExpiredSessions(): Promise<number> {
    const result = await prisma.adminSession.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  }

  // ============== 用户管理 ==============

  async createUser(params: {
    username: string;
    password: string;
    role: AdminRole;
  }): Promise<AdminUserPublic> {
    const existing = await prisma.adminUser.findUnique({
      where: { username: params.username },
    });
    if (existing) {
      throw Errors.validationError(`用户名已存在: ${params.username}`);
    }
    // P0：内部入口也走强密码策略，防止绕过 HTTP zod schema
    assertPasswordStrength(params.password);
    const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
    const user = await prisma.adminUser.create({
      data: {
        username: params.username,
        passwordHash,
        role: params.role,
        active: true,
      },
    });
    logger.info({ userId: user.id, username: user.username, role: user.role, msg: 'Admin 用户已创建' });
    return toPublic(user);
  }

  async listUsers(): Promise<AdminUserPublic[]> {
    const users = await prisma.adminUser.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return users.map(toPublic);
  }

  async setActive(userId: string, active: boolean): Promise<void> {
    // 防止禁用最后一个 active admin
    if (!active) {
      const target = await prisma.adminUser.findUnique({ where: { id: userId } });
      if (!target) throw Errors.notFound('用户不存在');
      if (target.role === 'admin') {
        const adminCount = await prisma.adminUser.count({
          where: { role: 'admin', active: true },
        });
        if (adminCount <= 1) {
          throw Errors.validationError('不能禁用最后一个 active admin');
        }
      }
    }
    await prisma.adminUser.update({
      where: { id: userId },
      data: { active },
    });
    // 禁用时清理所有 session
    if (!active) {
      await prisma.adminSession.deleteMany({ where: { adminUserId: userId } });
    }
  }

  /**
   * 管理员重置他人密码（admin 角色专用）
   * - 不需要当前密码（管理员强制重置场景）
   * - P0 安全修复：禁止重置自己（自改必须走 changeOwnPassword，验证当前密码）
   *   防止会话被劫持后攻击者直接改密锁定真实用户
   */
  async resetPasswordByAdmin(
    targetUserId: string,
    newPassword: string,
    operatorUserId: string,
  ): Promise<void> {
    if (targetUserId === operatorUserId) {
      throw Errors.validationError('不能重置自己的密码，请使用修改密码接口（需验证当前密码）');
    }
    assertPasswordStrength(newPassword);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.adminUser.update({
      where: { id: targetUserId },
      data: { passwordHash },
    });
    // 改密后该用户所有 session 失效
    await prisma.adminSession.deleteMany({ where: { adminUserId: targetUserId } });
  }

  /**
   * 用户修改自己的密码
   * - P0 安全修复：必须验证当前密码，防止会话劫持后改密
   * - 验证通过后改密并清除该用户所有 session（含当前会话，强制重新登录）
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await prisma.adminUser.findUnique({ where: { id: userId } });
    if (!user || !user.active) {
      throw Errors.unauthorized('用户不存在或已禁用');
    }
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw Errors.unauthorized('当前密码错误');
    }
    // 新密码不能与当前密码相同
    if (currentPassword === newPassword) {
      throw Errors.validationError('新密码不能与当前密码相同');
    }
    assertPasswordStrength(newPassword);
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await prisma.adminUser.update({
      where: { id: userId },
      data: { passwordHash },
    });
    // 改密后所有 session 失效（含当前会话）
    await prisma.adminSession.deleteMany({ where: { adminUserId: userId } });
  }

  async setRole(userId: string, role: AdminRole): Promise<void> {
    // 防止把最后一个 admin 降级
    const target = await prisma.adminUser.findUnique({ where: { id: userId } });
    if (!target) throw Errors.notFound('用户不存在');
    if (target.role === 'admin' && role !== 'admin') {
      const adminCount = await prisma.adminUser.count({
        where: { role: 'admin', active: true },
      });
      if (adminCount <= 1) {
        throw Errors.validationError('不能降级最后一个 admin');
      }
    }
    await prisma.adminUser.update({
      where: { id: userId },
      data: { role },
    });
  }
}

export const adminAuthService = new AdminAuthService();
