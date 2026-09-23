import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The plugin's bridge imports installModelSelection from the dsh-agent root
// module, which pulls workspace-internal packages absent here (dsh-scope).
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }));

import { type A2aPluginConfig, apply, inject, name } from './index.js';

const config = (overrides: Partial<A2aPluginConfig> = {}): A2aPluginConfig => ({
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  basePath: '/a2a',
  cwd: process.cwd(),
  uploadsDir: '',
  agent: { provider: '', model: '', preset: '' },
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

  it('clears a stored context after its live bridge binding is gone', async () => {
    const setIdentity = vi.fn();
    ctx.provide('storageIdentity', { set: setIdentity });
    let session: { id: string };
    ctx.provide('agents', {
      create: async ({ sessionId }: { sessionId: string }) => {
        session = { id: sessionId };
        return {
          agent: {
            session,
            followup: () => {
              ctx.emit(
                'session/event',
                session as never,
                { type: 'turn/start', seq: 0, time: Date.now(), data: { turn: 1 } } as never,
              );
              ctx.emit(
                'session/event',
                session as never,
                {
                  type: 'turn/end',
                  seq: 1,
                  time: Date.now(),
                  data: { turn: 1, reason: { kind: 'completed' } },
                } as never,
              );
            },
            cancel: () => {},
            whenIdle: async () => {},
          },
          dispose: async () => {},
        };
      },
    } as never);
    const { port } = (await apply(ctx, config()))!;
    const base = `http://127.0.0.1:${port}/a2a/`;
    const sent = (await (
      await fetch(base, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'A2A-Version': '1.0',
          'x-platform-user-id': 'platform',
          'x-app-user-id': 'app',
          'x-app-user-uid': 'wrong',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'SendMessage',
          params: {
            tenant: '',
            message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] },
          },
        }),
      })
    ).json()) as any;
    const task = sent.result.task;
    expect(setIdentity).toHaveBeenCalledWith(task.contextId, 'platform');
    ctx.emit('session/disposed', session! as never);
    const service = ctx.get('a2aTasks') as { clearContext(id: string): Promise<string[]> };
    expect(await service.clearContext(task.contextId)).toEqual([task.id]);
    const got = (await (
      await fetch(base, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'GetTask',
          params: { tenant: '', id: task.id },
        }),
      })
    ).json()) as any;
    expect(got.error).toBeDefined();

    const fallback = (await (
      await fetch(base, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'A2A-Version': '1.0',
          'x-app-user-id': 'app',
          'x-app-user-uid': 'wrong',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'SendMessage',
          params: {
            tenant: '',
            message: { messageId: 'm2', role: 'ROLE_USER', parts: [{ text: 'again' }] },
          },
        }),
      })
    ).json()) as any;
    expect(setIdentity).toHaveBeenCalledWith(fallback.result.task.contextId, 'app');
  });
});
