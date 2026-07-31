const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const keys = await p.apiKey.findMany({
    select: {
      id: true,
      keyPrefix: true,
      tenantId: true,
      active: true,
      scopes: true,
      rateLimitPerMin: true,
      quotaPerDay: true,
      quotaUsedDay: true,
      lastUsedAt: true,
    },
  });
  console.log('DB 中的 API Keys:');
  keys.forEach((k) => console.log(JSON.stringify(k, null, 2)));

  // 检查 active API key 数量
  const activeCount = await p.apiKey.count({ where: { active: true } });
  console.log('\nActive API Key 数量:', activeCount);

  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
