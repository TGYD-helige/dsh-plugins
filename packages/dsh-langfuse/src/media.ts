import type { AttachmentStore } from '@deepseek-ai/dsh-attachment';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

export interface MediaOptions {
  enabled: boolean;
  maxBytes: number;
  timeoutMs: number;
}

/** Display-only projection. The attachment service owns byte/digest validation. */
export async function displayBlocks(
  content: readonly ContentBlock[],
  attachments: AttachmentStore | undefined,
  options: MediaOptions,
  signal?: AbortSignal,
  budget = { remaining: options.maxBytes },
): Promise<unknown[]> {
  return Promise.all(
    content.map(async (block) => {
      if (block.type !== 'image') return block;
      const ref = block.attachment;
      const fallback = {
        type: 'image',
        mediaType: ref?.mediaType,
        bytes: ref?.bytes,
        width: ref?.width,
        height: ref?.height,
        offloaded: block.offloaded,
      };
      if (
        !options.enabled ||
        !attachments ||
        block.offloaded ||
        !ref ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType) ||
        !Number.isSafeInteger(ref.bytes) ||
        ref.bytes <= 0 ||
        ref.bytes > budget.remaining
      )
        return fallback;
      budget.remaining -= ref.bytes;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('image display timed out')),
        options.timeoutMs,
      );
      timer.unref();
      const readSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let onAbort: (() => void) | undefined;
      try {
        readSignal.throwIfAborted();
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(readSignal.reason);
          readSignal.addEventListener('abort', onAbort, { once: true });
        });
        const { data } = await Promise.race([attachments.readImage(ref, readSignal), aborted]);
        readSignal.throwIfAborted();
        if (data.byteLength !== ref.bytes)
          throw new Error('image byte length does not match its reference');
        return {
          type: 'image_url',
          image_url: {
            url: `data:${ref.mediaType};base64,${Buffer.from(data).toString('base64')}`,
          },
        };
      } catch (error) {
        console.error('[dsh-langfuse] image display failed:', error);
        return fallback;
      } finally {
        clearTimeout(timer);
        if (onAbort) readSignal.removeEventListener('abort', onAbort);
      }
    }),
  );
}
