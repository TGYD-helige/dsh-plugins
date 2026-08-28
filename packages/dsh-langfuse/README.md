# dsh-langfuse

![dsh-langfuse preview](preview.png)

Langfuse observability for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness):

- one **generation** per LLM call (`llm/stream` waterfall), plus a nested `llm-request` span carrying the verbatim loop-built request
- one **span** per tool call (`tools/execute` waterfall)
- one **trace** per session turn (`session/event`) — in the v5 SDK the trace IS its root span, ended (and thereby exported) at `turn/end`
- subagent child sessions nested under the parent's tree (`session/created` header link + `subagent/start` / `subagent/end`)

## Install

```sh
dsh plugin --profile my-agent add dsh-langfuse \
  @langfuse/tracing @langfuse/otel @opentelemetry/sdk-trace-node \
  @opentelemetry/api @opentelemetry/exporter-trace-otlp-http
```

The Langfuse JS SDK v5 peers (`@langfuse/tracing`, `@langfuse/otel`, `@opentelemetry/sdk-trace-node`) are loaded via lazy dynamic `import()`, so an unused install costs nothing — but they must all be present at runtime (`dsh plugin add` does not auto-install peer trees, so the OTEL api/exporter packages `@langfuse/otel` itself peers on are listed explicitly).

## Configuration

Disabled by default. Configure via the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: langfuse
      name: dsh-langfuse
      config:
        enabled: true
        publicKey: pk-lf-...
        secretKey: sk-lf-...            # secret role
        baseUrl: https://cloud.langfuse.com
        traceName: dsh-turn
        captureContent: true            # set false to record metadata only
```

Buffered spans drain on `session/flush(session)`; the exporter shuts down with the plugin fiber.

Observability is a no-throw seam: backend errors are logged with a `[dsh-langfuse]` prefix and never escape into the agent loop.

## Compatibility

Pinned dsh/cordis versions live in the [root compat matrix](../../README.md#compatibility). Event payloads ride pre-release dsh APIs — check the `TODO(verify)` markers in `src/` before upgrading dsh.

## License

MIT
