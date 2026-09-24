# dsh-plugins

![dsh-plugins preview](preview.png)

Composable, config-driven plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). Each package is a publishable dsh bundle: install only what an agent needs, configure it through Cordis, and keep dsh itself unpatched.

## Packages

| Package | What it does | Primary seams |
| --- | --- | --- |
| [`@amaster.ai/dsh-a2a`](packages/dsh-a2a) | Serves dsh agents over the [A2A protocol](https://github.com/a2aproject) **1.0** (JSON-RPC + SSE, with a v0.3 compatibility layer): streaming turns, task cancel, task list, agent card; pluggable task-state stores (memory/Redis/GCS + workspace archive) | `ctx.agents`, `session/event`, own HTTP server |
| [`@amaster.ai/dsh-storage`](packages/dsh-storage) | Mirrors the session event stream into MySQL/PostgreSQL/SQLite/SQL Server (`ai_messages` / `ai_chat_histories`) | `session/event` tap (local persistence stays authoritative) |
| [`@amaster.ai/dsh-langfuse`](packages/dsh-langfuse) | Langfuse observability: one generation per LLM call (plus a nested `llm-request` span with the verbatim loop-built request), one span per tool call, one trace per turn; subagent child sessions nested under the parent's tree | `llm/stream` + `tools/execute` waterfalls, `session/event`, `session/created` + `subagent/start`/`subagent/end` |
| [`@amaster.ai/dsh-policy`](packages/dsh-policy) | Declarative tool-call policy: config-driven `allow`/`deny`/`ask` rules (tool name, args pattern, per-segment shell command prefix/regex, priority) — Gemini CLI-style policy files as plain plugin config | `tools/pre-execute` waterfall (`ask` rides dsh's approval seam) |

## Plugin previews

<table>
  <tr>
    <td><strong>dsh-a2a</strong><br><a href="packages/dsh-a2a"><img src="packages/dsh-a2a/preview.png" alt="dsh-a2a preview" width="260"></a></td>
    <td><strong>dsh-storage</strong><br><a href="packages/dsh-storage"><img src="packages/dsh-storage/preview.png" alt="dsh-storage preview" width="260"></a></td>
    <td><strong>dsh-langfuse</strong><br><a href="packages/dsh-langfuse"><img src="packages/dsh-langfuse/preview.png" alt="dsh-langfuse preview" width="260"></a></td>
    <td><strong>dsh-policy</strong><br><a href="packages/dsh-policy"><img src="packages/dsh-policy/preview.png" alt="dsh-policy preview" width="260"></a></td>
  </tr>
</table>

## Status

This is an early dsh-preview ecosystem. The plugin shapes, config schemas, and seam choices are in place; event-payload field names are marked `TODO(verify)` where dsh pre-release APIs may shift. Pin your dsh version and check those markers before production use.

## Compatibility

| @amaster.ai/dsh-* | dsh | cordis | @a2a-js/sdk (dsh-a2a) |
| --- | --- | --- | --- |
| 0.1.x | `>=0.1.5-rc.1 || >=0.1.6-alpha.1` (peer floor) / `0.1.6-alpha.2` (tested) | `^4.0.1` | `^1.1.0` (A2A 1.0 + v0.3 compat) |

dsh is in developer preview and **will** break compatibility between releases. Plugins declare the oldest compatible dsh version as a fixed peer floor and every release records the tested dsh version in this matrix; the floor moves only when a plugin starts requiring a newer dsh API. Installs ride `dsh plugin add`, which is pnpm-only — pnpm's peer matching has no prerelease gate, so any newer dsh (alpha or stable) satisfies the floor without warnings. npm consumers are gated differently: npm never lets a prerelease satisfy a range unless the range names that release tuple with a prerelease comparator, so the floor carries the `|| >=0.1.6-alpha.1` union member — required only while 0.1.6 is pre-release; `0.1.6` final satisfies the plain floor again.

## Install

Every package is a dsh **bundle** and ships a `cordis.patch.yml`. With the dsh CLI:

```sh
dsh plugin --profile my-agent add @amaster.ai/dsh-a2a @amaster.ai/dsh-storage @amaster.ai/dsh-langfuse
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

All plugins are **disabled by default** and configured through the standard dsh plugin config layer (Schemastery-validated, hot-reloaded). Example profile `cordis.patch.yml` snippet:

```yaml
- insert:
    - id: langfuse
      name: '@amaster.ai/dsh-langfuse'
      config:
        enabled: true
        publicKey: pk-lf-...
        secretKey: sk-lf-...
        baseUrl: https://cloud.langfuse.com
    - id: storage-mirror
      name: '@amaster.ai/dsh-storage'
      config:
        enabled: true
        database:
          enabled: true
          provider: mysql   # mysql | postgresql | sqlite | sqlserver
          url: mysql://user:pass@host:3306/agent
    - id: a2a
      name: '@amaster.ai/dsh-a2a'
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
    - id: policy
      name: '@amaster.ai/dsh-policy'
      config:
        enabled: true
        rules:
          - tool: bash
            decision: deny
            commandPrefix: npm
            priority: 200
            message: 'npm is not allowed. Use bun instead.'
          - tool: '*'
            decision: allow
            priority: 20
```

## Data model

`dsh-storage`'s relational shape matches the source project's `ai_messages` / `ai_chat_histories` tables, so existing data stays compatible (one deviation: no `user_id` column — tenancy rides on `session_id`). It requires **Prisma 7** peer packages at runtime: `@prisma/client` plus the driver adapter for your database (`@prisma/adapter-mariadb` for MySQL, `@prisma/adapter-pg` for PostgreSQL, `@prisma/adapter-libsql` for SQLite, `@prisma/adapter-mssql` for SQL Server). The PrismaClient is pre-generated per provider and shipped in the package — **no `prisma generate` step**. Create or upgrade the tables with the shipped schema variant:

```sh
npx prisma db push --schema node_modules/@amaster.ai/dsh-storage/prisma/schema.mysql.prisma --url "mysql://user:pass@host:3306/agent"
# schema.postgresql.prisma / schema.sqlite.prisma / schema.sqlserver.prisma work the same way
```

SQL Server note: Prisma's sqlserver connector has no `Json` type, so its variant maps the JSON columns to text — the backend serializes them on write automatically (derived from `provider: sqlserver`; SQL Server's `ISJSON` / `JSON_VALUE` still query the text as JSON).

- **`ai_messages`** — user/model rows with `thoughts`, `tokens`, `tool_calls`, `agent_id`, `metadata` JSON columns and soft-delete; tool results update the matching model row's `tool_calls`.
- **`ai_chat_histories`** — per-session rollup (message count, total tokens, first/last message timestamps).

The logical message id rides in `metadata.id`; message rows use a deterministic hash of `(session_id, message id)` as their primary key, so re-projected events upsert in place rather than duplicate — on every connector (the source project's `metadata.id` JSON-path lookup only works on PostgreSQL/MySQL). Session rows are matched by `session_id` and keep their cuid primary keys — the per-session serialization chain makes the find-then-write safe, and rows from the early scaffold (or the source project) are continued, never duplicated. Upgrade note: the early scaffold wrote messages with cuid keys; if you ran it, dedupe those by `metadata.id` before enabling this version.

A2A **task state** is a separate concern from conversation history: `dsh-a2a` ships pluggable `TaskStore` backends — in-memory (default), Redis (task state JSON + TTL), and GCS (gzipped task state, same object layout as the source project's `GCSTaskStore`). Every backend persists a metadata shell only (history/artifacts are stripped before saving — conversation history belongs to `dsh-storage`), and saves are collapsed to task-state transitions so streamed text deltas never reach the backend.

## Security

dsh ships **no authentication or authorization**. `dsh-a2a` binds `127.0.0.1` by default; if you expose it, put an authenticated reverse proxy in front and treat every agent as running with the host process's OS privileges. Multi-tenant deployments need per-tenant isolation (containers) on top.

## Repository layout

```
packages/
├── dsh-a2a/        # A2A protocol server plugin
├── dsh-storage/    # session storage mirror plugin (+ prisma schema)
├── dsh-langfuse/   # Langfuse observability plugin
└── dsh-policy/     # declarative tool-call policy plugin
```

## Development

```sh
pnpm install
pnpm build        # tsc per package
pnpm typecheck
pnpm test         # vitest (packages with a test script)
```

## Current limitations

- All plugins are disabled by default; enable and configure each explicitly in the profile.

- `dsh-a2a` is text-only at the protocol boundary (non-text message parts are rejected), has no approval/`input-required` mid-turn bridge (dsh ships the approval seam only as the optional `dsh-user-approval` package, not composed by headless profiles), and does not resume live sessions across restarts — persisted task shells survive in Redis/GCS, but continuing a conversation starts a fresh session. No event replay is retained for subscriptions: `SubscribeToTask` opens with the current task snapshot and follows the live bus only.
- `dsh-a2a` GCS store: workspace archiving (`archiveWorkspace`) shells out to `tar` and is not wired to the task lifecycle yet.

## License

MIT
