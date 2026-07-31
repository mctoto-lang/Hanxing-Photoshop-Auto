// M9 字体许可证管理测试
// 1. 创建无 licenseNote 的测试字体（published=false）
// 2. 用 admin API 尝试 publish → 应 400
// 3. 设置 licenseNote
// 4. 再次 publish → 应 200
import { prisma } from '../dist/lib/prisma.js';
import { genFontCode } from '../dist/lib/crypto.js';

async function main() {
  // 清理旧测试字体
  const old = await prisma.fontVersion.findFirst({ where: { familyName: 'M9测试字体' } });
  if (old) {
    await prisma.fontVersion.delete({ where: { id: old.id } });
    console.log('已清理旧测试字体');
  }

  // 创建无 licenseNote 的测试字体（模拟 register 无 licenseNote 的情况）
  const font = await prisma.fontVersion.create({
    data: {
      code: genFontCode(),
      familyName: 'M9测试字体',
      postscriptName: 'M9TestFont-Regular',
      style: 'Regular',
      fileObjectKey: 'fonts/test_m9.ttf',
      sha256: '0'.repeat(64),
      licenseNote: null,
      published: false, // M9：无 licenseNote 不自动发布
    },
  });
  console.log('测试字体已创建（无 licenseNote）:');
  console.log('  fontId:', font.id);
  console.log('  published:', font.published);
  console.log('  licenseNote:', font.licenseNote);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
