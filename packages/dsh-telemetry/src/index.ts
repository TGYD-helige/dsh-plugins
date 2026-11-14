import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { adapters } from './adapters/index.js';
import { type CollectorConfig, collect } from './core/index.js';
import { type ReporterConfig, TelemetryReporter } from './core/otel.js';

export type { TraceContext as TelemetryTraceContext } from './core/index.js';
export {
  appendHookEvent,
  type HookInvoked,
  type HookResult,
} from './core/index.js';
export const name = 'dsh-telemetry';
export const inject = [] as string[];
export const Config = Schema.object({
  enabled: Schema.boolean().default(false),
  backend: Schema.union(['phoenix', 'langfuse']).default('phoenix'),
  endpoint: Schema.string().default(''),
  apiKey: Schema.string().role('secret').default(''),
  project: Schema.string().default(''),
  publicKey: Schema.string().default(''),
  secretKey: Schema.string().role('secret').default(''),
  baseUrl: Schema.string().default(''),
  traceName: Schema.string().default('dsh-turn'),
  captureContent: Schema.boolean().default(true),
  redactFields: Schema.array(Schema.string()).default([]),
  userId: Schema.string().default(''),
  tags: Schema.array(Schema.string()).default([]),
  environment: Schema.string().default(''),
  release: Schema.string().default(''),
  captureMedia: Schema.boolean().default(false),
  maxMediaBytes: Schema.number()
    .min(1)
    .step(1)
    .default(5 * 1024 * 1024),
  mediaTimeoutMs: Schema.number().min(1).max(60000).step(1).default(5000),
});
export interface TelemetryPluginConfig extends ReporterConfig, CollectorConfig {
  enabled: boolean;
}
export function apply(ctx: Context, config: TelemetryPluginConfig): Promise<void> | void {
  if (!config.enabled) return;
  config = {
    ...config,
    environment:
      config.environment ||
      process.env.DSH_TELEMETRY_ENVIRONMENT ||
      (config.backend === 'langfuse' ? process.env.LANGFUSE_TRACING_ENVIRONMENT : undefined),
    release: config.release || process.env.DSH_TELEMETRY_RELEASE,
    userId: config.userId || process.env.DSH_TELEMETRY_USER_ID,
  };
  return collect(
    ctx,
    config,
    new TelemetryReporter(config, adapters[config.backend]),
    'telemetry/context',
  );
}
