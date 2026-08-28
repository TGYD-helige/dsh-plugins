/**
 * dsh-a2a cancel leg — the REAL cancellation path against a live turn:
 * start a long streaming turn, fire CancelTask once content is flowing, and
 * assert the stream ends on a canceled statusUpdate (executor.cancelTask →
 * agent.cancel → turn/end aborted → translator). Then: the terminal guard
 * rejects taskId follow-ups, while contextId-only continuation keeps working
 * on the same session under a fresh task id.
 *
 * On the A2A 1.0 wire: terminal states close the SDK's event queue (the
 * `final` flag is gone), and the frames are oneof-keyed (`result.task` /
 * `result.statusUpdate`).
 */

import { a2aClient, assert, bootA2a, frameOf, STATES, stopA2a, THINKING_OFF } from './lib/a2a-shared.mjs';

const { a2a, proc } = await bootA2a({ tag: 'cancel', extraPatch: THINKING_OFF });
const client = a2aClient(a2a);

try {
  console.log('\n$ SendStreamingMessage (long turn) + CancelTask mid-flight');
  const stream = await client.stream('SendStreamingMessage', {
    message: client.userMessage('从 1 数到 300，每个数字一行，中间不要停'),
  });
  assert(stream.ok, `SendStreamingMessage http ${stream.status}`);

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
      const event = frameOf(JSON.parse(raw.slice(6)).result);
      if (!event) continue;
      events.push(event);
      const { kind } = event;
      if (kind === 'task') taskId = event.value.id;
      if (
        !cancelFired &&
        taskId &&
        kind === 'statusUpdate' &&
        event.value.status?.state === STATES.working &&
        event.value.status.message
      ) {
        cancelFired = true;
        console.log(`first content frame seen — canceling task ${taskId}`);
        // Intentionally awaited inline: the cancel HTTP round-trip is quick,
        // and the stream keeps buffering meanwhile.
        const { body } = await client.rpc('CancelTask', { id: taskId });
        assert(
          body.result?.status?.state === STATES.canceled,
          `cancel response: ${JSON.stringify(body)}`,
        );
      }
    }
  }

  assert(cancelFired, 'never saw a content frame to cancel on');
  const canceledFinal = events.find(
    (e) => e.kind === 'statusUpdate' && e.value.status?.state === STATES.canceled,
  );
  assert(
    canceledFinal,
    `stream never delivered a canceled statusUpdate: ${JSON.stringify(events.at(-1))}`,
  );
  console.log(`stream ended after ${events.length} events with canceled state`);

  const { body: got } = await client.rpc('GetTask', { id: taskId });
  assert(
    got.result?.status?.state === STATES.canceled,
    `GetTask state ${got.result?.status?.state}`,
  );

  // Terminal guard: follow-ups addressed at the canceled task id are rejected.
  const { body: rejected } = await client.rpc('SendMessage', {
    message: client.userMessage('继续', { taskId }),
  });
  assert(rejected.error, 'a canceled task must reject taskId follow-ups');

  // …but the session survives: contextId-only continuation rebinds a fresh task.
  console.log('\n$ SendMessage (contextId-only after cancel)');
  const continued = await client.rpc('SendMessage', {
    message: client.userMessage('只回复 ok 即可', { contextId: got.result.contextId }),
  });
  assert(
    continued.body.result?.task?.status?.state === STATES.inputRequired &&
      continued.body.result.task.id !== taskId,
    `continuation after cancel failed: ${JSON.stringify(continued.body)}`,
  );

  console.log(`\nSCENARIO_OK cancel (task=${taskId}, continued=${continued.body.result.task.id})`);
} finally {
  await stopA2a(proc);
}
