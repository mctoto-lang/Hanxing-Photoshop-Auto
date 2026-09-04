/**
 * 任务队列（第三期改造：纯 SQLite + 内存队列）
 *
 * 改造历史：
 *   - 第一期：memory 队列（DB 轮询 + 内存等待队列）
 *   - 第二期：引入 BullMQ + Redis 作为通知通道（但 claim 仍走 DB 事务）
 *   - 第三期改造：移除 BullMQ/Redis 依赖，回归 memory 队列
 *     原因：项目目标负载为 10-20 任务并发，SQLite WAL 模式 + 内存队列绰绰有余，
 *     无需引入额外有状态服务（Redis）。原 BullMqQueue 实现实际未真正使用 BullMQ
 *     队列能力，仅检测 Redis 连接，价值有限。
 *
 * 能力路由（保留）：
 *   - 任务携带 requiredCapabilities（psMajorVersion、supportsSmartObject 等）
 *   - Worker claim 时上报自身能力，由 matchCapabilities 过滤
 *
 * DB 是任务事实源（状态机、租约、心跳、产物）。
 * claim 通过 DB 事务 + updateMany WHERE status='QUEUED' 条件更新防并发覆盖。
 * 在 SQLite SERIALIZABLE 隔离级别下，事务串行执行，无竞态。
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { genLeaseToken } from '../../lib/crypto.js';
import { webhookService } from '../webhook/webhook-service.js';

export interface ClaimRequest {
  workerId: string;
  /** Worker 能力：支持的 PS 大版本 */
  psMajorVersion: number;
  /** Worker 能力标签（capabilities JSON） */
  capabilities?: Record<string, unknown>;
  /** 等待时长（秒），长轮询 */
  maxWaitSeconds: number;
  /** 已安装字体的 postscriptName 集合 */
  installedFonts?: Set<string>;
}

export interface ClaimRecord {
  jobId: string;
  jobCode: string;
  leaseToken: string;
  leaseExpiresAt: Date;
}

// ============== 能力匹配 ==============

interface RequiredCapabilities {
  psMajorVersion?: number;
  supportsSmartObject?: boolean;
  supportsTextLayer?: boolean;
  os?: string;
  [k: string]: unknown;
}

/**
 * 解析任务的 requiredCapabilities JSON
 */
function parseRequiredCapabilities(raw: string | null | undefined): RequiredCapabilities | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RequiredCapabilities;
  } catch {
    return null;
  }
}

/**
 * 判断 Worker 能力是否满足任务要求
 * - 任务未声明 requiredCapabilities：任何 Worker 可领
 * - 任务声明 psMajorVersion=25：Worker 必须 psMajorVersion >= 25
 * - 任务声明 supportsSmartObject=true：Worker 必须显式声明 supportsSmartObject=true
 */
export function matchCapabilities(
  workerPsMajor: number,
  workerCapabilities: Record<string, unknown> | undefined,
  required: RequiredCapabilities | null,
): boolean {
  if (!required) return true;
  if (required.psMajorVersion !== undefined && workerPsMajor < required.psMajorVersion) {
    return false;
  }
  if (required.supportsSmartObject === true) {
    if (!workerCapabilities || workerCapabilities.supportsSmartObject !== true) return false;
  }
  if (required.supportsTextLayer === true) {
    if (!workerCapabilities || workerCapabilities.supportsTextLayer !== true) return false;
  }
  if (required.os) {
    // P0 安全修复（严重 S5）：原代码运算符优先级错误
    //   原: (workerCapabilities?.os as string) ?? env.NODE_ENV === 'production' ? 'windows' : 'unknown'
    //   由于 ?? 优先级低于 ===，实际解析为 ?? (env.NODE_ENV === 'production' ? 'windows' : 'unknown')
    //   导致 Worker 未上报 os 时，生产环境一律认为是 windows，未来扩展 os 类型会静默匹配错。
    //   修复：加括号显式表达意图
    const wos = (workerCapabilities?.os as string) ?? (env.NODE_ENV === 'production' ? 'windows' : 'unknown');
    if (wos !== required.os) return false;
  }
  return true;
}

// ============== DB claim 核心逻辑 ==============

/**
 * 从 DB 原子领取下一个任务（带能力过滤）
 *
 * P0-5 修复：原先 findMany + update 存在并发竞态——两个 Worker 可能同时读到
 *   同一 QUEUED 任务，后者的 update 会覆盖前者的 leaseToken，导致前者拿到
 *   失效令牌却以为领到了任务，最终任务"丢失"。
 *
 * 修复方案：用 updateMany + WHERE status='QUEUED' 做条件更新。
 *   - 并发时只有一个 Worker 的 updateMany 返回 count=1，其余 count=0
 *   - count=0 的 Worker 自动尝试下一个候选任务
 *   - 在 PostgreSQL READ COMMITTED 下，UPDATE 会阻塞等待先行事务提交，
 *     然后按最新 committed 状态重新评估 WHERE，自然避免覆盖
 *   - 在 SQLite SERIALIZABLE 下，事务串行执行，无竞态
 *
 * @param workerId 当前 Worker
 * @param workerPsMajor Worker 的 PS 大版本
 * @param workerCapabilities Worker 能力标签
 */
async function claimNextJob(
  workerId: string,
  workerPsMajor: number,
  workerCapabilities?: Record<string, unknown>,
): Promise<ClaimRecord | null> {
  return await prisma.$transaction(async (tx) => {
    // 取所有 QUEUED 任务按优先级排序，逐个匹配能力
    const candidates = await tx.renderJob.findMany({
      where: { status: 'QUEUED', OR: [{ targetWorkerId: null }, { targetWorkerId: workerId }] },
      orderBy: [{ priority: 'asc' }, { queuedAt: 'asc' }],
      take: 50, // 取前 50 个匹配，避免大表扫描
    });

    for (const candidate of candidates) {
      if (!matchCapabilities(workerPsMajor, workerCapabilities, parseRequiredCapabilities(candidate.requiredCapabilities))) {
        continue;
      }

      const leaseToken = genLeaseToken(candidate.id, workerId);
      const leaseExpiresAt = new Date(Date.now() + env.LEASE_TTL_SECONDS * 1000);

      // P0-5：条件更新——仅当 status 仍为 QUEUED 时才能领取
      // 并发场景下只有一个 Worker 的 updateMany 会返回 count=1
      const claimed = await tx.renderJob.updateMany({
        where: { id: candidate.id, status: 'QUEUED' },
        data: {
          status: 'LEASED',
          workerId,
          leaseToken,
          leaseExpiresAt,
          leasedAt: new Date(),
          stage: 'DOWNLOAD',
          progress: 0,
        },
      });

    const worker = await tx.worker.findUnique({ where: { id: workerId }, select: { currentJobId: true } });
    if (!worker || worker.currentJobId) return null;

      if (claimed.count === 1) {
        // 抢到了——更新 Worker 状态
        await tx.worker.update({
          where: { id: workerId },
          data: { currentJobId: candidate.id, lastHeartbeatAt: new Date(), offlineSince: null },
        });
        return { jobId: candidate.id, jobCode: candidate.code, leaseToken, leaseExpiresAt };
      }
      // count===0：被其他 Worker 抢走，继续尝试下一个候选
    }
    return null;
  });
}

// ============== 队列后端接口 ==============

export interface QueueBackend {
  readonly name: string;
  /** 通知有新任务入队（唤醒等待的 Worker） */
  notifyNewJob(): void;
  /** 长轮询领取任务 */
  claim(req: ClaimRequest): Promise<ClaimRecord | null>;
  /** 关闭连接（优雅停机） */
  close?(): Promise<void>;
}

// ============== 内存队列后端（第一期） ==============

class InMemoryQueue implements QueueBackend {
  readonly name = 'memory';
  private claimWaiters: Array<{
    workerId: string;
    psMajorVersion: number;
    capabilities?: Record<string, unknown>;
    resolve: (r: ClaimRecord | null) => void;
    timer: NodeJS.Timeout;
  }> = [];

  notifyNewJob(): void {
    // B-H9 修复：原仅 shift 单个等待者（FIFO），若被唤醒者能力不匹配（如新任务要求
    //   psMajorVersion=25 但等待者上报 24），claimNextJob 返回 null，该等待者直接
    //   退出；其他在队列中等待且能力匹配的 Worker 永不被唤醒，新任务滞留 DB。
    //   现改为广播唤醒所有等待者，让能力匹配的 Worker 竞争领取（DB updateMany
    //   条件更新保证最终只有一个 Worker 抢到），无匹配时所有等待者重新返回等待队列。
    //   10-20 Worker 规模下广播成本可控。
    const waiters = this.claimWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      claimNextJob(waiter.workerId, waiter.psMajorVersion, waiter.capabilities)
        .then((r) => waiter.resolve(r))
        .catch(() => waiter.resolve(null));
    }
  }

  async claim(req: ClaimRequest): Promise<ClaimRecord | null> {
    const immediate = await claimNextJob(req.workerId, req.psMajorVersion, req.capabilities);
    if (immediate) return immediate;

    // B-H9：长轮询期间可能被 notifyNewJob 广播唤醒但能力不匹配返回 null，
    //   此时应重新进入等待队列继续等待，直到超时或抢到任务，避免被唤醒一次就退出。
    const deadline = Date.now() + req.maxWaitSeconds * 1000;
    return new Promise<ClaimRecord | null>((resolve) => {
      const reRegister = () => {
        // 超时则结束
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        const remainingMs = deadline - Date.now();
        const timer = setTimeout(() => {
          const idx = this.claimWaiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) this.claimWaiters.splice(idx, 1);
          claimNextJob(req.workerId, req.psMajorVersion, req.capabilities).then((r) => {
            if (r) {
              resolve(r);
            } else {
              // 被唤醒但未抢到，重新注册继续等待
              reRegister();
            }
          });
        }, Math.min(remainingMs, 30_000)); // 最长 30s 重试一次，避免长时间无唤醒时漏超时

        this.claimWaiters.push({
          workerId: req.workerId,
          psMajorVersion: req.psMajorVersion,
          capabilities: req.capabilities,
          resolve,
          timer,
        });
      };
      reRegister();
    });
  }

  /** 优雅停机：清理所有等待中的 claim 长轮询定时器 */
  async close(): Promise<void> {
    for (const w of this.claimWaiters) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.claimWaiters.length = 0;
  }
}

// ============== BullMQ 队列后端已移除（第三期改造） ==============
// 原 BullMqQueue 类实际未真正使用 BullMQ 队列能力，仅检测 Redis 连接，
// claim 仍走 DB 事务。项目目标负载（10-20 并发）下内存队列已足够，
// 移除 Redis/BullMQ 依赖简化部署。
// 若未来需要水平扩展到多机多 Worker 高并发场景，可重新引入。
// 详见 DEPLOY.md "数据库与队列" 章节。

// ============== 队列工厂 ==============

let backendInstance: QueueBackend | null = null;

export function getQueue(): QueueBackend {
  if (!backendInstance) {
    // 第三期改造：仅保留内存队列后端
    // env.QUEUE_BACKEND 即使误设为 'bullmq'，env.ts 已自动降级为 'memory'
    backendInstance = new InMemoryQueue();
    logger.info({ backend: backendInstance.name, msg: '队列后端已初始化（内存队列）' });
  }
  return backendInstance;
}

/** 优雅停机：关闭队列后端 */
export async function stopQueue(): Promise<void> {
  if (backendInstance) {
    await backendInstance.close?.();
    backendInstance = null;
    logger.info({ msg: '队列后端已关闭' });
  }
}

// 兼容旧 API：queue.notifyNewJob() / queue.claim()
export const queue: QueueBackend = {
  get name() { return getQueue().name; },
  notifyNewJob() { return getQueue().notifyNewJob(); },
  claim(req: ClaimRequest) { return getQueue().claim(req); },
  async close() { await stopQueue(); },
};

// ============== 后台任务：租约回收 + 产物清理 ==============

/**
 * 后台租约回收器：扫描过期租约
 * - attempt < maxAttempts: 回收为 QUEUED，attempt+1，清除租约
 * - attempt >= maxAttempts: 标记 FAILED，errorCode=WORKER_LOST
 *
 * 第二期增强：
 * - 标记 Worker offlineSince（用于离线告警）
 * - 触发 alert 事件
 */
/**
 * 后台定时器注册表（P1-9：优雅停机用）
 * server.ts 在 SIGTERM/SIGINT 时统一 clearInterval，防止 prisma.$disconnect 后
 * 定时器仍触发查询导致未捕获异常
 */
export const backgroundTimers: NodeJS.Timeout[] = [];

/** 停止所有后台定时器（优雅停机时调用） */
export function stopBackgroundTimers(): void {
  for (const t of backgroundTimers) {
    clearInterval(t);
    clearTimeout(t);
  }
  backgroundTimers.length = 0;
  logger.info({ msg: '后台定时器已全部停止' });
}

export async function startLeaseReaper(): Promise<void> {
  const intervalMs = 10_000;
  const timer = setInterval(async () => {
    try {
      const now = new Date();
      const expired = await prisma.renderJob.findMany({
        where: {
          status: { in: ['LEASED', 'PROCESSING'] },
          leaseExpiresAt: { lt: now },
        },
      });

      for (const job of expired) {
        await prisma.$transaction(async (tx) => {
          // P1-1 修复：使用条件更新防止 TOCTOU 覆盖任务终态
          // findMany 与 update 之间，Worker 可能已 complete/fail 将任务置为终态。
          // 改用 updateMany + WHERE status/leaseExpiresAt 条件，仅当任务仍为
          // LEASED/PROCESSING 且租约确实过期时才更新；count===0 表示任务已被
          // 终态化或被其他回收器处理，跳过后续 Worker/告警更新
          const isFinalAttempt = job.attempt + 1 >= job.maxAttempts;
          const targetStatus = isFinalAttempt ? 'FAILED' : 'QUEUED';
          const updateData: any = isFinalAttempt
            ? {
                status: 'FAILED',
                errorCode: 'WORKER_LOST',
                errorMessage: `租约超时且已达最大重试次数 (${job.maxAttempts})`,
                failedAt: new Date(),
                leaseToken: null,
                leaseExpiresAt: null,
                workerId: null,
              }
            : {
                status: 'QUEUED',
                attempt: job.attempt + 1,
                leaseToken: null,
                leaseExpiresAt: null,
                workerId: null,
                stage: null,
                progress: 0,
              };

          const result = await tx.renderJob.updateMany({
            where: {
              id: job.id,
              status: { in: ['LEASED', 'PROCESSING'] },
              leaseExpiresAt: { lt: now },
            },
            data: updateData,
          });

          if (result.count === 0) {
            // 任务已被 Worker 终态化或被其他回收器处理，跳过
            return;
          }

          if (job.workerId) {
            await tx.worker.update({
              where: { id: job.workerId },
              data: { currentJobId: null, offlineSince: new Date() },
            });
          }

          if (isFinalAttempt) {
            // 第二期：触发告警
            await tx.alertEvent.create({
              data: {
                type: 'lease_expired',
                severity: 'ERROR',
                refType: 'job',
                refId: job.id,
                title: `任务 ${job.code} 租约超时且达最大重试`,
                message: `Worker ${job.workerId} 失联，任务标记 FAILED`,
                metrics: JSON.stringify({ attempt: job.attempt, maxAttempts: job.maxAttempts }),
              },
            });
            // 回收器判 FAILED 与 Worker 主动 fail 一致：回调订阅方（终态不缺通知）
            if (job.webhookUrl) {
              await webhookService.enqueueOutbox(tx, {
                jobId: job.id,
                event: 'job.failed',
                targetUrl: job.webhookUrl,
                apiKeyId: job.apiKeyId,
                payload: {
                  jobCode: job.code,
                  status: 'FAILED',
                  errorCode: 'WORKER_LOST',
                  errorMessage: `租约超时且已达最大重试次数 (${job.maxAttempts})`,
                },
              });
            }
            logger.warn({ jobId: job.id, msg: '任务租约超时，标记 FAILED' });
          } else {
            logger.warn({ jobId: job.id, attempt: job.attempt + 1, msg: '租约超时，回收重排队' });
          }
        });
        queue.notifyNewJob();
      }
    } catch (e) {
      logger.error({ err: e as Error, msg: '租约回收器异常' });
    }
  }, intervalMs);
  backgroundTimers.push(timer);

  logger.info({ intervalMs, msg: '租约回收器已启动' });
}

/**
 * 文件产物清理器：到期自动删除
 * 第二期：COS 模式下也调用 storage.deleteObject（COS SDK 内部走对象存储删除）
 */
export async function startArtifactReaper(): Promise<void> {
  const intervalMs = 60_000 * 30;
  const timer = setInterval(async () => {
    try {
      const now = new Date();
      const expired = await prisma.artifact.findMany({
        where: { expiresAt: { lt: now } },
        select: { id: true, objectKey: true },
      });
      if (expired.length === 0) return;
      const { getStorage } = await import('../storage/index.js');
      const storage = await getStorage();
      for (const a of expired) {
        await storage.deleteObject(a.objectKey).catch(() => {});
      }
      await prisma.artifact.deleteMany({
        where: { id: { in: expired.map((a) => a.id) } },
      });
      logger.info({ count: expired.length, msg: '已清理过期产物' });
    } catch (e) {
      logger.error({ err: e as Error, msg: '产物清理器异常' });
    }
  }, intervalMs);
  backgroundTimers.push(timer);

  logger.info({ intervalMs, msg: '产物清理器已启动' });
}

/**
 * P2-H：模板 PSD 孤儿文件清理器
 *
 * 背景：softDelete 模板时，若 jobCount > 0 则保留 PSD 文件（供在途任务继续使用）。
 *   但保留的 PSD 文件不是 Artifact，不进入 startArtifactReaper 清理范围。
 *   长期运行后，所有任务已终结但 PSD 文件仍在存储中，造成存储泄漏。
 *
 * 策略：定期扫描 DELETED 状态的模板，对其每个版本检查：
 *   1. 是否有非终结状态的 RenderJob 引用（QUEUED/LEASED/PROCESSING/CANCELLING）
 *      → 有则跳过，等在途任务完成
 *   2. 所有引用任务都已终结 → 删除 PSD + 缩略图，清空 psdObjectKey/thumbnailObjectKey
 *      防止重复清理
 *
 * 注意：仅清理存储对象，不删除 DB 记录（保留审计追溯能力）。
 *   清理后 psdObjectKey 置空字符串，thumbnailObjectKey 置 null。
 */
export async function startTemplatePsdReaper(): Promise<void> {
  const intervalMs = 60_000 * 60; // 每小时执行一次
  const timer = setInterval(async () => {
    try {
      await reapOrphanTemplatePsd();
    } catch (e) {
      logger.error({ err: e as Error, msg: '模板 PSD 孤儿清理器异常' });
    }
  }, intervalMs);
  backgroundTimers.push(timer);

  logger.info({ intervalMs, msg: '模板 PSD 孤儿清理器已启动' });
}

/** P2-H：执行一次孤儿 PSD 清理（导出供测试调用） */
export async function reapOrphanTemplatePsd(): Promise<{ cleaned: number; skipped: number }> {
  // 查找所有 DELETED 模板的版本（psdObjectKey 非空表示尚未清理）
  const deletedTemplates = await prisma.template.findMany({
    where: { status: 'DELETED' },
    select: {
      id: true,
      code: true,
      versions: {
        select: {
          id: true,
          version: true,
          psdObjectKey: true,
          thumbnailObjectKey: true,
        },
      },
    },
  });

  if (deletedTemplates.length === 0) {
    return { cleaned: 0, skipped: 0 };
  }

  // 终结状态：SUCCEEDED / FAILED / CANCELLED（非终结状态需跳过等待任务完成）
  const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

  const { getStorage } = await import('../storage/index.js');
  const storage = await getStorage();

  let cleaned = 0;
  let skipped = 0;

  for (const tpl of deletedTemplates) {
    for (const ver of tpl.versions) {
      // psdObjectKey 为空表示已清理过
      if (!ver.psdObjectKey || ver.psdObjectKey.length === 0) continue;

      // 检查是否有非终结状态的任务引用该版本
      const activeJobCount = await prisma.renderJob.count({
        where: {
          templateVersionId: ver.id,
          status: { notIn: TERMINAL_STATUSES },
        },
      });

      if (activeJobCount > 0) {
        skipped++;
        continue;
      }

      // 所有任务已终结（或无任务），安全删除 PSD + 缩略图。
      // 仅当 deleteObject 成功时才清空 DB 的对应 objectKey；
      // 失败则保留 objectKey，下一轮（1 小时后）会重试，
      // 避免 COS 删除失败时 DB 已清空 key 导致文件成为永久孤儿。
      const updates: { psdObjectKey?: string; thumbnailObjectKey?: string | null } = {};
      try {
        await storage.deleteObject(ver.psdObjectKey);
        updates.psdObjectKey = '';
      } catch (e) {
        logger.warn({
          err: e as Error,
          templateId: tpl.id,
          versionId: ver.id,
          objectKey: ver.psdObjectKey,
          msg: '孤儿清理：删除 PSD 文件失败，下一轮重试',
        });
      }
      if (ver.thumbnailObjectKey) {
        try {
          await storage.deleteObject(ver.thumbnailObjectKey);
          updates.thumbnailObjectKey = null;
        } catch (e) {
          logger.warn({
            err: e as Error,
            templateId: tpl.id,
            versionId: ver.id,
            objectKey: ver.thumbnailObjectKey,
            msg: '孤儿清理：删除缩略图失败，下一轮重试',
          });
        }
      }

      // 至少一个 key 删除成功才更新 DB（清空已删成功的 key，保留失败的供下轮重试）
      if (updates.psdObjectKey !== undefined || updates.thumbnailObjectKey !== undefined) {
        await prisma.templateVersion.update({
          where: { id: ver.id },
          data: updates,
        });
      }

      // PSD 文件删成功才算 cleaned；只删了缩略图或全部失败都不计入 cleaned
      if (updates.psdObjectKey !== undefined) {
        cleaned++;
        logger.info({
          templateId: tpl.id,
          templateCode: tpl.code,
          versionId: ver.id,
          version: ver.version,
          msg: '已清理孤儿模板 PSD 文件',
        });
      }
    }
  }

  if (cleaned > 0 || skipped > 0) {
    logger.info({ cleaned, skipped, msg: '模板 PSD 孤儿清理完成' });
  }

  return { cleaned, skipped };
}
