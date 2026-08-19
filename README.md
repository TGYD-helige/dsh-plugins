# dsh-plugins

Generic, config-driven plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). No dsh core patches required — everything is built on documented Cordis seams (services, typed events, waterfalls).

| Package | What it does | Seams used |
| --- | --- | --- |
| [`dsh-a2a`](packages/dsh-a2a) | Serves dsh agents over the [A2A protocol](https://github.com/a2aproject) (JSON-RPC + SSE): task create/cancel, streaming, agent card | `ctx.agents`, `session/event`, own HTTP server |
| [`dsh-storage`](packages/dsh-storage) | Mirrors the session event stream into MySQL/PostgreSQL (`dsh_messages` / `dsh_chat_histories`), Redis, and/or GCS (incl. workspace tar archives) | `session/event` tap (local persistence stays authoritative) |
| [`dsh-langfuse`](packages/dsh-langfuse) | Langfuse observability: one generation per LLM call, one span per tool call, one trace per turn | `llm/stream` + `tools/execute` waterfalls, `session/event` |

## Status

Early scaffold. The plugin shapes, config schemas, and seam choices are in place; event-payload field names are marked `TODO(verify)` where dsh pre-release APIs may shift. Pin your dsh version and check the markers before production use.

## Compatibility

| dsh-plugins | dsh | cordis |
| --- | --- | --- |
| 0.1.x | `0.1.0-rc.7` (source) / `>=0.0.1-rc.1` (npm) | `^4.0.1` |

dsh is in developer preview and **will** break compatibility between releases. Every release of these plugins pins a tested dsh version in this matrix; upgrade deliberately.

## Install

Each package is a dsh **bundle** (ships a `cordis.patch.yml`). With the dsh CLI:

```sh
dsh plugin --profile my-agent add dsh-a2a dsh-storage dsh-langfuse
dsh --profile my-agent
```

For local development from this checkout, use a `--patch` overlay instead (no packaging needed):

```yaml
# dev.patch.yml
- insert:
    - id: langfuse
      name: file:///absolute/path/to/dsh-plugins/packages/dsh-langfuse
```

```sh
dsh --profile my-agent --patch dev.patch.yml
```

## Configuration

All three plugins are **disabled by default** and configured through the standard dsh plugin config layer (Schemastery-validated, hot-reloaded). Example profile `cordis.patch.yml` snippet:

```yaml
- insert:
    - id: langfuse
      name: dsh-langfuse
      config:
        enabled: true
        publicKey: pk-lf-...
        secretKey: sk-lf-...
        baseUrl: https://cloud.langfuse.com
    - id: storage-mirror
      name: dsh-storage
      config:
        enabled: true
        database:
          enabled: true
          url: mysql://user:pass@host:3306/agent
        redis:
          enabled: true
          url: redis://127.0.0.1:6379
        gcs:
          enabled: false
          bucket: my-agent-archives
        archiveWorkspace: true
    - id: a2a
      name: dsh-a2a
      config:
        enabled: true
        host: 127.0.0.1   # no auth built in — keep loopback or front with a proxy
        port: 41241
        cwd: /srv/agent-workspaces
```

## Data model

`dsh-storage`'s relational shape (`packages/dsh-storage/prisma/schema.prisma`) is adapted from the source project's `ai_messages` / `ai_chat_histories` tables:

- **`dsh_messages`** — one row per projected session event (user / model / tool), with `thoughts`, `tokens`, `tool_calls`, `agent_id`, `metadata` JSON columns and soft-delete.
- **`dsh_chat_histories`** — per-session rollup (message count, total tokens, first/last message timestamps, archive marker).

The logical message id rides in `metadata.id`; the DB primary key is a cuid, so re-projected events update rather than duplicate.

## Security

dsh ships **no authentication or authorization**. `dsh-a2a` binds `127.0.0.1` by default; if you expose it, put an authenticated reverse proxy in front and treat every agent as running with the host process's OS privileges. Multi-tenant deployments need per-tenant isolation (containers) on top.

## Repository layout

```
packages/
├── dsh-a2a/        # A2A protocol server plugin
├── dsh-storage/    # session storage mirror plugin (+ prisma schema)
└── dsh-langfuse/   # Langfuse observability plugin
```

## Development

```sh
pnpm install
pnpm build        # tsc per package
pnpm typecheck
```

Known scaffold gaps (help welcome):

- `dsh-a2a`: the session-event → A2A event translation table is a stub (`translateSessionEvent` in `bridge.ts`); the `@a2a-js/sdk` transport (RequestHandler, ExecutionEventBus, TaskStore, resubscribe-with-replay) is not wired yet.
- `dsh-langfuse`: turn-trace ↔ generation/span parenting needs the verified session identity path from `llm/stream` options.
- `dsh-storage`: GCS workspace archiving shells out to `tar`; Redis mirror is list-based, no query API.

## License

MIT
