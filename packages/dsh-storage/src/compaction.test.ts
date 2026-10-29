import { describe, expect, it, vi } from 'vitest';
import { compressionSnapshot } from './compaction.js';

const end = { type: 'compaction/end', seq: 12, time: 2000, data: { compactionId: 'c1', turn: 1 } };

describe('compression snapshots', () => {
  it.each(['{', 'null', '[]', '42', '"raw"'])(
    'preserves non-object tool arguments %s and their failed result as data',
    (raw) => {
      const call = { type: 'tool-call', id: 'bad-call', name: 'read', arguments: raw };
      const result = {
        type: 'tool-result',
        toolCallId: 'bad-call',
        content: [{ type: 'text', text: 'Invalid arguments' }],
        isError: true,
      };
      const row = compressionSnapshot(
        {
          id: 's1',
          deriveMessages: () => [
            { role: 'assistant', content: [call] },
            { role: 'tool', toolCallId: 'bad-call', content: result.content, isError: true },
          ],
        },
        end,
      )!;
      const messages = JSON.parse(row.content);
      expect(
        messages.map((m: any) =>
          m.parts.map((p: any) => JSON.parse(p.text.split('\n').slice(1).join('\n'))),
        ),
      ).toEqual([[call], [result]]);
      expect(row.content).not.toContain('functionResponse');
      expect(row.content).not.toContain('functionCall');
    },
  );

  it('matches native empty-argument parsing without discarding the checkpoint', () => {
    const row = compressionSnapshot(
      {
        id: 's1',
        deriveMessages: () => [
          {
            role: 'assistant',
            content: [{ type: 'tool-call', id: 'empty', name: 'read', arguments: '' }],
          },
        ],
      },
      end,
    )!;
    expect(JSON.parse(row.content)[0].parts[0]).toEqual({
      functionCall: { id: 'empty', name: 'read', args: {} },
    });
  });
  it('retains developer tool updates and extension blocks as labelled data', () => {
    const blocks = [
      { type: 'tool-addition', toolName: 'read' },
      { type: 'tool-removal', toolName: 'write' },
      { type: 'plugin-note', value: 'retained extension content' },
      { type: 'text', text: 'A recorded developer note' },
    ];
    const row = compressionSnapshot(
      {
        id: 's1',
        deriveMessages: () => [
          { role: 'user', content: [{ type: 'text', text: 'Summary' }] },
          { role: 'developer', content: blocks },
        ],
      },
      end,
    )!;
    const [message] = JSON.parse(row.content);
    expect(message.role).toBe('user');
    expect(message.parts[0]).toEqual({ text: 'Summary' });
    expect(
      message.parts
        .slice(1)
        .map((part: any) => JSON.parse(part.text.split('\n').slice(1).join('\n'))),
    ).toEqual([
      { type: 'tool-addition', toolName: 'read' },
      { type: 'tool-removal', toolName: 'write' },
      { type: 'plugin-note', value: 'retained extension content' },
      { type: 'text', text: 'A recorded developer note' },
    ]);
    expect(message.parts[1].text).toContain('[Recorded DSH tool-addition data]');
  });
  it('preserves native attachment identities as reference data without inventing usable URIs', () => {
    const image = {
      type: 'image',
      attachment: {
        attachmentId: 'image-hash',
        mediaType: 'image/png',
        bytes: 100,
        width: 10,
        height: 10,
      },
    };
    const file = {
      type: 'file',
      attachment: { attachmentId: 'file-hash', name: 'notes.txt', bytes: 20 },
    };
    const row = compressionSnapshot(
      { id: 's1', deriveMessages: () => [{ role: 'user', content: [image, file] }] },
      end,
    )!;
    const [message] = JSON.parse(row.content);
    expect(message.parts).toEqual([
      { text: `[Recorded DSH image data]\n${JSON.stringify(image)}` },
      { text: `[Recorded DSH file data]\n${JSON.stringify(file)}` },
    ]);
    expect(row.content).not.toContain('fileUri');
  });
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
