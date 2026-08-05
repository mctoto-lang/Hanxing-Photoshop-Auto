import { prisma } from '../../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../../lib/secret-crypto.js';
import { env } from '../../config/env.js';
import type { CosConfig } from './cos-storage.js';

export type StorageSettingsInput = {
  backend: 'local' | 'cos';
  localStorageDir?: string;
  cosBucket?: string;
  cosRegion?: string;
  cosInternalDomain?: string;
  cosPresignExpiresSec?: number;
  manifestUrlExpiresSec?: number;
  cosSecretId?: string;
  cosSecretKey?: string;
};

class StorageConfigService {
  async getPublic() {
    const config = await prisma.storageConfig.findUnique({ where: { id: 1 } });
    return {
      backend: config?.backend ?? env.STORAGE_BACKEND,
      localStorageDir: config?.localStorageDir ?? env.LOCAL_STORAGE_DIR,
      cosBucket: config?.cosBucket ?? env.COS_BUCKET,
      cosRegion: config?.cosRegion ?? env.COS_REGION,
      cosInternalDomain: config?.cosInternalDomain ?? env.COS_INTERNAL_DOMAIN,
      cosPresignExpiresSec: config?.cosPresignExpiresSec ?? env.COS_PRESIGN_EXPIRES_SECONDS,
      manifestUrlExpiresSec: config?.manifestUrlExpiresSec ?? env.MANIFEST_URL_EXPIRES_SEC,
      hasCosSecretId: Boolean(config?.cosSecretIdEncrypted) || Boolean(env.COS_SECRET_ID),
      hasCosSecretKey: Boolean(config?.cosSecretKeyEncrypted) || Boolean(env.COS_SECRET_KEY),
    };
  }

  async getRuntime() {
    const config = await prisma.storageConfig.findUnique({ where: { id: 1 } });
    // manifest URL 有效期对 local/cos 两种模式都需要，统一在顶层返回，
    // job-service.buildManifest 据此为下载/上传预签名 URL 设定 expiresInSec。
    const manifestUrlExpiresSec = config?.manifestUrlExpiresSec ?? env.MANIFEST_URL_EXPIRES_SEC;
    if (!config || config.backend !== 'cos') {
      // local 模式：返回 DB 配置的本地存储目录，回退到 env
      // 之前只返回 backend，导致 LocalStorageService 始终用 env.LOCAL_STORAGE_DIR，
      // 用户在 Admin UI 修改的本地存储目录完全不生效
      return {
        backend: (config?.backend ?? env.STORAGE_BACKEND) as 'local',
        localStorageDir: config?.localStorageDir ?? env.LOCAL_STORAGE_DIR,
        manifestUrlExpiresSec,
      } as const;
    }
    return {
      backend: 'cos' as const,
      manifestUrlExpiresSec,
      config: {
        Bucket: config.cosBucket || env.COS_BUCKET,
        Region: config.cosRegion || env.COS_REGION,
        SecretId: config.cosSecretIdEncrypted ? decryptSecret(config.cosSecretIdEncrypted) : env.COS_SECRET_ID,
        SecretKey: config.cosSecretKeyEncrypted ? decryptSecret(config.cosSecretKeyEncrypted) : env.COS_SECRET_KEY,
        internalDomain: config.cosInternalDomain ?? env.COS_INTERNAL_DOMAIN,
        presignExpiresSec: config.cosPresignExpiresSec ?? env.COS_PRESIGN_EXPIRES_SECONDS,
      } satisfies CosConfig & { internalDomain: string; presignExpiresSec: number },
    };
  }

  async save(input: StorageSettingsInput) {
    if (input.backend === 'cos' && (!input.cosBucket || !input.cosRegion)) throw new Error('COS Bucket 和 Region 为必填项');
    const existing = await prisma.storageConfig.findUnique({ where: { id: 1 } });
    if (input.backend === 'cos' && (!input.cosSecretId && !existing?.cosSecretIdEncrypted && !env.COS_SECRET_ID || !input.cosSecretKey && !existing?.cosSecretKeyEncrypted && !env.COS_SECRET_KEY)) {
      throw new Error('COS SecretId 和 SecretKey 为必填项');
    }
    await prisma.storageConfig.upsert({
      where: { id: 1 },
      create: {
        id: 1, backend: input.backend, localStorageDir: input.localStorageDir || null,
        cosBucket: input.cosBucket || null, cosRegion: input.cosRegion || null,
        cosInternalDomain: input.cosInternalDomain || null, cosPresignExpiresSec: input.cosPresignExpiresSec || null,
        manifestUrlExpiresSec: input.manifestUrlExpiresSec || null,
        cosSecretIdEncrypted: input.cosSecretId ? encryptSecret(input.cosSecretId) : null,
        cosSecretKeyEncrypted: input.cosSecretKey ? encryptSecret(input.cosSecretKey) : null,
      },
      update: {
        backend: input.backend, localStorageDir: input.localStorageDir || null,
        cosBucket: input.cosBucket || null, cosRegion: input.cosRegion || null,
        cosInternalDomain: input.cosInternalDomain || null, cosPresignExpiresSec: input.cosPresignExpiresSec || null,
        manifestUrlExpiresSec: input.manifestUrlExpiresSec || null,
        ...(input.cosSecretId ? { cosSecretIdEncrypted: encryptSecret(input.cosSecretId) } : {}),
        ...(input.cosSecretKey ? { cosSecretKeyEncrypted: encryptSecret(input.cosSecretKey) } : {}),
      },
    });
  }
}

export const storageConfigService = new StorageConfigService();
