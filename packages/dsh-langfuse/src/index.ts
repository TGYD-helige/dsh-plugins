/**
 * dsh-langfuse — Langfuse observability for DeepSeek Harness.
 *
 * Instruments the documented seams, with zero core patches:
 *
 * - `llm/stream` waterfall  → one Langfuse **generation** per LLM call
 *   (input = loop-built options; output, token usage and finish reason collected
 *   from the chunk stream), plus a nested `llm-request` **span** holding the
 *   same options and collected chunk stream (the rawest request/response a
 *   plugin can observe — the provider HTTP body is assembled inside the adapter).
 * - `tools/pre-execute` → `tools/result` → one Langfuse **span** per tool pipeline
 *   (routed to the session's trace via `exec.agent.id` — the agent/session
 *   shared identity).
 * - `hook/invoked` / `hook/result` session records → one **span** per hook run.
 * - `session/event` emit    → one Langfuse **trace** per agent turn
 *   (`turn/start` opens a root span — in the v5 SDK the root observation IS
 *   the trace — the turn's first `user/message` sets the input, `turn/end`
 *   stamps the end reason and ends the root, which is what exports it).
 * - Native A2A inbox tasks own a trace spanning admission through task termination;
 *   agent turns and queue controls are children of that task.
 * - subagent child sessions (`session/created` with `header.parentSession`)
 *   ride the parent's trace: a `subagent` **span** opened under the enclosing
 *   delegation tool span, the child's generations/tool spans nested under it,
 *   closed at `subagent/end` (enriched by `subagent/start` and the child's
 *   `subagent/descriptor` event).
 *
 * Event/waterfall shapes verified against the installed
 * @deepseek-ai/dsh-{llm,session,tools,agent,subagent}@0.2.0-rc.1 package sources
 * (types for shapes; `lib/*.js` for the session/created ordering claim).
 *
 * @module dsh-langfuse
 */

import { createHash } from 'node:crypto';
import type { Context, Events } from '@deepseek-ai/cordis';
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm';
// Augmentation-only imports: pull the dsh packages' Events declarations into
// the compilation (the listeners are contextually typed).
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { LangfuseReporter, type LangfuseTraceContext, type ObservationLevel } from './client.js';
import { isHookInvoked, isHookResult } from './hooks.js';
import { displayBlocks } from './media.js';

export type { LangfuseTraceContext } from './client.js';
export { appendHookEvent, type HookInvoked, type HookResult } from './hooks.js';

/** Optional protocol telemetry; no dependency on the A2A plugin. */
interface A2aInboxEvent {
  phase: string;
  contextId: string;
  at: number;
  pending: number;
  target?: 'next-turn' | 'next-step';
  input?: string;
  position?: number;
  agentStatus?: string;
  taskId?: string;
  taskIds?: string[];
  messageId?: string;
  referenceTaskIds?: string[];
  nativeMessageId?: string;
  queuedAt?: number;
  selectedAt?: number;
  turn?: number;
  step?: number;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'a2a/inbox'(detail: A2aInboxEvent): void;
    /** Bind standard labels/parent context before a session's next trace starts. */
    'langfuse/context': (sessionId: string, context: LangfuseTraceContext) => void;
  }
}

export const name = 'dsh-langfuse';

/**
 * Waterfall listeners only need the events to exist; no hard service
 * dependency is declared so the plugin still loads in minimal compositions
 * (it simply never observes anything). Add 'llm' / 'tools' to `inject` if you
 * prefer fail-fast wiring.
 */
export const inject = [] as string[];

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('master switch'),
  publicKey: Schema.string().default('').description('Langfuse public key'),
  secretKey: Schema.string().role('secret').default('').description('Langfuse secret key'),
  baseUrl: Schema.string()
    .default('')
    .description('profile override for LANGFUSE_BASE_URL; defaults to EU cloud'),
  traceName: Schema.string().default('dsh-turn'),
  /** Include full message/tool payloads in Langfuse IO. Disable to log metadata only. */
  captureContent: Schema.boolean().default(true),
  redactFields: Schema.array(Schema.string())
    .default([])
    .description('case-insensitive payload fields to redact'),
  userId: Schema.string().default(''),
  tags: Schema.array(Schema.string()).default([]),
  environment: Schema.string().default(''),
  release: Schema.string().default(''),
  captureMedia: Schema.boolean()
    .default(false)
    .description('upload attachment images for display; requires captureContent'),
  maxMediaBytes: Schema.number()
    .min(1)
    .step(1)
    .default(5 * 1024 * 1024)
    .description('image byte budget per display payload'),
  mediaTimeoutMs: Schema.number().min(1).max(60_000).step(1).default(5000),
});

export interface LangfusePluginConfig {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  traceName: string;
  captureContent: boolean;
  redactFields?: string[];
  userId?: string;
  tags?: string[];
  environment?: string;
  release?: string;
  captureMedia?: boolean;
  maxMediaBytes?: number;
  mediaTimeoutMs?: number;
}

/** Any observation handle the plugin tracks (v5: trace roots and spans are the same type). */
type ObservationHandle = ReturnType<LangfuseReporter['startSpan']>;

interface HookObservation {
  span: ObservationHandle;
  root?: ObservationHandle;
  turn: number;
  point: string;
  handlerId: string;
  persistent: boolean;
  callId?: string;
  turnTrace?: ObservationHandle;
}

/** Per-session open turn trace. */
interface SessionTrace {
  taskKey?: string;
  trace: NonNullable<ObservationHandle>;
  /** Whether the trace input was set — the turn's first `user/message` wins. */
  hasInput: boolean;
  /** The turn's latest assistant text — becomes the trace's output at `turn/end`. */
  lastAssistantText?: string;
  hadErrors?: boolean;
  turn?: number;
}

interface InboxTaskTrace {
  key: string;
  contextId: string;
  taskId: string;
  trace: ObservationHandle;
  hasInput: boolean;
  messageIds: Set<string>;
  nativeMessageIds: Set<string>;
  selectedAt?: number;
  waitMs?: number;
  lastOutput?: string;
  openTurns: number;
  end?: { phase: string; at: number; output: unknown; level: ObservationLevel };
}

/**
 * A subagent child session (header.parentSession set at session/created):
 * rides the parent session's trace under one `subagent` span instead of
 * opening own turn traces.
 */
interface ChildSession {
  parentSessionId: string;
  turnTrace?: ObservationHandle;
  turn?: number;
  /** The open `subagent` span for this child (null when creation failed). */
  span: ObservationHandle;
  /** Whether the span input was set — the child's first `user/message` wins. */
  hasInput: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Provider/tool error text can embed prompt fragments, paths, or credentials —
 * it crosses to Langfuse only when `captureContent` allows content. Structural
 * facts (levels, kinds, error codes) always do.
 */
const contentMessage = (config: LangfusePluginConfig, text: string): string | undefined =>
  config.captureContent ? text : undefined;

// dsh-llm ≤0.1.0 exported this shared predicate from './message'; 0.1.2
// removed it without a replacement (0.1.3 keeps per-package private copies),
// so the TTFT rule lives here: the first real token is a non-empty
// text/reasoning delta or a tool-call delta with content — block boundaries,
// usage frames and empty heartbeat deltas are not completions.
const isTokenDelta = (chunk: StreamChunk): boolean =>
  ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && chunk.text !== '') ||
  (chunk.type === 'tool-call-delta' && (chunk.argumentsDelta !== '' || chunk.name !== undefined));

/** Trace input/output text: the message's text blocks, joined. */
function messageText(message: { content: readonly ContentBlock[] }): string | undefined {
  const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
  return text.length > 0 ? text.join('\n') : undefined;
}

/**
 * Langfuse model parameters: only the request fields actually set, coerced to
 * the v5 value type (`string | number` — the stop list serializes). Stop
 * sequences are arbitrary request strings — content, not metadata — so under
 * `captureContent: false` they collapse to a count.
 */
function modelParametersOf(
  options: GenerateOptions,
  captureContent: boolean,
): Record<string, string | number> | undefined {
  const params = Object.fromEntries(
    Object.entries({
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: captureContent && options.stop ? JSON.stringify(options.stop) : undefined,
      stopCount: captureContent ? undefined : options.stop?.length,
      reasoningEffort: options.reasoningEffort,
      // Narrowing predicate: drops the undefined-valued keys for the type
      // checker too (dsh-llm ≥0.1.2 resolves its branded ids for real —
      // dsh-brand became a runtime dependency — so the unfiltered union no
      // longer collapses to any).
    }).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
  );
  return Object.keys(params).length > 0 ? params : undefined;
}

/**
 * The loop-built request as Langfuse input: every current/future option except
 * the non-JSON-safe AbortSignal when content capture is on, counts otherwise.
 */
function requestBodyOf(options: GenerateOptions, captureContent: boolean): Record<string, unknown> {
  if (!captureContent) {
    return {
      messageCount: options.messages.length,
      hasSystem: options.system !== undefined,
      toolCount: options.tools?.length,
    };
  }
  const { signal: _, ...body } = options;
  return body;
}

/** Generation names carry the reply's first non-empty line (capped) for list readability. */
function enhanceWithFirstLine(base: string, text: string): string | undefined {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  return `${base} [${firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine}]`;
}

/** Tool argument keys worth surfacing in a span name, in priority order. */
const ARG_SUMMARY_KEYS = [
  'path',
  'file_path',
  'filePath',
  'command',
  'description',
  'query',
  'name',
  'url',
  'instruction',
];

/** A short argument summary for span names: the first matching key's first line, trimmed and capped. */
function toolCallSummary(args: unknown): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const key of ARG_SUMMARY_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    const first = value.split('\n', 1)[0].trim();
    if (first.length > 0) return first.slice(0, 80);
  }
  return undefined;
}

/** Redact each complete block before exporting fragments that could reconstruct a secret. */
function redactChunks(chunks: StreamChunk[], reporter: LangfuseReporter): StreamChunk[] {
  const groups = new Map<string, { text: string; positions: number[] }>();
  for (const [position, chunk] of chunks.entries()) {
    if (
      chunk.type !== 'text-delta' &&
      chunk.type !== 'reasoning-delta' &&
      chunk.type !== 'tool-call-delta'
    )
      continue;
    const key = `${chunk.type}:${chunk.index}`;
    const group = groups.get(key) ?? { text: '', positions: [] };
    group.text += chunk.type === 'tool-call-delta' ? chunk.argumentsDelta : chunk.text;
    group.positions.push(position);
    groups.set(key, group);
  }
  const output = [...chunks];
  for (const group of groups.values()) {
    const masked = reporter.mask(group.text);
    if (masked === group.text) continue;
    // Sensitive content changes, but the record count/type/index remain.
    for (const [index, position] of group.positions.entries()) {
      const chunk = chunks[position];
      const text = index === 0 ? masked : '';
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
        output[position] = { ...chunk, text };
      else if (chunk.type === 'tool-call-delta')
        output[position] = { ...chunk, argumentsDelta: text };
    }
  }
  return output;
}

/** Validate and copy together: JSON.stringify silently rewrites non-JSON values. */
function snapshotMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const ancestors = new Set<object>();
  function snapshot(value: unknown): unknown {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return value;
    if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Invalid metadata');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
      throw new TypeError('Invalid metadata');
    ancestors.add(value);
    let copy: unknown;
    if (array) {
      // Reject holes and extra properties instead of turning them into null or dropping them.
      if (Reflect.ownKeys(value).length !== value.length + 1)
        throw new TypeError('Invalid metadata');
      copy = Array.from({ length: value.length }, (_, index) => {
        if (!Object.hasOwn(value, index)) throw new TypeError('Invalid metadata');
        return snapshot(value[index]);
      });
    } else {
      copy = Object.fromEntries(
        Reflect.ownKeys(value).map((key) => {
          if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(value, key))
            throw new TypeError('Invalid metadata');
          return [key, snapshot((value as Record<string, unknown>)[key])];
        }),
      );
    }
    ancestors.delete(value);
    return copy;
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new TypeError('Invalid metadata');
  return snapshot(metadata) as Record<string, unknown>;
}

export function apply(ctx: Context, config: LangfusePluginConfig): Promise<void> | void {
  if (!config.enabled || /^(false|0)$/i.test(process.env.LANGFUSE_TRACING_ENABLED ?? '')) return;
  config = {
    ...config,
    publicKey: config.publicKey || process.env.LANGFUSE_PUBLIC_KEY || '',
    secretKey: config.secretKey || process.env.LANGFUSE_SECRET_KEY || '',
    baseUrl: config.baseUrl || process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
    userId: config.userId || process.env.LANGFUSE_USER_ID,
  };
  if (!config.publicKey || !config.secretKey) return;

  const reporter = new LangfuseReporter(config);
  const sessions = new Map<string, SessionTrace>();
  const nativeInboxes = new Set<string>();
  const pendingTurns = new Map<string, { turn: number; startTime: Date }>();
  const inboxInputs = new Map<string, A2aInboxEvent[]>();
  const inboxTasks = new Map<string, InboxTaskTrace>();
  const children = new Map<string, ChildSession>();
  const completedTurns = new Map<
    string,
    { sessionId: string; parent: NonNullable<ObservationHandle>; turnTrace: ObservationHandle }
  >();

  function rememberTurn(
    sessionId: string,
    turn: number,
    parent: ObservationHandle,
    turnTrace: ObservationHandle,
  ): void {
    if (!parent) return;
    const key = JSON.stringify([sessionId, turn]);
    completedTurns.delete(key);
    completedTurns.set(key, { sessionId, parent, turnTrace });
    // Bound retained SDK handles across all sessions; older hooks use the standalone fallback.
    if (completedTurns.size > 128) completedTurns.delete(completedTurns.keys().next().value!);
  }
  /** Per-session stack of currently open tool pipeline spans (for subagent parenting). */
  const openToolSpans = new Map<string, ObservationHandle[]>();
  const toolCalls = new Map<string, Map<string, { span: ObservationHandle; turn?: number }>>();
  const toolResults = new WeakMap<
    object,
    (result: Parameters<Events['tools/result']>[1]) => void
  >();
  const openHooks = new Map<string, Map<string, HookObservation>>();
  const openOperations = new Set<() => void>();
  const traceContexts = new Map<string, LangfuseTraceContext>();
  type Handle =
    | NonNullable<ObservationHandle>
    | NonNullable<ReturnType<LangfuseReporter['startGeneration']>>;
  const pendingMedia = new Set<Promise<void>>();
  const mediaFor = new WeakMap<Handle, Promise<void>>();
  const mediaOptions = {
    enabled:
      config.captureContent &&
      !!config.captureMedia &&
      !/^(false|0)$/i.test(process.env.LANGFUSE_MEDIA_UPLOAD_ENABLED ?? ''),
    maxBytes: config.maxMediaBytes ?? 5 * 1024 * 1024,
    timeoutMs: config.mediaTimeoutMs ?? 5000,
  };

  function trackMedia(task: Promise<void>): Promise<void> {
    const pending = task.catch((error) => {
      console.error('[dsh-langfuse] media finalization failed:', error);
    });
    pendingMedia.add(pending);
    void pending.then(() => pendingMedia.delete(pending));
    return pending;
  }

  function enrichInput(handle: Handle | null, input: Promise<unknown>): void {
    if (!handle) return;
    mediaFor.set(
      handle,
      trackMedia(input.then((value) => reporter.updateSpan(handle, { input: value }))),
    );
  }

  function afterMedia(
    handle: Handle | null,
    close: (endedAt: Date) => void,
    endedAt = new Date(),
  ): void {
    const task = handle ? mediaFor.get(handle) : undefined;
    if (task) trackMedia(task.then(() => close(endedAt)));
    else close(endedAt);
  }

  function setMessageInput(handle: ObservationHandle, content: readonly ContentBlock[]): void {
    if (content.some((block) => block.type !== 'text')) {
      enrichInput(handle, displayBlocks(content, ctx.get('attachments'), mediaOptions));
    } else reporter.updateSpan(handle, { input: messageText({ content }) });
  }

  async function drainMedia(): Promise<void> {
    while (pendingMedia.size) await Promise.all([...pendingMedia]);
  }

  ctx.on('langfuse/context', (sessionId, context) => {
    traceContexts.delete(sessionId);
    try {
      // Snapshot at submission, not trace creation: the host may reuse or
      // mutate its request object before the next event opens the trace.
      const { userId, tags, traceparent, metadata } = context;
      const snapshot = {
        userId,
        tags,
        traceparent,
        metadata: metadata === undefined ? undefined : snapshotMetadata(metadata),
      };
      traceContexts.set(sessionId, reporter.mask(JSON.parse(JSON.stringify(snapshot))));
    } catch {
      // Never include caller data or serialization errors in diagnostics.
      console.error('[dsh-langfuse] invalid request context; ignoring context');
    }
  });

  function openTrace(
    sessionId: string | undefined,
    metadata?: Record<string, unknown>,
    startTime?: Date,
  ) {
    const context = sessionId ? traceContexts.get(sessionId) : undefined;
    if (sessionId) traceContexts.delete(sessionId);
    return reporter.openTrace({ name: config.traceName, sessionId, metadata, context, startTime });
  }

  const inboxKey = (contextId: string, taskId: string) => JSON.stringify([contextId, taskId]);

  function taskTrace(event: A2aInboxEvent): InboxTaskTrace | undefined {
    if (!event.taskId) return;
    const key = inboxKey(event.contextId, event.taskId);
    let task = inboxTasks.get(key);
    if (!task) {
      const context = traceContexts.get(event.contextId);
      traceContexts.delete(event.contextId);
      task = {
        key,
        contextId: event.contextId,
        taskId: event.taskId,
        trace: reporter.openTrace({
          name: config.traceName === 'dsh-turn' ? 'a2a-task' : config.traceName,
          sessionId: event.contextId,
          metadata: { taskId: event.taskId, taskState: 'queued' },
          traceId: createHash('sha256').update(key).digest('hex').slice(0, 32),
          startTime: new Date(event.queuedAt ?? event.at),
        }),
        hasInput: false,
        messageIds: new Set(),
        nativeMessageIds: new Set(),
        openTurns: 0,
      };
      if (context) reporter.updateContext(task.trace, context);
      inboxTasks.set(key, task);
    }
    if (event.messageId) task.messageIds.add(event.messageId);
    if (event.nativeMessageId) task.nativeMessageIds.add(event.nativeMessageId);
    if (!task.hasInput && config.captureContent && event.input) {
      reporter.updateSpan(task.trace, { input: event.input });
      task.hasInput = true;
    }
    reporter.updateSpan(task.trace, {
      metadata: {
        referenceTaskIds: event.referenceTaskIds?.length ? event.referenceTaskIds : undefined,
        a2aMessageIds: [...task.messageIds],
        nativeMessageIds: [...task.nativeMessageIds],
      },
    });
    return task;
  }

  function closeTask(task: InboxTaskTrace, endedAt = new Date()): void {
    if (!task.end || task.openTurns) return;
    const end = task.end;
    if (inboxInputs.get(task.contextId)?.[0]?.taskId === task.taskId)
      inboxInputs.delete(task.contextId);
    if (inboxTasks.get(task.key) === task) inboxTasks.delete(task.key);
    afterMedia(
      task.trace,
      (at) =>
        reporter.endSpan(
          task.trace,
          {
            output:
              end.phase === 'completed' && config.captureContent && task.lastOutput !== undefined
                ? task.lastOutput
                : end.output,
            level: end.level,
            metadata: { taskState: end.phase },
          },
          at,
        ),
      new Date(Math.max(end.at, endedAt.getTime())),
    );
  }

  function endTurn(
    state: SessionTrace,
    update: Parameters<LangfuseReporter['endSpan']>[1] = {},
    endedAt?: Date,
  ): void {
    const task = state.taskKey ? inboxTasks.get(state.taskKey) : undefined;
    if (task && state.lastAssistantText !== undefined) task.lastOutput = state.lastAssistantText;
    afterMedia(
      state.trace,
      (at) => {
        reporter.endSpan(state.trace, update, at);
        if (task) {
          task.openTurns--;
          closeTask(task, at);
        }
      },
      endedAt,
    );
  }

  function suspendTasks(contextId?: string): void {
    for (const task of [...inboxTasks.values()]) {
      if (contextId !== undefined && task.contextId !== contextId) continue;
      task.end ??= {
        phase: 'suspended',
        at: Date.now(),
        output: { state: 'suspended' },
        level: 'DEFAULT',
      };
      closeTask(task);
    }
  }

  function rootSessionId(sessionId: string | undefined): string | undefined {
    while (sessionId && children.has(sessionId))
      sessionId = children.get(sessionId)?.parentSessionId;
    return sessionId;
  }

  function noteError(sessionId: string | undefined): void {
    const id = rootSessionId(sessionId);
    const state = id ? sessions.get(id) : undefined;
    if (state) state.hadErrors = true;
  }

  function closeHooks(sessionId: string, legacyOnly = false): void {
    const pending = openHooks.get(sessionId);
    for (const [key, hook] of pending ?? []) {
      // Per-execution IDs allow results after turn closure without colliding with the next turn.
      if (legacyOnly && hook.persistent) continue;
      const update = { level: 'WARNING' as const, statusMessage: 'hook result not observed' };
      reporter.endSpan(hook.span, update);
      reporter.endSpan(hook.root ?? null, update);
      pending?.delete(key);
    }
    if (pending?.size === 0) openHooks.delete(sessionId);
  }

  /**
   * The trace an observation for `sessionId` belongs to: the session's open
   * turn trace, else a per-session one-off trace shared by that session's
   * out-of-turn calls (between-turn maintenance like compaction, sessions
   * that started before the plugin loaded) so those observations stay in one
   * trace instead of fragmenting per call. The next `turn/start` replaces it.
   * Session-less hand-built calls get one trace each — there is no key to
   * cache under. Subagent child sessions resolve through their parent chain
   * (a tree by construction) to the root trace.
   */
  function traceFor(sessionId: string | undefined): ObservationHandle {
    const id = rootSessionId(sessionId);
    const existing = id ? sessions.get(id) : undefined;
    if (existing) return existing.trace;
    const pending = id ? pendingTurns.get(id) : undefined;
    const turn = pending?.turn;
    if (id && nativeInboxes.has(id)) {
      const selected = inboxInputs.get(id)?.[0];
      const task = selected ? taskTrace(selected) : undefined;
      if (!task || task.end) return null;
      const context = traceContexts.get(id);
      if (context) {
        reporter.updateContext(task.trace, context);
        traceContexts.delete(id);
      }
      const trace = reporter.startSpan(task.trace, {
        name: 'agent:turn',
        metadata: { turn, taskId: task.taskId },
        startTime: pending?.startTime,
      });
      pendingTurns.delete(id);
      if (trace) {
        task.openTurns++;
        sessions.set(id, { trace, hasInput: turn === undefined, turn, taskKey: task.key });
      }
      return trace;
    }
    const trace = openTrace(id, turn === undefined ? undefined : { turn }, pending?.startTime);
    if (id) pendingTurns.delete(id);
    // hasInput starts true: one-offs never take a turn's first-message input.
    if (trace && id) sessions.set(id, { trace, hasInput: turn === undefined, turn });
    return trace;
  }

  /**
   * The observation a generation/span for `sessionId` parents under: the
   * child's own `subagent` span when there is one, else the turn trace.
   */
  function parentFor(sessionId: string | undefined): ObservationHandle {
    const child = sessionId ? children.get(sessionId) : undefined;
    return child?.span ?? traceFor(sessionId);
  }

  ctx.on('a2a/inbox', (event) => {
    try {
      const id = event.contextId;
      nativeInboxes.add(id);
      if (event.phase === 'resolved') return;
      const metadata = {
        taskId: event.taskId,
        taskIds: event.taskIds,
        messageId: event.messageId,
        nativeMessageId: event.nativeMessageId,
        pending: event.pending,
        target: event.target,
        position: event.position,
        agentStatus: event.agentStatus,
        turn: event.turn,
        step: event.step,
      };
      const input = config.captureContent ? event.input : undefined;
      const waitMs =
        event.queuedAt === undefined
          ? undefined
          : Math.max(0, (event.selectedAt ?? event.at) - event.queuedAt);
      const output = {
        state: event.phase,
        target: event.target,
        position: event.position,
        pending: event.pending,
        agentStatus: event.agentStatus,
      };
      if (event.phase === 'selected') {
        const task = taskTrace(event);
        if (task && task.selectedAt === undefined) {
          task.selectedAt = event.selectedAt ?? event.at;
          task.waitMs = waitMs;
        }
        if (task)
          reporter.updateSpan(task.trace, {
            metadata: { taskState: 'running', waitMs: task.waitMs },
          });
        const inputs = inboxInputs.get(id) ?? [];
        if (!inputs.some((input) => input.nativeMessageId === event.nativeMessageId))
          inputs.push(event);
        inboxInputs.set(id, inputs);
        return;
      }
      if (['prepared', 'prepare-failed', 'prepare-aborted'].includes(event.phase)) {
        const parent = parentFor(id);
        const inputs = inboxInputs.get(id) ?? [event];
        const first = inputs[0];
        const turnWaitMs =
          first.queuedAt === undefined
            ? undefined
            : Math.max(0, (first.selectedAt ?? first.at) - first.queuedAt);
        reporter.updateSpan(parent, {
          input: sessions.get(id)?.hasInput ? undefined : input,
          metadata: {
            taskId: event.taskId,
            waitMs: turnWaitMs,
            a2aMessageIds: inputs.map((input) => input.messageId),
            nativeMessageIds: inputs.map((input) => input.nativeMessageId),
          },
        });
        const prepare = reporter.startSpan(parent, {
          name: event.target === 'next-step' ? 'inbox:steering' : 'inbox:prepare',
          input,
          startTime: new Date(event.selectedAt ?? event.at),
          metadata: {
            ...metadata,
            waitMs,
            prepareMs:
              event.selectedAt === undefined ? undefined : Math.max(0, event.at - event.selectedAt),
          },
        });
        reporter.endSpan(
          prepare,
          {
            output,
            level:
              event.phase === 'prepare-failed'
                ? 'ERROR'
                : event.phase === 'prepare-aborted'
                  ? 'WARNING'
                  : 'DEFAULT',
          },
          new Date(event.at),
        );
        return;
      }
      const tasks = event.taskId
        ? [
            ['completed', 'failed', 'canceled'].includes(event.phase)
              ? inboxTasks.get(inboxKey(id, event.taskId))
              : taskTrace(event),
          ].filter((task): task is InboxTaskTrace => !!task)
        : [...inboxTasks.values()].filter(
            (task) =>
              task.contextId === id &&
              !task.end &&
              (event.taskIds === undefined || event.taskIds.includes(task.taskId)),
          );
      for (const task of tasks) {
        if (task.end) continue;
        const details = { ...metadata, taskId: task.taskId };
        const operation = reporter.startSpan(task.trace, {
          name: `inbox:${event.phase}`,
          input,
          startTime: new Date(event.at),
          metadata: details,
        });
        reporter.endSpan(operation, { output }, new Date(event.at));
        const phase = event.phase === 'cleared' ? 'canceled' : event.phase;
        if (['completed', 'failed', 'canceled'].includes(phase)) {
          task.end = {
            phase,
            at: event.at,
            output: { ...output, state: phase },
            level: phase === 'failed' ? 'ERROR' : phase === 'canceled' ? 'WARNING' : 'DEFAULT',
          };
          closeTask(task, new Date(event.at));
        }
      }
      if (event.phase === 'disposed') suspendTasks(id);
      if (event.phase === 'disposed' || event.phase === 'cleared') {
        nativeInboxes.delete(id);
        inboxInputs.delete(id);
      }
    } catch (error) {
      console.error('[dsh-langfuse] inbox reporting failed:', error);
    }
  });

  // ------------------------------------------------------------------
  // Subagent child sessions: session/created precedes both subagent/start
  // and the child's first generation, and the durable header already links
  // child → parent (verified against dsh-subagent@0.1.6-alpha.2).
  // ------------------------------------------------------------------
  ctx.on('session/created', (session) => {
    const parentSessionId: string | undefined = session.header.parentSession;
    if (!parentSessionId) return;
    const childId: string = session.id;
    // Parent under the enclosing delegation tool span when one is open
    // (foreground runs execute inside the parent's tools/execute), else the
    // parent's own subagent span (nested delegation), else the root trace.
    const parentObservation =
      openToolSpans.get(parentSessionId)?.at(-1) ??
      children.get(parentSessionId)?.span ??
      traceFor(parentSessionId);
    const span = reporter.startSpan(parentObservation, {
      name: 'subagent',
      metadata: {
        childSessionId: childId,
        delegationDepth: session.header.delegationDepth,
      },
    });
    children.set(childId, {
      parentSessionId,
      span,
      hasInput: false,
      turnTrace:
        children.get(parentSessionId)?.turnTrace ??
        sessions.get(rootSessionId(parentSessionId) ?? '')?.trace,
    });
  });

  ctx.on('subagent/start', (info) => {
    const child = children.get(info.id);
    if (!child) return; // remote (ACP) runs have no local session — nothing to nest
    reporter.updateSpan(child.span, { metadata: { provider: info.provider, local: info.local } });
  });

  ctx.on('subagent/end', (info) => {
    const child = children.get(info.id);
    if (!child) return;
    if (info.stopReason === 'error') noteError(info.id);
    children.delete(info.id);
    afterMedia(child.span, (endedAt) =>
      reporter.endSpan(
        child.span,
        {
          output: {
            stopReason: info.stopReason,
            ...(config.captureContent ? { lastAssistantMessage: info.lastAssistantMessage } : {}),
          },
          level:
            info.stopReason === 'error'
              ? 'ERROR'
              : info.stopReason === 'aborted'
                ? 'WARNING'
                : 'DEFAULT',
        },
        endedAt,
      ),
    );
  });

  // ------------------------------------------------------------------
  // Turn lifecycle: native tasks keep their root across turns; other sessions
  // open one trace per turn. Subagents stay under their parent's trace.
  // ------------------------------------------------------------------
  ctx.on('session/event', (session, event) => {
    const sessionId: string = session.id;
    const hookEvent: { type: string; data: unknown } = event;
    if (hookEvent.type === 'hook/invoked') {
      const data = hookEvent.data;
      if (!isHookInvoked(data)) return;
      const pending = openHooks.get(sessionId) ?? new Map<string, HookObservation>();
      const key = data.invocationId ? `run:${data.invocationId}` : `handler:${data.handlerId}`;
      if (pending.has(key)) {
        reporter.endSpan(pending.get(key)?.span ?? null, {
          level: 'WARNING',
          statusMessage: 'hook result not observed',
        });
      }
      const previous = pending.get(key);
      if (previous?.root) reporter.endSpan(previous.root, { level: 'WARNING' });
      const child = children.get(sessionId);
      const inTurn = child
        ? child.turn === data.turn
        : (sessions.get(sessionId)?.turn ?? pendingTurns.get(sessionId)?.turn) === data.turn;
      const completed =
        data.invocationId && !inTurn
          ? completedTurns.get(JSON.stringify([sessionId, data.turn]))
          : undefined;
      const root =
        data.invocationId && !inTurn && !completed
          ? // A late hook must not consume context queued for the next turn.
            reporter.openTrace({
              name: config.traceName,
              sessionId,
              metadata: { turn: data.turn, detachedHook: true },
            })
          : undefined;
      const tool = data.callId ? toolCalls.get(sessionId)?.get(data.callId) : undefined;
      const hookName = config.captureContent ? reporter.mask({ name: data.name }).name : undefined;
      const span = reporter.startSpan(
        completed?.parent ??
          (root === undefined
            ? tool?.turn === data.turn
              ? tool.span
              : parentFor(sessionId)
            : root),
        {
          name: `hook:${data.point}${hookName ? `:${hookName}` : ''}`,
          input: config.captureContent ? data.input : undefined,
          metadata: {
            turn: data.turn,
            point: data.point,
            dialect: data.dialect,
            matcher: data.matcher,
            handlerId: data.handlerId,
            ...(data.invocationId ? { invocationId: data.invocationId } : {}),
            ...(data.callId ? { callId: data.callId } : {}),
            ...(config.captureContent && data.name ? { name: data.name } : {}),
          },
        },
      );
      pending.set(key, {
        span,
        root,
        turn: data.turn,
        point: data.point,
        handlerId: data.handlerId,
        persistent: !!data.invocationId,
        callId: data.callId,
        turnTrace: completed
          ? completed.turnTrace
          : root === undefined
            ? (child?.turnTrace ?? sessions.get(sessionId)?.trace)
            : undefined,
      });
      openHooks.set(sessionId, pending);
      return;
    }
    if (hookEvent.type === 'hook/result') {
      const data = hookEvent.data;
      if (!isHookResult(data)) return;
      const pending = openHooks.get(sessionId);
      const key = data.invocationId ? `run:${data.invocationId}` : `handler:${data.handlerId}`;
      const hook = pending?.get(key);
      if (
        !hook ||
        hook.handlerId !== data.handlerId ||
        hook.turn !== data.turn ||
        hook.point !== data.point ||
        (data.callId !== undefined && hook.callId !== data.callId)
      )
        return;
      const span = hook.span;
      const failed = data.outcome
        ? data.outcome === 'failed' || data.outcome === 'timed-out'
        : data.exitCode === undefined || (data.exitCode !== 0 && data.exitCode !== 2);
      const level: ObservationLevel = failed
        ? 'ERROR'
        : data.outcome === 'cancelled' || ['block', 'deny', 'stop'].includes(data.decision)
          ? 'WARNING'
          : 'DEFAULT';
      if (span) {
        const processOutput: Record<string, string> = {};
        const truncation: Record<string, boolean> = {};
        if (config.captureContent) {
          const masked = reporter.mask({
            stdout: data.stdout,
            stderr: data.stderr,
            stderrSummary: data.stderrSummary,
          });
          for (const [field, text] of Object.entries(masked)) {
            if (text === undefined) continue;
            processOutput[field] = text.slice(0, 4096);
            truncation[`${field}Truncated`] = text.length > 4096;
          }
        }
        if (failed && sessions.get(rootSessionId(sessionId) ?? '')?.trace === hook.turnTrace)
          noteError(sessionId);
        reporter.endSpan(span, {
          output: {
            decision: data.decision,
            ...(data.outcome ? { outcome: data.outcome } : {}),
            ...(data.signal ? { signal: data.signal } : {}),
            exitCode: data.exitCode,
            ...(config.captureContent ? { result: data.result, ...processOutput } : {}),
          },
          level,
          metadata: { durationMs: data.durationMs, ...truncation },
        });
      }
      reporter.endSpan(hook.root ?? null, { level });
      pending?.delete(key);
      if (pending?.size === 0) openHooks.delete(sessionId);
      return;
    }
    if (event.type === 'turn/end' || event.type === 'turn/start') toolCalls.delete(sessionId);
    if (event.type === 'turn/end') closeHooks(sessionId, true);
    const child = children.get(sessionId);
    if (child) {
      if (event.type === 'turn/start') child.turn = event.data.turn;
      if (event.type === 'turn/end') {
        rememberTurn(sessionId, event.data.turn, child.span, child.turnTrace ?? null);
        child.turn = undefined;
      }
      // The delegated prompt (the child's first user/message) is the
      // subagent span's input; the descriptor enriches the span name.
      if (event.type === 'user/message' && !child.hasInput && config.captureContent) {
        setMessageInput(child.span, event.data.content);
        child.hasInput = true;
      } else if (event.type === 'subagent/descriptor') {
        // The label is the delegation's model-authored description — content.
        reporter.updateSpan(child.span, {
          name:
            config.captureContent && event.data.label
              ? `subagent: ${event.data.label}`
              : 'subagent',
          metadata: { mode: event.data.mode, provider: event.data.provider },
        });
      }
      return;
    }
    switch (event.type) {
      case 'turn/start': {
        // A leftover entry is either a between-turns one-off trace or a turn
        // whose `turn/end` was never seen (crash-orphaned): end and replace
        // it — v5 spans only export on end, so the stale root must close to
        // keep what it already recorded.
        closeHooks(sessionId, true);
        const stale = sessions.get(sessionId);
        if (stale) endTurn(stale);
        inboxInputs.delete(sessionId);
        if (nativeInboxes.has(sessionId)) {
          sessions.delete(sessionId);
          pendingTurns.set(sessionId, { turn: event.data.turn, startTime: new Date(event.time) });
          break;
        }
        const trace = openTrace(sessionId, { turn: event.data.turn });
        if (trace) sessions.set(sessionId, { trace, hasInput: false, turn: event.data.turn });
        break;
      }
      case 'user/message': {
        const state = sessions.get(sessionId);
        if (state && !state.hasInput && config.captureContent) {
          setMessageInput(state.trace, event.data.content);
          state.hasInput = true;
        }
        break;
      }
      case 'assistant/message': {
        const state = sessions.get(sessionId);
        if (state && config.captureContent) {
          state.lastAssistantText = messageText(event.data.message) ?? state.lastAssistantText;
        }
        break;
      }
      case 'turn/end': {
        if (pendingTurns.has(sessionId)) traceFor(sessionId);
        const state = sessions.get(sessionId);
        if (state) {
          sessions.delete(sessionId);
          rememberTurn(sessionId, event.data.turn, state.trace, state.trace);
          // Native task roots stay open until the A2A terminal signal.
          endTurn(state, {
            output: state.lastAssistantText,
            level:
              event.data.reason.kind === 'error'
                ? 'ERROR'
                : ['aborted', 'blocked', 'max-tokens', 'interrupted'].includes(
                      event.data.reason.kind,
                    )
                  ? 'WARNING'
                  : 'DEFAULT',
            statusMessage:
              event.data.reason.kind === 'error'
                ? contentMessage(config, event.data.reason.error.message)
                : undefined,
            metadata: {
              turn: event.data.turn,
              endReason: event.data.reason.kind,
              ...(state.hadErrors ? { hadErrors: true } : {}),
              ...(event.data.reason.kind === 'error'
                ? { errorCode: event.data.reason.error.code }
                : {}),
            },
          });
        }
        break;
      }
    }
  });

  ctx.on('session/disposed', (session) => {
    const sessionId: string = session.id;
    closeHooks(sessionId);
    const state = sessions.get(sessionId);
    sessions.delete(sessionId);
    traceContexts.delete(sessionId);
    pendingTurns.delete(sessionId);
    nativeInboxes.delete(sessionId);
    inboxInputs.delete(sessionId);
    for (const [key, completed] of completedTurns) {
      if (completed.sessionId === sessionId) completedTurns.delete(key);
    }
    openToolSpans.delete(sessionId);
    toolCalls.delete(sessionId);
    // End an abandoned root (crash-orphaned turn or between-turns one-off
    // trace) — v5 spans only export on end, so dropping it open would lose
    // everything it recorded.
    if (state) endTurn(state);
    suspendTasks(sessionId);
    // Children: keep the entry — background/continuable subagents dispose
    // their session BEFORE subagent/end fires, and the span's close must ride
    // subagent/end (disposing first would either leak the span or close it
    // with a bogus WARNING, the latter seen on a healthy run in a real
    // trace). A crashed run leaves the span open — it never exports.
  });

  // ------------------------------------------------------------------
  // Generation per LLM call. The waterfall is SYNCHRONOUS (cordis returns
  // the outermost listener's return value as the stream), so the listener
  // must not be async — it returns an async-generator tee instead.
  // ------------------------------------------------------------------
  ctx.on('llm/stream', (options, next) => {
    const parent = parentFor(options.sessionId);
    // A session-less call's trace root has no session lifecycle to close it
    // (it is never cached in `sessions`), so it rides this call's: un-ended
    // spans never export in v5 — end it when the call settles.
    const oneOffRoot = options.sessionId ? null : parent;
    const generationName = options.purpose ? `llm-call [${options.purpose}]` : 'llm-call';
    const modelParameters = modelParametersOf(options, config.captureContent);
    const input = requestBodyOf(options, config.captureContent);
    const generation = reporter.startGeneration(parent, {
      name: generationName,
      model: options.model,
      input,
      modelParameters,
      metadata: { purpose: options.purpose },
    });
    if (
      generation &&
      config.captureContent &&
      options.messages.some((message) => message.content.some((block) => block.type === 'image'))
    ) {
      const budget = { remaining: mediaOptions.maxBytes };
      enrichInput(
        generation,
        Promise.all(
          options.messages.map(async (message) => ({
            ...message,
            content: await displayBlocks(
              message.content,
              ctx.get('attachments'),
              mediaOptions,
              options.signal,
              budget,
            ),
          })),
        ).then((messages) => ({ ...input, messages })),
      );
    }

    // The rawest request a plugin can observe: the loop-built GenerateOptions
    // verbatim, pre-adapter (the provider HTTP body is assembled inside the
    // adapter — dsh exposes no seam for it). Nested under the generation,
    // closed alongside it with the same outcome; its output is the collected
    // chunk stream (the raw response at this seam).
    const requestSpan = reporter.startSpan(generation, {
      name: 'llm-request',
      input,
      metadata: { provider: options.provider },
    });
    const rawChunks: StreamChunk[] = [];
    let chunkCount = 0;
    let toolCallCount = 0;

    let text = '';
    let reasoning = '';
    const toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    let usage: TokenUsage | undefined;
    let finish: FinishReason | undefined;
    let completionStartTime: Date | undefined;
    let thrownMessage: string | undefined;
    const outputBody = () =>
      config.captureContent
        ? toolCalls.length > 0 || reasoning
          ? {
              role: 'assistant',
              ...(text ? { content: text } : {}),
              ...(reasoning ? { thinking: [{ type: 'thinking', content: reasoning }] } : {}),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            }
          : text || undefined
        : undefined;
    let closed = false;
    const closeCall = () => {
      if (closed) return;
      closed = true;
      const endedAt = new Date();
      openOperations.delete(closeCall);
      const failure =
        finish && (finish.kind === 'error' || finish.kind === 'aborted') ? finish : undefined;
      // No terminal finish chunk (the consumer abandoned the stream or
      // the adapter cut it short): the call's outcome is unknown — mark
      // it instead of posing as a normal completion.
      let level: ObservationLevel = 'DEFAULT';
      let statusMessage: string | undefined;
      if (thrownMessage !== undefined) {
        level = 'ERROR';
        statusMessage = contentMessage(config, thrownMessage);
      } else if (failure) {
        level = failure.kind === 'aborted' ? 'WARNING' : 'ERROR';
        // `failure` is contractually required on error/aborted finishes,
        // but a non-conformant adapter must never turn observability into
        // a generator-level TypeError escaping into the agent loop.
        statusMessage = contentMessage(config, failure.failure?.message ?? 'unknown failure');
      } else if (!finish) {
        level = 'WARNING';
        statusMessage = 'stream closed before the terminal finish chunk';
      }
      reporter.endSpan(
        requestSpan,
        {
          output: config.captureContent ? redactChunks(rawChunks, reporter) : undefined,
          level,
          statusMessage,
          metadata: { chunkCount },
        },
        endedAt,
      );
      if (level === 'ERROR') noteError(options.sessionId);
      // Partial progress counts on every path: whatever streamed is kept.
      afterMedia(
        generation,
        (endedAt) =>
          reporter.endGeneration(
            generation,
            {
              name: config.captureContent
                ? enhanceWithFirstLine(generationName, reporter.mask(text))
                : undefined,
              output: outputBody(),
              usage,
              completionStartTime,
              level,
              statusMessage,
              metadata: {
                finishReason: finish?.kind,
                errorCode: failure?.failure?.code,
                incomplete: finish ? undefined : true,
                toolCallCount: toolCallCount > 0 ? toolCallCount : undefined,
              },
            },
            endedAt,
          ),
        endedAt,
      );
      reporter.endSpan(oneOffRoot, {}, endedAt);
    };
    openOperations.add(closeCall);
    let stream: AsyncIterable<StreamChunk>;
    try {
      stream = next();
    } catch (error) {
      thrownMessage = messageOf(error);
      closeCall();
      throw error;
    }

    // Replay unchanged; unload can finish the observation before this iterator settles.
    return (async function* () {
      try {
        for await (const chunk of stream) {
          if (closed) {
            yield chunk;
            continue;
          }
          chunkCount += 1;
          if (config.captureContent) rawChunks.push(chunk);
          // TTFT is the first real token — block boundaries, usage frames and
          // empty heartbeat deltas are not completions (the predicate above).
          if (completionStartTime === undefined && isTokenDelta(chunk)) {
            completionStartTime = new Date();
          }
          switch (chunk.type) {
            case 'text-delta':
              if (config.captureContent) text += chunk.text;
              break;
            case 'reasoning-delta':
              if (config.captureContent) reasoning += chunk.text;
              break;
            case 'block-end':
              if (chunk.block.type === 'tool-call') {
                toolCallCount += 1;
                if (config.captureContent)
                  toolCalls.push({
                    id: chunk.block.id,
                    type: 'function',
                    function: { name: chunk.block.name, arguments: chunk.block.arguments },
                  });
              }
              break;
            case 'usage':
              usage = chunk.usage;
              break;
            case 'finish':
              finish = chunk.reason;
              break;
          }
          yield chunk;
        }
      } catch (error) {
        // The raw message stays local — redaction gates what crosses to
        // Langfuse, and `undefined` (not an empty string) is the no-throw
        // discriminator.
        thrownMessage = messageOf(error);
        throw error;
      } finally {
        closeCall();
      }
    })();
  });

  // ------------------------------------------------------------------
  // Span per tool pipeline, including pre/post hooks and denied calls.
  // Open spans are tracked per session
  // so a subagent span opened mid-dispatch (foreground delegation) parents
  // under the enclosing tool span.
  // ------------------------------------------------------------------
  ctx.on(
    'tools/pre-execute',
    (exec, next) => {
      const sessionId = exec.agent?.id;
      const parent = parentFor(sessionId);
      // An agent-less dispatch's trace root has no session lifecycle to close
      // it — it rides this dispatch's (same one-off rule as llm/stream).
      const oneOffRoot = sessionId ? null : parent;
      // Argument summaries are argument content — they ride captureContent.
      const args = config.captureContent ? reporter.mask(exec.arguments) : undefined;
      const argSummary = config.captureContent ? toolCallSummary(args) : undefined;
      const span = reporter.startSpan(parent, {
        name: `tool:${exec.name}${argSummary ? ` [${argSummary}]` : ''}`,
        asType: 'tool',
        input: args,
        metadata: { callId: exec.callId, toolName: exec.name },
      });
      if (sessionId && span) {
        openToolSpans.set(sessionId, [...(openToolSpans.get(sessionId) ?? []), span]);
        const calls = toolCalls.get(sessionId) ?? new Map();
        calls.set(exec.callId, {
          span,
          turn: children.get(sessionId)?.turn ?? sessions.get(sessionId)?.turn,
        });
        toolCalls.set(sessionId, calls);
      }
      let closed = false;
      const closeTool = () =>
        finishTool({ level: 'WARNING', statusMessage: 'plugin unloaded during tool call' });
      function finishTool(
        update: NonNullable<Parameters<LangfuseReporter['endSpan']>[1]>,
        display?: Promise<unknown>,
      ): void {
        if (closed) return;
        closed = true;
        const endedAt = new Date();
        openOperations.delete(closeTool);
        toolResults.delete(exec);
        if (sessionId && toolCalls.get(sessionId)?.get(exec.callId)?.span === span) {
          const calls = toolCalls.get(sessionId)!;
          calls.delete(exec.callId);
          if (!calls.size) toolCalls.delete(sessionId);
        }
        if (sessionId && span) {
          const remaining = (openToolSpans.get(sessionId) ?? []).filter((s) => s !== span);
          if (remaining.length) openToolSpans.set(sessionId, remaining);
          else openToolSpans.delete(sessionId);
        }
        const end = (output = update.output) => {
          reporter.endSpan(span, { ...update, output }, endedAt);
          reporter.endSpan(oneOffRoot, {}, endedAt);
        };
        if (display)
          trackMedia(
            display.then(end).catch((error) => {
              console.error('[dsh-langfuse] media projection failed:', error);
              end();
            }),
          );
        else end();
      }
      openOperations.add(closeTool);
      toolResults.set(exec, (result) => {
        if (closed) return;
        if (result.isError) noteError(sessionId);
        const update = {
          output: config.captureContent ? result.content : undefined,
          level: (result.isError ? 'ERROR' : 'DEFAULT') as ObservationLevel,
          statusMessage: result.isError ? contentMessage(config, result.error.message) : undefined,
          metadata: { errorCode: result.isError ? result.error.info?.code : undefined },
        };
        if (
          span &&
          config.captureContent &&
          result.content.some((block) => block.type === 'image')
        ) {
          finishTool(
            update,
            displayBlocks(result.content, ctx.get('attachments'), mediaOptions, exec.signal),
          );
        } else finishTool(update);
      });
      return next();
    },
    { prepend: true },
  );

  ctx.on('tools/result', (exec, result) => {
    toolResults.get(exec)?.(result);
  });

  // Durability checkpoint: the store awaits every session/flush listener.
  ctx.on('session/flush', async () => {
    await drainMedia();
    await reporter.flush();
  });

  // Lifecycle: this cordis fork has no ready/dispose events — cleanup rides
  // the fiber unload via ctx.effect() (shutdown() chains behind the lazy
  // import, so a still-importing SDK is never shut down mid-construction).
  ctx.effect(() => {
    return async () => {
      const endedAt = new Date();
      for (const close of openOperations) close();
      for (const sessionId of openHooks.keys()) closeHooks(sessionId);
      await drainMedia();
      // End every tracked observation still open before shutting the exporter
      // down — v5 spans only export on end, so unloading mid-turn (profile
      // reload) would otherwise silently drop them.
      for (const state of sessions.values()) endTurn(state, {}, endedAt);
      suspendTasks();
      await drainMedia();
      for (const child of children.values()) reporter.endSpan(child.span, {}, endedAt);
      sessions.clear();
      pendingTurns.clear();
      nativeInboxes.clear();
      inboxInputs.clear();
      inboxTasks.clear();
      completedTurns.clear();
      traceContexts.clear();
      children.clear();
      openToolSpans.clear();
      toolCalls.clear();
      await reporter.shutdown();
    };
  });

  // Returning the init promise folds the lazy SDK import into this fiber's
  // load transition: cordis awaits a plugin callback's thenable, so a boot
  // that awaits plugin readiness can never observe the import window.
  return reporter.ready;
}
