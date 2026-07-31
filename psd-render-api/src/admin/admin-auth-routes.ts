/**
 * Admin 鉴权路由（第三期 M3）
 *
 * 路由：
 *   - GET  /admin/login           登录页（HTML）
 *   - POST /admin/api/login       登录（用户名+密码 → set-cookie）
 *   - POST /admin/api/logout      登出（清除 cookie + 删除 session）
 *   - GET  /admin/api/me          当前登录用户信息
 *   - GET  /admin/api/admin-users 用户列表（admin 角色）
 *   - POST /admin/api/admin-users 创建用户（admin 角色）
 *   - POST /admin/api/admin-users/:id/disable  禁用（admin 角色）
 *   - POST /admin/api/admin-users/:id/enable   启用（admin 角色）
 *   - POST /admin/api/admin-users/:id/password 管理员重置他人密码（admin 角色，禁止重置自己）
 *   - POST /admin/api/me/password              修改自己的密码（验证当前密码）
 *   - POST /admin/api/admin-users/:id/role     修改角色（admin 角色）
 *
 * 注：这些路由前缀是 /admin（在 server.ts 中以 prefix: '/admin' 注册）
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { adminAuthService } from '../services/admin/admin-auth-service.js';
import {
  buildAdminCookie,
  buildClearAdminCookie,
} from '../plugins/admin-auth.js';
import { auditService } from '../services/audit/audit-service.js';
import { loginPageHtml } from './login-page.js';
import type { AdminRole } from '../types/index.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

// P1-12 修复：密码策略加强——最少 12 位，至少包含 3 类字符（大写/小写/数字/特殊符号）
// 原 min(8) 过于宽松，结合 P1-4 暴力破解防护虽能挡住在线爆破，
// 但离线攻击（DB 泄露后 bcrypt 爆破）仍依赖密码强度
const strongPasswordSchema = z
  .string()
  .min(12)
  .max(128)
  .refine((pw) => {
    let categoryCount = 0;
    if (/[a-z]/.test(pw)) categoryCount++;
    if (/[A-Z]/.test(pw)) categoryCount++;
    if (/[0-9]/.test(pw)) categoryCount++;
    if (/[^a-zA-Z0-9]/.test(pw)) categoryCount++;
    return categoryCount >= 3;
  }, '密码必须至少 12 位，且包含大写/小写/数字/特殊符号中的至少 3 类');

const createUserSchema = z.object({
  username: z.string().min(2).max(64),
  password: strongPasswordSchema,
  role: z.enum(['admin', 'operator', 'viewer']),
});

const changePasswordSchema = z.object({
  password: strongPasswordSchema,
});

// P0 安全修复：自改密码需要当前密码
const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: strongPasswordSchema,
});

const changeRoleSchema = z.object({
  role: z.enum(['admin', 'operator', 'viewer']),
});

export async function adminAuthRoutes(app: FastifyInstance) {
  // ===== 公开路由 =====

  // 登录页
  app.get('/login', async (_req, reply) => {
    reply.type('text/html').send(loginPageHtml);
  });

  // 登录接口
  app.post('/api/login', {
    schema: {
      tags: ['admin-auth'],
      summary: '管理员登录',
      description: '使用用户名+密码登录，成功后通过 set-cookie 返回 admin_session，并返回当前用户信息。失败统一返回 401（不泄露具体原因）；触发暴力破解防护时返回 429。',
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 64, description: '用户名' },
          password: { type: 'string', minLength: 1, maxLength: 128, description: '密码' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            user: {
              type: 'object',
              description: '当前登录用户信息',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
                active: { type: 'boolean' },
                lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
                lastLoginIp: { type: 'string', nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
            expiresAt: { type: 'string', format: 'date-time', description: 'Session 过期时间' },
          },
        },
        401: { $ref: 'ErrorResponse#' },
        429: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '用户名或密码格式不正确',
        details: parsed.error.issues,
      });
    }
    const ip = req.ip;
    const userAgent = req.headers['user-agent'];
    try {
      const result = await adminAuthService.login({
        username: parsed.data.username,
        password: parsed.data.password,
        ip,
        userAgent,
      });
      reply.header('set-cookie', buildAdminCookie(result.token, result.expiresAt));
      auditService.record({
        action: 'admin_login',
        actor: result.user.username,
        actorIp: ip,
        actorUa: userAgent,
        refType: 'admin_user',
        refId: result.user.id,
        message: `管理员登录: ${result.user.username}`,
      });
      return reply.send({
        ok: true,
        user: result.user,
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (e: any) {
      // P2-4 修复：登录失败统一返回 "用户名或密码错误"，不泄露内部错误细节
      // （DB 错误、bcrypt 异常等不应通过响应暴露给客户端）
      // 同时审计日志记录真实原因便于运维排查
      const isAuthError = e?.code === 'UNAUTHORIZED' || e?.code === 'RATE_LIMITED';
      const auditMsg = isAuthError
        ? (e.message ?? '未知原因')
        : `登录异常: ${e.message ?? '未知原因'}`;
      auditService.record({
        action: 'admin_login',
        actor: parsed.data.username,
        actorIp: ip,
        actorUa: userAgent,
        result: 'failure',
        message: `登录失败: ${auditMsg}`,
      });
      // 限流错误单独返回 429
      if (e?.code === 'RATE_LIMITED') {
        return reply.code(429).send({
          error: 'RATE_LIMITED',
          message: e.message ?? '请求过于频繁',
        });
      }
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: '用户名或密码错误',
      });
    }
  });

  // ===== 以下路由需登录 =====

  // 登出
  app.post('/api/logout', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-auth'],
      summary: '管理员登出',
      description: '清除当前 session（cookie 与 DB 记录），返回清除 cookie 的 set-cookie 头。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
      },
    },
  }, async (req, reply) => {
    // 从 cookie / Authorization 提取 token 删除
    const cookie = req.headers.cookie;
    let token: string | null = null;
    if (cookie && typeof cookie === 'string') {
      for (const part of cookie.split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === 'admin_session' && v.length > 0) {
          token = v.join('=').trim();
          break;
        }
      }
    }
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.slice(7).trim();
    }
    if (token) {
      await adminAuthService.logout(token);
    }
    reply.header('set-cookie', buildClearAdminCookie());
    auditService.recordFromReq(req, {
      action: 'admin_logout',
      refType: 'admin_user',
      message: `管理员登出`,
    });
    return reply.send({ ok: true });
  });

  // 当前用户信息
  app.get('/api/me', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-auth'],
      summary: '获取当前登录用户',
      description: '返回当前 session 对应的管理员用户信息（id/username/role/active）。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
                active: { type: 'boolean' },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    return reply.send({ user: req.adminUser });
  });

  // ===== 用户管理（仅 admin 角色） =====

  // 用户列表
  app.get('/api/admin-users', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-users'],
      summary: '管理员用户列表',
      description: '返回所有管理员用户（不含密码哈希）。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            users: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  username: { type: 'string' },
                  role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
                  active: { type: 'boolean' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        403: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (_req, reply) => {
    const users = await adminAuthService.listUsers();
    return reply.send({ users });
  });

  // 创建用户
  app.post('/api/admin-users', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-users'],
      summary: '创建管理员用户',
      description: '创建新的管理员账号。密码需 ≥12 位且包含大写/小写/数字/特殊符号中的至少 3 类。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        required: ['username', 'password', 'role'],
        properties: {
          username: { type: 'string', minLength: 2, maxLength: 64, description: '用户名' },
          password: { type: 'string', minLength: 12, maxLength: 128, description: '密码（≥12 位，至少 3 类字符）' },
          role: { type: 'string', enum: ['admin', 'operator', 'viewer'], description: '角色' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
                active: { type: 'boolean' },
              },
            },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        403: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = createUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    const user = await adminAuthService.createUser({
      username: parsed.data.username,
      password: parsed.data.password,
      role: parsed.data.role as AdminRole,
    });
    auditService.recordFromReq(req, {
      action: 'admin_user_create',
      refType: 'admin_user',
      refId: user.id,
      message: `创建管理员用户: ${user.username} (role=${user.role})`,
      meta: { username: user.username, role: user.role },
    });
    return reply.code(201).send({ user });
  });

  // 禁用用户
  app.post('/api/admin-users/:id/disable', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-users'],
      summary: '禁用管理员用户',
      description: '将管理员用户设为 active=false，立即拒绝其登录与访问。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '用户 ID' } } },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    await adminAuthService.setActive(id, false);
    auditService.recordFromReq(req, {
      action: 'admin_user_disable',
      refType: 'admin_user',
      refId: id,
      message: `禁用管理员用户: ${id}`,
    });
    return reply.send({ ok: true });
  });

  // 启用用户
  app.post('/api/admin-users/:id/enable', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-users'],
      summary: '启用管理员用户',
      description: '将管理员用户设为 active=true，恢复其登录与访问能力。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '用户 ID' } } },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        403: { $ref: 'ErrorResponse#' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    await adminAuthService.setActive(id, true);
    auditService.recordFromReq(req, {
      action: 'admin_user_enable',
      refType: 'admin_user',
      refId: id,
      message: `启用管理员用户: ${id}`,
    });
    return reply.send({ ok: true });
  });

  // P0 安全修复：自改密码（需验证当前密码）—— 所有已登录角色可用
  //   会话被劫持时，攻击者不知道当前密码，无法改密锁定真实用户
  app.post('/api/me/password', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-auth'],
      summary: '修改自己的密码',
      description: '修改当前登录用户的密码，需验证当前密码。新密码需 ≥12 位且包含大写/小写/数字/特殊符号中的至少 3 类。所有已登录角色可调用。',
      security: [{ adminSession: [] }],
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', description: '当前密码' },
          newPassword: { type: 'string', minLength: 12, maxLength: 128, description: '新密码（≥12 位，至少 3 类字符）' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const parsed = changeOwnPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '入参校验失败',
        details: parsed.error.issues,
      });
    }
    // P0-B 修复：原代码 (req as any).adminUser.userId 恒为 undefined（AdminAuthUser 接口
    //   仅有 id/username/role，requireAdminAuth 注入的也是 id），导致：
    //   1. /api/me/password 接口彻底不可用（findUnique({where:{id:undefined}}) 抛错）
    //   2. /api/admin-users/:id/password 的"禁止重置自己"保护被绕过（operatorId === undefined
    //      恒为 false，会话被劫持的攻击者可直接重置自己密码锁定真实管理员）
    //   3. 审计日志"操作者: undefined"字段缺失
    //   修复：改用 req.adminUser.id（与 AdminAuthUser 接口对齐），移除 as any 断言
    const userId = req.adminUser!.id;
    await adminAuthService.changeOwnPassword(
      userId,
      parsed.data.currentPassword,
      parsed.data.newPassword,
    );
    auditService.recordFromReq(req, {
      action: 'admin_user_password_self',
      refType: 'admin_user',
      refId: userId,
      message: '修改自己的密码（验证了当前密码）',
    });
    return reply.send({ ok: true });
  });

  // 管理员重置他人密码（admin 角色专用）
  //   P0 安全修复：禁止重置自己（自改必须走 /api/me/password）
  app.post('/api/admin-users/:id/password', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-users'],
      summary: '管理员重置他人密码',
      description: '管理员重置指定用户的密码。禁止重置自己的密码（自改必须走 /api/me/password）。新密码需 ≥12 位且包含大写/小写/数字/特殊符号中的至少 3 类。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '目标用户 ID' } } },
      body: {
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', minLength: 12, maxLength: 128, description: '新密码（≥12 位，至少 3 类字符）' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: { $ref: 'ErrorResponse#' },
        403: { $ref: 'ErrorResponse#' },
        409: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '密码至少 12 位，且包含大写/小写/数字/特殊符号中的至少 3 类',
        details: parsed.error.issues,
      });
    }
    // P0-B 修复：同上，原 (req as any).adminUser.userId 恒为 undefined，导致
    //   admin-auth-service.ts 中 `targetUserId === operatorUserId` 始终 false，
    //   "禁止重置自己密码"的保护被完全消解。改用 req.adminUser.id。
    const operatorId = req.adminUser!.id;
    await adminAuthService.resetPasswordByAdmin(id, parsed.data.password, operatorId);
    auditService.recordFromReq(req, {
      action: 'admin_user_password_reset',
      refType: 'admin_user',
      refId: id,
      message: `管理员重置他人密码: ${id}（操作者: ${operatorId}）`,
    });
    return reply.send({ ok: true });
  });

  // 修改角色
  app.post('/api/admin-users/:id/role', {
    preHandler: [app.requireAdminAuth, app.requireRole('admin')],
    schema: {
      tags: ['admin-users'],
      summary: '修改管理员角色',
      description: '修改指定管理员的角色（admin / operator / viewer）。仅 admin 角色可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '目标用户 ID' } } },
      body: {
        type: 'object',
        required: ['role'],
        properties: {
          role: { type: 'string', enum: ['admin', 'operator', 'viewer'], description: '新角色' },
        },
      },
      response: {
        200: { type: 'object', properties: { ok: { type: 'boolean' } } },
        400: { $ref: 'ErrorResponse#' },
        403: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '角色无效',
        details: parsed.error.issues,
      });
    }
    await adminAuthService.setRole(id, parsed.data.role as AdminRole);
    auditService.recordFromReq(req, {
      action: 'admin_user_role',
      refType: 'admin_user',
      refId: id,
      message: `修改管理员角色: ${id} → ${parsed.data.role}`,
      meta: { newRole: parsed.data.role },
    });
    return reply.send({ ok: true });
  });
}
