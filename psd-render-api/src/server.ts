/**
 * PSD 渲染服务平台 - 后端入口
 *
 * 启动流程：
 * 1. 校验环境变量（zod fail-fast）
 * 2. 连接 Prisma
 * 3. 注册插件（CORS、鉴权、错误处理、multipart、静态文件）
 * 4. 注册路由（存储代理 / 外部 API / Worker 内部 / Admin）
 * 5. 启动后台任务（租约回收、产物清理）
 * 6. 监听端口
 */
import Fastify, { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { env, isDev } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma, initSqlitePragmas } from './lib/prisma.js';

import corsPlugin from './plugins/cors.js';
import authPlugin, { stopAuthTimers } from './plugins/auth.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import adminAuthPlugin from './plugins/admin-auth.js';
import swaggerPlugin from './plugins/swagger.js';
import observabilityPlugin from './plugins/observability.js';

import { storageRoutes } from './routes/storage.js';
import { assetsRoutes } from './routes/v1/assets.js';
import { templateRoutes } from './routes/v1/templates.js';
import { renderJobRoutes } from './routes/v1/render-jobs.js';
import { fontRoutes } from './routes/v1/fonts.js';
import { workerRoutes } from './routes/internal/workers.js';
import { jobInternalRoutes } from './routes/internal/jobs.js';
import { fontInternalRoutes } from './routes/internal/fonts.js';
import { adminRoutes } from './admin/admin-routes.js';
import { adminAuthRoutes } from './admin/admin-auth-routes.js';
import { adminWriteRoutes } from './admin/admin-write-routes.js';
import { apiKeyRoutes } from './admin/api-key-routes.js';
import { apiKeyService } from './services/admin/api-key-service.js';
import { auditRoutes } from './admin/audit-routes.js';
import { webhookRoutes } from './admin/webhook-routes.js';

import { startLeaseReaper, startArtifactReaper, startTemplatePsdReaper, stopBackgroundTimers, backgroundTimers, stopQueue } from './services/render-job/queue.js';
import { alertService } from './services/alert/alert-service.js';
import { adminAuthService } from './services/admin/admin-auth-service.js';
import { auditService } from './services/audit/audit-service.js';
import { webhookService } from './services/webhook/webhook-service.js';

// B-H10 修复：将 app 提升为模块级变量，供 gracefulShutdown 调用 app.close()。
//   原实现 app 是 main() 的局部变量，shutdown 时无法优雅关闭 HTTP 服务，
//   process.exit(0) 会强制中断正在处理的请求与 keep-alive 连接。
let serverInstance: FastifyInstance | null = null;

async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // 使用自定义 pino
    // P0 安全修复：信任反向代理转发的 X-Forwarded-For / X-Real-IP
    //   生产部署在 Nginx/Docker 之后，未启用时 req.ip 永远是 127.0.0.1，
    //   导致 ADMIN_IP_WHITELIST、API Key ipWhitelist、登录限流、审计日志 IP 全部失效。
    //   设为 true 后 Fastify 会按 X-Forwarded-For 最左侧取真实客户端 IP。
    //   部署时必须确保前置 Nginx 已设置 X-Real-IP / X-Forwarded-For 且未对外暴露该头。
    trustProxy: true,
    // M11：trace_id 贯穿 — 优先沿用客户端 X-Trace-Id，否则生成 8 字符短 id
    // P0 安全修复（低危14）：改用 crypto.randomUUID（详见 logger.genTraceId 注释）
    genReqId: (req) => {
      const h = req.headers['x-trace-id'];
      if (typeof h === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(h)) return h;
      return randomUUID().replace(/-/g, '').slice(0, 8);
    },
    // 全局 bodyLimit 与 MAX_INPUT_SIZE_MB 一致（默认 150MB），覆盖输入资产等常规路由。
    // PSD 模板上传路由（/admin/api/templates/upload、/storage/upload）因需支持 300MB 大文件，
    //   在路由级单独覆盖 bodyLimit（见各路由），此处不放宽全站限额。
    bodyLimit: env.MAX_INPUT_SIZE_MB * 1024 * 1024,
    disableRequestLogging: false,
  });

  // 原始二进制 body 解析（用于 /storage/upload 和 /admin/api/test/assets）
  // 扩展类型：覆盖常见图片与字体格式
  app.addContentTypeParser(
    ['application/octet-stream', 'image/png', 'image/jpeg', 'image/jpg',
     'image/webp', 'image/gif', 'image/bmp',
     'image/vnd.adobe.photoshop', 'font/otf', 'font/ttf'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // 插件
  await app.register(corsPlugin);
  await app.register(authPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(adminAuthPlugin);

  // 第三期 M7：OpenAPI 文档（必须在路由注册前注册）
  // 注意：swagger 必须在 observability 之前注册，否则 /health /health/live /health/ready /metrics
  //   的 schema 不会被 Swagger 捕获（@fastify/swagger 仅 hook 注册之后的路由）
  await app.register(swaggerPlugin);
  // 注入共享 schema（路由中可通过 $ref 引用）
  app.addSchema({
    $id: 'ErrorResponse',
    type: 'object',
    properties: {
      error: { type: 'string', description: '错误码' },
      message: { type: 'string', description: '错误描述' },
      details: { type: 'array', description: '可选，详细错误信息' },
    },
    required: ['error', 'message'],
  });

  // 第三期 M11：可观测性（trace_id 响应头 + /health + /metrics + 请求指标）
  // 必须在路由注册前，以便 hook 能覆盖所有业务路由
  // （/docs 等 Swagger 端点不需 trace_id 与请求指标，故 swagger 先注册不影响）
  await app.register(observabilityPlugin);

  // 路由
  await app.register(storageRoutes);
  await app.register(assetsRoutes, { prefix: '' });
  await app.register(templateRoutes, { prefix: '' });
  await app.register(renderJobRoutes, { prefix: '' });
  await app.register(fontRoutes, { prefix: '' });
  await app.register(workerRoutes, { prefix: '' });
  await app.register(jobInternalRoutes, { prefix: '' });
  await app.register(fontInternalRoutes, { prefix: '' });
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(adminAuthRoutes, { prefix: '/admin' });
  await app.register(adminWriteRoutes, { prefix: '/admin' });
  await app.register(apiKeyRoutes, { prefix: '/admin' });
  await app.register(auditRoutes, { prefix: '/admin' });
  await app.register(webhookRoutes, { prefix: '/admin' });

  return app;
}

async function main() {
  const app = await buildServer();
  serverInstance = app;

  // 连接数据库
  await prisma.$connect();
  logger.info('数据库已连接');

  // 第三期改造：初始化 SQLite PRAGMA（WAL + busy_timeout + synchronous=NORMAL）
  //   仅对 SQLite 生效，非 SQLite 数据库会被 try-catch 忽略
  await initSqlitePragmas();

  // 第三期 M3：引导创建初始管理员
  await adminAuthService.bootstrap().catch((e) => {
    logger.error({ err: e as Error, msg: 'Admin 引导失败' });
  });

  // B-E1 修复：将 .env 中的 API_KEY 引导为正式 ApiKey 记录
  //   原 POC 回落在 DB 出现任意 ApiKey 后被禁用，导致 env.API_KEY 不可用。
  //   此处幂等写入，确保 dev 模式下 .env 标注的 key 永远可用。
  await apiKeyService.bootstrapEnvApiKey().catch((e) => {
    logger.error({ err: e as Error, msg: 'API_KEY env 引导失败' });
  });

  // 启动后台任务
  // P1-9：所有 setInterval 引用统一注册到 backgroundTimers，
  //   SIGTERM/SIGINT 时通过 stopBackgroundTimers() 清理，
  //   防止 prisma.$disconnect 后定时器仍触发查询导致未捕获异常
  startLeaseReaper();
  startArtifactReaper();
  // P2-H：清理 softDelete 模板时因 jobCount>0 保留的孤儿 PSD 文件
  startTemplatePsdReaper();
  // 第二期：监控告警评估器
  alertService.start();
  // 每小时清理一次老告警
  const alertReapTimer = setInterval(() => alertService.reapOld().catch(() => {}), 60 * 60 * 1000);
  backgroundTimers.push(alertReapTimer);
  // 第三期 M3：每小时清理一次过期 Admin session
  const sessionReapTimer = setInterval(() => adminAuthService.reapExpiredSessions().catch(() => {}), 60 * 60 * 1000);
  backgroundTimers.push(sessionReapTimer);
  // 第三期 M2：每天清理一次 90 天前的审计日志
  const auditReapTimer = setInterval(() => auditService.reapOld(90).catch(() => {}), 24 * 60 * 60 * 1000);
  backgroundTimers.push(auditReapTimer);
  // 第三期 M6：启动 Webhook 后台处理器（指数退避重试）
  webhookService.start();
  // 第三期 M6：每天清理一次 30 天前的已完结 Webhook 日志
  const webhookReapTimer = setInterval(() => webhookService.reapOld(30).catch(() => {}), 24 * 60 * 60 * 1000);
  backgroundTimers.push(webhookReapTimer);

  // 启动 HTTP 服务
  await app.listen({
    port: env.PORT,
    host: env.HOST,
  });

  logger.info({
    msg: '🚀 PSD 渲染服务已启动',
    port: env.PORT,
    env: env.NODE_ENV,
    storage: env.STORAGE_BACKEND,
    queue: env.QUEUE_BACKEND,
    adminAuth: env.ADMIN_AUTH_ENABLED,
    dev: isDev,
  });
  logger.info({
    msg: 'API 文档（Swagger UI）：GET /docs | 外部 API：/v1/* | Worker：/internal/* | Admin：/admin | 健康检查：GET /health | 指标：GET /metrics',
  });
}

main().catch((err) => {
  logger.error({ err, msg: '启动失败' });
  process.exit(1);
});

// 优雅关闭
// P1-9：清理所有后台定时器 + alertService.stop + webhookService.stop，
//   再 prisma.$disconnect，防止 disconnect 后定时器仍查询 DB 触发未捕获异常
// B-H10 修复：增加 await app.close()，让 HTTP 服务优雅关闭——
//   停止接收新连接、等待正在处理的请求完成、关闭 keep-alive 连接、触发 onClose 钩子，
//   避免 process.exit(0) 强制中断进行中的请求导致客户端 ECONNRESET。
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal, msg: `收到 ${signal}，正在关闭...` });
  stopBackgroundTimers();
  stopAuthTimers();
  alertService.stop();
  webhookService.stop();
  await stopQueue();
  // 先优雅关闭 HTTP 服务（等待进行中的请求完成），再断开 DB
  if (serverInstance) {
    try {
      await serverInstance.close();
      logger.info({ msg: 'HTTP 服务已关闭' });
    } catch (e) {
      logger.error({ err: e as Error, msg: 'HTTP 服务关闭异常' });
    }
  }
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
