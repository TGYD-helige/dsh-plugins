# Native DSH inbox extension, v1

URI: `https://github.com/TGYD-helige/dsh-plugins/blob/main/docs/protocol/inbox-v1.md`

This is a project extension, not an official A2A extension. It follows the
[A2A extension mechanism](https://a2a-protocol.org/v1.0.1/topics/extensions/).
The Agent Card advertises it when `inbox.enabled` is true. Activate it with the
`A2A-Extensions` HTTP header. Responses echo that header. Standard task methods,
states, subscriptions and Push configurations keep their official meanings.

## Methods

Send JSON-RPC 2.0 requests to the advertised JSONRPC endpoint. All methods take
`contextId`. IDs named `id` below are **native inbox message IDs**, not task IDs.
The extension adds no REST or gRPC service; those clients can discover and use
the advertised JSONRPC endpoint for these operations.

| Method | Additional parameters | Result |
| --- | --- | --- |
| `dsh/inbox/get` | — | Live inbox snapshot |
| `dsh/inbox/update` | `id`, `message` (A2A 1.0 user Message) | Updated snapshot |
| `dsh/inbox/move` | `id`, `index` (zero-based destination in the same list) | Updated snapshot |
| `dsh/inbox/remove` | `id` | Updated snapshot |
| `dsh/inbox/clear` | — | Snapshot after clearing pending input |
| `dsh/inbox/execute` | Optional `id` to move first in the next-turn list | Snapshot after waking pending work |
| `dsh/inbox/steer` | `id`, `taskId` (active target) | Snapshot after promotion |
| `dsh/inbox/subscribe` | — | SSE JSON-RPC result stream of `{contextId, version}` |

A snapshot is `{contextId, version, nextTurn, nextStep}`. Each entry is
`{id, message, editable}`: `message` uses the standard A2A 1.0 Message JSON shape.
Native inputs without A2A ownership expose text and have `editable: false`;
editing them requires the originating producer. Queue removal/reordering still
uses native IDs. Updates preserve native/protocol IDs, context and task ownership;
they cannot replace message identity or edit already claimed input. Index is
evaluated after removing the selected item. Execute preserves other pending
items and their order; steer reuses the existing task-ownership promotion rules.
Explicit execution also drives native-producer input without inventing an A2A
Task for it; its conversation events remain in the native session history.
Reading or subscribing does not gate input from native producers. An already
live native agent is reused with its existing setup and lifecycle owner. Plugin
shutdown leaves native work running; it detaches plugin-owned queued A2A input,
retaining it in task metadata only under the configured retention policy.
Clearing pending input does not cancel an active turn; use standard CancelTask
for task cancellation. Removed independent queued tasks become canceled.

Methods use SDK JSON-RPC error serialization. Invalid parameters and stale
claims are RequestMalformedError; missing extension activation is
ExtensionSupportRequiredError. Unknown extension methods return method-not-found.
No tenant namespace or authorization model is added: sessions are native DSH
contexts. The host must authenticate/authorize access before exposing this
loopback-default server. A nonempty tenant is rejected for these methods.

## Checkpointed invalidation

`version` is a session event sequence (last included event, initially -1), not a
task revision. Snapshots describe the live queue and may include newer changes
than a previously notified checkpoint. Do not treat a snapshot as a durability
acknowledgement. Mutation failures may occur after a native mutation; re-read
the authoritative queue before retrying. Same-process host observers opt in with
`inbox.notifications: true` (default false); an SSE subscription activates its
own session feed without enabling unused contexts.

Subscribe registers before checkpointing, then sends an initial invalidation
only after `ctx.sessions.flush(session)` returns true. Subsequent invalidations
observe native `agent/inbox/spliced` events, including edits and consumption,
coalesce changes per context, and checkpoint before publishing. A rejected or
false checkpoint produces no success notification. Later changes or reconnects
retry the current state; there is no durable outbox, replay or exactly-once
delivery. A host can consume the same feed through `a2a/inbox-checkpointed`.
Notification data contains no message bodies. Re-read `dsh/inbox/get` after an
invalidation and on reconnect. Each context checkpoints independently; slow SSE
clients disconnect instead of creating an unbounded notification backlog.
Closing the plugin unregisters observers/subscriptions and suppresses late sends.

## Existing admission metadata

Standard SendMessage/SendStreamingMessage continues to accept
`metadata[URI] = {target: 'next-turn' | 'next-step', wakeup: boolean}` on its
Message, negotiated as before. Prefer those standard methods for new input.
The operations above control already queued input; they do not add another
queue, consumer, task-state machine or webhook configuration store.
