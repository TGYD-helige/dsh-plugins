/**
 * dsh-a2a — exposes DeepSeek Harness agents over the A2A protocol.
 *
 * Plugin shape mirrors dsh's own ACP bridge (packages/acp/acp in the dsh
 * repo): the plugin owns the agents it creates, serves a protocol endpoint
 * for the process lifetime, and disposes everything on unload.
 *
 * Security note: dsh ships no authn/authz. This plugin binds 127.0.0.1 by
 * default; put a real authentication layer in front before exposing it
 * beyond loopback.
 *
 * @module dsh-a2a
 */

import { InMemoryTaskStore } from '@a2a-js/sdk/server';
import type { Context } from '@deepseek-ai/cordis';
// Augmentation-only imports: pull ctx.agents and the session Events
// declarations into the compilation (listeners are contextually typed).
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session';
import Schema from '@deepseek-ai/schemastery';
import { A2aBridge } from './bridge.js';
import { DshAgentExecutor } from './executor.js';
import { startA2aServer } from './server.js';
import { GcsTaskStore } from './stores/gcs.js';
import { RedisTaskStore } from './stores/redis.js';
import { type ManagedTaskStore, SanitizedTaskStore } from './task-store.js';

export const name = 'dsh-a2a';

/** The bridge creates and owns agents through the registry service. */
export const inject = ['agents'];

export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().default(41241),
  basePath: Schema.string().default('/a2a'),
  /** Working directory for agents spawned by A2A tasks. Must be absolute. */
  cwd: Schema.string().default(process.cwd()),
  agent: Schema.object({
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
  }),
  card: Schema.object({
    name: Schema.string().default('dsh-a2a-agent'),
    description: Schema.string().default('DeepSeek Harness agent over A2A'),
    version: Schema.string().default('0.1.0'),
    publicUrl: Schema.string().default(''),
  }),
  /**
   * A2A task state store (task metadata only — conversation history is
   * dsh-storage's ai_messages, not this). 'memory' loses tasks on restart.
   */
  taskStore: Schema.union([
    Schema.const('memory'),
    Schema.const('redis'),
    Schema.const('gcs'),
  ]).default('memory'),
  redis: Schema.object({
    url: Schema.string().role('secret').default('redis://127.0.0.1:6379'),
    keyPrefix: Schema.string().default('a2a'),
    ttlSeconds: Schema.natural().default(86400),
  }),
  gcs: Schema.object({
    bucket: Schema.string().default(''),
    prefix: Schema.string().default('tasks'),
    keyFilename: Schema.string().default(''),
  }),
});

export interface A2aPluginConfig {
  enabled: boolean;
  host: string;
  port: number;
  basePath: string;
  cwd: string;
  agent: { provider: string; model: string };
  card: { name: string; description: string; version: string; publicUrl: string };
  taskStore: 'memory' | 'redis' | 'gcs';
  redis: { url: string; keyPrefix: string; ttlSeconds: number };
  gcs: { bucket: string; prefix: string; keyFilename: string };
}

export function apply(
  ctx: Context,
  config: A2aPluginConfig,
): Promise<{ port: number }> | undefined {
  if (!config.enabled) return;

  // This cordis fork has no ready/dispose events: startup runs inside
  // ctx.effect() (executed at fiber load) and its returned disposer runs on
  // fiber unload. apply() returns the startup promise so fiber readiness
  // covers the bind.
  let ready!: Promise<{ port: number }>;
  let serverPort = 0;
  ctx.effect(() => {
    const startup = start();
    ready = startup.then(() => ({ port: serverPort }));
    return startup;
  });
  return ready;

  async function start(): Promise<() => Promise<void>> {
    const bridge = new A2aBridge(ctx, {
      cwd: config.cwd,
      agentOptions: {
        provider: config.agent.provider || undefined,
        model: config.agent.model || undefined,
      },
    });

    const store = createTaskStore(config);
    await store.init?.();

    const executor = new DshAgentExecutor(bridge);
    const server = await startA2aServer({
      host: config.host,
      port: config.port,
      basePath: config.basePath,
      card: {
        name: config.card.name,
        description: config.card.description,
        version: config.card.version,
        publicUrl: config.card.publicUrl || undefined,
      },
      executor,
      taskStore: store,
    });
    serverPort = server.port;

    console.log(
      `[dsh-a2a] A2A endpoint: http://${config.host}:${server.port}${config.basePath}/ ` +
        `(agent card: /.well-known/agent-card.json)`,
    );

    return async () => {
      await server.close();
      await bridge.dispose();
      await store.close?.();
    };
  }
}

function createTaskStore(config: A2aPluginConfig): ManagedTaskStore {
  switch (config.taskStore) {
    case 'redis':
      return new SanitizedTaskStore(new RedisTaskStore(config.redis));
    case 'gcs':
      if (!config.gcs.bucket) {
        throw new Error("[dsh-a2a] taskStore 'gcs' requires gcs.bucket");
      }
      return new SanitizedTaskStore(new GcsTaskStore(config.gcs));
    default:
      return new SanitizedTaskStore(new InMemoryTaskStore());
  }
}
