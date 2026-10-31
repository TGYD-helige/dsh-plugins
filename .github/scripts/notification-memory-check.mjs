/** Build dsh-a2a first, then run with node --expose-gc. No network or database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Context } from '@deepseek-ai/cordis';
import { installNotifications } from '../../packages/dsh-a2a/lib/notifications.js';

assert.equal(typeof global.gc, 'function', 'Run with node --expose-gc');
const ctx = new Context();
let deliveries = 0;
ctx.provide('sessions', { flush: async () => true });
installNotifications(ctx, {
  message: async () => {
    deliveries++;
    return true;
  },
});
const session = { id: 'long-lived-memory-check' };
let warmHeap;
try {
  for (let seq = 0; seq < 50_000; seq++) {
    const id = randomUUID();
    ctx.emit('a2a/message-admitted', {
      contextId: session.id,
      taskId: 'fixture',
      a2aMessageId: id,
      dshMessageId: id,
      requestHeaders: undefined,
    });
    ctx.emit('session/event', session, {
      type: 'user/message',
      seq,
      data: { id, source: { kind: 'user' } },
    });
    // Stay below the pending delivery limit so every fixture notification is sent.
    if (seq % 64 === 63 || seq === 4_999) await setImmediate();
    if (seq === 4_999) {
      global.gc();
      warmHeap = process.memoryUsage().heapUsed;
    }
  }
  await setImmediate();
  global.gc();
  const retainedMiB = (process.memoryUsage().heapUsed - warmHeap) / 1024 / 1024;
  assert.equal(deliveries, 50_000);
  assert.ok(
    retainedMiB < 4,
    `45,000 completed notifications retained ${retainedMiB.toFixed(2)} MiB`,
  );
  console.log(
    `Notification memory check passed: 50,000 delivered; retained growth ${retainedMiB.toFixed(2)} MiB after warmup`,
  );
} finally {
  await ctx.fiber.dispose();
}
