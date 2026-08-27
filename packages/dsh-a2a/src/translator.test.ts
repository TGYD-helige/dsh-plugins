import type { Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import type { CallId, TokenUsage } from '@deepseek-ai/dsh-llm';
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

const updates = (events: ReturnType<SessionTranslator['handle']>) =>
  events.filter((e): e is TaskStatusUpdateEvent => e.kind === 'status-update');

describe('SessionTranslator', () => {
  it('emits a working status-update on turn/start', () => {
    const t = new SessionTranslator('task1', 'ctx1', 'deepseek-chat');
    const out = updates(t.handle(turnStart()));
    expect(out).toHaveLength(1);
    expect(out[0].status.state).toBe('working');
    expect(out[0].final).toBe(false);
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
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    const ma = a[0].status.message as Message;
    const mb = b[0].status.message as Message;
    expect(ma.parts).toEqual([{ kind: 'text', text: 'hello ' }]);
    expect(mb.parts).toEqual([{ kind: 'text', text: 'world' }]);
    expect(ma.messageId).toBe(mb.messageId);
    expect(a[0].metadata?.dshAgent).toEqual({ kind: 'text-content' });

    // next turn rotates the messageId
    t.handle(turnEnd({ kind: 'completed' }));
    t.handle(turnStart(2));
    const c = updates(t.handle(textDelta('again')));
    expect((c[0].status.message as Message).messageId).not.toBe(ma.messageId);
  });

  it('routes reasoning deltas to a separate thought messageId', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const text = updates(t.handle(textDelta('answer')));
    const thought = updates(t.handle(reasoningDelta('thinking')));
    expect(thought[0].metadata?.dshAgent).toEqual({ kind: 'thought' });
    expect((thought[0].status.message as Message).messageId).not.toBe(
      (text[0].status.message as Message).messageId,
    );
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
    expect(t.handle(event('todo/write', { todos: [] }))).toEqual([]);
  });

  it('serializes tool calls and results as data parts, pairing by callId', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const call = updates(
      t.handle(
        event('tool/call', {
          turn: 1,
          step: 1,
          callId: 'c1' as CallId,
          name: 'bash',
          arguments: '{"cmd":"ls"}',
        }),
      ),
    );
    expect(call[0].metadata?.dshAgent).toEqual({ kind: 'tool-call' });
    expect((call[0].status.message as Message).parts).toEqual([
      { kind: 'data', data: { callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' } },
    ]);

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
    expect((result[0].status.message as Message).parts[0]).toEqual({
      kind: 'data',
      data: { callId: 'c1', name: 'bash', result: 'file.txt', isError: false },
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
    const data = (out[0].status.message as Message).parts[0] as { data: Record<string, unknown> };
    expect(data.data.isError).toBe(true);
    expect(data.data.error).toBe('ToolError: EXEC_FAILED');
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
    expect(final[0].status.state).toBe('input-required');
    expect(final[0].final).toBe(true);
    expect(final[0].metadata?.dshAgent).toEqual({ kind: 'state-change', reason: 'completed' });
    expect(final[0].metadata?.usage).toEqual({
      inputTokens: 14,
      outputTokens: 7,
      reasoningTokens: 7,
    });
    // the final message carries the authoritative assembled text so blocking
    // message/send clients can read the answer from the final task status
    const message = final[0].status.message as Message;
    expect(message.parts).toEqual([{ kind: 'text', text: 'partial answer and more' }]);
  });

  it('falls back to accumulated deltas when no assistant/message was recorded', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    t.handle(textDelta('streamed '));
    t.handle(textDelta('only'));
    const final = updates(t.handle(turnEnd({ kind: 'completed' })));
    expect((final[0].status.message as Message).parts).toEqual([
      { kind: 'text', text: 'streamed only' },
    ]);
  });

  it('maps max-tokens to input-required with the reason recorded', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    const final = updates(t.handle(turnEnd({ kind: 'max-tokens' })));
    expect(final[0].status.state).toBe('input-required');
    expect(final[0].final).toBe(true);
    expect(final[0].metadata?.dshAgent).toEqual({ kind: 'state-change', reason: 'max-tokens' });
  });

  it('maps aborted to canceled and error/blocked to failed', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    t.handle(turnStart());
    expect(
      updates(t.handle(turnEnd({ kind: 'aborted', reason: { kind: 'user' } })))[0].status.state,
    ).toBe('canceled');

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
    expect(failed[0].status.state).toBe('failed');
    expect(failed[0].final).toBe(true);
    expect(failed[0].metadata?.error).toBe('provider down');
    expect((failed[0].status.message as Message).parts).toEqual([
      { kind: 'text', text: 'provider down' },
    ]);

    t.handle(turnStart(3));
    expect(updates(t.handle(turnEnd({ kind: 'blocked' }, 3)))[0].status.state).toBe('failed');
  });

  it('ignores the crash-recovery interrupted marker', () => {
    const t = new SessionTranslator('task1', 'ctx1');
    expect(t.handle(turnEnd({ kind: 'interrupted' }))).toEqual([]);
  });

  it('builds terminal status-updates for the bridge/executor paths', () => {
    const event = terminalStatusUpdate('t', 'c', 'canceled', 'bye');
    expect(event.kind).toBe('status-update');
    expect(event.status.state).toBe('canceled');
    expect(event.final).toBe(true);
    expect((event.status.message as Message).parts).toEqual([{ kind: 'text', text: 'bye' }]);
  });
});
