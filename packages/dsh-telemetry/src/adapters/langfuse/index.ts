import { usageOf } from '../../core/index.js';
import { traceEndpoint } from '../endpoint.js';
import type { Attributes, BackendAdapter, ConnectionConfig, ObservationData } from '../types.js';

function resolve(config: ConnectionConfig, env: NodeJS.ProcessEnv) {
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
    project: '',
    secrets: [publicKey, secretKey],
  };
}
function map(data: ObservationData): Attributes {
  const attributes: Attributes = {};
  const set = (key: string, value: unknown) => {
    if (value !== undefined)
      attributes[key] =
        typeof value === 'object' ? JSON.stringify(value) : (value as string | number | boolean);
  };
  Object.assign(attributes, langfuseContextAttributes(data));
  set(
    'langfuse.observation.type',
    data.kind === 'generation' ? 'generation' : data.kind === 'tool' ? 'tool' : 'span',
  );
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
  return attributes;
}

export const langfuse: BackendAdapter = { resolve, attributes: map };

/** Extracted from the legacy reporter; context is masked by each caller before mapping. */
export function langfuseContextAttributes(
  context: Pick<ObservationData, 'sessionId' | 'traceName' | 'userId' | 'tags' | 'metadata'>,
): Attributes {
  const attributes: Attributes = {};
  if (context.traceName) attributes['langfuse.trace.name'] = context.traceName;
  if (context.sessionId) attributes['session.id'] = context.sessionId;
  if (context.userId) attributes['user.id'] = context.userId;
  if (context.tags?.length) attributes['langfuse.trace.tags'] = context.tags;
  if (context.metadata)
    attributes['langfuse.observation.metadata'] = JSON.stringify(context.metadata);
  return attributes;
}
