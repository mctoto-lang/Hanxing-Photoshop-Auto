/**
 * 第三期 M11：可观测性增强
 *
 * 1. trace_id 贯穿：客户端可传 X-Trace-Id，服务端响应回传 X-Trace-Id
 * 2. HTTP 请求指标：method/route/status 维度的计数与耗时
 * 3. GET /health         综合健康检查（无鉴权）
 * 4. GET /health/live    存活探针（仅检查进程存活，无依赖检查，供 K8s livenessProbe）
 * 5. GET /health/ready   就绪探针（检查 DB + 存储，供 K8s readinessProbe）
 * 6. GET /metrics        Prometheus 指标导出（无鉴权，建议生产用网络层限制）
 */
import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma.js';
import { getStorage } from '../services/storage/index.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

// ===== 指标收集器（轻量内存实现，避免引入 prom-client 依赖） =====
//
// Prometheus 命名规范：
//   - 基础单位使用 SI 单位（秒、字节），后缀 _seconds / _bytes
//   - counter 总数后缀 _total
//   - histogram 自动生成 _bucket / _sum / _count 三个序列
//
// HTTP 请求耗时使用 histogram 而非 counter，便于在 Prometheus 中用
//   histogram_quantile() 计算 p50/p90/p99 分位数，比单纯 sum 更有用。
// 时间单位统一为秒（Prometheus 惯例），内部存储仍为毫秒避免浮点精度问题，
//   导出时除以 1000 转换。
class MetricsCollector {
  // HTTP 请求：key = `${method}|${route}|${statusClass}`
  private httpReqs = new Map<string, { count: number; durationSumMs: number; buckets: number[] }>();
  // 业务 gauge（jobs_queued / workers_online 等）
  private gauges = new Map<string, number>();
  private startTime = Date.now();

  // histogram 桶边界（毫秒），覆盖 1ms ~ 60s 的典型 HTTP 延迟分布
  // 桶选择参考 Prometheus 官方建议：覆盖典型延迟范围 + 业务关键阈值
  //   - 5/10/25/50/100/250/500ms：快速 API（查询/上传）
  //   - 1/2.5/5/10s：渲染任务提交、模板保存等较慢操作
  //   - 30/60s：极端慢请求边界（含重试）
  //   +Inf 桶由导出时自动追加
  private static readonly BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];

  recordHttp(method: string, route: string, status: number, durationMs: number) {
    const statusClass = `${Math.floor(status / 100)}xx`;
    const key = `${method}|${route}|${statusClass}`;
    const cur = this.httpReqs.get(key) ?? {
      count: 0,
      durationSumMs: 0,
      buckets: new Array(MetricsCollector.BUCKETS_MS.length + 1).fill(0),
    };
    cur.count++;
    cur.durationSumMs += durationMs;
    // 累积桶（cumulative buckets）：le=5ms 的桶包含所有 ≤5ms 的请求，
    //   le=10ms 的桶包含所有 ≤10ms 的请求（含 ≤5ms 的）。
    //   因此找到第一个 >= durationMs 的桶后，该桶及所有更大桶都要 +1。
    //   buckets 数组最后一项为 +Inf 桶，恒 +1（所有样本都 ≤ +Inf）。
    let startIdx = MetricsCollector.BUCKETS_MS.length; // 默认落入 +Inf
    for (let i = 0; i < MetricsCollector.BUCKETS_MS.length; i++) {
      if (durationMs <= MetricsCollector.BUCKETS_MS[i]) {
        startIdx = i;
        break;
      }
    }
    // 从 startIdx 到 +Inf 桶全部 +1（保证单调不减）
    for (let i = startIdx; i < cur.buckets.length; i++) {
      cur.buckets[i]++;
    }
    this.httpReqs.set(key, cur);
  }

  setGauge(name: string, value: number) {
    this.gauges.set(name, value);
  }

  export(): string {
    const lines: string[] = [];
    lines.push('# HELP psd_http_requests_total HTTP 请求总数');
    lines.push('# TYPE psd_http_requests_total counter');
    for (const [key, v] of this.httpReqs) {
      const [method, route, statusClass] = key.split('|');
      lines.push(
        `psd_http_requests_total{method="${method}",route="${route}",status="${statusClass}"} ${v.count}`,
      );
    }
    lines.push('');
    // histogram：导出 _bucket（每个 le 一个序列）+ _sum + _count
    // 单位为秒（Prometheus 惯例），毫秒值除以 1000
    lines.push('# HELP psd_http_request_duration_seconds HTTP 请求耗时分布（秒）');
    lines.push('# TYPE psd_http_request_duration_seconds histogram');
    for (const [key, v] of this.httpReqs) {
      const [method, route, statusClass] = key.split('|');
      const labels = `method="${method}",route="${route}",status="${statusClass}"`;
      // 每个桶边界导出一个 _bucket 序列（累积值）
      for (let i = 0; i < MetricsCollector.BUCKETS_MS.length; i++) {
        const leSeconds = (MetricsCollector.BUCKETS_MS[i] / 1000).toString();
        lines.push(
          `psd_http_request_duration_seconds_bucket{${labels},le="${leSeconds}"} ${v.buckets[i]}`,
        );
      }
      // +Inf 桶（必须存在，值等于 _count）
      lines.push(
        `psd_http_request_duration_seconds_bucket{${labels},le="+Inf"} ${v.buckets[MetricsCollector.BUCKETS_MS.length]}`,
      );
      // _sum：总耗时（秒）
      lines.push(
        `psd_http_request_duration_seconds_sum{${labels}} ${(v.durationSumMs / 1000).toFixed(6)}`,
      );
      // _count：样本总数
      lines.push(
        `psd_http_request_duration_seconds_count{${labels}} ${v.count}`,
      );
    }
    lines.push('');
    lines.push('# HELP psd_gauge 业务运行时指标');
    lines.push('# TYPE psd_gauge gauge');
    for (const [name, value] of this.gauges) {
      lines.push(`psd_gauge{name="${name}"} ${value}`);
    }
    lines.push('');
    lines.push('# HELP psd_process_uptime_seconds 进程运行时长（秒）');
    lines.push('# TYPE psd_process_uptime_seconds gauge');
    lines.push(`psd_process_uptime_seconds ${((Date.now() - this.startTime) / 1000).toFixed(0)}`);
    return lines.join('\n');
  }
}

export const metrics = new MetricsCollector();

export default fp(async (app) => {
  // ===== trace_id 贯穿 =====
  // 响应头回传 X-Trace-Id（req.id 由 genReqId 生成或沿用客户端传入）
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.id) reply.header('X-Trace-Id', req.id);
    return payload;
  });

  // ===== HTTP 请求指标收集 =====
  app.addHook('onResponse', async (req, reply) => {
    const start = (req as any).__startedAt ?? Date.now();
    const durationMs = Date.now() - start;
    // 规范化路由：用 req.routeOptions?.url 或 fallback 到原始 url
    const route = (req as any).routeOptions?.url || req.url || 'unknown';
    metrics.recordHttp(req.method, route, reply.statusCode, durationMs);
  });
  app.addHook('onRequest', async (req) => {
    (req as any).__startedAt = Date.now();
  });

  // ===== GET /health 综合健康检查 =====
  // 含 DB / 存储 / 队列检查；任一 down 返回 503。供 Docker HEALTHCHECK / LB 综合探测。
  app.get('/health', {
    schema: {
      tags: ['system'],
      summary: '综合健康检查',
      description: '检查数据库、存储、队列的连通性。任一依赖 down 则返回 503。供 Docker HEALTHCHECK 与负载均衡综合探测使用。',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'ok | degraded' },
            uptime: { type: 'integer', description: '进程运行时长（秒）' },
            version: { type: 'string', description: '服务版本' },
            checks: {
              type: 'object',
              properties: {
                database: { type: 'string', description: 'ok | down' },
                storage: { type: 'string', description: 'ok | down' },
                queue: { type: 'string', description: 'ok | down' },
              },
            },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'degraded' },
            uptime: { type: 'integer' },
            version: { type: 'string' },
            checks: { type: 'object', additionalProperties: true },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  }, async (_req, reply) => {
    const checks: Record<string, string> = {};
    let allOk = true;
    // 数据库
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (e) {
      checks.database = 'down';
      allOk = false;
    }
    // 存储（仅检测能否实例化，不下载数据）
    try {
      await getStorage();
      checks.storage = 'ok';
    } catch (e) {
      checks.storage = 'down';
      allOk = false;
    }
    // 队列（第三期改造：纯内存队列，恒 ok）
    checks.queue = 'ok';
    const uptimeSec = Math.floor(process.uptime());
    const body = {
      status: allOk ? 'ok' : 'degraded',
      uptime: uptimeSec,
      version: '0.3.0',
      checks,
      timestamp: new Date().toISOString(),
    };
    reply.code(allOk ? 200 : 503);
    return reply.send(body);
  });

  // ===== GET /health/live 存活探针 =====
  // 仅检查进程存活，不检查任何依赖。供 K8s livenessProbe / 进程级重启判定使用。
  // 失败条件：进程无法响应（已被 SIGTERM/SIGKILL 或死锁），由 LB 探测超时推断。
  app.get('/health/live', {
    schema: {
      tags: ['system'],
      summary: '存活探针',
      description: '仅检查进程存活，不检查依赖服务。供 K8s livenessProbe 使用：失败时重启容器。',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', description: '恒为 alive' },
            uptime: { type: 'integer', description: '进程运行时长（秒）' },
          },
        },
      },
    },
  }, async (_req, reply) => {
    return reply.code(200).send({
      status: 'alive',
      uptime: Math.floor(process.uptime()),
    });
  });

  // ===== GET /health/ready 就绪探针 =====
  // 检查依赖服务（DB + 存储），不检查队列（队列恒 ok）。供 K8s readinessProbe 使用：
  // 失败时从负载均衡摘除流量但不重启容器。
  app.get('/health/ready', {
    schema: {
      tags: ['system'],
      summary: '就绪探针',
      description: '检查数据库与存储连通性。供 K8s readinessProbe 使用：失败时从负载均衡摘除流量但不重启容器。',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'ready | not_ready' },
            checks: {
              type: 'object',
              properties: {
                database: { type: 'string', description: 'ok | down' },
                storage: { type: 'string', description: 'ok | down' },
              },
            },
          },
        },
        503: {
          type: 'object',
          properties: {
            status: { type: 'string', description: 'not_ready' },
            checks: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ready = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch {
      checks.database = 'down';
      ready = false;
    }
    try {
      await getStorage();
      checks.storage = 'ok';
    } catch {
      checks.storage = 'down';
      ready = false;
    }
    reply.code(ready ? 200 : 503);
    return reply.send({
      status: ready ? 'ready' : 'not_ready',
      checks,
    });
  });

  // ===== GET /metrics Prometheus 指标导出 =====
  // P1-24 修复：生产环境对 /metrics 加 Admin 鉴权，防止业务指标泄露
  // （jobs_queued / workers_online / webhooks_pending 等可被竞争情报利用）
  // 开发环境保持无鉴权方便本地 Prometheus 抓取调试
  app.get('/metrics', {
    preHandler: [env.NODE_ENV === 'production' ? (app as any).requireAdminAuth : (_req: any, _reply: any, done: any) => done()],
    schema: {
      tags: ['system'],
      summary: 'Prometheus 指标导出',
      description: [
        '导出 Prometheus 文本格式指标。生产环境需 Admin 鉴权（防止业务指标泄露），开发环境无鉴权便于本地抓取。',
        '',
        '**指标列表**：',
        '- `psd_http_requests_total`：HTTP 请求总数（按 method/route/status 分维度）',
        '- `psd_http_request_duration_seconds`：HTTP 请求耗时分布（histogram，含 `_bucket`/`_sum`/`_count` 序列，单位秒）',
        '- `psd_gauge{name="jobs_queued"}`：排队中任务数',
        '- `psd_gauge{name="jobs_processing"}`：执行中任务数',
        '- `psd_gauge{name="jobs_succeeded_total"}`：累计成功任务数',
        '- `psd_gauge{name="jobs_failed_total"}`：累计失败任务数',
        '- `psd_gauge{name="jobs_cancelled_total"}`：累计取消任务数',
        '- `psd_gauge{name="workers_online"}`：在线 Worker 数（心跳在阈值内）',
        '- `psd_gauge{name="webhooks_pending"}`：待投递 Webhook 数',
        '- `psd_gauge{name="alerts_active"}`：活跃告警数',
        '- `psd_gauge{name="templates_count"}`：未删除模板数',
        '- `psd_gauge{name="fonts_count"}`：字体版本数',
        '- `psd_gauge{name="api_keys_active"}`：启用中 API Key 数',
        '- `psd_process_uptime_seconds`：进程运行时长（秒）',
      ].join('\n'),
      // P0 修复（严重2）：声明 security 与描述保持一致
      // 生产环境需要 adminSession，开发环境无鉴权（security: [] 表示公开）
      ...(env.NODE_ENV === 'production'
        ? { security: [{ adminSession: [] }] }
        : { security: [] }),
      response: {
        200: { type: 'string', description: 'Prometheus 文本格式指标' },
        401: { $ref: 'ErrorResponse#', description: '生产环境需要 Admin 鉴权' },
      },
    },
  }, async (_req, reply) => {
    // 刷新业务 gauge（查询 DB 拿当前值）
    try {
      const [queued, processing, succeeded, failed, cancelled, workersOnline, webhooksPending, alertsActive, templatesCount, fontsCount, apiKeysActive] = await Promise.all([
        prisma.renderJob.count({ where: { status: 'QUEUED' } }),
        prisma.renderJob.count({ where: { status: { in: ['LEASED', 'PROCESSING'] } } }),
        prisma.renderJob.count({ where: { status: 'SUCCEEDED' } }),
        prisma.renderJob.count({ where: { status: 'FAILED' } }),
        prisma.renderJob.count({ where: { status: { in: ['CANCELLING', 'CANCELLED'] } } }),
        // B-M1 修复：workers_online 必须按"sessionActive=true 且心跳在阈值内"计算。
        //   原实现仅 count(sessionActive=true)，忽略 lastHeartbeatAt，导致
        //   所有 Worker 心跳早已超时（HEARTBEAT_TIMEOUT）但指标仍显示 8 在线，
        //   与 Admin UI 显示不一致，且基于指标的告警会误报。
        //   阈值使用 env.ALERT_WORKER_OFFLINE_SECONDS（与告警评估保持一致）。
        prisma.worker.count({
          where: {
            sessionActive: true,
            lastHeartbeatAt: { gte: new Date(Date.now() - env.ALERT_WORKER_OFFLINE_SECONDS * 1000) },
          },
        }),
        prisma.webhookLog.count({ where: { status: { in: ['PENDING', 'RETRYING'] } } }),
        prisma.alertEvent.count({ where: { status: 'ACTIVE' } }),
        prisma.template.count({ where: { NOT: { status: 'DELETED' } } }),
        prisma.fontVersion.count(),
        prisma.apiKey.count({ where: { active: true } }),
      ]);
      metrics.setGauge('jobs_queued', queued);
      metrics.setGauge('jobs_processing', processing);
      metrics.setGauge('jobs_succeeded_total', succeeded);
      metrics.setGauge('jobs_failed_total', failed);
      metrics.setGauge('jobs_cancelled_total', cancelled);
      metrics.setGauge('workers_online', workersOnline);
      metrics.setGauge('webhooks_pending', webhooksPending);
      metrics.setGauge('alerts_active', alertsActive);
      metrics.setGauge('templates_count', templatesCount);
      metrics.setGauge('fonts_count', fontsCount);
      metrics.setGauge('api_keys_active', apiKeysActive);
    } catch (e) {
      logger.warn({ err: e as Error, msg: '刷新业务 gauge 失败（指标可能过期）' });
    }
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return reply.send(metrics.export());
  });
});
