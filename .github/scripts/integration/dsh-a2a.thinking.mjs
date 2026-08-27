/**
 * dsh-a2a thinking leg — the reasoning event path: with `llm-deepseek`
 * thinking at max effort, a pure-chat stream must carry thought-marked
 * status-updates (metadata.dshAgent.kind === 'thought', a separate messageId
 * from the answer's text stream) before the final input-required.
 *
 * No tools in this leg: reasoning enabled makes the integration gateway
 * stochastically garble tool calls, and tool behavior is already covered by
 * the base leg. Model variance (an occasionally thought-free answer) is
 * absorbed by retrying on a fresh task.
 */

import { a2aClient, assert, bootA2a, readEvents, stopA2a, THINKING_MAX } from './lib/a2a-shared.mjs';

const { a2a, proc } = await bootA2a({ tag: 'thinking', extraPatch: THINKING_MAX });
const client = a2aClient(a2a);

try {
  let thoughtEvents = [];
  let textIds = new Set();
  let finalEvent;
  for (let attempt = 1; attempt <= 3 && thoughtEvents.length === 0; attempt++) {
    console.log(`\n$ message/stream with thinking at max (attempt ${attempt})`);
    const res = await client.stream('message/stream', {
      message: client.userMessage('9.11 和 9.9 哪个大？给出判断即可'),
    });
    assert(res.ok, `message/stream http ${res.status}`);
    const events = await readEvents(res);
    thoughtEvents = events.filter(
      (e) => e.kind === 'status-update' && e.metadata?.dshAgent?.kind === 'thought',
    );
    textIds = new Set(
      events
        .filter((e) => e.kind === 'status-update' && e.metadata?.dshAgent?.kind === 'text-content')
        .map((e) => e.status.message?.messageId),
    );
    finalEvent = events.at(-1);
    if (thoughtEvents.length === 0) {
      console.log('::warning::no thought events in this stream — retrying on a fresh task');
    }
  }

  assert(thoughtEvents.length > 0, 'no thought-marked status-update across 3 attempts');
  assert(
    finalEvent?.kind === 'status-update' &&
      finalEvent.status.state === 'input-required' &&
      finalEvent.final === true,
    `stream must end on a final input-required, got ${JSON.stringify(finalEvent)}`,
  );

  // Thoughts and answer text stream on different messageIds.
  for (const id of new Set(thoughtEvents.map((e) => e.status.message?.messageId))) {
    assert(!textIds.has(id), 'thought and text deltas must not share a messageId');
  }

  console.log(`\nSCENARIO_OK thinking (thoughtEvents=${thoughtEvents.length})`);
} finally {
  await stopA2a(proc);
}
