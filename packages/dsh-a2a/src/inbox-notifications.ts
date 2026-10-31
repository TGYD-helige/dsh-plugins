import { setTimeout } from 'node:timers/promises';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type { Session } from '@deepseek-ai/dsh-session';

/** Native inbox invalidation, outside the standard A2A task event stream. */
export interface InboxChangeNotification {
  contextId: string;
  version: number;
}
/** Return false or throw on failure. Honor cancellation and bound execution time. */
export type InboxNotificationSender = (
  detail: InboxChangeNotification,
  signal: AbortSignal,
) => Promise<boolean>;

/** Opt in once on a plugin-scoped Context; task updates keep using standard A2A. */
export function installInboxNotifications(ctx: Context, send?: InboxNotificationSender): void {
  if (!send) return;
  const pending = new Map<string, { session: Session; version: number }>();
  const running = new Map<string, AbortController>();
  let disposed = false;
  let scheduled = false;
  const report = (error: unknown) => console.error('[dsh-a2a] inbox notification failed:', error);
  const kick = () => {
    if (scheduled || disposed) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      for (const id of pending.keys()) {
        if (disposed || running.size >= 16) break;
        if (running.has(id)) continue;
        const controller = new AbortController();
        running.set(id, controller);
        void drain(id, controller.signal)
          .catch(report)
          .finally(() => {
            if (running.get(id) !== controller) return;
            running.delete(id);
            kick();
          });
      }
    });
  };
  const drain = async (id: string, signal: AbortSignal) => {
    if (disposed || signal.aborted) return;
    const entry = pending.get(id);
    if (!entry) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt) await setTimeout(250 * attempt, undefined, { signal });
        if (disposed || signal.aborted) return;
        const flushed = await ctx.sessions.flush(entry.session);
        if (disposed || signal.aborted) return;
        if (!flushed) throw new Error('Inbox notification checkpoint failed');
        if (await send({ contextId: id, version: entry.version }, signal)) break;
      } catch (error) {
        if (disposed || signal.aborted) return;
        report(error);
      }
    }
    if (disposed || signal.aborted) return;
    const latest = pending.get(id);
    pending.delete(id);
    // Newer versions get their own budget behind contexts already waiting.
    if (latest && latest !== entry) pending.set(id, latest);
  };
  ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'agent/inbox/spliced') return;
    // One invalidation per context, including active deliveries; overload is best effort.
    if (!pending.has(session.id) && pending.size >= 128) return;
    pending.set(session.id, { session, version: event.seq });
    kick();
  });
  const forget = (session: Session) => {
    pending.delete(session.id);
    running.get(session.id)?.abort();
    // Flush itself cannot be canceled; free its slot without waiting for completion.
    running.delete(session.id);
    kick();
  };
  ctx.on('session/disposed', forget);
  ctx.on('agent/disposed', ({ agent }) => forget(agent.session));
  ctx.effect(() => () => {
    disposed = true;
    pending.clear();
    for (const controller of running.values()) controller.abort();
    running.clear();
  });
}

/** Host-owned inbox envelope and explicit headers; not A2A Push Notifications. */
export function httpInboxNotificationSender(
  map: (detail: InboxChangeNotification) => {
    url: string;
    body: unknown;
    headers?: Record<string, string>;
  },
): InboxNotificationSender {
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
