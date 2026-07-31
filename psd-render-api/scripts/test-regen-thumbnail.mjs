// End-to-end test: regenerate thumbnail for an existing template
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

// Find a PUBLISHED template with thumbnailObjectKey set
const ts = await p.template.findMany({
  where: { status: 'PUBLISHED' },
  include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
});
const t = ts.find(x => x.versions[0]?.thumbnailObjectKey);
if (!t) { console.log('No template with thumbnailObjectKey found'); process.exit(0); }

console.log('Template:', t.id, '|', t.name);
console.log('Current thumbnailObjectKey:', t.versions[0].thumbnailObjectKey);

// Dynamically import the templateService from dist
const { templateService } = await import('../dist/services/template/template-service.js');

// 1. Check that headObject returns null (file missing)
const { getStorage } = await import('../dist/services/storage/index.js');
const storage = await getStorage();
const meta = await storage.headObject(t.versions[0].thumbnailObjectKey).catch(() => null);
console.log('Before regen - file exists on disk:', !!meta);

// 2. Call getThumbnailDownloadUrl - should auto-clear the broken reference
console.log('\n--- Calling getThumbnailDownloadUrl (should clear broken ref) ---');
const url1 = await templateService.getThumbnailDownloadUrl(t.id);
console.log('Result:', url1);

// 3. Check the DB - thumbnailObjectKey should be cleared
const tAfter = await p.template.findUnique({
  where: { id: t.id },
  include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
});
console.log('After getThumbnailDownloadUrl - thumbnailObjectKey:', tAfter.versions[0].thumbnailObjectKey);

// 4. Regenerate the thumbnail
console.log('\n--- Calling regenerateThumbnail ---');
try {
  const result = await templateService.regenerateThumbnail(t.id);
  console.log('Regen result:', result);
} catch (e) {
  console.error('Regen failed:', e.message);
}

// 5. Verify the thumbnail now exists
const tFinal = await p.template.findUnique({
  where: { id: t.id },
  include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
});
console.log('\nFinal thumbnailObjectKey:', tFinal.versions[0].thumbnailObjectKey);
const metaFinal = await storage.headObject(tFinal.versions[0].thumbnailObjectKey).catch(() => null);
console.log('Final file exists on disk:', !!metaFinal);
if (metaFinal) console.log('Final file size:', metaFinal.size, 'bytes');

// 6. Get the download URL - should work now
const url2 = await templateService.getThumbnailDownloadUrl(t.id);
console.log('Final downloadUrl:', url2?.downloadUrl?.slice(0, 80) + '...');

await p.$disconnect();
