import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type Message, type Part, Role, TaskState } from '@a2a-js/sdk';
import {
  type AgentExecutionEvent,
  DefaultExecutionEventBus,
  RequestContext,
  ServerCallContext,
  STATE_HEADERS_KEY,
} from '@a2a-js/sdk/server';
import { Context } from '@deepseek-ai/cordis';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2aBridge } from '../../../packages/dsh-a2a/src/bridge.js';
import { DshAgentExecutor } from '../../../packages/dsh-a2a/src/executor.js';
import { startA2aServer } from '../../../packages/dsh-a2a/src/server.js';
import { MemoryTaskStore, SanitizedTaskStore } from '../../../packages/dsh-a2a/src/task-store.js';

const mocks = vi.hoisted(() => ({ installModelSelection: vi.fn() }));
vi.mock('@deepseek-ai/dsh-agent', () => ({ installModelSelection: mocks.installModelSelection }));

let seq = 0;
function event(type: string, data: unknown): SessionEvent {
  return { type, seq: seq++, time: Date.now(), data } as SessionEvent;
}
const turnEnd = (reason: TurnEndReason) => event('turn/end', { turn: 1, reason });
let runScript: (fake: any) => void;

function fakeAgents(ctx: Context) {
  const created: any[] = [];
  const registry = {
    create: vi.fn(async (options: any) => {
      const session = { id: options.sessionId };
      const fake: any = {
        sessionId: options.sessionId,
        prompts: [],
        contents: [],
        emit: (events: SessionEvent[]) => {
          for (const item of events) ctx.emit('session/event', session as never, item);
        },
        stream: (frames: unknown[]) => {
          for (const frame of frames)
            ctx.emit('agent/assistant-stream', { agent: fake.agent, frame } as never);
        },
        agent: undefined,
      };
      const agent = {
        id: options.sessionId,
        session,
        options: options.agentOptions ?? {},
        status: 'idle',
        followup: vi.fn((message: any) => {
          ctx.emit('agent/inbox/inserted', { agent, message } as never);
          ctx.emit('agent/inbox/claimed', { agent, message, turn: 1 } as never);
          fake.contents.push(message.content);
          fake.prompts.push(message.content.map((block: any) => block.text ?? '').join(''));
          runScript(fake);
        }),
        cancel: vi.fn(),
        whenIdle: vi.fn(async () => {}),
      };
      fake.agent = agent;
      created.push(fake);
      return { agent, dispose: vi.fn(async () => {}) };
    }),
  };
  ctx.provide('agents', registry as never);
  return { registry, created };
}

describe('A2A bridge HTTP integration', () => {
  let ctx: Context;
  let bridge: A2aBridge;
  let agents: ReturnType<typeof fakeAgents>;

  beforeEach(() => {
    seq = 0;
    runScript = (fake) =>
      fake.emit([event('turn/start', { turn: 1 }), turnEnd({ kind: 'completed' })]);
    ctx = new Context();
    agents = fakeAgents(ctx);
    bridge = new A2aBridge(ctx, { cwd: '/tmp', agentOptions: { model: 'm' } });
    mocks.installModelSelection.mockClear();
  });

  afterEach(vi.unstubAllGlobals);

  const userMessage = (text: string): Message => ({
    messageId: 'user-1',
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [part({ $case: 'text', value: text }, 'text/plain')],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  });
  const part = (content: Part['content'], mediaType = '', filename = ''): Part => ({
    content,
    metadata: undefined,
    filename,
    mediaType,
  });
  const statusUpdates = (events: AgentExecutionEvent[]) =>
    events
      .filter(
        (event): event is Extract<AgentExecutionEvent, { kind: 'statusUpdate' }> =>
          event.kind === 'statusUpdate',
      )
      .map((event) => event.data);

  async function executeMessage(message: Message) {
    const executor = new DshAgentExecutor(bridge);
    const bus = new DefaultExecutionEventBus();
    const seen: AgentExecutionEvent[] = [];
    bus.on('event', (event) => seen.push(event));
    await executor.execute(
      new RequestContext(
        { tenant: '', message, configuration: undefined, metadata: undefined },
        't1',
        'ctx1',
        new ServerCallContext({ state: new Map([[STATE_HEADERS_KEY, {}]]) }),
      ),
      bus,
    );
    return seen;
  }

  const promptPath = (prompt: string) => {
    const filePath = /path="([^"]+)"/.exec(prompt)?.[1];
    if (!filePath) throw new Error(`no path attribute in prompt: ${prompt}`);
    return filePath;
  };

  function fakeAttachments() {
    const store = {
      imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
      saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
        attachmentId: `img-${input.name ?? 'image'}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 8,
        height: 8,
        name: input.name,
      })),
      saveFile: vi.fn(async (input: { data: Uint8Array; name?: string }) => ({
        attachmentId: `file-${input.name ?? 'upload'}`,
        name: input.name ?? 'upload',
        bytes: input.data.byteLength,
      })),
    };
    ctx.provide('attachments', store as unknown as AttachmentStore);
    return store;
  }

  const stubDownload = async (uploadsCwd: string) => {
    const docBytes = new TextEncoder().encode('hello doc');
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      res.end(docBytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    bridge = new A2aBridge(ctx, {
      cwd: uploadsCwd,
      agentOptions: { model: 'm' },
      uploadsDir: uploadsCwd,
      downloadAllowedHosts: ['127.0.0.1'],
    });
    return {
      docBytes,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/doc.docx`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  it('publishes tool calls and results on the legacy A2A HTTP stream', async () => {
    runScript = (fake) => {
      fake.emit([
        event('turn/start', { turn: 1 }),
        event('tool/call', {
          turn: 1,
          step: 1,
          callId: 'call-1',
          name: 'bash',
          arguments: '{"command":"pwd"}',
        } as never),
        event('tool/result', {
          turn: 1,
          step: 1,
          message: {
            id: 'result-1',
            role: 'tool',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: '/workspace' }],
          },
        } as never),
        turnEnd({ kind: 'completed' }),
      ]);
    };
    const server = await startA2aServer({
      host: '127.0.0.1',
      port: 0,
      basePath: '/a2a',
      card: { name: 'test', description: 'test', version: '0.1' },
      executor: new DshAgentExecutor(bridge),
      taskStore: new SanitizedTaskStore(new MemoryTaskStore()),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/a2a/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: {
            message: {
              kind: 'message',
              messageId: 'user-1',
              role: 'user',
              parts: [{ kind: 'text', text: 'work' }],
            },
          },
        }),
      });
      const frames = (await response.text())
        .split('\n\n')
        .filter((frame) => frame.startsWith('data: '))
        .map((frame) => JSON.parse(frame.slice(6)));
      const updates = frames
        .map((frame) => frame.result)
        .filter((result) => result?.kind === 'status-update');
      expect(
        updates.find((update) => update.metadata?.dshAgent?.kind === 'tool-call'),
      ).toMatchObject({
        status: {
          message: {
            parts: [
              {
                data: {
                  callId: 'call-1',
                  name: 'bash',
                  arguments: '{"command":"pwd"}',
                },
              },
            ],
          },
        },
      });
      expect(
        updates.find((update) => update.metadata?.dshAgent?.kind === 'tool-result'),
      ).toMatchObject({
        status: { message: { parts: [{ data: { callId: 'call-1', result: '/workspace' } }] } },
      });
    } finally {
      await server.close();
    }
  });

  it('downloads a url file part locally when a store is composed', async () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const uploadsCwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-a2a-uploads-'));
    const store = fakeAttachments();
    const download = await stubDownload(uploadsCwd);
    try {
      const message: Message = {
        ...userMessage(''),
        parts: [
          part({ $case: 'text', value: '这个文档讲了啥' }, 'text/plain'),
          part({ $case: 'url', value: download.url }, DOCX, 'doc.docx'),
        ],
      };
      const seen = await executeMessage(message);
      expect(store.saveFile).not.toHaveBeenCalled();
      const blocks = agents.created[0].contents[0];
      expect(blocks[0]).toMatchObject({ type: 'text', text: '这个文档讲了啥' });
      expect(blocks[1]).toMatchObject({ type: 'text' });
      expect(new Uint8Array(await readFile(promptPath(blocks[1].text ?? '')))).toEqual(
        download.docBytes,
      );
      expect(statusUpdates(seen).at(-1)!.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    } finally {
      await download.close();
    }
  });

  it('persists a url file part into the workspace when no store is composed', async () => {
    const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const uploadsCwd = await mkdtemp(path.join(os.tmpdir(), 'dsh-a2a-uploads-'));
    const download = await stubDownload(uploadsCwd);
    try {
      const message: Message = {
        ...userMessage(''),
        parts: [
          part({ $case: 'text', value: '这个文档讲了啥' }, 'text/plain'),
          part({ $case: 'url', value: download.url }, DOCX, 'doc.docx'),
        ],
      };
      const seen = await executeMessage(message);
      const prompt = agents.created[0].prompts[0];
      expect(prompt).toContain(`<document name="doc.docx" uri="${download.url}"`);
      expect(prompt).toContain(`type="${DOCX}"`);
      expect(prompt).toContain(`size="${download.docBytes.byteLength}"`);
      const filePath = promptPath(prompt);
      expect(filePath.startsWith(uploadsCwd)).toBe(true);
      expect(new Uint8Array(await readFile(filePath))).toEqual(download.docBytes);
      expect(statusUpdates(seen).at(-1)!.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    } finally {
      await download.close();
    }
  });
});
