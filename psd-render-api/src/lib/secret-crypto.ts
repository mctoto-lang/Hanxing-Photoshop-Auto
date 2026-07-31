/**
 * AES-256-GCM 加解密工具：用于将敏感配置（如 COS Secret、Webhook Secret）加密后落库。
 *
 * 方案：
 *   - key = HKDF-SHA256(WORKER_TOKEN_SECRET, salt, info)，长度 32 字节
 *   - iv = randomBytes(12)，每次加密随机生成（GCM 推荐 12 字节 IV，无需与 key 同等强度）
 *   - 输出格式：base64url(iv(12) || authTag(16) || ciphertext)
 *   - 加密后无法解密回原文除非持有正确 key + iv + authTag，篡改任一字节都会让 final() 抛错
 *
 * 安全修复（S-H3 / S-H4）：
 *   1. KDF 从裸 SHA-256 升级为 HKDF-SHA256（带 salt + info），避免低熵 secret 派生的 key
 *      被离线暴力破解，并为不同用途（cos / webhook / etc）派生独立 key。
 *   2. decryptSecret 失败时仅返回通用错误信息「密文解密失败」，原始错误细节仅写入日志，
 *      避免向客户端泄露底层 crypto 错误细节（如 "bad decrypt"、"Unsupported state"）。
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';

/**
 * 从 WORKER_TOKEN_SECRET 派生 AES-256 密钥
 *
 * HKDF-SHA256(RGB529)：
 *   - salt：固定常量（环境隔离用，不参与熵增强但防彩虹表）
 *   - info：派生用途标签，不同用途派生不同 key（cos / webhook / admin 等）
 *
 * 即便 WORKER_TOKEN_SECRET 熵不足，HKDF 的提取阶段也会输出 32 字节伪随机 key；
 * 配合 env.ts 中提升后的最小长度（32 位），整体安全性满足 AES-256 要求。
 */
const KDF_SALT = 'psd-render-api/v1/kdf-salt';
function deriveKey(info: string): Buffer {
  // hkdfSync(digest, ikm, salt, info, keylen)
  return Buffer.from(hkdfSync('sha256', env.WORKER_TOKEN_SECRET, KDF_SALT, info, 32));
}

/** 派生指定用途的加密 key */
export function deriveEncryptionKey(info: string): Buffer {
  return deriveKey(info);
}

export function encryptSecret(value: string): string {
  return encryptSecretWithInfo(value, 'default');
}

/** 派生指定用途的 key 加密（推荐：cos / webhook / admin 等不同用途使用不同 info） */
export function encryptSecretWithInfo(value: string, info: string): string {
  const k = deriveKey(info);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

/**
 * 解密密文。失败时抛 AppError('CONFIG_ERROR')，由 error-handler 统一处理为 500，
 *   不向客户端暴露底层 crypto 错误细节。
 *
 * S-H3：原始 crypto 错误（如 "bad decrypt"、authTag 校验失败、Unsupported state 等）
 *   仅写入服务端日志用于排查；对外统一抛「密文解密失败」，避免泄露 KDF/算法细节。
 */
export function decryptSecret(value: string): string {
  return decryptSecretWithInfo(value, 'default');
}

/**
 * 用指定用途派生的 key 解密。失败时抛 AppError('CONFIG_ERROR')，由 error-handler
 *   统一处理为 500，不向客户端暴露底层 crypto 错误细节。
 *
 * S-H3：原始 crypto 错误（如 "bad decrypt"、authTag 校验失败、Unsupported state 等）
 *   仅写入服务端日志用于排查；对外统一抛「密文解密失败」，避免泄露 KDF/算法细节。
 */
export function decryptSecretWithInfo(value: string, info: string): string {
  try {
    const data = Buffer.from(value, 'base64url');
    if (data.length < 28) {
      throw new Error('密文长度不足（iv + authTag 至少 28 字节）');
    }
    const k = deriveKey(info);
    const decipher = createDecipheriv('aes-256-gcm', k, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  } catch (e) {
    // 原始错误细节仅写日志，不回传客户端
    logger.error({ err: e as Error, msg: '密文解密失败' });
    throw new AppError('CONFIG_ERROR', '密文解密失败');
  }
}
