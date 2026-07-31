const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // 停用所有 DB API Key，使 env.API_KEY 回落生效
  const result = await p.apiKey.updateMany({
    where: { active: true },
    data: { active: false },
  });
  console.log(`已停用 ${result.count} 个 API Key，env 回落将生效`);

  // 验证
  const activeCount = await p.apiKey.count({ where: { active: true } });
  console.log('剩余 active API Key:', activeCount);

  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
