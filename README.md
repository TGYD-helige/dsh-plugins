# dsh-plugins

Generic, config-driven plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). No dsh core patches required — everything is built on documented Cordis seams (services, typed events, waterfalls).

| Package | What it does | Seams used |
| --- | --- | --- |
| [`dsh-a2a`](packages/dsh-a2a) | Serves dsh agents over the [A2A protocol](https://github.com/a2aproject) (JSON-RPC + SSE): task create/cancel, streaming, agent card; pluggable task-state stores (memory/Redis/GCS + workspace archive) | `ctx.agents`, `session/event`, own HTTP server |
| [`dsh-storage`](packages/dsh-storage) | Mirrors the session event stream into MySQL/PostgreSQL/SQLite/SQL Server (`ai_messages` / `ai_chat_histories`) | `session/event` tap (local persistence stays authoritative) |
| [`dsh-langfuse`](packages/dsh-langfuse) | Langfuse observability: one generation per LLM call, one span per tool call, one trace per turn | `llm/stream` + `tools/execute` waterfalls, `session/event` |

## Status

Early scaffold. The plugin shapes, config schemas, and seam choices are in place; event-payload field names are marked `TODO(verify)` where dsh pre-release APIs may shift. Pin your dsh version and check the markers before production use.

## Compatibility

| dsh-plugins | dsh | cordis |
| --- | --- | --- |
| 0.1.x | `0.1.0-rc.7` (source) / `0.1.0-rc.7` (npm) | `^4.0.1` |

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
          provider: mysql   # mysql | postgresql | sqlite | sqlserver
          url: mysql://user:pass@host:3306/agent
    - id: a2a
      name: dsh-a2a
      config:
        enabled: true
        host: 127.0.0.1   # no auth built in — keep loopback or front with a proxy
        port: 41241
        cwd: /srv/agent-workspaces
        taskStore: redis  # memory | redis | gcs — A2A task state only
        redis:
          url: redis://127.0.0.1:6379
        gcs:
          bucket: my-agent-archives
```

## Data model

`dsh-storage`'s relational shape matches the source project's `ai_messages` / `ai_chat_histories` tables, so existing data stays compatible (one deviation: no `user_id` column — tenancy rides on `session_id`). It requires **Prisma 7** peer packages at runtime: `@prisma/client` plus the driver adapter for your database (`@prisma/adapter-mariadb` for MySQL, `@prisma/adapter-pg` for PostgreSQL, `@prisma/adapter-libsql` for SQLite, `@prisma/adapter-mssql` for SQL Server). The PrismaClient is pre-generated per provider and shipped in the package — **no `prisma generate` step**. Create or upgrade the tables with the shipped schema variant:

```sh
npx prisma db push --schema node_modules/dsh-storage/prisma/schema.mysql.prisma --url "mysql://user:pass@host:3306/agent"
# schema.postgresql.prisma / schema.sqlite.prisma / schema.sqlserver.prisma work the same way
```

SQL Server note: Prisma's sqlserver connector has no `Json` type, so its variant maps the JSON columns to text — the backend serializes them on write automatically (derived from `provider: sqlserver`; SQL Server's `ISJSON` / `JSON_VALUE` still query the text as JSON).

- **`ai_messages`** — one row per projected session event (user / model / tool), with `thoughts`, `tokens`, `tool_calls`, `agent_id`, `metadata` JSON columns and soft-delete.
- **`ai_chat_histories`** — per-session rollup (message count, total tokens, first/last message timestamps).

The logical message id rides in `metadata.id`; message rows use a deterministic hash of `(session_id, message id)` as their primary key, so re-projected events upsert in place rather than duplicate — on every connector (the source project's `metadata.id` JSON-path lookup only works on PostgreSQL/MySQL). Session rows are matched by `session_id` and keep their cuid primary keys — the per-session serialization chain makes the find-then-write safe, and rows from the early scaffold (or the source project) are continued, never duplicated. Upgrade note: the early scaffold wrote messages with cuid keys; if you ran it, dedupe those by `metadata.id` before enabling this version.

A2A **task state** is a separate concern from conversation history: `dsh-a2a` ships pluggable `TaskStore` backends — in-memory (default), Redis (task metadata JSON + TTL, `contextId → taskId` index), and GCS (gzipped task metadata + optional workspace tar archive, same layout as the source project's `GCSTaskStore`).

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
pnpm test         # vitest (packages with a test script)
```

Known scaffold gaps (help welcome):

- `dsh-a2a`: the session-event → A2A event translation table is a stub (`translateSessionEvent` in `bridge.ts`); the `@a2a-js/sdk` transport (RequestHandler, ExecutionEventBus, resubscribe-with-replay) is not wired yet — the Redis/GCS `TaskStore`s are created from config but not yet fed by the SDK handler.
- `dsh-langfuse`: turn-trace ↔ generation/span parenting needs the verified session identity path from `llm/stream` options.
- `dsh-a2a` GCS store: workspace archiving shells out to `tar`.
- No package ships its `preview.png` yet — the shared preview system (see AGENTS.md) is unbuilt; generate all three together when it lands.

## License

MIT
