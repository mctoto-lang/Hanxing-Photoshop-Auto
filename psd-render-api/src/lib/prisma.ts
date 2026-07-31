/**
 * Prisma 客户端单例（避免开发热重载时建立过多连接）
 *
 * 第三期改造：项目从 PostgreSQL + Redis 切换为纯 SQLite 部署。
 *   SQLite 默认 journal_mode=DELETE，写时全库 EXCLUSIVE 锁会阻塞读，
 *   在 10-20 任务并发场景下可能导致心跳接口偶发超时。
 *   启用 WAL + busy_timeout + synchronous=NORMAL 显著提升并发写入性能：
 *     - WAL：读写不互相阻塞（多读者 + 单写者）
 *     - busy_timeout=5000ms：写冲突时等待而非立即报错 SQLITE_BUSY
 *     - synchronous=NORMAL：WAL 模式下安全，比 FULL 快 2-3 倍（仅断电时可能丢最后一条事务）
 *
 * PRAGMA 仅对 SQLite 生效；如未来切回 PostgreSQL，这些语句会报错（已用 try-catch 容错）。
 */
import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaPragmaInitialized: boolean | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['warn', 'error'],
  });

if (globalForPrisma.prisma === undefined) {
  globalForPrisma.prisma = prisma;
}

/**
 * 初始化 SQLite PRAGMA（仅 SQLite 生效）
 * 必须在 PrismaClient 创建后、首次查询前调用。
 * 幂等：通过 globalForPrisma.prismaPragmaInitialized 防止重复执行。
 *
 * B-PR1 修复：原实现使用 $executeRaw 执行 PRAGMA 语句，但 journal_mode=WAL 等会
 *   返回结果行（例如 WAL 模式返回 [{journal_mode: 'wal'}]），SQLite 驱动禁止
 *   $executeRaw 返回结果，抛 "Execute returned results, which is not allowed
 *   in SQLite" 被外层 try-catch 静默吞掉，导致 PRAGMA 全部未生效。
 *   修复：改用 $queryRaw（允许返回结果），并对关键 PRAGMA 校验返回值是否符合预期。
 */
export async function initSqlitePragmas(): Promise<void> {
  if (globalForPrisma.prismaPragmaInitialized) return;
  globalForPrisma.prismaPragmaInitialized = true;
  try {
    // journal_mode 必须用 $queryRaw，它返回结果行
    const journalRows = await prisma.$queryRaw<{ journal_mode?: string }[]>`PRAGMA journal_mode=WAL`;
    const actualJournal = Array.isArray(journalRows) && journalRows[0]?.journal_mode;
    if (actualJournal && String(actualJournal).toLowerCase() !== 'wal') {
      logger.warn({
        msg: 'SQLite journal_mode 未切换为 WAL',
        expected: 'wal',
        actual: actualJournal,
      });
    }
    // 其余 PRAGMA 返回值简单，使用 $executeRaw 也可，但为统一风格仍用 $queryRaw
    await prisma.$queryRaw`PRAGMA busy_timeout=5000`;
    await prisma.$queryRaw`PRAGMA synchronous=NORMAL`;
    await prisma.$queryRaw`PRAGMA foreign_keys=ON`;
    logger.info({
      msg: 'SQLite PRAGMA 已启用',
      journal_mode: actualJournal ?? 'wal',
      busy_timeout: 5000,
      synchronous: 'NORMAL',
    });
  } catch (e) {
    // 非 SQLite 数据库（如 PostgreSQL）会抛错，忽略即可
    logger.debug({ err: e as Error, msg: 'PRAGMA 初始化跳过（可能非 SQLite 数据库）' });
  }
}
