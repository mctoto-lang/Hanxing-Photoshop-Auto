const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // 检查 AdminSession 表结构
  const cols = await p.$queryRawUnsafe('PRAGMA table_info("AdminSession")');
  console.log('AdminSession 列:');
  cols.forEach((c) => console.log('  -', c.name, c.type, c.notnull ? 'NOT NULL' : 'NULL'));

  // 检查 Worker 表是否有 accessTokenHash
  const wcols = await p.$queryRawUnsafe('PRAGMA table_info("Worker")');
  console.log('\nWorker 列:');
  wcols.forEach((c) => console.log('  -', c.name, c.type));

  // 检查迁移状态
  const migrations = await p.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at');
  console.log('\n迁移状态:');
  migrations.forEach((m) => console.log('  -', m.migration_name, m.finished_at ? '[完成]' : '[未完成]', m.rolled_back_at ? '[已回滚]' : ''));

  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
