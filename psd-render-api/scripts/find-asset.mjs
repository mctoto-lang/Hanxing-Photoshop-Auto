import { prisma } from '../dist/lib/prisma.js';

// 找一个已上传的 input artifact
const artifacts = await prisma.artifact.findMany({
  where: { kind: 'input', tenantId: 'default' },
  take: 5,
  orderBy: { createdAt: 'desc' },
});
console.log('Recent input artifacts:');
for (const a of artifacts) {
  console.log(`  ${a.code} | sha256=${a.sha256?.slice(0,16)} | size=${a.sizeBytes} | mime=${a.mimeType} | name=${a.originalName}`);
}

// 也找一下 output artifact
const outputs = await prisma.artifact.findMany({
  where: { kind: 'output', tenantId: 'default' },
  take: 3,
  orderBy: { createdAt: 'desc' },
});
console.log('\nRecent output artifacts:');
for (const a of outputs) {
  console.log(`  ${a.code} | sha256=${a.sha256?.slice(0,16)} | size=${a.sizeBytes} | mime=${a.mimeType}`);
}

await prisma.$disconnect();
