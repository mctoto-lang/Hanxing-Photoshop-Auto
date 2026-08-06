import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('三份 Prisma schema 均定义字体全局兜底配置及关系', () => {
  for (const path of [
    'prisma/schema.prisma',
    'prisma/schema.sqlite.prisma',
    'prisma/schema.postgres.prisma',
  ]) {
    const source = read(path);
    assert.match(source, /model FontConfig\s*\{/);
    assert.match(source, /fallbackFontVersionId\s+String\?/);
    assert.match(source, /fallbackFontVersion\s+FontVersion\?/);
    assert.match(source, /fontConfig\s+FontConfig\?/);
  }
});

test('SQLite 和 PostgreSQL 均提供字体全局兜底迁移', () => {
  const sqlite = read('prisma/migrations/20260806120000_font_fallback_config/migration.sql');
  const postgres = read('prisma/migrations-pg/20260806120000_font_fallback_config/migration.sql');
  assert.match(sqlite, /CREATE TABLE "FontConfig"/);
  assert.match(sqlite, /REFERENCES "FontVersion"/);
  assert.match(postgres, /CREATE TABLE "FontConfig"/);
  assert.match(postgres, /REFERENCES "FontVersion"/);
});

test('后台 API 提供字体兜底配置读取和更新端点', () => {
  const source = read('src/admin/admin-write-routes.ts');
  assert.match(source, /app\.get\('\/api\/font-settings'/);
  assert.match(source, /app\.put\('\/api\/font-settings'/);
  assert.match(source, /fallbackFontVersionId/);
});

test('字体禁用和删除均保护全局兜底引用', () => {
  const source = read('src/services/font/font-service.ts');
  const matches = source.match(/fallbackFontVersionId:\s*fontVersionId/g) ?? [];
  assert.ok(matches.length >= 2);
  assert.match(source, /全局兜底字体/);
});

test('字体禁用和删除均保护模板图层显式引用', () => {
  const source = read('src/services/font/font-service.ts');
  const matches = source.match(/defaultFontVersionId:\s*fontVersionId/g) ?? [];
  assert.ok(matches.length >= 2);
  assert.match(source, /被 .* 个图层绑定引用/);
});

test('任务 manifest 单独传递兜底字体且不覆盖文本绑定字体', () => {
  const source = read('src/services/render-job/job-service.ts');
  assert.match(source, /fallbackFontVersionId,/);
  assert.doesNotMatch(source, /b\.type === 'text' && !b\.defaultFontVersionId/);
  assert.match(source, /id:\s*\{\s*in:/);
  assert.doesNotMatch(source, /fontVersion\.findMany\(\{ where: \{ published: true \} \}\)/);
});

test('全量字体 manifest 的 OpenAPI 契约与 fileUrl 和 fileToken 一致', () => {
  const source = read('src/routes/internal/fonts.ts');
  assert.match(source, /fileUrl:\s*\{ type: 'string' \}/);
  assert.match(source, /fileToken:\s*\{ type: 'string' \}/);
  assert.doesNotMatch(source, /downloadUrl:\s*\{ type: 'string' \}/);
});
