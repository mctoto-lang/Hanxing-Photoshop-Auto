/**
 * PSD 渲染平台 - 第一期 POC 验证脚本
 *
 * 用法：
 *   npx tsx scripts/verify-poc.ts [--psd <path>] [--backend <url>] [--skip-e2e] [--skip-psd-parse]
 *
 * 验证内容（规范第十三节 P0 项）：
 *   1. 后端 API 路由契约：上传 PSD、创建模板、配置绑定、发布、提交任务
 *   2. PSD 解析器：用真实 PSD 文件验证图层树提取（layerId/layerPath/类型判定）
 *   3. 三类场景测试用例：
 *      场景 1：纯文字替换（type=text）
 *      场景 2：单层智能对象替换（type=smartObject）
 *      场景 3：嵌套组内智能对象替换（type=smartObject，layerPath 跨多级）
 *   4. Mock Worker 端到端：注册 → claim → 上传 PNG 当结果 → complete → 查询结果
 *
 * 不依赖真实 Photoshop：用 Mock Worker 直接上传一张 PNG 作为渲染结果，
 * 验证 API 链路、租约机制、状态机、SHA-256 校验、产物存储。
 *
 * 若需联调真实 Worker + PS，启动 psd-render-worker 即可（自动接管 claim）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 后端 src 内部模块（用于离线 PSD 解析）
import { psdParser } from '../src/services/psd-parser/psd-parser.js';
import sharp from 'sharp';

// ============== 参数解析 ==============

interface CliArgs {
  psdPath?: string;
  backendUrl: string;
  skipE2E: boolean;
  skipPsdParse: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    backendUrl: process.env.PSD_API_URL ?? 'http://localhost:3000',
    skipE2E: false,
    skipPsdParse: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--psd') opts.psdPath = args[++i];
    else if (a === '--backend') opts.backendUrl = args[++i] ?? opts.backendUrl;
    else if (a === '--skip-e2e') opts.skipE2E = true;
    else if (a === '--skip-psd-parse') opts.skipPsdParse = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: npx tsx scripts/verify-poc.ts [--psd <path>] [--backend <url>] [--skip-e2e] [--skip-psd-parse]');
      process.exit(0);
    }
  }
  return opts;
}

// ============== 测试结果汇总 ==============

interface TestResult {
  name: string;
  passed: boolean;
  message: string;
  durationMs?: number;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, message: string, durationMs?: number) {
  results.push({ name, passed, message, durationMs });
  const tag = passed ? '✓ PASS' : '✗ FAIL';
  const dur = durationMs !== undefined ? ` [${durationMs}ms]` : '';
  console.log(`  ${tag} ${name}${dur} — ${message}`);
}

async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    record(name, true, 'OK', Date.now() - t0);
  } catch (e) {
    record(name, false, (e as Error).message ?? String(e), Date.now() - t0);
  }
}

// ============== 测试素材生成 ==============

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function ensureFixtures(): Promise<{
  redPng: Buffer;
  greenPng: Buffer;
  bluePng: Buffer;
  resultPng: Buffer;
}> {
  await fs.mkdir(FIXTURES_DIR, { recursive: true });

  const red = path.join(FIXTURES_DIR, 'input_red.png');
  const green = path.join(FIXTURES_DIR, 'input_green.png');
  const blue = path.join(FIXTURES_DIR, 'input_blue.png');
  const result = path.join(FIXTURES_DIR, 'mock_result.png');

  if (!(await fileExists(red))) {
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#E63946' } })
      .png().toFile(red);
  }
  if (!(await fileExists(green))) {
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2A9D8F' } })
      .png().toFile(green);
  }
  if (!(await fileExists(blue))) {
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#264653' } })
      .png().toFile(blue);
  }
  if (!(await fileExists(result))) {
    // 模拟结果图：白底 + 文字（用 SVG 转 PNG）
    const svg = `<svg width="800" height="600" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#FFFFFF"/>
      <text x="400" y="300" text-anchor="middle" font-family="sans-serif" font-size="48" fill="#000">
        Mock Render Result
      </text>
    </svg>`;
    await sharp(Buffer.from(svg)).png().toFile(result);
  }

  return {
    redPng: await fs.readFile(red),
    greenPng: await fs.readFile(green),
    bluePng: await fs.readFile(blue),
    resultPng: await fs.readFile(result),
  };
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ============== HTTP 工具 ==============

class ApiClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async request(method: string, p: string, opts: {
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: Buffer;
    timeoutMs?: number;
    expectStatus?: number;
  } = {}): Promise<{ status: number; json: any; text: string }> {
    const url = `${this.baseUrl}${p}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
    try {
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        ...(opts.headers ?? {}),
      };
      let body: BodyInit | undefined;
      if (opts.rawBody !== undefined) {
        body = opts.rawBody;
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
      const resp = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await resp.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
      return { status: resp.status, json, text };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 上传文件到本地存储代理（PUT /storage/upload） */
  async uploadToStorage(uploadUrl: string, buf: Buffer, mimeType: string): Promise<{ sha256: string; size: number }> {
    // uploadUrl 是相对路径
    const url = uploadUrl.startsWith('http') ? uploadUrl : `${this.baseUrl}${uploadUrl}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': mimeType },
      body: buf,
    });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`上传失败 ${resp.status}: ${text}`);
    const json = JSON.parse(text);
    return { sha256: json.sha256, size: json.size };
  }

  /** 下载文件（GET /storage/download） */
  async downloadFromStorage(downloadUrl: string): Promise<Buffer> {
    const url = downloadUrl.startsWith('http') ? downloadUrl : `${this.baseUrl}${downloadUrl}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载失败 ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  }
}

// ============== Mock Worker ==============

class MockWorker {
  private accessToken: string | null = null;
  private workerId: string | null = null;

  constructor(private baseUrl: string) {}

  async register(): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/internal/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineFingerprint: `mock-worker-${process.pid}-${Date.now()}`,
        psVersion: '25.0',
        psMajorVersion: 25,
        os: 'windows',
        supportsSmartObject: true,
        supportsTextLayer: true,
        fonts: [],
      }),
    });
    if (!resp.ok) throw new Error(`Worker 注册失败 ${resp.status}: ${await resp.text()}`);
    const json = await resp.json();
    this.accessToken = json.accessToken;
    this.workerId = json.workerId;
  }

  async claim(maxWaitSec = 5): Promise<{
    jobId: string;
    leaseToken: string;
    manifest: any;
  } | null> {
    const resp = await fetch(`${this.baseUrl}/internal/workers/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ maxWaitSeconds: maxWaitSec, psMajorVersion: 25 }),
    });
    if (resp.status === 202) return null;
    if (!resp.ok) throw new Error(`claim 失败 ${resp.status}: ${await resp.text()}`);
    const json = await resp.json();
    if (!json.jobId) return null;
    return { jobId: json.jobId, leaseToken: json.leaseToken, manifest: json.manifest };
  }

  async heartbeat(jobId: string, leaseToken: string, data: { stage?: string; progress?: number }): Promise<void> {
    await fetch(`${this.baseUrl}/internal/jobs/${jobId}/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ leaseToken, ...data }),
    });
  }

  async complete(jobId: string, leaseToken: string, data: {
    resultObjectKey: string; resultSha256: string; resultMimeType: string; resultSize: number;
  }): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/internal/jobs/${jobId}/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ leaseToken, ...data }),
    });
    if (!resp.ok) throw new Error(`complete 失败 ${resp.status}: ${await resp.text()}`);
  }

  async fail(jobId: string, leaseToken: string, data: {
    errorCode: string; errorMessage: string; stage?: string;
  }): Promise<void> {
    await fetch(`${this.baseUrl}/internal/jobs/${jobId}/fail`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ leaseToken, ...data }),
    });
  }
}

// ============== 场景定义 ==============

interface Scenario {
  name: string;
  description: string;
  /** 应在图层树中找到的图层标识（用于绑定配置） */
  bindings: Array<{
    bindingId: string;
    layerPathSubstring: string;
    type: 'text' | 'smartObject';
    required: boolean;
    /** 模拟输入：文字或图片 buffer */
    text?: string;
    image?: Buffer;
    imageFileName?: string;
    expectedLayerKind: 'text' | 'smartObject';
  }>;
}

/**
 * 三类场景定义。
 * 这些场景依赖一个具备特定结构的 PSD 模板：
 *   - 顶层文字图层（如 "标题"）
 *   - 顶层智能对象图层（如 "主图"）
 *   - 嵌套组 "组/内层" 中包含一个智能对象
 *
 * 若用户提供的 PSD 不完全匹配，脚本会按图层类型自适应：
 * 从图层树中自动选择第一个文字层、第一个智能对象、嵌套最深的智能对象。
 */
function buildScenarios(
  layerTree: any[],
  images: { red: Buffer; green: Buffer; blue: Buffer },
): Scenario[] {
  const flat = flattenTree(layerTree);

  // 找出候选图层
  const textLayers = flat.filter((n) => n.type === 'text');
  const smartObjectLayers = flat.filter((n) => n.type === 'smartObject');
  // 嵌套组内智能对象：layerPath 含至少一个 "/"（即非顶层）
  const nestedSmartObjects = smartObjectLayers.filter((n) => n.layerPath.includes('/'));
  const topLevelSmartObjects = smartObjectLayers.filter((n) => !n.layerPath.includes('/'));

  const scenarios: Scenario[] = [];

  // 场景 1：纯文字替换
  if (textLayers.length > 0) {
    const t = textLayers[0];
    scenarios.push({
      name: '场景1-纯文字替换',
      description: `替换文字图层 "${t.layerPath}" 的内容`,
      bindings: [{
        bindingId: 'title_text',
        layerPathSubstring: t.layerPath,
        type: 'text',
        required: true,
        text: 'POC 验证 - 文字替换成功 - ' + new Date().toISOString(),
        expectedLayerKind: 'text',
      }],
    });
  }

  // 场景 2：单层智能对象替换
  const soCandidate = topLevelSmartObjects[0] ?? smartObjectLayers[0];
  if (soCandidate) {
    scenarios.push({
      name: '场景2-单层智能对象替换',
      description: `替换智能对象 "${soCandidate.layerPath}" 的内容`,
      bindings: [{
        bindingId: 'main_image',
        layerPathSubstring: soCandidate.layerPath,
        type: 'smartObject',
        required: true,
        image: images.red,
        imageFileName: 'input_red.png',
        expectedLayerKind: 'smartObject',
      }],
    });
  }

  // 场景 3：嵌套组内智能对象替换
  const nestedCandidate = nestedSmartObjects[0];
  if (nestedCandidate) {
    scenarios.push({
      name: '场景3-嵌套组内智能对象替换',
      description: `替换嵌套组智能对象 "${nestedCandidate.layerPath}" 的内容`,
      bindings: [{
        bindingId: 'nested_image',
        layerPathSubstring: nestedCandidate.layerPath,
        type: 'smartObject',
        required: true,
        image: images.green,
        imageFileName: 'input_green.png',
        expectedLayerKind: 'smartObject',
      }],
    });
  }

  return scenarios;
}

function flattenTree(nodes: any[], parent?: any): any[] {
  const result: any[] = [];
  for (const n of nodes) {
    result.push({ ...n, _parent: parent?.layerPath });
    if (n.children?.length) result.push(...flattenTree(n.children, n));
  }
  return result;
}

// ============== 主流程 ==============

async function main() {
  const args = parseArgs();
  console.log('\n=== PSD 渲染平台 POC 验证 ===');
  console.log(`后端: ${args.backendUrl}`);
  console.log(`PSD:  ${args.psdPath ?? '(未提供)'}`);
  console.log('');

  // 0. 准备测试素材
  console.log('[0/4] 准备测试素材');
  await runStep('生成测试 PNG（红/绿/蓝/mock 结果）', async () => {
    await ensureFixtures();
  });

  // 1. 离线 PSD 解析（不依赖后端）
  if (!args.skipPsdParse && args.psdPath) {
    console.log('\n[1/4] PSD 解析器验证（离线）');
    const psdBuffer = await fs.readFile(args.psdPath);
    await runStep('PSD 文件存在且非空', async () => {
      if (psdBuffer.length === 0) throw new Error('PSD 文件为空');
    });
    await runStep('psd-parser 解析图层树', async () => {
      const result = await psdParser.parse({
        templateId: 'verify-tpl',
        templateVersionId: 'verify-tplv',
        filePath: args.psdPath!,
      });
      if (!result.layerTree || result.layerTree.length === 0) {
        throw new Error('图层树为空');
      }
      const flat = flattenTree(result.layerTree);
      console.log(`    画布: ${result.canvas.width}x${result.canvas.height}`);
      console.log(`    顶层图层数: ${result.layerTree.length}`);
      console.log(`    总图层数: ${flat.length}`);
      console.log(`    文字层: ${flat.filter((n) => n.type === 'text').length}`);
      console.log(`    智能对象: ${flat.filter((n) => n.type === 'smartObject').length}`);
      console.log(`    组: ${flat.filter((n) => n.type === 'group').length}`);
    });
  } else if (!args.skipPsdParse && !args.psdPath) {
    console.log('\n[1/4] PSD 解析器验证：跳过（未提供 --psd 参数）');
  }

  // 2. 后端 API 联调
  if (!args.skipE2E) {
    console.log('\n[2/4] 后端 API 路由契约验证');

    // 检查后端是否启动
    let backendAlive = false;
    await runStep('后端健康检查（GET /admin/api/stats）', async () => {
      try {
        const resp = await fetch(`${args.backendUrl}/admin/api/stats`, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        backendAlive = true;
      } catch (e) {
        throw new Error(`后端未启动或不可达: ${(e as Error).message}（请先运行 npm run dev）`);
      }
    });

    if (backendAlive) {
      const apiKey = process.env.API_KEY ?? 'sk_live_poc_demo_2026';
      const client = new ApiClient(args.backendUrl, apiKey);

      await runStep('鉴权：无 API Key 应返回 401', async () => {
        const resp = await fetch(`${args.backendUrl}/v1/templates`);
        if (resp.status !== 401) throw new Error(`期望 401，实际 ${resp.status}`);
      });

      await runStep('鉴权：正确 API Key 应返回 200', async () => {
        const r = await client.request('GET', '/v1/templates');
        if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}: ${r.text}`);
      });

      await runStep('GET /v1/templates 模板列表', async () => {
        const r = await client.request('GET', '/v1/templates');
        if (!r.json?.templates) throw new Error('响应缺少 templates 字段');
      });

      await runStep('POST /v1/assets/upload-url 资产上传地址', async () => {
        const r = await client.request('POST', '/v1/assets/upload-url', {
          body: { fileName: 'test.png', mimeType: 'image/png' },
        });
        if (r.status !== 200 || !r.json?.uploadUrl) {
          throw new Error(`响应异常: ${r.status} ${r.text}`);
        }
      });

      // 完整 e2e 需要 PSD 文件
      if (!args.psdPath) {
        console.log('  ℹ 未提供 --psd，跳过完整 e2e 链路（场景 3-5）');
        console.log('    提示：运行 npx tsx scripts/verify-poc.ts --psd path/to/template.psd 启用完整验证');
      }
    } else {
      console.log('  ℹ 后端未启动，跳过 API 契约测试');
    }
  } else {
    console.log('\n[2/4] API 契约验证：跳过（--skip-e2e）');
  }

  // 3. 端到端 Mock Worker 流程
  if (!args.skipE2E && args.psdPath) {
    console.log('\n[3/4] 端到端 Mock Worker 流程（需后端运行 + PSD 文件）');

    let backendAlive = false;
    try {
      const resp = await fetch(`${args.backendUrl}/admin/api/stats`, { signal: AbortSignal.timeout(3000) });
      backendAlive = resp.ok;
    } catch {}

    if (!backendAlive) {
      console.log('  ℹ 后端未启动，跳过 e2e 流程');
    } else {
      const apiKey = process.env.API_KEY ?? 'sk_live_poc_demo_2026';
      const client = new ApiClient(args.backendUrl, apiKey);
      const images = await ensureFixtures();
      const imageBuffers = {
        red: images.redPng, green: images.greenPng, blue: images.bluePng,
      };

      // 解析 PSD 拿到图层树
      const parseResult = await psdParser.parse({
        templateId: 'verify-tpl',
        templateVersionId: 'verify-tplv',
        filePath: args.psdPath,
      });
      const scenarios = buildScenarios(parseResult.layerTree, imageBuffers);

      if (scenarios.length === 0) {
        console.log('  ⚠ PSD 中未找到可绑定的文字层或智能对象层');
      }

      // 注册 Mock Worker
      const worker = new MockWorker(args.backendUrl);
      await runStep('Mock Worker 注册', async () => {
        await worker.register();
      });

      // 上传 PSD
      let psdObjectKey: string | null = null;
      let templateId: string | null = null;
      let templateVersionId: string | null = null;
      let layerSchema: any = null;

      await runStep('上传 PSD + 创建模板', async () => {
        const psdBuffer = await fs.readFile(args.psdPath!);
        // 1. 获取上传 URL
        const upUrlResp = await client.request('POST', '/v1/templates/upload-url', {
          body: { fileName: path.basename(args.psdPath!), mimeType: 'image/vnd.adobe.photoshop' },
        });
        if (upUrlResp.status !== 200) throw new Error(`upload-url: ${upUrlResp.text}`);
        psdObjectKey = upUrlResp.json.objectKey;
        // 2. PUT 上传文件
        await client.uploadToStorage(upUrlResp.json.uploadUrl, psdBuffer, 'image/vnd.adobe.photoshop');
        // 3. 创建模板（触发解析）
        const createResp = await client.request('POST', '/v1/templates', {
          body: { objectKey: psdObjectKey, name: `POC 验证模板 ${new Date().toISOString()}` },
        });
        if (createResp.status !== 200) throw new Error(`create: ${createResp.text}`);
        templateId = createResp.json.templateId;
        templateVersionId = createResp.json.templateVersionId;
        const flat = flattenTree(createResp.json.layerTree);
        console.log(`    模板已创建，图层总数 ${flat.length}`);
      });

      // 配置绑定
      await runStep('配置图层绑定并发布模板', async () => {
        // 从后端重新拉取模板详情，拿到图层树
        const detail = await client.request('GET', `/v1/templates/${templateId}`);
        const tree = detail.json.latestVersion.layerTree;
        const flat = flattenTree(tree);

        // 找出场景需要的图层
        const bindings: any[] = [];
        for (const sc of scenarios) {
          for (const b of sc.bindings) {
            const node = flat.find((n: any) => n.layerPath === b.layerPathSubstring);
            if (!node) {
              throw new Error(`场景 ${sc.name} 找不到图层: ${b.layerPathSubstring}`);
            }
            if (node.type !== b.expectedLayerKind) {
              throw new Error(`图层 ${b.layerPathSubstring} 类型不匹配: 期望 ${b.expectedLayerKind}，实际 ${node.type}`);
            }
            bindings.push({
              bindingId: b.bindingId,
              layerId: node.layerId,
              layerPath: node.layerPath,
              type: b.type,
              required: b.required,
              acceptedFormats: b.type === 'smartObject' ? ['jpg', 'png', 'jpeg'] : undefined,
              fit: b.type === 'smartObject' ? 'cover' : undefined,
            });
          }
        }

        const saveResp = await client.request('PUT', `/v1/templates/${templateId}/layer-bindings`, {
          body: { bindings },
        });
        if (saveResp.status !== 200) throw new Error(`save bindings: ${saveResp.text}`);

        const pubResp = await client.request('POST', `/v1/templates/${templateId}/publish`);
        if (pubResp.status !== 200) throw new Error(`publish: ${pubResp.text}`);
        layerSchema = { bindings };
      });

      // 三类场景：依次提交任务
      for (const sc of scenarios) {
        await runStep(`提交任务：${sc.name}`, async () => {
          // 1. 上传智能对象图片
          const input: Record<string, { assetId?: string; text?: string }> = {};
          for (const b of sc.bindings) {
            if (b.type === 'smartObject' && b.image && b.imageFileName) {
              const upResp = await client.request('POST', '/v1/assets/upload-url', {
                body: { fileName: b.imageFileName, mimeType: 'image/png' },
              });
              if (upResp.status !== 200) throw new Error(`upload-url: ${upResp.text}`);
              await client.uploadToStorage(upResp.json.uploadUrl, b.image, 'image/png');
              input[b.bindingId] = { assetId: upResp.json.assetId };
            } else if (b.type === 'text' && b.text !== undefined) {
              input[b.bindingId] = { text: b.text };
            }
          }

          // 2. 提交任务
          const idempotencyKey = `verify-${sc.name}-${Date.now()}`;
          const r = await client.request('POST', '/v1/render-jobs', {
            body: {
              templateVersionId,
              input,
              output: { format: 'png' },
            },
            headers: { 'Idempotency-Key': idempotencyKey },
          });
          if (r.status !== 201) throw new Error(`提交失败: ${r.status} ${r.text}`);
          console.log(`    任务编号: ${r.json.jobId}`);
        });

        // Mock Worker 领取任务并完成
        await runStep(`Mock Worker claim + complete：${sc.name}`, async () => {
          const claim = await worker.claim(20);
          if (!claim) throw new Error('未领取到任务');
          console.log(`    已领取 jobId=${claim.jobId.slice(0, 12)}...`);

          // 心跳
          await worker.heartbeat(claim.jobId, claim.leaseToken, { stage: 'RUN_JSX', progress: 50 });
          await worker.heartbeat(claim.jobId, claim.leaseToken, { stage: 'UPLOAD', progress: 90 });

          // 上传 mock 结果到 manifest.resultUploadUrl
          const resultPng = (await ensureFixtures()).resultPng;
          const upMeta = await client.uploadToStorage(
            claim.manifest.resultUploadUrl,
            resultPng,
            'image/png',
          );

          // 完成任务
          await worker.complete(claim.jobId, claim.leaseToken, {
            resultObjectKey: claim.manifest.resultObjectKey,
            resultSha256: upMeta.sha256,
            resultMimeType: 'image/png',
            resultSize: upMeta.size,
          });
        });
      }

      // 查询任务结果
      await runStep('查询任务结果并下载', async () => {
        const list = await client.request('GET', '/v1/render-jobs', { headers: {} }).catch(() => null);
        // render-jobs 没有列表接口，改用 admin
        const adminJobs = await fetch(`${args.backendUrl}/admin/api/jobs?limit=10`).then((r) => r.json());
        const recent = adminJobs.jobs.filter((j: any) => j.status === 'SUCCEEDED').slice(0, scenarios.length);
        if (recent.length < scenarios.length) {
          throw new Error(`期望至少 ${scenarios.length} 个 SUCCEEDED 任务，实际 ${recent.length}`);
        }
        for (const j of recent) {
          console.log(`    任务 ${j.jobId}: ${j.status}, 模板=${j.template}`);
        }
      });
    }
  } else if (!args.psdPath) {
    console.log('\n[3/4] 端到端 Mock Worker 流程：跳过（未提供 --psd）');
  } else {
    console.log('\n[3/4] 端到端 Mock Worker 流程：跳过（--skip-e2e）');
  }

  // 4. JSX 脚本结构验证
  console.log('\n[4/4] JSX 脚本结构验证');
  await runStep('render-job.jsx 包含必备函数', async () => {
    const jsxPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'psd-render-worker', 'jsx', 'render-job.jsx',
    );
    const src = await fs.readFile(jsxPath, 'utf8');
    const required = [
      'function readFileText',
      'function writeFileText',
      'function parseJson',
      'function stringifyJson',
      'function findLayerById',
      'function findLayerByPath',
      'function resolveLayer',
      'function replaceSmartObjectContents',
      'function replaceTextContents',
      'function exportDocument',
      'function main',
      'placedLayerReplaceContents',
    ];
    const missing = required.filter((k) => !src.includes(k));
    if (missing.length > 0) throw new Error(`缺少: ${missing.join(', ')}`);
  });

  await runStep('JSX 包含三类场景分支', async () => {
    const jsxPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'psd-render-worker', 'jsx', 'render-job.jsx',
    );
    const src = await fs.readFile(jsxPath, 'utf8');
    if (!src.includes("b.type === 'text'")) throw new Error('缺少文字替换分支');
    if (!src.includes("b.type === 'smartObject'")) throw new Error('缺少智能对象替换分支');
    if (!src.includes("b.type === 'group'")) throw new Error('缺少组类型分支');
  });

  await runStep('JSX 支持 PNG/JPEG/PSD 三种导出', async () => {
    const jsxPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..', '..', 'psd-render-worker', 'jsx', 'render-job.jsx',
    );
    const src = await fs.readFile(jsxPath, 'utf8');
    if (!src.includes("format === 'psd'")) throw new Error('缺少 PSD 导出');
    if (!src.includes("format === 'jpeg'")) throw new Error('缺少 JPEG 导出');
    if (!src.includes('ExportOptionsSaveForWeb')) throw new Error('缺少 SaveForWeb 选项');
  });

  // ============== 汇总 ==============
  console.log('\n=== 验证汇总 ===');
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`通过 ${passed} 项，失败 ${failed} 项，共 ${results.length} 项`);

  if (failed > 0) {
    console.log('\n失败项：');
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  - ${r.name}: ${r.message}`);
    }
    process.exit(1);
  } else {
    console.log('\n✓ POC 验证全部通过');
  }
}

main().catch((e) => {
  console.error('脚本执行异常:', e);
  process.exit(1);
});
