/**
 * Webhook 投递服务（第三期 M6 生产级）
 *
 * 设计：
 *   - 事件入队：enqueue() 创建 WebhookLog 记录，eventId 唯一约束保证幂等
 *   - 同步试投：enqueue 内立即尝试一次投递，失败则进入指数退避重试队列
 *   - 后台轮询：processPending() 周期扫描 RETRYING 状态记录，按 nextAttemptAt 触发
 *   - 指数退避：1m, 5m, 15m, 60m, 240m, 960m（最大 6 次）
 *   - 签名：HMAC-SHA256（优先使用 API Key 维度的 webhookSecret，回落到全局 WORKER_TOKEN_SECRET）
 *   - 投递头：X-Render-Signature / X-Render-Event-Id / X-Render-Event / X-Render-Attempt
 *
 * 事件类型：
 *   - job.succeeded
 *   - job.failed
 *   - job.cancelled
 *
 * 与 job-service.ts 的协议：
 *   - 任务终态时调用 enqueue()，传入 jobId / event / targetUrl / apiKeyId / payload
 *   - 入队失败仅 log warn（不阻塞主流程）
 */
import http from 'node:http';
import https from 'node:https';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { hmacSign } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { validateAndResolveWebhookUrl } from '../../lib/ssrf-guard.js';
import { decryptSecretWithInfo } from '../../lib/secret-crypto.js';
import { AppError } from '../../lib/errors.js';

/**
 * S-H1：webhookSecret 解析。
 *   - DB 中存储的是 AES-256-GCM 密文（info='webhook' 派生的 key 加密）
 *   - 解密成功返回明文用于 HMAC 签名
 *   - 解密失败视为历史明文数据（迁移期向后兼容），记录警告后原样返回
 *     建议管理员通过 update 接口重设 secret 以完成加密迁移
 *
 * 注意：AES-GCM 的 authTag（16 字节）提供完整性校验，随机串被误判为合法密文
 *   的概率约 2^-128，可忽略。因此「解密失败即历史明文」的判定是安全的。
 */
function resolveWebhookSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decryptSecretWithInfo(stored, 'webhook');
  } catch (e) {
    // CONFIG_ERROR 表示解密失败——视为历史明文（迁移期兼容）
    if (e instanceof AppError && e.code === 'CONFIG_ERROR') {
      logger.warn({
        msg: 'webhookSecret 为明文存储（历史数据），建议通过 Admin 接口重设以加密存储',
      });
      return stored;
    }
    throw e;
  }
}

// ============== 常量 ==============

/** 重试退避间隔（秒）：1m, 5m, 15m, 60m, 240m, 960m */
const BACKOFF_SECONDS = [60, 300, 900, 3600, 14400, 57600];

/** 默认最大尝试次数（含首次） */
const DEFAULT_MAX_ATTEMPTS = 6;

/** 单次投递超时（毫秒） */
const DELIVERY_TIMEOUT_MS = 10_000;

/** 后台扫描间隔（毫秒） */
const PROCESSOR_INTERVAL_MS = 15_000;

/** 每批最多处理多少条 */
const PROCESSOR_BATCH_SIZE = 20;

/** 响应体最大保留长度 */
const MAX_RESPONSE_BODY_LEN = 1000;

/**
 * M7 修复：URL 脱敏工具，剥离 query 参数（可能含签名 token / access_token）。
 * 仅保留 origin + pathname，用于日志输出。
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    // 非法 URL 仅截断前 80 字符
    return url.length > 80 ? url.slice(0, 80) : url;
  }
}

/**
 * S-H2：IP-pinned HTTP(S) 请求。
 *
 * 防 DNS Rebinding：传入已通过 SSRF 校验的 IP，通过自定义 agent.lookup
 * 强制连接到该 IP，避免 fetch 二次 DNS 解析时被攻击者切换到内网地址。
 *
 * - HTTPS 请求的 TLS SNI / 证书校验仍使用原始 hostname（agent 仅替换解析结果）
 * - 连接超时由 timeout 选项控制，读取超时由整体 Promise 竞争保证
 * - 每次请求创建独立 agent（keepAlive=false），避免跨目标连接复用
 *
 * 替代原 fetch 调用：保留相同的 { status, ok, text } 语义。
 */
function pinnedRequest(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  ip: string;
  family: number;
}): Promise<{ status: number; ok: boolean; text: string }> {
  const parsed = new URL(opts.url);
  const isHttps = parsed.protocol === 'https:';
  const AgentCtor = isHttps ? https.Agent : http.Agent;
  const agent = new AgentCtor({
    // 固定返回已校验的 IP，无视任何后续 DNS 变化
    lookup: (_hostname: string, _dnsOpts: any, cb: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>) => void) => {
      cb(null, [{ address: opts.ip, family: opts.family }]);
    },
    keepAlive: false,
  });

  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      {
        method: opts.method,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        headers: opts.headers,
        agent,
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`请求超时 (${opts.timeoutMs}ms)`));
    });
    req.write(opts.body);
    req.end();
  });
}

/** 支持的事件类型 */
export type WebhookEvent = 'job.succeeded' | 'job.failed' | 'job.cancelled';

export interface EnqueueInput {
  jobId: string;
  event: WebhookEvent;
  targetUrl: string;
  apiKeyId?: string | null;
  /** 业务 payload（不含 eventId/event/jobId/timestamp 等通用字段） */
  payload?: Record<string, unknown>;
}

export interface WebhookLogPublic {
  id: string;
  eventId: string;
  jobId: string;
  event: string;
  targetUrl: string;
  apiKeyId: string | null;
  status: string;
  attempt: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  responseCode: number | null;
  responseBody: string | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toPublic(log: any): WebhookLogPublic {
  return {
    id: log.id,
    eventId: log.eventId,
    jobId: log.jobId,
    event: log.event,
    targetUrl: log.targetUrl,
    apiKeyId: log.apiKeyId ?? null,
    status: log.status,
    attempt: log.attempt,
    maxAttempts: log.maxAttempts,
    nextAttemptAt: log.nextAttemptAt ? log.nextAttemptAt.toISOString() : null,
    responseCode: log.responseCode ?? null,
    responseBody: log.responseBody ?? null,
    lastError: log.lastError ?? null,
    deliveredAt: log.deliveredAt ? log.deliveredAt.toISOString() : null,
    createdAt: log.createdAt.toISOString(),
    updatedAt: log.updatedAt.toISOString(),
  };
}

// ============== 服务 ==============

class WebhookService {
  private processorTimer: NodeJS.Timeout | null = null;
  private processing = false;
  /**
   * P1-K：投递并发去重
   *   enqueue 的即时试投、processPending 的重试投递、manualRetry 的手动重试
   *   三者可能并发调用 deliverOnce，导致同一 webhook 被投递多次。
   *   用 inFlight Set 记录正在投递的 logId，重复调用直接跳过。
   *   注意：此为单实例防护；多实例部署需依赖 DB 级别的行锁（如 SELECT FOR UPDATE）。
   */
  private inFlight = new Set<string>();

  async enqueueOutbox(tx: any, input: EnqueueInput): Promise<void> {
    const eventId = `${input.jobId}.${input.event}`;
    const payload = JSON.stringify({
      eventId,
      event: input.event,
      jobId: input.jobId,
      timestamp: new Date().toISOString(),
      ...(input.payload ?? {}),
    });
    await tx.webhookLog.create({
      data: {
        eventId,
        jobId: input.jobId,
        event: input.event,
        targetUrl: input.targetUrl,
        apiKeyId: input.apiKeyId ?? null,
        payload,
        status: 'RETRYING',
        nextAttemptAt: new Date(),
        attempt: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      },
    }).catch((error: any) => {
      if (error?.code !== 'P2002') throw error;
    });
  }

  /**
   * 入队 webhook 投递任务
   *
   * 幂等：基于 eventId = `${jobId}.${event}` 唯一索引去重
   * 若已存在同 eventId 的记录，直接返回（不重复投递）
   *
   * 入队后立即触发一次试投，成功则标记 DELIVERED，失败则安排指数退避重试
   */
  async enqueue(input: EnqueueInput): Promise<{ logId: string; created: boolean } | null> {
    const eventId = `${input.jobId}.${input.event}`;

    // 幂等检查：同 eventId 已存在则跳过
    const existing = await prisma.webhookLog.findUnique({
      where: { eventId },
      select: { id: true, status: true },
    });
    if (existing) {
      logger.info({
        eventId,
        webhookLogId: existing.id,
        status: existing.status,
        msg: 'Webhook 已存在，跳过重复投递',
      });
      return { logId: existing.id, created: false };
    }

    // 组装完整 payload
    const fullPayload = JSON.stringify({
      eventId,
      event: input.event,
      jobId: input.jobId,
      timestamp: new Date().toISOString(),
      ...(input.payload ?? {}),
    });

    // 获取 API Key 维度的 webhookSecret（若有）
    // S-H1：DB 中为密文，需解密后用于 HMAC 签名
    let secret: string = env.WORKER_TOKEN_SECRET;
    if (input.apiKeyId) {
      const k = await prisma.apiKey.findUnique({
        where: { id: input.apiKeyId },
        select: { webhookSecret: true },
      });
      const resolved = resolveWebhookSecret(k?.webhookSecret);
      if (resolved) secret = resolved;
    }

    // 创建投递记录
    let log;
    try {
      log = await prisma.webhookLog.create({
        data: {
          eventId,
          jobId: input.jobId,
          event: input.event,
          targetUrl: input.targetUrl,
          apiKeyId: input.apiKeyId ?? null,
          payload: fullPayload,
          status: 'RETRYING',
          nextAttemptAt: new Date(),
          attempt: 0,
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
        },
      });
    } catch (e: any) {
      // P1-6 修复：捕获唯一约束错误（并发同 eventId），视为已存在
      // 原 findUnique 检查与 create 之间存在 TOCTOU 窗口，
      // complete 与 cancel 并发回调时可能同时通过检查
      if (e?.code === 'P2002' && e?.meta?.target?.includes('eventId')) {
        const existing = await prisma.webhookLog.findUnique({
          where: { eventId },
          select: { id: true },
        });
        if (existing) {
          logger.info({
            eventId,
            webhookLogId: existing.id,
            msg: 'Webhook 已存在（并发竞态后回落），跳过重复投递',
          });
          return { logId: existing.id, created: false };
        }
      }
      throw e;
    }

    // 立即异步试投（不阻塞调用方）
    this.deliverOnce(log.id, secret).catch((e) => {
      logger.warn({ err: e as Error, logId: log.id, msg: 'Webhook 首次投递异常' });
    });

    logger.info({
      webhookLogId: log.id,
      eventId,
      jobId: input.jobId,
      event: input.event,
      targetUrl: redactUrl(input.targetUrl),
      msg: 'Webhook 已入队',
    });

    return { logId: log.id, created: true };
  }

  /**
   * 单次投递尝试
   * - 成功（2xx）：标记 DELIVERED
   * - 失败（非 2xx / 网络异常 / 超时）：尝试次数 +1，安排下次重试或标记 FAILED
   *
   * P1-K：inFlight 防并发重复投递
   *   enqueue 即时试投 / processPending 重试 / manualRetry 手动重试
   *   可能并发调用本方法，inFlight Set 确保同一 logId 同时只投递一次。
   */
  private async deliverOnce(logId: string, secret: string): Promise<void> {
    // P1-K：并发去重——已在投递中则跳过
    if (this.inFlight.has(logId)) {
      logger.debug({ logId, msg: 'Webhook 正在投递中，跳过重复调用' });
      return;
    }
    this.inFlight.add(logId);
    try {
      await this.deliverOnceInner(logId, secret);
    } finally {
      this.inFlight.delete(logId);
    }
  }

  private async deliverOnceInner(logId: string, secret: string): Promise<void> {
    const log = await prisma.webhookLog.findUnique({ where: { id: logId } });
    if (!log) return;
    if (log.status === 'DELIVERED') return;

    const attempt = log.attempt + 1;
    const signature = hmacSign(secret, log.payload);

    let responseCode: number | null = null;
    let responseBody = '';
    let lastError: string | null = null;
    let delivered = false;

    // P0 + S-H2：投递前 SSRF 校验 + DNS 解析（单次），返回已校验的 IP 用于 pinning。
    //   校验与连接使用同一批解析结果，消除「校验时解析 → fetch 时再解析」的 TOCTOU。
    const ssrfCheck = await validateAndResolveWebhookUrl(log.targetUrl);
    if (!ssrfCheck.ok) {
      // SSRF 命中：直接标记 FAILED，不重试（避免反复尝试内部地址）
      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'FAILED',
          attempt,
          lastError: `SSRF 拦截: ${ssrfCheck.reason}`,
          nextAttemptAt: null,
        },
      });
      logger.warn({
        webhookLogId: logId,
        eventId: log.eventId,
        targetUrl: redactUrl(log.targetUrl),
        reason: ssrfCheck.reason,
        msg: 'Webhook 投递被 SSRF 防护拦截',
      });
      return;
    }

    const headers = {
      'Content-Type': 'application/json',
      'X-Render-Signature': `sha256=${signature}`,
      'X-Render-Event-Id': log.eventId,
      'X-Render-Event': log.event,
      'X-Render-Attempt': String(attempt),
    };

    try {
      let resp: { status: number; ok: boolean; text: string };
      if (ssrfCheck.ips && ssrfCheck.ips.length > 0) {
        // S-H2：生产模式——用已校验的 IP 建立 pinned 连接，防 DNS rebinding
        const pinned = ssrfCheck.ips[0];
        resp = await pinnedRequest({
          url: log.targetUrl,
          method: 'POST',
          headers,
          body: log.payload,
          timeoutMs: DELIVERY_TIMEOUT_MS,
          ip: pinned.address,
          family: pinned.family,
        });
      } else {
        // 开发模式（allowPrivate）：无 IP pinning，直接 fetch（允许内网回测）
        const r = await fetch(log.targetUrl, {
          method: 'POST',
          headers,
          body: log.payload,
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        resp = {
          status: r.status,
          ok: r.ok,
          text: (await r.text()).slice(0, MAX_RESPONSE_BODY_LEN),
        };
      }
      responseCode = resp.status;
      responseBody = resp.text.slice(0, MAX_RESPONSE_BODY_LEN);
      delivered = resp.ok;
    } catch (e) {
      lastError = (e as Error).message ?? String(e);
    }

    const now = new Date();
    if (delivered) {
      await prisma.webhookLog.update({
        where: { id: logId },
        data: {
          status: 'DELIVERED',
          attempt,
          responseCode,
          responseBody,
          lastError: null,
          deliveredAt: now,
          nextAttemptAt: null,
        },
      });
      logger.info({
        webhookLogId: logId,
        eventId: log.eventId,
        attempt,
        responseCode,
        msg: 'Webhook 投递成功',
      });
      return;
    }

    // 投递失败：决定是否重试
    const exhausted = attempt >= log.maxAttempts;
    const nextDelaySec = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
    const nextAttemptAt = exhausted ? null : new Date(now.getTime() + nextDelaySec * 1000);

    await prisma.webhookLog.update({
      where: { id: logId },
      data: {
        status: exhausted ? 'FAILED' : 'RETRYING',
        attempt,
        responseCode,
        responseBody,
        lastError: lastError ?? `HTTP ${responseCode}`,
        nextAttemptAt,
      },
    });

    logger.warn({
      webhookLogId: logId,
      eventId: log.eventId,
      attempt,
      responseCode,
      lastError: lastError ?? `HTTP ${responseCode}`,
      exhausted,
      nextAttemptAt,
      msg: exhausted ? 'Webhook 投递失败（已达最大次数）' : 'Webhook 投递失败，安排重试',
    });
  }

  /**
   * 后台扫描器：周期处理 RETRYING 状态、到期的 nextAttemptAt 记录
   */
  private async processPending(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const now = new Date();
      const pending = await prisma.webhookLog.findMany({
        where: {
          status: 'RETRYING',
          nextAttemptAt: { lte: now },
        },
        orderBy: { nextAttemptAt: 'asc' },
        take: PROCESSOR_BATCH_SIZE,
        select: { id: true, apiKeyId: true },
      });

      if (pending.length === 0) return;

      // 批量取 secret（同 apiKeyId 复用）
      const apiKeyIds = Array.from(new Set(pending.map((p) => p.apiKeyId).filter(Boolean))) as string[];
      const keys = apiKeyIds.length > 0
        ? await prisma.apiKey.findMany({
            where: { id: { in: apiKeyIds } },
            select: { id: true, webhookSecret: true },
          })
        : [];
      const secretMap = new Map<string, string | null>();
      // S-H1：DB 中为密文，解密后存入 map 供投递使用
      for (const k of keys) secretMap.set(k.id, resolveWebhookSecret(k.webhookSecret));

      await Promise.all(
        pending.map((p) => {
          const secret = (p.apiKeyId && secretMap.get(p.apiKeyId)) || env.WORKER_TOKEN_SECRET;
          return this.deliverOnce(p.id, secret).catch((e) => {
            logger.warn({ err: e as Error, logId: p.id, msg: 'Webhook 重试投递异常' });
          });
        }),
      );
    } catch (e) {
      logger.error({ err: e as Error, msg: 'Webhook 处理器异常' });
    } finally {
      this.processing = false;
    }
  }

  /**
   * 启动后台处理器
   */
  start(): void {
    if (this.processorTimer) return;
    this.processorTimer = setInterval(() => {
      this.processPending().catch(() => {});
    }, PROCESSOR_INTERVAL_MS);
    logger.info({
      intervalMs: PROCESSOR_INTERVAL_MS,
      batchSize: PROCESSOR_BATCH_SIZE,
      msg: 'Webhook 后台处理器已启动',
    });
  }

  /**
   * 停止后台处理器（优雅停机）
   */
  stop(): void {
    if (this.processorTimer) {
      clearInterval(this.processorTimer);
      this.processorTimer = null;
      logger.info({ msg: 'Webhook 后台处理器已停止' });
    }
  }

  // ============== Admin 查询 ==============

  /** 分页查询 */
  async list(
    filter: {
      jobId?: string;
      event?: string;
      status?: string;
      apiKeyId?: string;
      startTime?: Date;
      endTime?: Date;
    },
    page: number,
    pageSize: number,
  ): Promise<{ items: WebhookLogPublic[]; total: number; page: number; pageSize: number }> {
    const where: any = {};
    if (filter.jobId) where.jobId = filter.jobId;
    if (filter.event) where.event = filter.event;
    if (filter.status) where.status = filter.status;
    if (filter.apiKeyId) where.apiKeyId = filter.apiKeyId;
    if (filter.startTime || filter.endTime) {
      where.createdAt = {};
      if (filter.startTime) where.createdAt.gte = filter.startTime;
      if (filter.endTime) where.createdAt.lte = filter.endTime;
    }

    const [total, items] = await Promise.all([
      prisma.webhookLog.count({ where }),
      prisma.webhookLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: items.map(toPublic), total, page, pageSize };
  }

  /** 单条详情 */
  async getDetail(id: string): Promise<WebhookLogPublic | null> {
    const log = await prisma.webhookLog.findUnique({ where: { id } });
    return log ? toPublic(log) : null;
  }

  /**
   * 手动重试：将 FAILED 记录重置为 RETRYING，立即触发
   * 仅 FAILED 状态允许重试
   */
  async manualRetry(id: string): Promise<WebhookLogPublic | null> {
    const log = await prisma.webhookLog.findUnique({ where: { id } });
    if (!log) return null;
    if (log.status !== 'FAILED') {
      throw new Error(`仅 FAILED 状态可手动重试，当前状态: ${log.status}`);
    }
    const updated = await prisma.webhookLog.update({
      where: { id },
      data: {
        status: 'RETRYING',
        nextAttemptAt: new Date(),
        lastError: '手动重试',
      },
    });

    // 立即触发（不等待下次扫描）
    // S-H1：DB 中为密文，解密后用于签名
    let secret = env.WORKER_TOKEN_SECRET;
    if (log.apiKeyId) {
      const k = await prisma.apiKey.findUnique({
        where: { id: log.apiKeyId },
        select: { webhookSecret: true },
      });
      const resolved = resolveWebhookSecret(k?.webhookSecret);
      if (resolved) secret = resolved;
    }
    this.deliverOnce(log.id, secret).catch((e) => {
      logger.warn({ err: e as Error, logId: log.id, msg: 'Webhook 手动重试异常' });
    });

    return toPublic(updated);
  }

  /** 清理 N 天前的已完结记录 */
  async reapOld(retentionDays: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000);
    const r = await prisma.webhookLog.deleteMany({
      where: {
        status: { in: ['DELIVERED', 'FAILED'] },
        createdAt: { lt: cutoff },
      },
    });
    return { deleted: r.count };
  }
}

export const webhookService = new WebhookService();
