// 插入一个 DRAFT 状态的测试模板，用于验证 M5 图层绑定 UI
import { prisma } from '../dist/lib/prisma.js';
import { genTemplateCode, genTemplateVersionCode } from '../dist/lib/crypto.js';

async function main() {
  // 先清理旧的测试模板
  const existing = await prisma.template.findFirst({ where: { name: 'M5测试模板' } });
  if (existing) {
    await prisma.layerBinding.deleteMany({ where: { templateId: existing.id } });
    await prisma.templateVersion.deleteMany({ where: { templateId: existing.id } });
    await prisma.template.delete({ where: { id: existing.id } });
    console.log('已清理旧测试模板');
  }

  // 创建模板（DRAFT）
  const template = await prisma.template.create({
    data: {
      code: genTemplateCode(),
      name: 'M5测试模板',
      status: 'DRAFT',
    },
  });

  // 简单图层树：1 个 group + 2 个 smartObject + 1 个 text
  const layerTree = [
    {
      layerId: 10,
      layerPath: '/背景组',
      name: '背景组',
      type: 'group',
      visible: true,
      children: [
        {
          layerId: 11,
          layerPath: '/背景组/主图',
          name: '主图',
          type: 'smartObject',
          visible: true,
          bounds: { top: 0, left: 0, bottom: 800, right: 600 },
        },
        {
          layerId: 12,
          layerPath: '/背景组/副图',
          name: '副图',
          type: 'smartObject',
          visible: true,
          bounds: { top: 100, left: 50, bottom: 400, right: 350 },
        },
      ],
    },
    {
      layerId: 20,
      layerPath: '/标题文字',
      name: '标题文字',
      type: 'text',
      visible: true,
      defaultText: '请输入标题',
      bounds: { top: 820, left: 0, bottom: 900, right: 600 },
    },
    {
      layerId: 30,
      layerPath: '/装饰像素层',
      name: '装饰像素层',
      type: 'pixel',
      visible: true,
    },
  ];

  const version = await prisma.templateVersion.create({
    data: {
      code: genTemplateVersionCode(),
      templateId: template.id,
      version: 1,
      psdObjectKey: 'psd/test_m5.psd',
      psdSha256: '0'.repeat(64),
      psMinVersion: '25.0',
      layerTree: JSON.stringify(layerTree),
      layerSchema: JSON.stringify({ bindings: [] }),
      canvasWidth: 600,
      canvasHeight: 900,
      published: false,
    },
  });

  console.log('测试模板已创建:');
  console.log('  templateId:', template.id);
  console.log('  code:', template.code);
  console.log('  versionId:', version.id);
  console.log('  layerTree nodes:', layerTree.length, '(顶层)');

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});
