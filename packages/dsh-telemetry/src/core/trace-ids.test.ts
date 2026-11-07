import { expect, it } from 'vitest';
import { createTraceIdGenerator } from './trace-ids.js';

it('restores root IDs after nested creation and failures, and rejects invalid requested IDs', () => {
  const ids = createTraceIdGenerator({
    generateTraceId: () => '11111111111111111111111111111111',
    generateSpanId: () => '1111111111111111',
  });
  ids.withTraceId('22222222222222222222222222222222', () => {
    expect(ids.generateTraceId()).toBe('22222222222222222222222222222222');
    expect(() =>
      ids.withTraceId('33333333333333333333333333333333', () => {
        throw new Error('failed creation');
      }),
    ).toThrow('failed creation');
    expect(ids.generateTraceId()).toBe('22222222222222222222222222222222');
  });
  expect(ids.generateTraceId()).toBe('11111111111111111111111111111111');
  for (const invalid of ['00000000000000000000000000000000', 'not-a-trace-id'])
    expect(ids.withTraceId(invalid, () => ids.generateTraceId())).toBe(
      '11111111111111111111111111111111',
    );
});
