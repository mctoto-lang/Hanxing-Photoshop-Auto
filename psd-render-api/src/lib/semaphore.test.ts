import assert from 'node:assert/strict';
import test from 'node:test';
import { Semaphore } from './semaphore.js';

test('permits=1：首个 acquire 立即返回，第二个需等待 release 后才 resolve', async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];

  const r1 = await sem.acquire();
  order.push('acquired1');
  const p2 = sem.acquire().then((r) => {
    order.push('acquired2');
    return r;
  });
  // 此时 p2 应仍在等待
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ['acquired1']);

  r1(); // 释放后 p2 应被唤醒
  const r2 = await p2;
  assert.deepEqual(order, ['acquired1', 'acquired2']);
  r2();
});

test('FIFO 公平：permits=1 时 3 个等待者按入队顺序唤醒', async () => {
  const sem = new Semaphore(1);
  const order: string[] = [];
  const r0 = await sem.acquire();

  const waiters = [1, 2, 3].map((i) =>
    sem.acquire().then((r) => {
      order.push(`w${i}`);
      return r;
    }),
  );

  // 依次释放，每次只应唤醒队首
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    // 第 0 次释放 r0，后续释放上一次拿到的 release
    if (i === 0) r0();
    else (await waiters[i - 1])();
  }
  await Promise.all(waiters);
  assert.deepEqual(order, ['w1', 'w2', 'w3']);
});

test('permits=2：两个并发 acquire 立即返回，第三个需等待', async () => {
  const sem = new Semaphore(2);
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.available, 0);

  let resolved = false;
  const p3 = sem.acquire().then((r) => {
    resolved = true;
    return r;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(resolved, false);

  r1();
  const r3 = await p3;
  assert.equal(resolved, true);
  r2();
  r3();
});

test('release 幂等：重复调用 release 不会额外增加可用许可', async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  r1();
  r1(); // 重复释放不应泄漏额外许可
  assert.equal(sem.available, 1);

  const r2 = await sem.acquire();
  assert.equal(sem.available, 0);
  r2();
});

test('构造非法许可数抛错（fail-fast）', () => {
  assert.throws(() => new Semaphore(0), /正整数/);
  assert.throws(() => new Semaphore(-1), /正整数/);
  assert.throws(() => new Semaphore(1.5), /正整数/);
});
