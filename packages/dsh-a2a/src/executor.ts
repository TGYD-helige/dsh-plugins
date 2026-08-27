/**
 * The @a2a-js/sdk {@link AgentExecutor} that drives dsh agents through the
 * bridge. One `execute()` = one user-message turn:
 *
 *   1. extract the text prompt (v1 is text-only)
 *   2. ensure the task's session/agent exists (creating it on first contact)
 *   3. anchor the SDK's ResultManager with an initial Task event for ids it
 *     has never seen (its status-update path drops unknown tasks)
 *   4. run the turn; session events stream onto the bus via the bridge
 *   5. on failure publish a failed final event instead of rethrowing — the
 *     SDK's own executor-failure fallback mints a fresh task id, which would
 *     detach the error from the task the client asked about
 *
 * `cancelTask` is an arrow property because the SDK destructures it.
 */

import type { Message, Task, TextPart } from '@a2a-js/sdk';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
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
      if (freshTask) {
        eventBus.publish(initialTask(taskId, contextId, userMessage));
        anchored = true;
      }
      await this.bridge.runTurn(entry, text, eventBus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!anchored) eventBus.publish(failedTask(taskId, contextId, message));
      eventBus.publish(terminalStatusUpdate(taskId, contextId, 'failed', message));
    } finally {
      eventBus.finished();
    }
  }

  cancelTask = async (taskId: string, eventBus: ExecutionEventBus): Promise<void> => {
    // The SDK only calls cancelTask while a bus for the task is live. The live
    // path aborts the dsh turn (its turn/end also lands on the bus as a
    // canceled final via the translator — a harmless duplicate); the published
    // event moves the persisted shell to canceled through the handler's
    // ResultManager either way.
    const contextId = this.bridge.cancel(taskId) ?? '';
    eventBus.publish(
      terminalStatusUpdate(taskId, contextId, 'canceled', 'Task canceled by request.'),
    );
  };
}

// TODO(verify): non-text parts (file/data) — dsh supports image content
// blocks; map them when a client needs it. The confirmation data-part
// protocol ({callId, outcome}) has no dsh rc.7 counterpart to bridge to.
function extractText(message: Message): string {
  const nonText = message.parts.filter((part) => part.kind !== 'text');
  if (nonText.length > 0) {
    throw new Error(
      `dsh-a2a: unsupported part kind(s): ${nonText.map((part) => part.kind).join(', ')} (text-only)`,
    );
  }
  const text = message.parts.map((part) => (part as TextPart).text).join('');
  if (!text.trim()) throw new Error('dsh-a2a: message must contain at least one text part');
  return text;
}

function initialTask(taskId: string, contextId: string, userMessage: Message): Task {
  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: { state: 'submitted', timestamp: new Date().toISOString() },
    history: [userMessage],
  };
}

function failedTask(taskId: string, contextId: string, message: string): Task {
  return {
    kind: 'task',
    id: taskId,
    contextId,
    status: {
      state: 'failed',
      message: agentTextMessage(taskId, contextId, message),
      timestamp: new Date().toISOString(),
    },
    history: [],
  };
}
