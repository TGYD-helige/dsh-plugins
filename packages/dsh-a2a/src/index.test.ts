import { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The plugin's bridge imports installModelSelection from the dsh-agent root
// module, which pulls workspace-internal packages absent here (dsh-scope).
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: vi.fn() }));

import { type A2aPluginConfig, apply, Config, inject, name } from './index.js';

const config = (overrides: Partial<A2aPluginConfig> = {}): A2aPluginConfig => ({
  enabled: true,
  host: '127.0.0.1',
  port: 0,
  basePath: '/a2a',
  cwd: process.cwd(),
  uploadsDir: '',
  subagentTools: { enabled: false },
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

  it('defaults heartbeats off at 15 seconds and validates configured intervals', () => {
    expect(Config({}).heartbeat).toEqual({ enabled: false, intervalMs: 15_000 });
    expect(Config({ heartbeat: { enabled: true, intervalMs: 25_000 } }).heartbeat).toEqual({
      enabled: true,
      intervalMs: 25_000,
    });
    for (const intervalMs of [0, -1, 1.5, Infinity, 2_147_483_648]) {
      expect(() => Config({ heartbeat: { enabled: true, intervalMs } })).toThrow();
    }
  });

  it('requires explicit pending retention on host shutdown', () => {
    expect(Config({}).inbox).toEqual({ enabled: false, shutdown: 'cancel' });
    expect(Config({ inbox: { enabled: true, shutdown: 'retain-pending' } }).inbox.shutdown).toBe(
      'retain-pending',
    );
    expect(() => Config({ inbox: { shutdown: 'replay' as never } })).toThrow();
  });

  it('enables standard push notifications only by explicit configuration', () => {
    expect(Config({}).pushNotifications).toBe(false);
    expect(Config({ pushNotifications: true }).pushNotifications).toBe(true);
  });

  it('defaults optional bindings off and validates the gRPC port', () => {
    expect(Config({}).rest).toBe(false);
    expect(Config({}).grpc).toEqual({ enabled: false, port: 41242, publicUrl: '' });
    expect(Config({ grpc: { enabled: true, port: 0 } }).grpc.port).toBe(0);
    expect(() => Config({ grpc: { port: 65536 } })).toThrow();
  });

  it('wires optional bindings and the host extended card provider into discovery', async () => {
    const extendedAgentCard = vi.fn(async () => {
      throw new Error('Unauthorized');
    });
    ctx.provide('a2aExtendedCard', extendedAgentCard);
    const started = await apply(ctx, config({ rest: true, grpc: { enabled: true, port: 0 } }));
    const card = (await (
      await fetch(`http://127.0.0.1:${started!.port}/.well-known/agent-card.json`, {
        headers: { 'A2A-Version': '1.0' },
      })
    ).json()) as {
      supportedInterfaces: { protocolBinding: string; url: string }[];
      capabilities: { extendedAgentCard: boolean };
    };
    expect(card.capabilities.extendedAgentCard).toBe(true);
    expect(started!.grpcPort).toBeGreaterThan(0);
    expect(card.supportedInterfaces).toContainEqual(
      expect.objectContaining({ protocolBinding: 'GRPC', url: `127.0.0.1:${started!.grpcPort}` }),
    );
    const denied = await fetch(`http://127.0.0.1:${started!.port}/a2a/rest/extendedAgentCard`, {
      headers: { 'A2A-Version': '1.0' },
    });
    expect(denied.status).toBe(500);
    expect(extendedAgentCard).toHaveBeenCalledOnce();
    await ctx.fiber.dispose();
  });

  it('does nothing when disabled', () => {
    const result = apply(ctx, config({ enabled: false }));
    expect(result).toBeUndefined();
    expect(console.log).not.toHaveBeenCalled();
  });

  it('requires an explicit opt-in for subagent tool streaming', () => {
    expect(Config({}).subagentTools).toEqual({ enabled: false });
    expect(Config({ subagentTools: { enabled: true } }).subagentTools).toEqual({ enabled: true });
    expect(() => Config({ subagentTools: { enabled: 'yes' as never } })).toThrow();
  });

  it('enables private downloads only through explicit opt-ins', () => {
    expect(Config({}).urlDownloads).toEqual({ allowPrivate: false, allowedHosts: [] });
    expect(Config({ urlDownloads: { allowPrivate: true } }).urlDownloads).toMatchObject({
      allowPrivate: true,
    });
    expect(
      Config({ urlDownloads: { allowedHosts: ['127.0.0.1', 'files.internal'] } }).urlDownloads,
    ).toMatchObject({ allowedHosts: ['127.0.0.1', 'files.internal'] });
  });

  it.each([false, true])(
    'serves the agent card and unloads the server (push=%s)',
    async (pushNotifications) => {
      const started = await apply(ctx, config({ pushNotifications }));
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[dsh-a2a] A2A endpoint:'));

      const port = started!.port;
      const res = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        name: 'test-agent',
        capabilities: { pushNotifications },
      });

      await ctx.fiber.dispose();
      await expect(fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)).rejects.toThrow();
    },
  );

  it("fails startup when taskStore is 'gcs' without a bucket", async () => {
    await expect(apply(ctx, config({ taskStore: 'gcs' }))).rejects.toThrow(
      "taskStore 'gcs' requires gcs.bucket",
    );
  });

  it('clears a stored context after its live bridge binding is gone', async () => {
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
  });
});
