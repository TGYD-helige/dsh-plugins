import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import {
  createOtlpNetworkExportDelegate,
  type ExportResponse,
  OTLPExporterError,
} from '@opentelemetry/otlp-exporter-base';
import {
  convertLegacyHttpOptions,
  createOtlpHttpExporterMetrics,
} from '@opentelemetry/otlp-exporter-base/node-http';
import {
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
} from '@opentelemetry/otlp-transformer';
import type { SpanExporter } from '@opentelemetry/sdk-trace-node';

interface BatchDeadline {
  signal: AbortSignal;
  expiresAt: number;
}

const compress = promisify(gzip);
const retryableStatuses = new Set([429, 502, 503, 504]);
const retryableNetworkErrors = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

function retryAfterMillis(header: string | undefined) {
  if (header === undefined) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function readResponse(response: IncomingMessage): Promise<ExportResponse> {
  const status = response.statusCode ?? 0;
  const ok = status >= 200 && status < 300;
  const parts: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of response) {
      length += chunk.length;
      if (length > 4 * 1024 * 1024)
        return { status: 'failure', error: new Error('OTLP response exceeds 4 MiB') };
      if (ok) parts.push(chunk);
    }
  } catch {
    // Once a 2xx arrives, failure to read its optional partial-success message does not undo delivery.
    if (ok) return { status: 'success' };
  }
  if (ok) return { status: 'success', data: Buffer.concat(parts) };
  const error = new OTLPExporterError('OTLP HTTP export failed', status);
  return retryableStatuses.has(status)
    ? {
        status: 'retryable',
        error,
        retryInMillis: retryAfterMillis(response.headers['retry-after']),
      }
    : { status: 'failure', error };
}

export async function createTraceExporter(url: string, headers: Record<string, string>) {
  const options = convertLegacyHttpOptions({ url, headers }, 'TRACES', 'v1/traces', {
    'Content-Type': 'application/x-protobuf',
  });
  const endpoint = new URL(options.url);
  const { request } =
    endpoint.protocol === 'https:' ? await import('node:https') : await import('node:http');
  const agent = await options.agentFactory(endpoint.protocol);
  // Only this transport reads the deadline. Host diagnostic sinks retain their own HTTP lifecycle.
  const scope = new AsyncLocalStorage<BatchDeadline>();
  const metrics = createOtlpHttpExporterMetrics(
    'otlp_http_span_exporter',
    TraceExporterMetricsHelper,
    options.url,
    undefined,
  );
  const delegate = createOtlpNetworkExportDelegate(options, ProtobufTraceSerializer, metrics, {
    async send(data, timeoutMillis) {
      const batch = scope.getStore()!;
      const expiresAt = Math.min(batch.expiresAt, performance.now() + timeoutMillis);
      const signal =
        expiresAt === batch.expiresAt
          ? batch.signal
          : AbortSignal.any([
              batch.signal,
              AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMillis))),
            ]);
      signal.throwIfAborted();
      const requestHeaders: Record<string, string> = {
        ...(await options.headers()),
        'User-Agent': 'OTel-OTLP-Exporter-JavaScript/0.221.0',
      };
      let body = data;
      if (options.compression === 'gzip') {
        requestHeaders['Content-Encoding'] = 'gzip';
        body = await compress(data);
      }
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        if (performance.now() >= expiresAt) throw new Error('Timeout');
        let result: ExportResponse;
        try {
          const response = await new Promise<IncomingMessage>((resolve, reject) => {
            request(endpoint, { method: 'POST', headers: requestHeaders, agent, signal }, resolve)
              .on('error', reject)
              .end(body);
          });
          result = await readResponse(response);
        } catch (error) {
          signal.throwIfAborted();
          if (!retryableNetworkErrors.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
          result = { status: 'retryable', error: error as Error };
        }
        if (result.status !== 'retryable' || attempt === 5) return result;
        const backoff = Math.min(1000 * 1.5 ** attempt * (0.8 + Math.random() * 0.4), 5000);
        const wait = result.retryInMillis ?? backoff;
        if (wait >= expiresAt - performance.now()) return result;
        await delay(wait, undefined, { signal });
      }
    },
    shutdown: () => agent.destroy(),
  });
  return {
    export(
      spans: Parameters<SpanExporter['export']>[0],
      callback: Parameters<SpanExporter['export']>[1],
      batch: BatchDeadline,
    ) {
      scope.run(batch, () => delegate.export(spans, callback));
    },
    shutdown: () => delegate.shutdown(),
  };
}
