# @amaster.ai/dsh-langfuse

![dsh-langfuse preview](preview.png)

Langfuse observability for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness):

- one **generation** per LLM call (`llm/stream` waterfall), plus a nested `llm-request` span carrying the verbatim loop-built request
- one **tool observation** per tool call (`tools/execute` waterfall)
- one **span** per `hook/invoked` / `hook/result` pair, with hook point, decision, exit code, and duration (stderr summary follows `captureContent`)
- one **trace** per session turn (`session/event`) — in the v5 SDK the trace IS its root span, ended (and thereby exported) at `turn/end`
- subagent child sessions nested under the parent's tree (`session/created` header link + `subagent/start` / `subagent/end`)
- structured reasoning in generation output, optional image display, inherited user/tags, and final turn severity
- optional W3C parent context supplied per session, without adopting the host's ambient OTEL context

## Install

```sh
dsh plugin --profile my-agent add @amaster.ai/dsh-langfuse \
  @langfuse/tracing @langfuse/otel @opentelemetry/sdk-trace-node \
  @opentelemetry/api @opentelemetry/exporter-trace-otlp-http
```

The SDK peers (`@langfuse/tracing`, `@langfuse/otel`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/api`) are loaded via lazy dynamic `import()`, so an unused install costs nothing — but they must all be present at runtime (`dsh plugin add` does not auto-install peer trees, so the exporter that `@langfuse/otel` itself peers on is listed explicitly).

## Configuration

Disabled by default. Configure via the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: langfuse
      name: '@amaster.ai/dsh-langfuse'
      config:
        enabled: true
        publicKey: pk-lf-...
        secretKey: sk-lf-...            # secret role
        baseUrl: https://cloud.langfuse.com
        traceName: dsh-turn
        captureContent: true            # set false to record metadata only
        userId: developer
        tags: [coding, experiment-a]
        environment: development
        release: build-42
        redactFields: [password, authorization]
        captureMedia: false              # opt in to uploading images
        maxMediaBytes: 5242880            # total image bytes per display payload
        mediaTimeoutMs: 5000              # attachment read deadline
```

Explicit profile values take precedence over environment variables. Empty credentials/base URL fall back to `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_BASE_URL` (then the EU cloud URL). `userId` falls back to `LANGFUSE_USER_ID`. Empty environment/release values use the SDK's `LANGFUSE_TRACING_ENVIRONMENT` / `LANGFUSE_RELEASE` defaults. `LANGFUSE_TRACING_ENABLED=false` (or `0`) overrides the profile master switch; environment keys alone do not enable the plugin.

Buffered spans drain on `session/flush(session)`; the exporter shuts down with the plugin fiber. Both checkpoints await pending display projections. Unload also closes outstanding model calls with their collected partial content/usage and marks incomplete calls `WARNING`, including calls whose stream was never consumed; the original stream can still settle without ending those observations twice. Attachment reads run in the background and never delay the agent's chunk stream or tool return value; a read that exceeds its deadline degrades to image metadata, even if the backend ignores cancellation. The SDK's `LANGFUSE_FLUSH_AT`, `LANGFUSE_FLUSH_INTERVAL`, and `LANGFUSE_TIMEOUT` control exporter batching and network timeouts.

With `captureContent: true`, both `llm-call` and `llm-request` inputs contain every `llm/stream` request option except the non-serializable `AbortSignal`. New request fields pass through without a plugin update. For image-bearing requests, generation input is updated to a display projection; `llm-request` retains the original attachment references. Langfuse's separate generation `modelParameters` attribute summarizes the known sampling fields; it is not part of either request input. These are dsh-side values, not exact provider HTTP payloads: adapters may add defaults, project messages/tools, or rename fields after this seam. With `captureContent: false`, inputs keep structural counts while the separate `modelParameters` attribute keeps safe parameter metadata; reply excerpts, reasoning, tool arguments/results, error text, and media are withheld from observation names and IO.

Configured Langfuse credentials and `pk-lf-*` / `sk-lf-*` values are redacted across reporter payloads, names, status messages, and labels. `redactFields` replaces matching payload fields recursively, including JSON-encoded arguments, ignoring case. Name excerpts are derived after redaction. Delta blocks are also checked as assembled text so fragmented credentials cannot bypass the mask: affected blocks keep their record count/type/index, with sanitized text in the first delta and later deltas cleared. Redaction only changes telemetry copies; original messages/results and the forwarded stream stay intact. The exporter applies the same mask to IO and metadata as a final safeguard. User/tags are explicit metadata and remain when content capture is off.

## Reasoning, images, and turn results

Text-only generation output remains a string. When reasoning or tool calls are present, output uses the Langfuse chat format: `role: "assistant"`, optional `content`, `thinking` blocks, and `tool_calls` with the original call ID and function arguments. This renders thinking and invoked tools in the formatted preview. The original reasoning deltas remain in the nested `llm-request` output; no extra generation is created.

`captureMedia: true` requires content capture and an available `ctx.attachments` service (`@deepseek-ai/dsh-attachment >=0.2.0-rc.1`). Prompt, generation-input, and tool-output image references are read through that service and converted to data URIs for the SDK's media uploader. Install the attachment bundle appropriate to the deployment; the plugin does not instantiate a storage backend. Missing/failed reads, offloaded images, unsupported MIME types, oversized images, and disabled media fall back to MIME/size/dimension metadata. A generation's byte budget covers all messages in that request. `LANGFUSE_MEDIA_UPLOAD_ENABLED=false` (or `0`) overrides media capture. Verbatim file references remain metadata; their bytes are not uploaded.

Root severity follows the final turn reason: errors are `ERROR`; cancellation, blocking, token limits, and interruptions are `WARNING`. A recovered intermediate generation/tool/hook/subagent error sets `hadErrors` metadata while a successful final turn remains `DEFAULT`. This keeps retry failures visible without treating recovery as a failed turn. Outstanding tools also close as `WARNING` at unload, including calls without an agent/session; late results still reach their original callers without repeated telemetry or media reads.

## Per-request labels and distributed tracing

Hosts can supply standard context before a session's next trace starts:

```ts
ctx.emit('langfuse/context', session.id, {
  userId: 'user-123',
  tags: ['support', 'experiment-b'],
  traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
});
```

The typed event is exported through this package's Cordis augmentation. Context is consumed once by the next turn trace (or an out-of-turn trace created first); send it again for another request. Labels override profile defaults for that trace and propagate through generations, tools, hooks, and nested subagents. Queued context is discarded when the session is disposed or the plugin unloads. Concurrent sessions have independent context; no process-global request environment is modified.

Only explicit W3C version-00 parents with non-zero trace/span IDs are joined. Invalid headers log a prefixed diagnostic and start an independent trace. Without a header the plugin always starts an independent trace. Each observation is created inside native OTEL `ROOT_CONTEXT`: foreign spans and Langfuse baggage (user/tags/metadata) are excluded, while explicit parents and plugin labels are preserved. This scoped context does not replace the host's global provider or context manager. When joining an external trace, dsh's turn is an observation under the supplied parent; the SDK's automatic app-root claim is disabled and the external owner's trace name and trace-level IO stay intact.

## Token usage and cost

Generation `usageDetails` has disjoint `input`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output`, and `output_reasoning_tokens` buckets plus `total`. Reasoning is subtracted from provider output before becoming its own bucket; cached input is counted separately. These keys match the official Pi integration. Custom definitions using the previous `input_cache_read`, `input_cache_creation`, or `output_reasoning` names must update their price keys. This avoids double-counting both usage and inferred cost.

[Langfuse infers USD cost](https://langfuse.com/docs/observability/features/token-and-cost-tracking) when the generation model matches a model definition with prices for the **exact usage keys**. In Project Settings → Models, configure these buckets for private routes, model aliases, or custom prices; reasoning output generally uses the model's output rate. A token total does not prove that a matching price definition exists. If a generation shows “Create model definition”, its model has no matching definition. For gateway aliases, use the actual routed model and your gateway’s rates when defining prices; the plugin keeps the requested model name rather than guessing the upstream model. Definition changes apply to new generations only. dsh's current `TokenUsage` does not carry billed cost, so the plugin does not claim provider-invoiced costs or maintain its own price table.

Compaction and session-title calls passing through `llm/stream` already receive their own generation and `purpose` metadata, including out-of-turn calls. Tools using the same LLM service are observed there too; adding a second generation from tool-result usage would duplicate accounting.

Hook spans appear when a dsh hook bridge emits the paired session records. The current `hook/result` record does not contain stdout; successful script output can appear in the LLM request when the bridge injects it as context, while the hook span reports decision, exit code, duration, and bounded stderr. `SessionStart` runs before the first turn and does not emit these records, so it has no hook span.

Observability is a no-throw seam: backend errors are logged with a `[dsh-langfuse]` prefix and never escape into the agent loop.

## Compatibility

Run `pnpm test:sdk` at the repository root for a secrets-free check using the real Langfuse SDK and the existing local OTLP receiver. It verifies export, native tool type, SDK label redaction, ambient-baggage isolation, external trace ownership, and agent-less tool unload. It is separate from the mocked unit suite and the gateway/real-Langfuse E2E legs.

Pinned dsh/cordis versions live in the [root compat matrix](../../README.md#compatibility). Event payloads ride pre-release dsh APIs — check the `TODO(verify)` markers in `src/` before upgrading dsh.

## License

MIT

The Langfuse integration scenarios label observations with environment `ci`, release `GITHUB_SHA`, and tags for scenario, run ID, and workflow run attempt. Select environment `ci` in Langfuse to find new E2E traces. Read-back uses a bounded time window for each model run and queries a discovered trace directly while ingestion settles.
