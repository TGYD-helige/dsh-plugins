import { describe, expect, it, vi } from 'vitest';
import { AdmissionGate } from './admission.js';

describe('AdmissionGate', () => {
  it('releases FIFO once and cleans up only the current tail', async () => {
    const gate = new AdmissionGate();
    const first = gate.acquire('task');
    await first.ready;
    const second = gate.acquire('task');
    const secondSettled = vi.fn();
    void second.ready.then(secondSettled);
    await Promise.resolve();
    expect(secondSettled).not.toHaveBeenCalled();

    const staleCleanup = vi.fn();
    first.release(staleCleanup);
    expect(staleCleanup).not.toHaveBeenCalled();

    await second.ready;
    const cleanup = vi.fn();
    second.release(cleanup);
    second.release(cleanup);
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
