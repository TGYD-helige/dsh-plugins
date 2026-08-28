/**
 * dsh-a2a turns leg — conversation semantics on the A2A 1.0 wire against a
 * real dsh `web` profile:
 *
 * 1. multi-turn memory on one task (turn 2 recalls turn 1's codeword without tools)
 * 2. contextId-only continuation (no taskId): the SDK mints a fresh task id and
 *    the bridge rebinds it to the live session
 * 3. non-blocking SendMessage (`configuration.returnImmediately`) returning a
 *    non-final task immediately, with GetTask polling to the turn's end
 * 4. SubscribeToTask on a settled (input-required) task: yields the current
 *    task snapshot as the first event (the 1.0 #418 behavior); the bus stays
 *    alive for interrupted tasks, so the leg reads exactly that first frame
 *    and disconnects
 */

import { a2aClient, assert, bootA2a, STATES, stopA2a, textOf, THINKING_OFF } from './lib/a2a-shared.mjs';

const { a2a, proc } = await bootA2a({ tag: 'turns', extraPatch: THINKING_OFF });
const client = a2aClient(a2a);

const codeword = '424242';

try {
  // 1. Turn 1 plants the codeword; turn 2 must recall it from session context.
  console.log('\n$ turn 1 (plant codeword)');
  const send1 = await client.rpc('SendMessage', {
    message: client.userMessage(`记住这个数字：${codeword}。只回复 ok`),
  });
  assert(!send1.body.error, `turn 1 rpc error: ${JSON.stringify(send1.body.error)}`);
  assert(
    send1.body.result?.task?.status?.state === STATES.inputRequired,
    `turn 1 state ${send1.body.result?.task?.status?.state}`,
  );
  const taskId = send1.body.result.task.id;
  const contextId = send1.body.result.task.contextId;

  console.log('\n$ turn 2 (recall, same taskId)');
  const send2 = await client.rpc('SendMessage', {
    message: client.userMessage('我刚才让你记住的数字是什么？只回复数字', { taskId, contextId }),
  });
  const answer2 = textOf(send2.body.result?.task);
  console.log(`recall answer: ${JSON.stringify(answer2.slice(0, 200))}`);
  assert(answer2.includes(codeword), `turn 2 did not recall the codeword: ${answer2}`);

  // 2. contextId-only continuation: same session, fresh task id.
  console.log('\n$ turn 3 (contextId only — rebind to a fresh task id)');
  const send3 = await client.rpc('SendMessage', {
    message: client.userMessage('再确认一次，那个数字是？只回复数字', { contextId }),
  });
  assert(!send3.body.error, `turn 3 rpc error: ${JSON.stringify(send3.body.error)}`);
  assert(
    send3.body.result?.task?.id && send3.body.result.task.id !== taskId,
    'contextId-only send must mint a fresh task id',
  );
  const answer3 = textOf(send3.body.result.task);
  assert(answer3.includes(codeword), `turn 3 (rebound session) lost the codeword: ${answer3}`);

  // 3. Non-blocking send: the response is the first event's task (non-final),
  //    and the turn completes in the background.
  console.log('\n$ SendMessage (returnImmediately)');
  const early = await client.rpc('SendMessage', {
    message: client.userMessage('只回复 ok 即可'),
    configuration: { returnImmediately: true },
  });
  assert(!early.body.error, `non-blocking rpc error: ${JSON.stringify(early.body.error)}`);
  const earlyTask = early.body.result?.task;
  assert(earlyTask, `non-blocking must return a task, got ${JSON.stringify(early.body)}`);
  assert(
    earlyTask.status?.state !== STATES.inputRequired,
    `non-blocking send must return before the turn ends, got ${earlyTask.status?.state}`,
  );
  let settled;
  for (let i = 0; i < 120 && !settled; i++) {
    const { body } = await client.rpc('GetTask', { id: earlyTask.id });
    if (body.result?.status?.state === STATES.inputRequired) settled = body.result;
    else await new Promise((r) => setTimeout(r, 500));
  }
  assert(settled, `task ${earlyTask.id} never settled to input-required`);

  // 4. SubscribeToTask on the settled task: the first event is the current
  //    task snapshot (1.0 #418). The bus is kept alive for interrupted tasks,
  //    so the stream would wait for future events — read the snapshot, then
  //    disconnect.
  console.log('\n$ SubscribeToTask (settled task)');
  const res = await client.stream('SubscribeToTask', { id: earlyTask.id });
  assert(res.ok, `subscribe http ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let snapshot;
  const deadline = Date.now() + 10_000;
  while (!snapshot && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0 && !snapshot) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!raw.startsWith('data: ')) continue;
      const result = JSON.parse(raw.slice(6)).result;
      if (result?.task) snapshot = result.task;
    }
  }
  await reader.cancel();
  assert(snapshot, 'no task snapshot as the first resubscribe event');
  assert(snapshot.id === earlyTask.id, `snapshot task ${snapshot.id}`);
  assert(
    snapshot.status?.state === STATES.inputRequired,
    `snapshot state ${snapshot.status?.state}`,
  );

  console.log(
    `\nSCENARIO_OK turns (task=${taskId}, rebound=${send3.body.result.task.id}, nonBlocking=${earlyTask.id})`,
  );
} finally {
  await stopA2a(proc);
}
