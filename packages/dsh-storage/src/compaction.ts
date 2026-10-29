import type { MessageRow } from './types.js';

/** Legacy Content[] checkpoints remain readable by databaseChatStorage. */
export function compressionSnapshot(session: any, event: any): MessageRow | null {
  if (event?.type !== 'compaction/end' || event.data?.error !== undefined) return null;
  const calls = new Map<string, string>();
  const messages = session.deriveMessages().flatMap((message: any) => {
    if (message.role === 'system') return [];
    if (message.role === 'tool') {
      const id = message.toolCallId ?? message.source?.callId;
      const name = calls.get(id);
      if (!name) throw new Error('compaction snapshot has an unmatched tool result');
      return [
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id,
                name,
                response: { output: message.content, isError: Boolean(message.isError) },
              },
            },
          ],
        },
      ];
    }
    const parts = message.content.map((block: any, index: number) => {
      switch (block.type) {
        case 'text':
          return { text: block.text };
        case 'reasoning': {
          const replay = message.source?.replayState?.blocks?.[index];
          const signature = replay?.signature ?? replay?.thoughtSignature;
          return {
            text: block.text,
            thought: true,
            ...(signature ? { thoughtSignature: signature } : {}),
          };
        }
        case 'tool-call':
          calls.set(block.id, block.name);
          return {
            functionCall: { id: block.id, name: block.name, args: JSON.parse(block.arguments) },
          };
        case 'image':
        case 'file':
          return {
            fileData: { fileUri: block.attachment.id, mimeType: block.attachment.mediaType },
          };
        default:
          throw new Error(`unsupported compaction snapshot block: ${block.type}`);
      }
    });
    return [{ role: message.role === 'assistant' ? 'model' : 'user', parts }];
  });
  const content: Array<{ role: string; parts: any[] }> = [];
  for (const message of messages) {
    const previous = content.at(-1);
    // Legacy recovery discards adjacent equal roles instead of merging them.
    if (previous && previous.role === message.role) previous.parts.push(...message.parts);
    else content.push(message);
  }
  return {
    id: event.data.compactionId,
    sessionId: session.id,
    historyId: null,
    agentId: 'main',
    type: 'utility_compressor',
    content: JSON.stringify(content),
    model: 'agent-history-provider-summarizer',
    createdAt: new Date(event.time),
    metadata: {
      id: event.data.compactionId,
      event: event.type,
      seq: event.seq,
      sessionCreatedAt: session.header?.createdAt,
      sessionId: session.id,
      newHistoryLength: content.length,
    },
  };
}
