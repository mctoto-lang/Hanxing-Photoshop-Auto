/**
 * PSD 解析服务（基于 psd npm 包，纯 JS 解析，无需 Photoshop）
 *
 * 输出：图层树，每个节点包含 layerId（PS 内部稳定 ID）+ layerPath（降级路径）。
 *
 * 注意（P0 待验证项，见规范第十三节）：
 *   psd npm 包解析的 layerId 与 PS 运行时 layer.id 是否一致尚未验证。
 *   第一期 POC 用管理脚本对比；若不一致需改为路径+类型双重校验。
 *
 * 第三期 M8：新增 generateThumbnail() —— 利用 psd.js 的 image preview 能力
 * 导出 PSD 内嵌预览图，并用 sharp 缩放为缩略图（最大宽 320，保持纵横比）。
 *
 * 智能对象检测修复：psd npm 包 v3.4.0 的 LAYER_INFO 映射未注册 placedLayer 解析器，
 * 导致 plLd/SoLd 图层信息块被跳过，智能对象被误判为 pixel。
 * 通过 monkey-patch Layer.prototype.parseLayerInfo 注册自定义 PlacedLayerInfo 解析器修复。
 *
 * L4 警告：本文件通过 monkey-patch psd 包内部 coffee 文件路径
 *   （psd/lib/psd/layer.coffee、psd/lib/psd/layer/info.coffee）实现智能对象解析。
 *   psd 包升级（3.2+ 或重构版本）会破坏 patch，升级前必须验证：
 *   1) LAYER_INFO 仍存在于 lib/psd/layer/info.coffee
 *   2) Layer.prototype.parseLayerInfo 仍是 patch 的挂载点
 *   3) 跑通 scripts/check-psd-layers.ts 验证智能对象检测正常
 *   package.json 中 psd 版本已锁 "^3.1.0"，请勿放松。
 *
 * B-H5 修复：将 psd.parse() 同步 CPU 密集型操作移至 worker_threads，
 *   避免阻塞 Node 主线程事件循环导致 HTTP 服务对所有请求无响应。
 *   worker 入口见 ./psd-worker.ts，主线程仅负责 IPC 通信。
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
import type { LayerNode, LayerTreeResult } from '../../types/index.js';

// worker 脚本路径（编译后 dist/services/psd-parser/psd-worker.js）
const WORKER_PATH = fileURLToPath(new URL('./psd-worker.js', import.meta.url));

export interface ParseOptions {
  templateId: string;
  templateVersionId: string;
  /** PSD 文件本地路径 */
  filePath: string;
}

interface WorkerResponse {
  ok: boolean;
  result?: LayerTreeResult;
  thumbnail?: Buffer | null;
  error?: string;
  name?: string;
}

/**
 * 在 worker_threads 中执行 PSD 解析请求。
 *   单次请求创建独立 worker，结束后 terminate。10-20 并发下 worker 创建开销可接受。
 *   超时保护：60 秒强制终止，避免恶意 PSD 导致 worker 永久挂起。
 */
function runInWorker(req: {
  type: 'parse' | 'thumbnail';
  filePath: string;
  templateId?: string;
  templateVersionId?: string;
  maxWidth?: number;
}): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_PATH);
    const timeoutMs = 60_000;
    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      resolve({ ok: false, error: `PSD 解析超时（${timeoutMs}ms）`, name: 'PsdTimeoutError' });
    }, timeoutMs);

    worker.once('message', (msg: WorkerResponse) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve(msg);
    });

    worker.once('error', (err) => {
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      resolve({ ok: false, error: err.message, name: err.name });
    });

    worker.postMessage(req);
  });
}

export class PsdParserService {
  /**
   * 第三期 M8：生成 PSD 缩略图
   *
   * 利用 psd.js 的 image preview 能力（PSD 文件末尾的内嵌预览图），
   * 导出原始尺寸 PNG → 用 sharp 缩放为缩略图。
   *
   * B-H5：在 worker_threads 中执行，避免阻塞主线程。
   *
   * @returns PNG 缩略图 Buffer（最大宽 320，保持纵横比）；若 PSD 无内嵌预览返回 null
   */
  async generateThumbnail(opts: { filePath: string; maxWidth?: number }): Promise<Buffer | null> {
    logger.info({ msg: '开始生成 PSD 缩略图（worker）', file: path.basename(opts.filePath) });

    const resp = await runInWorker({
      type: 'thumbnail',
      filePath: opts.filePath,
      maxWidth: opts.maxWidth ?? 640,
    });

    if (!resp.ok) {
      logger.warn({
        msg: 'PSD 缩略图生成失败',
        file: path.basename(opts.filePath),
        error: resp.error,
      });
      // 缩略图失败不阻断主流程，返回 null
      return null;
    }

    if (resp.thumbnail) {
      // Worker 通过 postMessage 结构化克隆传输数据，Buffer 子类信息会丢失，
      // 主线程接收到的是 Uint8Array 而非 Buffer。下游 storage.putObject 在
      // Buffer.isBuffer 校验失败时会走流式分支，按字节迭代 Uint8Array 会导致
      // Buffer.from(number) 抛错（如 "Received type number (137)"，0x89 为 PNG 首字节）。
      // 这里统一转换为真正的 Buffer 再返回。
      const buf = Buffer.isBuffer(resp.thumbnail)
        ? resp.thumbnail
        : Buffer.from(resp.thumbnail as Uint8Array);
      logger.info({
        msg: 'PSD 缩略图已生成',
        thumbnailSize: buf.length,
      });
      return buf;
    } else {
      logger.warn({ msg: 'PSD 无内嵌预览图，跳过缩略图生成', file: path.basename(opts.filePath) });
      return null;
    }
  }

  /**
   * 解析 PSD 并提取图层树
   *
   * B-H5：在 worker_threads 中执行 psd.parse()，避免阻塞主线程事件循环。
   */
  async parse(opts: ParseOptions): Promise<LayerTreeResult> {
    logger.info({ msg: '开始解析 PSD（worker）', file: path.basename(opts.filePath) });

    const resp = await runInWorker({
      type: 'parse',
      filePath: opts.filePath,
      templateId: opts.templateId,
      templateVersionId: opts.templateVersionId,
    });

    if (!resp.ok || !resp.result) {
      const err = resp.error ?? 'PSD 解析失败（未知错误）';
      // 保留原错误类型语义：文件过大 / 图层超限
      const e = new Error(err);
      e.name = resp.name ?? 'PsdParseError';
      throw e;
    }

    logger.info({
      msg: 'PSD 解析完成',
      canvas: resp.result.canvas,
      layerCount: resp.result.layerTree.length,
    });

    return resp.result;
  }

  /**
   * 扁平化图层树（便于前端列表展示与绑定校验）
   */
  flatten(tree: LayerNode[]): LayerNode[] {
    const result: LayerNode[] = [];
    const walk = (nodes: LayerNode[]) => {
      for (const n of nodes) {
        result.push(n);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree);
    return result;
  }
}

export const psdParser = new PsdParserService();
