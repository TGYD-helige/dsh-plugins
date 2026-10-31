import { setTimeout } from 'node:timers/promises';
import type { Context, Events } from '@deepseek-ai/cordis';
import type { UserMessage } from '@deepseek-ai/dsh-llm/types';
import type { Session } from '@deepseek-ai/dsh-session';
import type {} from './index.js';

export interface CommittedMessageNotification {
  contextId: string;
  messageId: string;
  taskId: string;
  requestHeaders: unknown;
  source: UserMessage['source'];
}
export interface InboxChangeNotification {
  contextId: string;
  version: number;
}
/** Return false or throw on delivery failure. Honor signal, including request timeouts. */
export type NotificationSender<T> = (detail: T, signal: AbortSignal) => Promise<boolean>;
export interface NotificationOptions {
  message?: NotificationSender<CommittedMessageNotification>;
  inbox?: NotificationSender<InboxChangeNotification>;
}

/** Opt in on a plugin-scoped Context; unloading that fiber cancels all work. */
export function installNotifications(ctx: Context, options: NotificationOptions): void {
  if (!options.message && !options.inbox) return;
  type Admission = Parameters<Events['a2a/message-admitted']>[0];
  type PendingMessage = Admission & { committedSeq?: number };
  const pending = new Map<string, Map<string, PendingMessage>>();
  const committed = new Map<string, number>();
  const active = { message: new Set<AbortSignal>(), inbox: new Set<AbortSignal>() };
  const waiting: Array<{
    signal: AbortSignal;
    channel: keyof typeof active;
    run: () => Promise<boolean>;
    resolve: (sent: boolean) => void;
    reject: (error: unknown) => void;
  }> = [];
  const controllers = new Map<string, AbortController>();
  const queues = new Map<string, { session: Session; version: number }>();
  const running = new Map<string, AbortSignal>();
  let disposed = false;
  const signalFor = (id: string) => {
    let controller = controllers.get(id);
    if (!controller) {
      controller = new AbortController();
      controllers.set(id, controller);
      controller.signal.addEventListener('abort', pump, { once: true });
    }
    return controller.signal;
  };
  const report = (error: unknown) => console.error('[dsh-a2a] notification failed:', error);
  function pump() {
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (disposed || waiting[i].signal.aborted) waiting.splice(i, 1)[0].resolve(false);
    }
    while (!disposed && active.message.size + active.inbox.size < 16) {
      const index = waiting.findIndex((job) => !active[job.channel].has(job.signal));
      if (index < 0) break;
      const job = waiting.splice(index, 1)[0];
      active[job.channel].add(job.signal);
      let cancel!: () => void;
      const canceled = new Promise<boolean>((resolve) => {
        cancel = () => resolve(false);
        job.signal.addEventListener('abort', cancel, { once: true });
      });
      // Flush has no cancellation argument; release its slot on disposal anyway.
      void Promise.race([
        canceled,
        Promise.resolve().then(() => (job.signal.aborted || disposed ? false : job.run())),
      ])
        .then(job.resolve, job.reject)
        .finally(() => {
          job.signal.removeEventListener('abort', cancel);
          active[job.channel].delete(job.signal);
          pump();
        });
    }
  }
  const schedule = (
    signal: AbortSignal,
    channel: keyof typeof active,
    run: () => Promise<boolean>,
  ): Promise<boolean> => {
    if (
      disposed ||
      signal.aborted ||
      (waiting.length >= 128 &&
        (active[channel].has(signal) || active.message.size + active.inbox.size >= 16))
    )
      return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      waiting.push({ signal, channel, run, resolve, reject });
      pump();
    });
  };
  const checkpoint = async (session: Session, signal: AbortSignal) => {
    if (disposed || signal.aborted) return false;
    if (!(await ctx.sessions.flush(session))) throw new Error('Notification checkpoint failed');
    return !disposed && !signal.aborted;
  };
  const put = (detail: Admission) => {
    if (disposed) return;
    let entries = pending.get(detail.contextId);
    if (!entries) {
      entries = new Map();
      pending.set(detail.contextId, entries);
    }
    if (entries.get(detail.dshMessageId)?.committedSeq !== undefined) return;
    // Bound stale observations too; selected input can restore an evicted admission.
    if (!entries.has(detail.dshMessageId) && entries.size >= 256) {
      const oldest = [...entries].find(([, entry]) => entry.committedSeq === undefined);
      if (!oldest) return;
      entries.delete(oldest[0]);
    }
    entries.set(detail.dshMessageId, detail);
  };
  if (options.message) {
    ctx.on('a2a/message-admitted', (detail) => {
      const selected = pending.get(detail.contextId)?.get(detail.dshMessageId);
      if (selected) selected.requestHeaders = detail.requestHeaders ?? selected.requestHeaders;
      else put(detail);
    });
    ctx.on('a2a/inbox', (detail) => {
      if (
        detail.phase !== 'selected' ||
        !detail.nativeMessageId ||
        !detail.messageId ||
        !detail.taskId
      )
        return;
      put({
        contextId: detail.contextId,
        dshMessageId: detail.nativeMessageId,
        a2aMessageId: detail.messageId,
        taskId: detail.taskId,
        requestHeaders: pending.get(detail.contextId)?.get(detail.nativeMessageId)?.requestHeaders,
      });
    });
    ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      pending.get(agent.session.id)?.delete(message.id);
    });
  }
  const drain = async (id: string, signal: AbortSignal) => {
    try {
      while (!disposed && !signal.aborted) {
        const entry = queues.get(id);
        if (!entry) break;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            if (attempt) await setTimeout(250 * attempt, undefined, { signal });
            if (
              await schedule(signal, 'inbox', async () => {
                if (!(await checkpoint(entry.session, signal))) return false;
                return Boolean(
                  await options.inbox?.({ contextId: id, version: entry.version }, signal),
                );
              })
            )
              break;
          } catch (error) {
            if (!signal.aborted && !disposed) report(error);
          }
          if (signal.aborted || disposed) return;
        }
        if (queues.get(id) === entry) queues.delete(id);
      }
    } finally {
      if (running.get(id) === signal) running.delete(id);
    }
  };
  ctx.on('session/event', (session, event) => {
    if (disposed) return;
    if (options.inbox && event.type === 'agent/inbox/spliced') {
      queues.set(session.id, { session, version: event.seq });
      if (!running.has(session.id)) {
        const signal = signalFor(session.id);
        running.set(session.id, signal);
        void Promise.resolve()
          .then(() => drain(session.id, signal))
          .catch(report);
      }
    }
    if (!options.message || event.type !== 'user/message') return;
    const entries = pending.get(session.id);
    const detail = entries?.get(event.data.id);
    // The native append feed is ordered; replayed observations keep their original seq.
    if (event.seq <= (committed.get(session.id) ?? -1)) {
      if (detail?.committedSeq === undefined) entries?.delete(event.data.id);
      return;
    }
    if (!detail) return;
    committed.set(session.id, event.seq);
    detail.committedSeq = event.seq;
    const signal = signalFor(session.id);
    void schedule(signal, 'message', async () => {
      if (!(await checkpoint(session, signal))) return false;
      if (
        !(await options.message?.(
          {
            contextId: session.id,
            messageId: detail.a2aMessageId,
            taskId: detail.taskId,
            requestHeaders: detail.requestHeaders,
            source: event.data.source,
          },
          signal,
        ))
      )
        throw new Error('Message notification delivery failed');
      return true;
    })
      .catch(report)
      .finally(() => {
        entries?.delete(event.data.id);
        if (pending.get(session.id) === entries && !entries?.size) pending.delete(session.id);
      });
  });
  const forget = (session: Session) => {
    const id = session.id;
    controllers.get(id)?.abort();
    controllers.delete(id);
    pending.delete(id);
    committed.delete(id);
    queues.delete(id);
    running.delete(id);
  };
  ctx.on('session/disposed', (session) => forget(session));
  ctx.on('agent/disposed', ({ agent }) => forget(agent.session));
  ctx.effect(() => () => {
    disposed = true;
    for (const controller of controllers.values()) controller.abort();
    controllers.clear();
    pending.clear();
    committed.clear();
    queues.clear();
    running.clear();
    pump();
  });
}

/** Host maps endpoint, envelope and an explicit header allowlist. No headers are inferred. */
export function httpNotificationSender<T>(
  map: (detail: T) => { url: string; body: unknown; headers?: Record<string, string> },
): NotificationSender<T> {
  return async (detail, signal) => {
    const { url, body, headers } = map(detail);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    });
    await response.body?.cancel();
    return response.ok;
  };
}
