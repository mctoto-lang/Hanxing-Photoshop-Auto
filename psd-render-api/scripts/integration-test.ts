/**
 * PSD 渲染平台 - 集成测试脚本
 *
 * 测试范围：
 *   1. 基础端点（/health、/metrics、/docs）
 *   2. Admin 鉴权流程与 /admin/api/* 端点
 *   3. 外部 API 鉴权与 /v1/* 端点（assets/templates/render-jobs）
 *   4. Worker 注册与 /internal/* 端点
 *   5. 端到端渲染流程（提交任务 → Worker 领取 → 心跳 → 完成）
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.PSD_API_URL ?? 'http://localhost:3000';
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'ChangeMe!Secure2026';
const API_KEY = process.env.API_KEY ?? 'sk_live_poc_demo_2026';

// ============== 测试结果汇总 ==============
interface TestResult { name: string; passed: boolean; message: string; durationMs?: number; }
const results: TestResult[] = [];

function record(name: string, passed: boolean, message: string, durationMs?: number) {
  results.push({ name, passed, message, durationMs });
  const tag = passed ? '✓ PASS' : '✗ FAIL';
  const dur = durationMs !== undefined ? ` [${durationMs}ms]` : '';
  console.log(`  ${tag} ${name}${dur} — ${message}`);
}

async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try { await fn(); record(name, true, 'OK', Date.now() - t0); }
  catch (e) { record(name, false, (e as Error).message ?? String(e), Date.now() - t0); }
}

// ============== HTTP 工具 ==============
async function request(method: string, url: string, opts: {
  body?: unknown; headers?: Record<string, string>; rawBody?: Buffer; timeoutMs?: number;
} = {}): Promise<{ status: number; json: any; text: string; headers: Record<string, string> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let body: BodyInit | undefined;
    if (opts.rawBody !== undefined) body = opts.rawBody;
    else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
    const resp = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await resp.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => { respHeaders[k] = v; });
    return { status: resp.status, json, text, headers: respHeaders };
  } finally { clearTimeout(timer); }
}

function extractCookieToken(setCookie: string): string | null {
  const match = setCookie.match(/admin_session=([^;]+)/);
  return match ? match[1] : null;
}

// ============== 主流程 ==============
async function main() {
  console.log('\n=== PSD 渲染平台 集成测试 ===');
  console.log(`后端: ${BASE_URL}`);
  console.log('');

  // ========== 1. 基础端点 ==========
  console.log('[1/5] 基础端点（无鉴权）');
  await runStep('GET /health', async () => {
    const r = await request('GET', `${BASE_URL}/health`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (r.json.status !== 'ok') throw new Error(`status=${r.json.status}`);
    if (r.json.checks.database !== 'ok') throw new Error(`DB ${r.json.checks.database}`);
    if (r.json.checks.storage !== 'ok') throw new Error(`storage ${r.json.checks.storage}`);
    if (r.json.checks.queue !== 'ok') throw new Error(`queue ${r.json.checks.queue}`);
  });

  await runStep('GET /metrics', async () => {
    const r = await request('GET', `${BASE_URL}/metrics`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.text.includes('psd_http_requests_total')) throw new Error('缺少 psd_http_requests_total 指标');
    if (!r.text.includes('psd_process_uptime_seconds')) throw new Error('缺少 psd_process_uptime_seconds 指标');
  });

  await runStep('GET /docs/json (OpenAPI)', async () => {
    const r = await request('GET', `${BASE_URL}/docs/json`);
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    if (!r.json.openapi) throw new Error('响应非 OpenAPI 文档');
    if (!r.json.paths || Object.keys(r.json.paths).length === 0) throw new Error('无 API 路径');
    const pathCount = Object.keys(r.json.paths).length;
    console.log(`    API 路径数: ${pathCount}`);
  });

  // ========== 2. Admin 鉴权与 API ==========
  console.log('\n[2/5] Admin 鉴权流程与 /admin/api/* 端点');
  let adminToken: string | null = null;

  await runStep('POST /admin/api/login（正确凭据）', async () => {
    const r = await request('POST', `${BASE_URL}/admin/api/login`, {
      body: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!r.json.ok) throw new Error('响应缺少 ok=true');
    if (!r.json.user || r.json.user.username !== ADMIN_USER) throw new Error('用户信息不匹配');
    adminToken = extractCookieToken(r.headers['set-cookie'] ?? '');
    if (!adminToken) throw new Error('未收到 set-cookie admin_session');
  });

  await runStep('POST /admin/api/login（错误密码 → 401）', async () => {
    const r = await request('POST', `${BASE_URL}/admin/api/login`, {
      body: { username: ADMIN_USER, password: 'wrong-password-xxx' },
    });
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
    if (r.json.error !== 'UNAUTHORIZED') throw new Error(`期望 error=UNAUTHORIZED，实际 ${r.json.error}`);
  });

  await runStep('GET /admin/api/me（Bearer token 鉴权）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/me`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (r.json.user.username !== ADMIN_USER) throw new Error('用户名不匹配');
    if (r.json.user.role !== 'admin') throw new Error(`角色 ${r.json.user.role}（期望 admin）`);
  });

  await runStep('GET /admin/api/me（无 token → 401）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/me`);
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
  });

  await runStep('GET /admin/api/stats（概览数据）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (typeof r.json.workers !== 'number') throw new Error('缺少 workers 字段');
    if (typeof r.json.templates !== 'number') throw new Error('缺少 templates 字段');
    if (!r.json.jobs || typeof r.json.jobs.total !== 'number') throw new Error('缺少 jobs.total 字段');
    console.log(`    workers=${r.json.workers}, templates=${r.json.templates}, jobs.total=${r.json.jobs.total}`);
  });

  await runStep('GET /admin/api/jobs（任务列表）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/jobs?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!Array.isArray(r.json.jobs)) throw new Error('响应缺少 jobs 数组');
    console.log(`    任务数: ${r.json.jobs.length}`);
  });

  await runStep('GET /admin/api/workers（Worker 列表）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/workers`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!Array.isArray(r.json.workers)) throw new Error('响应缺少 workers 数组');
    console.log(`    Worker 数: ${r.json.workers.length}`);
  });

  await runStep('GET /admin/api/templates（模板列表）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/templates`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!Array.isArray(r.json.templates)) throw new Error('响应缺少 templates 数组');
    console.log(`    模板数: ${r.json.templates.length}`);
  });

  await runStep('GET /admin/api/alerts（告警列表）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/alerts?limit=50`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!Array.isArray(r.json.alerts)) throw new Error('响应缺少 alerts 数组');
    console.log(`    告警数: ${r.json.alerts.length}`);
  });

  await runStep('GET /admin/api/alerts/channels（告警渠道）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/alerts/channels`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!r.json.channels) throw new Error('响应缺少 channels 字段');
  });

  await runStep('GET /admin/api/admin-users（管理员列表）', async () => {
    const r = await request('GET', `${BASE_URL}/admin/api/admin-users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!Array.isArray(r.json.users)) throw new Error('响应缺少 users 数组');
    console.log(`    管理员数: ${r.json.users.length}`);
  });

  // ========== 3. 外部 API（/v1/*） ==========
  console.log('\n[3/5] 外部 API 鉴权与 /v1/* 端点');

  await runStep('GET /v1/templates（无 API Key → 401）', async () => {
    const r = await request('GET', `${BASE_URL}/v1/templates`);
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
  });

  await runStep('GET /v1/templates（正确 API Key）', async () => {
    const r = await request('GET', `${BASE_URL}/v1/templates`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!Array.isArray(r.json.templates)) throw new Error('响应缺少 templates 数组');
    console.log(`    模板数: ${r.json.templates.length}`);
  });

  await runStep('POST /v1/assets/upload-url（获取上传地址）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/assets/upload-url`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { fileName: 'test-image.png', mimeType: 'image/png', sizeBytes: 1024 },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!r.json.assetId || !r.json.assetId.startsWith('art_')) throw new Error(`assetId 格式错误: ${r.json.assetId}`);
    if (!r.json.uploadUrl) throw new Error('缺少 uploadUrl');
    if (!r.json.objectKey) throw new Error('缺少 objectKey');
    console.log(`    assetId: ${r.json.assetId}`);
  });

  await runStep('POST /v1/assets/upload-url（非法文件类型 → 400/422）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/assets/upload-url`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { fileName: 'test.exe', mimeType: 'application/octet-stream' },
    });
    if (r.status !== 400 && r.status !== 422) throw new Error(`期望 400/422，实际 ${r.status}`);
  });

  await runStep('POST /v1/assets/upload-url（非法文件名 → 400）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/assets/upload-url`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { fileName: '../etc/passwd.png', mimeType: 'image/png' },
    });
    if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}`);
  });

  await runStep('POST /v1/render-jobs（不存在的模板 → 422）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/render-jobs`, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Idempotency-Key': `test-${Date.now()}` },
      body: { templateVersionId: 'tpv_nonexistent', input: { test: { text: 'hello' } } },
    });
    if (r.status !== 422 && r.status !== 404 && r.status !== 400) {
      throw new Error(`期望 422/404/400，实际 ${r.status}: ${r.text}`);
    }
  });

  await runStep('POST /v1/render-jobs（参数校验失败 → 400）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/render-jobs`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { templateVersionId: '', input: {} },
    });
    if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}`);
  });

  await runStep('GET /v1/render-jobs/job_notexist（查询不存在任务 → 404）', async () => {
    const r = await request('GET', `${BASE_URL}/v1/render-jobs/job_notexist`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (r.status !== 404) throw new Error(`期望 404，实际 ${r.status}`);
  });

  // P1-29 修复：补充关键端点测试覆盖
  await runStep('POST /v1/assets/upload-url + PUT + POST /v1/assets/:id/complete（资产确认端到端）', async () => {
    // 1. 获取上传地址
    const upResp = await request('POST', `${BASE_URL}/v1/assets/upload-url`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { fileName: 'test-asset.png', mimeType: 'image/png', sizeBytes: 100 },
    });
    if (upResp.status !== 200) throw new Error(`upload-url 失败: ${upResp.status}`);
    const { assetId, uploadUrl, objectKey } = upResp.json;

    // 2. PUT 文件到存储
    const mockData = Buffer.alloc(100, 0x42);
    const putResp = await request('PUT', uploadUrl, { body: mockData, headers: { 'Content-Type': 'image/png' } });
    if (putResp.status !== 200 && putResp.status !== 204) {
      throw new Error(`PUT 上传失败: ${putResp.status}`);
    }

    // 3. 调用 complete 确认资产
    const completeResp = await request('POST', `${BASE_URL}/v1/assets/${assetId}/complete`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { objectKey, sha256: crypto.createHash('sha256').update(mockData).digest('hex') },
    });
    if (completeResp.status !== 200) throw new Error(`complete 失败: ${completeResp.status}: ${completeResp.text}`);
    if (!completeResp.json.ok) throw new Error('complete 响应缺少 ok=true');
    console.log(`    assetId: ${assetId}, complete: ok`);
  });

  await runStep('POST /v1/assets/nonexistent/complete（不存在资产 → 404）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/assets/art_nonexistent/complete`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { objectKey: 'test', sha256: crypto.createHash('sha256').update('test').digest('hex') },
    });
    if (r.status !== 404 && r.status !== 422) throw new Error(`期望 404/422，实际 ${r.status}`);
  });

  await runStep('GET /v1/templates/:templateId（模板详情）', async () => {
    const listResp = await request('GET', `${BASE_URL}/v1/templates`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (listResp.json.templates.length === 0) {
      console.log('    跳过（无模板）');
      return;
    }
    const templateId = listResp.json.templates[0].templateId;
    const r = await request('GET', `${BASE_URL}/v1/templates/${templateId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (r.status !== 200) throw new Error(`期望 200，实际 ${r.status}`);
    if (!r.json.templateId) throw new Error('响应缺少 templateId');
    if (!r.json.latestVersion) throw new Error('响应缺少 latestVersion');
    console.log(`    templateId: ${templateId}`);
  });

  await runStep('POST /v1/render-jobs/:jobId/cancel（取消不存在的任务 → 404）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/render-jobs/job_cancel_test/cancel`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { reason: 'test' },
    });
    if (r.status !== 404 && r.status !== 422) throw new Error(`期望 404/422，实际 ${r.status}`);
  });

  await runStep('GET /internal/jobs/:jobId/cancel-check（取消信号检查 → 401 无 token）', async () => {
    const r = await request('GET', `${BASE_URL}/internal/jobs/job_test/cancel-check`);
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
  });

  await runStep('POST /v1/render-jobs（缺少 Idempotency-Key → 400）', async () => {
    const r = await request('POST', `${BASE_URL}/v1/render-jobs`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: { templateVersionId: 'tpv_test', input: { test: { text: 'hello' } } },
    });
    if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}`);
  });

  // ========== 4. Worker 注册与内部接口 ==========
  console.log('\n[4/5] Worker 注册与 /internal/* 端点');
  let workerToken: string | null = null;
  const workerFingerprint = `test-${Date.now()}-${Math.random()}`;

  await runStep('POST /internal/workers/register（注册 Worker）', async () => {
    const r = await request('POST', `${BASE_URL}/internal/workers/register`, {
      body: {
        machineFingerprint: workerFingerprint,
        psVersion: '25.0',
        psMajorVersion: 25,
        os: 'windows',
        supportsSmartObject: true,
        supportsTextLayer: true,
        fonts: [],
      },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!r.json.accessToken) throw new Error('缺少 accessToken');
    if (!r.json.workerId) throw new Error('缺少 workerId');
    workerToken = r.json.accessToken;
    console.log(`    workerId: ${r.json.workerId}`);
  });

  await runStep('POST /internal/workers/register（参数校验失败 → 400）', async () => {
    const r = await request('POST', `${BASE_URL}/internal/workers/register`, {
      body: { machineFingerprint: '', psVersion: '', psMajorVersion: 0, os: 'linux' },
    });
    if (r.status !== 400) throw new Error(`期望 400，实际 ${r.status}`);
  });

  await runStep('POST /internal/workers/claim（无任务 → 202）', async () => {
    const r = await request('POST', `${BASE_URL}/internal/workers/claim`, {
      headers: { Authorization: `Bearer ${workerToken}` },
      body: { maxWaitSeconds: 2 },
    });
    if (r.status !== 202) throw new Error(`期望 202，实际 ${r.status}: ${r.text}`);
    if (r.json.jobId !== null) throw new Error('期望 jobId=null');
  });

  await runStep('POST /internal/workers/claim（无 token → 401）', async () => {
    const r = await request('POST', `${BASE_URL}/internal/workers/claim`, {
      body: { maxWaitSeconds: 1 },
    });
    if (r.status !== 401) throw new Error(`期望 401，实际 ${r.status}`);
  });

  await runStep('POST /internal/workers/heartbeat（Worker 心跳）', async () => {
    const r = await request('POST', `${BASE_URL}/internal/workers/heartbeat`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!r.json.ok) throw new Error('缺少 ok=true');
    if (!r.json.serverTime) throw new Error('缺少 serverTime');
  });

  await runStep('POST /internal/workers/refresh-token（刷新令牌）', async () => {
    const r = await request('POST', `${BASE_URL}/internal/workers/refresh-token`, {
      headers: { Authorization: `Bearer ${workerToken}` },
    });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}: ${r.text}`);
    if (!r.json.accessToken) throw new Error('缺少 accessToken');
    workerToken = r.json.accessToken;
  });

  // ========== 5. 端到端渲染流程 ==========
  console.log('\n[5/5] 端到端渲染流程（使用已发布模板）');

  // 通过 Admin API 查找已发布的模板
  let publishedTemplateVersionId: string | null = null;
  let publishedBindings: any[] = [];
  try {
    const loginResp = await request('POST', `${BASE_URL}/admin/api/login`, {
      body: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    const cookie = loginResp.headers['set-cookie'] ?? '';
    const adminToken2 = extractCookieToken(cookie);

    const tlResp = await request('GET', `${BASE_URL}/admin/api/templates`, {
      headers: { Authorization: `Bearer ${adminToken2}` },
    });
    const published = tlResp.json.templates.find((t: any) => t.published && t.status === 'PUBLISHED');
    if (published) {
      // 获取模板详情以拿到 versionId (CUID) 和 bindings
      const tdResp = await request('GET', `${BASE_URL}/v1/templates/${published.templateId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (tdResp.status === 200 && tdResp.json.latestVersion) {
        publishedTemplateVersionId = tdResp.json.latestVersion.versionId;
        const schema = tdResp.json.latestVersion.layerSchema;
        if (schema && schema.bindings) {
          publishedBindings = schema.bindings;
        }
      }
    }
  } catch { /* ignore */ }

  if (!publishedTemplateVersionId) {
    console.log('  ℹ 未找到已发布模板，跳过端到端渲染流程测试');
  } else {
    await runStep('端到端：上传资产 → 提交任务 → Worker领取 → 心跳 → 完成', async () => {
      console.log(`    使用模板版本: ${publishedTemplateVersionId}, 绑定数: ${publishedBindings.length}`);

      // 1. 为每个 smartObject 绑定上传一个测试图片资产
      const input: Record<string, { assetId: string }> = {};
      let assetIdx = 0;
      for (const b of publishedBindings) {
        if (b.type === 'smartObject') {
          assetIdx++;
          // 获取上传地址（文件名仅允许 ASCII 字母/数字/._-，使用索引避免中文 bindingId）
          const upUrlResp = await request('POST', `${BASE_URL}/v1/assets/upload-url`, {
            headers: { Authorization: `Bearer ${API_KEY}` },
            body: { fileName: `e2e-test-${assetIdx}.png`, mimeType: 'image/png', sizeBytes: 1024 },
          });
          if (upUrlResp.status !== 200) throw new Error(`获取上传地址失败 (${b.bindingId}): ${upUrlResp.text}`);

          // 上传一个小的 mock PNG (1x1 红色像素)
          const pngData = Buffer.from([
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xDE,
            0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01,
            0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
          ]);
          const uploadUrl = upUrlResp.json.uploadUrl.startsWith('http')
            ? upUrlResp.json.uploadUrl : `${BASE_URL}${upUrlResp.json.uploadUrl}`;
          const putResp = await request('PUT', uploadUrl, { rawBody: pngData, headers: { 'Content-Type': 'image/png' } });
          if (putResp.status !== 200 && putResp.status !== 204) throw new Error(`资产上传失败 (${b.bindingId}): ${putResp.status}`);

          input[b.bindingId] = { assetId: upUrlResp.json.assetId };
        }
      }
      console.log(`    已上传 ${Object.keys(input).length} 个资产`);

      // 2. 提交渲染任务（要求 psMajorVersion=99，隔离外部 Worker 抢占：
      //    claim 端点默认 psMajorVersion=25，外部 Worker 无法匹配 99）
      const jobResp = await request('POST', `${BASE_URL}/v1/render-jobs`, {
        headers: { Authorization: `Bearer ${API_KEY}`, 'Idempotency-Key': `e2e-${Date.now()}` },
        body: {
          templateVersionId: publishedTemplateVersionId,
          input,
          output: { format: 'png' },
          requiredCapabilities: { psMajorVersion: 99 },
        },
      });
      if (jobResp.status !== 201) throw new Error(`提交任务失败: ${jobResp.text}`);
      const jobId = jobResp.json.jobId;
      console.log(`    任务已提交: ${jobId}`);

      // 3. Worker 领取任务（上报 psMajorVersion=99 匹配任务要求）
      const claimResp = await request('POST', `${BASE_URL}/internal/workers/claim`, {
        headers: { Authorization: `Bearer ${workerToken}` },
        body: { maxWaitSeconds: 5, psMajorVersion: 99 },
      });
      if (claimResp.status !== 200) throw new Error(`claim 失败: ${claimResp.text}`);
      if (!claimResp.json.jobId) throw new Error('Worker 未领取到任务');
      console.log(`    Worker 已领取: ${claimResp.json.jobId}`);

      // 4. 心跳
      await request('POST', `${BASE_URL}/internal/jobs/${claimResp.json.jobId}/heartbeat`, {
        headers: { Authorization: `Bearer ${workerToken}` },
        body: { leaseToken: claimResp.json.leaseToken, stage: 'RUN_JSX', progress: 50 },
      });

      // 5. 上传结果文件并完成任务
      const mockResult = Buffer.from('mock e2e result');
      const resultUploadUrl = claimResp.json.manifest.resultUploadUrl.startsWith('http')
        ? claimResp.json.manifest.resultUploadUrl : `${BASE_URL}${claimResp.json.manifest.resultUploadUrl}`;
      const upMeta = await request('PUT', resultUploadUrl, { rawBody: mockResult, headers: { 'Content-Type': 'image/png' } });
      if (upMeta.status !== 200 && upMeta.status !== 204) throw new Error(`结果上传失败 ${upMeta.status}`);

      const completeResp = await request('POST', `${BASE_URL}/internal/jobs/${claimResp.json.jobId}/complete`, {
        headers: { Authorization: `Bearer ${workerToken}` },
        body: {
          leaseToken: claimResp.json.leaseToken,
          resultObjectKey: claimResp.json.manifest.resultObjectKey,
          resultSha256: upMeta.json?.sha256 ?? crypto.createHash('sha256').update(mockResult).digest('hex'),
          resultMimeType: 'image/png',
          resultSize: upMeta.json?.size ?? mockResult.length,
        },
      });
      if (completeResp.status !== 200) throw new Error(`complete 失败: ${completeResp.text}`);

      // 6. 查询任务状态
      const getResp = await request('GET', `${BASE_URL}/v1/render-jobs/${jobId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (getResp.json.status !== 'SUCCEEDED') throw new Error(`期望 SUCCEEDED，实际 ${getResp.json.status}`);
      console.log(`    任务完成: ${jobId}`);
    });
  }

  // ========== 汇总 ==========
  printSummary();
}

function printSummary() {
  console.log('\n=== 集成测试汇总 ===');
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
    console.log('\n✓ 集成测试全部通过');
  }
}

main().catch((e) => { console.error('脚本执行异常:', e); process.exit(1); });
