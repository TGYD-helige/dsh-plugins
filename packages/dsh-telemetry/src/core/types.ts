import type { TokenUsage } from '@deepseek-ai/dsh-llm';
export type ObservationLevel = 'DEFAULT' | 'WARNING' | 'ERROR';
export interface TraceContext {
  userId?: string;
  tags?: string[];
  traceparent?: string;
  metadata?: Record<string, unknown>;
}
export interface SpanInput {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  asType?: 'tool' | 'agent';
  startTime?: Date;
  model?: string;
  modelParameters?: Record<string, string | number>;
}
export interface SpanUpdate {
  name?: string;
  input?: unknown;
  output?: unknown;
  usage?: TokenUsage;
  completionStartTime?: Date;
  level?: ObservationLevel;
  statusMessage?: string;
  metadata?: Record<string, unknown>;
}
export interface InstrumentationReporter {
  readonly ready: Promise<void>;
  mask<T>(data: T): T;
  shouldRedactField(key: string): boolean;
  openTrace(input: {
    name: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    context?: TraceContext;
    startTime?: Date;
    traceId?: string;
  }): object | null;
  updateContext(span: object | null, context: TraceContext): void;
  startSpan(parent: object | null, input: SpanInput): object | null;
  startGeneration(parent: object | null, input: SpanInput): object | null;
  updateSpan(span: object | null, update: SpanUpdate): void;
  endSpan(span: object | null, update?: SpanUpdate, endedAt?: Date): void;
  endGeneration(span: object | null, update: SpanUpdate, endedAt?: Date): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}
