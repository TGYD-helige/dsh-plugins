# @amaster.ai/dsh-a2a

![dsh-a2a preview](preview.png)

A2A protocol server plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): expose dsh agents as [A2A](https://github.com/a2aproject) agents — streaming turns, task cancel, agent card, and pluggable task-state stores. Speaks **A2A 1.0** (JSON-RPC + SSE) on [`@a2a-js/sdk`](https://github.com/a2aproject/a2a-js) 1.x, with the SDK's opt-in **v0.3 compatibility layer** kept on so pre-1.0 clients keep working. Ported from the source project's `packages/a2a-server`.

`dsh-a2a` is the network boundary for a dsh agent. It gives A2A clients a stable task-oriented interface while the agent continues to use the profile's models, presets, tools, and workspace rules.

## Install

```sh
dsh plugin --profile my-agent add @amaster.ai/dsh-a2a
```

## Native inbox execution

`inbox.enabled: true` opts into durable native DSH input instead of request-serialized execution. **This requires the unreleased upstream native inbox capability (`ctx.agents.nativeInboxVersion === 1`); the tested `0.2.0-rc.2` runtime does not provide it.** Startup rejects unsupported factories before opening a backend. Legacy execution remains the default.

In this mode, ordinary `SendMessage` / `SendStreamingMessage` calls enter the DSH inbox before their initial task response is published. Nonblocking sends return a submitted task after durable admission. A context owns one agent, while tasks retain separate message identities, streams, and terminal states. A completed unit of work settles `completed`; use the same context with a new task for later work. Disconnecting an HTTP client does not cancel execution. Task snapshots, polling, and subscriptions use the standard A2A operations.

The optional [inbox extension](../../docs/protocol/inbox-v1.md) selects parked admission (`wakeup: false`) or next-step steering (`target: next-step`). Steering must address the currently active task. It cannot pull an unrelated task's input into the active model step.

The same-process `a2aInbox` service implements the exported `A2aInbox` interface:

```ts
const inbox = ctx.get('a2aInbox') as A2aInbox;
const agent = await inbox.resolve(contextId);
const blocks = await inbox.content(message, contextId);
await inbox.enqueue(taskId, message); // Host follow-up with explicit task ownership.
await inbox.pause(contextId);
await inbox.wake(contextId); // Leaves a persisted pause intact.
await inbox.wake(contextId, { resume: true }); // Explicitly unpauses existing work.
await inbox.cancel(taskId, { retainInbox: true }); // Terminal task; pending input stays parked.
```

`pause` cancels active tasks while retaining their unconsumed input and other queued tasks; resumed input from a canceled task gets a fresh task identity. `CancelTask` remains terminal and removes that task's pending input, retaining other tasks' input. The service's explicit retention option parks the context; resuming retained input creates a new task when its former owner is terminal. `a2aTasks.clearContext` discards pending work even when idle. Plugin unload preserves the native inbox and drains its session writes. For restart recovery, configure durable DSH session persistence and a Redis or GCS TaskStore, then call `wake` for the contexts the host chooses to restore. `SubscribeToTask` observes recovered work without submitting a wake message.

In native mode, host settlement hooks submit follow-ups through `a2aInbox.enqueue(taskId, message)`; it binds and persists the task identity before enqueueing. Raw `Agent.send` / `followup` inputs without A2A attribution are rejected rather than assigned to the most recent hook.

`a2a/before-followup` validates admission; use `a2a/before-assembly` for per-input runtime state. The latter runs after the model-step batch is selected, before prompt assembly, and receives the same `A2aTurnContext` fields. Request headers are process-local: restored inputs receive `requestHeaders: undefined`. Persist replay-safe metadata in the message, never credentials in the queue. Admission observers remain non-vetoing.

Recovery only restores an interrupted claim without a committed `user/message`; it never replays committed model input or promises exactly-once tool effects. A task with committed input, no remaining pending input, and no durable terminal A2A checkpoint becomes failed on recovery, including when the turn ended before the process stopped. The host can then decide what to do next. Keep file parts on persistent storage with `uploadsDir` or `a2aFileMaterializer` when queued inputs must survive host or machine restarts. The memory TaskStore and temporary upload default do not provide that durability. In-process task handles remain until context clear or plugin unload; long-lived hosts should clear finished contexts.

Run the real loop / A2A HTTP / JSONL recovery checks against a prepared upstream checkout:

```bash
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness node .github/scripts/check-native-inbox.mjs
```

The Integration workflow runs this suite without secrets, including on fork PRs, against a pinned upstream source checkout plus the checked-in native inbox source companion. It verifies insertion during an active turn, FIFO execution, independent task completion, and exactly one user-message commit per input.

The checkout needs its installed dependencies and `pnpm run build:native-system`; model responses are scripted, so this check needs no gateway or model credentials. The upstream source companion is required before native mode can be released; no dependency artifact patch is installed by this plugin.

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
        heartbeat:
          enabled: false     # opt in to SSE heartbeats
          intervalMs: 15000  # positive integer, at most 2147483647
        cwd: /srv/agent-workspaces
        uploadsDir: ''         # file-part upload root; empty = <OS temp>/dsh-a2a-uploads/<date>
        subagentTools:
          enabled: false      # opt in to attributed local descendant tool calls/results
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
- `POST <basePath>/` — JSON-RPC. v1 methods: `SendMessage` (blocking by default, `configuration.returnImmediately: true` returns after the first event), `SendStreamingMessage` (SSE), `GetTask`, `ListTasks` (filter + cursor pagination), `CancelTask`, `SubscribeToTask` (the current task is the first event; the bus stays alive while the task is interrupted, so interrupted tasks can be re-followed live). v0.3 spellings (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`) keep working through the compat layer. Legacy SSE status updates that end an interaction carry `final: true`, including `input-required` after a completed turn or an approval wait; this ends the stream without making the task terminal. Resubscribe snapshots keep waiting for future events while a live task bus exists. Legacy `tasks/get` also accepts `contextId` without `id` on this path or root `/`, returning the latest stored task or `result: null` when absent.

## Behavior notes

- **One task = one dsh session.** The A2A `contextId` IS the dsh session id. By default, a completed turn ends `input-required`, not `completed` — the task is a conversation and stays continuable; `CancelTask` and turn errors are terminal (`canceled` / `failed`), and the SDK rejects follow-ups addressed at a terminal `taskId` (send with only the `contextId` to continue the session under a fresh task id).
- **Same-task messages.** `ctx.on('a2a/working-task-message', async (detail) => { ... })` runs when another message targets an executing task, before waiting for that task's prior request. Its detail contains `agent`, `contextId`, `taskId`, the original `a2aMessage` (including its `messageId`), `requestHeaders`, and an abort `signal`; the host can use it to end or revise pending continuation. Failure rejects the new request without enqueueing it. The plugin still serializes agent follow-ups.
- **Host admission and settlement.** `ctx.on('a2a/before-followup', async (detail) => { ... })` runs before every user message enters the agent inbox. Its detail contains `agent`, `contextId`, `taskId`, the original `a2aMessage`, `dshMessageId`, `requestHeaders`, and an abort `signal`; rejection fails the A2A task without enqueueing the message. A host may inspect its own A2A message metadata here; the plugin does not interpret it. The existing `a2a/message-admitted` event remains an observational tap after insertion. A host can register `ctx.on('a2a/task-settlement', async ({ agent, contextId, taskId, reason, signal }, next) => { await hostWork; return next(); })`. The hook starts after the first completed turn and may wait for any number of autonomous follow-ups, including none. The plugin streams their events under the same task ID and publishes the latest turn's final status when the hook resolves. Cancel, clear, and disposal abort the signal and release the waiter. Without this hook, the first completed turn settles as before. The host must end its wait when its work is done; the plugin does not infer that from product metadata.
- **Agents are full preset citizens.** Each task's agent is created with the deployment's default model selection (`agentDefaultModel`) and mounts its agent preset (the web profile keeps all tools inside presets — without one the agent would see an empty tool catalog). `agent.preset` pins a specific preset.
- **Streaming aggregation.** Text deltas of a turn share one `messageId`, so clients accumulate them into a single message; reasoning deltas ride a separate `messageId` and are marked `metadata.dshAgent.kind: 'thought'`. The turn-final event's message carries the full assembled text, so blocking `SendMessage` clients read the answer from `result.task.status.message`. Tool calls/results are data parts marked `tool-call` / `tool-result`; token usage lands in `metadata.usage` of the final event. A2A 1.0 has no `final` flag — terminal and interrupted states close the stream.
- **Message parts beyond text.** File parts can carry inline bytes or a `url`; the plugin downloads URLs over http/https, bounded to 64 MiB and 30 s. Supported images use the composed attachment store (`ctx.attachments`, e.g. `@deepseek-ai/dsh-attachment-local`) to reach vision-capable models. Non-image files use a configured materializer or persist under `uploadsDir` (default `<OS temp>/dsh-a2a-uploads/<date>/`, names sanitized cross-platform, collisions suffixed), even when an attachment store exists. The prompt references the resulting readable path inside a `<document>` tag. Ensure the local directory is readable by the agent's tools. `data` parts become `<data>` JSON text. A turn never fails because a part kind is unsupported.
- **Remote execution files.** A deployment can register `ctx.provide('a2aFileMaterializer', { materializeFile })`, using the exported `A2aFileMaterializer` type. The callback receives `{ contextId, bytes, filename, mediaType }` (with a sanitized basename) and returns `{ readablePath }`, a path readable by that context's file/shell tools. When configured, non-image FileParts use the materializer instead of `ctx.attachments.saveFile()`; the model receives the returned `<document path="...">`. Images keep the existing attachment handling. A failed callback yields a delivery note, never a host-path fallback. The deployment owns sandbox selection, upload, and lifetime; no E2B SDK is required by this plugin.
- **Local execution files.** Without a remote materializer, inline and downloaded non-image FileParts persist under `uploadsDir`; the `<document>` envelope carries the path, source URL, media type, size, and original filename when sanitization or a collision changes it. Images still use native attachment handling.
- **Tool approvals.** When the profile composes `@deepseek-ai/dsh-user-approval` with policy `ask`, A2A-owned agents answer `approval/request` by publishing `input-required` with a DataPart `{ requestId, toolName, reason?, callId? }`. Reply on the same `taskId`/`contextId` with one DataPart `{ requestId, callId?, outcome: "allowed-once" | "rejected" }`. The reply settles the waiting tool call inside the original dsh turn; it does not create another user message or billing turn. Invalid, duplicate, and withdrawn replies are rejected. `never` policy rejects inside dsh before the A2A answerer is called. The approval service is optional; without it, `ask` fails closed as usual.
- **Custom approval payloads.** A deployment may register `ctx.provide('a2aApprovalCodec', codec)` before this plugin starts. The exported `A2aApprovalCodec` has `encode(request)` and `decode(message)` methods; `decode` returns `{ requestId?, callId?, outcome }` only for a supported one-shot decision. A unique `callId` can replace `requestId` for legacy clients. Reject unsupported outcomes in the decoder; never translate `proceed_always` into `allowed-once`. Other message types, including question, plan, and UI markup, remain outside this plugin.
- **Requests for one task execute in order.** Autonomous turns covered by a settlement hook finish before the next user request starts. Approval confirmations settle a pending decision inside its current turn.
- **Restart**: persisted task shells survive in Redis/GCS. With `sessionPersistence` composed, a `contextId` already present on disk resumes its dsh session after restart; a new id creates a new session.
- **Clear**: the same-process gateway can call `ctx.get('a2aTasks').clearContext(contextId)` before reporting `messages/clear` success. It cancels and drains the live turn, removes the binding and every TaskStore shell for that context, and returns the removed task IDs. The gateway owns the separate session-surface replacement and client-visible history-ID update.

## SSE heartbeats

Set `heartbeat.enabled: true` to send heartbeats every `heartbeat.intervalMs`
(default 15000 ms). The default is disabled. Intervals must be positive integers
no greater than 2147483647 ms (Node's timer limit). This covers
`SendStreamingMessage` / `SubscribeToTask` and their legacy
`message/stream` / `tasks/resubscribe` equivalents. The timer starts after the
SDK commits SSE headers; pre-stream validation and failures retain their JSON
responses. There is no heartbeat while waiting for the SDK's first stream event.

Heartbeats are JSON artifact updates with `artifact.name === "heartbeat"`, so
clients that refresh their idle timer on parsed JSON messages receive activity
throughout otherwise idle task streams. Legacy streams receive:

```text
data: {"jsonrpc":"2.0","id":"<request-id>","result":{"kind":"artifact-update","taskId":"<task-id>","contextId":"<context-id>","artifact":{"artifactId":"heartbeat","name":"heartbeat","parts":[]},"append":false,"lastChunk":false}}

```

Native A2A 1.0 streams use `result.artifactUpdate` with the same fields (without
`kind`). Identifiers come from the current request and streamed task, including
resubscription requests. Clients should refresh their idle timer and discard
these empty heartbeat artifacts without displaying content. Heartbeats are sent
directly on the transport, never persisted as task artifacts or history, and do
not change task status, completion, or event IDs. Reverse proxies must forward
streaming bytes without buffering for keepalives to reach the client.

Heartbeats are skipped while the response requires drain, with no heartbeat
queue or catch-up burst. Timers stop on completion, disconnect, response errors,
and server disposal. Heartbeats require a responsive event loop; they cannot
repair event-loop starvation or guarantee delivery during backpressure.

## Subagent tools

`subagentTools.enabled` defaults to `false`. When enabled, tool calls/results from local descendant sessions created inside `tools/execute` are forwarded to the owning A2A task. Each child has a separate translator: its text, reasoning, usage and turn state never enter the parent's translator, and child completion or disposal never settles the parent task. Main-agent streaming keeps its existing format.

Child events retain the parent's A2A `taskId` and `contextId`. `metadata.dshAgent.source` carries `{ sessionId, agentId, parentSessionId, parentCallId }` (exported as `SubagentToolSource`): the source child, its immediate parent, and the exact dispatch call that created it. DSH agent IDs are session IDs. Use `(source.sessionId, data.callId)` to identify a child tool call; use `(source.parentSessionId, source.parentCallId)` to attach it to its delegation, including nested descendants. The link is captured with async dispatch context, never inferred from event ordering or descriptions. Verified against DSH 0.2.0-rc.1 and 0.2.0-rc.2's in-process child creation path.

Forwarding follows the owning task's active request bus. Background child events between streams are dropped, with no buffering, replay, extra stream or extension of parent settlement; if the same task opens another stream, live events can appear there. Rebinding the parent context to a new task permanently excludes children created for the old task. Providers running outside this process expose no local child events, so only their parent delegation call/result remain visible. Sessions without a captured dispatch link (including children loaded after a process restart, or created outside tool dispatch) are not forwarded; durable attribution for those cases requires an upstream DSH lineage field.

## Task stores

A2A task snapshots retain protocol history and artifacts; [dsh-storage](../dsh-storage) separately records the full conversation. Backends save on task-state transitions, including the complete reply at `input-required`, so token-rate stream events never reach Redis or GCS. While a task is working, in-process history accumulates text deltas for `GetTask` and resubscription; a restart before the next state change can lose those transient deltas.

- `memory` (default) — in-process, lost on restart
- `redis` — task JSON under `<keyPrefix>:tasks:<scope>:<taskId>` with a TTL; requires the `ioredis` peer
- `gcs` — gzipped task JSON at `<prefix>/<scope>/<taskId>/metadata.json.gz`; requires the `@google-cloud/storage` peer. `archiveWorkspace()` (tar of the workspace) exists but is not wired to the lifecycle yet.

`<scope>` is a hash of the A2A tenant and user. Older unscoped Redis/GCS task records are not read after this upgrade; migrate known records into their scope or let them expire before rollout.

## Security

dsh ships **no authentication or authorization**. The server binds `127.0.0.1` by default; if you expose it, put an authenticated reverse proxy in front and treat every agent as running with the host process's OS privileges. File parts carrying a `url` are fetched server-side (http/https only, bounded) — another reason to keep the endpoint off untrusted networks.

## Compatibility

Pinned dsh/cordis versions live in the [root compat matrix](../../README.md#compatibility). Event payloads ride pre-release dsh APIs (`@deepseek-ai/dsh-{agent,session,llm,attachment,tools}@0.2.0-rc.2` — the attachment store is an optional peer) — the session peer floor is `>=0.2.0-rc.1` because child attribution uses `firstLifecycleSeq` to reject restored sessions; check the `TODO(verify)` markers in `src/` before upgrading dsh.

## License

MIT
