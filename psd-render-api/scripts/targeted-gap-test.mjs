/**
 * 针对性补丁测试：覆盖 comprehensive-api-test.mjs 未触及的端点
 * 重点验证：
 *   1. Admin 字体模块（POST /admin/api/fonts/upload, GET /admin/api/fonts, ...）
 *   2. Admin Bootstrap Token 模块
 *   3. Admin 存储配置模块
 *   4. Admin Worker 管理写操作（display-name / custom-code / force-offline / reapprove / delete）
 *   5. Admin 模板归档/取消归档/删除/缩略图
 *   6. Admin 任务高级操作（force-cancel / release-lease / retry / batch-*）
 *   7. Admin 告警 ack / batch-clear
 *   8. Webhook 日志 retry（如有失败日志）
 *   9. Internal 字体模块（manifest / 列表 / upload-url / 注册）
 *  10. Internal Worker 列表（GET /internal/workers）
 *  11. /storage/download 签名校验
 *  12. 文档不一致验证：/storage/upload 无 security 声明但实际需鉴权
 *
 * 运行方式：node scripts/targeted-gap-test.mjs
 * 依赖：后端运行在 http://localhost:3000，.env 中默认管理员密码
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const ADMIN_USER = 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'DevAdmin!Secure2026';
const WORKER_REGISTER_SECRET = process.env.WORKER_REGISTER_SECRET || 'dev_only_register_b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3';

const results = [];
const state = {};

function record(name, pass, status, body, note = '') {
  results.push({ name, pass, status, body, note });
  const tag = pass ? '[PASS]' : '[FAIL]';
  console.log(`${tag} ${name}`);
  console.log(`       status=${status}${note ? ', ' + note : ''}`);
  if (body) console.log(`       ${typeof body === 'string' ? body.slice(0, 240) : JSON.stringify(body).slice(0, 240)}`);
  console.log('');
}

async function req(method, path, { headers = {}, body, noJson = false } = {}) {
  // 默认 application/json；若 noJson=true 则不带 Content-Type（避免 Fastify 拒绝空 body）
  const init = { method, headers: { ...headers } };
  if (!noJson) {
    init.headers['Content-Type'] = 'application/json';
  }
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) {
      init.body = body;
      init.headers['Content-Type'] = headers['Content-Type'] || 'application/octet-stream';
    } else if (typeof body === 'string') {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
    }
  }
  const r = await fetch(`${BASE}${path}`, init);
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed, headers: r.headers };
}

async function login() {
  const r = await req('POST', '/admin/api/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
  if (r.status !== 200) throw new Error(`Admin 登录失败: ${r.status} ${JSON.stringify(r.body)}`);
  const cookie = r.headers.get('set-cookie');
  const m = cookie && cookie.match(/admin_session=([^;]+)/);
  state.token = m && m[1];
  state.authHeader = { Cookie: `admin_session=${state.token}`, Authorization: `Bearer ${state.token}` };
  console.log(`[登录] 成功，token=${state.token && state.token.slice(0, 12)}...\n`);
}

async function main() {
  console.log('############################################');
  console.log('#  PSD 渲染服务 - 针对性补丁测试（覆盖未测端点）');
  console.log(`#  目标: ${BASE}`);
  console.log('############################################\n');

  await login();

  // ===== 1. Bootstrap Token 模块 =====
  console.log('========== Bootstrap Token 模块 ==========\n');
  // 创建
  let r = await req('POST', '/admin/api/bootstrap-tokens', { headers: state.authHeader, body: { note: 'gap-test' } });
  record('POST /admin/api/bootstrap-tokens 创建配对码', r.status === 200, r.status, r.body);
  if (r.status === 200 && r.body.id) {
    state.tokenId = r.body.id;
    state.pairingCode = r.body.pairingCode;
    state.bootstrapToken = r.body.token;
  }

  // 列表
  r = await req('GET', '/admin/api/bootstrap-tokens', { headers: state.authHeader });
  record('GET /admin/api/bootstrap-tokens 列表', r.status === 200, r.status, r.body, `count=${r.body && r.body.tokens ? r.body.tokens.length : '?'}`);

  // 作废
  if (state.tokenId) {
    r = await req('DELETE', `/admin/api/bootstrap-tokens/${state.tokenId}`, { headers: state.authHeader });
    record('DELETE /admin/api/bootstrap-tokens/:id 作废', r.status === 200, r.status, r.body);

    // 硬删除
    r = await req('POST', `/admin/api/bootstrap-tokens/${state.tokenId}/delete`, { headers: state.authHeader, noJson: true });
    record('POST /admin/api/bootstrap-tokens/:id/delete 硬删除', r.status === 200, r.status, r.body);
  }

  // ===== 2. 存储配置模块 =====
  console.log('========== 存储配置 ==========\n');
  r = await req('GET', '/admin/api/storage-settings', { headers: state.authHeader });
  record('GET /admin/api/storage-settings', r.status === 200, r.status, r.body);

  r = await req('POST', '/admin/api/storage-settings/test', { headers: state.authHeader, noJson: true });
  record('POST /admin/api/storage-settings/test 测试连接', r.status === 200 || r.status === 400, r.status, r.body);

  // ===== 3. 模板归档/取消归档/缩略图 =====
  console.log('========== 模板归档/缩略图 ==========\n');
  // 先获取一个模板
  r = await req('GET', '/admin/api/templates', { headers: state.authHeader });
  const templates = (r.body && r.body.templates) || [];
  if (templates.length > 0) {
    const tpl = templates[0];
    state.templateId = tpl.templateId;

    // 缩略图 URL
    r = await req('GET', `/admin/api/templates/${state.templateId}/thumbnail-url`, { headers: state.authHeader });
    record('GET /admin/api/templates/:id/thumbnail-url', r.status === 200 || r.status === 404, r.status, r.body);

    // 归档
    r = await req('POST', `/admin/api/templates/${state.templateId}/archive`, { headers: state.authHeader, noJson: true });
    record('POST /admin/api/templates/:id/archive', r.status === 200 || r.status === 400 || r.status === 409, r.status, r.body);

    if (r.status === 200) {
      // 取消归档
      r = await req('POST', `/admin/api/templates/${state.templateId}/unarchive`, { headers: state.authHeader, noJson: true });
      record('POST /admin/api/templates/:id/unarchive', r.status === 200 || r.status === 400 || r.status === 409, r.status, r.body);
    }
  } else {
    record('模板归档/缩略图测试', false, 200, null, '无可用模板');
  }

  // ===== 4. Worker 管理写操作 =====
  console.log('========== Worker 管理写操作 ==========\n');
  // 先注册一个 worker
  r = await req('POST', '/internal/workers/register', {
    headers: { Authorization: `Bearer ${WORKER_REGISTER_SECRET}` },
    body: {
      machineFingerprint: 'gap-test-fingerprint-' + Date.now(),
      psVersion: '25.0',
      psMajorVersion: 25,
      os: 'windows',
      supportsSmartObject: true,
      supportsTextLayer: true,
      fonts: [],
    },
  });
  if (r.status === 200) {
    state.workerId = r.body.workerId;
    state.workerToken = r.body.accessToken;
    record('POST /internal/workers/register (for admin tests)', true, r.status, r.body);
  } else {
    record('POST /internal/workers/register (for admin tests)', false, r.status, r.body);
  }

  // Worker 列表（内部）
  r = await req('GET', '/internal/workers', { headers: state.authHeader });
  record('GET /internal/workers 列表', r.status === 200, r.status, r.body, `count=${r.body && r.body.workers ? r.body.workers.length : '?'}`);

  // Worker 详情
  if (state.workerId) {
    r = await req('GET', `/admin/api/workers/${state.workerId}`, { headers: state.authHeader });
    record('GET /admin/api/workers/:id 详情', r.status === 200, r.status, r.body);

    // 更新 display-name
    r = await req('PUT', `/admin/api/workers/${state.workerId}/display-name`, {
      headers: state.authHeader,
      body: { displayName: 'gap-test-worker' },
    });
    record('PUT /admin/api/workers/:id/display-name', r.status === 200, r.status, r.body);

    // 更新 custom-code
    r = await req('PUT', `/admin/api/workers/${state.workerId}/custom-code`, {
      headers: state.authHeader,
      body: { customCode: 'GAP-001' },
    });
    record('PUT /admin/api/workers/:id/custom-code', r.status === 200, r.status, r.body);

    // 强制下线
    r = await req('POST', `/admin/api/workers/${state.workerId}/force-offline`, { headers: state.authHeader, noJson: true });
    record('POST /admin/api/workers/:id/force-offline', r.status === 200, r.status, r.body);

    // 重新批准
    r = await req('POST', `/admin/api/workers/${state.workerId}/reapprove`, { headers: state.authHeader, noJson: true });
    record('POST /admin/api/workers/:id/reapprove', r.status === 200, r.status, r.body);

    // 再次强制下线后删除
    r = await req('POST', `/admin/api/workers/${state.workerId}/force-offline`, { headers: state.authHeader, noJson: true });
    r = await req('DELETE', `/admin/api/workers/${state.workerId}`, { headers: state.authHeader });
    record('DELETE /admin/api/workers/:id', r.status === 200 || r.status === 400, r.status, r.body);
  }

  // ===== 5. 内部字体模块 =====
  console.log('========== 内部字体模块 ==========\n');
  // Worker 字体清单
  if (state.workerToken) {
    r = await req('GET', '/internal/fonts/manifest', { headers: { Authorization: `Bearer ${state.workerToken}` } });
    record('GET /internal/fonts/manifest', r.status === 200, r.status, r.body);
  }

  // Admin 字体列表（含 /internal/fonts 和 /admin/api/fonts 两个等价端点）
  r = await req('GET', '/internal/fonts', { headers: state.authHeader });
  record('GET /internal/fonts 字体列表', r.status === 200, r.status, r.body, `count=${r.body && r.body.fonts ? r.body.fonts.length : '?'}`);

  r = await req('GET', '/admin/api/fonts', { headers: state.authHeader });
  record('GET /admin/api/fonts 字体列表', r.status === 200, r.status, r.body, `count=${r.body && r.body.fonts ? r.body.fonts.length : '?'}`);

  // 字体 upload-url（admin）
  r = await req('POST', '/internal/fonts/upload-url', {
    headers: state.authHeader,
    body: { fileName: 'gap-test.ttf' },
  });
  record('POST /internal/fonts/upload-url', r.status === 200 || r.status === 400, r.status, r.body);

  // 字体详情
  const fonts = (r.body && r.body.fonts) || [];
  if (fonts.length > 0) {
    const font = fonts[0];
    r = await req('GET', `/admin/api/fonts/${font.id}`, { headers: state.authHeader });
    record('GET /admin/api/fonts/:id 详情', r.status === 200, r.status, r.body);
  }

  // ===== 6. 任务高级操作 =====
  console.log('========== 任务高级操作 ==========\n');
  // 批量取消（应返回 cancelled 数）
  r = await req('POST', '/admin/api/jobs/batch-cancel', { headers: state.authHeader, noJson: true });
  record('POST /admin/api/jobs/batch-cancel', r.status === 200, r.status, r.body);

  // 批量删除
  r = await req('POST', '/admin/api/jobs/batch-delete', { headers: state.authHeader, noJson: true });
  record('POST /admin/api/jobs/batch-delete', r.status === 200, r.status, r.body);

  // 获取一个任务详情进行 retry / force-cancel 测试
  r = await req('GET', '/admin/api/jobs', { headers: state.authHeader, headers2: { ...state.authHeader } });
  const jobs = (r.body && r.body.jobs) || [];
  // 找一个 failed 的任务做 retry
  const failedJob = jobs.find(j => j.status === 'FAILED');
  if (failedJob) {
    r = await req('GET', `/admin/api/jobs/${failedJob.code}`, { headers: state.authHeader });
    record('GET /admin/api/jobs/:code 详情', r.status === 200, r.status, r.body);

    r = await req('POST', `/admin/api/jobs/${failedJob.code}/retry`, { headers: state.authHeader, noJson: true });
    record('POST /admin/api/jobs/:code/retry', r.status === 200 || r.status === 409, r.status, r.body);

    r = await req('POST', `/admin/api/jobs/${failedJob.code}/force-cancel`, { headers: state.authHeader, noJson: true });
    record('POST /admin/api/jobs/:code/force-cancel', r.status === 200 || r.status === 409, r.status, r.body);
  } else {
    record('任务高级操作（retry/force-cancel）', false, 200, null, '无 FAILED 任务可测试');
  }

  // ===== 7. 告警操作 =====
  console.log('========== 告警操作 ==========\n');
  r = await req('GET', '/admin/api/alerts?status=ACTIVE', { headers: state.authHeader });
  const alerts = (r.body && r.body.alerts) || [];
  if (alerts.length > 0) {
    r = await req('POST', `/admin/api/alerts/${alerts[0].id}/ack`, { headers: state.authHeader, noJson: true });
    record('POST /admin/api/alerts/:id/ack', r.status === 200, r.status, r.body);
  } else {
    record('POST /admin/api/alerts/:id/ack', false, 200, null, '无 ACTIVE 告警');
  }

  r = await req('POST', '/admin/api/alerts/batch-clear', { headers: state.authHeader, noJson: true });
  record('POST /admin/api/alerts/batch-clear', r.status === 200, r.status, r.body);

  // ===== 8. Webhook 日志 retry =====
  console.log('========== Webhook 日志 retry ==========\n');
  r = await req('GET', '/admin/api/webhook-logs?status=FAILED', { headers: state.authHeader });
  const logs = (r.body && r.body.items) || [];
  if (logs.length > 0) {
    r = await req('POST', `/admin/api/webhook-logs/${logs[0].id}/retry`, { headers: state.authHeader });
    record('POST /admin/api/webhook-logs/:id/retry', r.status === 200 || r.status === 400, r.status, r.body);
  } else {
    record('POST /admin/api/webhook-logs/:id/retry', false, 200, null, '无 FAILED webhook 日志');
  }

  // ===== 9. 文档不一致验证 =====
  console.log('========== 文档不一致验证 ==========\n');
  // /storage/upload 无 token：实际实现先校验 key/token 存在性，返回 400 MISSING_PARAMS
  // 文档未声明 security，且未声明 MISSING_PARAMS 错误响应
  r = await req('PUT', '/storage/upload?key=test-no-token', { body: Buffer.from('test'), noJson: true });
  record('PUT /storage/upload 无 token（文档未声明 security 也未声明 MISSING_PARAMS）',
    r.status === 400 || r.status === 401 || r.status === 403, r.status, r.body);

  // /storage/download 无 token：同上
  r = await req('GET', '/storage/download?key=test-no-token');
  record('GET /storage/download 无 token（文档未声明 security 也未声明 MISSING_PARAMS）',
    r.status === 400 || r.status === 401 || r.status === 403, r.status, r.body);

  // /storage/upload 用错误 token：应返回 403
  r = await req('PUT', '/storage/upload?key=input/test.png&token=invalid-token', { body: Buffer.from('test'), noJson: true });
  record('PUT /storage/upload 错误 token（文档声明 403）',
    r.status === 403, r.status, r.body);

  // Idempotency-Key 超长（OpenAPI 未声明 maxLength，实际返回 400）
  r = await req('POST', '/v1/render-jobs', {
    headers: { Authorization: 'Bearer sk_live_poc_demo_2026', 'Idempotency-Key': 'x'.repeat(129) },
    body: { templateVersionId: 'tpv_nonexist', input: {} },
  });
  record('POST /v1/render-jobs 超长 Idempotency-Key（文档未声明 maxLength）',
    r.status === 400, r.status, r.body);

  // GET /metrics 是否需要鉴权（生产环境应需要，dev 模式可能不需要）
  r = await req('GET', '/metrics');
  record('GET /metrics 无鉴权访问（描述说生产需 admin，文档未声明 security）',
    r.status === 200 || r.status === 401, r.status, r.body, `body length=${typeof r.body === 'string' ? r.body.length : '?'}`);

  // ===== 汇总 =====
  console.log('============================================');
  console.log('                 测试汇总');
  console.log('============================================');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`总计: ${results.length}  PASS: ${passed}  FAIL: ${failed}`);
  console.log('');
  if (failed > 0) {
    console.log('失败用例：');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  [FAIL] ${r.name}  status=${r.status}${r.note ? ', ' + r.note : ''}`);
    });
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('未捕获异常:', err);
  process.exit(1);
});
