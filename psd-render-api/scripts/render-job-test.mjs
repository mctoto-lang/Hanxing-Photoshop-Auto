/**
 * 渲染任务 API 专项测试 - 使用真实已发布模板 + 必填绑定
 */
import { prisma } from '../dist/lib/prisma.js';

const BASE = 'http://localhost:3000';
const results = [];
let pass = 0, fail = 0;

function record(name, ok, detail = '', extra = null) {
  results.push({ name, ok, detail, extra });
  if (ok === true) pass++;
  else if (ok === false) fail++;
  const tag = ok === true ? 'PASS' : ok === false ? 'FAIL' : 'SKIP';
  console.log(`[${tag}] ${name}`);
  if (detail) console.log(`       ${detail}`);
  if (extra) console.log(`       ${JSON.stringify(extra).slice(0, 400)}`);
  console.log('');
}

async function req(method, path, opts = {}) {
  const url = new URL(path, BASE);
  const headers = { ...opts.headers };
  let body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.json);
  } else if (opts.raw !== undefined) {
    body = opts.raw;
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body: parsed, text };
}

// 找一个已发布的模板版本
const tv = await prisma.templateVersion.findFirst({
  where: { published: true },
  include: { template: { include: { bindings: true } } },
});
if (!tv) {
  console.log('No published template found');
  process.exit(1);
}
console.log(`Using template: ${tv.template.name} (versionId=${tv.id}, tenant=${tv.template.tenantId})`);
console.log(`Bindings: ${tv.template.bindings.map(b => `${b.bindingId}(${b.type},${b.required?'required':'optional'})`).join(', ')}`);
await prisma.$disconnect();

const envApiKey = 'sk_live_poc_demo_2026';
const auth = { Authorization: `Bearer ${envApiKey}` };

console.log('\n========== 渲染任务 API 测试 ==========\n');

// 用 DB 中已验证的测试 artifact（sha256 非空）
let r;
const assetId = 'art_test_1785315255367';
console.log(`使用预置 assetId: ${assetId}\n`);

// 构造绑定输入
const bindings = {};
for (const b of tv.template.bindings) {
  if (b.type === 'text') {
    bindings[b.bindingId] = { text: '测试文本内容' };
  } else if (b.type === 'smartObject' || b.type === 'pixel') {
    bindings[b.bindingId] = { assetId: assetId || 'art_dummy' };
  }
}
console.log(`构造的 input: ${JSON.stringify(bindings)}\n`);

// 1. 提交渲染任务（使用真实 templateVersionId + 必填绑定）
const idemKey = 'test-render-' + Date.now();
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': idemKey },
  json: {
    templateVersionId: tv.id,
    input: bindings,
  },
});
let jobId = r.body?.jobId;
let jobStatus = r.body?.status;
record('POST /v1/render-jobs 创建任务（真实模板+必填绑定）',
  Boolean(r.status === 201 || r.status === 200),
  `status=${r.status}, jobId=${jobId}, jobStatus=${jobStatus}`, r.body);

// 2. 幂等性测试
if (jobId) {
  r = await req('POST', '/v1/render-jobs', {
    headers: { ...auth, 'Idempotency-Key': idemKey },
    json: { templateVersionId: tv.id, input: bindings },
  });
  record('POST /v1/render-jobs 幂等性（相同 key 返回 200 + 相同 jobId）',
    Boolean(r.status === 200 && r.body?.jobId === jobId),
    `status=${r.status}, jobId=${r.body?.jobId} (应等于 ${jobId})`, r.body);

  // 3. 查询任务
  r = await req('GET', `/v1/render-jobs/${jobId}`, { headers: auth });
  record('GET /v1/render-jobs/:jobId 查询任务',
    Boolean(r.status === 200 && r.body?.jobId === jobId),
    `status=${r.status}, jobStatus=${r.body?.status}, progress=${r.body?.progress}`, r.body);

  // 4. 取消任务（QUEUED 状态应直接 CANCELLED）
  r = await req('POST', `/v1/render-jobs/${jobId}/cancel`, {
    headers: auth,
    json: { reason: '测试取消' },
  });
  record('POST /v1/render-jobs/:jobId/cancel 取消任务',
    Boolean(r.status === 200 && r.body?.updated === true),
    `status=${r.status}, jobStatus=${r.body?.status}, updated=${r.body?.updated}`, r.body);

  // 5. 再次取消（应 409 - 已是终态）
  r = await req('POST', `/v1/render-jobs/${jobId}/cancel`, {
    headers: auth,
    json: { reason: '再次取消' },
  });
  record('POST /v1/render-jobs/:jobId/cancel 已终态返回 409',
    Boolean(r.status === 409 && r.body?.updated === false),
    `status=${r.status}, updated=${r.body?.updated}`, r.body);

  // 6. 查询取消后的任务状态
  r = await req('GET', `/v1/render-jobs/${jobId}`, { headers: auth });
  record('GET /v1/render-jobs/:jobId 取消后状态',
    Boolean(r.status === 200 && r.body?.status === 'CANCELLED'),
    `status=${r.status}, jobStatus=${r.body?.status}`, r.body);
}

// 7. 跨租户隔离 - 无效 API Key
r = await req('GET', `/v1/render-jobs/${jobId ?? 'job_xxx'}`, {
  headers: { Authorization: 'Bearer sk_live_invalid_other_tenant' },
});
record('跨租户隔离 - 无效 key 返回 401',
  Boolean(r.status === 401),
  `status=${r.status}`, r.body);

// 8. SSRF 防护 - 169.254.169.254 强制拒绝
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': 'test-ssrf-metadata-' + Date.now() },
  json: {
    templateVersionId: tv.id,
    input: bindings,
    webhookUrl: 'http://169.254.169.254/latest/meta-data/',
  },
});
record('SSRF 防护 - 169.254.169.254 强制拒绝（dev 也拒绝）',
  Boolean(r.status === 400),
  `status=${r.status}`, r.body);

// 9. SSRF 防护 - localhost 拒绝
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': 'test-ssrf-localhost-' + Date.now() },
  json: {
    templateVersionId: tv.id,
    input: bindings,
    webhookUrl: 'http://localhost:8080/hook',
  },
});
record('SSRF 防护 - localhost 拒绝',
  Boolean(r.status === 400),
  `status=${r.status}`, r.body);

// 10. SSRF 防护 - 非 HTTP 协议拒绝
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': 'test-ssrf-ftp-' + Date.now() },
  json: {
    templateVersionId: tv.id,
    input: bindings,
    webhookUrl: 'ftp://example.com/hook',
  },
});
record('SSRF 防护 - ftp 协议拒绝',
  Boolean(r.status === 400),
  `status=${r.status}`, r.body);

// 11. 优先级 + JPEG 输出
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': 'test-priority-' + Date.now() },
  json: {
    templateVersionId: tv.id,
    input: bindings,
    output: { format: 'jpeg', quality: 80 },
    priority: 1,
  },
});
record('POST /v1/render-jobs 优先级 + JPEG 输出',
  Boolean(r.status === 201 || r.status === 200),
  `status=${r.status}, jobId=${r.body?.jobId}`, r.body);

// 12. 无效优先级
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': 'test-bad-priority-' + Date.now() },
  json: { templateVersionId: tv.id, input: bindings, priority: 100 },
});
record('无效优先级（>10）返回 400',
  Boolean(r.status === 400),
  `status=${r.status}`, r.body);

// 13. 能力路由
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': 'test-caps-' + Date.now() },
  json: {
    templateVersionId: tv.id,
    input: bindings,
    requiredCapabilities: { psMajorVersion: 25, supportsSmartObject: true, os: 'windows' },
  },
});
record('POST /v1/render-jobs 能力路由要求',
  Boolean(r.status === 201 || r.status === 200),
  `status=${r.status}, jobId=${r.body?.jobId}`, r.body);

// 14. 超长 Idempotency-Key
r = await req('POST', '/v1/render-jobs', {
  headers: { ...auth, 'Idempotency-Key': 'x'.repeat(200) },
  json: { templateVersionId: tv.id, input: bindings },
});
record('超长 Idempotency-Key（>128）返回 400',
  Boolean(r.status === 400),
  `status=${r.status}`, r.body);

// 15. 查询不存在的任务
r = await req('GET', '/v1/render-jobs/job_nonexistent', { headers: auth });
record('GET /v1/render-jobs/:jobId 不存在返回 404',
  Boolean(r.status === 404),
  `status=${r.status}`, r.body);

// 汇总
console.log('\n============================================');
console.log('          渲染任务测试汇总');
console.log('============================================');
console.log(`总计: ${results.length}  PASS: ${pass}  FAIL: ${fail}`);
console.log(`通过率: ${((pass / results.length) * 100).toFixed(1)}%\n`);
if (fail > 0) {
  console.log('--- 失败用例 ---');
  results.filter(r => r.ok === false).forEach(r => {
    console.log(`  [FAIL] ${r.name}: ${r.detail}`);
  });
}
process.exit(fail > 0 ? 1 : 0);
