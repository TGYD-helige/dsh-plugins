# @amaster.ai/dsh-a2a

![dsh-a2a preview](preview.png)

A2A protocol server plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): expose dsh agents as [A2A](https://github.com/a2aproject) agents — streaming turns, task cancel, agent card, and pluggable task-state stores. Speaks **A2A 1.0** (JSON-RPC + SSE) on [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) 1.x, with the SDK's opt-in **v0.3 compatibility layer** kept on so pre-1.0 clients keep working. Ported from the source project's `packages/a2a-server`.

`dsh-a2a` is the network boundary for a dsh agent. It gives A2A clients a stable task-oriented interface while the agent continues to use the profile's models, presets, tools, and workspace rules.

## Install

```sh
dsh plugin --profile my-agent add @amaster.ai/dsh-a2a
```

## Configuration

Disabled by default. Configure via the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: a2a
      name: '@amaster.ai/dsh-a2a'
      config:
        enabled: true
        host: 127.0.0.1        # no auth built in — keep loopback or front with a proxy
        port: 41241
        basePath: /a2a
        cwd: /srv/agent-workspaces
        uploadsDir: ''         # file-part upload root; empty = <OS temp>/dsh-a2a-uploads/<date>
        agent:
          provider: ''       # dsh provider/model for A2A sessions; empty = profile default
          model: ''
          preset: ''         # agent preset mounted per task; empty = deployment default
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

- `GET /.well-known/agent-card.json` — agent card: A2A 1.0 shape for `A2A-Version: 1.0` clients, the 0.3 shape for headerless clients (the legacy `/.well-known/agent.json` path is served as an alias)
- `POST <basePath>/` — JSON-RPC. v1 methods: `SendMessage` (blocking by default, `configuration.returnImmediately: true` returns after the first event), `SendStreamingMessage` (SSE), `GetTask`, `ListTasks` (filter + cursor pagination), `CancelTask`, `SubscribeToTask` (the current task is the first event; the bus stays alive while the task is interrupted, so interrupted tasks can be re-followed live). v0.3 spellings (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`) keep working through the compat layer. Legacy `tasks/get` also accepts `contextId` without `id` on this path or root `/`, returning the latest stored task or `result: null` when absent.

## Behavior notes

- **One task = one dsh session.** The A2A `contextId` IS the dsh session id. A completed turn ends `input-required`, not `completed` — the task is a conversation and stays continuable; `CancelTask` and turn errors are terminal (`canceled` / `failed`), and the SDK rejects follow-ups addressed at a terminal `taskId` (send with only the `contextId` to continue the session under a fresh task id).
- **Agents are full preset citizens.** Each task's agent is created with the deployment's default model selection (`agentDefaultModel`) and mounts its agent preset (the web profile keeps all tools inside presets — without one the agent would see an empty tool catalog). `agent.preset` pins a specific preset.
- **Streaming aggregation.** Text deltas of a turn share one `messageId`, so clients accumulate them into a single message; reasoning deltas ride a separate `messageId` and are marked `metadata.dshAgent.kind: 'thought'`. The turn-final event's message carries the full assembled text, so blocking `SendMessage` clients read the answer from `result.task.status.message`. Tool calls/results are data parts marked `tool-call` / `tool-result`; token usage lands in `metadata.usage` of the final event. A2A 1.0 has no `final` flag — terminal and interrupted states close the stream.
- **Message parts beyond text.** File parts (inline bytes or a `url` — the plugin downloads those over http/https, bounded to 64 MiB and 30 s) become durable image/file content blocks when the deployment composes an attachment store (`ctx.attachments`, e.g. `@deepseek-ai/dsh-attachment-local`): images reach vision-capable models natively, and every file projects to deterministic handle text naming the file and — on host-file-backed stores — its read-only saved path. Without a store, files persist under the configured `uploadsDir` (default `<OS temp>/dsh-a2a-uploads/<date>/`, names sanitized cross-platform, collisions suffixed) and the prompt references them by absolute path inside a `<document>` tag, so the agent reads or converts them with its own tools. `data` parts become `<data>` JSON text. A turn never fails because a part kind is unsupported.
- **No approval bridge**: dsh ships the mid-turn approval seam only as the optional `dsh-user-approval` package, which headless profiles do not compose, so tools that would ask are governed by the profile's own approval setup; the A2A side never enters a mid-turn `input-required`.
- **One in-flight message per task** is the supported flow (send the next message after the turn-final event). dsh serializes queued follow-ups into successive turns, but concurrent requests share one event bus — a second in-flight request may resolve with the first turn's final event.
- **Restart**: persisted task shells survive in Redis/GCS. With `sessionPersistence` composed, a `contextId` already present on disk resumes its dsh session after restart; a new id creates a new session.
- **Clear**: the same-process gateway can call `ctx.get('a2aTasks').clearContext(contextId)` before reporting `messages/clear` success. It cancels and drains the live turn, removes the binding and every TaskStore shell for that context, and returns the removed task IDs. The gateway owns the separate session-surface replacement and client-visible history-ID update.

## Task stores

A2A **task state** (status + metadata) is separate from conversation history — use [dsh-storage](../dsh-storage) for the latter. Every backend persists a sanitized metadata shell (history/artifacts stripped) and saves only on task-state transitions, so token-rate stream events never reach the backend.

- `memory` (default) — in-process, lost on restart
- `redis` — task JSON under `<keyPrefix>:tasks:<taskId>` with a TTL; requires the `ioredis` peer
- `gcs` — gzipped task JSON at `<prefix>/<taskId>/metadata.json.gz` (same layout as the source project's `GCSTaskStore`); requires the `@google-cloud/storage` peer. `archiveWorkspace()` (tar of the workspace) exists but is not wired to the lifecycle yet.

## Security

dsh ships **no authentication or authorization**. The server binds `127.0.0.1` by default; if you expose it, put an authenticated reverse proxy in front and treat every agent as running with the host process's OS privileges. File parts carrying a `url` are fetched server-side (http/https only, bounded) — another reason to keep the endpoint off untrusted networks.

`create_by` uses `x-platform-user-id`, falling back to `x-app-user-id`. These headers are not verified by dsh-a2a; a trusted gateway must remove client-supplied copies and set them from its authenticated identity before forwarding requests.

## Compatibility

Pinned dsh/cordis versions live in the [root compat matrix](../../README.md#compatibility). Event payloads ride pre-release dsh APIs (`@deepseek-ai/dsh-{agent,session,llm,attachment}@0.1.6-alpha.2` — the attachment store is an optional peer) — check the `TODO(verify)` markers in `src/` before upgrading dsh.

## License

MIT
