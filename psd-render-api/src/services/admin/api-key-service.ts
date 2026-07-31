/**
 * API Key 管理服务（第三期 M1）
 *
 * 职责：
 *   - 创建 API Key：生成明文 key + keyPrefix（sk_live_ + 12 字符）+ keyHash（bcrypt）
 *   - 列表/详情：返回元数据，不含 keyHash
 *   - 轮换：标记旧 key 为 disabled（disabledAt=now），生成新 key 返回明文
 *   - 启用/禁用：切换 active，禁用时记录 disabledAt
 *   - 更新配置：name / priority / rateLimitPerMin / quotaPerDay / scopes / webhookUrlDefault / webhookSecret / ipWhitelist
 *   - 重置日配额：手动清零 quotaUsedDay + 重设 quotaResetAt
 *
 * 安全：
 *   - 明文 key 仅在 create / rotate 接口返回一次
 *   - 数据库仅存 keyHash（bcrypt）
 *   - keyPrefix 唯一索引（用于鉴权时快速查找）
 *
 * 与 plugins/auth.ts 的协议：
 *   - extractKeyPrefix(fullKey) = 'sk_live_' + fullKey.slice(8, 8+12)
 *   - 鉴权时按 keyPrefix 唯一索引查找，bcrypt.compare 校验完整 key
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { genApiKeyPlainText } from '../../lib/crypto.js';
import { Errors } from '../../lib/errors.js';
import { encryptSecretWithInfo } from '../../lib/secret-crypto.js';
import { env, isProd } from '../../config/env.js';

/**
 * S-H1：webhookSecret 落库前用 HKDF 派生的 'webhook' 维度 key 加密。
 *   不同用途（cos / webhook / admin）派生独立 key，即便某维度 key 泄露
 *   也不会影响其它维度的密文。
 */
const WEBHOOK_SECRET_INFO = 'webhook';

/**
 * 掩码常量：API 响应中 webhookSecret 字段返回此固定字符串表示「已配置但不回显」。
 *   前端据此判断是否已设置，需要查看明文需走轮换流程重新生成。
 */
const WEBHOOK_SECRET_MASK = '***';

/** 加密 webhookSecret；空值返回 null（清除配置） */
function encryptWebhookSecret(plain: string | null | undefined): string | null {
  if (!plain || !plain.trim()) return null;
  return encryptSecretWithInfo(plain, WEBHOOK_SECRET_INFO);
}

// P0 安全修复（低危12）：bcrypt rounds 从 10 提升至 12（与 admin-auth-service 一致）
const BCRYPT_ROUNDS = 12;
const KEY_PREFIX_LEN = 12; // 'sk_live_' 后取 12 字符
const KEY_PREFIX_NAMESPACE = 'sk_live_';

export interface ApiKeyPublic {
  id: string;
  keyPrefix: string;
  name: string;
  tenantId: string;
  active: boolean;
  priority: number;
  rateLimitPerMin: number | null;
  quotaPerDay: number | null;
  quotaUsedDay: number;
  quotaResetAt: string | null;
  scopes: string[];
  webhookUrlDefault: string | null;
  webhookSecret: string | null;
  ipWhitelist: string | null;
  disabledAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyCreateInput {
  name: string;
  tenantId?: string;
  priority?: number;
  rateLimitPerMin?: number | null;
  quotaPerDay?: number | null;
  scopes?: string[];
  webhookUrlDefault?: string | null;
  webhookSecret?: string | null;
  ipWhitelist?: string | null;
}

export interface ApiKeyUpdateInput {
  name?: string;
  priority?: number;
  rateLimitPerMin?: number | null;
  quotaPerDay?: number | null;
  scopes?: string[];
  webhookUrlDefault?: string | null;
  webhookSecret?: string | null;
  ipWhitelist?: string | null;
}

export interface ApiKeyCreateResult {
  apiKey: ApiKeyPublic;
  /** 完整明文 key（仅此一次返回，调用方必须立即保存） */
  plaintextKey: string;
}

function toPublic(k: any): ApiKeyPublic {
  return {
    id: k.id,
    keyPrefix: k.keyPrefix,
    name: k.name,
    tenantId: k.tenantId,
    active: k.active,
    priority: k.priority,
    rateLimitPerMin: k.rateLimitPerMin,
    quotaPerDay: k.quotaPerDay,
    quotaUsedDay: k.quotaUsedDay,
    quotaResetAt: k.quotaResetAt ? k.quotaResetAt.toISOString() : null,
    scopes: k.scopes
      ? String(k.scopes).split(',').map((s: string) => s.trim()).filter(Boolean)
      : [],
    webhookUrlDefault: k.webhookUrlDefault,
    // S-H1：接口掩码——已配置返回 '***'，未配置返回 null。
    //   明文 secret 仅在 create/update 时由调用方持有，落库即加密。
    webhookSecret: k.webhookSecret ? WEBHOOK_SECRET_MASK : null,
    ipWhitelist: k.ipWhitelist,
    disabledAt: k.disabledAt ? k.disabledAt.toISOString() : null,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
  };
}

/** 从明文 key 提取 keyPrefix（必须与 auth.ts 中 extractKeyPrefix 保持一致） */
function extractKeyPrefix(plaintext: string): string {
  return KEY_PREFIX_NAMESPACE + plaintext.slice(KEY_PREFIX_NAMESPACE.length, KEY_PREFIX_NAMESPACE.length + KEY_PREFIX_LEN);
}

/** 校验明文 key 格式 */
function validateKeyFormat(plaintext: string): void {
  if (!plaintext.startsWith(KEY_PREFIX_NAMESPACE)) {
    throw Errors.validationError('API Key 格式错误：必须以 sk_live_ 开头');
  }
  const rest = plaintext.slice(KEY_PREFIX_NAMESPACE.length);
  if (rest.length < KEY_PREFIX_LEN) {
    throw Errors.validationError(`API Key 长度不足：sk_live_ 后至少 ${KEY_PREFIX_LEN} 字符`);
  }
}

class ApiKeyService {
  /**
   * B-E1 修复：引导 .env 中的 API_KEY 到数据库。
   *
   * 背景：原 POC 回落逻辑（plugins/auth.ts）仅在 DB 无 active ApiKey 时
   *   允许使用 env.API_KEY 鉴权。一旦通过 Admin UI 创建任意 API Key 后，
   *   回落被禁用，env.API_KEY 失效——用户按 .env 注释使用该 key 会得到 401。
   *
   * 修复：服务启动时若 env.API_KEY 存在且 DB 无对应 keyPrefix 记录，
   *   将其作为正式 ApiKey 写入 DB，使得该 key 在任何情况下都可用。
   *   生产环境可选配置（仍建议通过 Admin UI 单独创建高优先级 key）。
   *   - 幂等：keyPrefix 已存在则跳过
   *   - 仅 dev 模式启用（生产应通过 Admin UI 管理）
   */
  async bootstrapEnvApiKey(): Promise<void> {
    if (isProd) return; // 生产环境禁用 env 引导
    const plaintext = env.API_KEY;
    if (!plaintext || !plaintext.startsWith(KEY_PREFIX_NAMESPACE)) {
      logger.debug({ msg: 'API_KEY env 未配置或格式无效，跳过引导' });
      return;
    }
    // 校验长度：sk_live_ 后至少 12 字符（与 validateKeyFormat 一致）
    if (plaintext.length < KEY_PREFIX_NAMESPACE.length + KEY_PREFIX_LEN) {
      logger.warn({ msg: 'API_KEY env 长度不足，跳过引导' });
      return;
    }
    const keyPrefix = extractKeyPrefix(plaintext);
    if (!keyPrefix) {
      logger.warn({ msg: 'API_KEY env 无法提取 keyPrefix，跳过引导' });
      return;
    }
    const existing = await prisma.apiKey.findUnique({ where: { keyPrefix } });
    if (existing) {
      // 已存在同 prefix 记录，幂等跳过
      return;
    }
    const keyHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);
    await prisma.apiKey.create({
      data: {
        keyPrefix,
        keyHash,
        name: 'env-bootstrap-default',
        tenantId: 'default',
        active: true,
        priority: 5,
        rateLimitPerMin: null,
        quotaPerDay: null,
        quotaUsedDay: 0,
        scopes: '',
        webhookUrlDefault: null,
        webhookSecret: null,
        ipWhitelist: null,
      },
    });
    logger.info({
      keyPrefix,
      msg: '已将 env.API_KEY 引导为正式 ApiKey（POC 默认 key）',
    });
  }

  /**
   * 创建 API Key
   * - 生成明文 key（仅返回一次）
   * - keyPrefix + keyHash 写入数据库
   * - tenantId 默认 'default'
   */
  async create(input: ApiKeyCreateInput, operator: string): Promise<ApiKeyCreateResult> {
    const plaintext = genApiKeyPlainText();
    validateKeyFormat(plaintext);
    const keyPrefix = extractKeyPrefix(plaintext);
    const keyHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);

    // tenantId 默认 default；POC 阶段单租户
    const tenantId = input.tenantId || 'default';

    const created = await prisma.apiKey.create({
      data: {
        keyPrefix,
        keyHash,
        name: input.name,
        tenantId,
        active: true,
        priority: input.priority ?? 5,
        rateLimitPerMin: input.rateLimitPerMin ?? null,
        quotaPerDay: input.quotaPerDay ?? null,
        quotaUsedDay: 0,
        quotaResetAt: input.quotaPerDay ? new Date(Date.now() + 24 * 3600 * 1000) : null,
        scopes: (input.scopes ?? []).join(','),
        webhookUrlDefault: input.webhookUrlDefault ?? null,
        // S-H1：webhookSecret 落库前加密
        webhookSecret: encryptWebhookSecret(input.webhookSecret),
        ipWhitelist: input.ipWhitelist ?? null,
      },
    });

    logger.info({
      apiKeyId: created.id,
      name: created.name,
      tenantId,
      operator,
      msg: 'API Key 已创建',
    });
    return { apiKey: toPublic(created), plaintextKey: plaintext };
  }

  /** 列表（按 createdAt 倒序） */
  async list(filter?: { tenantId?: string; active?: boolean }): Promise<ApiKeyPublic[]> {
    const where: any = {};
    if (filter?.tenantId) where.tenantId = filter.tenantId;
    if (filter?.active !== undefined) where.active = filter.active;
    const keys = await prisma.apiKey.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return keys.map(toPublic);
  }

  /** 详情 */
  async getDetail(id: string): Promise<ApiKeyPublic | null> {
    const k = await prisma.apiKey.findUnique({ where: { id } });
    return k ? toPublic(k) : null;
  }

  /**
   * 轮换 API Key
   * - 旧 key 标记为 active=false + disabledAt=now
   * - 生成新 key（同名同租户同配置），返回明文
   * - 旧 key 仍可在历史审计中查询
   */
  async rotate(id: string, operator: string): Promise<ApiKeyCreateResult> {
    const old = await prisma.apiKey.findUnique({ where: { id } });
    if (!old) throw Errors.notFound('API Key 不存在');

    const plaintext = genApiKeyPlainText();
    validateKeyFormat(plaintext);
    const keyPrefix = extractKeyPrefix(plaintext);
    const keyHash = await bcrypt.hash(plaintext, BCRYPT_ROUNDS);

    // 事务：禁用旧 key + 创建新 key
    const [_, created] = await prisma.$transaction([
      prisma.apiKey.update({
        where: { id },
        data: { active: false, disabledAt: new Date() },
      }),
      prisma.apiKey.create({
        data: {
          keyPrefix,
          keyHash,
          name: old.name,
          tenantId: old.tenantId,
          active: true,
          priority: old.priority,
          rateLimitPerMin: old.rateLimitPerMin,
          quotaPerDay: old.quotaPerDay,
          quotaUsedDay: 0,
          quotaResetAt: old.quotaPerDay ? new Date(Date.now() + 24 * 3600 * 1000) : null,
          scopes: old.scopes,
          webhookUrlDefault: old.webhookUrlDefault,
          webhookSecret: old.webhookSecret,
          ipWhitelist: old.ipWhitelist,
        },
      }),
    ]);

    logger.info({
      oldApiKeyId: id,
      newApiKeyId: created.id,
      name: created.name,
      operator,
      msg: 'API Key 已轮换',
    });
    return { apiKey: toPublic(created), plaintextKey: plaintext };
  }

  /** 禁用 API Key */
  async disable(id: string, operator: string): Promise<ApiKeyPublic> {
    const k = await prisma.apiKey.findUnique({ where: { id } });
    if (!k) throw Errors.notFound('API Key 不存在');
    if (!k.active) {
      throw Errors.validationError('API Key 已处于禁用状态');
    }
    const updated = await prisma.apiKey.update({
      where: { id },
      data: { active: false, disabledAt: new Date() },
    });
    logger.info({
      apiKeyId: id,
      name: k.name,
      operator,
      msg: 'API Key 已禁用',
    });
    return toPublic(updated);
  }

  /** 启用 API Key */
  async enable(id: string, operator: string): Promise<ApiKeyPublic> {
    const k = await prisma.apiKey.findUnique({ where: { id } });
    if (!k) throw Errors.notFound('API Key 不存在');
    if (k.active) {
      throw Errors.validationError('API Key 已处于启用状态');
    }
    const updated = await prisma.apiKey.update({
      where: { id },
      data: { active: true, disabledAt: null },
    });
    logger.info({
      apiKeyId: id,
      name: k.name,
      operator,
      msg: 'API Key 已启用',
    });
    return toPublic(updated);
  }

  /** 更新配置 */
  async update(id: string, patch: ApiKeyUpdateInput, operator: string): Promise<ApiKeyPublic> {
    const k = await prisma.apiKey.findUnique({ where: { id } });
    if (!k) throw Errors.notFound('API Key 不存在');

    const data: any = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.priority !== undefined) data.priority = patch.priority;
    if (patch.rateLimitPerMin !== undefined) data.rateLimitPerMin = patch.rateLimitPerMin;
    if (patch.quotaPerDay !== undefined) {
      data.quotaPerDay = patch.quotaPerDay;
      // 若调高配额且当前已超额，立即重置
      if (patch.quotaPerDay !== null && k.quotaUsedDay >= patch.quotaPerDay) {
        data.quotaUsedDay = 0;
        data.quotaResetAt = new Date(Date.now() + 24 * 3600 * 1000);
      }
    }
    if (patch.scopes !== undefined) data.scopes = patch.scopes.join(',');
    if (patch.webhookUrlDefault !== undefined) data.webhookUrlDefault = patch.webhookUrlDefault;
    // S-H1：webhookSecret 落库前加密；传 null/空串清除配置
    if (patch.webhookSecret !== undefined) {
      data.webhookSecret = encryptWebhookSecret(patch.webhookSecret);
    }
    if (patch.ipWhitelist !== undefined) data.ipWhitelist = patch.ipWhitelist;

    const updated = await prisma.apiKey.update({ where: { id }, data });
    logger.info({
      apiKeyId: id,
      name: k.name,
      operator,
      msg: 'API Key 配置已更新',
    });
    return toPublic(updated);
  }

  /** 重置日配额（手动） */
  async resetQuota(id: string, operator: string): Promise<ApiKeyPublic> {
    const k = await prisma.apiKey.findUnique({ where: { id } });
    if (!k) throw Errors.notFound('API Key 不存在');
    const updated = await prisma.apiKey.update({
      where: { id },
      data: {
        quotaUsedDay: 0,
        quotaResetAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    logger.info({
      apiKeyId: id,
      name: k.name,
      operator,
      msg: 'API Key 日配额已重置',
    });
    return toPublic(updated);
  }

  /** 删除 API Key（彻底删除，谨慎；POC 可用，生产建议只禁用） */
  async delete(id: string, operator: string): Promise<{ ok: boolean }> {
    const k = await prisma.apiKey.findUnique({ where: { id } });
    if (!k) throw Errors.notFound('API Key 不存在');
    // 若有任务引用，prisma 会因外键约束拒绝；先解除关联
    await prisma.renderJob.updateMany({
      where: { apiKeyId: id },
      data: { apiKeyId: null },
    });
    await prisma.apiKey.delete({ where: { id } });
    logger.info({
      apiKeyId: id,
      name: k.name,
      operator,
      msg: 'API Key 已彻底删除',
    });
    return { ok: true };
  }
}

export const apiKeyService = new ApiKeyService();
