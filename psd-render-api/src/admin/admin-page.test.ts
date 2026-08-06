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

test('新建图片绑定默认使用 stretch 完全铺满目标图层', () => {
  const toggleBinding = adminPageHtml.match(/function toggleBinding\(enabled\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.match(toggleBinding, /fit: isImageType \? 'stretch' : undefined/);
});

test('后台测试任务支持 JSX 超时秒数', () => {
  assert.match(adminPageHtml, /jsxTimeoutSeconds/);
});

test('测试模板列表返回所有租户的已发布模板', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./admin-write-routes.ts', import.meta.url), 'utf-8');
  const templatesRoute = src.match(/app\.get\('\/api\/test\/templates'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  assert.doesNotMatch(templatesRoute, /tenantId: 'admin-test'/);
});

test('测试渲染任务使用所选模板所属租户创建', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./admin-write-routes.ts', import.meta.url), 'utf-8');
  const renderRoute = src.match(/app\.post\('\/api\/test\/render-jobs'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  assert.match(renderRoute, /templateVersion\.template\.tenantId/);
});

test('最近任务列表 template 字段 schema 为 string，避免 [object Object]', async () => {
  // handler 返回 j.templateVersion.template.name（字符串），
  // 若 schema 声明为 type:'object'，fast-json-stringify 会按字符索引
  // 把字符串序列化为 {"0":"挂",...} 对象，前端 escapeHtml 后显示 [object Object]
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./admin-routes.ts', import.meta.url), 'utf-8');
  const jobsRoute = src.match(/app\.get\('\/api\/jobs'[\s\S]*?\n  \}\);/)?.[0] ?? '';
  assert.match(jobsRoute, /template:\s*\{\s*type:\s*'string'/);
  assert.doesNotMatch(jobsRoute, /template:\s*\{\s*type:\s*'object'/);
});

test('字体管理支持选择已发布字体作为全局兜底字体', () => {
  assert.match(adminPageHtml, /\/admin\/api\/font-settings/);
  assert.match(adminPageHtml, /fallbackFontVersionId/);
  assert.match(adminPageHtml, /全局兜底字体/);
});

test('最近成功任务为有效结果显示下载按钮', () => {
  const loadJobs = adminPageHtml.match(/async function loadJobs\(\) \{[\s\S]*?\n    \}/)?.[0] ?? '';
  assert.match(loadJobs, /resultAvailable/);
  assert.match(loadJobs, /\/admin\/api\/jobs\//);
  assert.match(loadJobs, /下载结果/);
});

test('文字图层展示 PSD 源字体名称', () => {
  assert.match(adminPageHtml, /sourceFontNames/);
  assert.match(adminPageHtml, /PSD 字体/);
});
