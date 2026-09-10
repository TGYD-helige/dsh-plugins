/**
 * Pipeline tests: the policy plugin against the REAL dsh-tools execution
 * pipeline (SystemPrompt + ToolRuntime services mounted, a `bash`-shaped tool
 * registered via defineTool, calls driven through `ctx.tools.execute()`).
 * This is the seam contract unit tests can't prove: the runtime really runs
 * `tools/pre-execute` before dispatch, a `deny` never reaches the tool body,
 * and an unanswered `ask` fails closed.
 */

import { Context } from '@deepseek-ai/cordis';
import type { ToolCallId } from '@deepseek-ai/dsh-llm';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, type PolicyPluginConfig } from './index.js';

/** Commands the tool body actually ran (the gate's ground truth). */
let ran: string[] = [];

function registerBash(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'bash',
      description: 'test double for the shell tool',
      parameters: { command: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args) => {
        ran.push(args.command);
        return `ran:${args.command}`;
      },
    }),
  );
}

async function setup(config?: PolicyPluginConfig): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  registerBash(ctx);
  if (config) apply(ctx, config);
  return ctx;
}

let callSeq = 0;
function runBash(ctx: Context, command: string): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: `c${++callSeq}` as ToolCallId,
    name: 'bash',
    arguments: { command },
    signal: new AbortController().signal,
  });
}

describe('dsh-policy against the real tools pipeline', () => {
  beforeEach(() => {
    ran = [];
  });

  it('executes everything with no policy configured (pass-through default)', async () => {
    const ctx = await setup();
    const result = await runBash(ctx, 'npm install');
    expect(result.isError).toBe(false);
    expect(ran).toEqual(['npm install']);
  });

  it('executes everything when the plugin is disabled or has no rules', async () => {
    const ctx = await setup({ enabled: false, rules: [{ tool: '*', decision: 'deny' }] });
    const result = await runBash(ctx, 'npm install');
    expect(result.isError).toBe(false);
    expect(ran).toEqual(['npm install']);
  });

  it('deny: the tool body never runs and the reason reaches the result', async () => {
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
    const denied = await runBash(ctx, 'npm install');
    expect(denied.isError).toBe(true);
    if (denied.isError) expect(denied.error.message).toContain('npm is not allowed');
    // …while an uncovered command still executes.
    const allowed = await runBash(ctx, 'bun install');
    expect(allowed.isError).toBe(false);
    expect(ran).toEqual(['bun install']);
  });

  it('ask: fails closed to a denial when no approval service is composed', async () => {
    const ctx = await setup({
      enabled: true,
      rules: [{ tool: 'bash', decision: 'ask', commandPrefix: 'npm' }],
    });
    const result = await runBash(ctx, 'npm install');
    expect(result.isError).toBe(true);
    expect(ran).toEqual([]);
  });

  it('broad deny + narrow allow: the specific exception runs, the rest is denied', async () => {
    const ctx = await setup({
      enabled: true,
      rules: [
        { tool: 'bash', decision: 'deny', commandPrefix: 'bun run', priority: 200 },
        { tool: 'bash', decision: 'allow', commandPrefix: 'bun run lint', priority: 300 },
      ],
    });
    const lint = await runBash(ctx, 'bun run lint');
    expect(lint.isError).toBe(false);
    const test = await runBash(ctx, 'bun run test');
    expect(test.isError).toBe(true);
    expect(ran).toEqual(['bun run lint']);
  });

  it('broad allow + narrow deny: the exception is denied, the rest runs', async () => {
    const ctx = await setup({
      enabled: true,
      rules: [
        { tool: '*', decision: 'allow', priority: 20 },
        { tool: 'bash', decision: 'deny', commandPrefix: 'npm', priority: 200 },
      ],
    });
    expect((await runBash(ctx, 'bun install')).isError).toBe(false);
    expect((await runBash(ctx, 'npm install')).isError).toBe(true);
    expect(ran).toEqual(['bun install']);
  });

  it('denies a denied command hidden inside a compound', async () => {
    const ctx = await setup({
      enabled: true,
      rules: [
        { tool: '*', decision: 'allow', priority: 20 },
        { tool: 'bash', decision: 'deny', commandPrefix: 'npm', priority: 200 },
      ],
    });
    for (const command of ['bun run lint && npm i', 'echo "$(npm i)"', 'bun i; npm i']) {
      const result = await runBash(ctx, command);
      expect(result.isError).toBe(true);
    }
    expect(ran).toEqual([]);
  });
});
