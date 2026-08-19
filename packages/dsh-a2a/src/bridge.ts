/**
 * Bridges A2A tasks to dsh agents.
 *
 * One A2A task (contextId) maps to one dsh session/agent:
 *   message/send | message/stream → agents.create() + agent.followup()
 *   tasks/cancel                 → agent.cancel({ kind: 'user' })
 *   tasks/get (contextId lookup) → agents.get() / agents.resume()
 *   session/event stream         → A2A TaskStatusUpdate / Artifact events
 *
 * Modeled on dsh's own ACP bridge (packages/acp/acp in the dsh repo), which
 * proves this plugin shape: create/own/dispose agents inside a protocol
 * adapter plugin.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export interface BridgeOptions {
  /** Absolute working directory for spawned agents. */
  cwd: string
  /** Optional default model/provider overrides for created agents. */
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
}

interface TaskEntry {
  sessionId: string
  agent: any
  /** Subscribers (SSE streams) waiting for this task's events. */
  listeners: Set<(event: unknown) => void>
}

/**
 * Owns the taskId ↔ sessionId mapping and the agent lifecycle for every
 * A2A task this plugin serves.
 */
export class A2aBridge {
  private tasks = new Map<string, TaskEntry>()
  private byContext = new Map<string, string>() // contextId → taskId

  constructor(
    private ctx: Context,
    private options: BridgeOptions,
  ) {
    // Fan the durable session event stream out to per-task listeners.
    // TODO(verify): event names/payloads against your pinned dsh version.
    // Cast: dsh event names come from declaration merging in @deepseek-ai/*
    // packages that are not all published yet.
    const on = ctx.on.bind(ctx) as (name: string, handler: (...args: any[]) => unknown) => void
    on('session/event', (session: any, event: any) => {
      const entry = this.findBySessionId(session?.id)
      if (!entry) return
      const a2aEvent = translateSessionEvent(event)
      if (a2aEvent) {
        for (const listener of entry.listeners) listener(a2aEvent)
      }
    })
  }

  private findBySessionId(sessionId: string | undefined): TaskEntry | undefined {
    if (!sessionId) return undefined
    for (const entry of this.tasks.values()) {
      if (entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  /** Create a task (new session) or continue an existing one, then prompt. */
  async sendMessage(input: {
    taskId?: string
    contextId?: string
    text: string
  }): Promise<{ taskId: string; contextId: string }> {
    const existingId = input.taskId ?? (input.contextId && this.byContext.get(input.contextId))
    const entry = existingId ? this.tasks.get(existingId) : undefined

    if (entry) {
      await entry.agent.followup(createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }))
      return { taskId: existingId!, contextId: entry.sessionId }
    }

    const taskId = randomUUID()
    const sessionId = randomUUID()
    // TODO(verify): CreateAgentOptions shape (SessionId branding, meta.cwd,
    // agentOptions) — see packages/acp/acp/src/index.ts in the dsh repo.
    const handle = await (this.ctx as any).agents.create({
      sessionId,
      meta: { cwd: this.options.cwd },
      agentOptions: this.options.agentOptions,
    })
    const newEntry: TaskEntry = { sessionId, agent: handle.agent, listeners: new Set() }
    this.tasks.set(taskId, newEntry)
    this.byContext.set(sessionId, taskId)

    await handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: input.text }], source: { kind: 'user' } }))
    return { taskId, contextId: sessionId }
  }

  /** Subscribe a listener to a task's A2A event stream; returns unsubscribe. */
  subscribe(taskId: string, listener: (event: unknown) => void): () => void {
    const entry = this.tasks.get(taskId)
    if (!entry) throw new Error(`unknown task: ${taskId}`)
    entry.listeners.add(listener)
    return () => entry.listeners.delete(listener)
  }

  async cancel(taskId: string): Promise<void> {
    const entry = this.tasks.get(taskId)
    if (!entry) throw new Error(`unknown task: ${taskId}`)
    await entry.agent.cancel({ kind: 'user' })
  }

  status(taskId: string): unknown {
    const entry = this.tasks.get(taskId)
    if (!entry) throw new Error(`unknown task: ${taskId}`)
    return { taskId, contextId: entry.sessionId, status: entry.agent.status }
  }

  /** Dispose every owned agent (plugin unload / server shutdown). */
  async dispose(): Promise<void> {
    for (const entry of this.tasks.values()) {
      try {
        await entry.agent.dispose?.()
      } catch {
        /* best effort */
      }
    }
    this.tasks.clear()
    this.byContext.clear()
  }
}

/**
 * Map a dsh session event to an A2A event. Returns null for events that
 * should not cross the protocol boundary.
 *
 * TODO: full mapping table. The reference implementation is the event
 * switch in packages/a2a-server/src/agent/task.ts of the source project —
 * port its GeminiEventType→A2A translation to dsh's SessionEventMap:
 *   assistant/chunk (text-delta)  → TaskStatusUpdateEvent(working, message)
 *   assistant/chunk (reasoning)   → TaskStatusUpdateEvent(working, thought)
 *   tool/call                     → TaskStatusUpdateEvent + artifact (call)
 *   tool/result                   → TaskArtifactUpdateEvent (result)
 *   turn/end (completed)          → TaskStatusUpdateEvent(completed, final)
 *   turn/end (aborted/error)      → TaskStatusUpdateEvent(canceled|failed)
 *   approval/asked                → TaskStatusUpdateEvent(input-required)
 */
function translateSessionEvent(_event: any): unknown {
  // Skeleton: translation lands with the full mapping table above.
  return null
}
