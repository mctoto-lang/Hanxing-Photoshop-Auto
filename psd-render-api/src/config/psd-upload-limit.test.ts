import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/**
 * PSD 上传限制 300MB 改造的跨层接线校验。
 * 限制分散在 6 个层级，任一处遗漏都会导致 300MB PSD 被静默拦截或内存失控。
 * 此测试用源码断言确保各层改动一致存在（遵循 docker-manifest.test.ts 的轻量源码断言风格）。
 */

test('存储层：putObject 按 psd/ 前缀分支限额（local + cos 一致）', () => {
  for (const f of ['src/services/storage/local-storage.ts', 'src/services/storage/cos-storage.ts']) {
    const s = read(f);
    assert.match(s, /opts\.objectKey\.startsWith\('psd\/'\)/, `${f} 缺少 psd/ 前缀分支`);
    assert.match(s, /env\.MAX_PSD_SIZE_MB \* 1024 \* 1024/, `${f} PSD 限额未引用 MAX_PSD_SIZE_MB`);
    assert.match(s, /env\.MAX_INPUT_SIZE_MB \* 1024 \* 1024/, `${f} 输入资产限额未引用 MAX_INPUT_SIZE_MB`);
  }
});

test('Fastify 路由级 bodyLimit：Admin 模板上传 = MAX_PSD_SIZE_MB', () => {
  const s = read('src/admin/admin-write-routes.ts');
  assert.match(s, /app\.post\('\/api\/templates\/upload'/);
  assert.match(s, /bodyLimit:\s*env\.MAX_PSD_SIZE_MB \* 1024 \* 1024/);
});

test('Fastify 路由级 bodyLimit：/storage/upload = max(输入, PSD)', () => {
  const s = read('src/routes/storage.ts');
  assert.match(s, /app\.put\('\/storage\/upload'/);
  assert.match(s, /bodyLimit:\s*Math\.max\(env\.MAX_INPUT_SIZE_MB,\s*env\.MAX_PSD_SIZE_MB\) \* 1024 \* 1024/);
});

test('全局 bodyLimit 仍为 MAX_INPUT_SIZE_MB（未误放宽全站）', () => {
  const s = read('src/server.ts');
  assert.match(s, /bodyLimit:\s*env\.MAX_INPUT_SIZE_MB \* 1024 \* 1024/);
});

test('psd-parser：resourceLimits + 可配置超时 + 信号量三件套', () => {
  const s = read('src/services/psd-parser/psd-parser.ts');
  assert.match(s, /resourceLimits:\s*\{/);
  assert.match(s, /maxOldGenerationSizeMb:\s*Math\.max\(1024,\s*env\.MAX_PSD_SIZE_MB \* 5\)/);
  assert.match(s, /const timeoutMs = psdParseTimeoutMs/);
  assert.match(s, /const parseSemaphore = new Semaphore\(psdParseConcurrency\)/);
  assert.match(s, /parseSemaphore\.acquire\(\)/);
  // parse 与 generateThumbnail 各自 acquire/release
  const acquireCount = (s.match(/parseSemaphore\.acquire\(\)/g) ?? []).length;
  assert.equal(acquireCount, 2, 'parse 与 generateThumbnail 应各 acquire 一次');
});

test('template-service：上传 URL TTL 与 artifact expiresAt 均改用 env', () => {
  const s = read('src/services/template/template-service.ts');
  assert.match(s, /expiresInSec:\s*psdUploadUrlExpiresSec/);
  // 不应残留硬编码 600s
  assert.doesNotMatch(s, /expiresInSec:\s*600/);
  assert.doesNotMatch(s, /Date\.now\(\) \+ 600_000/);
  assert.match(s, /Date\.now\(\) \+ psdUploadUrlExpiresSec \* 1000/);
});

test('外部 API：/v1/templates/upload-url schema 含 sizeBytes 可选上限', () => {
  const s = read('src/routes/v1/templates.ts');
  assert.match(s, /sizeBytes:\s*\{\s*type:\s*'integer'/);
  assert.match(s, /maximum:\s*env\.MAX_PSD_SIZE_MB \* 1024 \* 1024/);
});

test('前端 Admin UI：300MB size 预检 + 提示', () => {
  const s = read('src/admin/admin-page.ts');
  assert.match(s, /const PSD_MAX_MB = 300/);
  assert.match(s, /file\.size > PSD_MAX_MB \* 1024 \* 1024/);
  assert.match(s, /最大 300MB/);
});

test('nginx 示例：client_max_body_size 提升至 400m', () => {
  const s = read('deploy/nginx.conf.example');
  assert.match(s, /client_max_body_size 400m/);
  assert.doesNotMatch(s, /client_max_body_size 200m/);
});
