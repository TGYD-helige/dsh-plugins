/** E2E-only producer: cancel a real tool turn, then report after its successor starts. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const name = 'cancel-hook-e2e';
export const inject = ['sessions', 'agents'];

export function apply(ctx) {
  const cancelled = new Map();
  const tasks = new Set();
  ctx.on('tools/pre-execute', async (exec, next) => {
    const marker = JSON.stringify(exec.arguments ?? {}).match(/ci-marker-cancel-hook-[\w-]+\.txt/)?.[0];
    if (!exec.agent || !marker || cancelled.has(exec.agent.id)) return next();
    const agent = ctx.agents.get(exec.agent.id);
    assert.ok(agent, 'cancellation fixture requires a live agent');
    const session = ctx.sessions.get(exec.agent.id);
    const turn = session.snapshotEvents().findLast((event) => event.type === 'turn/start').data.turn;
    cancelled.set(session.id, { turn, marker });
    agent.cancel({ kind: 'user' });
    agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '只回复 cancellation follow-up，不要调用工具。' }] });
    return next();
  });

  ctx.on('session/event', (session, event) => {
    const state = cancelled.get(session.id);
    if (!state) return;
    if (event.type === 'turn/end' && event.data.turn === state.turn) {
      state.endReason = event.data.reason.kind;
    }
    if (event.type !== 'turn/start' || event.data.turn <= state.turn || state.reported) return;
    state.reported = true;
    // Leave session.append's synchronous dispatch before publishing detached hook records.
    const task = Promise.resolve().then(async () => {
      assert.equal(state.endReason, 'aborted');
      const identity = { turn: state.turn, point: 'UserCancel', handlerId: 'cancel-observer',
        invocationId: randomUUID() };
      session.append('hook/invoked', { ...identity, dialect: 'gemini', name: 'cancel-observer',
        input: { marker: state.marker, nextTurn: event.data.turn } });
      const startedAt = Date.now();
      const { stdout } = await new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e',
          'setTimeout(() => process.stdout.write(JSON.stringify({ reason: "cancel-observed" })), 50)'],
        { timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve({ stdout }));
      });
      session.append('hook/result', { ...identity, decision: 'pass', outcome: 'success', exitCode: 0,
        durationMs: Date.now() - startedAt, result: JSON.parse(stdout) });
    });
    tasks.add(task);
    void task.catch((error) => { console.error('[cancel-hook-e2e]', error.message); process.exitCode = 1; });
  });
  const drain = async () => { await Promise.all(tasks); };
  ctx.on('session/flush', drain);
  ctx.effect(() => drain);
}
