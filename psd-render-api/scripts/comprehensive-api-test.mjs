/**
 * 全面 API 功能测试脚本
 * 覆盖所有主要 API 端点：健康检查、Admin 鉴权、API Key、模板、资产、渲染任务、审计、Webhook、Worker
 *
 * 运行方式：node scripts/comprehensive-api-test.mjs
 *
 * 输出：每个测试用例的 PASS/FAIL + 详细响应，最后给出汇总报告
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const __dirname = dirname(fileURLToPath(import.meta.url));

// 测试结果收集
const results = [];
let passCount = 0;
let failCount = 0;
let skipCount = 0;

function record(name, passed, detail = '', extra = null) {
  // 将 truthy/falsy 值规范化为 true/false/null
  if (passed !== null && passed !== undefined) {
    passed = !!passed;
  }
  results.push({ name, passed, detail, extra });
  if (passed === true) passCount++;
  else if (passed === false) failCount++;
  else skipCount++;
  const tag = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'SKIP';
  console.log(`[${tag}] ${name}`);
  if (detail) console.log(`       ${detail}`);
  if (extra) console.log(`       ${JSON.stringify(extra).slice(0, 500)}`);
  console.log('');
}

/**
 * 通用 HTTP 请求
 * @param {string} method
 * @param {string} path
 * @param {object} opts { headers, body, json, raw, timeoutMs }
 * @returns {Promise<{status:number, headers:object, body:any, text:string}>}
 */
async function req(method, path, opts = {}) {
  const url = new URL(path, BASE);
  const headers = { ...opts.headers };
  let body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.raw !== undefined) {
    body = opts.raw;
  } else if (opts.body !== undefined) {
    body = opts.body;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed, text };
  } finally {
    clearTimeout(timer);
  }
}

// 从 set-cookie 头提取 cookie 值
function extractCookie(setCookie, name) {
  if (!setCookie) return null;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of cookies) {
    const m = c.match(new RegExp(`${name}=([^;]+)`));
    if (m) return m[1];
  }
  return null;
}

// ===== 全局状态（在测试用例间共享） =====
const state = {
  adminCookie: null,
  adminToken: null,
  apiKeyPlain: null,
  apiKeyId: null,
  templateId: null,
  templateVersionId: null,
  assetId: null,
  assetObjectKey: null,
  uploadToken: null,
  jobId: null,
  workerToken: null,
  workerId: null,
  auditLogId: null,
  webhookLogId: null,
};

// ===== 测试用例 =====

async function testHealthAndMetrics() {
  console.log('\n========== 1. 健康检查与可观测性 ==========\n');

  // 综合健康检查
  let r = await req('GET', '/health');
  record('GET /health 综合健康检查', r.status === 200 && r.body.status === 'ok',
    `status=${r.status}`, r.body);

  // 存活探针
  r = await req('GET', '/health/live');
  record('GET /health/live 存活探针', r.status === 200 && r.body.status === 'alive',
    `status=${r.status}`, r.body);

  // 就绪探针
  r = await req('GET', '/health/ready');
  record('GET /health/ready 就绪探针', r.status === 200 && r.body.status === 'ready',
    `status=${r.status}`, r.body);

  // Metrics
  r = await req('GET', '/metrics');
  const hasMetrics = r.status === 200 && r.text.includes('psd_http_requests_total');
  record('GET /metrics Prometheus 指标', hasMetrics,
    `status=${r.status}, length=${r.text.length}`, r.text.slice(0, 200));

  // Trace ID 透传
  r = await req('GET', '/health/live', { headers: { 'X-Trace-Id': 'my-trace-abc-123' } });
  record('X-Trace-Id 透传', r.headers['x-trace-id'] === 'my-trace-abc-123',
    `trace-id=${r.headers['x-trace-id']}`);

  // 404 处理（不泄露 URL）
  r = await req('GET', '/nonexistent-path-xyz');
  record('GET /nonexistent 404 不泄露 URL', r.status === 404 && !r.text.includes('nonexistent'),
    `status=${r.status}`, r.body);

  // Swagger 文档
  r = await req('GET', '/docs/json');
  record('GET /docs/json OpenAPI 规范', r.status === 200 && r.body?.openapi,
    `status=${r.status}, openapi=${r.body?.openapi}`);
}

async function testAdminAuth() {
  console.log('\n========== 2. Admin 鉴权 ==========\n');

  // 错误密码
  let r = await req('POST', '/admin/api/login', { json: { username: 'admin', password: 'wrongpassword' } });
  record('登录 - 错误密码返回 401', r.status === 401,
    `status=${r.status}`, r.body);

  // 不存在的用户
  r = await req('POST', '/admin/api/login', { json: { username: 'nouser', password: 'whatever' } });
  record('登录 - 不存在的用户返回 401', r.status === 401,
    `status=${r.status}`, r.body);

  // 缺少字段
  r = await req('POST', '/admin/api/login', { json: { username: 'admin' } });
  record('登录 - 缺少 password 字段返回 400', r.status === 400,
    `status=${r.status}`, r.body);

  // 正确登录
  r = await req('POST', '/admin/api/login', { json: { username: 'admin', password: 'DevAdmin!Secure2026' } });
  state.adminCookie = extractCookie(r.headers['set-cookie'], 'admin_session');
  state.adminToken = state.adminCookie;
  record('登录 - 正确凭据返回 200', r.status === 200 && r.body?.ok && state.adminCookie,
    `status=${r.status}, user=${r.body?.user?.username}, role=${r.body?.user?.role}`, r.body);

  // 未带 token 访问受保护接口
  r = await req('GET', '/admin/api/me');
  record('未鉴权访问 /admin/api/me 返回 401', r.status === 401,
    `status=${r.status}`, r.body);

  // 用 cookie 访问当前用户
  r = await req('GET', '/admin/api/me', { headers: { Cookie: `admin_session=${state.adminCookie}` } });
  record('GET /admin/api/me (cookie 鉴权)', r.status === 200 && r.body?.user?.username === 'admin',
    `status=${r.status}`, r.body);

  // 用 Bearer token 访问当前用户
  r = await req('GET', '/admin/api/me', { headers: { Authorization: `Bearer ${state.adminToken}` } });
  record('GET /admin/api/me (Bearer 鉴权)', r.status === 200 && r.body?.user?.username === 'admin',
    `status=${r.status}`, r.body);

  // 查询管理员用户列表
  r = await req('GET', '/admin/api/admin-users', { headers: { Authorization: `Bearer ${state.adminToken}` } });
  record('GET /admin/api/admin-users 用户列表', r.status === 200 && Array.isArray(r.body?.users),
    `status=${r.status}, count=${r.body?.users?.length}`);

  // 创建一个 operator 用户（密码需 ≥12 位，3 类字符）
  const opPassword = 'Operator!Pass2026';
  r = await req('POST', '/admin/api/admin-users', {
    headers: { Authorization: `Bearer ${state.adminToken}` },
    json: { username: 'tester_op_' + Date.now(), password: opPassword, role: 'operator' },
  });
  const opUserId = r.body?.user?.id;
  record('POST /admin/api/admin-users 创建 operator', r.status === 201 && opUserId,
    `status=${r.status}, userId=${opUserId}`, r.body);

  // 弱密码应被拒绝
  r = await req('POST', '/admin/api/admin-users', {
    headers: { Authorization: `Bearer ${state.adminToken}` },
    json: { username: 'weakpw_user', password: '123', role: 'viewer' },
  });
  record('创建用户 - 弱密码应拒绝', r.status === 400,
    `status=${r.status}`, r.body);

  // 禁用用户
  if (opUserId) {
    r = await req('POST', `/admin/api/admin-users/${opUserId}/disable`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
    });
    record('POST /admin/api/admin-users/:id/disable 禁用用户', r.status === 200 && r.body?.ok,
      `status=${r.status}`, r.body);

    // 启用用户
    r = await req('POST', `/admin/api/admin-users/${opUserId}/enable`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
    });
    record('POST /admin/api/admin-users/:id/enable 启用用户', r.status === 200 && r.body?.ok,
      `status=${r.status}`, r.body);

    // 修改角色
    r = await req('POST', `/admin/api/admin-users/${opUserId}/role`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
      json: { role: 'viewer' },
    });
    record('POST /admin/api/admin-users/:id/role 修改角色', r.status === 200 && r.body?.ok,
      `status=${r.status}`, r.body);
  }

  // 修改自己的密码 - 当前密码错误
  r = await req('POST', '/admin/api/me/password', {
    headers: { Authorization: `Bearer ${state.adminToken}` },
    json: { currentPassword: 'wrongcurrent', newPassword: 'NewPassword!2026' },
  });
  record('修改自己密码 - 当前密码错误返回 401', r.status === 401,
    `status=${r.status}`, r.body);

  // 修改自己的密码 - 新密码不合规
  r = await req('POST', '/admin/api/me/password', {
    headers: { Authorization: `Bearer ${state.adminToken}` },
    json: { currentPassword: 'DevAdmin!Secure2026', newPassword: 'short' },
  });
  record('修改自己密码 - 弱新密码返回 400', r.status === 400,
    `status=${r.status}`, r.body);
}

async function testAdminStats() {
  console.log('\n========== 3. Admin 概览数据 ==========\n');
  const auth = { Authorization: `Bearer ${state.adminToken}` };

  let r = await req('GET', '/admin/api/stats', { headers: auth });
  record('GET /admin/api/stats 概览统计', r.status === 200 && r.body?.jobs,
    `status=${r.status}, workers=${r.body?.workers}, jobs=${JSON.stringify(r.body?.jobs)}`, r.body);

  r = await req('GET', '/admin/api/jobs?limit=5', { headers: auth });
  record('GET /admin/api/jobs 任务列表', r.status === 200 && Array.isArray(r.body?.jobs),
    `status=${r.status}, count=${r.body?.jobs?.length}`);

  r = await req('GET', '/admin/api/workers', { headers: auth });
  record('GET /admin/api/workers Worker 列表', r.status === 200 && Array.isArray(r.body?.workers),
    `status=${r.status}, count=${r.body?.workers?.length}`);

  r = await req('GET', '/admin/api/templates', { headers: auth });
  record('GET /admin/api/templates 模板列表', r.status === 200 && Array.isArray(r.body?.templates),
    `status=${r.status}, count=${r.body?.templates?.length}`);

  r = await req('GET', '/admin/api/alerts', { headers: auth });
  record('GET /admin/api/alerts 告警列表', r.status === 200 && Array.isArray(r.body?.alerts),
    `status=${r.status}, count=${r.body?.alerts?.length}`);

  r = await req('GET', '/admin/api/alerts/channels', { headers: auth });
  record('GET /admin/api/alerts/channels 告警渠道', r.status === 200 && r.body?.channels,
    `status=${r.status}`, r.body);
}

async function testApiKeyManagement() {
  console.log('\n========== 4. API Key 管理 ==========\n');
  const auth = { Authorization: `Bearer ${state.adminToken}` };

  // 列表
  let r = await req('GET', '/admin/api/api-keys', { headers: auth });
  record('GET /admin/api/api-keys 列表', r.status === 200 && Array.isArray(r.body?.apiKeys),
    `status=${r.status}, count=${r.body?.apiKeys?.length}`);

  // 创建
  const keyName = 'test_key_' + Date.now();
  r = await req('POST', '/admin/api/api-keys', {
    headers: auth,
    json: {
      name: keyName,
      tenantId: 'test-tenant',
      priority: 5,
      rateLimitPerMin: 100,
      quotaPerDay: 1000,
      scopes: ['render:write', 'template:read'],
    },
  });
  state.apiKeyPlain = r.body?.plaintextKey;
  state.apiKeyId = r.body?.apiKey?.id;
  record('POST /admin/api/api-keys 创建', r.status === 201 && state.apiKeyPlain && state.apiKeyId,
    `status=${r.status}, id=${state.apiKeyId}, prefix=${r.body?.apiKey?.keyPrefix}`, r.body);

  // 详情
  if (state.apiKeyId) {
    r = await req('GET', `/admin/api/api-keys/${state.apiKeyId}`, { headers: auth });
    record('GET /admin/api/api-keys/:id 详情', r.status === 200 && r.body?.apiKey?.id === state.apiKeyId,
      `status=${r.status}`, r.body);

    // 更新
    r = await req('PUT', `/admin/api/api-keys/${state.apiKeyId}`, {
      headers: auth,
      json: { name: keyName + '_updated', priority: 3 },
    });
    record('PUT /admin/api/api-keys/:id 更新', r.status === 200 && r.body?.apiKey?.name?.includes('_updated'),
      `status=${r.status}`, r.body);

    // 重置配额
    r = await req('POST', `/admin/api/api-keys/${state.apiKeyId}/reset-quota`, { headers: auth });
    record('POST /admin/api/api-keys/:id/reset-quota 重置配额', r.status === 200,
      `status=${r.status}`, r.body);

    // 禁用
    r = await req('POST', `/admin/api/api-keys/${state.apiKeyId}/disable`, { headers: auth });
    record('POST /admin/api/api-keys/:id/disable 禁用', r.status === 200 && r.body?.apiKey?.active === false,
      `status=${r.status}`, r.body);

    // 启用
    r = await req('POST', `/admin/api/api-keys/${state.apiKeyId}/enable`, { headers: auth });
    record('POST /admin/api/api-keys/:id/enable 启用', r.status === 200 && r.body?.apiKey?.active === true,
      `status=${r.status}`, r.body);

    // 轮换
    r = await req('POST', `/admin/api/api-keys/${state.apiKeyId}/rotate`, { headers: auth });
    record('POST /admin/api/api-keys/:id/rotate 轮换', r.status === 200 && r.body?.plaintextKey,
      `status=${r.status}, newPrefix=${r.body?.apiKey?.keyPrefix}`);
    if (r.body?.plaintextKey) state.apiKeyPlain = r.body.plaintextKey;
  }

  // 验证新 API Key 可用
  if (state.apiKeyPlain) {
    r = await req('GET', '/v1/templates', { headers: { Authorization: `Bearer ${state.apiKeyPlain}` } });
    record('使用新 API Key 访问 /v1/templates', r.status === 200,
      `status=${r.status}`, r.body);
  }

  // 无 API Key 访问受保护接口
  r = await req('GET', '/v1/templates');
  record('无 API Key 访问 /v1/templates 返回 401', r.status === 401,
    `status=${r.status}`, r.body);

  // 错误 API Key
  r = await req('GET', '/v1/templates', { headers: { Authorization: 'Bearer sk_live_invalid_xxx' } });
  record('错误 API Key 返回 401', r.status === 401,
    `status=${r.status}`, r.body);
}

async function testTemplateManagement() {
  console.log('\n========== 5. 模板管理 ==========\n');
  if (!state.apiKeyPlain) {
    record('模板管理测试 - 跳过（无 API Key）', null);
    return;
  }
  const auth = { Authorization: `Bearer ${state.apiKeyPlain}` };

  // 获取 PSD 上传地址
  let r = await req('POST', '/v1/templates/upload-url', {
    headers: auth,
    json: { fileName: 'test-template.psd' },
  });
  record('POST /v1/templates/upload-url 获取 PSD 上传地址', r.status === 200 && r.body?.uploadUrl,
    `status=${r.status}, objectKey=${r.body?.objectKey}`, r.body);

  if (!r.body?.objectKey) return;
  const psdObjectKey = r.body.objectKey;

  // 上传 PSD 文件：检测是 local 模式还是 COS 模式
  // - local 模式：uploadUrl 为 /storage/upload?key=xxx&token=yyy，走本机端点
  // - COS 模式：uploadUrl 为 https://xxx.cos... 预签名 URL，直接 PUT 到 COS
  const uploadUrl = r.body.uploadUrl;
  const isLocalMode = uploadUrl.startsWith('/storage/upload') || uploadUrl.includes('/storage/upload');

  // 读取测试 PSD 文件
  let psdBuffer;
  try {
    psdBuffer = readFileSync(join(__dirname, 'fixtures', 'mock_result.png'));
  } catch {
    psdBuffer = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
  }

  let psdUploaded = false;
  if (isLocalMode) {
    const localUrl = new URL(uploadUrl, BASE);
    const uploadKey = localUrl.searchParams.get('key');
    const uploadToken = localUrl.searchParams.get('token');
    r = await req('PUT', `/storage/upload?key=${encodeURIComponent(uploadKey)}&token=${encodeURIComponent(uploadToken)}`, {
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${uploadToken}` },
      raw: psdBuffer,
    });
    psdUploaded = r.status === 200;
    record('PUT /storage/upload 上传 PSD (local)', psdUploaded,
      `status=${r.status}`, r.body);
  } else {
    // COS 模式：直接 PUT 到预签名 URL
    try {
      const cosRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': r.body.headers?.['Content-Type'] || 'application/octet-stream' },
        body: psdBuffer,
      });
      psdUploaded = cosRes.status === 200;
      record('PUT <cos-presigned> 上传 PSD (COS)', psdUploaded,
        `status=${cosRes.status}`);
    } catch (e) {
      record('PUT <cos-presigned> 上传 PSD (COS)', false, `error=${e.message}`);
    }
  }

  // 创建模板（触发 PSD 解析）
  // 注意：测试上传的是 PNG 占位文件而非真实 PSD，PSD 解析会失败
  //   - 200/201：解析成功（理想情况，真实 PSD 文件）
  //   - 422：PSD 格式无效（业务错误，符合预期；非 PSD 文件应返回此码而非 500）
  if (psdUploaded) {
    r = await req('POST', '/v1/templates', {
      headers: auth,
      json: { objectKey: psdObjectKey, name: 'Test Template ' + Date.now() },
    });
    state.templateId = r.body?.templateId;
    state.templateVersionId = r.body?.versionId || r.body?.templateVersionId;
    const accepted = r.status === 200 || r.status === 201 || r.status === 422;
    record('POST /v1/templates 创建模板（PNG 占位，PSD 解析预期失败）', accepted,
      `status=${r.status}, templateId=${state.templateId}`, r.body);
  } else {
    record('POST /v1/templates 创建模板 - 跳过（PSD 未上传）', null);
  }

  // 模板列表
  r = await req('GET', '/v1/templates', { headers: auth });
  record('GET /v1/templates 模板列表', r.status === 200 && Array.isArray(r.body?.templates),
    `status=${r.status}, count=${r.body?.templates?.length}`);

  // 模板详情（使用现有模板 ID 或上面创建的）
  if (state.templateId) {
    r = await req('GET', `/v1/templates/${state.templateId}`, { headers: auth });
    record('GET /v1/templates/:id 详情', r.status === 200,
      `status=${r.status}`, r.body);
  }

  // 保存图层绑定（如果模板存在）
  if (state.templateId) {
    r = await req('PUT', `/v1/templates/${state.templateId}/layer-bindings`, {
      headers: auth,
      json: {
        bindings: [
          {
            bindingId: 'bg_layer',
            layerId: 1,
            layerPath: '/Background',
            type: 'pixel',
            required: false,
            fit: 'stretch',
          },
        ],
      },
    });
    record('PUT /v1/templates/:id/layer-bindings 保存绑定', r.status === 200 && r.body?.ok,
      `status=${r.status}`, r.body);
  }
}

async function testAssetUpload() {
  console.log('\n========== 6. 资产上传 ==========\n');
  if (!state.apiKeyPlain) {
    record('资产上传测试 - 跳过', null);
    return;
  }
  const auth = { Authorization: `Bearer ${state.apiKeyPlain}` };

  // 正常请求上传地址
  let r = await req('POST', '/v1/assets/upload-url', {
    headers: auth,
    json: { fileName: 'test-input.png', mimeType: 'image/png', sizeBytes: 1024 },
  });
  state.assetId = r.body?.assetId;
  record('POST /v1/assets/upload-url PNG', r.status === 200 && r.body?.assetId,
    `status=${r.status}, assetId=${state.assetId}`, r.body);

  // 上传图片到 storage：检测 local / COS 模式
  if (r.body?.uploadUrl) {
    const upUrl = r.body.uploadUrl;
    const isLocalAsset = upUrl.startsWith('/storage/upload') || upUrl.includes('/storage/upload');
    // 创建一个 1x1 PNG
    const pngBuf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    if (isLocalAsset) {
      const localUrl = new URL(upUrl, BASE);
      const upKey = localUrl.searchParams.get('key');
      const upToken = localUrl.searchParams.get('token');
      r = await req('PUT', `/storage/upload?key=${encodeURIComponent(upKey)}&token=${encodeURIComponent(upToken)}`, {
        headers: { 'Content-Type': 'image/png', Authorization: `Bearer ${upToken}` },
        raw: pngBuf,
      });
      record('PUT /storage/upload 上传 PNG (local)', r.status === 200 && r.body?.sha256,
        `status=${r.status}, sha256=${r.body?.sha256?.slice(0, 16)}`, r.body);
    } else {
      // COS 模式：直接 PUT 到预签名 URL
      try {
        const cosRes = await fetch(upUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/png' },
          body: pngBuf,
        });
        record('PUT <cos-presigned> 上传 PNG (COS)', cosRes.status === 200,
          `status=${cosRes.status}`);
      } catch (e) {
        record('PUT <cos-presigned> 上传 PNG (COS)', false, `error=${e.message}`);
      }
    }
  }

  // 不支持的文件类型
  r = await req('POST', '/v1/assets/upload-url', {
    headers: auth,
    json: { fileName: 'test.gif', mimeType: 'image/gif' },
  });
  record('上传 - 不支持的 GIF 类型拒绝', r.status === 400 || r.status === 422,
    `status=${r.status}`, r.body);

  // 不安全的文件名（路径遍历）
  r = await req('POST', '/v1/assets/upload-url', {
    headers: auth,
    json: { fileName: '../etc/passwd' },
  });
  record('上传 - 路径遍历文件名拒绝', r.status === 400,
    `status=${r.status}`, r.body);

  // 缺少 fileName
  r = await req('POST', '/v1/assets/upload-url', {
    headers: auth,
    json: {},
  });
  record('上传 - 缺少 fileName 返回 400', r.status === 400,
    `status=${r.status}`, r.body);
}

async function testRenderJobs() {
  console.log('\n========== 7. 渲染任务 ==========\n');
  if (!state.apiKeyPlain) {
    record('渲染任务测试 - 跳过', null);
    return;
  }
  const auth = { Authorization: `Bearer ${state.apiKeyPlain}` };

  // 提交渲染任务 - 无效的 templateVersionId
  let r = await req('POST', '/v1/render-jobs', {
    headers: { ...auth, 'Idempotency-Key': 'test-idem-' + Date.now() },
    json: {
      templateVersionId: 'tpv_invalid_xxx',
      input: {},
    },
  });
  record('POST /v1/render-jobs 无效 templateVersionId', r.status === 400 || r.status === 404 || r.status === 422,
    `status=${r.status}`, r.body);

  // 缺少必填字段
  r = await req('POST', '/v1/render-jobs', {
    headers: auth,
    json: { input: {} },
  });
  record('POST /v1/render-jobs 缺少 templateVersionId', r.status === 400,
    `status=${r.status}`, r.body);

  // 查询不存在的任务
  r = await req('GET', '/v1/render-jobs/job_nonexistent', { headers: auth });
  record('GET /v1/render-jobs/:jobId 不存在', r.status === 404,
    `status=${r.status}`, r.body);

  // 取消不存在的任务
  r = await req('POST', '/v1/render-jobs/job_nonexistent/cancel', { headers: auth });
  record('POST /v1/render-jobs/:jobId/cancel 不存在', r.status === 404 || r.status === 400,
    `status=${r.status}`, r.body);

  // 列出已有任务，找一个来测试查询
  r = await req('GET', '/admin/api/jobs?limit=5', { headers: { Authorization: `Bearer ${state.adminToken}` } });
  if (r.body?.jobs?.length > 0) {
    const existingJobCode = r.body.jobs[0].jobId;
    // 用 API Key 查询（注意 tenantId 隔离 - 可能 404）
    r = await req('GET', `/v1/render-jobs/${existingJobCode}`, { headers: auth });
    record('GET /v1/render-jobs/:jobId 已有任务', r.status === 200 || r.status === 404,
      `status=${r.status}, jobCode=${existingJobCode}`, r.body);
  } else {
    record('GET /v1/render-jobs/:jobId 已有任务 - 跳过（无任务）', null);
  }
}

async function testAuditLogs() {
  console.log('\n========== 8. 审计日志 ==========\n');
  const auth = { Authorization: `Bearer ${state.adminToken}` };

  let r = await req('GET', '/admin/api/audit-logs?pageSize=5', { headers: auth });
  record('GET /admin/api/audit-logs 分页查询', r.status === 200,
    `status=${r.status}, total=${r.body?.total}`, r.body);
  if (r.body?.items?.length > 0) {
    state.auditLogId = r.body.items[0].id;
  } else if (r.body?.data?.length > 0) {
    state.auditLogId = r.body.data[0].id;
  }

  // 按 action 过滤
  r = await req('GET', '/admin/api/audit-logs?action=admin_login&pageSize=3', { headers: auth });
  record('GET /admin/api/audit-logs?action=admin_login', r.status === 200,
    `status=${r.status}`, r.body);

  // 统计
  r = await req('GET', '/admin/api/audit-logs/stats?days=7', { headers: auth });
  record('GET /admin/api/audit-logs/stats 统计', r.status === 200 && Array.isArray(r.body?.stats),
    `status=${r.status}, days=${r.body?.days}`, r.body);

  // 详情
  if (state.auditLogId) {
    r = await req('GET', `/admin/api/audit-logs/${state.auditLogId}`, { headers: auth });
    record('GET /admin/api/audit-logs/:id 详情', r.status === 200,
      `status=${r.status}`, r.body);
  }

  // 不存在的 ID
  r = await req('GET', '/admin/api/audit-logs/nonexistent-id', { headers: auth });
  record('GET /admin/api/audit-logs/:id 不存在', r.status === 404,
    `status=${r.status}`, r.body);
}

async function testWebhookLogs() {
  console.log('\n========== 9. Webhook 日志 ==========\n');
  const auth = { Authorization: `Bearer ${state.adminToken}` };

  let r = await req('GET', '/admin/api/webhook-logs?pageSize=5', { headers: auth });
  record('GET /admin/api/webhook-logs 分页查询', r.status === 200,
    `status=${r.status}`, r.body);
  if (r.body?.items?.length > 0) {
    state.webhookLogId = r.body.items[0].id;
  } else if (r.body?.data?.length > 0) {
    state.webhookLogId = r.body.data[0].id;
  }

  r = await req('GET', '/admin/api/webhook-logs/stats?days=7', { headers: auth });
  record('GET /admin/api/webhook-logs/stats 统计', r.status === 200,
    `status=${r.status}, total=${r.body?.total}`, r.body);

  if (state.webhookLogId) {
    r = await req('GET', `/admin/api/webhook-logs/${state.webhookLogId}`, { headers: auth });
    record('GET /admin/api/webhook-logs/:id 详情', r.status === 200,
      `status=${r.status}`, r.body);
  } else {
    record('GET /admin/api/webhook-logs/:id 详情 - 跳过（无日志）', null);
  }
}

async function testWorkerInternal() {
  console.log('\n========== 10. Worker 内部接口 ==========\n');

  // 注册 Worker（需要 WORKER_REGISTER_SECRET）
  const registerSecret = 'dev_only_register_b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3';
  let r = await req('POST', '/internal/workers/register', {
    headers: { Authorization: `Bearer ${registerSecret}` },
    json: {
      machineFingerprint: 'test-fp-' + Date.now(),
      psVersion: '25.0.0',
      psMajorVersion: 25,
      os: 'windows',
      supportsSmartObject: true,
      supportsTextLayer: true,
      fonts: [],
      hostname: 'test-host',
      cpuModel: 'Test CPU',
      cpuCores: 4,
    },
  });
  state.workerToken = r.body?.accessToken;
  state.workerId = r.body?.workerId;
  record('POST /internal/workers/register 注册', r.status === 200 && state.workerToken,
    `status=${r.status}, workerId=${state.workerId}`, r.body);

  // 错误的注册密钥
  r = await req('POST', '/internal/workers/register', {
    headers: { Authorization: 'Bearer wrong-secret' },
    json: {
      machineFingerprint: 'test-fp-wrong',
      psVersion: '25.0.0',
      psMajorVersion: 25,
      os: 'windows',
      supportsSmartObject: true,
      supportsTextLayer: true,
      fonts: [],
    },
  });
  record('注册 - 错误密钥返回 401', r.status === 401,
    `status=${r.status}`, r.body);

  // 缺少必填字段
  r = await req('POST', '/internal/workers/register', {
    headers: { Authorization: `Bearer ${registerSecret}` },
    json: { machineFingerprint: 'test' },
  });
  record('注册 - 缺少必填字段返回 400', r.status === 400,
    `status=${r.status}`, r.body);

  // 领取任务（无任务时应超时或返回空）
  if (state.workerToken) {
    r = await req('POST', '/internal/workers/claim', {
      headers: { Authorization: `Bearer ${state.workerToken}` },
      json: { maxWaitSeconds: 5 },
      timeoutMs: 15000,
    });
    record('POST /internal/workers/claim 领取任务', r.status === 200 || r.status === 202 || r.status === 408,
      `status=${r.status}`, r.body);
  }
}

async function testErrorHandling() {
  console.log('\n========== 11. 错误处理与边界情况 ==========\n');

  // 无效 JSON
  let r = await req('POST', '/admin/api/login', {
    headers: { 'Content-Type': 'application/json' },
    raw: '{invalid json',
  });
  record('无效 JSON 返回 400', r.status === 400,
    `status=${r.status}`, r.body);

  // 超长 Idempotency-Key
  if (state.apiKeyPlain) {
    const longKey = 'x'.repeat(200);
    r = await req('POST', '/v1/render-jobs', {
      headers: {
        Authorization: `Bearer ${state.apiKeyPlain}`,
        'Idempotency-Key': longKey,
      },
      json: { templateVersionId: 'tpv_x', input: {} },
    });
    record('超长 Idempotency-Key 返回 400', r.status === 400,
      `status=${r.status}`, r.body);
  }

  // Webhook URL SSRF 防护
  if (state.apiKeyPlain) {
    r = await req('POST', '/v1/render-jobs', {
      headers: { Authorization: `Bearer ${state.apiKeyPlain}` },
      json: {
        templateVersionId: 'tpv_x',
        input: {},
        webhookUrl: 'http://169.254.169.254/latest/meta-data/', // 云元数据地址，无论 dev/prod 都强制拒绝
      },
    });
    record('Webhook URL SSRF 防护 - 拒绝云元数据地址(169.254)', r.status === 400,
      `status=${r.status}`, r.body);

    r = await req('POST', '/v1/render-jobs', {
      headers: { Authorization: `Bearer ${state.apiKeyPlain}` },
      json: {
        templateVersionId: 'tpv_x',
        input: {},
        webhookUrl: 'ftp://example.com/hook', // 非 http/https 应被拒绝
      },
    });
    record('Webhook URL SSRF 防护 - 拒绝非 HTTP(S)', r.status === 400,
      `status=${r.status}`, r.body);
  }

  // 角色权限：viewer 不能创建用户
  // 先创建一个 viewer 用户
  const viewerPw = 'Viewer!Pass2026';
  r = await req('POST', '/admin/api/admin-users', {
    headers: { Authorization: `Bearer ${state.adminToken}` },
    json: { username: 'tester_viewer_' + Date.now(), password: viewerPw, role: 'viewer' },
  });
  const viewerUser = r.body?.user;
  if (viewerUser) {
    // 用 viewer 登录
    r = await req('POST', '/admin/api/login', {
      json: { username: viewerUser.username, password: viewerPw },
    });
    const viewerToken = extractCookie(r.headers['set-cookie'], 'admin_session');
    if (viewerToken) {
      // viewer 尝试创建用户（应 403）
      r = await req('POST', '/admin/api/admin-users', {
        headers: { Authorization: `Bearer ${viewerToken}` },
        json: { username: 'should_fail', password: 'TestPassword!2026', role: 'viewer' },
      });
      record('viewer 角色创建用户返回 403', r.status === 403,
        `status=${r.status}`, r.body);
    }
  } else {
    record('viewer 角色创建用户 - 跳过（创建 viewer 失败）', null);
  }
}

async function testCleanup() {
  console.log('\n========== 12. 清理测试数据 ==========\n');
  const auth = { Authorization: `Bearer ${state.adminToken}` };

  // 删除测试 API Key
  if (state.apiKeyId) {
    const r = await req('DELETE', `/admin/api/api-keys/${state.apiKeyId}`, { headers: auth });
    // 200/204 均视为成功；响应体可能为 {}（部分路由未声明 schema 时）
    record('DELETE /admin/api/api-keys/:id 删除测试 Key', r.status === 200 || r.status === 204,
      `status=${r.status}`, r.body);
  }
}

async function main() {
  console.log(`\n############################################`);
  console.log(`#  PSD 渲染服务 - 全面 API 功能测试`);
  console.log(`#  目标: ${BASE}`);
  console.log(`#  时间: ${new Date().toISOString()}`);
  console.log(`############################################\n`);

  try {
    await testHealthAndMetrics();
    await testAdminAuth();
    await testAdminStats();
    await testApiKeyManagement();
    await testTemplateManagement();
    await testAssetUpload();
    await testRenderJobs();
    await testAuditLogs();
    await testWebhookLogs();
    await testWorkerInternal();
    await testErrorHandling();
    await testCleanup();
  } catch (e) {
    console.error('\n测试过程中发生异常:', e);
  }

  // 汇总报告
  console.log('\n============================================');
  console.log('                 测试汇总报告');
  console.log('============================================');
  console.log(`总计: ${results.length}  PASS: ${passCount}  FAIL: ${failCount}  SKIP: ${skipCount}`);
  console.log(`通过率: ${results.length ? ((passCount / results.length) * 100).toFixed(1) : 0}%\n`);

  if (failCount > 0) {
    console.log('--- 失败用例 ---');
    results.filter(r => r.passed === false).forEach(r => {
      console.log(`  [FAIL] ${r.name}`);
      if (r.detail) console.log(`         ${r.detail}`);
    });
  }

  // 写入详细报告文件
  const reportPath = join(__dirname, 'api-test-report.txt');
  const { writeFileSync } = await import('node:fs');
  const lines = [
    `PSD 渲染服务 - 全面 API 功能测试报告`,
    `目标: ${BASE}`,
    `时间: ${new Date().toISOString()}`,
    `总计: ${results.length}  PASS: ${passCount}  FAIL: ${failCount}  SKIP: ${skipCount}`,
    `通过率: ${results.length ? ((passCount / results.length) * 100).toFixed(1) : 0}%`,
    '',
    '--- 详细结果 ---',
  ];
  for (const r of results) {
    const tag = r.passed === true ? 'PASS' : r.passed === false ? 'FAIL' : 'SKIP';
    lines.push(`[${tag}] ${r.name}`);
    if (r.detail) lines.push(`       ${r.detail}`);
    if (r.extra) lines.push(`       ${JSON.stringify(r.extra)}`);
  }
  writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  console.log(`\n详细报告已写入: ${reportPath}`);

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
