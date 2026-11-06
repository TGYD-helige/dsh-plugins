import type { SpanUpdate } from '@amaster.ai/dsh-langfuse/instrumentation';
import { usageOf } from '@amaster.ai/dsh-langfuse/instrumentation';

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
export function resolveConnection(
  config: ConnectionConfig,
  env: NodeJS.ProcessEnv = process.env,
): { endpoint: string; headers: Record<string, string>; project: string; secrets: string[] } {
  if (config.backend === 'phoenix') {
    const base = config.endpoint || env.PHOENIX_COLLECTOR_ENDPOINT || 'http://localhost:6006';
    const key = config.apiKey || env.PHOENIX_API_KEY || '';
    return {
      endpoint: traceEndpoint(base, '/v1/traces'),
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      project: config.project || env.PHOENIX_PROJECT || env.PHOENIX_PROJECT_NAME || 'default',
      secrets: [key].filter(Boolean),
    };
  }
  const publicKey = config.publicKey || env.LANGFUSE_PUBLIC_KEY || '';
  const secretKey = config.secretKey || env.LANGFUSE_SECRET_KEY || '';
  if (!publicKey || !secretKey) throw new Error('Langfuse requires publicKey and secretKey');
  return {
    endpoint: traceEndpoint(
      config.endpoint || config.baseUrl || env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
      '/api/public/otel/v1/traces',
    ),
    headers: {
      Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,
    },
    project: '', // Langfuse keys select the project.
    secrets: [publicKey, secretKey],
  };
}
function traceEndpoint(base: string, suffix: string) {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid telemetry collector endpoint');
  url.pathname = url.pathname.replace(/\/$/, '');
  if (!url.pathname.endsWith('/v1/traces')) url.pathname += suffix;
  return url.toString();
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

/** Mapping only: IDs, clocks, parents and export lifecycle belong to the shared reporter. */
export function adapt(backend: Backend, data: ObservationData): Attributes {
  const attributes: Attributes = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined)
      attributes[key] =
        typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean);
  };
  set('session.id', data.sessionId);
  set('user.id', data.userId);
  if (backend === 'langfuse') {
    set(
      'langfuse.observation.type',
      data.kind === 'generation' ? 'generation' : data.kind === 'tool' ? 'tool' : 'span',
    );
    set('langfuse.trace.name', data.traceName);
    if (data.tags?.length) attributes['langfuse.trace.tags'] = data.tags;
    set('langfuse.observation.input', data.input);
    set('langfuse.observation.output', data.output);
    set('langfuse.observation.metadata', data.metadata);
    // Explicit per-key runtime metadata retains the legacy collision policy.
    for (const [key, value] of Object.entries(data.metadata ?? {}))
      set(`langfuse.observation.metadata.${key}`, value);
    set('langfuse.observation.model.name', data.model);
    set('langfuse.observation.model.parameters', data.modelParameters);
    set('langfuse.observation.usage_details', data.usage ? usageOf(data.usage) : undefined);
    set('langfuse.observation.completion_start_time', data.completionStartTime?.toISOString());
    set('langfuse.observation.level', data.level);
    set('langfuse.observation.status_message', data.statusMessage);
    set('langfuse.environment', data.environment);
    set('langfuse.release', data.release);
    if (data.kind === 'root') set('langfuse.internal.is_app_root', data.root);
    if (data.root) {
      set('langfuse.trace.input', data.input);
      set('langfuse.trace.output', data.output);
    }
  } else {
    set(
      'openinference.span.kind',
      data.kind === 'generation'
        ? 'LLM'
        : data.kind === 'tool'
          ? 'TOOL'
          : data.kind === 'root' || data.kind === 'agent'
            ? 'AGENT'
            : 'CHAIN',
    );
    set('input.value', data.input);
    set('output.value', data.output);
    if (data.input !== undefined)
      set('input.mime_type', typeof data.input === 'string' ? 'text/plain' : 'application/json');
    if (data.output !== undefined)
      set('output.mime_type', typeof data.output === 'string' ? 'text/plain' : 'application/json');
    set('metadata', { ...data.metadata, environment: data.environment, release: data.release });
    if (data.tags?.length) attributes['tag.tags'] = data.tags;
    set('llm.model_name', data.model);
    set('llm.invocation_parameters', data.modelParameters);
    if (data.kind === 'tool') {
      set('tool.name', data.name);
      set('tool.parameters', data.input);
    }
    if (data.usage) {
      const usage = data.usage;
      const input =
        (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
      set('llm.token_count.prompt', input);
      set('llm.token_count.completion', usage.outputTokens ?? 0);
      set('llm.token_count.total', input + (usage.outputTokens ?? 0));
      set('llm.token_count.prompt_details.cache_read', usage.cacheReadTokens);
      set('llm.token_count.prompt_details.cache_write', usage.cacheWriteTokens);
      set('llm.token_count.completion_details.reasoning', usage.reasoningTokens);
    }
    if (data.kind === 'generation') {
      const input = data.input as
        | { system?: string; messages?: unknown[]; tools?: unknown[] }
        | undefined;
      const messages = [
        ...(input?.system ? [{ role: 'system', content: input.system }] : []),
        ...(input?.messages ?? []),
      ];
      messages.forEach((message, i) => {
        mapMessage(attributes, `llm.input_messages.${i}`, message);
      });
      if (data.output)
        mapMessage(
          attributes,
          'llm.output_messages.0',
          typeof data.output === 'string'
            ? { role: 'assistant', content: data.output }
            : data.output,
        );
      input?.tools?.forEach((tool, i) => {
        set(`llm.tools.${i}.tool.json_schema`, tool);
      });
    }
  }
  return attributes;
}
function mapMessage(attributes: Attributes, prefix: string, value: unknown) {
  if (!value || typeof value !== 'object') return;
  const message = value as Record<string, unknown>;
  if (typeof message.role === 'string') attributes[`${prefix}.message.role`] = message.role;
  if (typeof message.toolCallId === 'string')
    attributes[`${prefix}.message.tool_call_id`] = message.toolCallId;
  if (typeof message.tool_call_id === 'string')
    attributes[`${prefix}.message.tool_call_id`] = message.tool_call_id;
  if (typeof message.content === 'string')
    attributes[`${prefix}.message.content`] = message.content;
  if (Array.isArray(message.thinking))
    message.thinking.forEach((block: { content?: string }, i: number) => {
      if (block.content) {
        attributes[`${prefix}.message.contents.${i}.message_content.type`] = 'text';
        attributes[`${prefix}.message.contents.${i}.message_content.text`] = block.content;
      }
    });
  if (typeof message.reasoning_content === 'string')
    attributes[`${prefix}.message.contents.0.message_content.text`] = message.reasoning_content;
  if (Array.isArray(message.content)) {
    const text: string[] = [];
    message.content.forEach((block: Record<string, unknown>, i: number) => {
      if (block.type === 'text' && typeof block.text === 'string') text.push(block.text);
      if (block.type === 'image_url') {
        const image = block.image_url as { url?: string } | undefined;
        if (image?.url) {
          attributes[`${prefix}.message.contents.${i}.message_content.type`] = 'image';
          attributes[`${prefix}.message.contents.${i}.message_content.image.image.url`] = image.url;
        }
      }
      if (block.type === 'tool-result' && typeof block.toolCallId === 'string')
        attributes[`${prefix}.message.tool_call_id`] = block.toolCallId;
    });
    if (text.length) attributes[`${prefix}.message.content`] = text.join('\n');
  }
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : Array.isArray(message.content)
      ? message.content.filter((b: { type: string }) => b.type === 'tool-call')
      : [];
  calls.forEach((call: Record<string, unknown>, i: number) => {
    const fn = call.function as { name?: string; arguments?: unknown } | undefined;
    for (const [key, value] of Object.entries({
      id: call.id,
      'function.name': fn?.name ?? call.name,
      'function.arguments': fn?.arguments ?? call.arguments,
    }))
      if (value !== undefined)
        attributes[`${prefix}.message.tool_calls.${i}.tool_call.${key}`] =
          typeof value === 'string' ? value : JSON.stringify(value);
  });
}
