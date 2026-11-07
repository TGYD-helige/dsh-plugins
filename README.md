# dsh-plugins

![dsh-plugins preview](preview.png)

Composable, config-driven plugins for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness). Each package is a publishable dsh bundle: install only what an agent needs, configure it through Cordis, and keep dsh itself unpatched.

## Packages

| Package | What it does | Primary seams |
| --- | --- | --- |
| [`@amaster.ai/dsh-a2a`](packages/dsh-a2a) | Serves dsh agents over the [A2A protocol](https://github.com/a2aproject) **1.0** (JSON-RPC + SSE, opt-in HTTP+JSON/REST and gRPC, with v0.3 compatibility): all eleven standard operations, tool approvals, opt-in native inbox execution; pluggable task-state stores (memory/filesystem/Redis/GCS + workspace archive) | `ctx.agents`, `session/event`, `approval/request`, own protocol listeners |
| [`@amaster.ai/dsh-storage`](packages/dsh-storage) | Mirrors the session event stream into MySQL/PostgreSQL/SQLite/SQL Server (`ai_messages` / `ai_chat_histories`) | `session/event` tap (local persistence stays authoritative) |
| [`@amaster.ai/dsh-langfuse`](packages/dsh-langfuse) | Langfuse observability: one generation per LLM call (plus a nested `llm-request` span with the verbatim loop-built request), one span per tool call or hook run, one trace per turn; subagent child sessions nested under the parent's tree | `llm/stream`, `tools/pre-execute` → `tools/result`, `session/event` (including `hook/*`), `session/created` + `subagent/start`/`subagent/end` |
| [`@amaster.ai/dsh-telemetry`](packages/dsh-telemetry) | Unified OTel tracing for Langfuse or Phoenix, including request context, hooks, subagents and A2A tasks | Shared `llm/stream`, tool, session, hook, subagent and A2A collector → backend adapter → shared OTLP/HTTP protobuf |
| [`@amaster.ai/dsh-policy`](packages/dsh-policy) | Declarative tool-call policy: config-driven `allow`/`deny`/`ask` rules (tool name, args pattern, per-segment shell command prefix/regex, priority) — Gemini CLI-style policy files as plain plugin config | `tools/pre-execute` waterfall (`ask` rides dsh's approval seam) |
| [`@amaster.ai/dsh-subagent-filesystem`](packages/dsh-subagent-filesystem) | Discovers Markdown specialist roles through the caller's filesystem and delegates through native in-process subagents | `ctx.fs`, scoped `ctx.tools` / `ctx.systemPrompt`, `agent/created`, `ctx.subagents` |

## Plugin previews

<table>
  <tr>
    <td width="50%" valign="top"><strong>dsh-a2a</strong><br><a href="packages/dsh-a2a"><img src="packages/dsh-a2a/preview.png" alt="dsh-a2a preview" width="360"></a></td>
    <td width="50%" valign="top"><strong>dsh-storage</strong><br><a href="packages/dsh-storage"><img src="packages/dsh-storage/preview.png" alt="dsh-storage preview" width="360"></a></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>dsh-langfuse</strong><br><a href="packages/dsh-langfuse"><img src="packages/dsh-langfuse/preview.png" alt="dsh-langfuse preview" width="360"></a></td>
    <td width="50%" valign="top"><strong>dsh-policy</strong><br><a href="packages/dsh-policy"><img src="packages/dsh-policy/preview.png" alt="dsh-policy preview" width="360"></a></td>
  </tr>
  <tr>
    <td width="50%" valign="top"><strong>dsh-subagent-filesystem</strong><br><a href="packages/dsh-subagent-filesystem"><img src="packages/dsh-subagent-filesystem/preview.png" alt="dsh-subagent-filesystem preview" width="360"></a></td>
    <td width="50%" valign="top"><strong>dsh-telemetry</strong><br><a href="packages/dsh-telemetry"><img src="packages/dsh-telemetry/preview.png" alt="dsh-telemetry preview" width="360"></a></td>
  </tr>
</table>

## Status

This is an early dsh-preview ecosystem. The plugin shapes, config schemas, and seam choices are in place; event-payload field names are marked `TODO(verify)` where dsh pre-release APIs may shift. Pin your dsh version and check those markers before production use.

## Compatibility

| @amaster.ai/dsh-* | dsh | cordis | @a2a-js/sdk (dsh-a2a) |
| --- | --- | --- | --- |
| 0.1.x | `>=0.1.5-rc.1 || >=0.1.6-alpha.1 || >=0.1.7-alpha.1 || >=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1` (peer floor) / `0.2.2-rc.1` (tested) | `^4.0.1` (tested `4.1.0`) | `^1.1.0` (A2A 1.0 + v0.3 compat) |

dsh is in developer preview and **will** break compatibility between releases. Plugins declare the oldest compatible dsh version as a fixed peer floor and every release records the tested dsh version in this matrix; the floor moves only when a plugin starts requiring a newer dsh API. Installs ride `dsh plugin add`, which is pnpm-only — pnpm's peer matching has no prerelease gate, so any newer dsh (alpha or stable) satisfies the floor without warnings. npm consumers are gated differently: npm never lets a prerelease satisfy a range unless the range names that release tuple with a prerelease comparator, so the peer ranges also name the 0.1.6, 0.1.7, 0.2.0, 0.2.1, and 0.2.2 prerelease tuples. Drop each union member once that line ships a final release.

`dsh-a2a` inbox execution additionally tests the unmodified official DSH `0.2.2-rc.1` npm runtime. Its agent peer floor is `>=0.2.2-rc.1`, for initial model selection through agent options and the scoped model-switch notice hook. Queueing uses `Agent.send`; no core patch is required.

`dsh-a2a`'s optional Goal integration consumes `@deepseek-ai/dsh-goal >=0.2.0-rc.2 || >=0.2.1-alpha.1 || >=0.2.2-rc.1` and preserves official Goal round validation (tested with the Goal service and round driver at `0.2.2-rc.1`).

`dsh-a2a`'s approval bridge has an optional `@deepseek-ai/dsh-user-approval` peer floor of `>=0.1.6-alpha.2 || >=0.1.7-alpha.1 || >=0.2.0-rc.1 || >=0.2.1-rc.1 || >=0.2.2-rc.1` (tested at `0.2.2-rc.1`).

`dsh-a2a` requires `@deepseek-ai/dsh-session >=0.2.1-rc.5 || >=0.2.2-rc.1` for the owner-scoped `SessionStore.flush` durability barrier used by native inbox operations and checkpointed invalidations. Optional subagent streaming also consumes the session lifecycle offset to distinguish new children from restored sessions.

`dsh-langfuse`'s optional image display uses `@deepseek-ai/dsh-attachment >=0.2.0-rc.1 || >=0.2.2-rc.1` (tested at `0.2.2-rc.1`); metadata-only tracing does not require an attachment backend.

`dsh-subagent-filesystem` requires `@deepseek-ai/dsh-subagent >=0.2.1-rc.2 || >=0.2.2-rc.1` (tested at `0.2.2-rc.1`) and the native in-process `spawn` provider. It supports foreground reports and continuable background children; Markdown definitions cannot override models, tools, or permissions.

`dsh-telemetry` tests the same dsh `0.2.2-rc.1` collector with OTel API `1.9.1`, SDK/resources `2.10.0`, and OTLP/HTTP protobuf exporter `0.221.0`. It needs no Langfuse SDK. See its README for backend server/version limits, project configuration and migration; enable one collector per profile.

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
        taskStore: redis  # memory | filesystem | redis | gcs — A2A task state only
        filesystem:
          root: /srv/dsh/a2a-tasks
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

Task updates use standard A2A streaming/subscriptions, snapshots, and optional [official SDK Push Notifications](packages/dsh-a2a/README.md#standard-a2a-notifications). Enable `pushNotifications: true` to let clients register standard task webhooks.

**Native inbox mode is opt-in and uses the official DSH APIs**; it is tested with the unmodified `0.2.2-rc.1` npm runtime. See [native inbox execution](packages/dsh-a2a/README.md#native-inbox-execution) for queueing, steering, pause/recovery semantics and the runtime integration checks.

Opt into `inbox: { enabled: true, shutdown: retain-pending }` to retain unclaimed A2A steering and future turns across graceful host restarts. Retain both the session persistence and TaskStore storage; hosts still discover and wake eligible work. Explicit cancellation and context clearing remain terminal. See [the shutdown contract](packages/dsh-a2a/README.md#graceful-host-shutdown).

A2A task snapshots are separate from the full conversation log: `dsh-a2a` ships pluggable `TaskStore` backends — in-memory (default), filesystem (private atomic JSON snapshots), Redis (task JSON + TTL), and GCS (gzipped task JSON). The snapshots retain A2A history and artifacts at task-state transitions; `dsh-storage` separately records the full conversation. Streamed text deltas stay in process until the next state change, so token-rate events never reach Redis or GCS. Redis and GCS keys are scoped to the A2A tenant and user; older unscoped records require migration or expiry.

## Security

dsh ships **no authentication or authorization**. `dsh-a2a` binds `127.0.0.1` by default; if you expose it, put an authenticated reverse proxy in front and treat every agent as running with the host process's OS privileges. Multi-tenant deployments need per-tenant isolation (containers) on top.

## Repository layout

```
packages/
├── dsh-a2a/        # A2A protocol server plugin
├── dsh-storage/    # session storage mirror plugin (+ prisma schema)
├── dsh-langfuse/   # Langfuse observability plugin
├── dsh-telemetry/  # Unified Langfuse/Phoenix tracing
└── dsh-policy/     # declarative tool-call policy plugin
```

## Development

```sh
pnpm install
pnpm build        # tsc per package
pnpm typecheck
pnpm test         # vitest (packages with a test script)
pnpm test:performance  # deterministic budgets + JSON results; no credentials
pnpm test:performance:network   # real loopback HTTP/SSE/gRPC and attachment paths
pnpm test:performance:database  # disposable SQLite benchmark
pnpm test:performance:combined  # real A2A + storage + telemetry + policy, synthetic agent
```

The [Performance workflow](.github/workflows/performance.yml) runs the **Performance
budgets** check without model or backend credentials. It reuses focused unit-test
modules with mocked backends, then benchmarks the real telemetry plugin/exporter
against a loopback OTLP receiver in separate processes.

| Area | Workload and checks |
| --- | --- |
| Slow consumers | 100/10,000 frames in byte/object streams; bounded backlog and listener cleanup |
| Task discovery | 100/1,000 large Redis/GCS snapshots; bounded prefix reads, page-only hydration, recovery without full downloads, GCS concurrency |
| Subscriptions | 10/1,000 subscribers per context across eight contexts; shared checkpoints and disposal cleanup |
| Storage | Up to 1,024 tool results; bounded batching and cache lookups; a 512-message blocked burst alongside 16 other sessions; paginated SQL lookup/archive |
| Telemetry streams | Eight concurrent 256/16,384-chunk streams; bounded serialization/masking and unchanged delivery |
| Lifecycle | 32 plugin lifecycles with 32 sessions each; no leftover fake-clock timers or late event handling |
| Slow exporters | 1,000 LLM calls while exports stall; pinned OTel queue/batch limits, failure/timeout handling and unload completion |
| Large payloads | Up to 10,000 entries, 64-level JSON and split credentials; bounded traversal/bytes and preserved redaction on both adapters |
| Policy scale | 10/1,000 candidate rules and 1,000 shell substitutions; one argument serialization and one args check per candidate, preserving deny decisions |
| Protocol load | 64 requests each over HTTP, SSE and gRPC at concurrency 1/16/64; first-frame/request percentiles, throughput and event-loop delay; 32 concurrent subscription cancellations |
| Attachments/media | 24 MiB real chunked download, 64 MiB cap refusal and cancellation without leftover files; 128 images sharing a 4 MiB read budget, including ignored-read cancellation |
| Real databases | 1,000/5,000 rows, oldest tool-call lookup, query plans, 32 concurrent reads and archive verification on SQLite/PostgreSQL; PostgreSQL additionally saturates a two-connection pool and verifies a row-lock wait does not block unrelated reads |
| Combined plugins | A2A alone versus A2A + Storage + Telemetry + Policy over real HTTP/SQLite/OTLP, with eight warmup tasks and 64 measured tasks at concurrency eight; verifies policy rejection, all 144 message rows and 72 exported generations |

`performance-results.json` records unit-test outcomes and durations.
`performance-metrics.json` compares disabled telemetry with content capture off/on
for both Phoenix and Langfuse. Each mode runs in a fresh Node process: 16 warmup
turns, then five samples of 64 turns with 128 chunks each. The report includes
startup, streaming, flush and shutdown time, CPU usage, turns/second, sampled heap,
post-GC retained heap growth, process peak RSS and ratios against disabled mode.
The receiver runs outside the measured worker, so its CPU is excluded.

The workflow also uploads `performance-network.json`, `performance-media.json`,
`performance-database-sqlite.json`, `performance-combined.json` and the transport
test report. The separate PostgreSQL job uploads `performance-database-postgresql.json`.
Combined-plugin CPU includes its co-located client/server/receiver; it is a total
fixture observation, unlike the isolated telemetry worker measurements.

SQLite runs in temporary WAL databases. PostgreSQL uses a disposable CI service;
local runs require an explicit loopback database named `dsh_performance`:

```sh
DSH_PERFORMANCE_DB_PROVIDER=postgresql \
DSH_PERFORMANCE_DB_URL=postgresql://postgres:performance-only@127.0.0.1:5432/dsh_performance \
pnpm test:performance:database
```

For a sustained unique-session workload, manually dispatch **Performance** with
`soak_minutes` set to `15`, `30` or `60`. This runs Phoenix content capture and
records heap/RSS, active resource types, CPU and flush/stream timings periodically
in `performance-soak.json`; it verifies every expected span reaches the receiver.
The default dispatch value `0` runs short checks only. Normal PRs exercise the
same runner for ten seconds without adding a long-duration job.

```sh
pnpm test:performance:soak  # 30 minutes by default
DSH_PERFORMANCE_SOAK_SECONDS=10 pnpm test:performance:soak  # local smoke test
```

Both reports are retained for seven days. Capacity and work limits fail the check;
hardware-dependent timing/memory figures are observations without fixed thresholds.
The agents and responses are synthetic, even in the real transport/database tests.
Reports do not establish production capacity or leak freedom. Query plans are
recorded rather than required to choose a particular index on a small fixture;
MySQL/SQL Server performance, real image decoding and production-network behavior
are not covered by these benchmarks.

## Current limitations

- All plugins are disabled by default; enable and configure each explicitly in the profile.

- `dsh-a2a` retains no event replay for subscriptions: `SubscribeToTask` opens with the current task snapshot and follows the live bus only. Resuming a dsh session after restart requires the optional `sessionPersistence` service.
- `dsh-a2a` GCS store: workspace archiving (`archiveWorkspace`) shells out to `tar` and is not wired to the task lifecycle yet.

## License

MIT
