/**
 * 存储服务工厂（按 STORAGE_BACKEND 选择实现）
 *   - local: 第一期本地文件系统 + HMAC 签名令牌模拟预签名 URL
 *   - cos: 第二期腾讯云 COS + SDK 预签名 URL
 */
import { env } from '../../config/env.js';
import type { StorageService } from './storage.js';
import { LocalStorageService } from './local-storage.js';
import { CosStorageService } from './cos-storage.js';
import { storageConfigService } from './storage-config-service.js';

let _instance: StorageService | null = null;

export async function getStorage(): Promise<StorageService> {
  if (_instance) return _instance;
  const runtime = await storageConfigService.getRuntime();
  switch (runtime.backend) {
    case 'local':
      // 传入 DB 配置的本地存储目录，使 Admin UI 的存储目录设置生效
      _instance = new LocalStorageService(runtime.localStorageDir);
      break;
    case 'cos':
      _instance = new CosStorageService(runtime.config);
      break;
    default:
      throw new Error(`未知存储后端: ${env.STORAGE_BACKEND}`);
  }
  return _instance;
}

export function resetStorage(): void { _instance = null; }

export type { StorageService, UploadUrlResult, DownloadUrlResult, ObjectMeta } from './storage.js';
