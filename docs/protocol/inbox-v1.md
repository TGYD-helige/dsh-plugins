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

A persisted context pause overrides `wakeup: true`. Resuming or editing queues remains a typed same-process host operation; this extension does not grant those privileges through message metadata. Standard A2A task queries and subscriptions observe execution. A subscription never wakes input. One context may contain several distinct tasks, which the shared agent executes serially.

Successful admission preserves the original A2A `messageId` alongside the native DSH message identity. A failing observer cannot veto insertion. Admission validation failures on an existing task reject that request without terminating previously accepted work. A completed work unit is terminal; `CancelTask` is terminal as well. Explicitly retained input is parked and, if its task is terminal, receives a fresh task on explicit host resume. The replacement messages reference the former task through `referenceTaskIds`; the canceled task is never restarted.

The extension has no exactly-once execution or tool-effect guarantee. The server recovers only uncommitted interrupted claims. It does not automatically replay input already committed as `user/message`, and a durable pause survives a host restart. Actual persistence requires both a durable DSH session backend and a durable A2A TaskStore.
