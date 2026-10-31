import { UnsupportedOperationError } from '@a2a-js/sdk/errors';
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';

export interface InboxChange {
  contextId: string;
  version: number;
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'a2a/inbox-checkpointed'(change: InboxChange): void;
  }
}

/** Invalidation only: DSH owns the queue, sequence and durability barrier. */
export class InboxChanges {
  private readonly states = new WeakMap<
    Session,
    { requested: number; job?: Promise<InboxChange> }
  >();
  private readonly listeners = new Map<Session, Map<(change: InboxChange) => void, () => void>>();
  private readonly disposed = new WeakSet<Session>();
  private readonly detach: Array<() => void>;
  private stopped = false;

  constructor(
    private readonly ctx: Context,
    managed: (contextId: string) => boolean,
    enabled = false,
  ) {
    this.detach = [
      ctx.on('session/event', (session, event) => {
        if (
          this.stopped ||
          event.type !== 'agent/inbox/spliced' ||
          !managed(session.id) ||
          (!enabled && !this.listeners.has(session))
        )
          return;
        void this.checkpoint(session).catch((error) => {
          if (!this.stopped)
            console.error('[dsh-a2a] inbox checkpoint notification failed:', error);
        });
      }),
      ctx.on('session/disposed', (session) => this.closeSession(session)),
    ];
    ctx.effect(() => () => this.close());
  }

  watch(session: Session, listener: (change: InboxChange) => void, closed: () => void): () => void {
    if (this.stopped || this.disposed.has(session))
      throw new UnsupportedOperationError('Inbox notifications are closed.');
    let listeners = this.listeners.get(session);
    if (!listeners) {
      listeners = new Map();
      this.listeners.set(session, listeners);
    }
    listeners.set(listener, closed);
    const dispose = () => {
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(session) === listeners)
        this.listeners.delete(session);
    };
    return dispose;
  }

  checkpoint(session: Session): Promise<InboxChange> {
    if (this.stopped || this.disposed.has(session))
      return Promise.reject(new UnsupportedOperationError('Inbox notifications are closed.'));
    let state = this.states.get(session);
    if (!state) {
      state = { requested: -1 };
      this.states.set(session, state);
    }
    state.requested = Math.max(state.requested, session.seq - 1);
    const pending = state;
    if (!pending.job)
      pending.job = Promise.resolve()
        .then(async () => {
          let version: number;
          do {
            if (this.stopped || this.disposed.has(session))
              throw new UnsupportedOperationError('Inbox notifications are closed.');
            version = pending.requested;
            const sessions = this.ctx.get('sessions');
            if (!sessions || !(await sessions.flush(session)))
              throw new UnsupportedOperationError(
                'Inbox notifications require a successful DSH durability checkpoint.',
              );
            if (this.stopped || this.disposed.has(session))
              throw new UnsupportedOperationError('Inbox notifications are closed.');
            const change = { contextId: session.id, version };
            for (const listener of this.listeners.get(session)?.keys() ?? []) {
              try {
                listener(change);
              } catch (error) {
                console.error('[dsh-a2a] inbox notification listener failed:', error);
              }
            }
            await this.ctx.parallel('a2a/inbox-checkpointed', change).catch((error: unknown) => {
              console.error('[dsh-a2a] inbox checkpoint observer failed:', error);
            });
          } while (pending.requested > version);
          return { contextId: session.id, version };
        })
        .finally(() => {
          pending.job = undefined;
        });
    return pending.job;
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const detach of this.detach) detach();
    for (const session of this.listeners.keys()) this.closeSession(session);
  }

  private closeSession(session: Session): void {
    this.disposed.add(session);
    const listeners = this.listeners.get(session);
    this.listeners.delete(session);
    for (const close of listeners?.values() ?? []) {
      try {
        close();
      } catch (error) {
        console.error('[dsh-a2a] inbox subscription cleanup failed:', error);
      }
    }
  }
}
