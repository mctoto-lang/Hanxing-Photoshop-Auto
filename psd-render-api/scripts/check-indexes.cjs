const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // 检查 AdminSession 索引
  const idx = await p.$queryRawUnsafe('PRAGMA index_list("AdminSession")');
  console.log('AdminSession 索引:');
  idx.forEach((i) => console.log('  -', i.name, i.unique ? '[UNIQUE]' : ''));

  // 检查现有 session 记录
  const sessions = await p.$queryRawUnsafe('SELECT id, token, tokenHash, expiresAt FROM AdminSession LIMIT 5');
  console.log('\n现有 session 记录:', sessions.length);
  sessions.forEach((s) => console.log('  - id:', s.id, 'tokenHash:', s.tokenHash, 'expiresAt:', s.expiresAt));

  // 清理过期 session
  const deleted = await p.$executeRawUnsafe('DELETE FROM AdminSession WHERE expiresAt < datetime("now")');
  console.log('\n清理过期 session:', deleted, '条');

  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
