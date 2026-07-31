/**
 * 数据库切换脚本
 * 用法：
 *   node scripts/switch-db.mjs postgres   # 切换到 PostgreSQL
 *   node scripts/switch-db.mjs sqlite     # 切换回 SQLite
 *
 * 实际操作：将 prisma/schema.{provider}.prisma 复制为 prisma/schema.prisma
 * 切换后需要重新运行 prisma generate 和 prisma migrate
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prismaDir = path.resolve(__dirname, '..', 'prisma');
const targetPath = path.join(prismaDir, 'schema.prisma');

const providers = {
  sqlite: path.join(prismaDir, 'schema.sqlite.prisma'),
  postgres: path.join(prismaDir, 'schema.postgres.prisma'),
};

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  const target = process.argv[2];
  if (!target || !providers[target]) {
    console.error(`用法: node scripts/switch-db.mjs <${Object.keys(providers).join('|')}>`);
    process.exit(1);
  }

  const sourcePath = providers[target];
  if (!(await fileExists(sourcePath))) {
    console.error(`源 schema 不存在: ${sourcePath}`);
    process.exit(1);
  }

  const content = await fs.readFile(sourcePath, 'utf8');
  await fs.writeFile(targetPath, content, 'utf8');
  console.log(`✓ 已切换 Prisma provider 到 ${target}`);
  console.log(`  ${targetPath}`);
  console.log('');
  console.log('下一步：');
  if (target === 'postgres') {
    console.log('  1. 设置 DATABASE_URL=postgresql://user:pass@host:5432/db');
    console.log('  2. npm run prisma:migrate:pg');
  } else {
    console.log('  1. 设置 DATABASE_URL="file:./dev.db"');
    console.log('  2. npm run prisma:migrate');
  }
  console.log('  3. npm run prisma:generate');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
