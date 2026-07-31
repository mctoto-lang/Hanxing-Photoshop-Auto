import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('production image installs the complete Prisma CLI dependency tree', () => {
  const packageJson = JSON.parse(read('package.json'));
  const dockerfile = read('Dockerfile');

  assert.equal(typeof packageJson.dependencies.prisma, 'string');
  assert.doesNotMatch(dockerfile, /COPY --from=builder \/app\/node_modules\/prisma/);
});

test('container exposes one application port and uses the liveness probe', () => {
  const dockerfile = read('Dockerfile');
  const compose = read('docker-compose.yml');

  assert.match(dockerfile, /^EXPOSE 3000$/m);
  assert.doesNotMatch(dockerfile, /EXPOSE 3000 3001/);
  assert.doesNotMatch(compose, /3001:3001/);
  assert.match(compose, /\/health\/live/);
  assert.doesNotMatch(compose, /container_name:/);
});

test('Docker base image and local package downloads support domestic mirrors', () => {
  const dockerfile = read('Dockerfile');
  const apiNpmrc = read('.npmrc');
  const workerNpmrc = read('../psd-render-worker/.npmrc');

  assert.match(dockerfile, /ARG NODE_IMAGE=/);
  assert.equal((dockerfile.match(/FROM \$\{NODE_IMAGE\}/g) ?? []).length, 2);
  assert.match(apiNpmrc, /^registry=https:\/\/registry\.npmmirror\.com$/m);
  assert.match(workerNpmrc, /^registry=https:\/\/registry\.npmmirror\.com$/m);
  assert.match(read('../psd-render-worker/scripts/build-pack.mjs'), /ELECTRON_MIRROR/);
  assert.match(read('../psd-render-worker/scripts/build-pack.mjs'), /ELECTRON_BUILDER_BINARIES_MIRROR/);
});

test('package manifests and lockfiles use the same root version', () => {
  const apiPackage = JSON.parse(read('package.json'));
  const apiLock = JSON.parse(read('package-lock.json'));
  const workerPackage = JSON.parse(read('../psd-render-worker/package.json'));
  const workerLock = JSON.parse(read('../psd-render-worker/package-lock.json'));

  assert.equal(apiLock.version, apiPackage.version);
  assert.equal(apiLock.packages[''].version, apiPackage.version);
  assert.equal(workerLock.version, workerPackage.version);
  assert.equal(workerLock.packages[''].version, workerPackage.version);
});
