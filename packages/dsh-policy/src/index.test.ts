import { Context } from '@deepseek-ai/cordis';
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apply, inject, name, type PolicyPluginConfig } from './index.js';

const execOf = (toolName: string, args: unknown): ToolExecution =>
  ({ name: toolName, arguments: args }) as unknown as ToolExecution;

/** The downstream chain's answer when the plugin delegates. */
const downstream = (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' });

const allowAll = {
  enabled: true,
  rules: [{ tool: '*', decision: 'allow', priority: 20 }],
} as PolicyPluginConfig;

const geminiLike: PolicyPluginConfig = {
  enabled: true,
  rules: [
    { tool: '*', decision: 'allow', priority: 20 },
    {
      tool: 'bash',
      decision: 'deny',
      commandPrefix: 'npm',
      priority: 200,
      message: 'npm is not allowed. Use bun instead.',
    },
    { tool: 'bash', decision: 'deny', commandPrefix: 'bun run', priority: 200 },
    { tool: 'bash', decision: 'allow', commandPrefix: 'bun run lint', priority: 300 },
    { tool: 'bash', decision: 'allow', commandPrefix: 'grep', priority: 300 },
    { tool: 'write_file', decision: 'deny', argsPattern: '\\.md"', priority: 200 },
    { tool: 'write_file', decision: 'allow', argsPattern: 'PRODUCT\\.md', priority: 300 },
  ],
};

function hookNames(ctx: Context): string[] {
  return Object.keys((ctx.events as never as { _hooks: object })._hooks);
}

describe('dsh-policy plugin', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context();
  });

  it('exposes the plugin name and no hard injects', () => {
    expect(name).toBe('dsh-policy');
    expect(inject).toEqual([]);
  });

  it('registers no listener when disabled or ruleless', () => {
    const before = hookNames(ctx);
    apply(ctx, { enabled: false, rules: geminiLike.rules });
    apply(ctx, { enabled: true, rules: [] });
    expect(hookNames(ctx)).toEqual(before);
  });

  it('fails the load on an invalid rule regex', () => {
    expect(() =>
      apply(ctx, {
        enabled: true,
        rules: [{ tool: 'bash', decision: 'deny', commandRegex: '([' }],
      }),
    ).toThrow(/invalid regex/);
  });

  it('answers covered calls without delegating, delegates the rest', async () => {
    apply(ctx, allowAll);
    const next = vi.fn(downstream);
    // The allow-* rule covers every tool: the plugin answers, next never runs.
    await expect(
      ctx.waterfall('tools/pre-execute', execOf('bash', { command: 'ls' }), next),
    ).resolves.toEqual({ kind: 'allow' });
    expect(next).not.toHaveBeenCalled();
  });

  it('passes through with no matching rule at all', async () => {
    apply(ctx, {
      enabled: true,
      rules: [{ tool: 'bash', decision: 'deny', commandPrefix: 'npm' }],
    });
    const next = vi.fn(downstream);
    await expect(
      ctx.waterfall('tools/pre-execute', execOf('bash', { command: 'ls' }), next),
    ).resolves.toEqual({ kind: 'allow' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('maps a matching deny rule to a deny decision carrying the message', async () => {
    apply(ctx, geminiLike);
    const result = await ctx.waterfall(
      'tools/pre-execute',
      execOf('bash', { command: 'npm install' }),
      downstream,
    );
    expect(result).toEqual({ kind: 'deny', reason: 'npm is not allowed. Use bun instead.' });
  });

  it('supplies a default deny reason naming the matched rule', async () => {
    apply(ctx, {
      enabled: true,
      rules: [{ tool: 'bash', decision: 'deny', commandPrefix: 'npm', priority: 200 }],
    });
    const result = await ctx.waterfall(
      'tools/pre-execute',
      execOf('bash', { command: 'npm install' }),
      downstream,
    );
    expect(result).toEqual({
      kind: 'deny',
      reason: 'denied by policy: tool "bash", commandPrefix "npm" (priority 200)',
    });
  });

  it('lets a higher-priority allow override a broader deny on the same segment', async () => {
    apply(ctx, geminiLike);
    const result = await ctx.waterfall(
      'tools/pre-execute',
      execOf('bash', { command: 'bun run lint' }),
      downstream,
    );
    expect(result).toEqual({ kind: 'allow' });
  });

  it('denies a compound command when any segment denies', async () => {
    apply(ctx, geminiLike);
    const result = await ctx.waterfall(
      'tools/pre-execute',
      execOf('bash', { command: 'bun run lint && npm i' }),
      downstream,
    );
    expect(result).toEqual({ kind: 'deny', reason: 'npm is not allowed. Use bun instead.' });
  });

  it('keeps a piped compound denied when one segment hits a deny', async () => {
    apply(ctx, geminiLike);
    const result = await ctx.waterfall(
      'tools/pre-execute',
      execOf('bash', { command: 'bun run type-check | grep -E "error"' }),
      downstream,
    );
    // bun run type-check hits the bun-run deny — this compound must stay denied…
    expect(result).toMatchObject({ kind: 'deny' });
  });

  it('maps an ask rule to the approval seam with its reason', async () => {
    apply(ctx, {
      enabled: true,
      rules: [
        { tool: 'write_file', decision: 'ask', argsPattern: '/etc/', message: 'system path' },
      ],
    });
    const result = await ctx.waterfall(
      'tools/pre-execute',
      execOf('write_file', { file_path: '/etc/hosts' }),
      downstream,
    );
    expect(result).toEqual({ kind: 'ask', reason: 'system path' });
  });

  it('applies argsPattern rules to non-shell tools', async () => {
    apply(ctx, geminiLike);
    await expect(
      ctx.waterfall(
        'tools/pre-execute',
        execOf('write_file', { file_path: '/x/PRODUCT.md' }),
        downstream,
      ),
    ).resolves.toEqual({ kind: 'allow' });
    await expect(
      ctx.waterfall(
        'tools/pre-execute',
        execOf('write_file', { file_path: '/x/NOTES.md' }),
        downstream,
      ),
    ).resolves.toMatchObject({ kind: 'deny' });
  });

  it('accepts array-valued tool and commandPrefix (any-of)', async () => {
    apply(ctx, {
      enabled: true,
      rules: [
        {
          tool: ['bash', 'pwsh'],
          decision: 'deny',
          commandPrefix: ['npm', 'yarn', 'pnpm'],
          message: 'use bun',
        },
      ],
    });
    await expect(
      ctx.waterfall('tools/pre-execute', execOf('bash', { command: 'yarn add x' }), downstream),
    ).resolves.toMatchObject({ kind: 'deny' });
    await expect(
      ctx.waterfall('tools/pre-execute', execOf('pwsh', { command: 'pnpm i' }), downstream),
    ).resolves.toMatchObject({ kind: 'deny' });
    const next = vi.fn(downstream);
    await ctx.waterfall('tools/pre-execute', execOf('read_file', { path: 'a' }), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('applies the object form of argsPattern through the gate', async () => {
    apply(ctx, {
      enabled: true,
      rules: [
        {
          tool: 'write_file',
          decision: 'ask',
          argsPattern: { file_path: '(^|/)etc/' },
          message: 'writes to a system path',
        },
      ],
    });
    await expect(
      ctx.waterfall(
        'tools/pre-execute',
        execOf('write_file', { file_path: '/etc/hosts' }),
        downstream,
      ),
    ).resolves.toEqual({ kind: 'ask', reason: 'writes to a system path' });
    const next = vi.fn(downstream);
    await ctx.waterfall(
      'tools/pre-execute',
      execOf('write_file', { file_path: '/tmp/x', note: 'mentions /etc/ inside another field' }),
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('swallows evaluation errors with the [dsh-policy] prefix and delegates', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apply(ctx, geminiLike);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await ctx.waterfall('tools/pre-execute', execOf('bash', circular), downstream);
    expect(result).toEqual({ kind: 'allow' }); // downstream's answer
    expect(errorSpy).toHaveBeenCalledWith('[dsh-policy] evaluation failed:', expect.any(Error));
    errorSpy.mockRestore();
  });
});
