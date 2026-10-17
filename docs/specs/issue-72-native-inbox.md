# Native inbox execution over A2A

## Problem

A2A hosts cannot durably queue input, steer a running task, or wake restored input without private bridge state or duplicate admission. Task rebinding currently cancels queued work. A request-owned event bus also leaves later work unobserved.

## Solution

An opt-in native inbox executor accepts ordinary A2A messages into the DSH inbox before execution. Contexts retain one agent, while each A2A task keeps its own identity, translator, and stream. Execution does not depend on an attached HTTP client. Standard task queries and subscriptions observe queued and restored work.

The optional inbox extension selects next-step steering or parked admission. Ordinary clients need no extension. It never introduces a wake message. A typed same-process service resolves an agent, converts content, pauses a context, and wakes existing work. Cancellation remains terminal; retained input belonging to a terminal task receives a new task on an explicit resume.

## Ownership

- DSH owns inbox mutations, prompt assembly, and driver lifetime. An independent upstream source change adds public wake-only execution, awaited pre-assembly preparation, and preservation during disposal.
- The plugin owns A2A attribution and task delivery. It stores attribution in the native input source and pause intent in the session log, without a second queue.
- Request headers remain process-local and are not persisted. Restored preparation receives no original credentials.
- Recovery requeues only claimed input without a committed user/message. Committed input and external tool effects are never automatically replayed.
- Legacy execution remains the default. Native mode fails explicitly on a runtime without the required capability.

## Validation

Tests exercise standard A2A sends, task snapshots and subscriptions, and the typed inbox service using the repository's real Cordis contexts with fake agent drivers. They cover FIFO queueing, steering, per-input preparation, observer failure containment, cancellation versus pause, active/idle clearing, restart attribution, and interrupted claims. Upstream tests exercise wake without insertion, preparation before assembly, and teardown retention using the real loop. The keyless integration runner covers real A2A HTTP/SSE and cold JSONL restoration with scripted model responses. It includes cancellation before recovery, retained steering alongside another task, factory-first teardown, and admission rejection without phantom input.

## Exclusions

No product metadata interpretation, scheduler, second queue store, exactly-once external effects, or changes to installed dependency artifacts. Upstream publication and live gateway/database E2E require separate validation.
