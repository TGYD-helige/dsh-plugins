import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@a2a-js/sdk';
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMessageContent, uploadsDir } from './content.js';

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

describe('buildMessageContent', () => {
  let dir: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    const blocks = await buildMessageContent(
      [urlPart('https://x.test/f.pdf', 'application/pdf', 'f.pdf')],
      undefined,
      dir,
    );
    expect(textOf(blocks[0])).toContain('HTTP 404');
    expectLogged();
  });

  it('refuses an over-cap download on content-length before reading the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('x', { headers: { 'content-length': String(65 * 1024 * 1024) } }),
      ),
    );
    const store = fakeStore();
    const blocks = await buildMessageContent(
      [urlPart('https://x.test/big.zip', 'application/zip', 'big.zip')],
      store as unknown as AttachmentStore,
      dir,
    );
    expect(store.saveFile).not.toHaveBeenCalled();
    expect(textOf(blocks[0])).toContain('exceeds');
    expectLogged();
  });

  it('refuses an over-cap body when content-length is absent', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream)),
    );
    const blocks = await buildMessageContent(
      [urlPart('https://x.test/big.zip', 'application/zip', 'big.zip')],
      undefined,
      dir,
    );
    expect(textOf(blocks[0])).toContain('exceeds');
    expectLogged();
  });

  it('falls back to the response content-type when the part declares no media type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2]), {
            headers: { 'content-type': 'image/png; charset=binary' },
          }),
      ),
    );
    const store = fakeStore();
    const blocks = await buildMessageContent(
      [urlPart('https://x.test/pic', '', 'pic.png')],
      store as unknown as AttachmentStore,
      dir,
    );
    expect(store.saveImage).toHaveBeenCalledTimes(1);
    expect(store.saveImage.mock.calls[0][0].mediaType).toBe('image/png');
    expect(blocks[0].type).toBe('image');
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('downloaded')),
    );
    const store = fakeStore();
    const blocks = await buildMessageContent(
      [
        part({ $case: 'raw', value: Buffer.from('inline') }, 'text/plain', '../report.txt'),
        urlPart('https://x.test/report.txt', 'text/plain', '../report.txt'),
        part({ $case: 'raw', value: Buffer.from([0x89]) }, 'image/png', 'pic.png'),
      ],
      store as unknown as AttachmentStore,
      dir,
    );
    expect(store.saveFile).not.toHaveBeenCalled();
    expect(store.saveImage).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(dir, 'report.txt'), 'utf8')).toBe('inline');
    expect(await readFile(path.join(dir, 'report-1.txt'), 'utf8')).toBe('downloaded');
    expect(textOf(blocks[0])).toContain(`path="${path.join(dir, 'report.txt')}"`);
    expect(textOf(blocks[0])).toContain('originalName="../report.txt"');
    expect(textOf(blocks[1])).toContain('uri="https://x.test/report.txt"');
    expect(textOf(blocks[1])).toContain('type="text/plain" size="10"');
    expect(blocks[2].type).toBe('image');
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
});
