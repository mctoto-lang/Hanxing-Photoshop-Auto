/**
 * Worker 一次性注册令牌服务（配对码模式）
 *
 * 工作流程：
 *   1. 管理员调用 create() 生成配对码 + 完整 token，明文仅返回一次
 *   2. Worker UI 输入 6 位配对码，作为 registerSecret 携带到后端注册
 *   3. 后端 verifyRegisterSecret 调用 verifyAndConsume() 校验并消费令牌
 *   4. 注册成功后标记 usedAt + usedByWorkerId，配对码和 token 都不可复用
 *
 * 安全设计：
 *   - 配对码 6 位（32^6 ≈ 10 亿组合），24h 过期，一次性使用
 *   - 完整 token 64 字符 hex，仅作为 Bearer 头传输，不进请求体
 *   - DB 仅存 tokenHash（SHA-256），明文 token 仅创建时返回一次
 *   - 配对码校验失败不泄露具体原因（统一返回"无效"）
 *   - 支持管理员作废未使用的令牌
 */
import { randomBytes } from 'node:crypto';
import { prisma } from '../../lib/prisma.js';
import { sha256 } from '../../lib/crypto.js';

// 配对码字符集：去掉易混淆字符 0/O/1/I/l
const PAIRING_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAIRING_CODE_LENGTH = 6;
const TOKEN_BYTES = 32; // 64 字符 hex

/** 默认有效期 24 小时 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateTokenInput {
  createdBy: string;
  note?: string;
  ttlMs?: number;
}

export interface CreatedToken {
  id: string;
  pairingCode: string; // 明文配对码，仅创建时返回
  token: string; // 明文完整 token，仅创建时返回
  createdBy: string;
  createdAt: Date;
  expiresAt: Date;
  note: string | null;
}

export interface TokenListItem {
  id: string;
  pairingCode: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  usedByWorkerId: string | null;
  revokedAt: string | null;
  note: string | null;
  status: 'unused' | 'used' | 'expired' | 'revoked';
}

/** 生成 6 位配对码，格式 XXX-XXX */
function genPairingCode(): string {
  const chars: string[] = [];
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    chars.push(PAIRING_CHARS[Math.floor(Math.random() * PAIRING_CHARS.length)]);
  }
  return chars.slice(0, 3).join('') + '-' + chars.slice(3).join('');
}

/** 生成完整 token（64 字符 hex） */
function genToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export class BootstrapTokenService {
  /**
   * 创建一次性注册令牌
   * 返回明文配对码和 token，仅此一次返回
   */
  async create(input: CreateTokenInput): Promise<CreatedToken> {
    const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl);

    // 重试机制：pairingCode 或 tokenHash 冲突时重新生成
    for (let attempt = 0; attempt < 5; attempt++) {
      const pairingCode = genPairingCode();
      const token = genToken();
      const tokenHash = sha256(token);

      try {
        const record = await prisma.workerBootstrapToken.create({
          data: {
            pairingCode,
            tokenHash,
            createdBy: input.createdBy,
            expiresAt,
            note: input.note ?? null,
          },
        });
        return {
          id: record.id,
          pairingCode,
          token,
          createdBy: record.createdBy,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
          note: record.note,
        };
      } catch (e: any) {
        // P2002: unique constraint violation，重试
        if (e?.code !== 'P2002') throw e;
      }
    }
    throw new Error('生成配对码失败：多次冲突，请重试');
  }

  /**
   * 列出所有令牌（按创建时间倒序）
   */
  async list(limit = 100): Promise<TokenListItem[]> {
    const records = await prisma.workerBootstrapToken.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const now = new Date();
    return records.map((r) => ({
      id: r.id,
      pairingCode: r.pairingCode,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      usedAt: r.usedAt?.toISOString() ?? null,
      usedByWorkerId: r.usedByWorkerId,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      note: r.note,
      status: this.computeStatus(r, now),
    }));
  }

  /**
   * 作废未使用的令牌
   */
  async revoke(id: string): Promise<void> {
    await prisma.workerBootstrapToken.updateMany({
      where: { id, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * 硬删除令牌记录（仅允许已作废或已过期的令牌删除）
   */
  async delete(id: string): Promise<void> {
    const now = new Date();
    // 仅允许删除已作废或已过期的令牌
    const record = await prisma.workerBootstrapToken.findUnique({ where: { id } });
    if (!record) return;
    const canDelete = record.revokedAt !== null || record.expiresAt < now;
    if (!canDelete) {
      throw new Error('仅已作废或已过期的配对码可以删除');
    }
    await prisma.workerBootstrapToken.delete({ where: { id } });
  }

  /**
   * 校验并消费令牌（注册时调用）
   *
   * @param provided Worker 携带的凭据（可能是配对码或完整 token）
   * @returns 如果校验通过返回 token 对应的 record（含 id），否则返回 null
   */
  async verifyAndConsume(provided: string): Promise<{ id: string } | null> {
    if (!provided) return null;

    const now = new Date();

    // 尝试作为配对码匹配（格式 XXX-XXX，7 字符）
    if (provided.length === 7 && provided[3] === '-') {
      const record = await prisma.workerBootstrapToken.findUnique({
        where: { pairingCode: provided },
      });
      if (!record) return null;
      if (record.usedAt || record.revokedAt) return null;
      if (record.expiresAt < now) return null;
      // 标记为已使用
      await prisma.workerBootstrapToken.update({
        where: { id: record.id },
        data: { usedAt: now },
      });
      return { id: record.id };
    }

    // 尝试作为完整 token 匹配（64 字符 hex）
    if (provided.length === 64 && /^[0-9a-f]+$/.test(provided)) {
      const tokenHash = sha256(provided);
      const record = await prisma.workerBootstrapToken.findUnique({
        where: { tokenHash },
      });
      if (!record) return null;
      if (record.usedAt || record.revokedAt) return null;
      if (record.expiresAt < now) return null;
      await prisma.workerBootstrapToken.update({
        where: { id: record.id },
        data: { usedAt: now },
      });
      return { id: record.id };
    }

    return null;
  }

  /**
   * 注册成功后绑定 Worker ID
   */
  async bindWorker(tokenId: string, workerId: string): Promise<void> {
    await prisma.workerBootstrapToken.update({
      where: { id: tokenId },
      data: { usedByWorkerId: workerId },
    });
  }

  /** 计算令牌状态 */
  private computeStatus(
    r: { usedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
    now: Date,
  ): TokenListItem['status'] {
    if (r.revokedAt) return 'revoked';
    if (r.usedAt) return 'used';
    if (r.expiresAt < now) return 'expired';
    return 'unused';
  }
}

export const bootstrapTokenService = new BootstrapTokenService();
