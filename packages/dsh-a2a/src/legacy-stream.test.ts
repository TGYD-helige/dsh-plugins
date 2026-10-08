import { randomUUID } from 'node:crypto';
import { TaskState } from '@a2a-js/sdk';
import { AgentEvent, type AgentExecutor, ServerCallContext } from '@a2a-js/sdk/server';
import { JsonRpcTransport } from '@a2a-js/sdk-v03/client';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { expect, it } from 'vitest';
import { startA2aServer } from './server.js';
import { MemoryTaskStore } from './task-store.js';
import { SessionTranslator } from './translator.js';

it.each([
  ['completed', 'input-required'],
  ['tools', 'input-required'],
  ['max-tokens', 'input-required'],
  ['aborted', 'canceled'],
  ['error', 'failed'],
  ['blocked', 'failed'],
  ['approval', 'input-required'],
])('a real 0.3 client receives an explicit ending for %s', async (reason, state) => {
  const executor: AgentExecutor = {
    async execute({ taskId, contextId }, bus) {
      bus.publish(
        AgentEvent.task({
          id: taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_SUBMITTED,
            message: undefined,
            timestamp: new Date().toISOString(),
          },
          history: [],
          artifacts: [],
          metadata: undefined,
        }),
      );
      const translator = new SessionTranslator(taskId, contextId);
      const publish = (event: unknown) => {
        for (const output of translator.handle(event as SessionEvent)) bus.publish(output);
      };
      publish({ type: 'turn/start', data: { turn: 1 } });
      if (reason === 'approval') {
        bus.publish(
          AgentEvent.statusUpdate({
            taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_INPUT_REQUIRED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: { dshAgent: { kind: 'state-change', reason: 'approval' } },
          }),
        );
      } else {
        if (reason === 'tools') {
          publish({ type: 'tool/call', data: { callId: 'call', name: 'bash', arguments: '{}' } });
          publish({
            type: 'tool/result',
            data: { message: { toolCallId: 'call', content: [{ type: 'text', text: 'ok' }] } },
          });
        }
        publish({
          type: 'assistant/message',
          data: { message: { content: [{ type: 'text', text: 'answer' }] } },
        });
        publish({
          type: 'turn/end',
          data: {
            reason: {
              kind: reason === 'tools' ? 'completed' : reason,
              error: { message: 'failure' },
            },
          },
        });
      }
      bus.finished();
    },
    async cancelTask() {},
  };
  const server = await startA2aServer({
    host: '127.0.0.1',
    port: 0,
    basePath: '/a2a',
    card: { name: 'test', description: 'test', version: '1' },
    executor,
    taskStore: new MemoryTaskStore(),
  });
  try {
    const client = new JsonRpcTransport({ endpoint: `http://127.0.0.1:${server.port}/a2a/` });
    const events = [];
    for await (const event of client.sendMessageStream({
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: 'hello' }],
      },
    }))
      events.push(event);
    const last = events.at(-1);
    expect(last).toMatchObject({
      kind: 'status-update',
      status: { state },
      final: true,
      metadata: { dshAgent: { reason: reason === 'tools' ? 'completed' : reason } },
    });
    expect(events.filter((event) => event.kind === 'status-update' && event.final)).toHaveLength(1);
    if (reason === 'completed' && last?.kind === 'status-update') {
      const subscription = client.resubscribeTask({ id: last.taskId });
      expect((await subscription.next()).value).toMatchObject({ kind: 'task', id: last.taskId });
      const followup = [];
      for await (const event of client.sendMessageStream({
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'user',
          taskId: last.taskId,
          contextId: last.contextId,
          parts: [{ kind: 'text', text: 'again' }],
        },
      }))
        followup.push(event);
      expect(followup.at(-1)).toMatchObject({ taskId: last.taskId, final: true });
      const subscribed = [];
      for await (const event of subscription) subscribed.push(event);
      expect(subscribed.at(-1)).toMatchObject({
        kind: 'status-update',
        taskId: last.taskId,
        status: { state: 'input-required' },
        final: true,
      });
    }
    if (reason === 'tools')
      expect(
        events.filter(
          (event) =>
            (event.metadata?.dshAgent as { kind?: string } | undefined)?.kind === 'tool-call',
        ),
      ).toHaveLength(1);
  } finally {
    await server.close();
  }
});

it('ends a cold resubscription with a final status after its task snapshot', async () => {
  const store = new MemoryTaskStore();
  await store.save(
    {
      id: 'cold',
      contextId: 'context',
      history: [],
      artifacts: [],
      metadata: undefined,
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
    },
    new ServerCallContext(),
  );
  const server = await startA2aServer({
    host: '127.0.0.1',
    port: 0,
    basePath: '/a2a',
    card: { name: 'test', description: 'test', version: '1' },
    taskStore: store,
    executor: { async execute() {}, async cancelTask() {} },
  });
  try {
    const client = new JsonRpcTransport({ endpoint: `http://127.0.0.1:${server.port}/a2a/` });
    const events = [];
    for await (const event of client.resubscribeTask({ id: 'cold' })) events.push(event);
    expect(events[0]).toMatchObject({ kind: 'task', id: 'cold' });
    expect(events.at(-1)).toMatchObject({
      kind: 'status-update',
      taskId: 'cold',
      final: true,
      status: { state: 'input-required' },
    });
  } finally {
    await server.close();
  }
});
