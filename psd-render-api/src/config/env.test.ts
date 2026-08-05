import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { env, maxPsdSizeBytes, psdParseTimeoutMs, psdParseConcurrency, psdUploadUrlExpiresSec } from './env.js';

const src = readFileSync(resolve(import.meta.dirname, 'env.ts'), 'utf8');

test('MAX_PSD_SIZE_MB 默认 300、范围 1-500（zod fail-fast）', () => {
  assert.match(src, /MAX_PSD_SIZE_MB:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(500\)\.default\(300\)/);
});

test('PSD_PARSE_TIMEOUT_MS 默认 180000、范围 30s-10min', () => {
  assert.match(src, /PSD_PARSE_TIMEOUT_MS:\s*z\.coerce\.number\(\)\.int\(\)\.min\(30000\)\.max\(600000\)\.default\(180000\)/);
});

test('PSD_PARSE_CONCURRENCY 默认 2、范围 1-8', () => {
  assert.match(src, /PSD_PARSE_CONCURRENCY:\s*z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(8\)\.default\(2\)/);
});

test('PSD_UPLOAD_URL_EXPIRES_SEC 默认 1200、范围 60-3600', () => {
  assert.match(src, /PSD_UPLOAD_URL_EXPIRES_SEC:\s*z\.coerce\.number\(\)\.int\(\)\.min\(60\)\.max\(3600\)\.default\(1200\)/);
});

test('派生常量已导出且与 env 值一致（运行时接线校验）', () => {
  assert.equal(maxPsdSizeBytes, env.MAX_PSD_SIZE_MB * 1024 * 1024);
  assert.equal(psdParseTimeoutMs, env.PSD_PARSE_TIMEOUT_MS);
  assert.equal(psdParseConcurrency, env.PSD_PARSE_CONCURRENCY);
  assert.equal(psdUploadUrlExpiresSec, env.PSD_UPLOAD_URL_EXPIRES_SEC);
  // 范围合理性（即便 .env 覆盖了默认值，仍须落在合法区间）
  assert.ok(env.MAX_PSD_SIZE_MB >= 1 && env.MAX_PSD_SIZE_MB <= 500);
  assert.ok(psdParseConcurrency >= 1 && psdParseConcurrency <= 8);
  assert.ok(psdParseTimeoutMs >= 30000 && psdParseTimeoutMs <= 600000);
  assert.ok(psdUploadUrlExpiresSec >= 60 && psdUploadUrlExpiresSec <= 3600);
});
