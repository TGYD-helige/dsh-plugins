/**
 * Maps A2A message parts onto dsh content blocks. A turn never fails over
 * part kinds:
 *
 *   - `text` parts stay text;
 *   - file parts (inline `raw` bytes or a `url`) are downloaded by the plugin
 *     (http/https only, size- and time-bounded) when they carry a URL;
 *   - an optional deployment materializer puts non-image files into the
 *     active execution world instead of saving a host attachment;
 *   - without a materializer, non-image files persist under the configured
 *     upload root even when an attachment store exists (default `<OS temp>/
 *     dsh-a2a-uploads/<date>/`) and the prompt references them by path;
 *   - `data` parts become JSON text.
 *
 * The SDK's admission helpers (admitEncodedFile/admitPromptContent) are not
 * used: they take base64 wire uploads and throw on refusal — this path holds
 * raw bytes and must degrade, never fail.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@a2a-js/sdk';
import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';

/** Cap on one url part download. */
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Deployment-owned writer for files read by an agent's active tools. */
export interface A2aFileMaterializer {
  materializeFile(input: {
    contextId: string;
    bytes: Uint8Array;
    filename: string;
    mediaType: string;
  }): Promise<{ readablePath: string }>;
}

interface Materialization {
  contextId: string;
  materializer: A2aFileMaterializer;
}

export interface UrlDownloadOptions {
  /** Allow every private/loopback host in a trusted intranet; HTTP(S), size and time limits still apply. */
  allowPrivate?: boolean;
  /** Private/loopback hosts are refused unless explicitly named here. */
  allowedHosts?: readonly string[];
}

export async function buildMessageContent(
  parts: readonly Part[],
  attachments: AttachmentStore | undefined,
  dir: string,
  materialization?: Materialization,
  downloads: UrlDownloadOptions = {},
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [];
  for (const part of parts) {
    const c = part.content;
    if (!c) continue;
    switch (c.$case) {
      case 'text':
        if (c.value.trim()) content.push({ type: 'text', text: c.value });
        break;
      case 'data':
        content.push({ type: 'text', text: dataText(c.value) });
        break;
      case 'raw':
      case 'url':
        content.push(await fileContent(c, part, attachments, dir, materialization, downloads));
        break;
      default:
        // A part kind this SDK version predates: keep it visible, never drop.
        content.push(
          note(
            part,
            part.mediaType,
            undefined,
            `unsupported part kind "${(c as { $case: string }).$case}"`,
          ),
        );
    }
  }
  if (content.length === 0) {
    throw new Error('dsh-a2a: message must contain at least one usable part');
  }
  return content;
}

/** The directory non-image file parts persist into without a materializer. */
export function uploadsDir(root?: string): string {
  // 'sv-SE' renders YYYY-MM-DD; the bucket is local time.
  const segment = new Date().toLocaleDateString('sv-SE').replaceAll('-', '');
  return path.resolve(root || path.join(os.tmpdir(), 'dsh-a2a-uploads'), segment);
}

type FilePartContent = { $case: 'raw'; value: Uint8Array } | { $case: 'url'; value: string };

/** Log and degrade one file-part failure to a metadata note. */
function failNote(
  part: Part,
  mediaType: string,
  uri: string | undefined,
  label: string,
  error: unknown,
): ContentBlock {
  console.error(`[dsh-a2a] ${label}:`, error);
  const text = error instanceof Error ? error.message : String(error);
  return note(
    part,
    mediaType,
    uri,
    uri ? text.replaceAll(uri, redactedUri(uri) ?? '[redacted URL]') : text,
  );
}

/** Resolve one file part to an attachment block or a workspace file. */
async function fileContent(
  c: FilePartContent,
  part: Part,
  attachments: AttachmentStore | undefined,
  dir: string,
  materialization: Materialization | undefined,
  downloads: UrlDownloadOptions,
): Promise<ContentBlock> {
  let bytes: Uint8Array;
  let mediaType = part.mediaType;
  let uri: string | undefined;
  try {
    if (c.$case === 'url') {
      uri = c.value;
      const got = await download(uri, downloads);
      bytes = got.bytes;
      mediaType ||= got.mediaType ?? '';
    } else {
      bytes = c.value;
    }
  } catch (error) {
    return failNote(part, mediaType, uri, 'failed to read a file part', error);
  }
  const image = attachments?.imageLimits.mediaTypes.includes(
    mediaType.toLowerCase() as ImageMediaType,
  );
  if (attachments && image) {
    const block = await saveAttachment(attachments, bytes, mediaType, part.filename);
    if (block) return block;
  }
  if (materialization && !image) {
    try {
      const { readablePath } = await materialization.materializer.materializeFile({
        contextId: materialization.contextId,
        bytes,
        filename: sanitizeUploadFileName(part.filename),
        mediaType,
      });
      if (!readablePath) throw new Error('materializer returned no readable path');
      return documentBlock(uri, mediaType, bytes.byteLength, readablePath, part.filename);
    } catch (error) {
      console.error('[dsh-a2a] failed to materialize a file part:', error);
      return note(part, mediaType, uri, 'file materialization failed');
    }
  }
  try {
    const name = sanitizeUploadFileName(part.filename);
    const filePath = await persistUpload(dir, name, bytes);
    return documentBlock(uri, mediaType, bytes.byteLength, filePath, part.filename);
  } catch (error) {
    return failNote(part, mediaType, uri, 'failed to persist a file part', error);
  }
}

/** Commit part bytes to the store: image path first, verbatim file on refusal. */
async function saveAttachment(
  attachments: AttachmentStore,
  bytes: Uint8Array,
  mediaType: string,
  filename: string,
): Promise<ContentBlock | undefined> {
  const name = filename || undefined;
  if (attachments.imageLimits.mediaTypes.includes(mediaType.toLowerCase() as ImageMediaType)) {
    try {
      const attachment = await attachments.saveImage({
        data: bytes,
        mediaType: mediaType as ImageMediaType,
        name,
      });
      return { type: 'image', attachment };
    } catch (error) {
      console.error('[dsh-a2a] image admission failed; storing the bytes as a file:', error);
    }
  }
  try {
    const attachment = await attachments.saveFile({ data: bytes, name });
    return { type: 'file', attachment };
  } catch (error) {
    console.error('[dsh-a2a] failed to store an attachment:', error);
    return undefined;
  }
}

/** Save one upload under the upload dir; returns the absolute path. */
async function persistUpload(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  await mkdir(dir, { recursive: true });
  const { name: stem, ext } = path.parse(name);
  for (let attempt = 0; ; attempt++) {
    const candidate = path.join(dir, attempt === 0 ? name : `${stem}-${attempt}${ext}`);
    try {
      await writeFile(candidate, bytes, { flag: 'wx' });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

// Windows refuses these device stems regardless of extension.
const WINDOWS_RESERVED_STEMS = new Set(
  'CON PRN AUX NUL COM1 COM2 COM3 COM4 COM5 COM6 COM7 COM8 COM9 LPT1 LPT2 LPT3 LPT4 LPT5 LPT6 LPT7 LPT8 LPT9'.split(
    ' ',
  ),
);

/**
 * Cross-platform basename with control and Windows-illegal characters
 * stripped; the trailing-dot/space strip also collapses '.' and '..'.
 */
function sanitizeUploadFileName(name: string): string {
  const cleaned = path.win32
    .basename(name)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  const stem = cleaned.split('.')[0].toUpperCase();
  return !cleaned || WINDOWS_RESERVED_STEMS.has(stem) ? 'unnamed-file' : cleaned;
}

/** Tool-readable path stand-in for a file part. */
function documentBlock(
  uri: string | undefined,
  mediaType: string,
  bytes: number,
  filePath: string,
  originalName: string,
): ContentBlock {
  const displayUri = uri ? redactedUri(uri) : undefined;
  const attrs = [
    // The basename of the final path, so name= always matches the file on
    // disk — including collision suffixes.
    `name="${attr(path.win32.basename(filePath))}"`,
    originalName &&
      originalName !== path.win32.basename(filePath) &&
      `originalName="${attr(originalName)}"`,
    displayUri && `uri="${attr(displayUri)}"`,
    mediaType && `type="${attr(mediaType)}"`,
    `size="${bytes}"`,
    `path="${attr(filePath)}"`,
  ]
    .filter(Boolean)
    .join(' ');
  return {
    type: 'text',
    text: `<document ${attrs}>\nThe file is saved at the path above; read or process it with your tools.\n</document>`,
  };
}

function note(
  part: Part,
  mediaType: string,
  uri: string | undefined,
  reason: string,
): ContentBlock {
  const displayUri = uri ? redactedUri(uri) : undefined;
  const desc = [
    part.filename && `"${part.filename}"`,
    mediaType && `(${mediaType})`,
    displayUri && `at ${displayUri}`,
  ]
    .filter(Boolean)
    .join(' ');
  return { type: 'text', text: `[attachment ${desc || 'file'} not delivered: ${reason}]` };
}

/** JSON text stand-in for a structured data part. */
function dataText(value: unknown): string {
  try {
    return `<data>\n${JSON.stringify(value, null, 2) ?? String(value)}\n</data>`;
  } catch {
    return `<data>\n${String(value)}\n</data>`;
  }
}

/** Strip characters that would break attribute position. */
function attr(value: string): string {
  return value.replace(/["\r\n<>]/g, ' ');
}

/** Display-only URL: credentials, query and fragment never enter prompts or notes. */
function redactedUri(uri: string): string | undefined {
  try {
    const parsed = new URL(uri);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

const nonPublic = new BlockList();
for (const [subnet, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  nonPublic.addSubnet(subnet, prefix, 'ipv4');
for (const [subnet, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as const)
  nonPublic.addSubnet(subnet, prefix, 'ipv6');

function assertPublicAddress(address: string): void {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  const value = mapped ?? address;
  const family = isIP(value);
  if (!family || nonPublic.check(value, family === 6 ? 'ipv6' : 'ipv4')) {
    throw new Error(`download targets a private or non-public address: ${address}`);
  }
}

async function safeAddresses(
  hostname: string,
  allowedHosts: ReadonlySet<string>,
  allowPrivate: boolean,
) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowPrivate || allowedHosts.has(host)) return [];
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await dnsLookup(host, { all: true, verbatim: true });
  if (!addresses.length) throw new Error(`download host has no address: ${host}`);
  for (const { address } of addresses) assertPublicAddress(address);
  return addresses;
}

/** Fetch one url part's bytes over http(s), bounded in size, redirects, address and time. */
async function download(
  uri: string,
  options: UrlDownloadOptions,
): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  const allowedHosts = new Set(
    (options.allowedHosts ?? []).map((host) => host.replace(/^\[|\]$/g, '').toLowerCase()),
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('download timed out')),
    DOWNLOAD_TIMEOUT_MS,
  );
  timeout.unref();
  try {
    let current = new URL(uri);
    for (let redirect = 0; ; redirect++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new Error(`unsupported scheme "${current.protocol}"`);
      }
      await safeAddresses(current.hostname, allowedHosts, options.allowPrivate === true);
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const request = (current.protocol === 'http:' ? httpRequest : httpsRequest)(
          current,
          {
            signal: controller.signal,
            lookup: (hostname, lookupOptions, callback) => {
              const allowed =
                options.allowPrivate === true ||
                allowedHosts.has(hostname.replace(/^\[|\]$/g, '').toLowerCase());
              const resolving = allowed
                ? dnsLookup(hostname, { all: lookupOptions.all ?? false }).then((entry) =>
                    Array.isArray(entry) ? entry : [entry],
                  )
                : safeAddresses(hostname, allowedHosts, false);
              void resolving.then(
                (addresses) => {
                  if (lookupOptions.all) return callback(null, addresses);
                  const { address, family } = addresses[0];
                  callback(null, address, family);
                  return addresses;
                },
                (error) => callback(error, '', 0),
              );
            },
          },
          resolve,
        );
        request.on('socket', (socket) => {
          socket.once('connect', () => {
            if (options.allowPrivate === true) return;
            if (allowedHosts.has(current.hostname.replace(/^\[|\]$/g, '').toLowerCase())) return;
            try {
              assertPublicAddress(socket.remoteAddress ?? '');
            } catch (error) {
              request.destroy(error as Error);
            }
          });
        });
        request.on('error', reject);
        request.end();
      });
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (redirect >= 5) throw new Error('too many download redirects');
        current = new URL(location, current);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        throw new Error(`HTTP ${status}`);
      }
      const declared = Number(response.headers['content-length']);
      if (declared > MAX_DOWNLOAD_BYTES) {
        response.destroy();
        throw new Error(`exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit`);
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for await (const chunk of response) {
          total += chunk.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) {
            throw new Error(`exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit`);
          }
          chunks.push(chunk);
        }
      } catch (error) {
        response.destroy();
        throw error;
      }
      const contentType = response.headers['content-type'];
      const mediaType = (Array.isArray(contentType) ? contentType[0] : contentType)
        ?.split(';')[0]
        .trim();
      return { bytes: Buffer.concat(chunks, total), mediaType: mediaType || undefined };
    }
  } finally {
    clearTimeout(timeout);
  }
}
