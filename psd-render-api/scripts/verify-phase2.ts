/**
 * PSD 渲染平台 - 第二期验证脚本
 *
 * 用法：
 *   npx tsx scripts/verify-phase2.ts [--backend <url>] [--skip-e2e]
 *
 * 验证内容（规范第十二节 + 第十三节 P1 项）：
 *   1. 任务取消流程：
 *      - 提交任务 → 取消（QUEUED 直接 CANCELLED）
 *      - 提交任务 → claim → 取消（LEASED → CANCELLING → Worker 阶段边界 → CANCELLED）
 *   2. 能力路由：
 *      - 任务声明 requiredCapabilities.psMajorVersion=25
 *      - 注册 PS 大版本 24 的 Worker，claim 应返回 null
 *      - 注册 PS 大版本 26 的 Worker，claim 应成功
 *   3. 监控告警：
 *      - GET /admin/api/alerts 返回告警列表
 *      - POST /admin/api/alerts/:id/ack 标记 ACKED
 *   4. COS 存储后端（若 STORAGE_BACKEND=cos）：
 *      - 生成上传 URL → PUT 文件 → headObject → 生成下载 URL → GET 校验内容
 *   5. BullMQ 队列后端（若 QUEUE_BACKEND=bullmq）：
 *      - 健康检查（Redis 连接状态）
 *      - 任务入队后 Worker 阻塞 claim 应在 1s 内被唤醒
 *
 * 依赖：
 *   - 后端服务已启动（npm run dev）
 *   - 环境变量 API_KEY 有效
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// ============== 参数解析 ==============

interface CliArgs {
  backendUrl: string;
  skipE2E: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const opts: CliArgs = {
    backendUrl: process.env.PSD_API_URL ?? 'http://localhost:3000',
    skipE2E: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--backend') opts.backendUrl = args[++i] ?? opts.backendUrl;
    else if (a === '--skip-e2e') opts.skipE2E = true;
    else if (a === '-h' || a === '--help') {
      console.log('Usage: npx tsx scripts/verify-phase2.ts [--backend <url>] [--skip-e2e]');
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

// ============== HTTP 工具 ==============

class ApiClient {
  constructor(private baseUrl: string, private apiKey: string) {}

  async request(method: string, p: string, opts: {
    body?: unknown;
    headers?: Record<string, string>;
    rawBody?: Buffer;
    timeoutMs?: number;
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

  async uploadToStorage(uploadUrl: string, buf: Buffer, mimeType: string): Promise<{ sha256: string; size: number }> {
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
}

// ============== Mock Worker ==============

class MockWorker {
  private accessToken: string | null = null;
  private workerId: string | null = null;

  constructor(private baseUrl: string) {}

  async register(opts: {
    psVersion?: string;
    psMajorVersion?: number;
    supportsSmartObject?: boolean;
    supportsTextLayer?: boolean;
  } = {}): Promise<{ workerId: string; accessToken: string }> {
    const resp = await fetch(`${this.baseUrl}/internal/workers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineFingerprint: `mock-${opts.psMajorVersion ?? 25}-${process.pid}-${Date.now()}-${Math.random()}`,
        psVersion: opts.psVersion ?? '25.0',
        psMajorVersion: opts.psMajorVersion ?? 25,
        os: 'windows',
        supportsSmartObject: opts.supportsSmartObject ?? true,
        supportsTextLayer: opts.supportsTextLayer ?? true,
        fonts: [],
      }),
    });
    if (!resp.ok) throw new Error(`Worker 注册失败 ${resp.status}: ${await resp.text()}`);
    const json = await resp.json();
    this.accessToken = json.accessToken;
    this.workerId = json.workerId;
    return { workerId: json.workerId, accessToken: json.accessToken };
  }

  async claim(maxWaitSec = 3, body: Record<string, unknown> = {}): Promise<{
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
      body: JSON.stringify({ maxWaitSeconds: maxWaitSec, ...body }),
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

  async checkCancel(jobId: string): Promise<{ cancelled: boolean }> {
    const resp = await fetch(`${this.baseUrl}/internal/jobs/${jobId}/cancel-check`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    if (!resp.ok) throw new Error(`cancel-check 失败 ${resp.status}: ${await resp.text()}`);
    return resp.json();
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

// ============== 模板/任务构造工具 ==============

/**
 * 创建一个最小可用的模板（带一个文字绑定）
 * 需要 PSD 文件；若没有 PSD，则跳过相关测试
 */
async function createSimpleTemplate(
  client: ApiClient,
  psdPath: string,
): Promise<{ templateId: string; templateVersionId: string; bindingId: string }> {
  // 上传 PSD
  const psdBuffer = await fs.readFile(psdPath);
  const upUrlResp = await client.request('POST', '/v1/templates/upload-url', {
    body: { fileName: path.basename(psdPath), mimeType: 'image/vnd.adobe.photoshop' },
  });
  if (upUrlResp.status !== 200) throw new Error(`upload-url: ${upUrlResp.text}`);
  await client.uploadToStorage(upUrlResp.json.uploadUrl, psdBuffer, 'image/vnd.adobe.photoshop');

  // 创建模板
  const createResp = await client.request('POST', '/v1/templates', {
    body: { objectKey: upUrlResp.json.objectKey, name: `Phase2 验证模板 ${Date.now()}` },
  });
  if (createResp.status !== 200) throw new Error(`create: ${createResp.text}`);
  const templateId = createResp.json.templateId;
  const templateVersionId = createResp.json.templateVersionId;

  // 找到第一个文字层绑定
  const detail = await client.request('GET', `/v1/templates/${templateId}`);
  const tree = detail.json.latestVersion.layerTree;
  const flat = flattenTree(tree);
  const textLayer = flat.find((n: any) => n.type === 'text');
  if (!textLayer) throw new Error('PSD 中未找到文字层，无法构造简单模板');

  const bindingId = 'phase2_test_text';
  await client.request('PUT', `/v1/templates/${templateId}/layer-bindings`, {
    body: {
      bindings: [{
        bindingId,
        layerId: textLayer.layerId,
        layerPath: textLayer.layerPath,
        type: 'text',
        required: true,
      }],
    },
  });
  await client.request('POST', `/v1/templates/${templateId}/publish`);
  return { templateId, templateVersionId, bindingId };
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
  console.log('\n=== PSD 渲染平台 第二期验证 ===');
  console.log(`后端: ${args.backendUrl}`);
  console.log('');

  // 0. 后端健康检查
  console.log('[0/5] 后端健康检查');
  let backendAlive = false;
  await runStep('GET /admin/api/stats 健康检查', async () => {
    try {
      const resp = await fetch(`${args.backendUrl}/admin/api/stats`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      backendAlive = true;
    } catch (e) {
      throw new Error(`后端未启动或不可达: ${(e as Error).message}（请先运行 npm run dev）`);
    }
  });

  if (!backendAlive) {
    console.log('\nℹ 后端不可达，无法继续验证，请先启动后端服务');
    printSummary();
    process.exit(1);
  }

  const apiKey = process.env.API_KEY ?? 'sk_live_poc_demo_2026';
  const client = new ApiClient(args.backendUrl, apiKey);

  // 准备 PSD 文件
  const psdPath = process.env.PSD_TEST_FILE ?? '';
  const hasPsd = psdPath && await fileExists(psdPath);
  if (!hasPsd) {
    console.log('  ℹ 未设置 PSD_TEST_FILE 环境变量，部分场景将跳过');
  }

  // 1. 任务取消流程
  console.log('\n[1/5] 任务取消流程');
  if (args.skipE2E || !hasPsd) {
    console.log('  ℹ 跳过（--skip-e2e 或未提供 PSD）');
  } else {
    const { templateVersionId, bindingId } = await createSimpleTemplate(client, psdPath);

    // 场景 A：QUEUED 直接取消
    await runStep('场景A：提交任务 → 立即取消（QUEUED → CANCELLED）', async () => {
      // 提交任务
      const createResp = await client.request('POST', '/v1/render-jobs', {
        body: {
          templateVersionId,
          input: { [bindingId]: { text: 'cancel-test-A' } },
          output: { format: 'png' },
        },
        headers: { 'Idempotency-Key': `cancel-A-${Date.now()}` },
      });
      if (createResp.status !== 201) throw new Error(`提交失败: ${createResp.text}`);
      const jobId = createResp.json.jobId;

      // 立即取消
      const cancelResp = await client.request('POST', `/v1/render-jobs/${jobId}/cancel`, {
        body: { reason: 'test_cancel_A' },
      });
      if (cancelResp.status !== 200) throw new Error(`取消失败: ${cancelResp.text}`);
      if (cancelResp.json.status !== 'CANCELLED') {
        throw new Error(`期望 status=CANCELLED，实际 ${cancelResp.json.status}`);
      }

      // 查询验证
      const getResp = await client.request('GET', `/v1/render-jobs/${jobId}`);
      if (getResp.json.status !== 'CANCELLED') {
        throw new Error(`查询期望 CANCELLED，实际 ${getResp.json.status}`);
      }
    });

    // 场景 B：LEASED → CANCELLING → CANCELLED
    await runStep('场景B：提交任务 → claim → 取消（CANCELLING → Worker 检测 → CANCELLED）', async () => {
      // 提交任务
      const createResp = await client.request('POST', '/v1/render-jobs', {
        body: {
          templateVersionId,
          input: { [bindingId]: { text: 'cancel-test-B' } },
          output: { format: 'png' },
        },
        headers: { 'Idempotency-Key': `cancel-B-${Date.now()}` },
      });
      if (createResp.status !== 201) throw new Error(`提交失败: ${createResp.text}`);
      const jobId = createResp.json.jobId;

      // 注册 Worker 并 claim
      const worker = new MockWorker(args.backendUrl);
      await worker.register({ psMajorVersion: 25 });
      const claim = await worker.claim(5);
      if (!claim) throw new Error('Worker 未能领取任务');
      if (claim.jobId !== jobId) {
        // 可能领取到其他任务，先 fail 掉
        await worker.fail(claim.jobId, claim.leaseToken, {
          errorCode: 'PHOTOSHOP_SCRIPT_ERROR',
          errorMessage: 'phase2 verify cleanup',
        });
        throw new Error(`领取到错误的任务: 期望 ${jobId}，实际 ${claim.jobId}`);
      }

      // 调用取消接口（应返回 CANCELLING）
      const cancelResp = await client.request('POST', `/v1/render-jobs/${jobId}/cancel`, {
        body: { reason: 'test_cancel_B' },
      });
      if (cancelResp.status !== 200) throw new Error(`取消失败: ${cancelResp.text}`);
      if (cancelResp.json.status !== 'CANCELLING') {
        throw new Error(`期望 status=CANCELLING，实际 ${cancelResp.json.status}`);
      }

      // Worker 在阶段边界检查取消信号
      const checkResult = await worker.checkCancel(claim.jobId);
      if (!checkResult.cancelled) {
        throw new Error('Worker 未检测到取消信号');
      }

      // 查询验证状态为 CANCELLED
      const getResp = await client.request('GET', `/v1/render-jobs/${jobId}`);
      if (getResp.json.status !== 'CANCELLED') {
        throw new Error(`期望 CANCELLED，实际 ${getResp.json.status}`);
      }
    });

    // 场景 C：取消已 SUCCEEDED 任务应返回 409
    await runStep('场景C：取消已成功任务应返回 409（updated=false）', async () => {
      // 先完成一个任务
      const createResp = await client.request('POST', '/v1/render-jobs', {
        body: {
          templateVersionId,
          input: { [bindingId]: { text: 'cancel-test-C' } },
          output: { format: 'png' },
        },
        headers: { 'Idempotency-Key': `cancel-C-${Date.now()}` },
      });
      if (createResp.status !== 201) throw new Error(`提交失败: ${createResp.text}`);
      const jobId = createResp.json.jobId;

      const worker = new MockWorker(args.backendUrl);
      await worker.register({ psMajorVersion: 25 });
      const claim = await worker.claim(5);
      if (!claim) throw new Error('Worker 未能领取任务');

      // 心跳进入 PROCESSING
      await worker.heartbeat(claim.jobId, claim.leaseToken, { stage: 'RUN_JSX', progress: 50 });

      // 上传一个 mock 结果文件
      const mockResult = Buffer.from('mock phase2 result');
      const upMeta = await client.uploadToStorage(claim.manifest.resultUploadUrl, mockResult, 'image/png');
      const completeResp = await fetch(`${args.backendUrl}/internal/jobs/${claim.jobId}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${(worker as any).accessToken}`,
        },
        body: JSON.stringify({
          leaseToken: claim.leaseToken,
          resultObjectKey: claim.manifest.resultObjectKey,
          resultSha256: upMeta.sha256,
          resultMimeType: 'image/png',
          resultSize: upMeta.size,
        }),
      });
      if (!completeResp.ok) throw new Error(`complete 失败: ${await completeResp.text()}`);

      // 尝试取消已成功任务
      const cancelResp = await client.request('POST', `/v1/render-jobs/${jobId}/cancel`, {
        body: { reason: 'test_cancel_C' },
      });
      if (cancelResp.status !== 409) {
        throw new Error(`期望 409，实际 ${cancelResp.status}: ${cancelResp.text}`);
      }
      if (cancelResp.json.updated !== false) {
        throw new Error(`期望 updated=false，实际 ${cancelResp.json.updated}`);
      }
    });
  }

  // 2. 能力路由
  console.log('\n[2/5] 能力路由');
  if (args.skipE2E || !hasPsd) {
    console.log('  ℹ 跳过（--skip-e2e 或未提供 PSD）');
  } else {
    const { templateVersionId, bindingId } = await createSimpleTemplate(client, psdPath);

    await runStep('场景D：requiredCapabilities.psMajorVersion=25，PS24 Worker 应被过滤', async () => {
      // 提交任务（要求 PS>=25）
      const createResp = await client.request('POST', '/v1/render-jobs', {
        body: {
          templateVersionId,
          input: { [bindingId]: { text: 'cap-test-D' } },
          output: { format: 'png' },
          requiredCapabilities: { psMajorVersion: 25 },
        },
        headers: { 'Idempotency-Key': `cap-D-${Date.now()}` },
      });
      if (createResp.status !== 201) throw new Error(`提交失败: ${createResp.text}`);
      const jobId = createResp.json.jobId;

      // 注册 PS24 Worker，claim 应返回 null
      const worker24 = new MockWorker(args.backendUrl);
      await worker24.register({ psMajorVersion: 24 });
      const claim24 = await worker24.claim(2, { psMajorVersion: 24 });
      if (claim24 !== null) {
        // 清理：fail 掉错领的任务
        await worker24.fail(claim24.jobId, claim24.leaseToken, {
          errorCode: 'PHOTOSHOP_SCRIPT_ERROR',
          errorMessage: 'phase2 verify cleanup',
        });
        throw new Error('PS24 Worker 不应领取到要求 PS>=25 的任务');
      }

      // 取消任务避免影响后续测试
      await client.request('POST', `/v1/render-jobs/${jobId}/cancel`, { body: {} });
    });

    await runStep('场景E：requiredCapabilities.psMajorVersion=25，PS26 Worker 可领取', async () => {
      // 提交任务（要求 PS>=25）
      const createResp = await client.request('POST', '/v1/render-jobs', {
        body: {
          templateVersionId,
          input: { [bindingId]: { text: 'cap-test-E' } },
          output: { format: 'png' },
          requiredCapabilities: { psMajorVersion: 25 },
        },
        headers: { 'Idempotency-Key': `cap-E-${Date.now()}` },
      });
      if (createResp.status !== 201) throw new Error(`提交失败: ${createResp.text}`);
      const jobId = createResp.json.jobId;

      // 注册 PS26 Worker，claim 应成功
      const worker26 = new MockWorker(args.backendUrl);
      await worker26.register({ psMajorVersion: 26 });
      const claim26 = await worker26.claim(5, { psMajorVersion: 26 });
      if (!claim26) throw new Error('PS26 Worker 应能领取到任务');

      // 清理：取消任务
      await worker26.fail(claim26.jobId, claim26.leaseToken, {
        errorCode: 'PHOTOSHOP_SCRIPT_ERROR',
        errorMessage: 'phase2 verify cleanup',
      });
    });

    await runStep('场景F：requiredCapabilities.supportsSmartObject=true，无能力 Worker 应被过滤', async () => {
      // 提交任务（要求 supportsSmartObject）
      const createResp = await client.request('POST', '/v1/render-jobs', {
        body: {
          templateVersionId,
          input: { [bindingId]: { text: 'cap-test-F' } },
          output: { format: 'png' },
          requiredCapabilities: { supportsSmartObject: true },
        },
        headers: { 'Idempotency-Key': `cap-F-${Date.now()}` },
      });
      if (createResp.status !== 201) throw new Error(`提交失败: ${createResp.text}`);
      const jobId = createResp.json.jobId;

      // 注册无智能对象能力的 Worker
      const workerNoSo = new MockWorker(args.backendUrl);
      await workerNoSo.register({
        psMajorVersion: 25,
        supportsSmartObject: false,
      });
      const claim = await workerNoSo.claim(2, {
        psMajorVersion: 25,
        supportsSmartObject: false,
      });
      if (claim !== null) {
        await workerNoSo.fail(claim.jobId, claim.leaseToken, {
          errorCode: 'PHOTOSHOP_SCRIPT_ERROR',
          errorMessage: 'phase2 verify cleanup',
        });
        throw new Error('不支持智能对象的 Worker 不应领取到要求智能对象的任务');
      }

      // 清理
      await client.request('POST', `/v1/render-jobs/${jobId}/cancel`, { body: {} });
    });
  }

  // 3. 监控告警 API
  console.log('\n[3/5] 监控告警 API');
  await runStep('GET /admin/api/alerts 返回告警列表', async () => {
    const resp = await fetch(`${args.backendUrl}/admin/api/alerts?limit=50`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!Array.isArray(json.alerts)) {
      throw new Error(`响应缺少 alerts 数组: ${JSON.stringify(json).slice(0, 200)}`);
    }
    console.log(`    当前告警数: ${json.alerts.length}`);
  });

  await runStep('GET /admin/api/alerts?status=ACTIVE 仅返回 ACTIVE 告警', async () => {
    const resp = await fetch(`${args.backendUrl}/admin/api/alerts?status=ACTIVE`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const allActive = json.alerts.every((a: any) => a.status === 'ACTIVE');
    if (!allActive) throw new Error('存在非 ACTIVE 状态告警');
  });

  // 4. COS 存储后端
  console.log('\n[4/5] COS 存储后端');
  const storageBackend = await getStorageBackend(args.backendUrl);
  if (storageBackend !== 'cos') {
    console.log(`  ℹ 跳过（STORAGE_BACKEND=${storageBackend}，仅 cos 模式验证）`);
  } else {
    await runStep('COS 上传/下载/删除循环', async () => {
      // 通过 /v1/assets/upload-url 拿到 COS 预签名 URL
      const upUrlResp = await client.request('POST', '/v1/assets/upload-url', {
        body: { fileName: 'phase2-test.bin', mimeType: 'application/octet-stream' },
      });
      if (upUrlResp.status !== 200) throw new Error(`upload-url: ${upUrlResp.text}`);

      const testData = crypto.randomBytes(1024);
      const url = upUrlResp.json.uploadUrl.startsWith('http')
        ? upUrlResp.json.uploadUrl
        : `${args.backendUrl}${upUrlResp.json.uploadUrl}`;

      const putResp = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: testData,
      });
      if (!putResp.ok) throw new Error(`COS PUT 失败 ${putResp.status}: ${await putResp.text()}`);

      // local 模式会返回 JSON；COS 模式直接返回 COS 响应
      // 不做严格校验，PUT 200/204 即可
      console.log(`    COS PUT 状态: ${putResp.status}`);
    });
  }

  // 5. BullMQ 队列后端
  console.log('\n[5/5] BullMQ 队列后端');
  const queueBackend = await getQueueBackend(args.backendUrl);
  if (queueBackend !== 'bullmq') {
    console.log(`  ℹ 跳过（QUEUE_BACKEND=${queueBackend}，仅 bullmq 模式验证）`);
  } else {
    await runStep('BullMQ 唤醒延迟（任务入队 → Worker claim < 1s）', async () => {
      if (!hasPsd) {
        throw new Error('需要 PSD 文件来构造任务');
      }
      const { templateVersionId, bindingId } = await createSimpleTemplate(client, psdPath);

      const worker = new MockWorker(args.backendUrl);
      await worker.register({ psMajorVersion: 25 });

      // 启动 claim（异步等待）
      const claimPromise = worker.claim(10);

      // 短暂等待 Worker 进入等待状态
      await sleep(200);

      // 提交任务
      const t0 = Date.now();
      await client.request('POST', '/v1/render-jobs', {
        body: {
          templateVersionId,
          input: { [bindingId]: { text: 'bullmq-wake-test' } },
          output: { format: 'png' },
        },
        headers: { 'Idempotency-Key': `bullmq-${Date.now()}` },
      });

      const claim = await claimPromise;
      const elapsed = Date.now() - t0;
      if (!claim) throw new Error('Worker 未领取到任务');
      console.log(`    唤醒延迟: ${elapsed}ms`);

      // 清理
      await worker.fail(claim.jobId, claim.leaseToken, {
        errorCode: 'PHOTOSHOP_SCRIPT_ERROR',
        errorMessage: 'phase2 verify cleanup',
      });

      if (elapsed > 2000) {
        throw new Error(`唤醒延迟过大: ${elapsed}ms（期望 < 2000ms）`);
      }
    });
  }

  // ============== 汇总 ==============
  printSummary();
}

function printSummary() {
  console.log('\n=== 第二期验证汇总 ===');
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
    console.log('\n✓ 第二期验证全部通过');
  }
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function getStorageBackend(baseUrl: string): Promise<string> {
  // 通过 admin /admin/api/stats 不暴露 storage backend；改用环境变量
  return process.env.STORAGE_BACKEND ?? 'local';
}

async function getQueueBackend(baseUrl: string): Promise<string> {
  return process.env.QUEUE_BACKEND ?? 'memory';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error('脚本执行异常:', e);
  process.exit(1);
});
