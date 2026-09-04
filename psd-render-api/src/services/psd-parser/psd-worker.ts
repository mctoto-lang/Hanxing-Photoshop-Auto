/**
 * PSD 解析 worker_threads 入口（B-H5 修复）
 *
 * 原 psd-parser.ts 的 parse() 与 generateThumbnail() 在 Node 主线程同步执行
 * psd.parse()，会阻塞事件循环数百毫秒到数秒，期间整个 HTTP 服务对所有其他
 * 请求无响应。现将 CPU 密集型解析移至 worker_threads，主线程仅负责 IPC 通信。
 *
 * worker 接收 { type, filePath, ... } 消息，独立完成：
 *   - 加载 psd 包 + 执行 monkey-patch（智能对象检测）
 *   - 解析图层树 / 生成缩略图
 *   - postMessage 返回结果或错误
 *
 * 由于 worker 独立加载 psd 包，主线程不再需要 patch，避免污染主线程模块缓存。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import sharp from 'sharp';
// 修复缩略图：用 ag-psd 读取 PSD 内嵌 JPEG 缩略图资源 (Resource 1036)
//   原 psd 包读 Image Data Section（合并合成图），但部分 PSD 该区域不完整/过时，
//   导致缩略图仅显示残缺内容（如倾斜长方形 + 大面积透明）。
//   ag-psd + Resource 1036 始终由 Photoshop 正确生成，代表完整画布预览。
import { initializeCanvas, readPsd } from 'ag-psd';
// P2-F：从 env.ts 读取 zod 校验后的环境变量，避免 Number(process.env.X) 在误配为
//   非数字字符串时返回 NaN 导致大小保护失效（size > NaN 恒为 false）。
//   env.ts 在主线程启动时已 fail-fast 校验，worker_threads 共享同一 process.env，
//   此处 import 重新触发 env.ts 模块初始化（幂等，无副作用）。
import { env } from '../../config/env.js';

// worker 内部使用 require 加载 CommonJS psd 包
const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PsdClass = any;

let _psd: PsdClass | null = null;
let _psdPatched = false;

/**
 * Monkey-patch psd npm 包以支持智能对象检测（与主线程原实现一致）
 */
function patchPsdForSmartObjectDetection(): void {
  if (_psdPatched) return;
  _psdPatched = true;

  try {
    const Layer = require('psd/lib/psd/layer.coffee');
    const LayerInfoBase = require('psd/lib/psd/layer_info.coffee');
    const Util = require('psd/lib/psd/util.coffee');
    const LazyExecute = require('psd/lib/psd/lazy_execute.coffee');

    const LAYER_INFO: Record<string, any> = {
      artboard: require('psd/lib/psd/layer_info/artboard.coffee'),
      blendClippingElements: require('psd/lib/psd/layer_info/blend_clipping_elements.coffee'),
      blendInteriorElements: require('psd/lib/psd/layer_info/blend_interior_elements.coffee'),
      fillOpacity: require('psd/lib/psd/layer_info/fill_opacity.coffee'),
      gradientFill: require('psd/lib/psd/layer_info/gradient_fill.coffee'),
      layerId: require('psd/lib/psd/layer_info/layer_id.coffee'),
      layerNameSource: require('psd/lib/psd/layer_info/layer_name_source.coffee'),
      legacyTypetool: require('psd/lib/psd/layer_info/legacy_typetool.coffee'),
      locked: require('psd/lib/psd/layer_info/locked.coffee'),
      metadata: require('psd/lib/psd/layer_info/metadata.coffee'),
      name: require('psd/lib/psd/layer_info/unicode_name.coffee'),
      nestedSectionDivider: require('psd/lib/psd/layer_info/nested_section_divider.coffee'),
      objectEffects: require('psd/lib/psd/layer_info/object_effects.coffee'),
      sectionDivider: require('psd/lib/psd/layer_info/section_divider.coffee'),
      solidColor: require('psd/lib/psd/layer_info/solid_color.coffee'),
      typeTool: require('psd/lib/psd/layer_info/typetool.coffee'),
      vectorMask: require('psd/lib/psd/layer_info/vector_mask.coffee'),
      vectorOrigination: require('psd/lib/psd/layer_info/vector_origination.coffee'),
      vectorStroke: require('psd/lib/psd/layer_info/vector_stroke.coffee'),
      vectorStrokeContent: require('psd/lib/psd/layer_info/vector_stroke_content.coffee'),
    };

    class PlacedLayerInfo extends LayerInfoBase {
      static shouldParse(key: string): boolean {
        return key === 'plLd' || key === 'SoLd' || key === 'plld';
      }
      parse(): void {
        this.data.isPlaced = true;
        this.skip();
      }
    }
    LAYER_INFO.placedLayer = PlacedLayerInfo;

    Layer.prototype.parseLayerInfo = function () {
      while (this.file.tell() < this.layerEnd) {
        this.file.seek(4, true);
        const key = this.file.readString(4);
        const length = Util.pad2(this.file.readInt());
        const pos = this.file.tell();

        let keyParseable = false;
        for (const name in LAYER_INFO) {
          const klass = LAYER_INFO[name];
          if (!klass.shouldParse(key)) continue;

          const i = new klass(this, length);
          this.adjustments[name] = new LazyExecute(i, this.file)
            .now('skip')
            .later('parse')
            .get();

          if (this[name] == null) {
            ((name: string) => {
              this[name] = () => this.adjustments[name];
            })(name);
          }

          this.infoKeys.push(key);
          keyParseable = true;
          break;
        }

        if (!keyParseable) {
          this.file.seek(length, true);
        }
      }
    };
  } catch (err) {
    // patch 失败时智能对象会被误判为 pixel，模板绑定配置会受影响；
    // 不中断解析（其他类型图层不受影响），但必须在服务日志中留下线索
    console.warn('[psd-worker] PSD 智能对象检测 monkey-patch 失败，后续解析会将智能对象误判为 pixel 图层', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function getPsd(): Promise<PsdClass> {
  if (!_psd) {
    const mod = await import('psd');
    _psd = (mod as any).default ?? mod;
  }
  if (!_psdPatched) {
    patchPsdForSmartObjectDetection();
  }
  return _psd;
}

/**
 * ag-psd 在 Node.js 中需要 Canvas 实现才能解码 ImageData。
 * 这里提供最小 shim：只支持 createImageData / putImageData / getImageData，
 * 不做真实渲染——putImageData 缓存像素数据，getImageData 取回，足够读取
 * PSD 内嵌缩略图资源 (Resource 1036) 的像素数据。
 */
let _agPsdInitialized = false;
function initAgPsdCanvas(): void {
  if (_agPsdInitialized) return;
  _agPsdInitialized = true;
  // Node.js 无 DOM，ag-psd 的 initializeCanvas 期望返回 HTMLCanvasElement。
  // 这里提供最小 shim（只实现 createImageData/putImageData/getImageData），
  // 用 any 绕过类型检查——足够读取 PSD 内嵌缩略图的像素数据。
  initializeCanvas(((width: number, height: number) => {
    let stored: { data: Uint8ClampedArray; width: number; height: number } | null = null;
    const ctx = {
      createImageData: (w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
        width: w,
        height: h,
        colorSpace: 'srgb' as const,
      }),
      putImageData: (imgData: { data: Uint8ClampedArray; width: number; height: number }) => {
        stored = imgData;
      },
      getImageData: () => stored,
    };
    return { width, height, getContext: () => ctx };
  }) as any);
}

// ============== 解析逻辑（从 psd-parser.ts 移植） ==============

// P2-F：使用 env.ts zod 校验后的值，避免 Number('abc')=NaN 导致保护失效
const MAX_PSD_SIZE_BYTES = env.MAX_PSD_SIZE_MB * 1024 * 1024;
const MAX_LAYER_DEPTH = env.PSD_MAX_LAYER_DEPTH;
const MAX_LAYER_COUNT = env.PSD_MAX_LAYER_COUNT;

async function assertFileSize(filePath: string): Promise<void> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_PSD_SIZE_BYTES) {
    throw new Error(`PSD 文件过大（${(stat.size / 1024 / 1024).toFixed(2)} MB > 上限 ${MAX_PSD_SIZE_BYTES / 1024 / 1024} MB）`);
  }
}

interface LayerNode {
  layerId: number;
  layerPath: string;
  name: string;
  type: string;
  visible: boolean;
  bounds?: { top: number; left: number; bottom: number; right: number };
  defaultText?: string;
  sourceFontNames?: string[];
  smartObjectSize?: { width: number; height: number };
  children?: LayerNode[];
}

interface LayerTreeResult {
  templateId: string;
  templateVersionId: string;
  canvas: { width: number; height: number };
  layerTree: LayerNode[];
}

function extractChildren(
  children: any[],
  parentPath: string,
  nameCounter: Map<string, number>,
  depth: number,
  counter: { count: number },
): LayerNode[] {
  const nodes: LayerNode[] = [];
  if (!children || !Array.isArray(children)) return nodes;
  if (depth >= MAX_LAYER_DEPTH) {
    throw new Error(`PSD 图层嵌套深度超限（${depth} > ${MAX_LAYER_DEPTH}）`);
  }
  for (const child of children) {
    counter.count += 1;
    if (counter.count > MAX_LAYER_COUNT) {
      throw new Error(`PSD 图层总数超限（${counter.count} > ${MAX_LAYER_COUNT}）`);
    }
    const node = buildNode(child, parentPath, nameCounter, depth, counter);
    if (node) nodes.push(node);
  }
  return nodes;
}

export function buildNode(
  node: any,
  parentPath: string,
  nameCounter: Map<string, number>,
  depth: number,
  counter: { count: number },
): LayerNode | null {
  if (!node) return null;
  const name: string = typeof node.name === 'function' ? node.name() : (node.name ?? '未命名');
  const rawLayer = node.layer ?? node;
  const exported = extractExportedNode(node);

  let layerId = 0;
  try {
    const layerIdProxy = typeof rawLayer?.layerId === 'function' ? rawLayer.layerId() : rawLayer?.layerId;
    if (layerIdProxy) {
      // LazyExecute 只为构造期自有属性（layer/length/data 等）生成 getter，
      // `id` 在 parse() 执行后才写入实例——直接读 proxy.id / proxy.obj.id 恒为
      // undefined（layerId=0 的根因）。先访问被代理属性触发 load()→parse()，
      // 再从底层实例读取；loaded 标志保证重复访问只解析一次。
      void layerIdProxy.length;
      const realId = layerIdProxy.obj?.id ?? layerIdProxy.id;
      if (typeof realId === 'number') layerId = realId;
      else if (typeof realId === 'string') {
        const parsed = parseInt(realId, 10);
        if (!Number.isNaN(parsed)) layerId = parsed;
      }
    }
    if (layerId === 0 && typeof rawLayer?.id === 'number') layerId = rawLayer.id;
  } catch { /* ignore */ }

  const pathSegment = buildPathSegment(name, parentPath, nameCounter);
  const layerPath = parentPath ? `${parentPath}/${pathSegment}` : pathSegment;
  const type = detectType(node, rawLayer, exported);
  const visible = isVisible(node, rawLayer);
  const bounds = extractBounds(node, rawLayer);

  const result: LayerNode = { layerId, layerPath, name, type, visible };
  if (bounds) result.bounds = bounds;

  if (type === 'text') {
    const defaultText = extractText(rawLayer, exported);
    if (defaultText !== undefined) result.defaultText = defaultText;
    const sourceFontNames = extractSourceFontNames(exported);
    if (sourceFontNames.length > 0) result.sourceFontNames = sourceFontNames;
  }

  if (type === 'smartObject') {
    const soSize = extractSmartObjectSize(node, rawLayer);
    if (soSize) result.smartObjectSize = soSize;
  }

  if (type === 'group') {
    const subChildren = typeof node.children === 'function' ? node.children() : (node.children ?? []);
    const kids = extractChildren(subChildren, layerPath, nameCounter, depth + 1, counter);
    if (kids.length > 0) result.children = kids;
  }

  return result;
}

function buildPathSegment(name: string, parentPath: string, nameCounter: Map<string, number>): string {
  const key = `${parentPath}::${name}`;
  const count = nameCounter.get(key) ?? 0;
  nameCounter.set(key, count + 1);
  if (count === 0) return name;
  return `${name}[${count}]`;
}

function detectType(node: any, rawLayer: any, exported: any): string {
  if (typeof node.isText === 'function' && node.isText()) return 'text';
  if (rawLayer?.text !== undefined && rawLayer?.text !== null) return 'text';
  if (exported?.text?.value !== undefined) return 'text';
  if (rawLayer?.placedLayer !== undefined && rawLayer?.placedLayer !== null) return 'smartObject';
  if (rawLayer?.smartObject !== undefined && rawLayer?.smartObject !== null) return 'smartObject';
  if (Array.isArray(rawLayer?.infoKeys)) {
    const keys = rawLayer.infoKeys as string[];
    if (keys.includes('plLd') || keys.includes('SoLd') || keys.includes('plld')) return 'smartObject';
  }
  if (typeof node.isGroup === 'function' && node.isGroup()) return 'group';
  if (rawLayer?.layerType === 'layerSection') return 'group';
  if (rawLayer?.layerType === 'adjustmentLayer') return 'adjustment';
  return 'pixel';
}

function isVisible(node: any, rawLayer: any): boolean {
  if (typeof node.visible === 'function') return node.visible();
  if (typeof rawLayer?.visible === 'boolean') return rawLayer.visible;
  if (typeof rawLayer?.flags === 'object' && rawLayer?.flags !== null) {
    return (rawLayer.flags.hidden ?? 0) === 0;
  }
  return true;
}

function extractBounds(node: any, rawLayer: any): { top: number; left: number; bottom: number; right: number } | undefined {
  const coords = node.coords ?? rawLayer?.coords;
  if (coords && typeof coords === 'object') {
    const top = Number(coords.top ?? 0);
    const left = Number(coords.left ?? 0);
    const bottom = Number(coords.bottom ?? 0);
    const right = Number(coords.right ?? 0);
    if ([top, left, bottom, right].every((n) => !Number.isNaN(n))) {
      return { top, left, bottom, right };
    }
  }
  return undefined;
}

function extractExportedNode(node: any): any {
  try {
    if (typeof node.export === 'function') return node.export({ text: true });
  } catch { /* ignore */ }
  return undefined;
}

function extractText(rawLayer: any, exported: any): string | undefined {
  if (typeof rawLayer?.text?.value === 'string') return rawLayer.text.value;
  if (typeof exported?.value === 'string') return exported.value;
  if (typeof exported?.text?.value === 'string') return exported.text.value;
  return undefined;
}

function extractSourceFontNames(exported: any): string[] {
  const names = exported?.text?.font?.names;
  if (!Array.isArray(names)) return [];
  return [...new Set(names.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean))];
}

function extractSmartObjectSize(node: any, rawLayer: any): { width: number; height: number } | undefined {
  try {
    const placedLayerVal = typeof rawLayer?.placedLayer === 'function' ? rawLayer.placedLayer() : rawLayer?.placedLayer;
    const smartObjectVal = typeof rawLayer?.smartObject === 'function' ? rawLayer.smartObject() : rawLayer?.smartObject;
    const nodePlacedVal = typeof node?.placedLayer === 'function' ? node.placedLayer() : node?.placedLayer;
    const nodeSmartVal = typeof node?.smartObject === 'function' ? node.smartObject() : node?.smartObject;
    const candidates = [placedLayerVal, smartObjectVal, nodePlacedVal, nodeSmartVal].filter((c) => c && typeof c === 'object');
    for (const c of candidates) {
      const w1 = Number(c.width);
      const h1 = Number(c.height);
      if (w1 > 0 && h1 > 0 && !Number.isNaN(w1) && !Number.isNaN(h1)) return { width: Math.round(w1), height: Math.round(h1) };
      const w2 = Number(c.size?.width);
      const h2 = Number(c.size?.height);
      if (w2 > 0 && h2 > 0 && !Number.isNaN(w2) && !Number.isNaN(h2)) return { width: Math.round(w2), height: Math.round(h2) };
    }
  } catch { /* ignore */ }
  return undefined;
}

// ============== worker 消息处理 ==============

interface WorkerRequest {
  type: 'parse' | 'thumbnail';
  filePath: string;
  templateId?: string;
  templateVersionId?: string;
  maxWidth?: number;
}

async function handleParse(filePath: string, templateId: string, templateVersionId: string): Promise<LayerTreeResult> {
  await assertFileSize(filePath);
  const PSD = await getPsd();
  const psd = PSD.fromFile(filePath);
  psd.parse();

  const tree = psd.tree();
  const canvas = {
    width: (psd as any).header?.cols ?? 0,
    height: (psd as any).header?.rows ?? 0,
  };

  const nameCounter = new Map<string, number>();
  const layerCounter = { count: 0 };
  const layerTree = extractChildren(tree.children(), '', nameCounter, 0, layerCounter);

  return { templateId, templateVersionId, canvas, layerTree };
}

async function handleThumbnail(filePath: string, maxWidth: number): Promise<Buffer | null> {
  await assertFileSize(filePath);
  const buf = await fs.readFile(filePath);

  // 优先方案：用 ag-psd 同时读取合成图与 Resource 1036
  //   1) 先试合成图（Image Data Section）— 分辨率高（如 1000×1000），缩放到 maxWidth 是下采样，画质好
  //   2) 合成图近乎为空时（覆盖率 ≤ 0.2%，残缺/过时读取）回退到 Resource 1036
  //      — Photoshop 保存时生成，始终代表完整画布的正确预览，但分辨率较低（通常 160×160），需放大
  const agPsdThumb = await generateThumbnailWithAgPsd(buf, maxWidth);
  if (agPsdThumb) return agPsdThumb;

  // 最终回退：用 psd 包读 Image Data Section（合成图）
  //   仅当 ag-psd 完全失败时使用（如非 Photoshop 保存的 PSD 无 Resource 1036）
  const PSD = await getPsd();
  const psd = PSD.fromFile(filePath);
  psd.parse();

  const image = (psd as any).image;
  if (!image || typeof image.saveAsPng !== 'function') return null;

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'psd-thumb-'));
  const rawPng = path.join(tmpDir, 'raw.png');
  try {
    await image.saveAsPng(rawPng);
    const rawBuf = await fs.readFile(rawPng);
    if (rawBuf.length === 0) return null;
    const thumb = await sharp(rawBuf)
      .resize({ width: maxWidth, height: maxWidth, fit: 'inside' })
      .flatten({ background: '#ffffff' })
      .png({ quality: 80 })
      .toBuffer();
    return thumb;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 用 ag-psd 读取 PSD 并生成正方形缩略图。
 *
 * 策略（按画质从高到低）：
 *   1. 合成图（Image Data Section）— 原始分辨率，下采样画质最佳
 *      仅排除「近乎为空」的残缺/过时读取（覆盖率 ≤ 0.2%）；透明底样机
 *      （T恤/手机壳等）覆盖率天然偏低，透明区由白底 flatten 兜底
 *   2. Resource 1036（JPEG 缩略图）— Photoshop 保存时生成，始终正确
 *      但分辨率较低（通常 160×160），放大到 maxWidth 会有轻微模糊
 *
 * @returns PNG Buffer；若两条路径都失败返回 null
 */
async function generateThumbnailWithAgPsd(psdBuffer: Buffer, maxWidth: number): Promise<Buffer | null> {
  try {
    initAgPsdCanvas();
    const psd = readPsd(psdBuffer, {
      skipCompositeImageData: false, // 读取合成图（高分辨率）
      skipLayerImageData: true,
    });

    // 方案1：合成图（psd.canvas）— 透明背景样机（T恤/手机壳等）不透明覆盖率
    // 天然偏低，仅要求「存在内容」（>0.2%，排除仅剩一条像素带的残缺读取）；
    // 透明区由 resizeToSquareThumbnail 的白底 flatten 兜底，不丢内容
    const compositeCanvas = (psd as any).canvas;
    if (compositeCanvas) {
      const ctx = compositeCanvas.getContext('2d');
      const imgData = ctx?.getImageData?.();
      if (imgData && imgData.data && imgData.data.length > 0) {
        const coverage = computeOpaqueCoverage(imgData.data);
        if (coverage > 0.002) {
          return await resizeToSquareThumbnail(imgData, maxWidth);
        }
      }
    }

    // 方案2：Resource 1036（imageResources.thumbnail）— 始终正确，允许放大
    const thumb = (psd as any).imageResources?.thumbnail;
    if (thumb && thumb.width && thumb.height) {
      const ctx = thumb.getContext('2d');
      const imgData = ctx?.getImageData?.();
      if (imgData && imgData.data && imgData.data.length > 0) {
        return await resizeToSquareThumbnail(imgData, maxWidth);
      }
    }

    return null;
  } catch {
    // ag-psd 解析失败时回退到旧方案
    return null;
  }
}

/** 计算 RGBA 像素数据中不透明像素的占比（alpha >= 10 视为不透明） */
function computeOpaqueCoverage(data: Uint8ClampedArray): number {
  let opaque = 0;
  const total = data.length / 4;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] >= 10) opaque++;
  }
  return total > 0 ? opaque / total : 0;
}

/** 将 RGBA ImageData 缩放为正方形 PNG（压白底），允许放大以支持低分辨率来源 */
async function resizeToSquareThumbnail(
  imgData: { data: Uint8ClampedArray; width: number; height: number },
  maxWidth: number,
): Promise<Buffer> {
  const rawBuf = Buffer.from(imgData.data);
  return sharp(rawBuf, {
    raw: { width: imgData.width, height: imgData.height, channels: 4 },
  })
    .resize({ width: maxWidth, height: maxWidth, fit: 'inside' }) // 正方形，匹配 PSD 画布比例；不设 withoutEnlargement 允许低分辨率来源放大
    .flatten({ background: '#ffffff' }) // 压白底，避免透明区域在深色 UI 上显示为棋盘格
    .png()
    .toBuffer();
}

async function main() {
  const port = parentPort;
  if (!port) throw new Error('psd-worker 必须在 worker_threads 中运行');

  port.on('message', async (req: WorkerRequest) => {
    try {
      if (req.type === 'parse') {
        const result = await handleParse(req.filePath, req.templateId!, req.templateVersionId!);
        port.postMessage({ ok: true, result });
      } else if (req.type === 'thumbnail') {
        const buf = await handleThumbnail(req.filePath, req.maxWidth ?? 800);
        port.postMessage({ ok: true, thumbnail: buf ? Buffer.from(buf) : null });
      } else {
        port.postMessage({ ok: false, error: `未知请求类型: ${req.type}` });
      }
    } catch (e) {
      port.postMessage({ ok: false, error: (e as Error).message, name: (e as Error).name });
    }
  });
}

if (parentPort) void main();
void workerData;
