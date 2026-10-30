import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@a2a-js/sdk';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMessageContent, uploadsDir } from './content.js';

const network = vi.hoisted(() => {
  type FakeResponse = {
    statusCode: number;
    headers: Record<string, string>;
    chunks: Uint8Array[];
  };
  const state = {
    handler: undefined as undefined | ((url: URL) => FakeResponse),
    requests: [] as Array<{ url: string; lookup: (...args: any[]) => void }>,
    lookups: [] as Array<{ hostname: string; options: any }>,
  };
  const response = (value: FakeResponse) => ({
    statusCode: value.statusCode,
    headers: value.headers,
    resume: vi.fn(),
    destroy: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of value.chunks) yield chunk;
    },
  });
  const request = vi.fn(
    (url: URL, options: { lookup: (...args: any[]) => void }, resolve: (value: any) => void) => {
      const listeners = new Map<string, (...args: any[]) => void>();
      const req = {
        on: (event: string, listener: (...args: any[]) => void) => {
          listeners.set(event, listener);
          return req;
        },
        destroy: (error: Error) => {
          listeners.get('error')?.(error);
          return req;
        },
        end: () => {
          state.requests.push({ url: url.href, lookup: options.lookup });
          const result = state.handler?.(url) ?? {
            statusCode: 500,
            headers: {},
            chunks: [],
          };
          queueMicrotask(() => resolve(response(result)));
          return req;
        },
      };
      return req as unknown as ClientRequest;
    },
  );
  const lookup = vi.fn(async (hostname: string, options: any) => {
    state.lookups.push({ hostname, options });
    const entry = { address: hostname === 'localhost' ? '127.0.0.1' : '93.184.216.34', family: 4 };
    return options?.all ? [entry] : entry;
  });
  return {
    state,
    request,
    lookup,
    reset: () => {
      state.handler = undefined;
      state.requests.length = 0;
      state.lookups.length = 0;
      request.mockClear();
      lookup.mockClear();
    },
  };
});
vi.mock('node:http', () => ({ request: network.request }));
vi.mock('node:https', () => ({ request: network.request }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));

function part(content: Part['content'], mediaType = '', filename = ''): Part {
  return { content, metadata: undefined, filename, mediaType };
}

const textPart = (text: string) => part({ $case: 'text', value: text }, 'text/plain');

const textOf = (block: ContentBlock) => (block.type === 'text' ? block.text : '');

function fakeStore() {
  return {
    imageLimits: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    saveImage: vi.fn(async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
      attachmentId: 'img-1',
      mediaType: input.mediaType as 'image/png',
      bytes: input.data.byteLength,
      width: 8,
      height: 8,
      name: input.name,
    })),
    saveFile: vi.fn(async (input: { data: Uint8Array; name?: string }) => ({
      attachmentId: 'file-1',
      name: input.name ?? 'upload',
      bytes: input.data.byteLength,
    })),
  };
}

const urlPart = (url: string, mediaType: string, filename: string) =>
  part({ $case: 'url', value: url }, mediaType, filename);

const localDownloads = { allowedHosts: ['127.0.0.1'] };

async function withDownloadServer(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
  run: (base: string) => Promise<void>,
) {
  network.state.handler = (url) => {
    const chunks: Uint8Array[] = [];
    const headers: Record<string, string> = {};
    const req = { url: `${url.pathname}${url.search}` } as IncomingMessage;
    const res = {
      statusCode: 200,
      writeHead(status: number, nextHeaders: Record<string, string>) {
        this.statusCode = status;
        Object.assign(headers, nextHeaders);
        return this;
      },
      write(chunk: string | Uint8Array) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        return true;
      },
      end(chunk?: string | Uint8Array) {
        if (chunk !== undefined)
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      },
    } as ServerResponse;
    respond(req, res);
    return { statusCode: res.statusCode, headers, chunks };
  };
  try {
    await run('http://127.0.0.1');
  } finally {
    network.state.handler = undefined;
  }
}

describe('buildMessageContent', () => {
  let dir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    network.reset();
    dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-a2a-content-'));
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const expectLogged = () =>
    expect(
      errorSpy.mock.calls.some((args: unknown[]) => String(args[0]).includes('[dsh-a2a]')),
    ).toBe(true);

  it('throws only when no part is usable', async () => {
    await expect(buildMessageContent([], undefined, dir)).rejects.toThrow('usable part');
    await expect(buildMessageContent([textPart('  ')], undefined, dir)).rejects.toThrow(
      'usable part',
    );
  });

  it('keeps text and data parts in message order, skipping empty content', async () => {
    const blocks = await buildMessageContent(
      [textPart('a'), part(undefined), part({ $case: 'data', value: { x: 1 } }), textPart('b')],
      undefined,
      dir,
    );
    expect(blocks.map((b) => b.type)).toEqual(['text', 'text', 'text']);
    expect(textOf(blocks[0])).toBe('a');
    expect(textOf(blocks[1])).toBe('<data>\n{\n  "x": 1\n}\n</data>');
    expect(textOf(blocks[2])).toBe('b');
  });

  it('rejects a non-http url part without fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const blocks = await buildMessageContent(
      [urlPart('file:///etc/passwd', 'text/plain', 'passwd')],
      undefined,
      dir,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(textOf(blocks[0])).toContain('unsupported scheme "file:"');
    expectLogged();
  });

  it('notes an HTTP error instead of failing', async () => {
    await withDownloadServer(
      (_req, res) => {
        res.statusCode = 404;
        res.end('nope');
      },
      async (base) => {
        const blocks = await buildMessageContent(
          [urlPart(`${base}/f.pdf`, 'application/pdf', 'f.pdf')],
          undefined,
          dir,
          undefined,
          localDownloads,
        );
        expect(textOf(blocks[0])).toContain('HTTP 404');
        expectLogged();
      },
    );
  });

  it('refuses an over-cap download on content-length before reading the body', async () => {
    await withDownloadServer(
      (_req, res) => {
        res.writeHead(200, { 'content-length': String(65 * 1024 * 1024) });
        res.end('x');
      },
      async (base) => {
        const store = fakeStore();
        const blocks = await buildMessageContent(
          [urlPart(`${base}/big.zip`, 'application/zip', 'big.zip')],
          store as unknown as AttachmentStore,
          dir,
          undefined,
          localDownloads,
        );
        expect(store.saveFile).not.toHaveBeenCalled();
        expect(textOf(blocks[0])).toContain('exceeds');
        expectLogged();
      },
    );
  });

  it('refuses an over-cap body when content-length is absent', async () => {
    await withDownloadServer(
      (_req, res) => {
        res.write(Buffer.alloc(64 * 1024 * 1024));
        res.end(Buffer.alloc(1));
      },
      async (base) => {
        const blocks = await buildMessageContent(
          [urlPart(`${base}/big.zip`, 'application/zip', 'big.zip')],
          undefined,
          dir,
          undefined,
          localDownloads,
        );
        expect(textOf(blocks[0])).toContain('exceeds');
        expectLogged();
      },
    );
  });

  it('falls back to the response content-type when the part declares no media type', async () => {
    await withDownloadServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'image/png; charset=binary' });
        res.end(new Uint8Array([1, 2]));
      },
      async (base) => {
        const store = fakeStore();
        const blocks = await buildMessageContent(
          [urlPart(`${base}/pic`, '', 'pic.png')],
          store as unknown as AttachmentStore,
          dir,
          undefined,
          localDownloads,
        );
        expect(store.saveImage).toHaveBeenCalledTimes(1);
        expect(store.saveImage.mock.calls[0][0].mediaType).toBe('image/png');
        expect(blocks[0].type).toBe('image');
      },
    );
  });

  it('notes a persist failure instead of failing', async () => {
    const file = path.join(dir, 'afile');
    await writeFile(file, 'x');
    const blocks = await buildMessageContent(
      [part({ $case: 'raw', value: Buffer.from('x') }, 'application/zip', 'z.zip')],
      undefined,
      // A directory below a regular file can never be created.
      path.join(file, 'sub'),
    );
    expect(textOf(blocks[0])).toContain('not delivered');
    expectLogged();
  });

  it('persists a ".." filename under the fallback name', async () => {
    const blocks = await buildMessageContent(
      [part({ $case: 'raw', value: Buffer.from('x') }, 'text/plain', '..')],
      undefined,
      dir,
    );
    expect(textOf(blocks[0])).toContain('unnamed-file');
  });

  it('uploadsDir layers the local date as YYYYMMDD under the given root', () => {
    expect(path.dirname(uploadsDir('/w'))).toBe(path.normalize('/w'));
    expect(path.basename(uploadsDir('/w'))).toMatch(/^\d{8}$/);
  });

  it('uploadsDir defaults to a dsh-a2a-uploads dir under the OS temp dir', () => {
    expect(uploadsDir().startsWith(path.join(os.tmpdir(), 'dsh-a2a-uploads'))).toBe(true);
  });

  it('strips Windows-illegal characters and reserved stems from upload names', async () => {
    const illegal = await buildMessageContent(
      [part({ $case: 'raw', value: Buffer.from('x') }, 'text/plain', 'a<b>:c.txt')],
      undefined,
      dir,
    );
    expect(textOf(illegal[0])).toContain('name="abc.txt"');

    const reserved = await buildMessageContent(
      [part({ $case: 'raw', value: Buffer.from('x') }, 'text/plain', 'CON')],
      undefined,
      dir,
    );
    expect(textOf(reserved[0])).toContain('unnamed-file');
  });

  it('matches image media types case-insensitively', async () => {
    const store = fakeStore();
    const blocks = await buildMessageContent(
      [part({ $case: 'raw', value: Buffer.from([0x89]) }, 'Image/PNG', 'p.png')],
      store as unknown as AttachmentStore,
      dir,
    );
    expect(store.saveImage).toHaveBeenCalledTimes(1);
    expect(blocks[0].type).toBe('image');
  });

  it('writes inline and URL non-images locally with a store, while images stay native', async () => {
    await withDownloadServer(
      (_req, res) => res.end('downloaded'),
      async (base) => {
        const store = fakeStore();
        const blocks = await buildMessageContent(
          [
            part({ $case: 'raw', value: Buffer.from('inline') }, 'text/plain', '../report.txt'),
            urlPart(`${base}/report.txt`, 'text/plain', '../report.txt'),
            part({ $case: 'raw', value: Buffer.from([0x89]) }, 'image/png', 'pic.png'),
          ],
          store as unknown as AttachmentStore,
          dir,
          undefined,
          localDownloads,
        );
        expect(store.saveFile).not.toHaveBeenCalled();
        expect(store.saveImage).toHaveBeenCalledTimes(1);
        expect(await readFile(path.join(dir, 'report.txt'), 'utf8')).toBe('inline');
        expect(await readFile(path.join(dir, 'report-1.txt'), 'utf8')).toBe('downloaded');
        expect(textOf(blocks[0])).toContain(`path="${path.join(dir, 'report.txt')}"`);
        expect(textOf(blocks[0])).toContain('originalName="../report.txt"');
        expect(textOf(blocks[1])).toContain(`uri="${base}/report.txt"`);
        expect(textOf(blocks[1])).toContain('type="text/plain" size="10"');
        expect(blocks[2].type).toBe('image');
      },
    );
  });

  it('gives a configured remote materializer precedence over local storage', async () => {
    const store = fakeStore();
    const materializeFile = vi.fn(async () => ({ readablePath: '/remote/report.txt' }));
    const blocks = await buildMessageContent(
      [part({ $case: 'raw', value: Buffer.from('x') }, 'text/plain', 'report.txt')],
      store as unknown as AttachmentStore,
      dir,
      { contextId: 'ctx-1', materializer: { materializeFile } },
    );
    expect(materializeFile).toHaveBeenCalledTimes(1);
    expect(store.saveFile).not.toHaveBeenCalled();
    expect(textOf(blocks[0])).toContain('path="/remote/report.txt"');
  });

  it('notes a part with an unknown content kind instead of dropping it silently', async () => {
    const blocks = await buildMessageContent(
      [textPart('hi'), part({ $case: 'voiceNote', value: 'x' } as never)],
      undefined,
      dir,
    );
    expect(blocks).toHaveLength(2);
    expect(textOf(blocks[1])).toContain('not delivered');
    expect(textOf(blocks[1])).toContain('voiceNote');
  });

  it('blocks private downloads and every redirect unless the host is explicitly allowed', async () => {
    const hits: string[] = [];
    await withDownloadServer(
      (req, res) => {
        hits.push(req.url!);
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://localhost/secret' });
          res.end();
        } else {
          res.end('downloaded');
        }
      },
      async (base) => {
        const blocked = await buildMessageContent(
          [urlPart(`${base}/secret`, 'text/plain', 'secret.txt')],
          undefined,
          dir,
        );
        expect(textOf(blocked[0])).toContain('private');
        expect(hits).toEqual([]);

        const allowed = await buildMessageContent(
          [urlPart(`${base}/secret`, 'text/plain', 'secret.txt')],
          undefined,
          dir,
          undefined,
          { allowedHosts: ['127.0.0.1'] },
        );
        expect(textOf(allowed[0])).toContain('size="10"');

        const redirected = await buildMessageContent(
          [urlPart(`${base}/redirect`, 'text/plain', 'redirect.txt')],
          undefined,
          dir,
          undefined,
          { allowedHosts: ['127.0.0.1'] },
        );
        expect(textOf(redirected[0])).toContain('private');
        expect(hits).toEqual(['/secret', '/redirect']);
      },
    );
  });

  it('allows private hosts and redirects with one allowPrivate switch', async () => {
    const hits: string[] = [];
    await withDownloadServer(
      (req, res) => {
        hits.push(req.url!);
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/secret' });
          res.end();
        } else res.end('downloaded');
      },
      async (base) => {
        const blocks = await buildMessageContent(
          [
            urlPart(
              `${base.replace('127.0.0.1', 'localhost')}/redirect`,
              'text/plain',
              'secret.txt',
            ),
          ],
          undefined,
          dir,
          undefined,
          { allowPrivate: true },
        );
        expect(textOf(blocks[0])).toContain('size="10"');
        expect(hits).toEqual(['/redirect', '/secret']);

        const callback = vi.fn();
        await new Promise<void>((resolve) => {
          network.state.requests[0].lookup('localhost', { all: true }, (...args: any[]) => {
            callback(...args);
            resolve();
          });
        });
        expect(callback).toHaveBeenCalledWith(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    );
  });

  it('redacts URL credentials from document and failure notes without changing the download', async () => {
    const requested: string[] = [];
    await withDownloadServer(
      (req, res) => {
        requested.push(req.url!);
        if (req.url!.startsWith('/missing')) {
          res.statusCode = 404;
          res.end('nope');
        } else res.end('downloaded');
      },
      async () => {
        const signed = 'https://user:pass@127.0.0.1/signed.txt?token=secret&signature=abc#fragment';
        const blocks = await buildMessageContent(
          [urlPart(signed, 'text/plain', 'signed.txt')],
          undefined,
          dir,
          undefined,
          { allowedHosts: ['127.0.0.1'] },
        );
        expect(textOf(blocks[0])).toContain('uri="https://127.0.0.1/signed.txt"');
        expect(textOf(blocks[0])).not.toContain('user:pass');
        expect(textOf(blocks[0])).not.toContain('token=secret');
        expect(textOf(blocks[0])).not.toContain('signature=abc');
        expect(textOf(blocks[0])).not.toContain('fragment');
        expect(requested[0]).toContain('token=secret&signature=abc');

        const failed = await buildMessageContent(
          [
            urlPart(
              'https://user:pass@127.0.0.1/missing?token=secret#fragment',
              'text/plain',
              'missing.txt',
            ),
          ],
          undefined,
          dir,
          undefined,
          { allowedHosts: ['127.0.0.1'] },
        );
        expect(textOf(failed[0])).toContain('not delivered');
        expect(textOf(failed[0])).toContain('https://127.0.0.1/missing');
        expect(textOf(failed[0])).not.toContain('user:pass');
        expect(textOf(failed[0])).not.toContain('token=secret');
        expect(textOf(failed[0])).not.toContain('fragment');

        const invalid = await buildMessageContent(
          [urlPart('not-a-url?token=secret#fragment', 'text/plain', 'invalid.txt')],
          undefined,
          dir,
        );
        expect(textOf(invalid[0])).not.toContain('not-a-url');
        expect(textOf(invalid[0])).not.toContain('token=secret');
        expect(textOf(invalid[0])).not.toContain('fragment');
      },
    );
  });
});
