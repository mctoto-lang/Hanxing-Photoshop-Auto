const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

p.$queryRawUnsafe('SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at')
  .then((r) => {
    console.log('已应用迁移:');
    r.forEach((m) => console.log(' -', m.migration_name, m.finished_at ? '[完成]' : '[未完成]'));
    return p.$disconnect();
  })
  .catch((e) => { console.error(e); process.exit(1); });
