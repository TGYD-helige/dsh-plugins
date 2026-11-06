import type { SpanUpdate } from '../core/index.js';
export type Backend = 'langfuse' | 'phoenix';
export interface ConnectionConfig {
  backend: Backend;
  endpoint?: string;
  apiKey?: string;
  project?: string;
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
}
export interface ObservationData extends SpanUpdate {
  kind: 'root' | 'span' | 'agent' | 'tool' | 'generation';
  root?: boolean;
  sessionId?: string;
  traceName?: string;
  userId?: string;
  tags?: string[];
  model?: string;
  modelParameters?: Record<string, string | number>;
  environment?: string;
  release?: string;
}
export type Attributes = Record<string, string | number | boolean | string[]>;

export interface BackendAdapter {
  resolve(
    config: ConnectionConfig,
    env: NodeJS.ProcessEnv,
  ): { endpoint: string; headers: Record<string, string>; project: string; secrets: string[] };
  attributes(data: ObservationData): Attributes;
}
