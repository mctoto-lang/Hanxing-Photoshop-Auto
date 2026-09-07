/**
 * OpenAPI 文档插件（第三期 M7）
 *
 * 基于 @fastify/swagger + @fastify/swagger-ui 自动从路由 schema 生成 OpenAPI 3.0 文档
 *
 * 暴露端点：
 *   - GET /docs           Swagger UI 交互式文档
 *   - GET /docs/json      OpenAPI 3.0 JSON
 *   - GET /docs/yaml      OpenAPI 3.0 YAML（由 swagger-ui 内置支持）
 *
 * 文档分组（按 tag）：
 *   - 系统与可观测性 (system)
 *   - 存储代理 (storage)
 *   - 资产上传 (assets)
 *   - 模板管理 (templates)
 *   - 渲染任务 (render-jobs)
 *   - Worker 内部接口 (internal-workers)
 *   - Worker 任务执行 (internal-jobs)
 *   - Worker 字体清单 (internal-fonts)
 *   - Admin 鉴权 (admin-auth)
 *   - Admin 用户 (admin-users)
 *   - Admin 概览统计 (admin-stats)
 *   - Admin 模板 (admin-templates)
 *   - Admin 字体 (admin-fonts)
 *   - Admin Worker (admin-workers)
 *   - Admin 任务 (admin-jobs)
 *   - Admin API Key (admin-api-keys)
 *   - Admin 审计日志 (admin-audit-logs)
 *   - Admin Webhook 日志 (admin-webhook-logs)
 *   - Admin 告警 (admin-alerts)
 *   - Admin 存储配置 (admin-storage)
 *   - Admin 测试工具 (admin-tests)
 *
 * 鉴权：API Key Bearer 模式（Authorization: Bearer sk_live_xxx）
 */
import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

export default fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'PSD 渲染服务平台 API',
        description: [
          '## 概述',
          'PSD 模板渲染服务平台对外提供 PSD 模板管理、资产上传、渲染任务提交与查询的 HTTP API。',
          '',
          '## 鉴权',
          '所有 `/v1/*` 接口需在 `Authorization` 头携带 API Key（格式：`Bearer sk_live_xxx`）。',
          'API Key 通过 Admin 控制台创建，每个 Key 可配置：',
          '- 限流（rateLimitPerMin）：每分钟最大请求数',
          '- 日配额（quotaPerDay）：每天最大请求数',
          '- IP 白名单（ipWhitelist）',
          '- 默认 Webhook URL / Secret',
          '',
          '## 幂等性',
          '`POST /v1/render-jobs` 支持通过 `Idempotency-Key` 头实现幂等：',
          '同租户同 key 重复提交将返回相同任务，不重复创建。',
          '',
          '## Webhook',
          '任务终态（succeeded / failed / cancelled）时自动投递 Webhook 到提交时声明的 `webhookUrl`。',
          '投递包含 HMAC-SHA256 签名头 `X-Render-Signature`，可校验来源。',
          '失败自动重试，指数退避：1m / 5m / 15m / 60m / 240m / 960m。',
          '',
          '## 错误响应',
          '所有错误响应统一为 `{ "error": "<CODE>", "message": "<描述>", "details"?: [...] }`。',
        ].join('\n'),
        version: '0.3.0',
        contact: {
          name: 'PSD 渲染服务平台',
        },
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: 'http',
            scheme: 'bearer',
            description: 'API Key（格式：sk_live_xxx）',
            bearerFormat: 'sk_live_xxx',
          },
          adminSession: {
            type: 'http',
            scheme: 'bearer',
            description: 'Admin Session Token（登录后获得）',
            // P0 修复（轻微9）：补齐 bearerFormat 与 apiKey 保持一致
            bearerFormat: 'session_token',
          },
          workerToken: {
            type: 'http',
            scheme: 'bearer',
            description: 'Worker 访问令牌（注册后获得）',
            bearerFormat: 'wkr_xxx',
          },
          // P0 修复（严重3）：补充自定义 securityScheme 表达 storage/worker register 鉴权模型
          // L5 修复：移除"也支持 ?token= 查询参数"的过期描述——storage.ts 实际只接受
          //   Authorization: Bearer 头（P0 安全修复中危11 已彻底弃用 query string 传 token）
          storageSignedToken: {
            type: 'apiKey',
            in: 'header',
            name: 'Authorization',
            description: '存储签名令牌（格式：Bearer <token>，由 generateUploadUrl/generateDownloadUrl 签发，仅 local 模式可用。仅接受 Authorization 头传递，不支持 query 参数）',
          },
          storageSignedUrl: {
            type: 'apiKey',
            in: 'query',
            name: 'sig',
            description: '缩略图签名直链（key + exp + sig 三个查询参数联合 HMAC 签名，由 GET /v1/templates 列表的 thumbnailUrl 字段签发，默认 1 小时有效；仅限 thumbnails/ 前缀对象，仅 local 模式）',
          },
          workerRegisterSecret: {
            type: 'apiKey',
            in: 'header',
            name: 'Authorization',
            description: 'Worker 注册凭据（格式：Bearer <WORKER_REGISTER_SECRET> 或一次性授权码/token，也可通过 X-Worker-Register-Secret 头传递）',
          },
        },
      },
      tags: [
        { name: 'system', description: '系统与可观测性（健康检查、Prometheus 指标）' },
        { name: 'storage', description: '存储代理（local 模式专用，模拟 COS 预签名 URL）' },
        { name: 'assets', description: '资产上传' },
        { name: 'templates', description: '模板管理' },
        { name: 'render-jobs', description: '渲染任务' },
        { name: 'internal-workers', description: 'Worker 内部接口（节点注册/领取任务/心跳/令牌刷新；Admin UI 也调用列表查询）' },
        { name: 'internal-jobs', description: 'Worker 任务执行接口（心跳/完成/失败/取消检查）' },
        { name: 'internal-fonts', description: 'Worker 字体清单接口（manifest/上传/注册；Admin UI 也调用列表和上传地址）' },
        { name: 'admin-auth', description: 'Admin 鉴权' },
        { name: 'admin-users', description: 'Admin 用户管理' },
        { name: 'admin-stats', description: 'Admin 概览统计' },
        { name: 'admin-templates', description: 'Admin 模板操作' },
        { name: 'admin-fonts', description: 'Admin 字体操作' },
        { name: 'admin-workers', description: 'Admin Worker 操作' },
        { name: 'admin-jobs', description: 'Admin 任务操作' },
        { name: 'admin-api-keys', description: 'Admin API Key 管理' },
        { name: 'admin-audit-logs', description: 'Admin 审计日志' },
        { name: 'admin-webhook-logs', description: 'Admin Webhook 日志' },
        { name: 'admin-alerts', description: 'Admin 告警' },
        { name: 'admin-storage', description: 'Admin 存储配置' },
        { name: 'admin-tests', description: 'Admin 测试工具（渲染任务测试）' },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayRequestDuration: true,
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      persistAuthorization: true,
    },
    uiHooks: {
      onRequest: function (_req, _opts, done) { done(); },
      preHandler: function (_req, _reply, done) { done(); },
    },
  });
});
