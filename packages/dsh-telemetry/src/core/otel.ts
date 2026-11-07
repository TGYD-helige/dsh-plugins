import type { Span, SpanContext, Tracer } from '@opentelemetry/api';
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type {
  Attributes,
  BackendAdapter,
  ConnectionConfig,
  ObservationData,
} from '../adapters/types.js';
import {
  boundPayload,
  createTraceIdGenerator,
  type InstrumentationReporter,
  newPayloadBudget,
  PayloadPrivacy,
  type SpanInput,
  type SpanUpdate,
  type TraceContext,
} from './index.js';

export interface ReporterConfig extends ConnectionConfig {
  captureContent: boolean;
  maxPayloadBytes?: number;
  redactFields?: string[];
  environment?: string;
  release?: string;
  userId?: string;
  tags?: string[];
}
interface Observation {
  span: Span;
  startedAt: number;
  data: ObservationData;
  ended?: boolean;
  contextMetadata?: Record<string, unknown>;
}

/** One isolated OTel tree and one exporter, independent of the selected attribute adapter. */
export class TelemetryReporter implements InstrumentationReporter {
  readonly ready: Promise<void>;
  private api?: typeof import('@opentelemetry/api');
  private provider?: NodeTracerProvider;
  private tracer?: Tracer;
  private ids?: ReturnType<typeof createTraceIdGenerator>;
  private observations = new WeakMap<object, Observation>();
  private privacy: PayloadPrivacy;
  constructor(
    private config: ReporterConfig,
    private adapter: BackendAdapter,
  ) {
    this.privacy = new PayloadPrivacy({ secrets: [], redactFields: config.redactFields });
    this.ready = this.init();
  }
  mask<T>(data: T): T {
    return this.privacy.mask(data);
  }
  shouldRedactField(key: string) {
    return this.privacy.shouldRedactField(key);
  }
  private failure(operation: string, error?: unknown) {
    const errors = Array.isArray(error) ? error : [error];
    const categories = errors.map((item) => {
      if (!(item instanceof Error)) return 'unknown';
      const code = (item as Error & { code?: number }).code;
      if (typeof code === 'number') return `HTTP ${code}`;
      const match = item.message.match(
        /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|Timeout|timeout|timed out|aborted)\b/,
      );
      return match?.[0] ?? item.name;
    });
    console.error(`[dsh-telemetry] ${operation} failed (${categories.join(', ')})`);
  }
  private async init() {
    try {
      const connection = this.adapter.resolve(this.config, process.env);
      // Encoded authentication is a credential too, should it reappear in request metadata.
      this.privacy = new PayloadPrivacy({
        secrets: [
          ...connection.secrets,
          ...Object.values(connection.headers),
          ...Object.values(connection.headers).map((v) => v.replace(/^(Basic|Bearer) /, '')),
        ],
        redactFields: this.config.redactFields,
      });
      const [api, sdk, exporter, resources] = await Promise.all([
        import('@opentelemetry/api'),
        import('@opentelemetry/sdk-trace-node'),
        import('@opentelemetry/exporter-trace-otlp-proto'),
        import('@opentelemetry/resources'),
      ]);
      const transport = new exporter.OTLPTraceExporter({
        url: connection.endpoint,
        headers: connection.headers,
      });
      this.ids = createTraceIdGenerator(new sdk.RandomIdGenerator());
      this.provider = new sdk.NodeTracerProvider({
        idGenerator: this.ids,
        resource: resources.resourceFromAttributes({
          'service.name': 'dsh-telemetry',
          ...this.mask(connection.resourceAttributes),
          ...(this.config.environment
            ? { 'deployment.environment.name': this.mask(this.config.environment) }
            : {}),
        }),
        spanLimits: {
          attributeCountLimit: 2048,
          attributeValueLengthLimit: this.config.maxPayloadBytes ?? 256 * 1024,
        },
        spanProcessors: [
          new sdk.BatchSpanProcessor(transport, {
            scheduledDelayMillis: 1000,
          }),
        ],
      });
      this.api = api;
      this.tracer = this.provider.getTracer('dsh-telemetry', '0.1.0');
    } catch (error) {
      this.failure('initialization', error);
    }
  }
  private parent(traceparent?: string): SpanContext | undefined {
    if (traceparent === undefined) return;
    const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent);
    if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) {
      console.error('[dsh-telemetry] invalid traceparent; starting an independent trace');
      return;
    }
    return {
      traceId: match[1],
      spanId: match[2],
      traceFlags: parseInt(match[3], 16) & 1,
      isRemote: true,
    };
  }
  private start(
    data: ObservationData,
    parent?: SpanContext,
    startTime?: Date,
    traceId?: string,
  ): object | null {
    const api = this.api;
    const tracer = this.tracer;
    const ids = this.ids;
    if (!api || !tracer || !ids) return null;
    try {
      const context = parent
        ? api.trace.setSpanContext(api.ROOT_CONTEXT, parent)
        : api.ROOT_CONTEXT;
      const startedAt = startTime?.getTime() ?? Date.now();
      const span = ids.withTraceId(traceId, () =>
        tracer.startSpan(
          this.mask(data.name ?? 'span'),
          { startTime: new Date(startedAt) },
          context,
        ),
      );
      const handle = {};
      this.observations.set(handle, { span, startedAt, data: this.mask(data) });
      return handle;
    } catch {
      this.failure('span creation');
      return null;
    }
  }
  openTrace(input: {
    name: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    context?: TraceContext;
    startTime?: Date;
    traceId?: string;
  }): object | null {
    const external = this.parent(input.context?.traceparent);
    const handle = this.start(
      {
        kind: 'root',
        name: input.name,
        sessionId: input.sessionId,
        root: !external,
        traceName: external ? undefined : input.name,
        userId: input.context?.userId ?? this.config.userId,
        tags: input.context?.tags ?? this.config.tags,
        metadata: { ...input.context?.metadata, ...input.metadata },
        environment: this.config.environment,
        release: this.config.release,
      },
      external,
      input.startTime,
      external ? undefined : input.traceId,
    );
    if (handle) this.observations.get(handle)!.contextMetadata = this.mask(input.context?.metadata);
    return handle;
  }
  updateContext(handle: object | null, context: TraceContext) {
    if (!handle) return;
    try {
      const observation = this.observations.get(handle);
      if (!observation || observation.ended) return;
      observation.data = this.mask({
        ...observation.data,
        userId: context.userId ?? observation.data.userId,
        tags: context.tags ?? observation.data.tags,
        metadata: { ...observation.data.metadata, ...context.metadata },
      });
      observation.contextMetadata = this.mask(context.metadata ?? observation.contextMetadata);
      const parent = this.parent(context.traceparent);
      if (parent) observation.span.addLink({ context: parent });
    } catch {
      this.failure('context update');
    }
  }
  private child(parent: object | null, input: SpanInput, kind: ObservationData['kind']) {
    if (!parent) return null;
    const observation = this.observations.get(parent);
    if (!observation) return null;
    const { sessionId, traceName, userId, tags, environment, release } = observation.data;
    // Only request dimensions propagate; runtime facts belong to their individual span.
    const handle = this.start(
      {
        kind,
        sessionId,
        traceName,
        userId,
        tags,
        environment,
        release,
        ...input,
        metadata: { ...observation.contextMetadata, ...input.metadata },
      },
      observation.span.spanContext(),
      input.startTime,
    );
    if (handle) this.observations.get(handle)!.contextMetadata = observation.contextMetadata;
    return handle;
  }
  startSpan(parent: object | null, input: SpanInput) {
    return this.child(
      parent,
      input,
      input.asType === 'tool' ? 'tool' : input.asType === 'agent' ? 'agent' : 'span',
    );
  }
  startGeneration(parent: object | null, input: SpanInput) {
    return this.child(parent, input, 'generation');
  }
  updateSpan(handle: object | null, update: SpanUpdate) {
    if (!handle) return;
    try {
      const observation = this.observations.get(handle);
      if (!observation || observation.ended) return;
      const values = Object.fromEntries(
        Object.entries(update).filter(([, value]) => value !== undefined),
      );
      observation.data = this.mask({
        ...observation.data,
        ...values,
        metadata: { ...observation.data.metadata, ...update.metadata },
      });
    } catch {
      this.failure('span update');
    }
  }
  private attributes(data: ObservationData): Attributes {
    const cap = this.config.maxPayloadBytes ?? 256 * 1024;
    const bounded = { ...data };
    for (const key of ['input', 'output'] as const) {
      if (!this.config.captureContent) delete bounded[key];
      else if (bounded[key] !== undefined)
        bounded[key] = boundPayload(bounded[key], newPayloadBudget(cap), this);
    }
    if (!this.config.captureContent) delete bounded.statusMessage;
    const attributes = this.adapter.attributes(bounded);
    // Final safeguard AFTER adaptation, including indexed OpenInference messages and JSON fields.
    const safe: Attributes = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (
        !this.config.captureContent &&
        this.adapter.contentPrefixes.some((prefix) => key.startsWith(prefix))
      )
        continue;
      const item = boundPayload(value, newPayloadBudget(cap), this);
      safe[this.mask(key)] = Array.isArray(item)
        ? (item as string[])
        : typeof item === 'object'
          ? JSON.stringify(item)
          : item;
    }
    return safe;
  }
  endSpan(handle: object | null, update: SpanUpdate = {}, endedAt?: Date) {
    if (!handle) return;
    const observation = this.observations.get(handle);
    if (!observation || observation.ended) return;
    this.updateSpan(handle, update);
    observation.ended = true;
    try {
      observation.span.updateName(this.mask(observation.data.name ?? 'span'));
      observation.span.setAttributes(this.attributes(observation.data));
      if (observation.data.kind === 'generation' && observation.data.completionStartTime) {
        const milliseconds = observation.data.completionStartTime.getTime() - observation.startedAt;
        if (Number.isFinite(milliseconds) && milliseconds >= 0) {
          const seconds = milliseconds / 1000;
          observation.span.setAttributes({
            'llm.time_to_first_token_ms': milliseconds,
            'llm.time_to_first_token_seconds': seconds,
          });
          observation.span.addEvent(
            'first_token',
            {
              time_to_first_token_ms: milliseconds,
              time_to_first_token_seconds: seconds,
            },
            observation.data.completionStartTime,
          );
        }
      }
      observation.span.setStatus({
        code: observation.data.level === 'ERROR' ? 2 : observation.data.level === 'WARNING' ? 0 : 1,
        message: this.config.captureContent ? this.mask(observation.data.statusMessage) : undefined,
      });
    } catch {
      this.failure('span finalization');
    } finally {
      try {
        observation.span.end(endedAt);
      } catch {
        this.failure('span end');
      }
    }
  }
  endGeneration(handle: object | null, update: SpanUpdate, endedAt?: Date) {
    this.endSpan(handle, update, endedAt);
  }
  async flush() {
    await this.ready;
    try {
      await this.provider?.forceFlush();
    } catch (error) {
      this.failure('flush', error);
    }
  }
  async shutdown() {
    await this.ready;
    const provider = this.provider;
    this.provider = undefined;
    this.tracer = undefined;
    this.api = undefined;
    try {
      await provider?.shutdown();
    } catch (error) {
      this.failure('shutdown', error);
    }
  }
}
