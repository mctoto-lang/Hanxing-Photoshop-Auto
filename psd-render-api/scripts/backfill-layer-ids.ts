/**
 * 存量数据回填脚本：修复 layerId=0 历史数据
 *
 * 背景：psd-worker.ts 的 LazyExecute 懒加载 bug 导致历史上所有模板解析出的
 * layerId 恒为 0，已固化在 TemplateVersion.layerTree / layerSchema 及 LayerBinding
 * 表中。解析器修复后仅新上传模板受益，本脚本对存量模板重新解析 PSD 并按
 * layerPath 精确匹配回填 layerId（仅更新技术字段，不改变绑定语义）。
 *
 * 用法：
 *   npx tsx scripts/backfill-layer-ids.ts            # dry-run（默认，仅输出报告）
 *   npx tsx scripts/backfill-layer-ids.ts --apply    # 实际写库
 *   npx tsx scripts/backfill-layer-ids.ts --apply --template-id <id>  # 只处理指定模板
 *
 * 安全措施：
 *   - 下载 PSD 后校验 sha256 与版本记录一致，不一致则跳过（防止 PSD 已被替换，
 *     新旧图层树不对应导致错误回填）
 *   - 仅回填 layerId=0 的节点/绑定；layerPath 匹配不上的保持原值并告警
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prisma } from '../src/lib/prisma.js';
import { getStorage } from '../src/services/storage/index.js';
import { psdParser } from '../src/services/psd-parser/psd-parser.js';
import type { LayerNode } from '../src/types/index.js';

interface FlatRef {
  layerPath: string;
  layerId: number;
}

function flattenTree(nodes: LayerNode[], out: FlatRef[] = []): FlatRef[] {
  for (const n of nodes) {
    out.push({ layerPath: n.layerPath, layerId: n.layerId });
    if (n.children?.length) flattenTree(n.children, out);
  }
  return out;
}

/** 递归回填树节点，返回更新数量 */
function backfillNodes(nodes: LayerNode[], pathToId: Map<string, number>): { updated: number; unmatched: string[] } {
  let updated = 0;
  const unmatched: string[] = [];
  const walk = (list: LayerNode[]) => {
    for (const n of list) {
      if (n.layerId === 0) {
        const id = pathToId.get(n.layerPath);
        if (id !== undefined) {
          n.layerId = id;
          updated += 1;
        } else {
          unmatched.push(n.layerPath);
        }
      }
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return { updated, unmatched };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const templateIdArgIdx = process.argv.indexOf('--template-id');
  const templateIdFilter = templateIdArgIdx >= 0 ? process.argv[templateIdArgIdx + 1] : undefined;

  console.log(`模式: ${apply ? 'APPLY（写库）' : 'DRY-RUN（仅报告）'}${templateIdFilter ? ` | 模板过滤: ${templateIdFilter}` : ''}\n`);

  const storage = await getStorage();

  const templates = await prisma.template.findMany({
    where: templateIdFilter ? { id: templateIdFilter } : undefined,
    select: { id: true, name: true },
  });
  console.log(`模板数: ${templates.length}`);

  let totalVersions = 0;
  let totalUpdatedNodes = 0;
  let totalUpdatedBindings = 0;
  let skipped = 0;

  for (const tpl of templates) {
    const versions = await prisma.templateVersion.findMany({
      where: { templateId: tpl.id },
      orderBy: { version: 'asc' },
    });
    const latest = versions.at(-1);

    for (const ver of versions) {
      // 跳过无需回填的版本
      let tree: LayerNode[];
      try {
        tree = JSON.parse(ver.layerTree);
      } catch {
        console.log(`  ✗ 模板 ${tpl.name} 版本 v${ver.version}: layerTree JSON 解析失败，跳过`);
        skipped += 1;
        continue;
      }
      const flat = flattenTree(tree);
      if (!flat.some((n) => n.layerId === 0)) continue;

      totalVersions += 1;

      // 下载 PSD 并校验 sha256
      let buf: Buffer;
      try {
        buf = await storage.getObject(ver.psdObjectKey);
      } catch (e) {
        console.log(`  ✗ 模板 ${tpl.name} 版本 v${ver.version}: PSD 下载失败 (${(e as Error).message})，跳过`);
        skipped += 1;
        continue;
      }
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (ver.psdSha256 && sha !== ver.psdSha256) {
        console.log(`  ✗ 模板 ${tpl.name} 版本 v${ver.version}: PSD sha256 与版本记录不一致（文件可能已变更），跳过`);
        skipped += 1;
        continue;
      }

      // 写临时文件并走生产解析路径
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'backfill-psd-'));
      const tmpFile = path.join(tmpDir, 'template.psd');
      try {
        await fs.writeFile(tmpFile, buf);
        const parsed = await psdParser.parse({
          templateId: tpl.id,
          templateVersionId: ver.id,
          filePath: tmpFile,
        });
        const pathToId = new Map(
          flattenTree(parsed.layerTree).filter((n) => n.layerId !== 0).map((n) => [n.layerPath, n.layerId]),
        );

        // 1) 回填 layerTree（先统计零值数——flattenTree 是值拷贝，回填后旧快照不更新）
        const zeroCount = flat.filter((n) => n.layerId === 0).length;
        const treeResult = backfillNodes(tree, pathToId);

        // 2) 回填 layerSchema 中的 bindings
        let schemaUpdated = 0;
        let schemaJson: string | null = null;
        if (ver.layerSchema) {
          try {
            const schema = JSON.parse(ver.layerSchema);
            if (Array.isArray(schema?.bindings)) {
              for (const b of schema.bindings) {
                if (b.layerId === 0) {
                  const id = pathToId.get(b.layerPath);
                  if (id !== undefined) {
                    b.layerId = id;
                    schemaUpdated += 1;
                  }
                }
              }
              schemaJson = JSON.stringify(schema);
            }
          } catch { /* layerSchema 非法则不动 */ }
        }

        console.log(
          `  ${apply ? '✓' : '[dry-run]'} 模板 ${tpl.name} 版本 v${ver.version}: 树节点回填 ${treeResult.updated}/${zeroCount}，绑定回填 ${schemaUpdated}` +
          (treeResult.unmatched.length ? `，⚠ 未匹配: ${treeResult.unmatched.join(', ')}` : ''),
        );

        if (apply) {
          await prisma.templateVersion.update({
            where: { id: ver.id },
            data: {
              layerTree: JSON.stringify(tree),
              ...(schemaJson ? { layerSchema: schemaJson } : {}),
            },
          });
        }
        totalUpdatedNodes += treeResult.updated;
        totalUpdatedBindings += schemaUpdated;

        // 3) 最新版本：同步回填 LayerBinding 表（按模板作用域）。
        //    使用内存中已回填的树建立映射，避免重新查询拿到旧值。
        if (ver.id === latest?.id) {
          const flatUpdated = flattenTree(tree).filter((n) => n.layerId !== 0);
          if (flatUpdated.length > 0) {
            const pathToId = new Map(flatUpdated.map((n) => [n.layerPath, n.layerId]));
            const zeroBindings = await prisma.layerBinding.findMany({ where: { templateId: tpl.id, layerId: 0 } });
            let bindingRows = 0;
            for (const b of zeroBindings) {
              const id = pathToId.get(b.layerPath);
              if (id !== undefined) {
                if (apply) {
                  await prisma.layerBinding.update({ where: { id: b.id }, data: { layerId: id } });
                }
                bindingRows += 1;
              }
            }
            if (bindingRows > 0) {
              console.log(`  ${apply ? '✓' : '[dry-run]'} 模板 ${tpl.name} LayerBinding 行回填 ${bindingRows}/${zeroBindings.length}`);
            }
          }
        }
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  console.log(`\n汇总: 处理版本 ${totalVersions}，回填树节点 ${totalUpdatedNodes} 个、绑定 ${totalUpdatedBindings} 个，跳过 ${skipped} 个版本`);
  if (!apply) console.log('（dry-run 未写库；确认无误后加 --apply 执行）');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
