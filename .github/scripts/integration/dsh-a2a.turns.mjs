/**
 * dsh-a2a turns leg — conversation semantics against a real dsh `web` profile:
 *
 * 1. multi-turn memory on one task (turn 2 recalls turn 1's codeword without tools)
 * 2. contextId-only continuation (no taskId): the SDK mints a fresh task id and
 *    the bridge rebinds it to the live session
 * 3. non-blocking message/send (`configuration.blocking: false`) returning a
 *    non-final task immediately, with tasks/get polling to the turn's end
 * 4. tasks/resubscribe on a settled task: yields the persisted task state once
 *    and ends (no event replay is retained — documented behavior)
 */

import { a2aClient, assert, bootA2a, readEvents, stopA2a, textOf, THINKING_OFF } from './lib/a2a-shared.mjs';

const { a2a, proc } = await bootA2a({ tag: 'turns', extraPatch: THINKING_OFF });
const client = a2aClient(a2a);

const codeword = '424242';

try {
  // 1. Turn 1 plants the codeword; turn 2 must recall it from session context.
  console.log('\n$ turn 1 (plant codeword)');
  const send1 = await client.rpc('message/send', {
    message: client.userMessage(`记住这个数字：${codeword}。只回复 ok`),
  });
  assert(send1.body.result?.kind === 'task', `turn 1: ${JSON.stringify(send1.body)}`);
  assert(
    send1.body.result.status?.state === 'input-required',
    `turn 1 state ${send1.body.result.status?.state}`,
  );
  const taskId = send1.body.result.id;
  const contextId = send1.body.result.contextId;

  console.log('\n$ turn 2 (recall, same taskId)');
  const send2 = await client.rpc('message/send', {
    message: client.userMessage('我刚才让你记住的数字是什么？只回复数字', { taskId, contextId }),
  });
  const answer2 = textOf(send2.body.result);
  console.log(`recall answer: ${JSON.stringify(answer2.slice(0, 200))}`);
  assert(answer2.includes(codeword), `turn 2 did not recall the codeword: ${answer2}`);

  // 2. contextId-only continuation: same session, fresh task id.
  console.log('\n$ turn 3 (contextId only — rebind to a fresh task id)');
  const send3 = await client.rpc('message/send', {
    message: client.userMessage('再确认一次，那个数字是？只回复数字', { contextId }),
  });
  assert(send3.body.result?.kind === 'task', `turn 3: ${JSON.stringify(send3.body)}`);
  assert(
    send3.body.result.id && send3.body.result.id !== taskId,
    'contextId-only send must mint a fresh task id',
  );
  const answer3 = textOf(send3.body.result);
  assert(answer3.includes(codeword), `turn 3 (rebound session) lost the codeword: ${answer3}`);

  // 3. Non-blocking send: the response is the first event's task (non-final),
  //    and the turn completes in the background.
  console.log('\n$ non-blocking message/send');
  const early = await client.rpc('message/send', {
    message: client.userMessage('只回复 ok 即可'),
    configuration: { blocking: false },
  });
  assert(early.body.result?.kind === 'task', `non-blocking: ${JSON.stringify(early.body)}`);
  assert(
    early.body.result.status?.state !== 'input-required',
    `non-blocking send must return before the turn ends, got ${early.body.result.status?.state}`,
  );
  const earlyId = early.body.result.id;
  let settled;
  for (let i = 0; i < 120 && !settled; i++) {
    const { body } = await client.rpc('tasks/get', { id: earlyId });
    if (body.result?.status?.state === 'input-required') settled = body.result;
    else await new Promise((r) => setTimeout(r, 500));
  }
  assert(settled, `task ${earlyId} never settled to input-required`);

  // 4. tasks/resubscribe on a settled task: one stored-state frame, then end.
  console.log('\n$ tasks/resubscribe (settled task)');
  const res = await client.stream('tasks/resubscribe', { id: earlyId });
  assert(res.ok, `resubscribe http ${res.status}`);
  const events = await readEvents(res);
  console.log(`resubscribe events: ${JSON.stringify(events)}`);
  assert(events.length === 1, `resubscribe must yield exactly the stored task, got ${events.length}`);
  assert(
    events[0].kind === 'task' && events[0].status?.state === 'input-required',
    `resubscribe frame: ${JSON.stringify(events[0])}`,
  );

  console.log(`\nSCENARIO_OK turns (task=${taskId}, rebound=${send3.body.result.id}, nonBlocking=${earlyId})`);
} finally {
  await stopA2a(proc);
}
