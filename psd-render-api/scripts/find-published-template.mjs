import { prisma } from '../dist/lib/prisma.js';

// 找一个已发布的模板版本
const tv = await prisma.templateVersion.findFirst({
  where: { published: true },
  include: { template: { include: { bindings: true } } },
});
if (tv) {
  console.log('Found published template version:');
  console.log('  versionId (use as templateVersionId):', tv.id);
  console.log('  code:', tv.code);
  console.log('  templateId:', tv.templateId);
  console.log('  templateName:', tv.template.name);
  console.log('  version:', tv.version);
  console.log('  published:', tv.published);
  console.log('  bindings count:', tv.template.bindings.length);
  if (tv.template.bindings.length > 0) {
    console.log('  first binding:', JSON.stringify(tv.template.bindings[0], null, 2));
  }
} else {
  console.log('No published template version found');
  const all = await prisma.templateVersion.findMany({ take: 10, include: { template: true } });
  console.log('All template versions (up to 10):');
  for (const v of all) {
    console.log(`  ${v.id} | published=${v.published} | template=${v.template.name} v${v.version} | tenant=${v.template.tenantId}`);
  }
}
await prisma.$disconnect();
