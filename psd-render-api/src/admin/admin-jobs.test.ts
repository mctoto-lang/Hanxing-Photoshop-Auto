import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import Fastify from 'fastify';
import { prisma } from '../lib/prisma.js';
import { getStorage, resetStorage } from '../services/storage/index.js';
import { storageConfigService } from '../services/storage/storage-config-service.js';
import { adminRoutes } from './admin-routes.js';

const future = new Date('2099-01-01T00:00:00.000Z');
const past = new Date('2000-01-01T00:00:00.000Z');

function artifact(expiresAt: Date, overrides: Record<string, unknown> = {}) {
  return {
    id: 'artifact-id',
    code: 'art_result',
    jobId: 'job-id',
    kind: 'output',
    objectKey: 'output/job_result.png',
    sha256: 'hash',
    mimeType: 'image/png',
    sizeBytes: 6,
    bindingId: null,
    originalName: null,
    expiresAt,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
    tenantId: 'default',
    ...overrides,
  };
}

function job(code: string, artifacts: unknown[]) {
  return {
    id: `${code}-id`,
    code,
    status: 'SUCCEEDED',
    priority: 5,
    attempt: 0,
    maxAttempts: 4,
    stage: 'UPLOAD',
    progress: 100,
    errorCode: null,
    templateVersion: { template: { name: '测试模板' } },
    worker: null,
    artifacts,
    createdAt: new Date('2026-08-06T00:00:00.000Z'),
    succeededAt: new Date('2026-08-06T00:01:00.000Z'),
    failedAt: null,
  };
}

async function buildApp() {
  const app = Fastify();
  app.decorate('requireAdminAuth', async () => {});
  app.decorate('requireRole', () => async () => {});
  app.addSchema({
    $id: 'ErrorResponse',
    type: 'object',
    required: ['error', 'message'],
    properties: { error: { type: 'string' }, message: { type: 'string' } },
  });
  await app.register(adminRoutes, { prefix: '/admin' });
  return app;
}

function replaceRenderJobMethod(name: 'findMany' | 'findUnique', implementation: (...args: any[]) => any) {
  const delegate = prisma.renderJob as any;
  const original = delegate[name];
  delegate[name] = implementation;
  return () => {
    delegate[name] = original;
  };
}

test('最近任务返回有效、过期和缺失结果的元数据', { concurrency: false }, async (t) => {
  const jobs = [
    job('job_available', [artifact(future)]),
    job('job_expired', [artifact(past)]),
    job('job_missing', []),
  ];
  const restorePrisma = replaceRenderJobMethod('findMany', async () => jobs);
  t.after(restorePrisma);
  const app = await buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/admin/api/jobs' });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(body.jobs.map((item: Record<string, unknown>) => ({
    jobId: item.jobId,
    maxAttempts: item.maxAttempts,
    resultAvailable: item.resultAvailable,
    resultMimeType: item.resultMimeType,
    resultSizeBytes: item.resultSizeBytes,
    resultExpiresAt: item.resultExpiresAt,
  })), [
    {
      jobId: 'job_available',
      maxAttempts: 4,
      resultAvailable: true,
      resultMimeType: 'image/png',
      resultSizeBytes: 6,
      resultExpiresAt: future.toISOString(),
    },
    {
      jobId: 'job_expired',
      maxAttempts: 4,
      resultAvailable: false,
      resultMimeType: 'image/png',
      resultSizeBytes: 6,
      resultExpiresAt: past.toISOString(),
    },
    {
      jobId: 'job_missing',
      maxAttempts: 4,
      resultAvailable: false,
      resultMimeType: null,
      resultSizeBytes: null,
      resultExpiresAt: null,
    },
  ]);
});

test('最近任务按字符串返回 Worker 编号', { concurrency: false }, async (t) => {
  const item = job('job_worker', []);
  item.worker = { code: 'worker-1', customCode: 'NODE-01', displayName: '一号节点' } as any;
  const restorePrisma = replaceRenderJobMethod('findMany', async () => [item]);
  t.after(restorePrisma);
  const app = await buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/admin/api/jobs' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().jobs[0].worker, 'worker-1');
});

test('结果下载以附件流返回存储对象', { concurrency: false }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'admin-job-result-'));
  mock.method(storageConfigService, 'getRuntime', async () => ({
    backend: 'local' as const,
    localStorageDir: root,
    manifestUrlExpiresSec: 600,
  }));
  const restorePrisma = replaceRenderJobMethod('findUnique', async () => job('job_available', [artifact(future)]));
  resetStorage();
  const storage = await getStorage();
  await storage.putObject({ objectKey: 'output/job_result.png', body: Buffer.from('result'), mimeType: 'image/png' });
  t.after(async () => {
    restorePrisma();
    mock.restoreAll();
    resetStorage();
    await rm(root, { recursive: true, force: true });
  });
  const app = await buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/admin/api/jobs/job_available/result' });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['content-length'], '6');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="job_available.png"');
  assert.deepEqual(response.rawPayload, Buffer.from('result'));
});

test('结果下载对过期结果返回 410', { concurrency: false }, async (t) => {
  const restorePrisma = replaceRenderJobMethod('findUnique', async () => job('job_expired', [artifact(past)]));
  t.after(restorePrisma);
  const app = await buildApp();
  t.after(() => app.close());

  const response = await app.inject({ method: 'GET', url: '/admin/api/jobs/job_expired/result' });

  assert.equal(response.statusCode, 410);
  assert.deepEqual(response.json(), { error: 'RESULT_EXPIRED', message: '任务结果已过期' });
});

test('结果下载对缺失产物记录或存储对象返回 404', { concurrency: false }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'admin-job-result-'));
  let currentJob = job('job_missing', []);
  mock.method(storageConfigService, 'getRuntime', async () => ({
    backend: 'local' as const,
    localStorageDir: root,
    manifestUrlExpiresSec: 600,
  }));
  const restorePrisma = replaceRenderJobMethod('findUnique', async () => currentJob);
  resetStorage();
  t.after(async () => {
    restorePrisma();
    mock.restoreAll();
    resetStorage();
    await rm(root, { recursive: true, force: true });
  });
  const app = await buildApp();
  t.after(() => app.close());

  const missingArtifact = await app.inject({ method: 'GET', url: '/admin/api/jobs/job_missing/result' });
  currentJob = job('job_missing_object', [artifact(future, { objectKey: 'output/missing.png' })]);
  const missingObject = await app.inject({ method: 'GET', url: '/admin/api/jobs/job_missing_object/result' });

  assert.equal(missingArtifact.statusCode, 404);
  assert.deepEqual(missingArtifact.json(), { error: 'RESULT_NOT_FOUND', message: '任务结果不存在' });
  assert.equal(missingObject.statusCode, 404);
  assert.deepEqual(missingObject.json(), { error: 'RESULT_NOT_FOUND', message: '任务结果不存在' });
});
