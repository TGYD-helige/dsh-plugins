# A2A recovery discovery (#104)

## Problem Statement

Hosts currently discover durable A2A work by opening every session log. Using
the public task list instead would hydrate full task pages and repeatedly scan
the same scope. Neither is necessary for discovering candidate contexts.

## Solution

Expose same-process `a2aInbox.recoveryCandidates(call?)` returning distinct
context IDs from durable nonterminal task checkpoints, without opening sessions,
creating agents or waking work. Candidates are a conservative superset: task
status cannot establish whether native input is unclaimed, paused or consumed.
Hosts still prepare identity, resolve candidates and decide whether to wake.

## User Stories

1. As a host, I can discover candidates without reading full conversation logs.
2. As an operator, I can restart using my existing filesystem, Redis or GCS store.
3. As an existing user, I can recover tasks lacking modern listing summaries.
4. As a tenant, I cannot discover another tenant's or owner's contexts.
5. As a paused user, discovery does not execute my pending input.

## Implementation Decisions

- Reuse atomic task listing summaries, not a separately written index.
- Enumerate a scope once per discovery call; no full modern snapshot hydration,
  sorting, exact count or task-page traversal is needed.
- Include all nonterminal and unknown states; omit completed, canceled, failed
  and rejected tasks, whose retained input requires explicit resume.
- Return sorted, deduplicated context IDs; preserve exact case.
- Legacy, malformed or oversized summaries use the existing snapshot fallback.
  Backend failures reject discovery rather than return a misleading empty set.
- Scope uses the SDK's tenant and user scope. No application routing is added.
- Hosts pass the same call context to `resolve(contextId, call)`; an explicit
  scope mismatch with an already loading/loaded context rejects. Agent context
  IDs remain global within a plugin instance.
- Optional custom stores fall back to exhaustive task pagination.
- Memory stores expose the same API but provide no restart durability.
- Redis durability and task expiry remain properties of the operator's Redis
  configuration. Session logs and uploaded files must also survive restart.

## Testing Decisions

The user confirmed two public test seams: inbox discovery (no agent creation or
waking, deduplication and scope), and TaskStore (backend parity, restart reads,
legacy/corrupt-summary fallback and operation counts). Existing task listing,
retention, pagination and inbox tests protect unchanged behavior.

## Out of Scope

Native session catalog queries, Agent history SQL, an independent pending-only
index, cross-process scheduling, replay of consumed claims, and deployment.

## Further Notes

Discovery remains O(task count) in lightweight summaries. Hosts must retain
their legacy session fallback where task snapshots were not durably retained
or have expired; this API cannot prove coverage of orphaned session logs.
