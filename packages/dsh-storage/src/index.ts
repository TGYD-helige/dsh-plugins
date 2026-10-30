/**
 * dsh-storage — mirrors the dsh session event stream into the ai_messages /
 * ai_chat_histories tables (MySQL/PostgreSQL/SQLite/SQL Server).
 *
 * Design: dsh's own session persistence (JSONL/SQLite) stays authoritative.
 * This plugin taps `session/event` (the same seam the built-in persistence
 * coordinator uses) and projects events into MessageRow / SessionRow shaped
 * after the source project's ai_messages / ai_chat_histories tables.
 *
 * A2A task state (task metadata in Redis, workspace archives in GCS) is NOT
 * here — that belongs to the A2A layer, see dsh-a2a's TaskStore backends.
 *
 * Resume caveat (docs/subsystems/persistence.md): constructor seeds do not
 * emit events. On agent resume, only events >= `session.firstLiveSeq` fire
 * on this stream — historical rows must come from the database itself, not
 * from replaying the tap.
 *
 * @module dsh-storage
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-session';
import Schema from '@deepseek-ai/schemastery';
import { DatabaseBackend, type DatabaseProvider } from './backends/database.js';
import { compressionSnapshot } from './compaction.js';
import { mergeToolResult, projectEvent, toolResultCallId, usageSampleOf } from './projector.js';
import type { MessageRow, SessionRow, StorageBackend } from './types.js';

export const name = 'dsh-storage';

// Event-tap only: no hard service dependency. Add 'sessionPersistence' to
// `inject` if you want fail-fast when persistence is not composed.
export const inject = [] as string[];

export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  database: Schema.object({
    enabled: Schema.boolean().default(false),
    provider: Schema.union(['mysql', 'postgresql', 'sqlite', 'sqlserver'] as const).default(
      'sqlite',
    ),
    url: Schema.string().role('secret').default(''),
  }),
});

export interface StoragePluginConfig {
  enabled: boolean;
  database: { enabled: boolean; provider: DatabaseProvider; url: string };
}

/** Explicit write API for a consumer's session-clear flow. */
export interface DshStorageService {
  archiveSession(sessionId: string): Promise<string | null>;
}

/** Per-session live rollup used to maintain the session row. */
interface SessionAccum {
  messageCount: number;
  totalTokens: number;
  title?: string;
  firstMessageAt?: Date;
  lastMessageAt?: Date;
  /** Existing history-row metadata, preserved verbatim across our writes. */
  metadata: Record<string, unknown>;
  /**
   * The highest committed usage event sequence and its sample. Session event
   * sequences are ordered, so this bounded high-water mark rejects redelivery
   * without retaining every seen ID; different attempts on one step still add.
   * Persisted in the row's metadata as `dsh-storage:lastUsage` (namespaced —
   * other writers' fields survive).
   */
  usageSample?: { key: string; input: number; output: number };
}

/** Metadata key for our usage bookkeeping — namespaced so other writers' fields never collide with it. */
const LAST_USAGE_KEY = 'dsh-storage:lastUsage';
const TOKEN_BASELINE_KEY = 'dsh-storage:token-baseline';
const ARCHIVE_IN_PROGRESS = 'dsh-storage:archive-in-progress';

/** Shape-guarded restore of our usage sample from arbitrary metadata. */
function usageSampleOfMetadata(value: unknown): SessionAccum['usageSample'] {
  const v = value as { key?: unknown; input?: unknown; output?: unknown } | null;
  return v &&
    typeof v.key === 'string' &&
    typeof v.input === 'number' &&
    typeof v.output === 'number'
    ? { key: v.key, input: v.input, output: v.output }
    : undefined;
}

export function apply(ctx: Context, config: StoragePluginConfig): void {
  // Lifecycle: this cordis fork has no 'ready'/'dispose' events — startup
  // work goes in ctx.effect() (runs immediately at plugin load; the returned
  // disposer runs on fiber unload at shutdown). Event taps verified against
  // @deepseek-ai/dsh-session@0.1.6-alpha.2: session/event(session, event),
  // session/disposed(session), and the awaited session/flush(session)
  // durability checkpoint. The type-only import above registers the event
  // names; handler params stay `any` because storage also mirrors
  // plugin-owned event types (e.g. session/title) it does not depend on.
  if (!config.enabled || !config.database.enabled || !config.database.url) return;

  const backends: StorageBackend[] = [
    new DatabaseBackend({
      provider: config.database.provider,
      url: config.database.url,
    }),
  ];

  const sessions = new Map<string, SessionAccum>();
  const toolCallMessages = new Map<string, Map<string, string>>();
  const TOOL_CALL_CACHE_LIMIT = 1000;

  function rememberToolCalls(sessionId: string, row: MessageRow | null): void {
    if (row?.type !== 'model' || !Array.isArray(row.toolCalls)) return;
    for (const call of row.toolCalls) {
      if (typeof call?.id !== 'string') continue;
      const calls = toolCallMessages.get(sessionId) ?? new Map<string, string>();
      // Bound each session's cache; Map iteration evicts the oldest insertion first.
      if (!calls.has(call.id) && calls.size >= TOOL_CALL_CACHE_LIMIT) {
        const oldest = calls.keys().next().value;
        if (oldest !== undefined) calls.delete(oldest);
      }
      calls.set(call.id, row.id);
      toolCallMessages.set(sessionId, calls);
    }
  }

  async function readToolResultRows(
    session: any,
    sessionId: string,
    event: any,
  ): Promise<MessageRow[]> {
    const callId = toolResultCallId(event);
    if (!callId) return [];
    let messageId = toolCallMessages.get(sessionId)?.get(callId);
    if (!messageId && typeof session?.deriveMessages === 'function') {
      const messages = session.deriveMessages();
      for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index];
        if (
          message.role === 'assistant' &&
          typeof message.id === 'string' &&
          Array.isArray(message.content) &&
          message.content.some((block: any) => block?.type === 'tool-call' && block.id === callId)
        ) {
          messageId = message.id;
          break;
        }
      }
    }
    if (messageId) {
      const rows = await backends[0].readMessages(sessionId, messageId);
      if (
        rows.some(
          (row) =>
            Array.isArray(row.toolCalls) && row.toolCalls.some((call) => call?.id === callId),
        )
      )
        return rows;
    }
    // Cold resume and eviction fall back to bounded database candidate pages.
    const rows = await backends[0].readToolCallMessages(sessionId, callId);
    for (const row of rows) rememberToolCalls(sessionId, row);
    return rows;
  }

  // Row writes are fire-and-forget during the run, but tracked so the
  // session/flush checkpoint and shutdown can drain them — a one-shot
  // (headless) run would otherwise lose the tail events to process exit.
  const pending = new Set<Promise<void>>();

  function track(task: Promise<void>): Promise<void> {
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }

  function guard(call: (backend: StorageBackend) => Promise<void>): Promise<void> {
    // Mirroring must never break the agent loop: log and swallow.
    return Promise.all(
      backends.map((backend) =>
        call(backend).catch((error) =>
          console.error(`[dsh-storage] ${backend.name} error:`, error),
        ),
      ),
    ).then(() => {});
  }

  // All sessions share one in-flight init. A failed attempt is cleared so the
  // next event can retry once; no read or write passes a failed init barrier.
  let started: Promise<void> | undefined;

  function ensureStarted(): Promise<void> {
    if (!started) {
      const attempt = track(
        Promise.all(backends.map((backend) => backend.init?.())).then(() => {}),
      );
      started = attempt;
      void attempt.catch(() => {
        if (started === attempt) started = undefined;
      });
    }
    return started;
  }

  function fanout(call: (backend: StorageBackend) => Promise<void>): Promise<void> {
    // Event failures reject into the per-session queue, which is the no-throw
    // boundary. Swallowing here would make a partial write look committed.
    return track(ensureStarted().then(() => Promise.all(backends.map(call)).then(() => {})));
  }

  // Per-session serialization: all event processing for one session runs
  // through a promise chain, so rollup writes complete in event order
  // (latest-wins — concurrent absolute snapshots must not land out of order)
  // and the first event of an unknown session seeds its accumulator from the
  // stored row before any write (resume: constructor seeds are not re-emitted,
  // so history must come from the database, not from zero).
  const chains = new Map<string, Promise<void>>();

  function enqueue(sessionId: string, task: () => Promise<void>): void {
    // Every task rechecks the init barrier: a failed earlier attempt must not
    // become a resolved chain that lets later events zero-seed or no-op write.
    const next = (chains.get(sessionId) ?? Promise.resolve())
      .then(() => ensureStarted())
      .then(task)
      .catch((error) => console.error('[dsh-storage] mirror task error:', error));
    chains.set(sessionId, next);
    track(next);
  }

  async function seedAccum(sessionId: string): Promise<SessionAccum> {
    // "Row not found" (a new session) is the only zero-seed case. A read
    // failure is NOT "not found": fail the task so the next event re-seeds,
    // instead of accumulating from zero and overwriting the stored rollup.
    let readFailure: unknown;
    for (const backend of backends) {
      try {
        const row = await backend.readSession?.(sessionId);
        if (row) {
          return {
            messageCount: row.messageCount,
            totalTokens: row.totalTokens,
            title: row.title ?? undefined,
            firstMessageAt: row.firstMessageAt ?? undefined,
            lastMessageAt: row.lastMessageAt ?? undefined,
            // Preserve every existing metadata field; we only own our key.
            // The baseline distinguishes cumulative active totals from a
            // restart's fresh-segment deltas during archive recovery.
            metadata: { [TOKEN_BASELINE_KEY]: row.totalTokens, ...(row.metadata ?? {}) },
            usageSample: usageSampleOfMetadata(row.metadata?.[LAST_USAGE_KEY]),
          };
        }
      } catch (error) {
        readFailure ??= error;
        console.error(`[dsh-storage] ${backend.name} error:`, error);
      }
    }
    if (readFailure) throw readFailure;
    return { messageCount: 0, totalTokens: 0, metadata: { [TOKEN_BASELINE_KEY]: 0 } };
  }

  ctx.effect(() => {
    void ensureStarted().catch((error) => console.error('[dsh-storage] database error:', error));
    return async () => {
      sessions.clear();
      toolCallMessages.clear();
      await Promise.allSettled([...pending]);
      await guard(async (backend) => backend.close?.());
    };
  });

  ctx.provide('dshStorage', {
    archiveSession(sessionId: string): Promise<string | null> {
      // Join the same per-session chain as event writes, then discard the old
      // in-memory rollup only after the database transaction commits.
      const archived = (chains.get(sessionId) ?? Promise.resolve())
        .then(() => ensureStarted())
        .then(async () => {
          const accum = sessions.get(sessionId);
          if (accum && !accum.metadata[ARCHIVE_IN_PROGRESS]) {
            // Freeze inside the session queue: all earlier events have now
            // committed, and this first baseline survives every retry until
            // the archive actually succeeds.
            accum.metadata[TOKEN_BASELINE_KEY] = accum.totalTokens;
            accum.metadata[ARCHIVE_IN_PROGRESS] = true;
          }
          const id = await backends[0].archiveSession(sessionId);
          sessions.delete(sessionId);
          toolCallMessages.delete(sessionId);
          return id;
        });
      const settled = archived.then(
        () => {},
        () => {},
      );
      chains.set(sessionId, settled);
      track(settled);
      return archived;
    },
  } satisfies DshStorageService);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  ctx.on('session/event', (session: any, event: any) => {
    const sessionId: string = session?.id ?? 'unknown';
    let snapshot: MessageRow | null;
    try {
      // Capture the committed surface now; queued writes must not observe later steps.
      snapshot = compressionSnapshot(session, event);
    } catch (error) {
      console.error('[dsh-storage] compaction snapshot error:', error);
      return;
    }
    enqueue(sessionId, async () => {
      if (snapshot) {
        await fanout((backend) => backend.upsertMessage(snapshot));
        return;
      }
      const stored = sessions.get(sessionId) ?? (await seedAccum(sessionId));
      sessions.set(sessionId, stored);
      // Stage every change on a copy. The live accumulator advances only
      // after the message + rollup transaction commits.
      const accum: SessionAccum = { ...stored, metadata: { ...stored.metadata } };

      let row: MessageRow | null = projectEvent(session, event, sessionId);
      if (row && session.header?.createdAt !== undefined) {
        row.metadata = { ...row.metadata, sessionCreatedAt: session.header.createdAt };
      }
      const storedRows =
        event?.type === 'tool/result'
          ? await readToolResultRows(session, sessionId, event)
          : row
            ? await backends[0].readMessages(sessionId, row.id)
            : [];
      if (event?.type === 'tool/result') row = mergeToolResult(event, storedRows);
      const existing = row && storedRows.find((stored) => stored.id === row?.id);
      if (event?.type === 'assistant/message' && row && existing && Array.isArray(row.toolCalls)) {
        row.toolCalls = row.toolCalls.map((call: any) => {
          const previous = Array.isArray(existing.toolCalls)
            ? existing.toolCalls.find((stored: any) => stored?.id === call?.id)
            : undefined;
          return previous && 'result' in previous
            ? {
                ...call,
                result: previous.result,
                ...(previous.error ? { error: previous.error } : {}),
              }
            : call;
        });
      }
      if (!row && event?.type === 'tool/result') {
        console.error('[dsh-storage] no matching model tool call for result');
      }
      if (row && !existing && event?.type !== 'tool/result') {
        accum.messageCount += 1;
        accum.firstMessageAt ??= row.createdAt;
        accum.lastMessageAt = row.createdAt;
      }

      // Every settled attempt/message is one model call; retries on the same
      // step are additive rather than replacement snapshots.
      const sampled = usageSampleOf(event);
      let usageDelta = 0;
      if (sampled) {
        const sequence = Number(sampled.key);
        const previous = Number(accum.usageSample?.key);
        const duplicate =
          Number.isSafeInteger(sequence) && Number.isSafeInteger(previous) && sequence <= previous;
        if (!duplicate) {
          usageDelta = sampled.sample.input + sampled.sample.output;
          accum.usageSample = { key: sampled.key, ...sampled.sample };
          accum.totalTokens += usageDelta;
        }
      }

      // Latest-wins title snapshot (log-only `session/title` event; payload
      // { title, messageSeqs, source } verified against dsh-session-title@0.1.6-alpha.2).
      if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
        accum.title = event.data.title;
      }

      if (
        row ||
        usageDelta !== 0 ||
        event?.type === 'turn/end' ||
        event?.type === 'session/title'
      ) {
        // Merge our bookkeeping into the existing metadata instead of
        // replacing the column — other fields (present or future) survive.
        const metadata = {
          ...accum.metadata,
          ...(accum.usageSample ? { [LAST_USAGE_KEY]: accum.usageSample } : {}),
        };
        const sessionRow: SessionRow = {
          sessionId,
          title: accum.title ?? null,
          messageCount: accum.messageCount,
          totalTokens: accum.totalTokens,
          firstMessageAt: accum.firstMessageAt ?? null,
          lastMessageAt: accum.lastMessageAt ?? null,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        };
        await fanout((backend) => backend.upsertEvent(row, sessionRow));
      }
      sessions.set(sessionId, accum);
      rememberToolCalls(sessionId, row);
    });
  });

  ctx.on('session/disposed', (session: any) => {
    const sessionId: string = session?.id ?? 'unknown';
    // The delete must run inside the session's chain — a synchronous delete
    // here races the queued event tasks (the map may not even have the entry
    // yet at emit time, and queued tasks would keep growing the accumulator
    // the dispose was meant to drop).
    enqueue(sessionId, async () => {
      sessions.delete(sessionId);
      toolCallMessages.delete(sessionId);
    });
    // Delete the chain entry only once it has settled AND is still the same
    // entry — deleting earlier would let a recreated session race the
    // orphaned writes; skipping the delete when a new task has since chained
    // on preserves order.
    const chain = chains.get(sessionId);
    chain?.finally(() => {
      if (chains.get(sessionId) === chain) chains.delete(sessionId);
    });
  });

  // Durability checkpoint: wait only for this session. Shutdown still drains
  // the global pending set; an unrelated slow session must not block this one.
  ctx.on('session/flush', async (session: any) => {
    const chain = chains.get(session?.id ?? 'unknown');
    if (chain) {
      await chain;
      return;
    }
    try {
      await ensureStarted();
    } catch (error) {
      console.error('[dsh-storage] database error:', error);
    }
  });
}
