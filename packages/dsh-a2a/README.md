# dsh-a2a

A2A protocol (JSON-RPC + SSE) server plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): expose dsh agents as [A2A](https://github.com/a2aproject) agents — task create/cancel, streaming, agent card, and pluggable task-state stores.

## Install

```sh
dsh plugin --profile my-agent add dsh-a2a
```

## Configuration

Disabled by default. Configure via the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: a2a
      name: dsh-a2a
      config:
        enabled: true
        host: 127.0.0.1        # no auth built in — keep loopback or front with a proxy
        port: 41241
        basePath: /a2a
        cwd: /srv/agent-workspaces
        agent:
          provider: ''       # dsh provider/model for A2A sessions; empty = profile default
          model: ''
        card:
          name: my-agent
          description: My dsh agent over A2A
          version: 0.1.0
          publicUrl: https://agent.example.com
        taskStore: redis       # memory | redis | gcs
        redis:
          url: redis://127.0.0.1:6379
          keyPrefix: a2a
          ttlSeconds: 86400
        gcs:
          bucket: my-agent-archives
          prefix: tasks
          keyFilename: ''      # GOOGLE_APPLICATION_CREDENTIALS path; empty = ADC
```

## Endpoints

- `GET /.well-known/agent.json` (and `<basePath>/.well-known/agent.json`) — agent card
- `POST <basePath>/` — JSON-RPC endpoint (`message/send`, `message/stream` over SSE, `tasks/get`, `tasks/cancel`)

## Task stores

A2A **task state** (task metadata, `contextId → taskId` index) is separate from conversation history — use [dsh-storage](../dsh-storage) for the latter.

- `memory` (default) — in-process, lost on restart
- `redis` — task metadata JSON + TTL; requires the `ioredis` peer
- `gcs` — gzipped task metadata + optional workspace tar archive (same layout as the source project's `GCSTaskStore`); requires the `@google-cloud/storage` peer, and shells out to `tar` for archiving

## Security

dsh ships **no authentication or authorization**. The server binds `127.0.0.1` by default; if you expose it, put an authenticated reverse proxy in front and treat every agent as running with the host process's OS privileges.

## Compatibility

Pinned dsh/cordis versions live in the [root compat matrix](../../README.md#compatibility). Event payloads ride pre-release dsh APIs — check the `TODO(verify)` markers in `src/` before upgrading dsh.

Known gaps: the session-event → A2A event translation table is a stub (`translateSessionEvent` in `src/bridge.ts`), and the `@a2a-js/sdk` transport is not wired yet — the Redis/GCS stores are created from config but not yet fed by the SDK handler.

## License

MIT
