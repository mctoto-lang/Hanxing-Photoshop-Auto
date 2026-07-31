/**
 * Admin 审计日志查询路由（第三期 M2）
 *
 * 路由：
 *   - GET  /admin/api/audit-logs         分页查询（支持 action/actor/refType/refId/result/startTime/endTime 筛选）
 *   - GET  /admin/api/audit-logs/:id     单条详情
 *   - GET  /admin/api/audit-logs/stats   按 action 聚合统计（默认最近 7 天）
 *
 * 权限：viewer+ 即可查询（审计日志对所有管理员可见，便于追溯）
 */
import { FastifyInstance } from 'fastify';
import { auditService } from '../services/audit/audit-service.js';

export async function auditRoutes(app: FastifyInstance) {
  // 分页查询
  app.get('/api/audit-logs', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-audit-logs'],
      summary: '审计日志分页查询',
      description: '分页查询审计日志，支持 action/actor/refType/refId/result/startTime/endTime 筛选。viewer 及以上可查询。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          action: { type: 'string', description: '按操作类型过滤（如 template_upload / admin_login）' },
          actor: { type: 'string', description: '按操作者过滤' },
          refType: { type: 'string', description: '按引用类型过滤（template/worker/job 等）' },
          refId: { type: 'string', description: '按引用 ID 过滤' },
          result: { type: 'string', enum: ['success', 'failure'], description: '按结果过滤' },
          startTime: { type: 'string', format: 'date-time' },
          endTime: { type: 'string', format: 'date-time' },
        },
      },
      // P0 修复：与 auditService.list() 返回对齐。
      //   原错误：schema 用 items/actorType/metadata/ip/userAgent，但 toPublic() 返回
      //   logs/actorIp/actorUa/meta，且 top-level 字段名 logs 而非 items，
      //   导致 fast-json-stringify 序列化缺失必填字段 → 500 INTERNAL_ERROR。
      response: {
        200: {
          type: 'object',
          required: ['logs', 'total', 'page', 'pageSize'],
          properties: {
            logs: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'action', 'actor', 'actorIp', 'actorUa', 'result', 'refType', 'refId', 'message', 'meta', 'createdAt'],
                properties: {
                  id: { type: 'string' },
                  action: { type: 'string' },
                  actor: { type: 'string' },
                  actorIp: { type: 'string', nullable: true, description: '操作者 IP' },
                  actorUa: { type: 'string', nullable: true, description: '操作者 User-Agent' },
                  refType: { type: 'string', nullable: true },
                  refId: { type: 'string', nullable: true },
                  result: { type: 'string' },
                  message: { type: 'string', nullable: true, description: '操作描述' },
                  meta: { type: 'object', additionalProperties: true, nullable: true, description: '结构化元数据' },
                  createdAt: { type: 'string', format: 'date-time' },
                },
              },
            },
            total: { type: 'integer' },
            page: { type: 'integer' },
            pageSize: { type: 'integer' },
          },
        },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
      },
    },
  }, async (req, reply) => {
    const q = req.query as any;
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.pageSize ?? '50', 10) || 50));
    const filter = {
      action: q.action || undefined,
      actor: q.actor || undefined,
      refType: q.refType || undefined,
      refId: q.refId || undefined,
      result: q.result || undefined,
      startTime: q.startTime ? new Date(q.startTime) : undefined,
      endTime: q.endTime ? new Date(q.endTime) : undefined,
    };
    const result = await auditService.list(filter, page, pageSize);
    return reply.send(result);
  });

  // 按 action 聚合统计（必须在 :id 之前注册，避免 stats 被当成 id）
  app.get('/api/audit-logs/stats', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-audit-logs'],
      summary: '审计日志按操作类型统计',
      description: '返回最近 N 天（默认 7 天，最多 90 天）内按 action 分组的审计日志计数，用于 Admin 概览统计。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 90, default: 7, description: '统计天数（默认 7，最大 90）' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['days', 'stats'],
          properties: {
            days: { type: 'integer', description: '实际统计天数' },
            // P0 修复：与 auditService.statsByAction() 返回对齐。
            //   原错误：schema 要求 total/success/failure，但 service 返回 count，
            //   导致 fast-json-stringify 序列化缺失必填字段 → 500 INTERNAL_ERROR。
            stats: {
              type: 'array',
              items: {
                type: 'object',
                required: ['action', 'count'],
                properties: {
                  action: { type: 'string', description: '操作类型' },
                  count: { type: 'integer', description: '该操作类型的日志总数' },
                },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
      },
    },
  }, async (req, reply) => {
    const q = req.query as any;
    const days = Math.min(90, Math.max(1, parseInt(q.days ?? '7', 10) || 7));
    const stats = await auditService.statsByAction(days);
    return reply.send({ days, stats });
  });

  // 单条详情
  app.get('/api/audit-logs/:id', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-audit-logs'],
      summary: '审计日志详情',
      description: '返回单条审计日志的完整信息（含 operator / action / refType / refId / message / meta / IP / UA 等）。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: '审计日志 ID' } } },
      response: {
        200: {
          type: 'object',
          required: ['log'],
          properties: {
            // P0 修复：与 auditService.getDetail() 返回（toPublic）对齐
            log: {
              type: 'object',
              required: ['id', 'action', 'actor', 'actorIp', 'actorUa', 'result', 'refType', 'refId', 'message', 'meta', 'createdAt'],
              properties: {
                id: { type: 'string' },
                action: { type: 'string' },
                actor: { type: 'string' },
                actorIp: { type: 'string', nullable: true },
                actorUa: { type: 'string', nullable: true },
                refType: { type: 'string', nullable: true },
                refId: { type: 'string', nullable: true },
                result: { type: 'string' },
                message: { type: 'string', nullable: true },
                meta: { type: 'object', additionalProperties: true, nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    const log = await auditService.getDetail(id);
    if (!log) return reply.code(404).send({ error: 'NOT_FOUND', message: '审计日志不存在' });
    return reply.send({ log });
  });
}
