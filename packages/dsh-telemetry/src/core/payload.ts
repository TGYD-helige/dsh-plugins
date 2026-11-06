import type { InstrumentationReporter } from './types.js';

export interface PayloadBudget {
  remaining: number;
  truncated: boolean;
}

export const newPayloadBudget = (maxBytes: number): PayloadBudget => ({
  remaining: maxBytes,
  truncated: false,
});

/** Take a UTF-8 prefix without ever exceeding the remaining content-byte budget. */
export function takePayloadText(value: string, budget: PayloadBudget): string {
  const bytes = Buffer.byteLength(value);
  if (bytes <= budget.remaining) {
    budget.remaining -= bytes;
    return value;
  }
  budget.truncated = true;
  if (budget.remaining <= 0) return '';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= budget.remaining) low = middle;
    else high = middle - 1;
  }
  budget.remaining = 0;
  return value.slice(0, low);
}

type BoundedPayload<T> = T | { truncated: true; preview?: string } | string | number;

/** Build a preview whose complete JSON value, including its wrapper, fits the remaining cap. */
function previewPayload<T>(serialized: string, budget: PayloadBudget): BoundedPayload<T> {
  const remaining = budget.remaining;
  const marker = { truncated: true as const };
  const withPreview = { ...marker, preview: '' };
  if (Buffer.byteLength(JSON.stringify(withPreview)) <= remaining) {
    let low = 0;
    let high = serialized.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = { ...marker, preview: serialized.slice(0, middle) };
      if (Buffer.byteLength(JSON.stringify(candidate)) <= remaining) low = middle;
      else high = middle - 1;
    }
    budget.remaining = 0;
    return { ...marker, preview: serialized.slice(0, low) };
  }
  if (Buffer.byteLength(JSON.stringify(marker)) <= remaining) {
    budget.remaining = 0;
    return marker;
  }
  // Even the marker is too large: retain a plain string prefix, still capped
  // after JSON quoting/escaping rather than by source-string bytes.
  let low = 0;
  let high = serialized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(serialized.slice(0, middle))) <= remaining) low = middle;
    else high = middle - 1;
  }
  budget.remaining = 0;
  return low > 0 ? serialized.slice(0, low) : remaining >= 2 ? '' : 0;
}

const MAX_ATOMIC_MASK_BYTES = 64 * 1024;

/** Redact leaves while serializing, so an oversized payload never needs a full mask or stringify. */
function boundMaskedPayload<T>(
  input: T,
  budget: PayloadBudget,
  reporter: Pick<InstrumentationReporter, 'mask' | 'shouldRedactField'>,
): BoundedPayload<T> {
  const seen = new WeakSet<object>();
  const parts: string[] = [];
  let remaining = budget.remaining;
  let overflow = false;
  const append = (text: string | undefined) => {
    if (overflow || text === undefined) return;
    const bytes = Buffer.byteLength(text);
    if (bytes > remaining) {
      // The node was already masked atomically; a serialized prefix is safe.
      parts.push(takePayloadText(text, { remaining, truncated: true }));
      remaining = 0;
      overflow = true;
      return;
    }
    parts.push(text);
    remaining -= bytes;
  };
  const write = (value: unknown): unknown => {
    if (overflow || value === undefined) return undefined;
    if (value === null || typeof value !== 'object' || value instanceof Date) {
      if (
        typeof value === 'string' &&
        Buffer.byteLength(value) > MAX_ATOMIC_MASK_BYTES &&
        Buffer.byteLength(value) > remaining
      ) {
        overflow = true;
        return undefined;
      }
      const masked = reporter.mask(value);
      append(JSON.stringify(masked));
      return masked;
    }
    if (seen.has(value)) {
      append(JSON.stringify('[Circular]'));
      return '[Circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      append('[');
      const result: unknown[] = [];
      for (const [index, item] of value.entries()) {
        if (overflow) break;
        if (index > 0) append(',');
        if (item === undefined) {
          append('null');
          result.push(null);
        } else {
          const masked = write(item);
          if (!overflow) result.push(masked);
        }
      }
      append(']');
      seen.delete(value);
      return result;
    }
    append('{');
    const result = Object.create(null) as Record<string, unknown>;
    let first = true;
    for (const key in value) {
      if (overflow) break;
      if (!Object.hasOwn(value, key)) continue;
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined && !reporter.shouldRedactField(key)) continue;
      if (!first) append(',');
      first = false;
      append(JSON.stringify(reporter.mask(key)));
      append(':');
      if (reporter.shouldRedactField(key)) {
        append(JSON.stringify('[REDACTED]'));
        result[key] = '[REDACTED]';
      } else {
        const masked = write(child);
        if (!overflow) result[key] = masked;
      }
    }
    append('}');
    seen.delete(value);
    return result;
  };
  try {
    const masked = write(input);
    if (!overflow) {
      budget.remaining = remaining;
      return masked as T;
    }
  } catch {
    budget.truncated = true;
    return previewPayload('', budget);
  }
  budget.truncated = true;
  return previewPayload(parts.join(''), budget);
}

/** Bound a structured payload without changing its shape when it fits. */
export function boundPayload<T>(
  input: T,
  budget: PayloadBudget,
  reporter?: Pick<InstrumentationReporter, 'mask' | 'shouldRedactField'>,
): BoundedPayload<T> {
  if (reporter) return boundMaskedPayload(input, budget, reporter);
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? '';
  } catch {
    budget.truncated = true;
    return previewPayload('', budget);
  }
  const bytes = Buffer.byteLength(serialized);
  if (bytes <= budget.remaining) {
    budget.remaining -= bytes;
    return input;
  }
  budget.truncated = true;
  return previewPayload(serialized, budget);
}
