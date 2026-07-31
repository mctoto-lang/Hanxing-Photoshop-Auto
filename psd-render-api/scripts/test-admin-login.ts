import { prisma } from '../src/lib/prisma.js';
import bcrypt from 'bcryptjs';
import { adminAuthService } from '../src/services/admin/admin-auth-service.js';

async function main() {
  // 1. 直接查询用户
  const u = await prisma.adminUser.findUnique({ where: { username: 'admin' } });
  console.log('[1] 用户查询:', u ? 'found' : 'not found', 'active:', u?.active);
  if (!u) { await prisma.$disconnect(); return; }

  // 2. bcrypt 校验
  const ok = await bcrypt.compare('Admin@2026!', u.passwordHash);
  console.log('[2] bcrypt.compare 结果:', ok);
  console.log('[2] hash 前缀:', u.passwordHash.slice(0, 30));

  // 3. 通过 adminAuthService.login 测试
  try {
    const result = await adminAuthService.login({
      username: 'admin',
      password: 'Admin@2026!',
      ip: '127.0.0.1',
      userAgent: 'test-script',
    });
    console.log('[3] adminAuthService.login 成功:', result.user.username);
    console.log('[3] token:', result.token.slice(0, 16) + '...');
  } catch (e: any) {
    console.log('[3] adminAuthService.login 失败:', e.message, '(code:', e.code + ')');
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
