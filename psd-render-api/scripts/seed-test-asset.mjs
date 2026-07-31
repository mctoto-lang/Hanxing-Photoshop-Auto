/**
 * 创建一个已验证的测试 artifact，用于渲染任务测试
 */
import { prisma } from '../dist/lib/prisma.js';
import { createHash } from 'node:crypto';

const sha256 = createHash('sha256').update('test-image-content').digest('hex');
const now = new Date();
const expiresAt = new Date(now.getTime() + 86400000); // 1 天后过期

const artifact = await prisma.artifact.create({
  data: {
    code: 'art_test_' + Date.now(),
    jobId: null,
    kind: 'input',
    objectKey: `input/test_${Date.now()}.png`,
    sha256: sha256,
    mimeType: 'image/png',
    sizeBytes: 1024,
    originalName: 'test.png',
    expiresAt: expiresAt,
    tenantId: 'default',
  },
});

console.log('Created test artifact:', artifact.code);
console.log('  sha256:', artifact.sha256.slice(0, 32) + '...');
console.log('  tenantId:', artifact.tenantId);
await prisma.$disconnect();
