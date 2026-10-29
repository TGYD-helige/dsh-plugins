import { describe, expect, it, vi } from 'vitest';
import { compressionSnapshot } from './compaction.js';

const end = { type: 'compaction/end', seq: 12, time: 2000, data: { compactionId: 'c1', turn: 1 } };

describe('compression snapshots', () => {
  it('merges adjacent roles so the legacy loader keeps every retained message', () => {
    const row = compressionSnapshot(
      {
        id: 's1',
        header: { createdAt: 1000 },
        deriveMessages: () => [
          { role: 'user', content: [{ type: 'text', text: 'Summary' }] },
          { role: 'user', content: [{ type: 'text', text: 'Retained user message' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'Additional answer' }] },
        ],
      },
      end,
    )!;
    expect(JSON.parse(row.content)).toEqual([
      { role: 'user', parts: [{ text: 'Summary' }, { text: 'Retained user message' }] },
      { role: 'model', parts: [{ text: 'Answer' }, { text: 'Additional answer' }] },
    ]);
  });
  it.each(['compaction/start', 'compaction/summary', 'user/message'])(
    'does not snapshot %s before commit',
    (type) => {
      const deriveMessages = vi.fn();
      expect(compressionSnapshot({ id: 's1', deriveMessages }, { ...end, type })).toBeNull();
      expect(deriveMessages).not.toHaveBeenCalled();
    },
  );

  it('leaves the previous checkpoint intact after failed or canceled compaction', () => {
    const deriveMessages = vi.fn();
    expect(
      compressionSnapshot(
        { id: 's1', deriveMessages },
        { ...end, data: { ...end.data, error: 'canceled' } },
      ),
    ).toBeNull();
    expect(deriveMessages).not.toHaveBeenCalled();
  });

  it('preserves retained tool calls, results, reasoning signatures and source ordering', () => {
    const row = compressionSnapshot(
      {
        id: 's1',
        header: { createdAt: 1000 },
        deriveMessages: () => [
          { role: 'user', content: [{ type: 'text', text: 'Summary' }] },
          {
            role: 'assistant',
            source: { replayState: { blocks: [{ signature: 'signed' }] } },
            content: [
              { type: 'reasoning', text: 'Reasoning' },
              { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: 'file contents' }],
            isError: false,
          },
        ],
      },
      end,
    )!;
    expect(JSON.parse(row.content)).toEqual([
      { role: 'user', parts: [{ text: 'Summary' }] },
      {
        role: 'model',
        parts: [
          { text: 'Reasoning', thought: true, thoughtSignature: 'signed' },
          { functionCall: { id: 'call-1', name: 'read', args: { path: 'a.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read',
              response: { output: [{ type: 'text', text: 'file contents' }], isError: false },
            },
          },
        ],
      },
    ]);
  });
});
