import { describe, expect, it } from 'vitest';
import { adapt, resolveConnection } from './adapters/index.js';

describe('backend adapters', () => {
  it('resolves Phoenix YAML overrides, env fallback and prefixed collector URLs', () => {
    expect(
      resolveConnection(
        { backend: 'phoenix', project: 'yaml-project' },
        {
          PHOENIX_COLLECTOR_ENDPOINT: 'https://example.com/s/team',
          PHOENIX_API_KEY: 'secret',
          PHOENIX_PROJECT: 'env-project',
        },
      ),
    ).toEqual({
      endpoint: 'https://example.com/s/team/v1/traces',
      headers: { Authorization: 'Bearer secret' },
      resourceAttributes: { 'openinference.project.name': 'yaml-project' },
      secrets: ['secret'],
    });
  });
  it('maps the same generation into OpenInference messages and exclusive Langfuse usage', () => {
    const data = {
      kind: 'generation' as const,
      model: 'deepseek-v4-flash',
      input: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] },
      output: { role: 'assistant', content: 'world', reasoning_content: 'think' },
      usage: { inputTokens: 4, cacheReadTokens: 2, outputTokens: 5, reasoningTokens: 3 },
      sessionId: 's',
    };
    expect(adapt('phoenix', data)).toMatchObject({
      'openinference.span.kind': 'LLM',
      'llm.model_name': 'deepseek-v4-flash',
      'llm.token_count.prompt': 6,
      'llm.token_count.completion': 5,
      'llm.input_messages.0.message.role': 'user',
      'llm.input_messages.0.message.content': 'hello',
      'llm.output_messages.0.message.role': 'assistant',
      'session.id': 's',
    });
    expect(adapt('langfuse', data)).toMatchObject({
      'langfuse.observation.type': 'generation',
      'langfuse.observation.model.name': 'deepseek-v4-flash',
      'langfuse.observation.usage_details': JSON.stringify({
        input: 4,
        output: 2,
        total: 11,
        cache_read_input_tokens: 2,
        output_reasoning_tokens: 3,
      }),
    });
  });
});

it('preserves tool-call/result linkage, structured reasoning and plain assistant output', () => {
  const attributes = adapt('phoenix', {
    kind: 'generation',
    input: {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
        },
        { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'file data' }] },
      ],
    },
    output: {
      role: 'assistant',
      content: 'done',
      thinking: [{ type: 'thinking', content: 'reason' }],
    },
  });
  expect(attributes).toMatchObject({
    'llm.input_messages.0.message.tool_calls.0.tool_call.id': 'c1',
    'llm.input_messages.0.message.tool_calls.0.tool_call.function.name': 'read',
    'llm.input_messages.1.message.tool_call_id': 'c1',
    'llm.output_messages.0.message.contents.0.message_content.text': 'reason',
  });
  expect(adapt('phoenix', { kind: 'generation', output: 'plain answer' })).toMatchObject({
    'llm.output_messages.0.message.role': 'assistant',
    'llm.output_messages.0.message.content': 'plain answer',
  });
});

it('uses the GitHub-configured PHOENIX_PROJECT_NAME and keeps a complete traces endpoint', () => {
  expect(
    resolveConnection(
      { backend: 'phoenix' },
      {
        PHOENIX_PROJECT_NAME: 'ci-project',
        PHOENIX_COLLECTOR_ENDPOINT: 'https://example.com/s/team/v1/traces',
      },
    ),
  ).toMatchObject({
    resourceAttributes: { 'openinference.project.name': 'ci-project' },
    endpoint: 'https://example.com/s/team/v1/traces',
    headers: {},
  });
});

it('maps explicit agent types independently of display names and preserves inline image attributes', () => {
  expect(adapt('phoenix', { kind: 'agent', name: 'subagent: reviewer' })).toMatchObject({
    'openinference.span.kind': 'AGENT',
  });
  expect(adapt('langfuse', { kind: 'root', root: false })).toMatchObject({
    'langfuse.internal.is_app_root': false,
  });
  expect(
    adapt('phoenix', {
      kind: 'generation',
      input: {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }],
          },
        ],
      },
    }),
  ).toMatchObject({
    'llm.input_messages.0.message.contents.0.message_content.image.image.url':
      'data:image/png;base64,AA==',
  });
});

it('keeps structural Phoenix telemetry when configured redaction replaces request collections', async () => {
  const { PayloadPrivacy } = await import('./core/index.js');
  const privacy = new PayloadPrivacy({ secrets: [], redactFields: ['tools', 'messages'] });
  const data = privacy.mask({
    kind: 'generation' as const,
    model: 'test',
    usage: { inputTokens: 2, outputTokens: 3 },
    input: { tools: [{ name: 'read' }], messages: [{ role: 'user', content: 'sensitive' }] },
  });
  expect(adapt('phoenix', data)).toMatchObject({
    'openinference.span.kind': 'LLM',
    'llm.model_name': 'test',
    'llm.token_count.total': 5,
  });
});

it.each([
  ['phoenix', 'https://example.com/v1/traces'],
  ['langfuse', 'https://example.com/api/public/otel/v1/traces'],
] as const)('normalizes a %s root origin without a double slash', (backend, expected) => {
  expect(
    resolveConnection(
      { backend, endpoint: 'https://example.com/', publicKey: 'pk', secretKey: 'sk' },
      {},
    ).endpoint,
  ).toBe(expected);
});

it('emits the provider and typed reasoning parts required by OpenInference', () => {
  expect(
    adapt('phoenix', {
      kind: 'generation',
      provider: 'deepseek',
      output: { role: 'assistant', thinking: [{ type: 'thinking', content: 'reason' }] },
    }),
  ).toMatchObject({
    'llm.system': 'deepseek',
    'llm.output_messages.0.message.contents.0.message_content.type': 'reasoning',
  });
});

it('keeps clean tool identity separate from the readable tree label', () => {
  expect(
    adapt('phoenix', {
      kind: 'tool',
      name: 'tool:read [/tmp/a]',
      metadata: { toolName: 'read', callId: 'call-1' },
    }),
  ).toMatchObject({ 'tool.name': 'read', 'tool.id': 'call-1' });
});
