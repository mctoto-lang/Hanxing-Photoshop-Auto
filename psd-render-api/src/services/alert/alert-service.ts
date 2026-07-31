/**
 * 监控告警服务（第二期）
 *
 * 告警类型：
 *   - worker_offline    Worker 心跳超时（ALERT_WORKER_OFFLINE_SECONDS）
 *   - job_failed_rate   最近 N 分钟任务失败率超阈值
 *   - queue_backlog     QUEUED 任务数超过阈值
 *   - ps_stuck          PROCESSING 任务运行时长超过 ALERT_PS_STUCK_SECONDS
 *   - lease_expired     任务租约超时（由 queue.ts 触发）
 *   - font_sync_failed  字体同步失败（由 Worker 触发）
 *
 * 工作机制：
 *   1. 每 ALERT_EVAL_INTERVAL_SECONDS 秒扫描一次 DB
 *   2. 检测到异常创建 AlertEvent（type + refId 去重，已有 ACTIVE 不重复创建）
 *   3. 异常恢复时将 AlertEvent 标记 RESOLVED
 *   4. Admin UI 通过 /admin/api/alerts 查询
 *
 * 第三期 M10：告警触发后通过 alertNotifier 主动推送通知
 *   （通用 Webhook / 飞书 / 钉钉机器人，按 ALERT_MIN_SEVERITY 过滤）
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { alertNotifier } from './alert-notifier.js';

class AlertService {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    const intervalMs = env.ALERT_EVAL_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => this.evaluate().catch((e) => {
      logger.error({ err: e as Error, msg: '告警评估异常' });
    }), intervalMs);
    logger.info({ intervalMs, msg: '监控告警评估器已启动' });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 触发一次完整告警评估
   */
  async evaluate(): Promise<void> {
    await Promise.all([
      this.checkWorkerOffline(),
      this.checkJobFailedRate(),
      this.checkQueueBacklog(),
      this.checkPsStuck(),
    ]);
  }

  /**
   * 1. Worker 离线：心跳超过阈值
   */
  private async checkWorkerOffline(): Promise<void> {
    const threshold = new Date(Date.now() - env.ALERT_WORKER_OFFLINE_SECONDS * 1000);
    const offline = await prisma.worker.findMany({
      where: {
        sessionActive: true,
        lastHeartbeatAt: { lt: threshold },
      },
      select: { id: true, code: true, customCode: true, displayName: true, lastHeartbeatAt: true, psVersion: true },
    });

    for (const w of offline) {
      // 标题使用自定义编号或系统编号（便于业务识别节点）
      const workerLabel = w.customCode || w.code;
      await this.trigger({
        type: 'worker_offline',
        severity: 'ERROR',
        refType: 'worker',
        refId: w.id,
        title: `Worker ${workerLabel} 离线`,
        message: `PS 版本 ${w.psVersion}，最后心跳 ${w.lastHeartbeatAt?.toISOString()}`,
        metrics: JSON.stringify({ offlineSeconds: env.ALERT_WORKER_OFFLINE_SECONDS, workerCode: w.code, customCode: w.customCode, displayName: w.displayName }),
      });
    }

    // 已恢复的 worker：标记告警为 RESOLVED
    const onlineIds = (await prisma.worker.findMany({
      where: { sessionActive: true, lastHeartbeatAt: { gte: threshold } },
      select: { id: true },
    })).map((w) => w.id);

    if (onlineIds.length > 0) {
      await prisma.alertEvent.updateMany({
        where: {
          type: 'worker_offline',
          refType: 'worker',
          refId: { in: onlineIds },
          status: 'ACTIVE',
        },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
    }
  }

  /**
   * 2. 任务失败率：最近 10 分钟失败率超阈值
   */
  private async checkJobFailedRate(): Promise<void> {
    const windowStart = new Date(Date.now() - 10 * 60 * 1000);
    const result = await prisma.renderJob.groupBy({
      by: ['status'],
      where: { updatedAt: { gte: windowStart } },
      _count: { _all: true },
    });
    const total = result.reduce((s, r) => s + r._count._all, 0);
    const failed = result.find((r) => r.status === 'FAILED')?._count._all ?? 0;
    if (total < 10) return; // 样本太少不评估
    const rate = failed / total;
    if (rate >= env.ALERT_JOB_FAILED_RATE_THRESHOLD) {
      await this.trigger({
        type: 'job_failed_rate',
        severity: rate >= 0.5 ? 'CRITICAL' : 'WARN',
        refType: 'system',
        refId: 'global',
        title: `任务失败率 ${(rate * 100).toFixed(1)}% 超阈值`,
        message: `最近 10 分钟 ${failed}/${total} 任务失败`,
        metrics: JSON.stringify({ rate, failed, total, threshold: env.ALERT_JOB_FAILED_RATE_THRESHOLD }),
      });
    } else {
      // 恢复
      await prisma.alertEvent.updateMany({
        where: { type: 'job_failed_rate', status: 'ACTIVE' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
    }
  }

  /**
   * 3. 队列堆积：QUEUED 任务超过阈值
   */
  private async checkQueueBacklog(): Promise<void> {
    const count = await prisma.renderJob.count({ where: { status: 'QUEUED' } });
    if (count >= env.ALERT_QUEUE_BACKLOG_THRESHOLD) {
      await this.trigger({
        type: 'queue_backlog',
        severity: count >= env.ALERT_QUEUE_BACKLOG_THRESHOLD * 2 ? 'CRITICAL' : 'WARN',
        refType: 'queue',
        refId: 'main',
        title: `队列堆积 ${count} 个任务`,
        message: `QUEUED 任务数 ${count} 超阈值 ${env.ALERT_QUEUE_BACKLOG_THRESHOLD}`,
        metrics: JSON.stringify({ count, threshold: env.ALERT_QUEUE_BACKLOG_THRESHOLD }),
      });
    } else {
      await prisma.alertEvent.updateMany({
        where: { type: 'queue_backlog', status: 'ACTIVE' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
    }
  }

  /**
   * 4. PS 卡死：PROCESSING 任务运行时长超阈值
   */
  private async checkPsStuck(): Promise<void> {
    const threshold = new Date(Date.now() - env.ALERT_PS_STUCK_SECONDS * 1000);
    const stuck = await prisma.renderJob.findMany({
      where: {
        status: 'PROCESSING',
        processingAt: { lt: threshold },
      },
      select: { id: true, code: true, processingAt: true, workerId: true, stage: true },
    });
    // 一次性查询所有相关 Worker 的自定义编号/名称，避免 N+1 查询
    const workerIds = Array.from(new Set(stuck.map((j) => j.workerId).filter(Boolean))) as string[];
    const workers = workerIds.length > 0
      ? await prisma.worker.findMany({ where: { id: { in: workerIds } }, select: { id: true, code: true, customCode: true, displayName: true } })
      : [];
    const workerMap = new Map(workers.map((w) => [w.id, w]));
    for (const j of stuck) {
      // 任务标题保留任务编号；消息中附带 Worker 自定义编号便于定位节点
      const w = j.workerId ? workerMap.get(j.workerId) : null;
      const workerLabel = w ? (w.customCode || w.code) : '?';
      await this.trigger({
        type: 'ps_stuck',
        severity: 'CRITICAL',
        refType: 'job',
        refId: j.id,
        title: `任务 ${j.code} 疑似 PS 卡死`,
        message: `阶段 ${j.stage ?? '?'}，开始处理于 ${j.processingAt?.toISOString()}，执行节点 ${workerLabel}`,
        metrics: JSON.stringify({
          stuckSeconds: env.ALERT_PS_STUCK_SECONDS,
          workerId: j.workerId,
          workerCode: w?.code,
          customCode: w?.customCode,
          displayName: w?.displayName,
        }),
      });
    }
  }

  /**
   * 创建告警事件（同 type + refId 已有 ACTIVE 时跳过）
   */
  async trigger(opts: {
    type: string;
    severity?: string;
    refType?: string;
    refId?: string;
    title: string;
    message: string;
    metrics?: string;
  }): Promise<void> {
    // 去重：相同 type + refId 已有 ACTIVE 不重复触发
    const existing = await prisma.alertEvent.findFirst({
      where: {
        type: opts.type,
        refId: opts.refId ?? null,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    if (existing) return;

    const severity = opts.severity ?? 'WARN';
    const triggeredAt = new Date();

    await prisma.alertEvent.create({
      data: {
        type: opts.type,
        severity,
        refType: opts.refType ?? null,
        refId: opts.refId ?? null,
        title: opts.title,
        message: opts.message,
        metrics: opts.metrics ?? null,
        status: 'ACTIVE',
        triggeredAt,
      },
    });
    logger.warn({
      type: opts.type,
      severity,
      refId: opts.refId,
      msg: `告警触发: ${opts.title}`,
    });

    // 第三期 M10：异步推送通知到外部渠道（fire-and-forget，不阻断主流程）
    alertNotifier.notify({
      type: opts.type,
      severity,
      refType: opts.refType,
      refId: opts.refId,
      title: opts.title,
      message: opts.message,
      triggeredAt,
    });
  }

  /**
   * 列出告警（Admin UI 用）
   */
  async list(opts: { status?: string; limit?: number } = {}): Promise<any[]> {
    return prisma.alertEvent.findMany({
      where: opts.status ? { status: opts.status } : undefined,
      orderBy: { triggeredAt: 'desc' },
      take: opts.limit ?? 100,
    });
  }

  /**
   * 确认告警（标记 ACKED）
   */
  async ack(id: string, ackedBy: string): Promise<void> {
    await prisma.alertEvent.update({
      where: { id },
      data: { status: 'ACKED', ackedBy, ackedAt: new Date() },
    });
  }

  /**
   * 清理老告警（resolved/acked 超过 minAgeSeconds 的删除）
   */
  async reapOld(): Promise<void> {
    const threshold = new Date(Date.now() - env.ALERT_REAP_MIN_AGE_SECONDS * 1000);
    const result = await prisma.alertEvent.deleteMany({
      where: {
        status: { in: ['RESOLVED', 'ACKED'] },
        triggeredAt: { lt: threshold },
      },
    });
    if (result.count > 0) {
      logger.info({ count: result.count, msg: '已清理老告警' });
    }
  }
}

export const alertService = new AlertService();
