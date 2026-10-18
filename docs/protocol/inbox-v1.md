# Native inbox extension v1

URI: `https://github.com/TGYD-helige/dsh-plugins/blob/main/docs/protocol/inbox-v1.md`

This optional A2A extension selects when an admitted message becomes runnable. It adds no RPC methods or wake messages. Servers advertise it in `AgentCard.capabilities.extensions` only when native inbox mode is enabled. Clients opt in through `A2A-Extensions`; the metadata key below is the complete extension URI. Unknown control keys, invalid values, and controls without negotiated support are rejected before admission.

```json
{
  "message": {
    "messageId": "input-2",
    "taskId": "existing-active-task",
    "role": "ROLE_USER",
    "parts": [{ "text": "Use the revised requirements" }],
    "metadata": {
      "https://github.com/TGYD-helige/dsh-plugins/blob/main/docs/protocol/inbox-v1.md": {
        "target": "next-step",
        "wakeup": true
      }
    }
  },
  "configuration": { "returnImmediately": true }
}
```

| Control | Values | Default | Meaning |
| --- | --- | --- | --- |
| `target` | `next-turn`, `next-step` | `next-turn` | Queue an ordinary turn, or steer the currently active addressed task at its next model-step boundary. |
| `wakeup` | boolean | `true` | Permit the driver to run after durable admission. `false` does not stop an already active driver from consuming pending work at its normal boundaries. |

These controls are forwarded directly to the official DSH `Agent.send(message, target, wakeup)` interface. The extension adds no pause, wake-only, or resume operation. Standard A2A task queries and subscriptions observe execution; subscriptions never wake input. One context may contain several tasks, executed by its shared agent.

Successful admission preserves the original A2A `messageId` alongside the DSH message identity. A failing observer cannot veto insertion. Validation failures on an existing task reject the request without terminating previously accepted work. Completion and `CancelTask` are terminal; later work uses a new task, with `referenceTaskIds` if the client wants to reference an earlier task.

DSH owns pending-input persistence and execution. This extension does not replay consumed claims, automatically restart terminal tasks, or guarantee exactly-once execution or tool effects. Durable protocol task queries additionally require a durable A2A TaskStore.

Same-process hosts may promote an unclaimed independent queued input through `a2aInbox.promote(contextId, nativeMessageId, activeTaskId)`. This is not a wire metadata privilege. Promotion preserves both message identities, transfers next-step ownership to the active task and settles the original task canceled. Ordinary future turns should use independent task identities so a failure in the active task does not discard them.

Local recovery requires durable DSH session persistence and a durable TaskStore (`filesystem` with a retained `filesystem.root`, Redis, or GCS). Hosts own startup discovery and waking. Promotion recovery repairs incomplete ownership moves only; consumed claims and committed model input are not automatically replayed. Explicit cancellation stays terminal.

Hosts may opt into `inbox.shutdown: retain-pending` (default: `cancel`) together with `inbox.enabled`. Graceful plugin unload stops execution and checkpoints unclaimed next-step/next-turn inputs, ordering and original message identities in the durable TaskStore. This checkpoint survives subsequent core disposal clearing the native inbox. Tasks owning retained input stay nonterminal; interrupted tasks without pending input fail. Existing request/subscription streams close, and callers reconnect after restart. Resolution restores the checkpoint before accepting new input and excludes committed `user/message` IDs. Explicit cancellation and context clearing remain terminal. Retain the same policy and durable session/TaskStore directories across restart; discovery and waking remain host responsibilities. This does not resume an interrupted model call or guarantee exactly-once tool effects.
