/** E2E-only producer: execute a real process at the public tool hook seams. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const name = 'tool-hook-e2e';
export const inject = ['sessions'];

export function apply(ctx) {
  async function report(point, exec, toolResult) {
    if (!exec.agent || !JSON.stringify(exec.arguments ?? {}).includes('ci-marker-tool-hooks-')) return;
    const session = ctx.sessions.get(exec.agent.id);
    const turn = session.snapshotEvents().findLast((event) => event.type === 'turn/start').data.turn;
    const identity = { turn, point, handlerId: 'verify-marker', invocationId: randomUUID(), callId: exec.callId };
    const input = { point, callId: exec.callId, toolName: exec.name, arguments: exec.arguments,
      ...(toolResult ? { toolResult } : {}), token: 'sk-lf-hook-fixture-private' };
    session.append('hook/invoked', { ...identity, dialect: 'codex', name: 'verify-marker', input });
    const startedAt = Date.now();
    try {
      const { stdout, stderr } = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, [fileURLToPath(new URL('./tool-hook-script.mjs', import.meta.url))],
          { cwd: session.header.cwd ?? process.cwd(), signal: exec.signal, timeout: 10_000, maxBuffer: 16 * 1024 },
          (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
        child.stdin.end(JSON.stringify(input));
      });
      session.append('hook/result', { ...identity, decision: 'pass', outcome: 'success', exitCode: 0,
        durationMs: Date.now() - startedAt, result: JSON.parse(stdout), stdout, stderr });
    } catch (error) {
      session.append('hook/result', { ...identity, decision: 'pass', outcome: 'failed',
        durationMs: Date.now() - startedAt });
      throw error; // A broken test fixture must fail the E2E leg.
    }
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    await report('BeforeTool', exec);
    return next();
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    await report('AfterTool', exec, result);
    return next();
  });
}
