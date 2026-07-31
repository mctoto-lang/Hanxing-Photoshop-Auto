/**
 * Admin 鉴权插件（第三期 M3）
 *
 * 提供：
 *   - requireAdminAuth：从 Cookie 或 Authorization 头读 session token，校验并注入 req.adminUser
 *   - requireRole(role)：角色守卫，需先通过 requireAdminAuth
 *   - ipWhitelist：IP 白名单前置校验（若配置）
 *
 * Cookie 形态：admin_session=<token>; HttpOnly; Path=/admin; SameSite=Strict
 * 也支持 Authorization: Bearer <token>（编程调用场景）
 *
 * 当 env.ADMIN_AUTH_ENABLED = false 时降级为 POC 模式（不鉴权），生产必须为 true。
 */
import fp from 'fastify-plugin';
import { env, isIpAllowed } from '../config/env.js';
import { adminAuthService } from '../services/admin/admin-auth-service.js';
import type { AdminRole } from '../types/index.js';
import { hasAdminRole } from '../types/index.js';

export interface AdminAuthUser {
  id: string;
  username: string;
  role: AdminRole;
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAdminAuth: (req: any, reply: any) => Promise<void>;
    requireRole: (role: AdminRole) => (req: any, reply: any) => Promise<void>;
    adminIpGuard: (req: any, reply: any) => Promise<void>;
  }
  interface FastifyRequest {
    adminUser?: AdminAuthUser;
  }
}

const COOKIE_NAME = 'admin_session';

function extractToken(req: any): string | null {
  // 1. Cookie
  const cookie = req.headers.cookie;
  if (cookie && typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === COOKIE_NAME && v.length > 0) {
        return v.join('=').trim();
      }
    }
  }
  // 2. Authorization Bearer
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export function buildAdminCookie(token: string, expiresAt: Date): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/admin',
    'HttpOnly',
    // S-H5：Strict 比 Lax 更严——禁止任何跨站请求携带（含顶级导航），
    //   彻底阻断 CSRF。同 eTLD+1 下的子域（如 admin.x.com ↔ api.x.com）
    //   仍属同站，cookie 正常携带，不影响 Admin UI 跨子域调用。
    'SameSite=Strict',
    `Max-Age=${Math.floor((expiresAt.getTime() - Date.now()) / 1000)}`,
  ];
  if (env.NODE_ENV === 'production') parts.push('Secure');
  if (env.ADMIN_COOKIE_DOMAIN) parts.push(`Domain=${env.ADMIN_COOKIE_DOMAIN}`);
  return parts.join('; ');
}

export function buildClearAdminCookie(): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/admin',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (env.NODE_ENV === 'production') parts.push('Secure');
  if (env.ADMIN_COOKIE_DOMAIN) parts.push(`Domain=${env.ADMIN_COOKIE_DOMAIN}`);
  return parts.join('; ');
}

export default fp(async (app) => {
  // IP 白名单守卫（保留独立 decorate 以兼容已有路由显式调用）
  app.decorate('adminIpGuard', async (req: any, reply: any) => {
    if (!env.ADMIN_AUTH_ENABLED) return;
    if (env.ADMIN_IP_WHITELIST === '') return;
    const ip = req.ip;
    if (!isIpAllowed(ip)) {
      return reply.code(403).send({
        error: 'IP_NOT_ALLOWED',
        message: `IP ${ip} 不在 Admin 白名单`,
      });
    }
  });

  // Admin 鉴权守卫
  // M6 修复：原 adminIpGuard 是独立 decorate，需路由 preHandler 链显式调用，易遗漏——
  //   若某路由忘记挂则 IP 白名单失效。现改为在 requireAdminAuth 内自动调用 IP 校验，
  //   确保所有走 requireAdminAuth 的路由都会被 IP 白名单保护。
  app.decorate('requireAdminAuth', async (req: any, reply: any) => {
    // POC 模式：不鉴权（env.ts 已强制生产必须 ADMIN_AUTH_ENABLED=true）
    if (!env.ADMIN_AUTH_ENABLED) {
      req.adminUser = {
        id: 'poc-admin',
        username: 'poc',
        role: 'admin' as AdminRole,
      };
      return;
    }

    // IP 白名单校验（内嵌，避免路由忘记挂 adminIpGuard）
    if (env.ADMIN_IP_WHITELIST !== '') {
      const ip = req.ip;
      if (!isIpAllowed(ip)) {
        return reply.code(403).send({
          error: 'IP_NOT_ALLOWED',
          message: `IP ${ip} 不在 Admin 白名单`,
        });
      }
    }

    const token = extractToken(req);
    if (!token) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录' });
    }
    const user = await adminAuthService.validateSession(token);
    if (!user) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '会话已过期，请重新登录' });
    }
    req.adminUser = {
      id: user.id,
      username: user.username,
      role: user.role,
    };
  });

  // 角色守卫工厂
  app.decorate('requireRole', (role: AdminRole) => {
    return async (req: any, reply: any) => {
      // POC 模式：直接通过
      if (!env.ADMIN_AUTH_ENABLED) return;
      const user = req.adminUser as AdminAuthUser | undefined;
      if (!user) {
        return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录' });
      }
      if (!hasAdminRole(user.role, role)) {
        return reply.code(403).send({
          error: 'FORBIDDEN',
          message: `需要 ${role} 及以上权限`,
        });
      }
    };
  });
});
