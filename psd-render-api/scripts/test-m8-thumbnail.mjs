// M8 thumbnail generation unit test
// Calls psdParser.generateThumbnail() with the minimal PSD file,
// verifies it returns a non-empty PNG buffer.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { psdParser } from '../dist/services/psd-parser/psd-parser.js';

async function main() {
  const psdPath = path.resolve('test-thumbnail.psd');
  console.log('[1] Calling psdParser.generateThumbnail() with:', psdPath);

  const thumbBuf = await psdParser.generateThumbnail({ filePath: psdPath, maxWidth: 320 });

  if (!thumbBuf || thumbBuf.length === 0) {
    console.error('[FAIL] generateThumbnail returned null/empty buffer');
    process.exit(1);
  }

  console.log('[OK] Thumbnail generated');
  console.log('  size (bytes):', thumbBuf.length);
  console.log('  PNG signature (first 8 bytes):', thumbBuf.slice(0, 8).toString('hex'));
  // PNG signature: 89 50 4e 47 0d 0a 1a 0a
  const isPng = thumbBuf[0] === 0x89 && thumbBuf[1] === 0x50 && thumbBuf[2] === 0x4e && thumbBuf[3] === 0x47;
  console.log('  is valid PNG signature:', isPng);
  if (!isPng) {
    console.error('[FAIL] Thumbnail buffer is not a PNG');
    process.exit(1);
  }

  // Save thumbnail for visual inspection
  const outPath = path.resolve('test-thumbnail-result.png');
  await fs.writeFile(outPath, thumbBuf);
  console.log('[OK] Thumbnail saved to:', outPath);

  // Test with smaller maxWidth
  const smallThumb = await psdParser.generateThumbnail({ filePath: psdPath, maxWidth: 80 });
  console.log('[OK] Small thumbnail (maxWidth=80) size:', smallThumb?.length, 'bytes');

  console.log('\n[DONE] M8 generateThumbnail() test passed');
}

main().catch((e) => {
  console.error('[FAIL]', e);
  process.exit(1);
});
