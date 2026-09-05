import { type Message, Role, TaskState } from '@a2a-js/sdk';
import type { AgentExecutionEvent } from '@a2a-js/sdk/server';
import type { TokenUsage, ToolCallId } from '@deepseek-ai/dsh-llm';
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionTranslator, terminalStatusUpdate } from './translator.js';

let seq = 0;
beforeEach(() => {
  seq = 0;
});

function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
): SessionEvent {
  return { type, seq: seq++, time: Date.now(), data } as SessionEvent;
}

const turnStart = (turn = 1) => event('turn/start', { turn });
const turnEnd = (reason: TurnEndReason, turn = 1) => event('turn/end', { turn, reason });
const textDelta = (text: string) =>
  event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } });
const reasoningDelta = (text: string) =>
  event('assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'reasoning-delta', index: 1, text },
  });
const assistantMessage = (text: string, usage?: TokenUsage) =>
  event('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    ...(usage ? { usage } : {}),
  } as never);

type StatusUpdate = Extract<AgentExecutionEvent, { kind: 'statusUpdate' }>['data'];
const updates = (events: AgentExecutionEvent[]): StatusUpdate[] =>
  events.filter((e) => e.kind === 'statusUpdate').map((e) => e.data as StatusUpdate);

const textPartOf = (message?: Message) =>
  message?.parts[0]?.content?.$case === 'text' ? message.parts[0].content.value : undefined;

describe('SessionTranslator (A2A 1.0 model)', () => {
  it('emits a working statusUpdate on turn/start', () => {
    const t = new SessionTranslator('task1', 'ctx1', 'deepseek-chat');
    const out = updates(t.handle(turnStart()));
    expect(out).toHaveLength(1);
    expect(out[0].status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(out[0].taskId).toBe('task1');
    expect(out[0].contextId).toBe('ctx1');
    expect(out[0].metadata?.dshAgent).toEqual({ kind: 'state-change' });
    expect(out[0].metadata?.model).toBe('deepseek-chat');
  });

  it('streams text deltas on one aggregating messageId per turn', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const a = updates(t.handle(textDelta('hello ')));
    const b = updates(t.handle(textDelta('world')));
    const ma = a[0].status?.message;
    const mb = b[0].status?.message;
    expect(ma?.role).toBe(Role.ROLE_AGENT);
    expect(textPartOf(ma)).toBe('hello ');
    expect(textPartOf(mb)).toBe('world');
    expect(ma?.messageId).toBe(mb?.messageId);
    expect(a[0].metadata?.dshAgent).toEqual({ kind: 'text-content' });

    // next turn rotates the messageId
    t.handle(turnEnd({ kind: 'completed' }));
    t.handle(turnStart(2));
    const c = updates(t.handle(textDelta('again')));
    expect(c[0].status?.message?.messageId).not.toBe(ma?.messageId);
  });

  it('routes reasoning deltas to a separate thought messageId', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const text = updates(t.handle(textDelta('answer')));
    const thought = updates(t.handle(reasoningDelta('thinking')));
    expect(thought[0].metadata?.dshAgent).toEqual({ kind: 'thought' });
    expect(thought[0].status?.message?.messageId).not.toBe(text[0].status?.message?.messageId);
  });

  it('ignores non-visible chunk types and log-only events', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    expect(
      t.handle(
        event('assistant/chunk', {
          turn: 1,
          step: 1,
          chunk: { type: 'block-start', index: 0, blockType: 'text' },
        }),
      ),
    ).toEqual([]);
    expect(t.handle(event('step/start', { turn: 1, step: 1 }))).toEqual([]);
    expect(t.handle(event('session/end-seed', {}))).toEqual([]);
  });

  it('serializes tool calls and results as data parts, pairing by callId', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const call = updates(
      t.handle(
        event('tool/call', {
          turn: 1,
          step: 1,
          callId: 'c1' as ToolCallId,
          name: 'bash',
          arguments: '{"cmd":"ls"}',
        }),
      ),
    );
    expect(call[0].metadata?.dshAgent).toEqual({ kind: 'tool-call' });
    const callPart = call[0].status?.message?.parts[0];
    expect(callPart?.content?.$case === 'data' && callPart.content.value).toEqual({
      callId: 'c1',
      name: 'bash',
      arguments: '{"cmd":"ls"}',
    });

    const result = updates(
      t.handle(
        event('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 'm2',
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c1',
                content: [{ type: 'text', text: 'file.txt' }],
              },
            ],
            source: { kind: 'tool', callId: 'c1' },
          },
        } as never),
      ),
    );
    expect(result[0].metadata?.dshAgent).toEqual({ kind: 'tool-result' });
    const resultPart = result[0].status?.message?.parts[0];
    expect(resultPart?.content?.$case === 'data' && resultPart.content.value).toEqual({
      callId: 'c1',
      name: 'bash',
      result: 'file.txt',
      isError: false,
    });
  });

  it('marks errored tool results', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const out = updates(
      t.handle(
        event('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 'm3',
            role: 'user',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c9',
                content: [{ type: 'text', text: 'boom' }],
                isError: true,
              },
            ],
            source: { kind: 'tool', callId: 'c9' },
          },
          error: { name: 'ToolError', code: 'EXEC_FAILED' },
        } as never),
      ),
    );
    const part = out[0].status?.message?.parts[0];
    const data = part?.content?.$case === 'data' ? part.content.value : undefined;
    expect(data.isError).toBe(true);
    expect(data.error).toBe('ToolError: EXEC_FAILED');
  });

  it('ends a completed turn input-required (continuable) with the assembled text and usage', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    t.handle(textDelta('partial '));
    t.handle(assistantMessage('partial answer', { inputTokens: 10, outputTokens: 5 }));
    t.handle(
      assistantMessage(' and more', { inputTokens: 4, outputTokens: 2, reasoningTokens: 7 }),
    );
    const final = updates(t.handle(turnEnd({ kind: 'completed' })));
    expect(final).toHaveLength(1);
    expect(final[0].status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(final[0].metadata?.dshAgent).toEqual({ kind: 'state-change', reason: 'completed' });
    expect(final[0].metadata?.usage).toEqual({
      inputTokens: 14,
      outputTokens: 7,
      reasoningTokens: 7,
    });
    // the final message carries the authoritative assembled text so blocking
    // SendMessage clients read the answer from the final task status
    expect(textPartOf(final[0].status?.message)).toBe('partial answer and more');
  });

  it('falls back to accumulated deltas when no assistant/message was recorded', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    t.handle(textDelta('streamed '));
    t.handle(textDelta('only'));
    const final = updates(t.handle(turnEnd({ kind: 'completed' })));
    expect(textPartOf(final[0].status?.message)).toBe('streamed only');
  });

  it('maps max-tokens to input-required with the reason recorded', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const final = updates(t.handle(turnEnd({ kind: 'max-tokens' })));
    expect(final[0].status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(final[0].metadata?.dshAgent).toEqual({ kind: 'state-change', reason: 'max-tokens' });
  });

  it('maps aborted to canceled and error/blocked to failed', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    expect(
      updates(t.handle(turnEnd({ kind: 'aborted', reason: { kind: 'user' } })))[0].status?.state,
    ).toBe(TaskState.TASK_STATE_CANCELED);

    t.handle(turnStart(2));
    const failed = updates(
      t.handle(
        turnEnd(
          {
            kind: 'error',
            error: { message: 'provider down', name: 'LlmError', code: 'HTTP_500' } as never,
          },
          2,
        ),
      ),
    );
    expect(failed[0].status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(failed[0].metadata?.error).toBe('provider down');
    expect(textPartOf(failed[0].status?.message)).toBe('provider down');

    t.handle(turnStart(3));
    expect(updates(t.handle(turnEnd({ kind: 'blocked' }, 3)))[0].status?.state).toBe(
      TaskState.TASK_STATE_FAILED,
    );
  });

  it('ignores the crash-recovery interrupted marker', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    expect(t.handle(turnEnd({ kind: 'interrupted' }))).toEqual([]);
  });

  it('builds terminal statusUpdates for the bridge/executor paths', () => {
    const event = terminalStatusUpdate('t', 'c', 'canceled', 'bye');
    expect(event.kind).toBe('statusUpdate');
    if (event.kind !== 'statusUpdate') throw new Error('unreachable');
    expect(event.data.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    expect(textPartOf(event.data.status?.message)).toBe('bye');
  });
});
