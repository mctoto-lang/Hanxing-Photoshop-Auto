import { promises as fs } from 'node:fs';
import path from 'node:path';
import PSD from 'psd';

async function main() {
  const psdDir = path.resolve('storage/psd');
  const files = await fs.readdir(psdDir);

  for (const file of files) {
    if (!file.endsWith('.psd')) continue;
    const fullPath = path.join(psdDir, file);
    try {
      const psd = PSD.fromFile(fullPath);
      psd.parse();
      const tree = psd.tree();
      const flat = flattenTree(tree.children());
      const textLayers = flat.filter((n: any) => n.type === 'text' || (n.text && n.text()));
      const smartObjects = flat.filter((n: any) => n.type === 'smartObject' || n.smartObject);
      console.log(`${file}:`);
      console.log(`  总层数: ${flat.length}, 文字层: ${textLayers.length}, 智能对象: ${smartObjects.length}`);
      if (textLayers.length > 0) {
        console.log(`  ✓ 有文字层（可用于 E2E 测试）`);
      }
    } catch (e) {
      console.log(`${file}: 解析失败 - ${(e as Error).message}`);
    }
  }
}

function flattenTree(nodes: any[]): any[] {
  const result: any[] = [];
  for (const n of nodes) {
    result.push(n);
    if (n.children?.length) result.push(...flattenTree(n.children()));
  }
  return result;
}

main().catch(console.error);
