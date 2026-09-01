/**
 * Worker 内部接口 - 任务执行
 *
 * POST /internal/jobs/:jobId/heartbeat   每 30 秒续约，上报当前阶段与进度
 * POST /internal/jobs/:jobId/complete    提交渲染结果（含 SHA-256），完成任务
 * POST /internal/jobs/:jobId/fail        上报任务失败
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { renderJobService } from '../../services/render-job/job-service.js';

const heartbeatSchema = z.object({
  leaseToken: z.string().min(1),
  stage: z.enum(['DOWNLOAD', 'RUN_JSX', 'EXPORT', 'UPLOAD']).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  message: z.string().optional(),
});

const completeSchema = z.object({
  leaseToken: z.string().min(1),
  resultObjectKey: z.string().min(1),
  resultSha256: z.string().min(1),
  resultMimeType: z.string().min(1),
  resultSize: z.number().int().positive(),
});

const failSchema = z.object({
  leaseToken: z.string().min(1),
  errorCode: z.enum([
    'PHOTOSHOP_SCRIPT_ERROR',
    'TEMPLATE_LAYER_NOT_FOUND',
    'FONT_UNAVAILABLE',
    'INVALID_INPUT_ASSET',
    'WORKER_LOST',
    'JOB_CANCELLED',
    'INVALID_LAYER_BINDING',
    'LEASE_LOST',
    'COMPLETE_REPORT_FAILED',
  ]),
  errorMessage: z.string().min(1),
  stage: z.string().optional(),
});

export async function jobInternalRoutes(app: FastifyInstance) {
  // 任务心跳
  app.post('/internal/jobs/:jobId/heartbeat', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-jobs'],
      summary: '任务心跳续约',
      description: 'Worker 每 30 秒续约任务租约，上报当前阶段（DOWNLOAD/RUN_JSX/EXPORT/UPLOAD）与进度（0-100）。租约过期则任务被回收。',
      security: [{ workerToken: [] }],
      params: {
        type: 'object',
        properties: { jobId: { type: 'string', description: '任务内部 ID' } },
      },
      body: {
        type: 'object',
        required: ['leaseToken'],
        properties: {
          leaseToken: { type: 'string', description: '领取任务时获得的租约令牌' },
          stage: { type: 'string', enum: ['DOWNLOAD', 'RUN_JSX', 'EXPORT', 'UPLOAD'], description: '当前执行阶段' },
          progress: { type: 'integer', minimum: 0, maximum: 100, description: '执行进度（0-100）' },
          message: { type: 'string', description: '可选，阶段说明信息' },
        },
      },
      response: {
        200: {
          type: 'object',
          required: ['ok', 'serverTime'],
          properties: {
            ok: { type: 'boolean' },
            serverTime: { type: 'string', format: 'date-time' },
          },
        },
        400: { $ref: 'ErrorResponse#', description: '参数校验失败' },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效' },
        409: { $ref: 'ErrorResponse#', description: '租约无效或已被其他 Worker 持有' },
      },
    },
  }, async (req, reply) => {
    const jobId = (req.params as any).jobId as string;
    const user = req.user as any;
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    await renderJobService.heartbeat(jobId, user.workerId, parsed.data.leaseToken, {
      stage: parsed.data.stage,
      progress: parsed.data.progress,
      message: parsed.data.message,
    });
    return reply.send({ ok: true, serverTime: new Date().toISOString() });
  });

  // 任务完成
  app.post('/internal/jobs/:jobId/complete', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-jobs'],
      summary: '提交任务结果',
      description: 'Worker 完成渲染后提交结果文件信息（objectKey / SHA-256 / MIME / size），服务端校验后置任务为 SUCCEEDED 并触发 Webhook。',
      security: [{ workerToken: [] }],
      params: {
        type: 'object',
        properties: { jobId: { type: 'string', description: '任务内部 ID' } },
      },
      body: {
        type: 'object',
        required: ['leaseToken', 'resultObjectKey', 'resultSha256', 'resultMimeType', 'resultSize'],
        properties: {
          leaseToken: { type: 'string', description: '租约令牌' },
          resultObjectKey: { type: 'string', description: '结果文件存储对象 key' },
          resultSha256: { type: 'string', description: '结果文件 SHA-256 哈希' },
          resultMimeType: { type: 'string', description: '结果文件 MIME 类型（image/png / image/jpeg / image/vnd.adobe.photoshop）' },
          resultSize: { type: 'integer', minimum: 1, description: '结果文件大小（字节）' },
        },
      },
      response: {
        200: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        400: { $ref: 'ErrorResponse#', description: '参数校验失败' },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效' },
        409: { $ref: 'ErrorResponse#', description: '租约无效或任务已被其他 Worker 处理' },
      },
    },
  }, async (req, reply) => {
    const jobId = (req.params as any).jobId as string;
    const user = req.user as any;
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    await renderJobService.complete(jobId, user.workerId, parsed.data.leaseToken, parsed.data);
    return reply.send({ ok: true });
  });

  // 任务失败
  app.post('/internal/jobs/:jobId/fail', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-jobs'],
      summary: '上报任务失败',
      description: 'Worker 上报任务失败，含错误码（PHOTOSHOP_SCRIPT_ERROR / TEMPLATE_LAYER_NOT_FOUND / FONT_UNAVAILABLE / INVALID_INPUT_ASSET / WORKER_LOST / JOB_CANCELLED / INVALID_LAYER_BINDING / LEASE_LOST / COMPLETE_REPORT_FAILED）与错误信息。',
      security: [{ workerToken: [] }],
      params: {
        type: 'object',
        properties: { jobId: { type: 'string', description: '任务内部 ID' } },
      },
      body: {
        type: 'object',
        required: ['leaseToken', 'errorCode', 'errorMessage'],
        properties: {
          leaseToken: { type: 'string', description: '租约令牌' },
          errorCode: {
            type: 'string',
            enum: ['PHOTOSHOP_SCRIPT_ERROR', 'TEMPLATE_LAYER_NOT_FOUND', 'FONT_UNAVAILABLE', 'INVALID_INPUT_ASSET', 'WORKER_LOST', 'JOB_CANCELLED', 'INVALID_LAYER_BINDING', 'LEASE_LOST', 'COMPLETE_REPORT_FAILED'],
            description: '错误码',
          },
          errorMessage: { type: 'string', description: '错误详情' },
          stage: { type: 'string', description: '可选，失败时所在阶段' },
        },
      },
      response: {
        200: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
        400: { $ref: 'ErrorResponse#', description: '参数校验失败' },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效' },
        409: { $ref: 'ErrorResponse#', description: '租约无效或任务已被其他 Worker 处理' },
      },
    },
  }, async (req, reply) => {
    const jobId = (req.params as any).jobId as string;
    const user = req.user as any;
    const parsed = failSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: '参数校验失败',
        details: parsed.error.issues,
      });
    }
    await renderJobService.fail(jobId, user.workerId, parsed.data.leaseToken, parsed.data);
    return reply.send({ ok: true });
  });

  // 第二期：取消信号检查（Worker 在阶段边界调用）
  // 若任务已被取消，返回 cancelled=true，Worker 应立即放弃任务并调用 fail(JOB_CANCELLED)
  app.get('/internal/jobs/:jobId/cancel-check', {
    preHandler: [app.authenticateWorker],
    schema: {
      tags: ['internal-jobs'],
      summary: '取消信号检查',
      description: 'Worker 在阶段边界调用，检查任务是否已被取消。若 cancelled=true，Worker 应立即放弃任务并调用 /fail 上报 JOB_CANCELLED。',
      security: [{ workerToken: [] }],
      params: {
        type: 'object',
        properties: { jobId: { type: 'string', description: '任务内部 ID' } },
      },
      response: {
        200: {
          type: 'object',
          required: ['cancelled', 'status'],
          properties: {
            cancelled: { type: 'boolean', description: '是否已被取消' },
            status: { type: 'string', description: '任务当前状态' },
          },
        },
        401: { $ref: 'ErrorResponse#', description: 'Worker 令牌无效' },
        // 注：service 在 job 不存在或 workerId 不匹配时统一返回 200 + { cancelled: false, status: 'UNKNOWN' }，
        // 避免向非持有方泄露任务存在性与状态，故不声明 404/409。
      },
    },
  }, async (req, reply) => {
    const jobId = (req.params as any).jobId as string;
    const user = req.user as any;
    const result = await renderJobService.checkCancelSignal(jobId, user.workerId);
    return reply.send(result);
  });
}
