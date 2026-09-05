/**
 * The @a2a-js/sdk {@link AgentExecutor} that drives dsh agents through the
 * bridge. One `execute()` = one user-message turn:
 *
 *   1. extract the text prompt (v1 is text-only)
 *   2. ensure the task's session/agent exists (creating it on first contact)
 *   3. publish a `task` event first — A2A 1.0 stream ordering REQUIRES the
 *      first event of every execute to be a task or message, including
 *      follow-up turns on a known task (the ResultManager merges it with the
 *      stored task; fresh tasks get the submitted anchor carrying the user
 *      message, continuing tasks get a working snapshot)
 *   4. run the turn; session events stream onto the bus via the bridge
 *   5. on failure publish a failed statusUpdate (plus a failed task anchor if
 *      none went out yet) instead of rethrowing — clients get the terminal
 *      state in band on both blocking and streaming paths
 *
 * `cancelTask` is an arrow property because the SDK destructures it.
 */

import { type Message, type Task, TaskState } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { AgentEvent } from '@a2a-js/sdk/server';
import type { A2aBridge } from './bridge.js';
import { agentTextMessage, terminalStatusUpdate } from './translator.js';

export class DshAgentExecutor implements AgentExecutor {
  constructor(private readonly bridge: A2aBridge) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;
    let anchored = false;
    try {
      const text = extractText(userMessage);
      const { entry, freshTask } = await this.bridge.ensureTask(taskId, contextId);
      eventBus.publish(
        freshTask
          ? // First contact: the submitted anchor carries the user message
            // into the task history the ResultManager persists.
            taskEvent(taskId, contextId, TaskState.TASK_STATE_SUBMITTED, { history: [userMessage] })
          : // Follow-up turn: a working snapshot satisfies the 1.0
            // stream-ordering rule; the ResultManager merges it with the
            // stored task (history/artifacts preserved).
            taskEvent(taskId, contextId, TaskState.TASK_STATE_WORKING),
      );
      anchored = true;
      await this.bridge.runTurn(entry, text, eventBus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!anchored) {
        eventBus.publish(
          taskEvent(taskId, contextId, TaskState.TASK_STATE_FAILED, {
            message: agentTextMessage(taskId, contextId, message),
          }),
        );
      }
      eventBus.publish(terminalStatusUpdate(taskId, contextId, 'failed', message));
    } finally {
      eventBus.finished();
    }
  }

  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    // The SDK only calls cancelTask while a bus for the task is live. The live
    // path aborts the dsh turn (its turn/end also lands on the bus as a
    // canceled statusUpdate via the translator — a harmless duplicate); the
    // published event moves the persisted shell to canceled through the
    // handler's ResultManager either way.
    const contextId = this.bridge.cancel(taskId) ?? '';
    eventBus.publish(
      terminalStatusUpdate(taskId, contextId, 'canceled', 'Task canceled by request.'),
    );
  };
}

/** One task event in the 1.0 model: the proto-required fields live here exactly once. */
function taskEvent(
  taskId: string,
  contextId: string,
  state: TaskState,
  extra: { history?: Message[]; message?: Message } = {},
): ReturnType<typeof AgentEvent.task> {
  const task: Task = {
    id: taskId,
    contextId,
    status: {
      state,
      message: extra.message,
      timestamp: new Date().toISOString(),
    },
    history: extra.history ?? [],
    artifacts: [],
    metadata: undefined,
  };
  return AgentEvent.task(task);
}

// TODO(verify): non-text parts (file/raw/url/data) — dsh supports image
// content blocks; map them when a client needs it. The confirmation data-part
// protocol ({callId, outcome}) maps onto the optional dsh-user-approval
// service (0.1.2+, asks carry the exact tool call) — bridge it once a
// deployment composes that service.
function extractText(message: Message): string {
  const nonText = message.parts.filter((part) => part.content?.$case !== 'text');
  if (nonText.length > 0) {
    throw new Error(
      `dsh-a2a: unsupported part kind(s): ${nonText.map((part) => part.content?.$case ?? 'unknown').join(', ')} (text-only)`,
    );
  }
  const text = message.parts
    .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
    .join('');
  if (!text.trim()) throw new Error('dsh-a2a: message must contain at least one text part');
  return text;
}
