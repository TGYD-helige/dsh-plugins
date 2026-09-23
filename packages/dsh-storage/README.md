# @amaster.ai/dsh-storage

![dsh-storage preview](preview.png)

Session storage mirror for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): projects the `session/event` stream into MySQL/PostgreSQL/SQLite/SQL Server (`ai_messages` / `ai_chat_histories`, same tables as the source project) without replacing dsh's local persistence — local files stay authoritative, this is a mirror.

Use it when a dsh profile needs durable, queryable session data in an existing relational database while preserving the runtime's local session store as the source of truth.

## Install

```sh
dsh plugin --profile my-agent add @amaster.ai/dsh-storage
```

Runtime peers: `@prisma/client` (**Prisma 7**) plus the driver adapter for your database:

| Provider | Adapter peer |
| --- | --- |
| `mysql` | `@prisma/adapter-mariadb` |
| `postgresql` | `@prisma/adapter-pg` |
| `sqlite` | `@prisma/adapter-libsql` |
| `sqlserver` | `@prisma/adapter-mssql` |

The PrismaClient is pre-generated per provider and shipped in the package — **no `prisma generate` step** for consumers.

## Configuration

Disabled by default. Configure via the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: storage-mirror
      name: '@amaster.ai/dsh-storage'
      config:
        enabled: true
        database:
          enabled: true
          provider: mysql   # mysql | postgresql | sqlite | sqlserver
          url: mysql://user:pass@host:3306/agent
```

Create or upgrade the tables with the shipped schema variant:

```sh
npx prisma db push --schema node_modules/@amaster.ai/dsh-storage/prisma/schema.mysql.prisma --url "mysql://user:pass@host:3306/agent"
# schema.postgresql.prisma / schema.sqlite.prisma / schema.sqlserver.prisma work the same way
```

## Data model

- **`ai_messages`** — one row per projected session event (user / model / tool), with `thoughts`, `tokens`, `tool_calls`, `agent_id`, `metadata` JSON columns and soft-delete.
- **`ai_chat_histories`** — per-session rollup (message count, total tokens, first/last message timestamps).

The logical message id rides in `metadata.id`; message rows use a deterministic hash of `(session_id, message id)` as their primary key, so re-projected events upsert in place rather than duplicate — on every connector. Session rows are matched by `session_id` and keep their cuid primary keys. One deviation from the source project: no `user_id` column — tenancy rides on `session_id`.

SQL Server note: Prisma's sqlserver connector has no `Json` type, so its variant maps the JSON columns to text — the backend serializes them on write automatically (SQL Server's `ISJSON` / `JSON_VALUE` still query the text as JSON).

Mirroring is a no-throw seam: backend errors are logged with a `[dsh-storage]` prefix and never escape into the agent loop.

## Compatibility

Pinned dsh/cordis versions live in the [root compat matrix](../../README.md#compatibility). Event payloads ride pre-release dsh APIs — check the `TODO(verify)` markers in `src/` before upgrading dsh.

## License

MIT
