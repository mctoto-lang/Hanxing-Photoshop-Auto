/**
 * 极简异步信号量（无第三方依赖）
 *
 * 用于限制 PSD 解析等内存密集型操作的并发数。项目未引入 p-limit / async-mutex，
 * 此实现提供相同的 acquire/release 语义，FIFO 公平排队。
 *
 * 用法：
 *   const sem = new Semaphore(2);
 *   const release = await sem.acquire();
 *   try { /* 临界区 *\/ } finally { release(); }
 *
 * 设计要点：
 *   - acquire() 返回一个 release 函数，调用方须在 finally 中调用，避免泄漏许可。
 *   - release() 唤醒队首等待者并直接移交许可（permits 不递增再递减），保证公平性
 *     且不会出现"许可被新来的请求抢走"的情况。
 *   - 允许重复 release 但仅第一次生效（idempotent），防御性编程。
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore 许可数必须为正整数，收到 ${permits}`);
    }
    this.permits = permits;
  }

  /**
   * 申请一个许可。若当前有空闲许可则立即返回；否则排队等待。
   * @returns release 函数，必须在临界区结束后调用（建议放 finally 块）
   */
  async acquire(): Promise<() => void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return this.createRelease();
    }
    // 无空闲许可，排队等待。被唤醒时许可已由前一个 release 直接移交，
    // 此处无需再递减（见 release 的移交逻辑）。
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return; // 幂等：重复 release 仅第一次生效
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // 直接把许可移交给队首等待者（不递增 permits），保持 FIFO 公平
      next();
      return;
    }
    // 无等待者，归还许可
    this.permits += 1;
  }

  /** 当前可用许可数（仅用于观测/测试，不应作为并发判断依据） */
  get available(): number {
    return this.permits;
  }

  /** 当前排队等待者数量（仅用于观测/测试） */
  get pending(): number {
    return this.waiters.length;
  }
}
