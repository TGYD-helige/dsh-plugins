# dsh-langfuse

Langfuse observability for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness):

- one **generation** per LLM call (`llm/stream` waterfall), plus a nested `llm-request` span carrying the verbatim loop-built request
- one **span** per tool call (`tools/execute` waterfall)
- one **trace** per session turn (`session/event`)
- subagent child sessions nested under the parent's tree (`session/created` header link + `subagent/start` / `subagent/end`)

## Install

```sh
dsh plugin --profile my-agent add dsh-langfuse
```

Requires the `langfuse` peer (`^3`) at runtime; it is loaded via lazy dynamic `import()`, so an unused install costs nothing.

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

Buffered observations drain on `session/flush(session)`; the Langfuse client shuts down with the plugin fiber.

Observability is a no-throw seam: backend errors are logged with a `[dsh-langfuse]` prefix and never escape into the agent loop.

## Compatibility

Pinned dsh/cordis versions live in the [root compat matrix](../../README.md#compatibility). Event payloads ride pre-release dsh APIs — check the `TODO(verify)` markers in `src/` before upgrading dsh.

## License

MIT
