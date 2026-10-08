/** Real A2A 0.3 client: explicit interaction endings and same-task continuation. */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { assert, bootA2a, stopA2a, THINKING_OFF } from './lib/a2a-shared.mjs';

// The pinned legacy SDK is a test-only alias; production stays on SDK 1.x.
const require = createRequire(new URL('../../../packages/dsh-a2a/package.json', import.meta.url));
const { JsonRpcTransport } = await import(require.resolve('@a2a-js/sdk-v03/client'));
const boot = await bootA2a({ tag: 'legacy', extraPatch: THINKING_OFF });
try {
  const client = new JsonRpcTransport({ endpoint: `${boot.a2a}/a2a/` });
  let taskId;
  let contextId;
  for (const text of ['只回复 hello', '只回复 again']) {
    const events = [];
    for await (const event of client.sendMessageStream({
      message: {
        kind: 'message', messageId: randomUUID(), role: 'user', taskId, contextId,
        parts: [{ kind: 'text', text }],
      },
    })) events.push(event);
    const last = events.at(-1);
    assert(last?.kind === 'status-update' && last.final === true,
      `missing explicit final: ${JSON.stringify(last)}`);
    assert(last.status.state === 'input-required', `unexpected state: ${last.status.state}`);
    assert(last.metadata?.dshAgent?.reason === 'completed', 'missing completed reason');
    assert(events.filter(event => event.kind === 'status-update' && event.final).length === 1,
      'expected exactly one final status');
    assert(last.status.message?.parts.some(part => part.kind === 'text' && part.text.trim()),
      'missing final answer');
    if (taskId) assert(last.taskId === taskId && last.contextId === contextId, 'continuation changed task');
    taskId = last.taskId;
    contextId = last.contextId;
  }
  console.log(`SCENARIO_OK legacy (task=${taskId})`);
} finally {
  await stopA2a(boot.proc);
}
