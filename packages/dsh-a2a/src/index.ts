/**
 * dsh-a2a — exposes DeepSeek Harness agents over the A2A protocol.
 *
 * Plugin shape mirrors dsh's own ACP bridge (packages/acp/acp in the dsh
 * repo): the plugin owns the agents it creates, serves a protocol endpoint
 * for the process lifetime, and disposes everything on unload.
 *
 * Security note: dsh ships no authn/authz. This plugin binds 127.0.0.1 by
 * default; put a real authentication layer in front (or contribute an auth
 * middleware hook here) before exposing it beyond loopback.
 *
 * @module dsh-a2a
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { A2aBridge } from './bridge.js'
import { startA2aServer } from './server.js'

export const name = 'dsh-a2a'

/** The bridge creates and owns agents through the registry service. */
export const inject = ['agents']

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
})

export interface A2aPluginConfig {
  enabled: boolean
  host: string
  port: number
  basePath: string
  cwd: string
  agent: { provider: string; model: string }
  card: { name: string; description: string; version: string; publicUrl: string }
}

export function apply(ctx: Context, config: A2aPluginConfig): void {
  if (!config.enabled) return

  const bridge = new A2aBridge(ctx, {
    cwd: config.cwd,
    agentOptions: {
      provider: config.agent.provider || undefined,
      model: config.agent.model || undefined,
    },
  })

  let server: { close(): Promise<void> } | null = null

  ctx.on('ready', async () => {
    server = await startA2aServer(bridge, {
      host: config.host,
      port: config.port,
      basePath: config.basePath,
      agentCard: {
        name: config.card.name,
        description: config.card.description,
        version: config.card.version,
        publicUrl: config.card.publicUrl || undefined,
      },
    })
    console.log(`[dsh-a2a] A2A endpoint: http://${config.host}:${config.port}${config.basePath}/`)
  })

  ctx.on('dispose', async () => {
    await server?.close()
    await bridge.dispose()
  })
}
