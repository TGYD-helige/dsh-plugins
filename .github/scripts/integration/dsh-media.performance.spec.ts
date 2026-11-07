import { getEventListeners } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, onTestFinished, vi } from 'vitest';
import { buildMessageContent } from '../../../packages/dsh-a2a/src/content.js';
import { displayBlocks } from '../../../packages/dsh-telemetry/src/core/media.js';

it('performance: large file download, cap refusal and cancellation cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-media-performance-'));
  let started!: () => void;
  let closed!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const requestClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const chunk = Buffer.alloc(256 * 1024, 42);
  const server = createServer((req, res) => {
    if (req.url === '/cancel') {
      req.once('close', closed);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write(chunk);
      started();
    } else if (req.url === '/over-cap') {
      res.writeHead(200, { 'content-length': 64 * 1024 * 1024 + 1 });
      res.end(chunk);
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      void pipeline(
        Readable.from(
          (async function* () {
            for (let i = 0; i < 96; i++) yield chunk;
          })(),
        ),
        res,
      ).catch(() => {});
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const parts = (route: string) => [
    {
      content: { $case: 'url' as const, value: `${base}/${route}` },
      filename: `${route}.bin`,
      mediaType: 'application/octet-stream',
      metadata: undefined,
    },
  ];
  const startedAt = performance.now();
  const blocks = await buildMessageContent(parts('large'), undefined, directory, undefined, {
    allowedHosts: ['127.0.0.1'],
  });
  expect(blocks[0].type).toBe('text');
  expect((await stat(join(directory, 'large.bin'))).size).toBe(24 * 1024 * 1024);
  const downloadMs = performance.now() - startedAt;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const refused = await buildMessageContent(parts('over-cap'), undefined, directory, undefined, {
    allowedHosts: ['127.0.0.1'],
  });
  expect(JSON.stringify(refused)).toContain('not delivered');
  expect(await readdir(directory)).toEqual(['large.bin']);
  const abort = new AbortController();
  const preparing = buildMessageContent(
    parts('cancel'),
    undefined,
    directory,
    undefined,
    { allowedHosts: ['127.0.0.1'] },
    abort.signal,
  );
  const rejected = expect(preparing).rejects.toThrow('performance cancellation');
  await requestStarted;
  const cancelAt = performance.now();
  abort.abort(new Error('performance cancellation'));
  await rejected;
  await requestClosed;
  expect(await readdir(directory)).toEqual(['large.bin']);
  expect(getEventListeners(abort.signal, 'abort')).toHaveLength(0);
  writeFileSync(
    fileURLToPath(new URL('../../../performance-media.json', import.meta.url)),
    JSON.stringify(
      {
        bytes: 24 * 1024 * 1024,
        downloadMs,
        cancellationMs: performance.now() - cancelAt,
        heapUsed: process.memoryUsage().heapUsed,
        rss: process.memoryUsage().rss,
        note: 'Download buffers the file up to its cap; this is not a zero-copy path.',
      },
      null,
      2,
    ),
  );
}, 20_000);

it('performance: media admission shares a byte budget and cancels ignored reads', async () => {
  const bytes = new Uint8Array(1024 * 1024);
  const content = Array.from({ length: 128 }, (_, index) => ({
    type: 'image' as const,
    attachment: {
      attachmentId: `image-${index}`,
      mediaType: 'image/png',
      bytes: bytes.byteLength,
      width: 1,
      height: 1,
    },
  }));
  const store = { readImage: vi.fn(async () => ({ data: bytes })) };
  const output = await displayBlocks(content as never, store as never, {
    enabled: true,
    maxBytes: 4 * 1024 * 1024,
    timeoutMs: 1000,
  });
  expect(store.readImage).toHaveBeenCalledTimes(4);
  expect(output.filter((block: any) => block.type === 'image_url')).toHaveLength(4);
  const signals: AbortSignal[] = [];
  store.readImage.mockImplementation((async (_ref: unknown, signal: AbortSignal) => {
    signals.push(signal);
    return new Promise(() => {});
  }) as never);
  store.readImage.mockClear();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const abort = new AbortController();
  const pending = displayBlocks(
    content as never,
    store as never,
    { enabled: true, maxBytes: 4 * 1024 * 1024, timeoutMs: 1000 },
    abort.signal,
  );
  abort.abort(new Error('cancel media'));
  expect(await pending).toHaveLength(128);
  expect(store.readImage).toHaveBeenCalledTimes(4);
  expect(
    signals.every((signal) => signal.aborted && getEventListeners(signal, 'abort').length === 0),
  ).toBe(true);
});
