/**
 * Pure translation layer: dsh session events → A2A protocol events.
 *
 * One {@link SessionTranslator} serves one A2A task (one dsh session). It is
 * deliberately free of cordis/HTTP concerns so the mapping is unit-testable
 * without a harness. The mapping is a port of the source project's
 * `packages/a2a-server/src/agent/task.ts` event switch onto dsh's
 * `SessionEventMap` (verified against @deepseek-ai/dsh-session@0.1.0-rc.7):
 *
 *   turn/start                         → status-update(working), ids rotate
 *   assistant/chunk (text-delta)       → status-update(working, text part),
 *                                        reusing the turn's messageId so
 *                                        clients aggregate deltas into one message
 *   assistant/chunk (reasoning-delta)  → status-update(working, thought metadata)
 *   assistant/message                  → no event; text + usage captured for the
 *                                        turn-final message (blocking `message/send`
 *                                        clients read the answer from the final
 *                                        task status, not from streamed deltas)
 *   tool/call                          → status-update(working, data part)
 *   tool/result                        → status-update(working, data part)
 *   turn/end completed | max-tokens    → status-update(input-required, final) —
 *                                        input-required, not completed: the task is
 *                                        a conversation and stays continuable
 *                                        (completed is terminal in A2A and the SDK
 *                                        refuses follow-ups to terminal tasks)
 *   turn/end aborted                   → status-update(canceled, final)
 *   turn/end blocked | error           → status-update(failed, final)
 *   everything else                    → no event
 *
 * dsh rc.7 has no approval/`input-required` mid-turn seam (the unpublished
 * dsh-user-approval package is not installed anywhere; `tools/pre-execute`'s
 * `ask` degrades to deny without an approval service), so no approval bridge
 * exists here. TODO(verify) when dsh ships one.
 */

import { randomUUID } from 'node:crypto';
import type { Message, TaskState, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { AgentExecutionEvent } from '@a2a-js/sdk/server';
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';

/**
 * The event-subtype channel carried in `metadata.dshAgent` of every event this
 * plugin emits (the same role the source project's `metadata.coderAgent`
 * plays). `reason` carries the {@link TurnEndReason} kind on final events.
 */
interface DshAgentEventMetadata {
  dshAgent: {
    kind: 'text-content' | 'thought' | 'tool-call' | 'tool-result' | 'state-change';
    reason?: string;
  };
  model?: string;
  usage?: TokenUsage;
  error?: string;
}

/** One agent-role text message — the single construction site for the plugin's message payloads. */
export function agentTextMessage(
  taskId: string,
  contextId: string,
  text: string,
  messageId: string = randomUUID(),
): Message {
  return {
    kind: 'message',
    role: 'agent',
    parts: [{ kind: 'text', text }],
    messageId,
    taskId,
    contextId,
  };
}

/** Build a terminal (final) status-update — shared by the bridge's dispose path and the executor's failure/cancel paths. */
export function terminalStatusUpdate(
  taskId: string,
  contextId: string,
  state: 'canceled' | 'failed',
  text: string,
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    status: {
      state,
      message: agentTextMessage(taskId, contextId, text),
      timestamp: new Date().toISOString(),
    },
    final: true,
    metadata: { dshAgent: { kind: 'state-change', reason: state } } satisfies DshAgentEventMetadata,
  };
}

export class SessionTranslator {
  /** messageId shared by this turn's streamed text deltas (client-side aggregation key). */
  private textMessageId = randomUUID();
  private thoughtMessageId = randomUUID();
  /** Authoritative turn text, assembled from `assistant/message` events. */
  private turnText = '';
  /** Fallback turn text, accumulated from `text-delta` chunks. */
  private deltaText = '';
  private sawAssistantMessage = false;
  private usage: TokenUsage | undefined;
  /** callId → tool name, for naming `tool/result` payloads. */
  private readonly toolNames = new Map<string, string>();

  constructor(
    private readonly taskId: string,
    private readonly contextId: string,
    private readonly model?: string,
  ) {}

  /** Translate one session event into zero or more A2A events. Never throws on unknown types. */
  handle(event: SessionEvent): AgentExecutionEvent[] {
    switch (event.type) {
      case 'turn/start': {
        this.textMessageId = randomUUID();
        this.thoughtMessageId = randomUUID();
        this.turnText = '';
        this.deltaText = '';
        this.sawAssistantMessage = false;
        this.usage = undefined;
        return [this.status('working', { kind: 'state-change' })];
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk;
        if (chunk.type === 'text-delta') {
          this.deltaText += chunk.text;
          return [
            this.status(
              'working',
              { kind: 'text-content' },
              agentTextMessage(this.taskId, this.contextId, chunk.text, this.textMessageId),
            ),
          ];
        }
        if (chunk.type === 'reasoning-delta') {
          return [
            this.status(
              'working',
              { kind: 'thought' },
              agentTextMessage(this.taskId, this.contextId, chunk.text, this.thoughtMessageId),
            ),
          ];
        }
        return [];
      }
      case 'assistant/message': {
        this.sawAssistantMessage = true;
        for (const block of event.data.message.content) {
          if (block.type === 'text') this.turnText += block.text;
        }
        const usage = event.data.usage;
        if (usage) this.usage = this.usage ? addUsage(this.usage, usage) : { ...usage };
        return [];
      }
      case 'tool/call': {
        const { callId, name, arguments: args } = event.data;
        this.toolNames.set(callId, name);
        return [
          this.status(
            'working',
            { kind: 'tool-call' },
            this.dataMessage({ callId, name, arguments: args }),
          ),
        ];
      }
      case 'tool/result': {
        const { message, error, meta } = event.data;
        // ToolResultMessage.content is a single tool-result block.
        const block = message.content[0];
        const callId = block?.type === 'tool-result' ? block.toolCallId : undefined;
        return [
          this.status(
            'working',
            { kind: 'tool-result' },
            this.dataMessage({
              callId,
              name: callId ? this.toolNames.get(callId) : undefined,
              result:
                block?.type === 'tool-result'
                  ? flattenContent(block.content)
                  : flattenContent(message.content),
              isError:
                (block?.type === 'tool-result' && block.isError === true) || error !== undefined,
              ...(error ? { error: `${error.name}: ${error.code}` } : {}),
              ...(meta !== undefined ? { meta } : {}),
            }),
          ),
        ];
      }
      case 'turn/end': {
        const final = this.turnEnd(event.data.reason);
        return final ? [final] : [];
      }
      default:
        return [];
    }
  }

  private turnEnd(reason: TurnEndReason): TaskStatusUpdateEvent | undefined {
    const text = this.sawAssistantMessage ? this.turnText : this.deltaText;
    const finalMessage = text
      ? agentTextMessage(this.taskId, this.contextId, text, this.textMessageId)
      : undefined;
    switch (reason.kind) {
      case 'completed':
      case 'max-tokens':
        // The task stays continuable; the reason records which ceiling hit.
        return this.status(
          'input-required',
          { kind: 'state-change', reason: reason.kind },
          finalMessage,
          true,
        );
      case 'aborted':
        return this.status(
          'canceled',
          { kind: 'state-change', reason: 'aborted' },
          undefined,
          true,
        );
      case 'blocked':
        return this.status('failed', { kind: 'state-change', reason: 'blocked' }, undefined, true);
      case 'error': {
        const message = reason.error.message || 'Agent turn failed.';
        return this.status(
          'failed',
          { kind: 'state-change', reason: 'error' },
          agentTextMessage(this.taskId, this.contextId, message),
          true,
          message,
        );
      }
      default:
        // 'interrupted' closes crash-orphaned turns on reload; the live loop
        // never emits it, and unknown merge extensions are ignored too.
        return undefined;
    }
  }

  private status(
    state: TaskState,
    dshAgent: DshAgentEventMetadata['dshAgent'],
    message?: Message,
    final = false,
    error?: string,
  ): TaskStatusUpdateEvent {
    const metadata: Record<string, unknown> = { dshAgent };
    if (this.model) metadata.model = this.model;
    if (final && this.usage) metadata.usage = this.usage;
    if (error) metadata.error = error;
    return {
      kind: 'status-update',
      taskId: this.taskId,
      contextId: this.contextId,
      status: { state, message, timestamp: new Date().toISOString() },
      final,
      metadata,
    };
  }

  private dataMessage(data: Record<string, unknown>): Message {
    return {
      kind: 'message',
      role: 'agent',
      parts: [{ kind: 'data', data }],
      messageId: randomUUID(),
      taskId: this.taskId,
      contextId: this.contextId,
    };
  }
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const sum = (x?: number, y?: number): number | undefined =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: sum(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: sum(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
  };
}

/** Flatten tool-result content blocks to display text; non-text blocks serialize as JSON. */
function flattenContent(content: ContentBlock[]): string {
  return content
    .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
    .join('');
}
