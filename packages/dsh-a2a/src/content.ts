/**
 * Maps A2A message parts onto dsh content blocks. A turn never fails over
 * part kinds:
 *
 *   - `text` parts stay text;
 *   - file parts (inline `raw` bytes or a `url`) use the composed attachment
 *     store unless a non-image materializer is configured; url parts are
 *     downloaded by the plugin (http/https only, size- and time-bounded);
 *   - an optional deployment materializer puts non-image files into the
 *     active execution world instead of saving a host attachment;
 *   - without a materializer, files with no store (or refused by a store)
 *     persist under the configured upload root (default `<OS temp>/
 *     dsh-a2a-uploads/<date>/`) and the prompt references them by path;
 *   - `data` parts become JSON text.
 *
 * The SDK's admission helpers (admitEncodedFile/admitPromptContent) are not
 * used: they take base64 wire uploads and throw on refusal — this path holds
 * raw bytes and must degrade, never fail.
 */

import { mkdir, writeFile } from 'node:fs/promises';
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

// TODO(verify): the confirmation data-part protocol ({callId, outcome}) maps
// onto the optional dsh-user-approval service (0.1.2+, asks carry the exact
// tool call) — bridge it once a deployment composes that service.
export async function buildMessageContent(
  parts: readonly Part[],
  attachments: AttachmentStore | undefined,
  dir: string,
  materialization?: Materialization,
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
        content.push(await fileContent(c, part, attachments, dir, materialization));
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

/** The directory file parts persist into when they are not attachments. */
export function uploadsDir(root?: string): string {
  // 'sv-SE' renders YYYY-MM-DD; the bucket is local time.
  const segment = new Date().toLocaleDateString('sv-SE').replaceAll('-', '');
  return path.join(root || path.join(os.tmpdir(), 'dsh-a2a-uploads'), segment);
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
  return note(part, mediaType, uri, error instanceof Error ? error.message : String(error));
}

/** Resolve one file part to an attachment block or a workspace file. */
async function fileContent(
  c: FilePartContent,
  part: Part,
  attachments: AttachmentStore | undefined,
  dir: string,
  materialization?: Materialization,
): Promise<ContentBlock> {
  let bytes: Uint8Array;
  let mediaType = part.mediaType;
  let uri: string | undefined;
  try {
    if (c.$case === 'url') {
      uri = c.value;
      const got = await download(uri);
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
  if (attachments && (!materialization || image)) {
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
      return documentBlock(uri, mediaType, bytes.byteLength, readablePath);
    } catch (error) {
      console.error('[dsh-a2a] failed to materialize a file part:', error);
      return note(part, mediaType, uri, 'file materialization failed');
    }
  }
  try {
    const name = sanitizeUploadFileName(part.filename);
    const filePath = await persistUpload(dir, name, bytes);
    return documentBlock(uri, mediaType, bytes.byteLength, filePath);
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
): ContentBlock {
  const attrs = [
    // The basename of the final path, so name= always matches the file on
    // disk — including collision suffixes.
    `name="${attr(path.win32.basename(filePath))}"`,
    uri && `uri="${attr(uri)}"`,
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
  const desc = [
    part.filename && `"${part.filename}"`,
    mediaType && `(${mediaType})`,
    uri && `at ${uri}`,
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

/** Fetch one url part's bytes over http(s), bounded in size and time. */
async function download(uri: string): Promise<{ bytes: Uint8Array; mediaType?: string }> {
  const scheme = new URL(uri).protocol;
  if (scheme !== 'http:' && scheme !== 'https:') {
    throw new Error(`unsupported scheme "${scheme}"`);
  }
  const response = await fetch(uri, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_DOWNLOAD_BYTES) {
    throw new Error(`exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    // Throwing out of the loop cancels the stream via the iterator's return.
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error(`exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit`);
      }
      chunks.push(chunk);
    }
  }
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim() || undefined;
  return { bytes: Buffer.concat(chunks, total), mediaType };
}
