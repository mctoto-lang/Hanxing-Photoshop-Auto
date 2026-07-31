/**
 * 临时脚本：查询 AdminUser 表用于测试
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.adminUser.findMany({
    select: { id: true, username: true, role: true, active: true, createdAt: true, lastLoginAt: true },
  });
  console.log('AdminUsers:', JSON.stringify(users, null, 2));

  const apiKeys = await prisma.apiKey.findMany({
    select: { id: true, name: true, active: true, tenantId: true, keyPrefix: true },
  });
  console.log('ApiKeys:', JSON.stringify(apiKeys, null, 2));

  const templates = await prisma.template.findMany({
    select: { id: true, code: true, name: true, status: true, tenantId: true },
  });
  console.log('Templates:', JSON.stringify(templates, null, 2));

  const workers = await prisma.worker.findMany({
    select: { id: true, code: true, name: true, status: true, sessionActive: true, lastHeartbeatAt: true },
  });
  console.log('Workers:', JSON.stringify(workers, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
