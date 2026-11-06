/**
 * dsh-langfuse — Langfuse observability for DeepSeek Harness.
 *
 * Instruments the documented seams, with zero core patches:
 *
 * - `llm/stream` waterfall  → one Langfuse **generation** per LLM call
 *   (input = loop-built options; output, token usage and finish reason collected
 *   from the chunk stream), plus a nested `llm-request` **span** holding the
 *   same options and collected chunk stream (the rawest request/response a
 *   plugin can observe — the provider HTTP body is assembled inside the adapter).
 * - `tools/pre-execute` → `tools/result` → one Langfuse **span** per tool pipeline
 *   (routed to the session's trace via `exec.agent.id` — the agent/session
 *   shared identity).
 * - `hook/invoked` / `hook/result` session records → one **span** per hook run.
 * - `session/event` emit    → one Langfuse **trace** per agent turn
 *   (`turn/start` records the start; actual activity opens the root — in v5 it IS
 *   the trace — the turn's first `user/message` sets the input, `turn/end`
 *   stamps the end reason and ends the root, which is what exports it).
 * - Native A2A inbox tasks own a trace spanning admission through task termination;
 *   agent turns and queue controls are children of that task.
 * - subagent child sessions (`session/created` with `header.parentSession`)
 *   ride the parent's trace: a `subagent` **span** opened under the enclosing
 *   delegation tool span, the child's generations/tool spans nested under it,
 *   closed at `subagent/end` (enriched by `subagent/start` and the child's
 *   `subagent/descriptor` event).
 *
 * Event/waterfall shapes verified against the installed
 * @deepseek-ai/dsh-{llm,session,tools,agent,subagent}@0.2.0-rc.1 package sources
 * (types for shapes; `lib/*.js` for the session/created ordering claim).
 *
 * @module dsh-langfuse
 */

import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { LangfuseReporter } from './client.js';
import { type CollectorConfig, collect } from './collector.js';

export type { LangfuseTraceContext } from './client.js';
export { appendHookEvent, type HookInvoked, type HookResult } from './hooks.js';

export const name = 'dsh-langfuse';

/**
 * Waterfall listeners only need the events to exist; no hard service
 * dependency is declared so the plugin still loads in minimal compositions
 * (it simply never observes anything). Add 'llm' / 'tools' to `inject` if you
 * prefer fail-fast wiring.
 */
export const inject = [] as string[];

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('master switch'),
  publicKey: Schema.string().default('').description('Langfuse public key'),
  secretKey: Schema.string().role('secret').default('').description('Langfuse secret key'),
  baseUrl: Schema.string()
    .default('')
    .description('profile override for LANGFUSE_BASE_URL; defaults to EU cloud'),
  traceName: Schema.string().default('dsh-turn'),
  /** Include full message/tool payloads in Langfuse IO. Disable to log metadata only. */
  captureContent: Schema.boolean().default(true),
  maxPayloadBytes: Schema.number()
    .min(1)
    .step(1)
    .default(256 * 1024)
    .description(
      'maximum captured request, raw-stream, assembled-output, or tool input/output/status bytes',
    ),
  redactFields: Schema.array(Schema.string())
    .default([])
    .description('case-insensitive payload fields to redact'),
  userId: Schema.string().default(''),
  tags: Schema.array(Schema.string()).default([]),
  environment: Schema.string().default(''),
  release: Schema.string().default(''),
  captureMedia: Schema.boolean()
    .default(false)
    .description('upload attachment images for display; requires captureContent'),
  maxMediaBytes: Schema.number()
    .min(1)
    .step(1)
    .default(5 * 1024 * 1024)
    .description('image byte budget per display payload'),
  mediaTimeoutMs: Schema.number().min(1).max(60_000).step(1).default(5000),
});

export interface LangfusePluginConfig extends CollectorConfig {
  enabled: boolean;
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  traceName: string;
  captureContent: boolean;
  maxPayloadBytes?: number;
  redactFields?: string[];
  userId?: string;
  tags?: string[];
  environment?: string;
  release?: string;
  captureMedia?: boolean;
  maxMediaBytes?: number;
  mediaTimeoutMs?: number;
}

export function apply(ctx: Context, config: LangfusePluginConfig): Promise<void> | void {
  if (!config.enabled || /^(false|0)$/i.test(process.env.LANGFUSE_TRACING_ENABLED ?? '')) return;
  config = {
    ...config,
    publicKey: config.publicKey || process.env.LANGFUSE_PUBLIC_KEY || '',
    secretKey: config.secretKey || process.env.LANGFUSE_SECRET_KEY || '',
    baseUrl: config.baseUrl || process.env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
    userId: config.userId || process.env.LANGFUSE_USER_ID,
  };
  if (!config.publicKey || !config.secretKey) return;

  const reporter = new LangfuseReporter(config);
  return collect(
    ctx,
    {
      ...config,
      mediaEnabled: !/^(false|0)$/i.test(process.env.LANGFUSE_MEDIA_UPLOAD_ENABLED ?? ''),
    },
    reporter,
  );
}
