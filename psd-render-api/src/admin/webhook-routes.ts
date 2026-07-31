/**
 * Admin Webhook 投递日志路由（第三期 M6）
 *
 * 路由：
 *   - GET  /admin/api/webhook-logs            分页查询（支持 jobId/event/status/apiKeyId/startTime/endTime 筛选）
 *   - GET  /admin/api/webhook-logs/stats      按 status/event 聚合统计
 *   - GET  /admin/api/webhook-logs/:id        单条详情（含完整 payload）
 *   - POST /admin/api/webhook-logs/:id/retry  手动重试 FAILED 记录（operator+）
 *
 * 权限：viewer+ 可查询；operator+ 才能手动重试
 */
import { FastifyInstance } from 'fastify';
import { webhookService } from '../services/webhook/webhook-service.js';
import { auditService } from '../services/audit/audit-service.js';
import { AppError } from '../lib/errors.js';
import { prisma } from '../lib/prisma.js';

export async function webhookRoutes(app: FastifyInstance) {
  // 分页查询
  app.get('/api/webhook-logs', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-webhook-logs'],
      summary: 'Webhook 投递日志分页查询',
      description: '分页查询 Webhook 投递日志，支持 jobId/event/status/apiKeyId/startTime/endTime 筛选。viewer 及以上可查询。',
      security: [{ adminSession: [] }],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          jobId: { type: 'string', description: '按任务 ID 过滤' },
          event: { type: 'string', description: '按事件类型过滤（succeeded/failed/cancelled）' },
          status: { type: 'string', description: '按投递状态过滤（PENDING/RETRYING/SUCCEEDED/FAILED）' },
          apiKeyId: { type: 'string', description: '按 API Key ID 过滤' },
          startTime: { type: 'string', format: 'date-time' },
          endTime: { type: 'string', format: 'date-time' },
        },
      },
      // P0 修复（严重5）：补齐缺失的 response schema
      response: {
        200: {
          type: 'object',
          required: ['items', 'total', 'page', 'pageSize'],
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'jobId', 'event', 'status', 'url', 'payload', 'responseStatus', 'responseHeaders', 'responseBody', 'attempt', 'nextRetryAt', 'createdAt', 'sentAt'],
                properties: {
                  id: { type: 'string' },
                  jobId: { type: 'string', nullable: true },
                  event: { type: 'string' },
                  status: { type: 'string' },
                  url: { type: 'string' },
                  payload: { type: 'object', additionalProperties: true, nullable: true },
                  responseStatus: { type: 'integer', nullable: true },
                  responseHeaders: { type: 'object', additionalProperties: true, nullable: true },
                  responseBody: { type: 'string', nullable: true },
                  attempt: { type: 'integer' },
                  nextRetryAt: { type: 'string', format: 'date-time', nullable: true },
                  createdAt: { type: 'string', format: 'date-time' },
                  sentAt: { type: 'string', format: 'date-time', nullable: true },
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
      jobId: q.jobId || undefined,
      event: q.event || undefined,
      status: q.status || undefined,
      apiKeyId: q.apiKeyId || undefined,
      startTime: q.startTime ? new Date(q.startTime) : undefined,
      endTime: q.endTime ? new Date(q.endTime) : undefined,
    };
    const result = await webhookService.list(filter, page, pageSize);
    return reply.send(result);
  });

  // 聚合统计（按 status + event 分组）：必须在 :id 之前注册
  app.get('/api/webhook-logs/stats', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-webhook-logs'],
      summary: 'Webhook 日志统计',
      description: '返回最近 N 天（默认 7 天，最多 90 天）内 Webhook 投递按 status / event 分组的计数，用于 Admin 概览与成功率监控。',
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
          required: ['days', 'total', 'byStatus', 'byEvent'],
          properties: {
            days: { type: 'integer' },
            total: { type: 'integer' },
            // P0 修复（中等6）：强化弱 schema
            byStatus: {
              type: 'array',
              items: {
                type: 'object',
                required: ['status', 'total'],
                properties: {
                  status: { type: 'string' },
                  total: { type: 'integer' },
                },
              },
            },
            // P0 修复（中等6）：强化弱 schema
            byEvent: {
              type: 'array',
              items: {
                type: 'object',
                required: ['event', 'total'],
                properties: {
                  event: { type: 'string' },
                  total: { type: 'integer' },
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
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);

    const [byStatus, byEvent, total] = await Promise.all([
      prisma.webhookLog.groupBy({
        by: ['status'],
        where: { createdAt: { gte: since } },
        _count: true,
      }),
      prisma.webhookLog.groupBy({
        by: ['event'],
        where: { createdAt: { gte: since } },
        _count: true,
      }),
      prisma.webhookLog.count({ where: { createdAt: { gte: since } } }),
    ]);

    return reply.send({
      days,
      total,
      byStatus: byStatus.map((s) => ({ status: s.status, count: s._count })),
      byEvent: byEvent.map((e) => ({ event: e.event, count: e._count })),
    });
  });

  // 单条详情
  app.get('/api/webhook-logs/:id', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['admin-webhook-logs'],
      summary: 'Webhook 日志详情',
      description: '返回单条 Webhook 投递日志的完整信息（含目标 URL、请求/响应体、重试次数、状态等）。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Webhook 日志 ID' } } },
      response: {
        200: {
          type: 'object',
          required: ['log'],
          properties: {
            // P0 修复（中等6）：强化弱 schema
            log: {
              type: 'object',
              required: ['id', 'jobId', 'event', 'status', 'url', 'payload', 'responseStatus', 'responseHeaders', 'responseBody', 'attempt', 'nextRetryAt', 'createdAt', 'sentAt'],
              properties: {
                id: { type: 'string' },
                jobId: { type: 'string', nullable: true },
                event: { type: 'string' },
                status: { type: 'string' },
                url: { type: 'string' },
                payload: { type: 'object', additionalProperties: true, nullable: true },
                responseStatus: { type: 'integer', nullable: true },
                responseHeaders: { type: 'object', additionalProperties: true, nullable: true },
                responseBody: { type: 'string', nullable: true },
                attempt: { type: 'integer' },
                nextRetryAt: { type: 'string', format: 'date-time', nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
                sentAt: { type: 'string', format: 'date-time', nullable: true },
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
    const log = await webhookService.getDetail(id);
    if (!log) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Webhook 日志不存在' });
    return reply.send({ log });
  });

  // 手动重试 FAILED 记录（operator+）
  app.post('/api/webhook-logs/:id/retry', {
    preHandler: [app.requireAdminAuth, app.requireRole('operator')],
    schema: {
      tags: ['admin-webhook-logs'],
      summary: '手动重试 Webhook 投递',
      description: '对 FAILED 状态的 Webhook 日志手动触发重试投递。重试次数与退避仍受全局策略约束。operator 及以上可调用。',
      security: [{ adminSession: [] }],
      params: { type: 'object', properties: { id: { type: 'string', description: 'Webhook 日志 ID' } } },
      response: {
        200: {
          type: 'object',
          required: ['ok', 'log'],
          properties: {
            ok: { type: 'boolean' },
            // P0 修复（中等6）：强化弱 schema
            log: {
              type: 'object',
              required: ['id', 'jobId', 'event', 'status', 'url', 'payload', 'responseStatus', 'responseHeaders', 'responseBody', 'attempt', 'nextRetryAt', 'createdAt', 'sentAt'],
              properties: {
                id: { type: 'string' },
                jobId: { type: 'string', nullable: true },
                event: { type: 'string' },
                status: { type: 'string' },
                url: { type: 'string' },
                payload: { type: 'object', additionalProperties: true, nullable: true },
                responseStatus: { type: 'integer', nullable: true },
                responseHeaders: { type: 'object', additionalProperties: true, nullable: true },
                responseBody: { type: 'string', nullable: true },
                attempt: { type: 'integer' },
                nextRetryAt: { type: 'string', format: 'date-time', nullable: true },
                createdAt: { type: 'string', format: 'date-time' },
                sentAt: { type: 'string', format: 'date-time', nullable: true },
              },
            },
          },
        },
        400: { $ref: 'ErrorResponse#' },
        401: { $ref: 'ErrorResponse#', description: '未认证' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
        404: { $ref: 'ErrorResponse#' },
      },
    },
  }, async (req, reply) => {
    const id = (req.params as any).id as string;
    try {
      const log = await webhookService.manualRetry(id);
      if (!log) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'Webhook 日志不存在' });
      }
      auditService.recordFromReq(req, {
        action: 'webhook_retry',
        refType: 'webhook_log',
        refId: id,
        message: `手动重试 Webhook 投递: ${log.eventId}`,
        meta: { eventId: log.eventId, jobId: log.jobId, event: log.event },
      });
      return reply.send({ ok: true, log });
    } catch (e: any) {
      auditService.recordFromReq(req, {
        action: 'webhook_retry',
        refType: 'webhook_log',
        refId: id,
        result: 'failure',
        message: `手动重试 Webhook 失败: ${e.message ?? '未知原因'}`,
      });
      if (e instanceof AppError) {
        return reply.code(400).send({ error: e.code, message: e.message });
      }
      return reply.code(400).send({ error: 'BAD_REQUEST', message: e.message ?? '重试失败' });
    }
  });
}
