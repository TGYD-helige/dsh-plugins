/** Run after building dsh-a2a; optional argument selects an isolated npm runtime directory. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { installNotifications } from '../../packages/dsh-a2a/lib/notifications.js';

const require = createRequire(resolve(process.argv[2] ?? '.', 'package.json'));
const load = (id) => import(pathToFileURL(require.resolve(id)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore } = await load('@deepseek-ai/dsh-session');
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent');
const { createUserMessage } = await load('@deepseek-ai/dsh-llm/message');
const ctx = new Context();
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  const session = ctx.sessions.create('notification-contract');
  const unregister = ctx.agents.register({ id: session.id, session, ctx });
  await unregister;
  let checkpoint;
  let flushed = false;
  const gate = new Promise((resolve) => {
    checkpoint = resolve;
  });
  ctx.on('session/flush', async () => {
    await gate;
    flushed = true;
  });
  const messages = [];
  const inbox = [];
  let signal;
  let reentrantError;
  ctx.on('session/event', (live, event) => {
    if (event.type !== 'user/message') return;
    try {
      live.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] });
    } catch (error) {
      reentrantError = error;
    }
  });
  installNotifications(ctx, {
    message: async (detail, disposal) => {
      assert.equal(flushed, true);
      signal = disposal;
      messages.push(detail);
      return true;
    },
    inbox: async (detail) => {
      assert.equal(flushed, true);
      inbox.push(detail);
      return true;
    },
  });
  const message = createUserMessage({
    content: [{ type: 'text', text: 'contract' }],
    source: { kind: 'user' },
  });
  ctx.emit('a2a/inbox', {
    phase: 'selected',
    contextId: session.id,
    taskId: 'selected',
    messageId: 'protocol',
    nativeMessageId: message.id,
  });
  const committed = session.append('user/message', message, { surfaceOp: 'append' });
  assert.match(String(reentrantError), /cannot reenter/, 'native publication must remain ordered');
  const splice = session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [],
  });
  await setTimeout(0);
  assert.equal(messages.length + inbox.length, 0);
  ctx.emit('a2a/message-admitted', {
    contextId: session.id,
    taskId: 'admitted',
    a2aMessageId: 'protocol',
    dshMessageId: message.id,
    requestHeaders: { identity: 'fixture-owner' },
  });
  checkpoint();
  for (let attempt = 0; attempt < 100 && (!messages.length || !inbox.length); attempt++)
    await setTimeout(5);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].taskId, 'selected');
  assert.deepEqual(messages[0].requestHeaders, { identity: 'fixture-owner' });
  assert.deepEqual(inbox, [{ contextId: session.id, version: splice.seq }]);
  ctx.emit('session/event', session, committed);
  await setTimeout(0);
  assert.equal(messages.length, 1, 'a replay keeps its native seq and must not resend');
  await unregister();
  assert.equal(signal.aborted, true, 'native agent disposal cancels the context');
  console.log(
    'Notification runtime contract passed:',
    ['cordis', 'dsh-session', 'dsh-agent']
      .map((name) => `${name}@${require(`@deepseek-ai/${name}/package.json`).version}`)
      .join(', '),
  );
} finally {
  await ctx.fiber.dispose();
}
