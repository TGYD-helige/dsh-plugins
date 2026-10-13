import type { Session } from '@deepseek-ai/dsh-session';

/** Standard log-only hook records; producers own matching, execution and decisions. */
export interface HookInvoked {
  turn: number;
  point: string;
  dialect: string;
  matcher?: string;
  handlerId: string;
  /** Unique per execution, shared with its result; required for concurrent runs. */
  invocationId?: string;
  name?: string;
}

export interface HookResult {
  turn: number;
  point: string;
  handlerId: string;
  invocationId?: string;
  decision: string;
  outcome?: 'success' | 'failed' | 'timed-out' | 'cancelled';
  exitCode?: number;
  signal?: string;
  stderrSummary?: string;
  durationMs: number;
}

interface HookEventMap {
  'hook/invoked': HookInvoked;
  'hook/result': HookResult;
}

function baseFields(data: unknown): data is HookInvoked & HookResult {
  if (!data || typeof data !== 'object') return false;
  const value = data as HookInvoked & HookResult;
  return (
    Number.isSafeInteger(value.turn) &&
    value.turn >= 0 &&
    typeof value.point === 'string' &&
    value.point.length > 0 &&
    typeof value.handlerId === 'string' &&
    value.handlerId.length > 0 &&
    (value.invocationId === undefined ||
      (typeof value.invocationId === 'string' && value.invocationId.length > 0))
  );
}

export function isHookInvoked(data: unknown): data is HookInvoked {
  return (
    baseFields(data) &&
    typeof data.dialect === 'string' &&
    data.dialect.length > 0 &&
    (data.matcher === undefined || typeof data.matcher === 'string') &&
    (data.name === undefined || typeof data.name === 'string')
  );
}

export function isHookResult(data: unknown): data is HookResult {
  return (
    baseFields(data) &&
    typeof data.decision === 'string' &&
    Number.isFinite(data.durationMs) &&
    data.durationMs >= 0 &&
    (data.outcome === undefined ||
      ['success', 'failed', 'timed-out', 'cancelled'].includes(data.outcome)) &&
    (data.exitCode === undefined || Number.isSafeInteger(data.exitCode)) &&
    (data.signal === undefined || typeof data.signal === 'string') &&
    (data.stderrSummary === undefined || typeof data.stderrSummary === 'string')
  );
}

/** Append standard telemetry without narrowing custom dialects or changing hook decisions. */
export function appendHookEvent<K extends keyof HookEventMap>(
  session: Session,
  type: K,
  data: HookEventMap[K],
): boolean {
  try {
    if (
      !(type === 'hook/invoked'
        ? isHookInvoked(data)
        : type === 'hook/result' && isHookResult(data))
    ) {
      throw new TypeError('invalid hook telemetry fields');
    }
    // The optional upstream hook-protocol augmentation still restricts dialects.
    const append = session.append as unknown as (type: K, data: HookEventMap[K]) => unknown;
    append.call(session, type, data);
    return true;
  } catch (error) {
    console.error('[dsh-langfuse] hook reporting failed:', error);
    return false;
  }
}
