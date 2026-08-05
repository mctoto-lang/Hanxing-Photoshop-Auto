/**
 * 渲染任务服务：创建、查询、状态机转换、Webhook 触发
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { genArtifactCode, sha256, safeEqual } from '../../lib/crypto.js';
import { env } from '../../config/env.js';
import { Errors, AppError } from '../../lib/errors.js';
import type {
  LayerSchema,
  LayerNode,
  RenderJobInput,
  RenderJobOutput,
  JobManifest,
  ErrorCode,
} from '../../types/index.js';
import { queue } from './queue.js';
import { getStorage } from '../storage/index.js';
import { storageConfigService } from '../storage/storage-config-service.js';
import { webhookService } from '../webhook/webhook-service.js';

export interface CreateJobParams {
  tenantId: string;
  apiKeyId?: string;
  idempotencyKey: string;
  templateVersionId: string;
  input: RenderJobInput;
  output: RenderJobOutput;
  priority?: number;
  webhookUrl?: string;
  traceId?: string;
  /** 第二期：能力路由要求（可选） */
  requiredCapabilities?: Record<string, unknown>;
  targetWorkerId?: string;
  jsxTimeoutSeconds?: number;
}

class RenderJobService {
  /**
   * 生成 PSD_YYMMDD_NNNN 格式的任务编号
   * - YY: 年份后两位（如 26 表示 2026）
   * - MMDD: 月日（如 0728 表示 7 月 28 日）
   * - NNNN: 当日序号（4 位，从 0001 开始）
   *
   * 并发冲突由 create() 中的 P2002 重试兜底：两个并发请求可能查到相同的
   * maxSeq，各自生成相同编号，DB 唯一约束会拒绝其中一个，失败方自增重试。
   */
  private async generateJobCode(): Promise<string> {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const prefix = `PSD_${yy}${mm}${dd}_`;

    // 查询今日已有的最大序号
    const todayJobs = await prisma.renderJob.findMany({
      where: { code: { startsWith: prefix } },
      select: { code: true },
    });
    let maxSeq = 0;
    for (const j of todayJobs) {
      const seq = parseInt(j.code.slice(prefix.length), 10);
      if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
    }
    return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`;
  }

  /**
   * 创建渲染任务（幂等）
   */
  async create(params: CreateJobParams) {
    // 幂等检查：同租户同 idempotencyKey 已存在则返回已有任务
    const existing = await prisma.renderJob.findFirst({
      where: {
        idempotencyKey: params.idempotencyKey,
        tenantId: params.tenantId,
      },
    });
    if (existing) {
      logger.info({
        jobId: existing.id,
        idempotencyKey: params.idempotencyKey,
        msg: '幂等命中，返回已有任务',
      });
      return { job: existing, created: false };
    }

    // 校验模板版本已发布
    const tv = await prisma.templateVersion.findUnique({
      where: { id: params.templateVersionId },
      include: { template: { include: { bindings: true } } },
    });
    if (!tv) throw Errors.templateNotPublished('模板版本不存在');
    if (tv.template.tenantId !== params.tenantId) throw Errors.templateNotPublished('模板版本不存在');
    if (!tv.published) throw Errors.templateNotPublished('模板版本未发布，无法提交渲染');

    if (params.targetWorkerId) {
      const worker = await prisma.worker.findUnique({ where: { id: params.targetWorkerId } });
      if (!worker || !worker.sessionActive) throw Errors.workerNotFound('指定 Worker 不存在或未连接');
    }

    // 校验 bindingId 全部在模板版本中
    const schema: LayerSchema = JSON.parse(tv.layerSchema);
    const validBindingIds = new Set(schema.bindings.map((b) => b.bindingId));
    const submittedIds = Object.keys(params.input);
    const invalid = submittedIds.filter((id) => !validBindingIds.has(id));
    if (invalid.length > 0) {
      throw Errors.invalidLayerBinding(`bindingId 不存在: ${invalid.join(', ')}`);
    }

    // 校验必填绑定都已提供
    const missingRequired = schema.bindings
      .filter((b) => b.required)
      .filter((b) => !params.input[b.bindingId]);
    if (missingRequired.length > 0) {
      throw Errors.invalidLayerBinding(
        `必填绑定缺失: ${missingRequired.map((b) => b.bindingId).join(', ')}`,
      );
    }

    // 校验输入资产：累计大小 ≤ 150MB + 资产存在 + SHA 校验
    let totalSize = 0;
    const inputArtifacts: Array<{
      bindingId: string;
      artifactId: string;
      objectKey: string;
      sha256: string;
      mimeType: string;
      sizeBytes: number;
    }> = [];

    for (const [bindingId, val] of Object.entries(params.input)) {
      const binding = schema.bindings.find((b) => b.bindingId === bindingId)!;
      // 文本绑定：无需资产
      if (binding.type === 'text') {
        if (val.text === undefined) {
          throw Errors.invalidLayerBinding(`绑定 ${bindingId} 缺少 text`);
        }
        if (binding.maxLength && val.text.length > binding.maxLength) {
          throw Errors.invalidLayerBinding(
            `绑定 ${bindingId} 文本超过最大长度 ${binding.maxLength}`,
          );
        }
        continue;
      }
      // 图片绑定：必须有 assetId
      if (!val.assetId) {
        throw Errors.invalidLayerBinding(`绑定 ${bindingId} 缺少 assetId`);
      }
      // P0 安全修复（高危7）：按 tenantId 隔离，防止租户 A 使用租户 B 的 assetId
      //   原 findUnique 仅按 code 查询，跨租户可访问他人资产
      const artifact = await prisma.artifact.findUnique({
        where: { code: val.assetId },
      });
      if (!artifact || artifact.kind !== 'input') {
        throw Errors.invalidInputAsset(`资产 ${val.assetId} 不存在或非输入类型`);
      }
      if (artifact.tenantId !== params.tenantId) {
        // 跨租户访问——不暴露"存在但无权"的信息，统一返回不存在
        throw Errors.invalidInputAsset(`资产 ${val.assetId} 不存在或非输入类型`);
      }
      if (artifact.jobId) throw Errors.invalidInputAsset(`资产 ${val.assetId} 已被其他任务使用`);
      if (artifact.expiresAt < new Date()) {
        throw Errors.invalidInputAsset(`资产 ${val.assetId} 已过期`);
      }
      // P1-H：校验 sha256 已写回——上传未完成或回写失败时 sha256 为空，
      //   此时 Worker 端的 SHA-256 校验将失效（空串与任意 hash 比较恒不等）
      if (!artifact.sha256 || artifact.sha256.length !== 64) {
        throw Errors.invalidInputAsset(`资产 ${val.assetId} 尚未完成上传或校验不完整，请重新上传`);
      }
      totalSize += artifact.sizeBytes;
      inputArtifacts.push({
        bindingId,
        artifactId: artifact.id,
        objectKey: artifact.objectKey,
        sha256: artifact.sha256,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      });
    }

    if (totalSize > env.MAX_INPUT_SIZE_MB * 1024 * 1024) {
      throw Errors.inputSizeExceeded();
    }

    // 创建任务 + 输入产物关联（复用已存在的 artifact，通过 jobId 回填）
    // 任务编号采用 PSD_YYMMDD_NNNN 格式，并发时可能发生编号冲突（P2002 on code），
    //   此时自增序号重试。幂等冲突（P2002 on idempotencyKey）则返回已有任务。
    let job: Awaited<ReturnType<typeof prisma.renderJob.create>> | undefined;
    const MAX_CODE_RETRIES = 5;
    for (let attempt = 0; attempt <= MAX_CODE_RETRIES; attempt++) {
      try {
        job = await prisma.renderJob.create({
          data: {
            code: await this.generateJobCode(),
            idempotencyKey: params.idempotencyKey,
            tenantId: params.tenantId,
            apiKeyId: params.apiKeyId,
            templateVersionId: params.templateVersionId,
            inputJson: JSON.stringify(params.input),
            outputFormat: params.output.format,
            priority: params.priority ?? 5,
            maxAttempts: env.MAX_ATTEMPTS,
            jsxTimeoutSeconds: Math.min(3600, Math.max(60, Math.trunc(params.jsxTimeoutSeconds ?? 600))),
            webhookUrl: params.webhookUrl,
            traceId: params.traceId,
            status: 'QUEUED',
            // 第二期：能力路由要求（JSON 字符串）
            requiredCapabilities: params.requiredCapabilities
              ? JSON.stringify(params.requiredCapabilities)
              : null,
            targetWorkerId: params.targetWorkerId,
          },
        });
        break;
      } catch (e: any) {
        // P1-6 修复：捕获唯一约束错误（并发同 idempotencyKey），返回已有任务
        // 原 findFirst 检查与 create 之间存在 TOCTOU 窗口，并发请求会触发唯一约束冲突
        if (e?.code === 'P2002' && e?.meta?.target?.includes('idempotencyKey')) {
          const existing = await prisma.renderJob.findFirst({
            where: {
              idempotencyKey: params.idempotencyKey,
              tenantId: params.tenantId,
            },
          });
          if (existing) {
            logger.info({
              jobId: existing.id,
              idempotencyKey: params.idempotencyKey,
              msg: '幂等命中（并发竞态后回落），返回已有任务',
            });
            return { job: existing, created: false };
          }
        }
        // 任务编号冲突（并发生成相同 PSD_YYMMDD_NNNN），自增重试
        if (e?.code === 'P2002' && e?.meta?.target?.includes('code') && attempt < MAX_CODE_RETRIES) {
          logger.warn({ attempt, msg: '任务编号冲突，重试生成' });
          continue;
        }
        throw e;
      }
    }
    // 循环正常结束意味着 job 必已赋值（最后一次迭代会 throw 而非 continue）
    if (!job) throw new Error('UNREACHABLE: 任务创建失败');

    // 回填输入产物的 jobId
    // P2-7 修复：原循环串行 await N 次 SQL，改用 $transaction 一次性提交
    // N 个输入资产时减少 N-1 次 DB 往返
    if (inputArtifacts.length > 0) {
      try {
        const claimedArtifacts = await prisma.$transaction(
          inputArtifacts.map((a) =>
            prisma.artifact.updateMany({
              where: { id: a.artifactId, jobId: null },
              data: { jobId: job.id, bindingId: a.bindingId },
            }),
          ),
        );
        if (claimedArtifacts.some((result) => result.count !== 1)) {
          throw Errors.invalidInputAsset('一个或多个输入资产已被其他任务使用');
        }
      } catch (error) {
        await prisma.renderJob.delete({ where: { id: job.id } }).catch(() => {});
        throw error;
      }
    }

    logger.info({
      jobId: job.id,
      templateVersionId: params.templateVersionId,
      msg: '任务已创建并入队',
    });

    // 通知等待中的 Worker
    queue.notifyNewJob();

    return { job, created: true };
  }

  /**
   * 查询任务
   */
  async get(jobId: string, tenantId: string) {
    const job = await prisma.renderJob.findUnique({
      where: { code: jobId },
      include: {
        templateVersion: { include: { template: true } },
        artifacts: true,
        worker: true,
      },
    });
    if (!job) return null;
    if (job.tenantId !== tenantId) return null;

    // 成功任务：生成结果下载地址（3 天有效）
    let resultUrl: string | undefined;
    if (job.status === 'SUCCEEDED') {
      const outputArtifact = job.artifacts.find((a) => a.kind === 'output');
      if (outputArtifact) {
        const storage = await getStorage();
        const ttl = env.OUTPUT_RETENTION_DAYS * 86400;
        const dl = await storage.generateDownloadUrl({
          objectKey: outputArtifact.objectKey,
          expiresInSec: ttl,
        });
        resultUrl = dl.downloadUrl;
      }
    }

    return {
      jobId: job.code,
      status: job.status,
      attempt: job.attempt,
      priority: job.priority,
      stage: job.stage,
      progress: job.progress,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      template: {
        name: job.templateVersion.template.name,
        version: job.templateVersion.version,
      },
      resultUrl,
      resultExpiresAt: job.artifacts.find((a) => a.kind === 'output')?.expiresAt ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      queuedAt: job.queuedAt,
      succeededAt: job.succeededAt,
      failedAt: job.failedAt,
    };
  }

  /**
   * 生成 Worker 领取任务后的 manifest（包含所有下载地址）
   */
  async buildManifest(jobId: string): Promise<JobManifest> {
    const job = await prisma.renderJob.findUnique({
      where: { id: jobId },
      include: {
        templateVersion: { include: { template: true } },
        artifacts: { where: { kind: 'input' } },
      },
    });
    if (!job) throw Errors.workerNotFound('任务不存在');

    const layerSchemaRaw: LayerSchema = JSON.parse(job.templateVersion.layerSchema);
    // 过滤掉非 smartObject/text/pixel 的旧类型绑定（向后兼容旧数据，避免 JSX 报错）
    const layerSchema: LayerSchema = {
      ...layerSchemaRaw,
      bindings: layerSchemaRaw.bindings.filter(
        (b) => b.type === 'smartObject' || b.type === 'text' || b.type === 'pixel',
      ),
    };
    const input: RenderJobInput = JSON.parse(job.inputJson);
    const output: RenderJobOutput = {
      format: job.outputFormat as 'png' | 'jpeg' | 'psd',
    };

    const storage = await getStorage();
    // manifest 下载/上传预签名 URL 有效期：独立配置项（默认 600s），可在 Admin UI 调整。
    //   原 LEASE_TTL_SECONDS*3（=270s）会被 271s+ 的 JSX 执行踩线导致上传 URL 过期
    //   （403 Request has expired）。需大于 JSX 最长执行时间。
    const runtime = await storageConfigService.getRuntime();
    const urlTtl = runtime.manifestUrlExpiresSec;
    // P1-17 修复：并行生成产物与字体的下载 URL
    // 原串行 for-await 在多输入+多字体时 Worker claim 响应延迟显著
    // P2-D：downloadToken 单独返回，Worker 通过 Authorization: Bearer 头携带，
    //   不再嵌入 URL query string（避免进入 Nginx/Fastify 日志、Referer）
    const [artifacts, psdDl, fontList] = await Promise.all([
      Promise.all(
        job.artifacts.map(async (a) => {
          const dl = await storage.generateDownloadUrl({
            objectKey: a.objectKey,
            expiresInSec: urlTtl,
          });
          return {
            bindingId: a.bindingId!,
            objectKey: a.objectKey,
            sha256: a.sha256,
            mimeType: a.mimeType,
            downloadUrl: dl.downloadUrl,
            downloadToken: dl.downloadToken ?? '',
          };
        }),
      ),
      storage.generateDownloadUrl({
        objectKey: job.templateVersion.psdObjectKey,
        expiresInSec: urlTtl,
      }),
      (async () => {
        const fonts = await prisma.fontVersion.findMany({ where: { published: true } });
        return Promise.all(
          fonts.map(async (f) => {
            const dl = await storage.generateDownloadUrl({
              objectKey: f.fileObjectKey,
              expiresInSec: urlTtl,
            });
            return {
              fontId: f.id,
              postscriptName: f.postscriptName,
              fileObjectKey: f.fileObjectKey,
              sha256: f.sha256,
              downloadUrl: dl.downloadUrl,
              downloadToken: dl.downloadToken ?? '',
            };
          }),
        );
      })(),
    ]);

    // 图片替换图层的目标尺寸（供 Worker 预处理图片到目标尺寸）
    // smartObject：使用 smartObjectSize（智能对象内部文档尺寸）
    // pixel：降级使用 bounds 画布尺寸（像素图层无内部文档尺寸）
    const layerTree: LayerNode[] = JSON.parse(job.templateVersion.layerTree);
    const flatLayers = this.flattenLayerTree(layerTree);
    const layerById = new Map(flatLayers.filter((n) => n.layerId !== 0).map((n) => [n.layerId, n]));
    const layerByPath = new Map(flatLayers.map((n) => [n.layerPath, n]));
    const layerSizes: Array<{ layerId: number; layerPath: string; width: number; height: number }> = [];
    for (const b of layerSchema.bindings) {
      const node = layerById.get(b.layerId) ?? layerByPath.get(b.layerPath);
      if (!node) continue;
      if (b.type === 'smartObject' && node.smartObjectSize) {
        layerSizes.push({
          layerId: b.layerId,
          layerPath: b.layerPath,
          width: node.smartObjectSize.width,
          height: node.smartObjectSize.height,
        });
      } else if (b.type === 'pixel' && node.bounds) {
        // 像素图层无内部文档尺寸，使用图层边界作为目标尺寸
        const w = node.bounds.right - node.bounds.left;
        const h = node.bounds.bottom - node.bounds.top;
        if (w > 0 && h > 0) {
          layerSizes.push({ layerId: b.layerId, layerPath: b.layerPath, width: w, height: h });
        }
      }
    }

    // 结果上传地址（Worker 直接 PUT 文件到此 URL）
    const outputExt = job.outputFormat === 'jpeg' ? 'jpg' : job.outputFormat;
    const resultObjectKey = `output/${job.id}/result.${outputExt}`;
    const resultMime = job.outputFormat === 'png' ? 'image/png'
      : job.outputFormat === 'jpeg' ? 'image/jpeg'
      : 'image/vnd.adobe.photoshop';
    const resultUp = await storage.generateUploadUrl({
      objectKey: resultObjectKey,
      mimeType: resultMime,
      expiresInSec: urlTtl,
    });

    return {
      jobId: job.id,
      jobCode: job.code,
      templateVersionId: job.templateVersionId,
      psdObjectKey: job.templateVersion.psdObjectKey,
      psdSha256: job.templateVersion.psdSha256,
      psdDownloadUrl: psdDl.downloadUrl,
      // P2-D：PSD 下载令牌单独返回，Worker 通过 Authorization 头携带
      psdDownloadToken: psdDl.downloadToken ?? '',
      layerSchema,
      input,
      output,
      artifacts,
      fonts: fontList,
      layerSizes,
      jsxTimeoutSeconds: job.jsxTimeoutSeconds,
      resultUploadUrl: resultUp.uploadUrl,
      resultObjectKey,
      resultUploadToken: resultUp.uploadToken,
      // P2-D：上传请求头（含 Authorization Bearer），Worker 直接使用
      resultUploadHeaders: resultUp.headers ?? {},
    };
  }

  /** 扁平化图层树 */
  private flattenLayerTree(nodes: LayerNode[]): LayerNode[] {
    const result: LayerNode[] = [];
    const walk = (ns: LayerNode[]) => {
      for (const n of ns) {
        result.push(n);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(nodes);
    return result;
  }

  /**
   * Worker 心跳续约
   */
  async heartbeat(jobId: string, workerId: string, leaseToken: string, data: {
    stage?: string;
    progress?: number;
    message?: string;
  }) {
    const job = await this.verifyLease(jobId, workerId, leaseToken);
    const now = new Date();
    const newExpires = new Date(now.getTime() + env.LEASE_TTL_SECONDS * 1000);

    // P1-2 修复：使用条件更新防止 TOCTOU 覆盖
    // verifyLease 与 update 之间，租约可能过期被回收器重排队、被新 Worker 领取。
    // 此时旧 Worker 的心跳会覆盖新 Worker 的 leaseToken/leaseExpiresAt。
    // updateMany 仅在 status 仍为 LEASED/PROCESSING 且 leaseToken 匹配时才更新
    const heartbeatResult = await prisma.renderJob.updateMany({
      where: {
        id: job.id,
        leaseToken,
        status: { in: ['LEASED', 'PROCESSING'] },
      },
      data: {
        leaseExpiresAt: newExpires,
        stage: data.stage ?? job.stage,
        progress: data.progress ?? job.progress,
        status: data.stage && job.status === 'LEASED' ? 'PROCESSING' : job.status,
        processingAt: job.processingAt ?? (data.stage ? now : null),
      },
    });

    if (heartbeatResult.count === 0) {
      // 租约已被回收或被其他 Worker 领取，拒绝心跳
      throw Errors.leaseExpired();
    }

    await prisma.$transaction([
      prisma.jobHeartbeat.create({
        data: {
          jobId: job.id,
          workerId,
          stage: data.stage,
          progress: data.progress ?? 0,
          message: data.message,
        },
      }),
      prisma.worker.update({
        where: { id: workerId },
        data: { lastHeartbeatAt: now },
      }),
    ]);
  }

  /**
   * Worker 提交渲染结果
   */
  async complete(jobId: string, workerId: string, leaseToken: string, data: {
    resultObjectKey: string;
    resultSha256: string;
    resultMimeType: string;
    resultSize: number;
  }) {
    const job = await this.verifyLease(jobId, workerId, leaseToken);

    // B-H3 修复：实际校验结果文件 SHA-256 与 MIME，原仅检查文件存在并直接信任 Worker 上报值。
    //   一个被攻破/异常的 Worker 可上传任意内容并上报不匹配的 sha256，污染 artifact 表的完整性证明。
    //   现拉取对象内容计算 SHA-256 并与上报值恒定时间比较；同时校验 MIME 白名单与大小一致性。
    const storage = await getStorage();
    const meta = await storage.headObject(data.resultObjectKey);
    if (!meta) {
      throw new AppError('PHOTOSHOP_SCRIPT_ERROR', `结果文件不存在: ${data.resultObjectKey}`);
    }
    // MIME 白名单校验（与 Worker 输出契约一致：png/jpeg/psd）
    const allowedMimes = ['image/png', 'image/jpeg', 'image/vnd.adobe.photoshop'];
    if (!allowedMimes.includes(data.resultMimeType)) {
      throw new AppError('PHOTOSHOP_SCRIPT_ERROR', `结果文件 MIME 类型不被允许: ${data.resultMimeType}`);
    }
    // 大小一致性校验（防御上报值与实际不符）
    if (data.resultSize <= 0 || data.resultSize !== meta.size) {
      throw new AppError('PHOTOSHOP_SCRIPT_ERROR', `结果文件大小不匹配: 上报 ${data.resultSize}, 实际 ${meta.size}`);
    }
    // SHA-256 重新计算并恒定时间比较（防时序侧信道）
    const buffer = await storage.getObject(data.resultObjectKey);
    const actualSha256 = sha256(buffer);
    if (!safeEqual(actualSha256, data.resultSha256)) {
      throw new AppError('PHOTOSHOP_SCRIPT_ERROR', '结果文件 SHA-256 校验失败：上报值与实际内容不匹配');
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + env.OUTPUT_RETENTION_DAYS * 86400 * 1000);

    await prisma.$transaction(async (tx) => {
      // 创建输出产物
      // P0 安全修复（高危7）：输出产物继承 job.tenantId，与输入资产保持租户隔离
      await tx.artifact.create({
        data: {
          code: genArtifactCode(),
          jobId: job.id,
          kind: 'output',
          objectKey: data.resultObjectKey,
          sha256: data.resultSha256,
          mimeType: data.resultMimeType,
          sizeBytes: data.resultSize,
          expiresAt,
          tenantId: job.tenantId,
        },
      });
      // P1-2 修复：条件更新——仅当任务仍为 LEASED/PROCESSING 且 leaseToken 匹配时才置为 SUCCEEDED
      // 防止租约过期被重排队后，原 Worker 的 complete 覆盖新 Worker 的 lease
      const completeResult = await tx.renderJob.updateMany({
        where: {
          id: job.id,
          leaseToken,
          status: { in: ['LEASED', 'PROCESSING'] },
        },
        data: {
          status: 'SUCCEEDED',
          stage: 'UPLOAD',
          progress: 100,
          succeededAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (completeResult.count === 0) {
        // 产物已创建但任务状态已被其他 Worker 接管——回滚事务
        throw Errors.leaseExpired();
      }
      // 释放 Worker
      await tx.worker.update({
        where: { id: workerId },
        data: { currentJobId: null },
      });
      if (job.webhookUrl) {
        await webhookService.enqueueOutbox(tx, {
          jobId: job.id,
          event: 'job.succeeded',
          targetUrl: job.webhookUrl,
          apiKeyId: job.apiKeyId,
        });
      }
    });

    logger.info({ jobId: job.id, msg: '任务完成' });

    // 触发 Webhook（M6 生产级：幂等 + 重试 + 指数退避）
  }

  /**
   * Worker 上报失败
   */
  async fail(jobId: string, workerId: string, leaseToken: string, data: {
    errorCode: ErrorCode;
    errorMessage: string;
    stage?: string;
  }) {
    const job = await this.verifyLease(jobId, workerId, leaseToken);
    const now = new Date();

    // B-H2 修复：任务状态更新与 Worker 释放纳入单一事务，与 complete 方法保持一致。
    //   原实现两条独立 SQL，若 renderJob.updateMany 成功但 worker.update 失败，
    //   会导致任务已 FAILED 而 worker.currentJobId 仍指向已结束任务，Worker 中间窗口无法领取新任务。
    await prisma.$transaction(async (tx) => {
      // P1-2 修复：条件更新——仅当任务仍为 LEASED/PROCESSING 且 leaseToken 匹配时才置为 FAILED
      const failResult = await tx.renderJob.updateMany({
        where: {
          id: job.id,
          leaseToken,
          status: { in: ['LEASED', 'PROCESSING'] },
        },
        data: {
          status: 'FAILED',
          errorCode: data.errorCode,
          errorMessage: data.errorMessage,
          stage: data.stage,
          failedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });

      if (failResult.count === 0) {
        // 任务已被其他 Worker 接管，拒绝 fail 上报，事务回滚
        throw Errors.leaseExpired();
      }

      // 释放 Worker
      await tx.worker.update({
        where: { id: workerId },
        data: { currentJobId: null },
      });
      if (job.webhookUrl) {
        await webhookService.enqueueOutbox(tx, {
          jobId: job.id,
          event: 'job.failed',
          targetUrl: job.webhookUrl,
          apiKeyId: job.apiKeyId,
          payload: { errorCode: data.errorCode, errorMessage: data.errorMessage },
        });
      }
    });

    logger.warn({ jobId: job.id, code: data.errorCode, msg: '任务失败' });

  }

  /**
   * 校验租约：workerId + leaseToken 必须匹配
   */
  private async verifyLease(jobId: string, workerId: string, leaseToken: string) {
    const job = await prisma.renderJob.findUnique({ where: { id: jobId } });
    if (!job) throw Errors.workerNotFound('任务不存在');
    if (job.workerId !== workerId) throw Errors.leaseTokenMismatch('workerId 不匹配');
    // P1-D 修复：leaseToken 改用恒定时间比较（safeEqual 已 import 自 crypto.js）
    //   原直接 !== 短路比较，与项目其他敏感比较（API Key、Worker token、签名、SHA-256）实践不一致。
    //   虽 96 bit 熵让在线爆破不现实，但保持一致的安全实践并防时序侧信道。
    if (!safeEqual(job.leaseToken ?? '', leaseToken)) throw Errors.leaseTokenMismatch('leaseToken 不匹配');
    if (job.leaseExpiresAt && job.leaseExpiresAt < new Date()) {
      throw Errors.leaseExpired();
    }
    if (job.status !== 'LEASED' && job.status !== 'PROCESSING') {
      throw Errors.leaseExpired(`任务状态 ${job.status} 不允许操作`);
    }
    return job;
  }

  // ============== 第二期：任务取消 ==============

  /**
   * 请求取消任务（外部 API 调用）
   *
   * 状态机：
   *   - QUEUED       → 直接 CANCELLED（未开始执行）
   *   - LEASED/PROCESSING → CANCELLING（等待 Worker 在阶段边界检测并主动放弃）
   *   - SUCCEEDED/FAILED/CANCELLED → 409 拒绝
   *
   * @returns updated=true 表示已发起取消；false 表示无需取消（已是终态）
   */
  async cancel(jobCode: string, tenantId: string, reason?: string): Promise<{
    jobId: string;
    status: string;
    updated: boolean;
  }> {
    const job = await prisma.renderJob.findUnique({
      where: { code: jobCode },
    });
    if (!job) throw Errors.notFound('任务不存在');
    if (job.tenantId !== tenantId) throw Errors.notFound('任务不存在');

    const now = new Date();

    // 已是终态：拒绝
    if (job.status === 'SUCCEEDED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
      return { jobId: job.id, status: job.status, updated: false };
    }

    // B-H1 修复：条件更新（WHERE status 检查）防止 TOCTOU 竞态。
    //   原无条件 update 会在 findUnique 与 update 之间被 Worker claimNextJob/complete/fail
    //   抢占，导致 workerId/leaseToken 被错误清空或终态被覆盖为 CANCELLING。
    //   现统一用 updateMany + WHERE status 仅在状态仍符合预期时更新。

    // QUEUED：直接取消，无需 Worker 介入
    if (job.status === 'QUEUED') {
      const cancelResult = await prisma.$transaction(async (tx) => {
        const result = await tx.renderJob.updateMany({
          where: { id: job.id, status: 'QUEUED' },
          data: {
            status: 'CANCELLED',
            cancelRequestedAt: now,
            cancelReason: reason ?? 'caller_requested',
            cancelledAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
            workerId: null,
          },
        });
        if (result.count === 1 && job.webhookUrl) {
          await webhookService.enqueueOutbox(tx, {
            jobId: job.id,
            event: 'job.cancelled',
            targetUrl: job.webhookUrl,
            apiKeyId: job.apiKeyId,
            payload: { reason: reason ?? 'caller_requested', source: 'queued' },
          });
        }
        return result;
      });
      if (cancelResult.count === 0) {
        // 状态已被并发改变（如被 Worker claim 为 LEASED），按当前最新状态返回
        const fresh = await prisma.renderJob.findUnique({ where: { id: job.id } });
        if (fresh && (fresh.status === 'SUCCEEDED' || fresh.status === 'FAILED' || fresh.status === 'CANCELLED')) {
          return { jobId: job.id, status: fresh.status, updated: false };
        }
        // 已被领取，转走 CANCELLING 分支
        const cancelingResult = await prisma.renderJob.updateMany({
          where: { id: job.id, status: { in: ['LEASED', 'PROCESSING', 'CANCELLING'] } },
          data: {
            status: 'CANCELLING',
            cancelRequestedAt: now,
            cancelReason: reason ?? 'caller_requested',
          },
        });
        if (cancelingResult.count === 0) {
          return { jobId: job.id, status: fresh?.status ?? job.status, updated: false };
        }
        logger.info({ jobId: job.id, msg: '任务标记为 CANCELLING，等待 Worker 检测取消信号' });
        return { jobId: job.id, status: 'CANCELLING', updated: true };
      }
      logger.info({ jobId: job.id, msg: 'QUEUED 任务直接取消' });

      // 触发 job.cancelled webhook
      return { jobId: job.id, status: 'CANCELLED', updated: true };
    }

    // LEASED / PROCESSING / CANCELLING：标记 CANCELLING，等 Worker 在阶段边界检测
    const cancelingResult = await prisma.renderJob.updateMany({
      where: {
        id: job.id,
        status: { in: ['LEASED', 'PROCESSING', 'CANCELLING'] },
      },
      data: {
        status: 'CANCELLING',
        cancelRequestedAt: now,
        cancelReason: reason ?? 'caller_requested',
      },
    });
    if (cancelingResult.count === 0) {
      // 状态已被并发改为终态，返回最新状态
      const fresh = await prisma.renderJob.findUnique({ where: { id: job.id } });
      return { jobId: job.id, status: fresh?.status ?? job.status, updated: false };
    }
    logger.info({ jobId: job.id, msg: '任务标记为 CANCELLING，等待 Worker 检测取消信号' });
    return { jobId: job.id, status: 'CANCELLING', updated: true };
  }

  /**
   * Worker 在阶段边界检查取消信号
   * - 若任务已标记 CANCELLING：上报 FAILED + errorCode=JOB_CANCELLED，释放 Worker
   * - 否则正常继续
   *
   * @returns cancelled=true 表示 Worker 应立即放弃任务
   */
  async checkCancelSignal(
    jobId: string,
    workerId: string,
  ): Promise<{ cancelled: boolean; status: string }> {
    try {
      const job = await prisma.renderJob.findUnique({
        where: { id: jobId },
        select: { id: true, status: true, workerId: true, webhookUrl: true, apiKeyId: true, cancelReason: true },
      });
      if (!job) return { cancelled: false, status: 'UNKNOWN' };
      // workerId 不匹配时返回 'UNKNOWN'，避免向非持有方泄露任务状态
      if (job.workerId !== workerId) return { cancelled: false, status: 'UNKNOWN' };

      if (job.status === 'CANCELLING') {
        const now = new Date();
        // P1 修复（审查 1.2）：原 renderJob.update 无 WHERE leaseToken 条件，
        //   worker.update 无 WHERE currentJobId 条件。租约过期窗口内原 Worker 的
        //   leaseToken 可能已被 reaper 清空，Worker 调用 checkCancelSignal 时若
        //   workerId 已被改写，worker.update 会误清新任务的 currentJobId。
        //   现改为条件更新：仅 CANCELLING 状态才更新；仅 currentJobId === job.id 才清空。
        const cancelResult = await prisma.$transaction(async (tx) => {
          const result = await tx.renderJob.updateMany({
            where: { id: job.id, status: 'CANCELLING' },
            data: {
              status: 'CANCELLED',
              cancelledAt: now,
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          if (result.count === 1) {
            await tx.worker.updateMany({ where: { id: workerId, currentJobId: job.id }, data: { currentJobId: null } });
            if (job.webhookUrl) {
              await webhookService.enqueueOutbox(tx, {
                jobId: job.id,
                event: 'job.cancelled',
                targetUrl: job.webhookUrl,
                apiKeyId: job.apiKeyId,
                payload: { reason: job.cancelReason ?? 'caller_requested', source: 'worker' },
              });
            }
          }
          return result;
        });
        if (cancelResult.count === 0) {
          // 状态已变（如被 reaper 重排队或 adminForceCancel），无需再处理
          // 重新查询以获取最新状态，避免回传过期的 'CANCELLING'
          const latest = await prisma.renderJob.findUnique({
            where: { id: job.id },
            select: { status: true },
          });
          return { cancelled: false, status: latest?.status ?? 'UNKNOWN' };
        }
        logger.info({ jobId: job.id, msg: 'Worker 检测到取消信号，任务标记 CANCELLED' });

        return { cancelled: true, status: 'CANCELLED' };
      }
      return { cancelled: false, status: job.status };
    } catch (e) {
      // 数据库异常（如 SQLITE_BUSY / 连接错误）时按"未取消"处理，
      // 与 worker 端 BackendClient.checkCancel 的"尽力而为"语义对齐：
      // 检查失败不应阻塞任务执行，避免瞬时数据库错误产生 HTTP 500 噪音。
      logger.warn({ err: e as Error, jobId, workerId, msg: '取消信号检查数据库异常' });
      return { cancelled: false, status: 'UNKNOWN' };
    }
  }

  // ============== 第三期 M4：Admin 写操作 ==============

  /** 任务详情：含心跳历史、产物、traceId 链路 */
  async getDetail(jobCode: string) {
    const job = await prisma.renderJob.findUnique({
      where: { code: jobCode },
      include: {
        templateVersion: { include: { template: true } },
        worker: true,
        artifacts: true,
        heartbeats: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!job) return null;
    return {
      jobId: job.id,
      code: job.code,
      status: job.status,
      priority: job.priority,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      stage: job.stage,
      progress: job.progress,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      traceId: job.traceId,
      idempotencyKey: job.idempotencyKey,
      tenantId: job.tenantId,
      webhookUrl: job.webhookUrl,
      webhookDelivered: job.webhookDelivered,
      requiredCapabilities: job.requiredCapabilities ? JSON.parse(job.requiredCapabilities) : null,
      cancelReason: job.cancelReason,
      template: {
        templateId: job.templateVersion.template.id,
        name: job.templateVersion.template.name,
        versionId: job.templateVersion.id,
        version: job.templateVersion.version,
        published: job.templateVersion.published,
      },
      worker: job.worker
        ? {
            workerId: job.worker.id,
            code: job.worker.code,
            psVersion: job.worker.psVersion,
          }
        : null,
      input: JSON.parse(job.inputJson),
      outputFormat: job.outputFormat,
      artifacts: job.artifacts.map((a) => ({
        artifactId: a.id,
        code: a.code,
        kind: a.kind,
        objectKey: a.objectKey,
        sha256: a.sha256,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        bindingId: a.bindingId,
        originalName: a.originalName,
        expiresAt: a.expiresAt,
        createdAt: a.createdAt,
      })),
      heartbeats: job.heartbeats.map((h) => ({
        id: h.id,
        stage: h.stage,
        progress: h.progress,
        message: h.message,
        createdAt: h.createdAt,
      })),
      timestamps: {
        queuedAt: job.queuedAt,
        leasedAt: job.leasedAt,
        processingAt: job.processingAt,
        succeededAt: job.succeededAt,
        failedAt: job.failedAt,
        cancelRequestedAt: job.cancelRequestedAt,
        cancelledAt: job.cancelledAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    };
  }

  /**
   * 管理员强制取消任务（无视租约/状态，直接置为 CANCELLED）
   * - 用于卡死的任务（worker 失联且租约未过期）
   * - 释放关联 Worker
   *
   * P1-E 修复：原 update({where:{id}}) 无 WHERE status 保护，findUnique 与 update
   *   之间存在 TOCTOU 窗口，任务可能在此期间被 Worker complete/fail 或被 reaper 重排队。
   *   导致：可把 SUCCEEDED 覆盖为 CANCELLED（产物已上传但状态错乱）。
   *   现统一改为 updateMany + WHERE status IN (非终态)，count===0 时返回 updated:false
   *   并附最新状态，与 cancel 方法保持一致。
   */
  async adminForceCancel(jobCode: string, operator: string) {
    const job = await prisma.renderJob.findUnique({
      where: { code: jobCode },
      include: { worker: true },
    });
    if (!job) throw Errors.notFound('任务不存在');
    // 已是终态：直接返回
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      return { jobId: job.id, status: job.status, updated: false };
    }
    const now = new Date();
    // P1-E：updateMany + WHERE status IN (非终态) 防止 TOCTOU 覆盖终态
    const cancelResult = await prisma.renderJob.updateMany({
      where: {
        id: job.id,
        status: { in: ['QUEUED', 'LEASED', 'PROCESSING', 'CANCELLING'] },
      },
      data: {
        status: 'CANCELLED',
        cancelRequestedAt: now,
        cancelReason: `admin_force_cancel by ${operator}`,
        cancelledAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        workerId: null,
      },
    });
    if (cancelResult.count === 0) {
      // 并发竞态：状态已被 Worker/reaper 改变，返回最新状态
      const fresh = await prisma.renderJob.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      return { jobId: job.id, status: fresh?.status ?? job.status, updated: false };
    }
    // 释放原关联 Worker（仅在任务实际被取消时）
    if (job.workerId) {
      await prisma.worker.updateMany({
        where: { id: job.workerId, currentJobId: job.id },
        data: { currentJobId: null },
      });
    }
    logger.info({
      jobId: job.id,
      code: job.code,
      operator,
      msg: '任务被管理员强制取消',
    });
    return { jobId: job.id, status: 'CANCELLED', updated: true };
  }

  /**
   * 强制释放租约（不取消任务，让任务回到 QUEUED 等待其他 Worker claim）
   * - 用于 Worker 假死但任务仍有价值时
   * - attempt 不增加（与租约回收器一致）
   *
   * P1-E 修复：原 update 无 WHERE status 保护，可把已 SUCCEEDED 的任务重置为 QUEUED，
   *   导致重复渲染。现用 updateMany + WHERE status IN (LEASED/PROCESSING) 防覆盖终态。
   */
  async adminReleaseLease(jobCode: string, operator: string) {
    const job = await prisma.renderJob.findUnique({
      where: { code: jobCode },
      include: { worker: true },
    });
    if (!job) throw Errors.notFound('任务不存在');
    if (job.status !== 'LEASED' && job.status !== 'PROCESSING') {
      throw Errors.jobAlreadyTerminated(
        `任务状态 ${job.status}，无法释放租约`,
      );
    }
    const releaseResult = await prisma.renderJob.updateMany({
      where: {
        id: job.id,
        status: { in: ['LEASED', 'PROCESSING'] },
      },
      data: {
        status: 'QUEUED',
        leaseToken: null,
        leaseExpiresAt: null,
        leasedAt: null,
        processingAt: null,
        stage: null,
        progress: 0,
        workerId: null,
      },
    });
    if (releaseResult.count === 0) {
      const fresh = await prisma.renderJob.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      throw Errors.jobAlreadyTerminated(
        `任务状态已变为 ${fresh?.status ?? job.status}，无法释放租约`,
      );
    }
    if (job.workerId) {
      await prisma.worker.updateMany({
        where: { id: job.workerId, currentJobId: job.id },
        data: { currentJobId: null },
      });
    }
    logger.info({
      jobId: job.id,
      code: job.code,
      operator,
      msg: '任务租约被管理员强制释放',
    });
    return { jobId: job.id, status: 'QUEUED', updated: true };
  }

  /**
   * 重试 FAILED 任务（创建一个新的 attempt）
   * - 复用同一 idempotencyKey 不行（会冲突），改为修改原任务状态
   * - attempt +1，若 attempt > maxAttempts 则拒绝
   *
   * P1-E 修复：原 update 无 WHERE status 保护，可把已 SUCCEEDED 的任务重置为 QUEUED
   *   并清空产物引用。现用 updateMany + WHERE status = FAILED 防覆盖终态。
   */
  async adminRetry(jobCode: string, operator: string) {
    const job = await prisma.renderJob.findUnique({
      where: { code: jobCode },
    });
    if (!job) throw Errors.notFound('任务不存在');
    if (job.status !== 'FAILED') {
      throw Errors.jobAlreadyTerminated(
        `任务状态 ${job.status}，仅 FAILED 可重试`,
      );
    }
    if (job.attempt >= job.maxAttempts) {
      throw Errors.validationError(
        `已达最大重试次数 ${job.maxAttempts}，无法继续重试`,
      );
    }
    const retryResult = await prisma.renderJob.updateMany({
      where: { id: job.id, status: 'FAILED' },
      data: {
        status: 'QUEUED',
        attempt: job.attempt + 1,
        errorCode: null,
        errorMessage: null,
        stage: null,
        progress: 0,
        workerId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        leasedAt: null,
        processingAt: null,
        queuedAt: new Date(),
      },
    });
    if (retryResult.count === 0) {
      const fresh = await prisma.renderJob.findUnique({
        where: { id: job.id },
        select: { status: true },
      });
      throw Errors.jobAlreadyTerminated(
        `任务状态已变为 ${fresh?.status ?? job.status}，无法重试`,
      );
    }
    logger.info({
      jobId: job.id,
      code: job.code,
      operator,
      attempt: job.attempt + 1,
      msg: 'FAILED 任务被管理员手动重试',
    });
    return {
      jobId: job.id,
      status: 'QUEUED',
      attempt: job.attempt + 1,
      updated: true,
    };
  }

  /**
   * 批量取消任务（按状态过滤）
   * - 仅取消 QUEUED / LEASED / PROCESSING / CANCELLING 状态
   * - 不影响已终态任务
   */
  async adminBatchCancel(filter: { status?: string }, operator: string) {
    const where: any = {};
    if (filter.status) {
      where.status = filter.status;
    } else {
      where.status = { in: ['QUEUED', 'LEASED', 'PROCESSING', 'CANCELLING'] };
    }
    const jobs = await prisma.renderJob.findMany({
      where,
      select: { id: true, workerId: true, status: true },
    });
    if (jobs.length === 0) {
      return { cancelled: 0 };
    }
    const now = new Date();
    // P1-7 修复：updateMany 的 WHERE 必须带状态过滤，防止 findMany 与 updateMany
    // 之间任务自然完成（SUCCEEDED）或失败（FAILED）时被错误覆盖为 CANCELLED
    const cancellableStatuses = ['QUEUED', 'LEASED', 'PROCESSING', 'CANCELLING'];
    const updateResult = await prisma.renderJob.updateMany({
      where: {
        id: { in: jobs.map((j) => j.id) },
        status: { in: cancellableStatuses },
      },
      data: {
        status: 'CANCELLED',
        cancelRequestedAt: now,
        cancelReason: `admin_batch_cancel by ${operator}`,
        cancelledAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
        workerId: null,
      },
    });

    // P0 安全修复（严重 S6）：仅释放"实际被 updateMany 命中"的任务的 Worker，
    //   避免对 findMany 查出但 updateMany 未命中（如任务已自然完成）的 Worker
    //   执行 worker.update({ currentJobId: null }) 而打断它正在执行的新任务。
    //   策略：在事务外再次查询被成功取消（CANCELLED + cancelReason 标记）的任务，
    //   仅对这些任务原关联的 Worker 释放 currentJobId。
    const affectedJobs = await prisma.renderJob.findMany({
      where: {
        id: { in: jobs.map((j) => j.id) },
        status: 'CANCELLED',
        cancelReason: `admin_batch_cancel by ${operator}`,
        cancelledAt: now,
      },
      select: { workerId: true },
    });
    const workerIdsToRelease = [...new Set(
      affectedJobs.map((j) => j.workerId).filter(Boolean),
    )] as string[];

    if (workerIdsToRelease.length > 0) {
      await prisma.$transaction(
        workerIdsToRelease.map((wid) =>
          prisma.worker.update({
            where: { id: wid },
            data: { currentJobId: null },
          }),
        ),
      );
    }

    logger.info({
      count: updateResult.count,
      requested: jobs.length,
      operator,
      msg: '批量取消任务',
    });
    return { cancelled: updateResult.count };
  }
}

export const renderJobService = new RenderJobService();
