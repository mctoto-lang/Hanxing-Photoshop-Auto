/**
 * Worker 内部接口 - 节点注册与领取任务
 *
 * POST /internal/workers/register   节点注册（需 WORKER_REGISTER_SECRET）
 * POST /internal/workers/claim      长轮询领取任务（需 Worker Token）
 * POST /internal/workers/refresh-token  刷新访问令牌（需当前令牌鉴权）
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workerService } from '../../services/worker/worker-service.js';
import { bootstrapTokenService } from '../../services/worker/bootstrap-token-service.js';
import { renderJobService } from '../../services/render-job/job-service.js';
import { queue } from '../../services/render-job/queue.js';
import { env, isProd } from '../../config/env.js';
import { Errors } from '../../lib/errors.js';

const registerSchema = z.object({
  machineFingerprint: z.string().min(1),
  psVersion: z.string().min(1),
  psMajorVersion: z.number().int().positive(),
  os: z.literal('windows'),
  supportsSmartObject: z.boolean(),
  supportsTextLayer: z.boolean(),
  fonts: z.array(z.string()),
  // 第四期 M9：硬件画像（全部可选，旧 Worker 不传则 DB 字段为 null）
  hostname: z.string().max(255).optional(),
  cpuModel: z.string().max(255).optional(),
  cpuCores: z.number().int().min(1).max(1024).optional(),
  cpuLogicalCores: z.number().int().min(1).max(4096).optional(),
  cpuClockMhz: z.number().int().min(100).max(10000).optional(),
  gpuModel: z.string().max(512).optional(),
  gpuVramMb: z.number().int().min(0).max(1024 * 1024).optional(),
  totalMemoryMb: z.number().int().min(0).max(1024 * 1024).optional(),
  availableMemoryMb: z.number().int().min(0).max(1024 * 1024).optional(),
  osVersion: z.string().max(255).optional(),
  diskTotalMb: z.number().int().min(0).max(1024 * 1024 * 100).optional(),
  diskFreeMb: z.number().int().min(0).max(1024 * 1024 * 100).optional(),
  hardwareInfo: z.string().max(64 * 1024).optional(), // 原始 JSON 字符串，最多 64KB
});

/**
 * M4 修复：claim 请求体 zod 校验。
 * 原实现 body.maxWaitSeconds / psMajorVersion / supportsSmartObject 等字段直接
 *   Number(body.xxx ?? 默认值) 转换，无类型/范围校验，可被注入 NaN / 负数 / 字符串。
 */
const claimSchema = z.object({
  maxWaitSeconds: z.number().int().min(1).max(env.CLAIM_MAX_WAIT_SECONDS).optional(),
  psMajorVersion: z.number().int().min(1).max(100).optional(),
  supportsSmartObject: z.boolean().optional(),
  supportsTextLayer: z.boolean().optional(),
  os: z.literal('windows').optional(),
  installedFonts: z.array(z.string()).optional(),
});

/**
 * 判断 IP 是否为 loopback（127.0.0.1 / ::1 / ::ffff:127.0.0.1）
 */
function isLoopbackIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1') return true;
  // IPv4-mapped IPv6
  if (ip.startsWith('::ffff:')) {
    const v4 = ip.slice(7);
    return v4 === '127.0.0.1';
  }
  return false;
}

/**
 * 校验 Worker 注册凭据
 *
 * 支持两种凭据（优先级从高到低）：
 *   1. 一次性配对码 / 一次性完整 token（bootstrapTokenService 校验，用后即焚）
 *   2. 长期密钥 WORKER_REGISTER_SECRET（恒定时间比较，兼容旧 Worker）
 *
 * P0 高危修复（H1）：原实现在 dev 模式未配置密钥时完全开放注册，
 *   若 dev 环境误暴露公网，任意人都可注册恶意 Worker 窃取任务素材。
 *   现改为：未配置密钥时仅允许 loopback IP 注册，非本地请求必须携带密钥。
 *   - 生产环境：必须携带配对码/token 或长期密钥
 *   - 开发环境且未配置密钥：仅允许 loopback（127.0.0.1 / ::1）放行
 *   - 开发环境且已配置密钥：与生产一致
 *
 * @returns tokenId 如果通过配对码/token 校验，返回 token id 用于后续绑定 Worker；长期密钥或 loopback 返回 null
 */
async function verifyRegisterCredential(req: any, reply: any): Promise<string | null> {
  const auth = req.headers.authorization;
  const provided =
    auth?.startsWith('Bearer ') ? auth.slice(7).trim() :
    (req.headers['x-worker-register-secret'] as string)?.trim() ?? '';

  // 1. 优先校验一次性配对码 / token
  if (provided) {
    const tokenInfo = await bootstrapTokenService.verifyAndConsume(provided);
    if (tokenInfo) {
      return tokenInfo.id;
    }
  }

  // 2. fallback 到长期密钥
  if (env.WORKER_REGISTER_SECRET) {
    if (!provided || provided.length !== env.WORKER_REGISTER_SECRET.length) {
      reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Worker 注册凭据无效' });
      return null;
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(env.WORKER_REGISTER_SECRET);
    if (a.length !== b.length || !a.equals(b)) {
      reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Worker 注册凭据无效' });
      return null;
    }
    return null;
  }

  // 3. 未配置长期密钥：dev 模式仅允许 loopback
  if (isProd) {
    reply.code(500).send({ error: 'CONFIG_ERROR', message: 'WORKER_REGISTER_SECRET 未配置' });
    return null;
  }
  const ip = String(req.ip ?? '');
  if (!isLoopbackIp(ip)) {
    reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: '未配置 WORKER_REGISTER_SECRET 时仅允许本机注册，请配置该密钥或使用配对码',
    });
    return null;
  }
  return null;
}

export async function workerRoutes(app: FastifyInstance) {
  // 注册（需 WORKER_REGISTER_SECRET，生产强制非空）
  app.post('/internal/workers/register', {
    schema: {
      tags: ['internal-workers'],
      summary: 'Worker 节点注册',
      description: '注册新的 Worker 节点，返回访问令牌（accessToken）。生产环境必须携带 WORKER_REGISTER_SECRET；dev 模式未配置密钥时仅允许 loopback 注册。',
      // P0 修复（严重3）：声明 security 表达注册鉴权
      security: [{ workerRegisterSecret: [] }],
      headers: {
        type: 'object',
        properties: {
          'Authorization': { type: 'string', description: 'Bearer <WORKER_REGISTER_SECRET> 或一次性配对码/token' },
          'X-Worker-Register-Secret': { type: 'string', description: '备选：注册密钥头' },
        },
      },
      body: {
        type: 'object',
        required: ['machineFingerprint', 'psVersion', 'psMajorVersion', 'os', 'supportsSmartObject', 'supportsTextLayer', 'fonts'],
        properties: {
          machineFingerprint: { type: 'string', description: '机器指纹（唯一标识）' },
          psVersion: { type: 'string', description: 'Photoshop 完整版本号（如 25.1.0）' },
          psMajorVersion: { type: 'integer', minimum: 1, description: 'PS 大版本号（如 25）' },
          os: { type: 'string', enum: ['windows'], description: '操作系统（当前仅支持 windows）' },
          supportsSmartObject: { type: 'boolean', description: '是否支持智能对象替换' },
          supportsTextLayer: { type: 'boolean', description: '是否支持文本图层替换' },
          fonts: { type: 'array', items: { type: 'string' }, description: '已安装字体的 PostScript 名称列表' },
          hostname: { type: 'string', maxLength: 255, description: '可选，主机名' },
          cpuModel: { type: 'string', maxLength: 255, description: '可选，CPU 型号' },
          cpuCores: { type: 'integer', minimum: 1, maximum: 1024, description: '可选，CPU 物理核心数' },
          totalMemoryMb: { type: 'integer', minimum: 0, maximum: 1048576, description: '可选，总内存（MB）' },
          osVersion: { type: 'string', maxLength: 255, description: '可选，操作系统版本' },
          // P0 修复（中等8）：补齐 zod 中存在但 OpenAPI 遗漏的 8 个硬件画像字段
          cpuLogicalCores: { type: 'integer', minimum: 1, maximum: 4096, description: '可选，CPU 逻辑核心数' },
          cpuClockMhz: { type: 'integer', minimum: 100, maximum: 10000, description: '可选，CPU 主频（MHz）' },
          gpuModel: { type: 'string', maxLength: 512, description: '可选，GPU 型号' },
          gpuVramMb: { type: 'integer', minimum: 0, maximum: 1048576, description: '可选，GPU 显存（MB）' },
          availableMemoryMb: { type: 'integer', minimum: 0, maximum: 1048576, description: '可选，可用内存（MB）' },
          diskTotalMb: { type: 'integer', minimum: 0, maximum: 104857600, description: '可选，磁盘总容量（MB）' },
          diskFreeMb: { type: 'integer', minimum: 0, maximum: 104857600, description: '可选，磁盘可用空间（MB）' },
          hardwareInfo: { type: 'string', maxLength: 65536, description: '可选，原始硬件信息 JSON 字符串（最多 64KB）' },
        },
      },
      response: {
        200: {
          type: 'object',
          // P0 修复：与 workerService.register() 实际返回对齐。
          //   原错误：required 声明了 code/sessionActive，但 service 返回 workerCode
          //   且不含 sessionActive，导致 fast-json-stringify 序列化缺失必填字段 → 500。
          required: ['workerId', 'workerCode', 'accessToken', 'tokenExpiresAt', 'allowedDownloadHosts'],
          properties: {
            workerId: { type: 'string', description: 'Worker 内部 ID' },
            workerCode: { type: 'string', description: 'Worker 编号（如 wrk_xxx）' },
            accessToken: { type: 'string', description: 'Worker 访问令牌（后续请求 Authorization: Bearer xxx）' },
            customCode: { type: 'string', nullable: true, description: '管理后台设置的自定义编号（Worker UI 优先展示此字段，回退到 workerCode）' },
            displayName: { type: 'string', nullable: true, description: '管理后台设置的显示名称' },
            tokenExpiresAt: { type: 'string', format: 'date-time', description: '令牌过期时间' },
            allowedDownloadHosts: {
              type: 'array',
              items: { type: 'string' },
              description: '当前存储配置下允许下载/上传的主机名列表（COS 桶域名等），Worker 据此自动更新 SSRF 白名单',
            },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '参数校验失败' },
        401: { $ref: 'ErrorResponse#', description: '注册凭据无效' },
        500: { $ref: 'ErrorResponse#', description: '生产环境未配置 WORKER_REGISTER_SECRET' },
      },
    },
  }, async (req, reply) => {
    const tokenId = await verifyRegisterCredential(req, reply);
    if (tokenId === null && reply.sent) return;

    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    // 第四期 M9：透传注册请求的 IP（trustProxy=true 时已解析 X-Forwarded-For）
    const result = await workerService.register(parsed.data, { registeredIp: req.ip ?? null });
    // 如果通过配对码注册，绑定 Worker ID 到 token 记录
    if (tokenId) {
      await bootstrapTokenService.bindWorker(tokenId, result.workerId);
    }
    return reply.send(result);
  });

  // 刷新令牌（需当前令牌鉴权）
  app.post('/internal/workers/refresh-token', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-workers'],
      summary: '刷新 Worker 访问令牌',
      description: '在令牌过期前刷新，返回新的访问令牌与过期时间。需当前有效的 Worker 令牌鉴权。',
      security: [{ workerToken: [] }],
      response: {
        200: {
          type: 'object',
          required: ['accessToken', 'tokenExpiresAt'],
          properties: {
            accessToken: { type: 'string', description: '新的 Worker 访问令牌' },
            tokenExpiresAt: { type: 'string', format: 'date-time', description: '新令牌过期时间' },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效或已过期' },
      },
    },
  }, async (req, reply) => {
    const user = req.user as any;
    const result = await workerService.refreshToken(user.workerId);
    return reply.send(result);
  });

  // 领取任务（长轮询，带能力路由）
  app.post('/internal/workers/claim', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-workers'],
      summary: '领取任务（长轮询）',
      description: 'Worker 长轮询领取任务，按能力路由匹配（PS 大版本、智能对象/文本图层支持、字体清单）。无任务时返回 202。成功领取后返回 leaseToken 与 manifest。',
      security: [{ workerToken: [] }],
      body: {
        type: 'object',
        properties: {
          // P0 修复（中等7）：maxWaitSeconds 范围与 zod 实际校验保持一致（上限 env.CLAIM_MAX_WAIT_SECONDS）
          maxWaitSeconds: { type: 'integer', minimum: 1, maximum: env.CLAIM_MAX_WAIT_SECONDS, description: `长轮询等待秒数（默认 ${env.CLAIM_MAX_WAIT_SECONDS}，上限 ${env.CLAIM_MAX_WAIT_SECONDS}）` },
          psMajorVersion: { type: 'integer', minimum: 1, maximum: 100, description: '当前 Worker 的 PS 大版本（用于能力匹配）' },
          supportsSmartObject: { type: 'boolean', description: '是否支持智能对象' },
          supportsTextLayer: { type: 'boolean', description: '是否支持文本图层' },
          os: { type: 'string', enum: ['windows'] },
          installedFonts: { type: 'array', items: { type: 'string' }, description: '已安装字体 PostScript 名列表（用于字体能力匹配）' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['jobId', 'jobCode', 'leaseToken', 'leaseExpiresAt', 'manifest'],
          properties: {
            jobId: { type: 'string', description: '任务内部 ID' },
            jobCode: { type: 'string', description: '任务编号（PSD_YYMMDD_NNNN 格式，用于 job 文件夹命名）' },
            leaseToken: { type: 'string', description: '租约令牌（心跳/完成/失败时需携带）' },
            leaseExpiresAt: { type: 'string', format: 'date-time', description: '租约过期时间' },
            // P0 修复：fast-json-stringify 对 { type: 'object' } 无 properties 的 schema
            //   会将对象序列化为空 {}，导致 manifest 所有字段（psdSha256、psdObjectKey 等）
            //   被剥离，Worker 收到 manifest={} 后 path.basename(undefined) 抛出
            //   ERR_INVALID_ARG_TYPE。必须设置 additionalProperties: true 才能透传全部字段。
            manifest: { type: 'object', additionalProperties: true, description: '任务执行清单（模板下载地址、输入资产、输出要求）' },
          },
        },
        202: {
          type: 'object',
          required: ['jobId', 'message'],
          properties: {
            jobId: { type: 'null' },
            message: { type: 'string', description: '暂无可用任务' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '参数校验失败' },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效或会话已失效' },
      },
    },
  }, async (req, reply) => {
    const parsed = claimSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    const body = parsed.data;
    const user = req.user as any;
    const maxWaitSeconds = body.maxWaitSeconds ?? env.CLAIM_MAX_WAIT_SECONDS;
    const psMajorVersion = body.psMajorVersion ?? 25;

    // 第二期：能力标签透传给队列层做匹配
    const capabilities: Record<string, unknown> = {
      supportsSmartObject: body.supportsSmartObject ?? true,
      supportsTextLayer: body.supportsTextLayer ?? true,
      os: body.os ?? 'windows',
    };

    const claim = await queue.claim({
      workerId: user.workerId,
      psMajorVersion,
      capabilities,
      maxWaitSeconds,
      installedFonts: body.installedFonts ? new Set(body.installedFonts) : undefined,
    });

    if (!claim) {
      // 无任务可领
      return reply.code(202).send({
        jobId: null,
        message: '暂无可用任务',
      });
    }

    const manifest = await renderJobService.buildManifest(claim.jobId);
    return reply.send({
      jobId: claim.jobId,
      jobCode: claim.jobCode,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt.toISOString(),
      manifest,
    });
  });

  // Worker 心跳（连接级，10 秒一次）
  app.post('/internal/workers/heartbeat', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-workers'],
      summary: 'Worker 心跳',
      description: 'Worker 连接级心跳（10 秒一次），刷新 lastHeartbeatAt。若会话已失效（被强制下线）返回 401 促使重新注册。',
      security: [{ workerToken: [] }],
      response: {
        200: {
          type: 'object',
          required: ['ok', 'serverTime'],
          properties: {
            ok: { type: 'boolean' },
            serverTime: { type: 'string', format: 'date-time', description: '服务端当前时间' },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效或会话已失效' },
      },
    },
  }, async (req, reply) => {
    const user = req.user as any;
    // P1-J：heartbeat 仅在 sessionActive=true 时刷新时间戳；
    //   若竞态窗口内 Worker 被强制下线，count=0，返回 401 促使 Worker 重新注册
    const result = await workerService.heartbeat(user.workerId);
    if (!result.active) {
      return reply.code(401).send({
        error: 'UNAUTHORIZED',
        message: 'Worker 会话已失效，请重新注册',
      });
    }
    return reply.send({ ok: true, serverTime: new Date().toISOString() });
  });

  // 查询 Worker 状态（供 Admin UI 使用，需 Admin 鉴权）
  app.get('/internal/workers', {
    preHandler: [app.requireAdminAuth],
    schema: {
      tags: ['internal-workers'],
      summary: 'Worker 列表（Admin）',
      description: '返回所有 Worker 节点列表（供 Admin UI 使用）。需 Admin 鉴权。与 /admin/api/workers 等价，保留此路径供内部调用。',
      security: [{ adminSession: [] }],
      response: {
        200: {
          type: 'object',
          required: ['workers'],
          properties: {
            workers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'Admin 未登录' },
        403: { $ref: 'ErrorResponse#', description: '权限不足' },
      },
    },
  }, async (_req, reply) => {
    const list = await workerService.list();
    return reply.send({ workers: list });
  });
}

export { Errors };
