/**
 * 审计日志服务（第三期 M2）
 *
 * 职责：
 *   - 记录关键写操作的审计日志（admin 登录、API Key 管理、模板/字体/Worker/任务管理）
 *   - 提供查询接口（分页 + 多维筛选）
 *
 * 设计：
 *   - 写入采用 fire-and-forget：调用方不必 await，失败不影响主请求
 *   - 在 service 内部 .catch() 吞掉写入错误，仅 log warn
 *   - 所有写操作路由在成功响应后调用 record()
 *
 * 表结构见 prisma/schema.prisma AuditLog 模型
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export interface AuditRecordInput {
  action: string;
  actor: string;
  actorIp?: string | null;
  actorUa?: string | null;
  result?: 'success' | 'failure';
  refType?: string | null;
  refId?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface AuditLogPublic {
  id: string;
  action: string;
  actor: string;
  actorIp: string | null;
  actorUa: string | null;
  result: string;
  refType: string | null;
  refId: string | null;
  message: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditListFilter {
  action?: string;
  actor?: string;
  refType?: string;
  refId?: string;
  result?: string;
  startTime?: Date;
  endTime?: Date;
}

export interface AuditListResult {
  logs: AuditLogPublic[];
  total: number;
  page: number;
  pageSize: number;
}

function toPublic(l: any): AuditLogPublic {
  let meta: Record<string, unknown> | null = null;
  try {
    meta = l.meta ? JSON.parse(l.meta) : null;
  } catch {
    meta = null;
  }
  return {
    id: l.id,
    action: l.action,
    actor: l.actor,
    actorIp: l.actorIp,
    actorUa: l.actorUa,
    result: l.result,
    refType: l.refType,
    refId: l.refId,
    message: l.message,
    meta,
    createdAt: l.createdAt.toISOString(),
  };
}

class AuditService {
  /**
   * 记录审计日志（fire-and-forget）
   * - 不抛异常，失败仅 log warn
   * - 返回 Promise<AuditLog | null>，调用方一般不 await
   */
  record(input: AuditRecordInput): Promise<void> {
    const data = {
      action: input.action,
      actor: input.actor || 'unknown',
      actorIp: input.actorIp ?? null,
      actorUa: input.actorUa ?? null,
      result: input.result ?? 'success',
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      message: input.message ?? null,
      meta: input.meta ? JSON.stringify(input.meta) : '{}',
    };
    return prisma.auditLog
      .create({ data })
      .then(() => {
        // 静默成功
      })
      .catch((e: unknown) => {
        logger.warn({
          msg: '审计日志写入失败',
          action: input.action,
          actor: input.actor,
          err: (e as Error).message,
        });
      });
  }

  /**
   * 从 Fastify 请求中便捷记录
   * - 自动提取 actor（adminUser.username）、IP、UserAgent
   */
  recordFromReq(
    req: any,
    params: Omit<AuditRecordInput, 'actor' | 'actorIp' | 'actorUa'>,
  ): Promise<void> {
    return this.record({
      ...params,
      actor: req.adminUser?.username ?? 'unknown',
      actorIp: req.ip ?? null,
      actorUa: req.headers?.['user-agent'] ?? null,
    });
  }

  /** 分页查询 */
  async list(
    filter: AuditListFilter,
    page: number = 1,
    pageSize: number = 50,
  ): Promise<AuditListResult> {
    const where: any = {};
    if (filter.action) where.action = filter.action;
    if (filter.actor) where.actor = filter.actor;
    if (filter.refType) where.refType = filter.refType;
    if (filter.refId) where.refId = filter.refId;
    if (filter.result) where.result = filter.result;
    if (filter.startTime || filter.endTime) {
      where.createdAt = {};
      if (filter.startTime) where.createdAt.gte = filter.startTime;
      if (filter.endTime) where.createdAt.lte = filter.endTime;
    }

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.auditLog.count({ where }),
    ]);

    return {
      logs: logs.map(toPublic),
      total,
      page,
      pageSize,
    };
  }

  /** 单条详情 */
  async getDetail(id: string): Promise<AuditLogPublic | null> {
    const log = await prisma.auditLog.findUnique({ where: { id } });
    return log ? toPublic(log) : null;
  }

  /** 统计：按 action 聚合（最近 N 天） */
  async statsByAction(days: number = 7): Promise<Array<{ action: string; count: number }>> {
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const rows = await prisma.auditLog.groupBy({
      by: ['action'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
    });
    return rows.map((r: any) => ({ action: r.action, count: r._count._all }));
  }

  /** 清理 N 天前的日志（定时调用） */
  async reapOld(retentionDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
    const result = await prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return result.count;
  }
}

export const auditService = new AuditService();
