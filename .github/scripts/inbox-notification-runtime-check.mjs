/** Build dsh-a2a first; optional argument selects an isolated npm runtime directory. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { installInboxNotifications } from '../../packages/dsh-a2a/lib/inbox-notifications.js';

const require = createRequire(resolve(process.argv[2] ?? '.', 'package.json'));
const load = (id) => import(pathToFileURL(require.resolve(id)).href);
const { Context } = await load('@deepseek-ai/cordis');
const { default: SessionStore } = await load('@deepseek-ai/dsh-session');
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent');
const ctx = new Context();
try {
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  const session = ctx.sessions.create('inbox-notification-contract');
  const unregister = ctx.agents.register({ id: session.id, session, ctx });
  await unregister;
  let finish;
  const checkpoint = new Promise((resolve) => {
    finish = resolve;
  });
  ctx.on('session/flush', () => checkpoint);
  const events = [];
  let signal;
  let block = false;
  let blocked = false;
  installInboxNotifications(ctx, async (detail, disposal) => {
    signal = disposal;
    if (block) {
      blocked = true;
      await new Promise((resolve) => disposal.addEventListener('abort', resolve, { once: true }));
      return false;
    }
    events.push(detail);
    return true;
  });
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] });
  const latest = session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [],
  });
  await setTimeout(0);
  assert.deepEqual(events, []);
  finish();
  for (let attempt = 0; attempt < 100 && !events.length; attempt++) await setTimeout(5);
  assert.deepEqual(events, [{ contextId: session.id, version: latest.seq }]);
  block = true;
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [] });
  for (let attempt = 0; attempt < 100 && !blocked; attempt++) await setTimeout(5);
  assert.equal(blocked, true);
  await unregister();
  assert.equal(signal.aborted, true);
  console.log(
    'Inbox notification runtime contract passed:',
    ['cordis', 'dsh-session', 'dsh-agent']
      .map((name) => `${name}@${require(`@deepseek-ai/${name}/package.json`).version}`)
      .join(', '),
  );
} finally {
  await ctx.fiber.dispose();
}
