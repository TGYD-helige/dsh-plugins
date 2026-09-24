import { describe, expect, it } from 'vitest';
import { mergeToolResult, projectEvent, usageSampleOf } from './projector.js';

// Event envelopes follow the dsh persistence catalog: { type, seq, time, data }.
const sessionId = 's1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const userMessage = (text: string, id = 'm1') => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

describe('projectEvent', () => {
  it('projects a user/message (data IS the UserMessage)', () => {
    const row = projectEvent(
      {},
      { type: 'user/message', seq: 1, time: 1700000000000, data: userMessage('hello') },
      sessionId,
    );
    expect(row).toMatchObject({
      id: 'm1',
      sessionId: 's1',
      historyId: null,
      agentId: 'main',
      type: 'user',
      content: 'hello',
      metadata: { event: 'user/message', seq: 1 },
    });
    expect(row?.createdAt).toEqual(new Date(1700000000000));
  });

  it('joins text blocks and ignores non-text blocks', () => {
    const row = projectEvent(
      {},
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: {
          ...userMessage(''),
          content: [
            { type: 'text', text: 'foo' },
            { type: 'image', id: 'img1' },
            { type: 'text', text: 'bar' },
          ],
        },
      },
      sessionId,
    );
    expect(row?.content).toBe('foobar');
  });

  it('generates a uuid when the message has no id', () => {
    const row = projectEvent(
      {},
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'x' }] } },
      sessionId,
    );
    expect(row?.id).toMatch(UUID_RE);
  });

  it('falls back to now when the event has no time', () => {
    const before = Date.now();
    const row = projectEvent(
      {},
      { type: 'user/message', seq: 1, data: userMessage('x') },
      sessionId,
    );
    const after = Date.now();
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(row?.createdAt.getTime()).toBeLessThanOrEqual(after);
  });

  it('projects an assistant/message with model, usage and tool calls', () => {
    const toolCall = { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' };
    const replayState = {
      response: { kind: 'deepseek-messages', version: 1, model: 'deepseek-chat' },
      blocks: [
        { type: 'reasoning', signature: 'opaque-signature' },
        { type: 'text' },
        { type: 'tool-call' },
      ],
    };
    const row = projectEvent(
      {},
      {
        type: 'assistant/message',
        seq: 2,
        time: 1700000001000,
        data: {
          turn: 0,
          step: 0,
          message: {
            id: 'a1',
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'thinking' },
              { type: 'text', text: 'answer' },
              toolCall,
            ],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat', replayState },
          },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
      sessionId,
    );
    expect(row).toMatchObject({
      id: 'a1',
      type: 'model',
      content: 'answer',
      thoughts: [{ content: 'thinking', thoughtSignature: 'opaque-signature' }],
      model: 'deepseek-chat',
      tokens: { inputTokens: 10, outputTokens: 5 },
      toolCalls: [toolCall],
      metadata: {
        event: 'assistant/message',
        seq: 2,
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat', replayState },
      },
    });
  });

  it('marks interrupted assistant messages in metadata', () => {
    const row = projectEvent(
      {},
      {
        type: 'assistant/message',
        seq: 3,
        time: 1,
        data: {
          turn: 0,
          step: 0,
          interrupted: true,
          message: {
            id: 'a2',
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
            source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
          },
        },
      },
      sessionId,
    );
    expect(row?.metadata).toMatchObject({ interrupted: true });
    expect(row?.thoughts).toBeUndefined();
    expect(row?.toolCalls).toBeUndefined();
  });

  it('does not project a tool/result as a separate row', () => {
    const resultBlock = {
      type: 'tool-result',
      toolCallId: 'c9',
      content: [{ type: 'text', text: 'file contents' }],
    };
    const row = projectEvent(
      {},
      {
        type: 'tool/result',
        seq: 4,
        time: 1,
        data: {
          turn: 0,
          step: 0,
          message: {
            id: 't1',
            role: 'user',
            content: [resultBlock],
            source: { kind: 'tool', callId: 'c9' },
          },
        },
      },
      sessionId,
    );
    expect(row).toBeNull();
  });

  it('merges a failed result into the matching model call without changing sibling calls', () => {
    const first = { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' };
    const second = { type: 'tool-call', id: 'c2', name: 'write', arguments: '{}' };
    const model = { id: 'a1', type: 'model', toolCalls: [first, second] } as any;
    const result = { type: 'tool-result', toolCallId: 'c2', content: [], isError: true };
    const event = {
      type: 'tool/result',
      data: {
        error: { name: 'ToolError', code: 'ENOENT' },
        message: { source: { callId: 'c2' }, content: [result] },
      },
    };
    const merged = mergeToolResult(event, [model]);
    expect(merged).toMatchObject({
      id: 'a1',
      type: 'model',
      toolCalls: [first, { ...second, result, error: event.data.error }],
    });
    expect(mergeToolResult(event, [merged!])).toEqual(merged);
  });

  it.each([
    ['assistant/attempt', { type: 'assistant/attempt', seq: 1, time: 1, data: { stream: [] } }],
    ['turn/end', { type: 'turn/end', seq: 9, time: 1, data: { turn: 0, reason: 'done' } }],
    ['session/title', { type: 'session/title', seq: 3, time: 1, data: { title: 't' } }],
    ['unknown event', { type: 'approval/asked', seq: 1, time: 1, data: {} }],
    ['empty event', null],
  ])('returns null for %s', (_label, event) => {
    expect(projectEvent({}, event, sessionId)).toBeNull();
  });
});

describe('usageSampleOf', () => {
  it("samples an assistant/attempt's embedded usage record with its step key", () => {
    expect(
      usageSampleOf({
        type: 'assistant/attempt',
        data: {
          turn: 1,
          step: 2,
          stream: [
            {
              type: 'chunk',
              time: 1,
              chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
            },
          ],
        },
      }),
    ).toEqual({ key: '1:2', sample: { input: 10, output: 5 } });
  });

  it('samples an assistant/message usage with its step key', () => {
    expect(
      usageSampleOf({
        type: 'assistant/message',
        data: { turn: 0, step: 1, usage: { inputTokens: 8, outputTokens: 2 } },
      }),
    ).toEqual({ key: '0:1', sample: { input: 8, output: 2 } });
  });

  it('folds cache buckets into input (they are billed separately, not subsets)', () => {
    expect(
      usageSampleOf({
        type: 'assistant/message',
        data: {
          turn: 0,
          step: 0,
          usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 900, cacheWriteTokens: 30 },
        },
      }),
    ).toEqual({ key: '0:0', sample: { input: 1030, output: 7 } });
  });

  it('returns null for streams without usage and other events', () => {
    expect(
      usageSampleOf({
        type: 'assistant/attempt',
        data: {
          turn: 0,
          step: 0,
          stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [0], texts: ['x'] }],
        },
      }),
    ).toBeNull();
    expect(usageSampleOf({ type: 'turn/end', data: { turn: 0 } })).toBeNull();
    expect(usageSampleOf({ type: 'user/message', data: {} })).toBeNull();
  });

  it('returns null when usage or the step identity is missing', () => {
    expect(usageSampleOf({ type: 'assistant/message', data: { turn: 0, step: 1 } })).toBeNull();
    expect(
      usageSampleOf({
        type: 'assistant/message',
        data: { usage: { inputTokens: 1 } },
      }),
    ).toBeNull();
    expect(usageSampleOf({})).toBeNull();
  });
});
