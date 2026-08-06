import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildNode } from './psd-worker.js';

const workerSrc = readFileSync(
  fileURLToPath(new URL('./psd-worker.ts', import.meta.url)),
  'utf-8',
);

test('缩略图生成优先用 ag-psd 读取合成图 + Resource 1036', () => {
  // 原方案用 psd 包读 Image Data Section（合并合成图），但部分 PSD 该区域
  // 不完整/过时，导致缩略图仅显示残缺内容（如倾斜长方形 + 大面积透明）。
  // 新方案用 ag-psd：先试合成图（高分辨率），残缺时回退到 Resource 1036。
  assert.match(workerSrc, /from 'ag-psd'/);
  assert.match(workerSrc, /generateThumbnailWithAgPsd/);
  assert.match(workerSrc, /imageResources\?\.thumbnail/);
});

test('缩略图合成图残缺时（覆盖率 < 50%）回退到 Resource 1036', () => {
  // 部分 PSD 的合成图不完整/过时，需检测覆盖率后跳过
  assert.match(workerSrc, /computeOpaqueCoverage/);
  assert.match(workerSrc, /coverage > 0\.5/);
});

test('缩略图回退到 psd 包的 Image Data Section（兼容 ag-psd 失败的情况）', () => {
  assert.match(workerSrc, /saveAsPng/);
});

test('缩略图统一压白底，避免透明区域在深色 UI 上显示为棋盘格', () => {
  assert.match(workerSrc, /flatten\(\s*\{\s*background:\s*'#ffffff'\s*\}\s*\)/);
});

test('缩略图默认尺寸为 800×800 正方形，匹配 PSD 画布比例', () => {
  // 原 640×480（4:3）不匹配方形画布；改为 800×800 正方形
  assert.match(workerSrc, /maxWidth \?\? 800/);
  assert.match(workerSrc, /resize\(\s*\{\s*width:\s*maxWidth,\s*height:\s*maxWidth,\s*fit:\s*'inside'/);
});

test('从 PSD 文字层导出数据识别类型并提取 sourceFontNames', () => {
  const node = buildNode({
    name: () => '标题',
    layer: { id: 12 },
    export: () => ({
      text: {
        value: '新品上市',
        font: { names: ['SourceHanSansCN-Bold', ' SourceHanSansCN-Bold ', '', 'ArialMT'] },
      },
    }),
  }, '', new Map(), 0, { count: 1 });

  assert.equal(node?.type, 'text');
  assert.equal(node?.defaultText, '新品上市');
  assert.deepEqual(node?.sourceFontNames, ['SourceHanSansCN-Bold', 'ArialMT']);
});
