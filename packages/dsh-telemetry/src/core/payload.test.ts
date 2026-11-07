import { describe, expect, it, vi } from 'vitest';
import { boundPayload, newPayloadBudget } from './payload.js';
import { PayloadPrivacy } from './privacy.js';

describe('bounded payload previews', () => {
  it.each([
    ['messages', 100],
    ['messages', 10_000],
    ['tools', 100],
    ['tools', 10_000],
  ] as const)('bounds traversal of %s with %i entries before masking', (key, count) => {
    const secret = 'sk-perf-fixture';
    const privacy = new PayloadPrivacy({ secrets: [secret], redactFields: ['password'] });
    let visited = 0;
    const input = {
      [key]: Array.from({ length: count }, () => ({
        get description() {
          visited++;
          return `${secret} 中文😀 `.repeat(16);
        },
        password: 'private-field-value',
      })),
    };
    const mask = vi.spyOn(privacy, 'mask');
    const budget = newPayloadBudget(1024);
    const output = boundPayload(input, budget, privacy);
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThanOrEqual(8);
    expect(mask.mock.calls.length).toBeLessThanOrEqual(64);
    const wire = JSON.stringify(output);
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(1024);
    expect(wire).not.toContain(secret);
    expect(wire).not.toContain('private-field-value');
    expect(budget.truncated).toBe(true);
  });

  it('bounds deeply nested JSON arguments while redacting credentials', () => {
    const privacy = new PayloadPrivacy({ secrets: ['perf-secret'], redactFields: ['password'] });
    let args: unknown = { password: 'private-value', credential: 'perf-secret' };
    for (let depth = 0; depth < 64; depth++) args = { nested: args };
    const input = { arguments: JSON.stringify(args) };
    const wire = JSON.stringify(boundPayload(input, newPayloadBudget(1024), privacy));
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(1024);
    expect(wire).not.toContain('perf-secret');
    expect(wire).not.toContain('private-value');
    expect(wire).toContain('[REDACTED]');
    expect(input.arguments).toContain('private-value');
  });

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
