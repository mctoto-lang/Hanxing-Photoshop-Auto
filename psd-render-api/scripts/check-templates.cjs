const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // 查询模板
  const templates = await p.template.findMany({
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });

  for (const t of templates) {
    console.log(`\n模板: ${t.name} (${t.code})`);
    console.log(`  状态: ${t.status}`);
    const v = t.versions[0];
    if (v) {
      console.log(`  最新版本: v${v.version} (published=${v.published})`);
      console.log(`  templateVersionId: ${v.code}`);
      // 查询该版本的绑定
      try {
        const bindings = await p.layerBinding.findMany({ where: { templateVersionId: v.id } });
        console.log(`  图层绑定数: ${bindings.length}`);
        for (const b of bindings) {
          console.log(`    - ${b.bindingId} (type=${b.type}, required=${b.required}, layerPath=${b.layerPath})`);
        }
      } catch (e) {
        console.log(`  绑定查询失败: ${e.message}`);
      }
    }
  }

  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
