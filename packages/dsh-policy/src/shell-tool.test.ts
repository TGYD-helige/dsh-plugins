/**
 * Real-shell-tool tests: the policy gate in front of the actual model-facing
 * `bash` tool (@deepseek-ai/dsh-tool-bash, not a test double) — proving the
 * real tool name/argument shape matches the plugin's `commandKeys` default,
 * and that a denied command never reaches the shell executor. The executor
 * behind `ctx.shell` is a stub recording what it would run; executing
 * commands for real is the E2E legs' job.
 */

import { Context } from '@deepseek-ai/cordis';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import ShellExecutor, {
  type ShellExecRequest,
  type ShellExecSpec,
  type ShellProcess,
  type ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import * as shellEnv from '@deepseek-ai/dsh-shell-env';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import * as bashTool from '@deepseek-ai/dsh-tool-bash';
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { beforeEach, describe, expect, it } from 'vitest';
import { apply, type PolicyPluginConfig } from './index.js';

/** A ctx.shell provider that records requests instead of spawning processes. */
class StubShell extends ShellExecutor {
  readonly executed: string[] = [];

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 5_000,
      stdoutMaxBytes: 65_536,
      sandboxPolicy: undefined,
    };
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.executed.push(spec.command);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: `stub-ran:${spec.command}\n`, truncated: false },
      stderr: { text: '', truncated: false },
    };
  }

  start(_spec: ShellExecSpec): ShellProcess {
    throw new Error('background execution is not supported in tests');
  }
}

async function setup(config?: PolicyPluginConfig): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(shellEnv as never);
  await ctx.plugin(StubShell);
  // The real model-facing bash tool; background is off so ctx.jobs is never
  // touched.
  await ctx.plugin(bashTool as never, { enableRunInBackground: false });
  if (config) apply(ctx, config);
  return ctx;
}

let callSeq = 0;
function runBash(ctx: Context, command: string): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: `c${++callSeq}` as ToolCallId,
    name: 'bash',
    arguments: { command, description: 'policy test call' },
    signal: new AbortController().signal,
  });
}

const shellOf = (ctx: Context): StubShell => ctx.shell as StubShell;

describe('dsh-policy in front of the real bash tool', () => {
  beforeEach(() => {
    callSeq = 0;
  });

  it('an uncovered command reaches the executor', async () => {
    const ctx = await setup({ enabled: true, rules: [{ tool: '*', decision: 'allow' }] });
    const result = await runBash(ctx, 'echo hi');
    expect(result.isError).toBe(false);
    expect(shellOf(ctx).executed).toEqual(['echo hi']);
    expect(JSON.stringify(result.content)).toContain('stub-ran:echo hi');
  });

  it('a denied command never reaches the executor, with the rule message as the error', async () => {
    const ctx = await setup({
      enabled: true,
      rules: [
        {
          tool: 'bash',
          decision: 'deny',
          commandPrefix: 'npm',
          message: 'npm is not allowed. Use bun instead.',
        },
      ],
    });
    const result = await runBash(ctx, 'npm install');
    expect(result.isError).toBe(true);
    if (result.isError) expect(result.error.message).toContain('npm is not allowed');
    expect(shellOf(ctx).executed).toEqual([]);
  });

  it('ask fails closed without an approval service — no executor contact', async () => {
    const ctx = await setup({
      enabled: true,
      rules: [{ tool: 'bash', decision: 'ask', commandPrefix: 'npm', message: 'needs approval' }],
    });
    const result = await runBash(ctx, 'npm --version');
    expect(result.isError).toBe(true);
    expect(shellOf(ctx).executed).toEqual([]);
  });

  it('a denied segment inside a compound keeps the whole command off the executor', async () => {
    const ctx = await setup({
      enabled: true,
      rules: [
        { tool: '*', decision: 'allow', priority: 20 },
        { tool: 'bash', decision: 'deny', commandPrefix: 'npm', priority: 200 },
      ],
    });
    const result = await runBash(ctx, 'echo ok && npm i');
    expect(result.isError).toBe(true);
    expect(shellOf(ctx).executed).toEqual([]);
  });
});
