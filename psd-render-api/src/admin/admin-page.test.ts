import assert from 'node:assert/strict';
import test from 'node:test';
import { adminPageHtml } from './admin-page.js';

test('删除模板使用页面确认框而不是原生 confirm', () => {
  const deleteFunction = adminPageHtml.match(/async function tplDelete\(id\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.match(deleteFunction, /await showConfirm\(/);
  assert.doesNotMatch(deleteFunction, /\bconfirm\(/);
});

test('loadTestRender 加入 loadAll 定时刷新，避免 Worker 状态不同步', () => {
  const loadAllMatch = adminPageHtml.match(/async function loadAll\(\) \{[\s\S]*?\}/)?.[0] ?? '';
  assert.match(loadAllMatch, /loadTestRender/);
});

test('loadAll 定时刷新包含 loadTestRender', () => {
  const intervalLine = adminPageHtml.match(/setInterval\(loadAll.*\)/)?.[0] ?? '';
  assert.ok(intervalLine.length > 0, '应存在 setInterval(loadAll, ...) 定时刷新');
});

test('模板列表 API 过滤 DELETED 状态', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./admin-routes.ts', import.meta.url), 'utf-8');
  const templatesRoute = src.match(/app\.get\('\/api\/templates'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  assert.match(templatesRoute, /NOT: \{ status: 'DELETED' \}/);
});

test('全页面不使用原生 confirm，避免预览容器 React #185', () => {
  assert.doesNotMatch(adminPageHtml, /!confirm\(/);
});
