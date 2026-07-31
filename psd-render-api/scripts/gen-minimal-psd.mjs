// Minimal PSD generator: produce a tiny RGB PSD with embedded preview image
// for testing psd-parser.generateThumbnail() (Phase 3 M8).
//
// Layout:
//   1. File Header (26 bytes) - signature '8BPS', version 1, 3 channels RGB,
//      16x16, depth 8, mode 3 (RGB)
//   2. Color Mode Data - length=0
//   3. Image Resources - length=0
//   4. Layer and Mask Info - length=0
//   5. Image Data - compression=0 (raw), then 3 channels of 16x16 = 768 bytes
//
// psd.js parses the trailing Image Data block as the preview image and exposes
// it via psd.image.saveAsPng().

import { promises as fs } from 'node:fs';
import path from 'node:path';

function writeUint32BE(buf, value, offset) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
  return offset + 4;
}

function writeUint16BE(buf, value, offset) {
  buf[offset] = (value >>> 8) & 0xff;
  buf[offset + 1] = value & 0xff;
  return offset + 2;
}

function generateMinimalPsd(width = 16, height = 16) {
  const channels = 3;
  const depth = 8;
  const mode = 3; // RGB

  // Image data: compression(2) + raw channel data (channels * width * height)
  const imageDataSize = 2 + channels * width * height;

  // Total size: header(26) + colormode(4) + resources(4) + layermask(4) + imageData
  const totalSize = 26 + 4 + 4 + 4 + imageDataSize;
  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Header
  buf.write('8BPS', offset); offset += 4;            // signature
  offset = writeUint16BE(buf, 1, offset);             // version
  for (let i = 0; i < 6; i++) buf[offset++] = 0;      // reserved
  offset = writeUint16BE(buf, channels, offset);      // channels
  offset = writeUint32BE(buf, height, offset);        // height
  offset = writeUint32BE(buf, width, offset);         // width
  offset = writeUint16BE(buf, depth, offset);         // depth
  offset = writeUint16BE(buf, mode, offset);          // mode

  // Color Mode Data
  offset = writeUint32BE(buf, 0, offset);

  // Image Resources
  offset = writeUint32BE(buf, 0, offset);

  // Layer and Mask Information
  offset = writeUint32BE(buf, 0, offset);

  // Image Data
  offset = writeUint16BE(buf, 0, offset); // compression: 0 = raw

  // Channel data: R first, then G, then B. Fill with simple gradient pattern.
  for (let c = 0; c < channels; c++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        // channel-specific color value
        let v;
        if (c === 0) v = (x * 16) & 0xff;        // R: horizontal gradient
        else if (c === 1) v = (y * 16) & 0xff;   // G: vertical gradient
        else v = ((x + y) * 8) & 0xff;           // B: diagonal gradient
        buf[offset++] = v;
      }
    }
  }

  return buf;
}

async function main() {
  const outPath = path.resolve('test-thumbnail.psd');
  const buf = generateMinimalPsd(16, 16);
  await fs.writeFile(outPath, buf);
  console.log(`[OK] Generated minimal PSD: ${outPath} (${buf.length} bytes)`);

  // Verify with psd.js that image preview can be extracted
  const PSD = (await import('psd')).default;
  const psd = PSD.fromFile(outPath);
  psd.parse();
  console.log('[OK] psd.parse() succeeded');
  console.log('  header cols/rows:', psd.header?.cols, psd.header?.rows);
  console.log('  has image:', !!psd.image);
  console.log('  image width/height:', psd.image?.width?.(), psd.image?.height?.());

  // Export PNG to verify
  const pngPath = path.resolve('test-thumbnail-raw.png');
  await psd.image.saveAsPng(pngPath);
  const stat = await fs.stat(pngPath);
  console.log(`[OK] saveAsPng wrote ${stat.size} bytes to ${pngPath}`);

  console.log('\n[DONE] Minimal PSD is ready for thumbnail test');
}

main().catch((e) => {
  console.error('[FAIL]', e);
  process.exit(1);
});
