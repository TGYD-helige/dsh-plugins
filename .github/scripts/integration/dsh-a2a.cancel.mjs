/**
 * dsh-a2a cancel leg — the REAL cancellation path against a live turn:
 * start a long streaming turn, fire tasks/cancel once content is flowing, and
 * assert the stream ends on a canceled final (executor.cancelTask →
 * agent.cancel → turn/end aborted → translator). Then: the terminal guard
 * rejects taskId follow-ups, while contextId-only continuation keeps working
 * on the same session under a fresh task id.
 */

import { a2aClient, assert, bootA2a, stopA2a, THINKING_OFF } from './lib/a2a-shared.mjs';

const { a2a, proc } = await bootA2a({ tag: 'cancel', extraPatch: THINKING_OFF });
const client = a2aClient(a2a);

try {
  console.log('\n$ message/stream (long turn) + tasks/cancel mid-flight');
  const stream = await client.stream('message/stream', {
    message: client.userMessage('从 1 数到 300，每个数字一行，中间不要停'),
  });
  assert(stream.ok, `message/stream http ${stream.status}`);

  // Read the SSE body incrementally; cancel as soon as real content flows.
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let taskId;
  let cancelFired = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!raw.startsWith('data: ')) continue;
      const event = JSON.parse(raw.slice(6)).result;
      if (!event) continue;
      events.push(event);
      if (event.kind === 'task') taskId = event.id;
      if (
        !cancelFired &&
        taskId &&
        event.kind === 'status-update' &&
        event.status?.state === 'working' &&
        event.status.message
      ) {
        cancelFired = true;
        console.log(`first content frame seen — canceling task ${taskId}`);
        // Intentionally awaited inline: the cancel HTTP round-trip is quick,
        // and the stream keeps buffering meanwhile.
        const { body } = await client.rpc('tasks/cancel', { id: taskId });
        assert(
          body.result?.status?.state === 'canceled',
          `cancel response: ${JSON.stringify(body)}`,
        );
      }
    }
  }

  assert(cancelFired, 'never saw a content frame to cancel on');
  const canceledFinal = events.find(
    (e) => e.kind === 'status-update' && e.status?.state === 'canceled' && e.final === true,
  );
  assert(
    canceledFinal,
    `stream never delivered a canceled final: ${JSON.stringify(events.at(-1))}`,
  );
  console.log(`stream ended after ${events.length} events with canceled final`);

  const { body: got } = await client.rpc('tasks/get', { id: taskId });
  assert(got.result?.status?.state === 'canceled', `tasks/get state ${got.result?.status?.state}`);

  // Terminal guard: follow-ups addressed at the canceled task id are rejected.
  const { body: rejected } = await client.rpc('message/send', {
    message: client.userMessage('继续', { taskId }),
  });
  assert(rejected.error, 'a canceled task must reject taskId follow-ups');

  // …but the session survives: contextId-only continuation rebinds a fresh task.
  console.log('\n$ message/send (contextId-only after cancel)');
  const continued = await client.rpc('message/send', {
    message: client.userMessage('只回复 ok 即可', { contextId: got.result.contextId }),
  });
  assert(
    continued.body.result?.status?.state === 'input-required' &&
      continued.body.result.id !== taskId,
    `continuation after cancel failed: ${JSON.stringify(continued.body)}`,
  );

  console.log(`\nSCENARIO_OK cancel (task=${taskId}, continued=${continued.body.result.id})`);
} finally {
  await stopA2a(proc);
}
