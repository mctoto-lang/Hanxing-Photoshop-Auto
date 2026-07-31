/**
 * ID / 业务编码生成器
 */
import { createHash, randomBytes, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = {
  apiKey: 'sk_live_',
  template: 'tpl_',
  templateVersion: 'tpv_',
  font: 'fntv_',
  worker: 'wrk_',
  job: 'job_',
  artifact: 'art_',
};

/** 生成短随机串（base36，去掉连字符） */
function shortRandom(len = 12): string {
  return randomBytes(len)
    .toString('base64url')
    .replace(/[-_]/g, '')
    .slice(0, len);
}

export const genTemplateCode = () => PREFIX.template + shortRandom(10);
export const genTemplateVersionCode = () => PREFIX.templateVersion + shortRandom(10);
export const genFontCode = () => PREFIX.font + shortRandom(10);
export const genWorkerCode = () => PREFIX.worker + shortRandom(8);
export const genJobCode = () => PREFIX.job + shortRandom(10);
export const genArtifactCode = () => PREFIX.artifact + shortRandom(10);

/** 生成完整 API Key 明文（仅创建时返回一次） */
export const genApiKeyPlainText = () =>
  PREFIX.apiKey + randomBytes(16).toString('hex');

/** 生成 Worker 短期访问令牌 */
export const genWorkerToken = () => randomBytes(24).toString('hex');

/** 生成租约令牌 */
export const genLeaseToken = (jobId: string, workerId: string) =>
  `${jobId}.${workerId}.${randomBytes(12).toString('hex')}`;

/** 生成机器指纹 */
export const genMachineFingerprint = (raw: string) => sha256(raw);

/** SHA-256 哈希（hex） */
export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 流式 SHA-256（用于大文件） */
import { createReadStream } from 'node:fs';
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/** HMAC-SHA256 签名（Webhook 防伪） */
export function hmacSign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** UUID v4 */
export const uuid = randomUUID;

/**
 * 恒定时间字符串比较（防时序攻击）；长度不同时先比较自身再返回 false。
 * 用于 hex 哈希值、签名等敏感字符串比较场景。
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // 仍调用一次 compare 以保持时间恒定
    ab.compare(ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
