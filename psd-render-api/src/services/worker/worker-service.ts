/**
 * Worker 服务：节点注册、令牌管理、能力路由
 */
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import {
  genWorkerCode,
  genWorkerToken,
  genMachineFingerprint,
  sha256,
} from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { storageConfigService } from '../storage/storage-config-service.js';

/**
 * 从 storageConfig 中提取需要加入 SSRF 白名单的主机名列表。
 *
 * COS 模式下，manifest 中的下载/上传 URL 指向 COS 桶域名
 * （如 photoshop-auto-xxx.cos.ap-guangzhou.myqcloud.com），需要加入
 * Worker 端 UrlGuard 白名单才能访问。
 *
 * Worker 注册时后端下发当前允许的主机名，Worker 自动更新白名单，
 * 避免 COS 域名变更后需要手动改 config.json。
 * - local 模式：返回空数组（下载/上传走后端自身，不需要额外主机）
 * - cos 模式：解析 cosInternalDomain 提取主机名
 */
async function getAllowedDownloadHosts(): Promise<string[]> {
  try {
    const runtime = await storageConfigService.getRuntime();
    if (runtime.backend !== 'cos') return [];
    const domain = runtime.config.internalDomain;
    if (!domain) return [];
    // cosInternalDomain 可能是完整 URL（https://xxx.myqcloud.com）或纯主机名
    const host = domain.startsWith('http')
      ? new URL(domain).hostname
      : domain.split('/')[0];
    return host ? [host.toLowerCase()] : [];
  } catch (e) {
    logger.warn({
      msg: '获取 allowedDownloadHosts 失败，回落为空数组',
      err: (e as Error).message,
    });
    return [];
  }
}

export interface RegisterParams {
  machineFingerprint: string;
  psVersion: string;          // "25.0"
  psMajorVersion: number;     // 25
  os: 'windows';
  supportsSmartObject: boolean;
  supportsTextLayer: boolean;
  fonts: string[];            // postscriptName 列表
  // 第四期 M9：可选硬件画像（旧 Worker 不传则保留 null）
  hostname?: string;
  cpuModel?: string;
  cpuCores?: number;
  cpuLogicalCores?: number;
  cpuClockMhz?: number;
  gpuModel?: string;
  gpuVramMb?: number;
  totalMemoryMb?: number;
  availableMemoryMb?: number;
  osVersion?: string;
  diskTotalMb?: number;
  diskFreeMb?: number;
  hardwareInfo?: string;
}

/**
 * 第四期 M9：安全解析 JSON（容错）。Worker 端可能上报格式异常的 hardwareInfo。
 */
function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

class WorkerService {
  /**
   * 注册 Worker 节点
   * - 路由层已校验 WORKER_REGISTER_SECRET（生产强制非空）
   * - 颁发短期访问令牌，DB 仅存其 SHA-256 hash（P0 安全修复）
   * - 已存在指纹则更新，否则创建
   *
   * B-H4 修复：原 findUnique + update/create 模式存在竞态——两个相同指纹的并发注册请求
   *   都会在 findUnique 时拿到 null，随后都走 create 分支，第二个 create 触发 P2002
   *   唯一约束冲突未捕获导致 500。现改用 upsert（数据库原子操作）并在 create 分支
   *   额外捕获 P2002 二次兜底，确保并发场景下不会抛错。
   */
  async register(params: RegisterParams, opts?: { registeredIp?: string | null }) {
    const fingerprint = genMachineFingerprint(params.machineFingerprint);

    const token = genWorkerToken();
    const tokenHash = sha256(token);
    const tokenExpiresAt = new Date(Date.now() + 3600 * 1000); // 1 小时
    const now = new Date();

    const capabilities = JSON.stringify({
      psVersion: params.psVersion,
      psMajorVersion: params.psMajorVersion,
      os: params.os,
      supportsSmartObject: params.supportsSmartObject,
      supportsTextLayer: params.supportsTextLayer,
    });

    // 字体清单哈希
    const { createHash } = await import('node:crypto');
    const fontInventoryHash = createHash('sha256')
      .update(params.fonts.slice().sort().join(','))
      .digest('hex');

    // 注册 IP：每次注册都刷新（反映当前连接来源 IP）
    const registeredIp = opts?.registeredIp ?? null;

    // 查询现有记录：用于判断硬件画像字段是否已有值
    // 策略：硬件画像"获取到信息的不刷新覆盖，保持显示旧的信息"
    //   - 已有值的字段不在 update 中覆盖（防止 Worker 重启后采集失败导致信息丢失）
    //   - 为 null 的字段允许写入新值（首次采集或补充缺失字段）
    const existing = await prisma.worker.findUnique({
      where: { machineFingerprint: fingerprint },
      select: {
        hostname: true, cpuModel: true, cpuCores: true, cpuLogicalCores: true,
        cpuClockMhz: true, gpuModel: true, gpuVramMb: true, totalMemoryMb: true,
        availableMemoryMb: true, osVersion: true, diskTotalMb: true, diskFreeMb: true,
        hardwareInfo: true,
      },
    });

    // 硬件画像字段：仅在 DB 当前值为 null 时写入（不覆盖已有值）
    const hwFields = {
      hostname: params.hostname,
      cpuModel: params.cpuModel,
      cpuCores: params.cpuCores,
      cpuLogicalCores: params.cpuLogicalCores,
      cpuClockMhz: params.cpuClockMhz,
      gpuModel: params.gpuModel,
      gpuVramMb: params.gpuVramMb,
      totalMemoryMb: params.totalMemoryMb,
      availableMemoryMb: params.availableMemoryMb,
      osVersion: params.osVersion,
      diskTotalMb: params.diskTotalMb,
      diskFreeMb: params.diskFreeMb,
      hardwareInfo: params.hardwareInfo,
    } as const;
    const hwUpdate: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(hwFields)) {
      if (val === undefined) continue;          // Worker 未上报，跳过
      if (existing && existing[key as keyof typeof existing] !== null) continue; // DB 已有值，不覆盖
      hwUpdate[key] = val;
    }

    // upsert 公共 data（更新分支）
    const updateData = {
      psVersion: params.psVersion,
      psMajorVersion: params.psMajorVersion,
      os: params.os,
      capabilities,
      // P0：仅存 hash，明文 token 仅本次返回给 Worker
      accessToken: null,
      accessTokenHash: tokenHash,
      tokenExpiresAt,
      fontInventoryHash,
      sessionActive: true,
      offlineSince: null,
      registeredAt: now,
      lastHeartbeatAt: now,
      // 注册 IP：每次注册都刷新
      ...(registeredIp ? { registeredIp } : {}),
      // 硬件画像：仅填充 null 字段，不覆盖已有值
      ...hwUpdate,
    };

    // create 分支专用 data
    const createData = {
      ...updateData,
      // 首次创建时，所有上报的硬件字段都写入（existing 为 null，hwUpdate 已含全部非 undefined 字段）
      ...(registeredIp !== null ? { registeredIp } : {}),
    };

    let worker;
    let isNew = false;
    try {
      // upsert 是原子操作，避免 findUnique + create 之间的竞态窗口
      worker = await prisma.worker.upsert({
        where: { machineFingerprint: fingerprint },
        update: updateData,
        create: {
          code: genWorkerCode(),
          machineFingerprint: fingerprint,
          ...createData,
        },
      });
      // upsert 无法直接区分是 create 还是 update，需查一次以判定日志语义
      const existing = await prisma.worker.findUnique({
        where: { machineFingerprint: fingerprint },
        select: { registeredAt: true },
      });
      isNew = existing?.registeredAt?.getTime() === now.getTime();
    } catch (e: any) {
      // P2002 兜底：极少数情况下 upsert 仍可能因 code 碰撞或并发触发表级约束冲突
      if (e?.code === 'P2002') {
        logger.warn({ fingerprint, msg: 'Worker 注册触发 P2002，回退为 update' });
        worker = await prisma.worker.update({
          where: { machineFingerprint: fingerprint },
          data: updateData,
        });
      } else {
        throw e;
      }
    }

    logger.info({
      workerId: worker.id,
      code: worker.code,
      msg: isNew ? '新 Worker 注册' : 'Worker 重新注册',
    });

    // 下发当前存储配置允许下载/上传的主机名，Worker 据此自动更新 SSRF 白名单。
    // COS 域名变更后无需手动改 config.json，重新注册即生效。
    const allowedDownloadHosts = await getAllowedDownloadHosts();

    return {
      workerId: worker.id,
      workerCode: worker.code,
      // 管理后台设置的自定义编号：Worker UI 优先展示此字段，回退到 workerCode
      customCode: worker.customCode,
      displayName: worker.displayName,
      accessToken: token,
      tokenExpiresAt: tokenExpiresAt.toISOString(),
      allowedDownloadHosts,
    };
  }

  /**
   * 心跳：仅刷新 lastHeartbeatAt，不主动修改 sessionActive
   *
   * P1-J 修复：原实现无条件 `sessionActive: true`，存在两类风险：
   *   1) 竞态：authenticateWorker 校验 sessionActive=true 与 forceOffline 写入
   *      sessionActive=false 之间存在 TOCTOU 窗口，期间进入的 heartbeat 会把
   *      已被管理员下线的 Worker 重新激活，绕过 forceOffline 管控。
   *   2) 语义错误：sessionActive 应由 register/forceOffline/reapprove 显式管理，
   *      心跳仅做保活，不应改变会话状态。
   * 现使用条件更新（updateMany WHERE sessionActive=true），仅在线状态下刷新时间戳；
   * 若 Worker 已被下线，count=0，调用方据此返回 401 促使 Worker 重新注册。
   */
  async heartbeat(workerId: string): Promise<{ active: boolean }> {
    const result = await prisma.worker.updateMany({
      where: { id: workerId, sessionActive: true },
      data: { lastHeartbeatAt: new Date() },
    });
    return { active: result.count > 0 };
  }

  async getById(workerId: string) {
    return prisma.worker.findUnique({ where: { id: workerId } });
  }

  /**
   * 刷新 Worker 令牌（过期前调用）
   * - 旧 hash 失效，颁发新 token + 新 hash
   */
  async refreshToken(workerId: string) {
    const token = genWorkerToken();
    const tokenHash = sha256(token);
    const tokenExpiresAt = new Date(Date.now() + 3600 * 1000);
    await prisma.worker.update({
      where: { id: workerId },
      data: { accessToken: null, accessTokenHash: tokenHash, tokenExpiresAt },
    });
    return { accessToken: token, tokenExpiresAt: tokenExpiresAt.toISOString() };
  }

  async list() {
    const workers = await prisma.worker.findMany({
      orderBy: { registeredAt: 'desc' },
    });
    return workers.map((w) => ({
      workerId: w.id,
      code: w.code,
      customCode: w.customCode,
      displayName: w.displayName,
      psVersion: w.psVersion,
      capabilities: JSON.parse(w.capabilities),
      sessionActive: w.sessionActive,
      currentJobId: w.currentJobId,
      lastHeartbeatAt: w.lastHeartbeatAt,
      registeredAt: w.registeredAt,
    }));
  }

  // ============== 第三期 M4：Admin 写操作 ==============

  /** Worker 详情：含能力、字体清单、当前任务、硬件画像、历史任务列表 */
  async getDetail(workerId: string) {
    const worker = await prisma.worker.findUnique({
      where: { id: workerId },
    });
    if (!worker) return null;

    // 第四期 M9：统计 Worker 历史任务数（用于详情页"累计执行"指标）
    const jobStats = await prisma.renderJob.groupBy({
      by: ['status'],
      where: { workerId },
      _count: { _all: true },
    });
    const totalJobs = jobStats.reduce((sum, s) => sum + s._count._all, 0);
    const succeededJobs = jobStats.find((s) => s.status === 'SUCCEEDED')?._count._all ?? 0;
    const failedJobs = jobStats.find((s) => s.status === 'FAILED')?._count._all ?? 0;

    // 历史任务列表：取最近 200 条（按创建时间倒序），用于详情页滚动展示
    //   注：UI 表格容器限高约 10 条，超出通过滚动查看；200 条覆盖常见场景，
    //   避免一次性返回全量任务（数万级）造成响应体过大。
    const recentJobs = await prisma.renderJob.findMany({
      where: { workerId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        code: true,
        status: true,
        stage: true,
        progress: true,
        attempt: true,
        errorCode: true,
        createdAt: true,
        succeededAt: true,
        failedAt: true,
      },
    });

    // 心跳超时判定（与列表路由一致），详情页据此显示真实在线/离线状态
    const now = Date.now();
    const heartbeatTimeoutSec = env.ALERT_WORKER_OFFLINE_SECONDS;
    const heartbeatAgeSec = worker.lastHeartbeatAt ? Math.floor((now - worker.lastHeartbeatAt.getTime()) / 1000) : null;
    const status = !worker.sessionActive
      ? 'OFFLINE'
      : heartbeatAgeSec === null
        ? 'CONNECTING'
        : heartbeatAgeSec >= heartbeatTimeoutSec
          ? 'HEARTBEAT_TIMEOUT'
          : 'IDLE';

    return {
      workerId: worker.id,
      code: worker.code,
      customCode: worker.customCode,
      displayName: worker.displayName,
      psVersion: worker.psVersion,
      psMajorVersion: worker.psMajorVersion,
      os: worker.os,
      capabilities: JSON.parse(worker.capabilities),
      fontInventoryHash: worker.fontInventoryHash,
      sessionActive: worker.sessionActive,
      currentJobId: worker.currentJobId,
      lastHeartbeatAt: worker.lastHeartbeatAt,
      offlineSince: worker.offlineSince,
      registeredAt: worker.registeredAt,
      registeredIp: worker.registeredIp,
      machineFingerprint: worker.machineFingerprint,
      // P0：仅显示是否已颁发令牌，不暴露明文/hash
      accessTokenPresent: !!worker.accessTokenHash,
      tokenExpiresAt: worker.tokenExpiresAt,
      // 实时状态（供详情页直接使用，不再仅依赖 sessionActive）
      status,
      statusLabel: status === 'IDLE' ? '空闲' : status === 'CONNECTING' ? '等待心跳' : status === 'HEARTBEAT_TIMEOUT' ? '心跳超时' : '已离线',
      heartbeatAgeSec,
      heartbeatTimeoutSec,
      // 第四期 M9：硬件画像
      hardware: {
        hostname: worker.hostname,
        cpuModel: worker.cpuModel,
        cpuCores: worker.cpuCores,
        cpuLogicalCores: worker.cpuLogicalCores,
        cpuClockMhz: worker.cpuClockMhz,
        gpuModel: worker.gpuModel,
        gpuVramMb: worker.gpuVramMb,
        totalMemoryMb: worker.totalMemoryMb,
        availableMemoryMb: worker.availableMemoryMb,
        osVersion: worker.osVersion,
        diskTotalMb: worker.diskTotalMb,
        diskFreeMb: worker.diskFreeMb,
        // 原始硬件信息 JSON（Worker 端可放任意扩展字段）
        hardwareInfo: worker.hardwareInfo ? safeJsonParse(worker.hardwareInfo, null) : null,
      },
      // 任务统计
      jobStats: {
        total: totalJobs,
        succeeded: succeededJobs,
        failed: failedJobs,
      },
      // 历史任务列表（最近 200 条，UI 限高滚动展示）
      recentJobs: recentJobs.map((j) => ({
        jobId: j.code,
        status: j.status,
        stage: j.stage,
        progress: j.progress,
        attempt: j.attempt,
        errorCode: j.errorCode,
        createdAt: j.createdAt,
        succeededAt: j.succeededAt,
        failedAt: j.failedAt,
      })),
    };
  }

  /**
   * 第四期 M9：删除 Worker 节点
   *
   * 使用场景：Worker 设备报废/下线/不再使用，需要从列表清理。
   *
   * 安全策略：
   * 1. 拒绝删除在线（sessionActive=true）的 Worker —— 需先 forceOffline
   * 2. 拒绝删除有进行中任务的 Worker —— 需等任务结束或强制取消
   * 3. 历史任务通过 workerId 引用 Worker，删除后这些任务的 worker 字段变 null
   *    （Prisma schema 中 relation 是可选的，onDelete=SET NULL）
   * 4. 审计日志单独记录，由调用方（admin-write-routes）写入
   *
   * @returns { workerId, code, deleted: true }
   */
  async delete(workerId: string, operator: string) {
    const worker = await prisma.worker.findUnique({
      where: { id: workerId },
      include: {
        _count: {
          select: {
            jobs: {
              where: { status: { in: ['QUEUED', 'LEASED', 'PROCESSING', 'CANCELLING'] } },
            },
          },
        },
      },
    });
    if (!worker) throw Errors.workerNotFound('Worker 不存在');

    // 防护 1：在线 Worker 必须先下线
    if (worker.sessionActive) {
      throw Errors.validationError('Worker 处于在线状态，请先强制下线再删除');
    }
    // 防护 2：有进行中任务的 Worker 不能删除（避免任务丢失）
    if (worker._count.jobs > 0) {
      throw Errors.validationError(`Worker 有 ${worker._count.jobs} 个进行中的任务，请等待任务完成或强制取消后再删除`);
    }

    // 执行删除（历史任务的 workerId 会被 Prisma 的 SET NULL 行为置空）
    await prisma.worker.delete({ where: { id: workerId } });

    logger.info({
      workerId,
      code: worker.code,
      operator,
      msg: 'Worker 节点已删除',
    });
    return { workerId, code: worker.code, deleted: true as const };
  }

  /**
   * 强制下线 Worker（管理员操作）
   * - 标记 sessionActive=false，offlineSince=now
   * - 撤销 accessToken（Worker 后续请求将失败）
   * - 不影响当前正在执行的任务（任务会被租约回收器处理）
   */
  async forceOffline(workerId: string, operator: string) {
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw Errors.workerNotFound('Worker 不存在');
    await prisma.worker.update({
      where: { id: workerId },
      data: {
        sessionActive: false,
        offlineSince: new Date(),
        // P0：清除 hash 而非明文（accessToken 已不再使用）
        accessToken: null,
        accessTokenHash: null,
        tokenExpiresAt: null,
      },
    });
    logger.info({
      workerId,
      code: worker.code,
      operator,
      msg: 'Worker 被管理员强制下线',
    });
    return { workerId, code: worker.code, sessionActive: false };
  }

  /**
   * 重新批准 Worker（重置 session 状态）
   * - 用于强制下线后允许 Worker 重新注册
   * - 不直接颁发 token（Worker 需重新走 register 流程）
   */
  async reapprove(workerId: string, operator: string) {
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw Errors.workerNotFound('Worker 不存在');
    await prisma.worker.update({
      where: { id: workerId },
      data: {
        offlineSince: null,
      },
    });
    logger.info({
      workerId,
      code: worker.code,
      operator,
      msg: 'Worker 被管理员重新批准',
    });
    return { workerId, code: worker.code };
  }

  async updateDisplayName(workerId: string, displayName: string | null) {
    const worker = await prisma.worker.update({
      where: { id: workerId },
      data: { displayName },
    });
    return { workerId: worker.id, code: worker.code, displayName: worker.displayName };
  }

  /**
   * 更新 Worker 自定义编号（customCode）
   * - 由管理员在控制台手动指定，便于业务识别
   * - 唯一约束：与其它 Worker 的 customCode / code 不可重复
   * - 传 null 清除自定义编号
   */
  async updateCustomCode(workerId: string, customCode: string | null) {
    const worker = await prisma.worker.findUnique({ where: { id: workerId } });
    if (!worker) throw Errors.workerNotFound('Worker 不存在');
    // 唯一性校验：customCode 不能与现有 code 或其它 Worker 的 customCode 重复
    if (customCode) {
      const conflict = await prisma.worker.findFirst({
        where: {
          AND: [
            { id: { not: workerId } },
            { OR: [{ customCode }, { code: customCode }] },
          ],
        },
      });
      if (conflict) {
        throw Errors.validationError(`自定义编号已被占用: ${customCode}`);
      }
    }
    const updated = await prisma.worker.update({
      where: { id: workerId },
      data: { customCode },
    });
    logger.info({
      workerId,
      code: worker.code,
      customCode,
      msg: 'Worker 自定义编号已更新',
    });
    return {
      workerId: updated.id,
      code: updated.code,
      customCode: updated.customCode,
    };
  }
}

export const workerService = new WorkerService();
export { Errors };
