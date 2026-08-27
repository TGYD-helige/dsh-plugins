import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type A2aPluginConfig, apply, inject, name } from './index.js';

const config = (overrides: Partial<A2aPluginConfig> = {}): A2aPluginConfig => ({
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  basePath: '/a2a',
  cwd: process.cwd(),
  agent: { provider: '', model: '' },
  card: { name: 'test-agent', description: 'd', version: '0.0.0', publicUrl: '' },
  taskStore: 'memory',
  redis: { url: '', keyPrefix: 'a2a', ttlSeconds: 1 },
  gcs: { bucket: '', prefix: 'tasks', keyFilename: '' },
  ...overrides,
});

describe('dsh-a2a plugin', () => {
  let ctx: Context;

  beforeEach(() => {
    ctx = new Context();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.fiber.dispose().catch(() => {});
  });

  it('exposes the plugin name and the agents dependency', () => {
    expect(name).toBe('dsh-a2a');
    expect(inject).toEqual(['agents']);
  });

  it('does nothing when disabled', () => {
    const result = apply(ctx, config({ enabled: false }));
    expect(result).toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('serves the agent card while loaded and closes the server on fiber unload', async () => {
    const started = await apply(ctx, config());
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[dsh-a2a] A2A endpoint:'));

    const port = started!.port;
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('test-agent');

    await ctx.fiber.dispose();
    await expect(fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)).rejects.toThrow();
  });

  it("fails startup when taskStore is 'gcs' without a bucket", async () => {
    await expect(apply(ctx, config({ taskStore: 'gcs' }))).rejects.toThrow(
      "taskStore 'gcs' requires gcs.bucket",
    );
  });
});
