/**
 * 诊断脚本：对指定 PSD 文件输出每层的 layerId 提取结果
 *
 * 走与模板上传完全相同的生产解析路径（psdParser.parse → worker_threads → buildNode），
 * 用于验证 layerId 提取是否正常（修复 layerId=0 问题前后的对比），以及日后排查
 * 模板图层解析问题。
 *
 * 用法：
 *   npx tsx scripts/diag-layer-id.ts <psd文件路径>
 */
import { psdParser } from '../src/services/psd-parser/psd-parser.js';

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('用法: npx tsx scripts/diag-layer-id.ts <psd文件路径>');
    process.exit(1);
  }

  const result = await psdParser.parse({
    templateId: 'diag',
    templateVersionId: 'diag',
    filePath,
  });

  console.log(`画布: ${result.canvas.width}x${result.canvas.height}\n`);

  let total = 0;
  let withId = 0;
  const walk = (nodes: typeof result.layerTree, indent: string) => {
    for (const n of nodes) {
      total += 1;
      if (n.layerId !== 0) withId += 1;
      console.log(`${indent}[${n.type}] ${n.name}  layerId=${n.layerId}  path=${n.layerPath}`);
      if (n.children?.length) walk(n.children, indent + '  ');
    }
  };
  walk(result.layerTree, '');

  console.log(`\n图层总数: ${total}，layerId 非零: ${withId}，layerId=0: ${total - withId}`);
  if (withId === 0 && total > 0) {
    console.log('⚠ 全部 layerId=0 —— 检查 LazyExecute 懒加载提取逻辑是否失效');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
