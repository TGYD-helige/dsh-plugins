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
import { projectEvent, usageOf } from './projector.js';
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
}

export function apply(ctx: Context, config: StoragePluginConfig): void {
  // Lifecycle: this cordis fork has no 'ready'/'dispose' events — startup
  // work goes in ctx.effect() (runs immediately at plugin load; the returned
  // disposer runs on fiber unload at shutdown). Event taps verified against
  // @deepseek-ai/dsh-session@0.1.0-rc.7: session/event(session, event),
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
    const accum = sessions.get(sessionId) ?? { messageCount: 0, totalTokens: 0 };
    sessions.set(sessionId, accum);

    const row: MessageRow | null = projectEvent(session, event, sessionId);
    if (row) {
      accum.messageCount += 1;
      accum.firstMessageAt ??= row.createdAt;
      accum.lastMessageAt = row.createdAt;
      void fanout((backend) => backend.upsertMessage(row));
    }

    const usage = usageOf(event);
    accum.totalTokens += usage.input + usage.output;

    // Latest-wins title snapshot (log-only `session/title` event; payload
    // { title, messageSeqs, source } verified against dsh-session-title@0.1.0-rc.7).
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') {
      accum.title = event.data.title;
    }

    if (
      row ||
      usage.input + usage.output > 0 ||
      event?.type === 'turn/end' ||
      event?.type === 'session/title'
    ) {
      const sessionRow: SessionRow = {
        sessionId,
        title: accum.title ?? null,
        messageCount: accum.messageCount,
        totalTokens: accum.totalTokens,
        firstMessageAt: accum.firstMessageAt ?? null,
        lastMessageAt: accum.lastMessageAt ?? null,
      };
      void fanout((backend) => backend.upsertSession(sessionRow));
    }
  });

  on('session/disposed', (session: any) => {
    sessions.delete(session?.id ?? 'unknown');
  });

  // Durability checkpoint: the store awaits every session/flush listener.
  on('session/flush', async () => {
    await Promise.all([...pending]);
  });
}
