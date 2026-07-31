import { prisma } from '../dist/lib/prisma.js';
const cfg = await prisma.storageConfig.findFirst();
console.log('StorageConfig:', JSON.stringify(cfg, null, 2));
await prisma.$disconnect();
