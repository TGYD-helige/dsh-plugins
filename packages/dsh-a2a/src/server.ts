/**
 * HTTP layer: serves the A2A agent card and the JSON-RPC endpoint with SSE.
 *
 * Deliberately thin. The heavy A2A protocol machinery (RequestHandler,
 * ExecutionEventBus, TaskStore, resubscribe-with-replay) is provided by
 * `@a2a-js/sdk` and can be ported wholesale from the source project's
 * packages/a2a-server/src/http — that code is harness-agnostic.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { createServer, type Server } from 'node:http'
import express from 'express'
import type { A2aBridge } from './bridge.js'

export interface A2aServerOptions {
  host: string
  port: number
  basePath: string
  agentCard: {
    name: string
    description: string
    version: string
    /** Public base URL advertised in the card, e.g. https://agent.example.com */
    publicUrl?: string
  }
}

export async function startA2aServer(
  bridge: A2aBridge,
  options: A2aServerOptions,
): Promise<{ close(): Promise<void> }> {
  const app = express()
  app.use(express.json({ limit: '16mb' }))

  const base = options.basePath.replace(/\/$/, '')
  const publicUrl = options.agentCard.publicUrl ?? `http://${options.host}:${options.port}`

  // ---- Agent card (A2A discovery) ----
  const card = {
    name: options.agentCard.name,
    description: options.agentCard.description,
    version: options.agentCard.version,
    protocolVersion: '0.3.0',
    url: `${publicUrl}${base}/`,
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  }
  app.get('/.well-known/agent.json', (_req, res) => res.json(card))
  app.get(`${base}/.well-known/agent.json`, (_req, res) => res.json(card))

  // ---- JSON-RPC endpoint ----
  // TODO: replace these minimal handlers with the @a2a-js/sdk transport
  // (A2AExpressApp + DefaultRequestHandler) once the executor port lands.
  app.post(`${base}/`, async (req, res) => {
    const { id, method, params } = req.body ?? {}
    try {
      switch (method) {
        case 'message/send': {
          const text = extractText(params)
          const result = await bridge.sendMessage({
            taskId: params?.taskId,
            contextId: params?.contextId,
            text,
          })
          res.json({ jsonrpc: '2.0', id, result })
          return
        }
        case 'message/stream': {
          // SSE: stream translated session events until turn/end.
          const text = extractText(params)
          const { taskId, contextId } = await bridge.sendMessage({
            taskId: params?.taskId,
            contextId: params?.contextId,
            text,
          })
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          })
          res.write(`data: ${JSON.stringify({ taskId, contextId, kind: 'task' })}\n\n`)
          const unsubscribe = bridge.subscribe(taskId, (event) => {
            res.write(`data: ${JSON.stringify(event)}\n\n`)
          })
          req.on('close', unsubscribe)
          return
        }
        case 'tasks/get':
          res.json({ jsonrpc: '2.0', id, result: bridge.status(params?.id) })
          return
        case 'tasks/cancel':
          await bridge.cancel(params?.id)
          res.json({ jsonrpc: '2.0', id, result: bridge.status(params?.id) })
          return
        default:
          res.status(400).json({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `method not found: ${method}` },
          })
      }
    } catch (error) {
      res.status(500).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })
    }
  })

  const server: Server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve())
  })

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

function extractText(params: any): string {
  const parts = params?.message?.parts
  if (!Array.isArray(parts)) throw new Error('message.parts is required')
  return parts
    .filter((p: any) => p?.kind === 'text' || p?.text)
    .map((p: any) => p.text)
    .join('')
}
