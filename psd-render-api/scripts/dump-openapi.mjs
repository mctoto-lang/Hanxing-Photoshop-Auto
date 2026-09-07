// Dump current OpenAPI JSON by starting the server briefly and fetching /docs/json
// Usage: node scripts/dump-openapi.mjs
import { writeFileSync } from 'node:fs';

const BASE = process.env.OPENAPI_BASE ?? 'http://127.0.0.1:3000';

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Server did not become ready in time');
}

async function main() {
  console.log('Waiting for server at', BASE, '...');
  await waitForServer();
  console.log('Server is up, fetching /docs/json ...');
  const r = await fetch(`${BASE}/docs/json`);
  if (!r.ok) {
    throw new Error(`/docs/json returned ${r.status}`);
  }
  const openapi = await r.json();
  writeFileSync('openapi-current.json', JSON.stringify(openapi, null, 2), 'utf8');
  const paths = Object.keys(openapi.paths || {}).sort();
  console.log('=== OpenAPI Paths ===');
  for (const p of paths) {
    const methods = Object.keys(openapi.paths[p]);
    console.log(`  ${methods.map((m) => m.toUpperCase()).join(',').padEnd(12)} ${p}`);
  }
  console.log(`\nTotal paths: ${paths.length}`);
  let totalOps = 0;
  let withSummary = 0;
  let withTags = 0;
  let withDescription = 0;
  for (const p of paths) {
    for (const m of Object.keys(openapi.paths[p])) {
      totalOps++;
      const op = openapi.paths[p][m];
      if (op.summary) withSummary++;
      if (op.tags && op.tags.length) withTags++;
      if (op.description) withDescription++;
    }
  }
  console.log(`Total operations: ${totalOps}`);
  console.log(`  With summary:     ${withSummary}`);
  console.log(`  With tags:        ${withTags}`);
  console.log(`  With description: ${withDescription}`);
  console.log('\nOpenAPI JSON saved to openapi-current.json');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
