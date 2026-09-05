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
import Schema from '@deepseek-ai/schemastery';
import { DatabaseBackend, type DatabaseProvider } from './backends/database.js';
import { projectEvent, usageSampleOf } from './projector.js';
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
   * The latest usage sample with its step key — replacement accounting. dsh
   * emits a step's usage samples adjacently (chunks, then the message), so
   * only the most recent sample needs keeping to dedup the chunk↔message
   * pair and progressive samples; it is also all a resume needs to avoid
   * double-counting the in-flight step. Persisted in the row's metadata as
   * `dsh-storage:lastUsage` (namespaced — other writers' fields survive).
   */
  usageSample?: { key: string; input: number; output: number };
}

/** Metadata key for our usage bookkeeping — namespaced so other writers' fields never collide with it. */
const LAST_USAGE_KEY = 'dsh-storage:lastUsage';

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
  // @deepseek-ai/dsh-session@0.1.2-rc.1: session/event(session, event),
  // session/disposed(session), and the awaited session/flush(session)
  // durability checkpoint. The cast stays because the dsh-session types that
  // declare these event names are not installed.
  const on = ctx.on.bind(ctx) as (name: string, handler: (...args: any[]) => unknown) => void;
  if (!config.enabled || !config.database.enabled || !config.database.url) return;

  const backends: StorageBackend[] = [
    new DatabaseBackend({
      provider: config.database.provider,
      url: config.database.url,
    }),
  ];

  const sessions = new Map<string, SessionAccum>();

  // Row writes are fire-and-forget during the run, but tracked so the
  // session/flush checkpoint and shutdown can drain them — a one-shot
  // (headless) run would otherwise lose the tail events to process exit.
  const pending = new Set<Promise<void>>();

  function track(task: Promise<void>): Promise<void> {
    pending.add(task);
    void task.finally(() => pending.delete(task));
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

  // Backend init starts at plugin load; every write chains behind it so no
  // row is lost to a still-connecting backend.
  let started: Promise<void>;

  function fanout(call: (backend: StorageBackend) => Promise<void>): Promise<void> {
    return track(started.then(() => guard(call)));
  }

  // Per-session serialization: all event processing for one session runs
  // through a promise chain, so rollup writes complete in event order
  // (latest-wins — concurrent absolute snapshots must not land out of order)
  // and the first event of an unknown session seeds its accumulator from the
  // stored row before any write (resume: constructor seeds are not re-emitted,
  // so history must come from the database, not from zero).
  const chains = new Map<string, Promise<void>>();

  function enqueue(sessionId: string, task: () => Promise<void>): void {
    // First task of a session also chains behind backend init, so seedAccum
    // never reads from a still-connecting backend (prisma === null would
    // masquerade as "row not found" and zero-seed over the stored rollup).
    const next = (chains.get(sessionId) ?? started)
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
            metadata: { ...(row.metadata ?? {}) },
            usageSample: usageSampleOfMetadata(row.metadata?.[LAST_USAGE_KEY]),
          };
        }
      } catch (error) {
        readFailure ??= error;
        console.error(`[dsh-storage] ${backend.name} error:`, error);
      }
    }
    if (readFailure) throw readFailure;
    return { messageCount: 0, totalTokens: 0, metadata: {} };
  }

  ctx.effect(() => {
    started = track(guard(async (backend) => backend.init?.()));
    return async () => {
      sessions.clear();
      await Promise.all([...pending]);
      await guard(async (backend) => backend.close?.());
    };
  });

  /* eslint-disable @typescript-eslint/no-explicit-any */
  on('session/event', (session: any, event: any) => {
    const sessionId: string = session?.id ?? 'unknown';
    enqueue(sessionId, async () => {
      let accum = sessions.get(sessionId);
      if (!accum) {
        accum = await seedAccum(sessionId);
        sessions.set(sessionId, accum);
      }

      const row: MessageRow | null = projectEvent(session, event, sessionId);
      if (row) {
        accum.messageCount += 1;
        accum.firstMessageAt ??= row.createdAt;
        accum.lastMessageAt = row.createdAt;
        await fanout((backend) => backend.upsertMessage(row));
      }

      // Replacement usage accounting: the latest sample for a (turn, step)
      // supersedes the previous one — fold only the delta, so the
      // chunk↔message pair and progressive samples never double-count, and a
      // failed step (usage chunk, no message) still counts. Samples of one
      // step arrive adjacently, so a single latest sample is all we track.
      const sampled = usageSampleOf(event);
      let usageDelta = 0;
      if (sampled) {
        const prev = accum.usageSample;
        usageDelta =
          sampled.sample.input +
          sampled.sample.output -
          (prev && prev.key === sampled.key ? prev.input + prev.output : 0);
        if (!prev || prev.key !== sampled.key || usageDelta !== 0) {
          accum.usageSample = { key: sampled.key, ...sampled.sample };
          accum.totalTokens += usageDelta;
        }
      }

      // Latest-wins title snapshot (log-only `session/title` event; payload
      // { title, messageSeqs, source } verified against dsh-session-title@0.1.2-rc.1).
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
        await fanout((backend) => backend.upsertSession(sessionRow));
      }
    });
  });

  on('session/disposed', (session: any) => {
    const sessionId: string = session?.id ?? 'unknown';
    // The delete must run inside the session's chain — a synchronous delete
    // here races the queued event tasks (the map may not even have the entry
    // yet at emit time, and queued tasks would keep growing the accumulator
    // the dispose was meant to drop).
    enqueue(sessionId, async () => {
      sessions.delete(sessionId);
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

  // Durability checkpoint: the store awaits every session/flush listener.
  on('session/flush', async () => {
    await Promise.all([...pending]);
  });
}
