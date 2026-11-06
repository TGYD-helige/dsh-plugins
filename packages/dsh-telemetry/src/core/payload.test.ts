import { describe, expect, it, vi } from 'vitest';
import { boundPayload, newPayloadBudget } from './payload.js';

describe('bounded payload previews', () => {
  it('uses a constant number of serialization passes for an oversized value', () => {
    const input = { text: 'large payload '.repeat(30_000) };
    const stringify = vi.spyOn(JSON, 'stringify');
    let passes: number;
    try {
      boundPayload(input, newPayloadBudget(128 * 1024));
      passes = stringify.mock.calls.length;
    } finally {
      stringify.mockRestore();
    }
    expect(passes).toBeLessThanOrEqual(5);
  });

  it('keeps escaped and Unicode previews valid and within every byte cap', () => {
    for (const text of [
      '"\\\n\r\t\b\f\u0000\u001f😀中文\ud800x\udc00',
      '\\'.repeat(50),
      '\\u1234\\u\\u12',
      '\ud800'.repeat(50),
      '\udc00'.repeat(50),
      '😀'.repeat(50),
    ]) {
      const input = { text: text.repeat(50) };
      const serialized = JSON.stringify(input);
      for (let cap = 1; cap <= 512; cap++) {
        const budget = newPayloadBudget(cap);
        const value = boundPayload(input, budget);
        expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(cap);
        expect(budget.truncated).toBe(true);
        if (value && typeof value === 'object' && 'preview' in value)
          expect(serialized.startsWith(String(value.preview))).toBe(true);
        if (typeof value === 'string') expect(serialized.startsWith(value)).toBe(true);
      }
    }
  });
});
