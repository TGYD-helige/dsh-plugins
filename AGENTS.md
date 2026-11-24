# dsh-plugins agent guide

## Scope and workflow

Use skills from [ponytail](https://github.com/DietrichGebert/ponytail) and
[mattpocock/skills](https://github.com/mattpocock/skills/blob/main/skills/engineering/README.md)
when available. Follow this workflow directly when skill loading is unavailable.

1. **Scope.** For plugin work, use the [package map](README.md#packages) and the affected
   package README to find the documented dsh seams. Before changing or reviewing plugin
   behavior, read the relevant implementation and tests.
   Build reusable dsh or protocol capabilities on documented Cordis services, typed events,
   and waterfalls. Keep application identity headers, database fields, and workflows in the
   consuming application. Establish a concrete use case outside that application before
   adding a plugin option or compatibility path.
2. **Plan.** Confirm the change is needed. Reuse existing seams, helpers, standard APIs,
   or installed dependencies. Keep simple operations free of new dependencies.
   Before non-trivial implementation, define the behavior and split the work into
   verifiable changes. Use `to-spec` or `to-tickets` when explicitly requested.
   Create or update GitHub issues only with explicit user authorization.
3. **Implement.** Use `diagnosing-bugs` for bug fixes. Reproduce the failure and verify its
   cause before fixing it. Use the reported transport, backend, and configuration where
   feasible. Sanitize payload fixtures and check other callers, backends, and legacy reads.
   Use `tdd` for behavior changes and update affected README contracts and examples.
   Limit repository documentation to user-facing usage. Keep agent work records outside
   Git, including research notes, plans, review logs, and image prompts.
4. **Verify.** For behavior changes, start with a focused check through the normal entry
   point. Use [workspace scripts](package.json) and [CI](.github/workflows/ci.yml) to select
   broader checks. For docs, verify links, commands, and claims against their sources.
   For reviews, pin the diff and use `code-review` to check the requested behavior and
   repository rules independently. Confirm findings against source or a focused check.
   When fixing findings, rerun affected checks and review the revised diff until no
   actionable findings remain.
   Report the revision checked, results, remaining failures, and unverified integrations.

## Plugin changes

- **Bundle and config.** Export `name`, `inject`, `Config`, and `apply` and ship
  `cordis.patch.yml`. Use Schemastery, default plugins to disabled, and mark secrets with
  `.role('secret')`. Support the unmodified dsh runtime.
- **Compatibility.** Read the [compatibility matrix](README.md#compatibility) and manifests
  before changing dsh seams or dependencies. Verify event shapes against the pinned dsh
  source before relying on them or removing `TODO(verify)`. Mark unverified event
  assumptions with `TODO(verify)` and the upstream doc path. Declare consumed dsh packages
  as peers and pin tested versions in dev dependencies, including type-only imports.
  Keep the minimum compatible peer floor, include each supported prerelease tuple for npm,
  and update affected compatibility docs. Declare heavy backend clients as peers, mark
  optional clients optional, and load them via dynamic import during backend initialization.
- **Lifecycle.** Use `ctx.effect()` for startup and return a disposer for fiber unload.
  Tap settled events via `session/event(session, event)` and live deltas via
  `agent/assistant-stream`. Clean up on `session/disposed(session)`. At the awaited
  `session/flush(session)` checkpoint, drain the work required for that session
  by the plugin's contract.
- **Boundaries.** Keep Cordis context and I/O at plugin edges and backend behavior in
  adapters. Pass helpers the fields or service they need. Share code across installable
  packages when callers need the same contract and can evolve together. Name values after
  their event, state, or protocol field and keep decision order visible.
- **Failures.** Catch observer and mirror failures at event and waterfall boundaries
  and report them via `console.error` with a `[dsh-*]` prefix so they cannot break the
  agent loop. Preserve stored data after read or parse failures.
- **Hot paths.** Count file, database, and network calls per turn. Reuse valid reads and
  batch independent writes only when ordering, error handling, and the awaited flush
  are preserved. Check for repeated parsing or copying of accumulated chunks and preserve
  streaming and cancellation. Find the matching [performance checks](README.md#development).

## Package-specific checks

- **A2A.** Keep [A2A task state](packages/dsh-a2a/README.md#task-stores) in `dsh-a2a` and
  the conversation mirror in `dsh-storage`. For listener or deployment changes, preserve and
  document the [loopback default and external authentication boundary](packages/dsh-a2a/README.md#security).
- **Storage.** Preserve [pre-generated Prisma clients in the published package](packages/dsh-storage/README.md#install).
  For database changes, follow [SQL Server JSON serialization](packages/dsh-storage/README.md#data-model).
- **Policy.** Keep [unmatched calls delegated](packages/dsh-policy/README.md#matching-semantics)
  to the remaining gate chain via `next()`. Fail closed on evaluation failure or when
  a matched `ask` cannot obtain approval.
- **Tracing.** For telemetry field changes, inspect serialized exports, test redaction
  with dummy credentials, and document what leaves the process. In `dsh-langfuse` and
  `dsh-telemetry`, keep tracer providers isolated. Start closing turn spans on `turn/end`.
  If media is pending, retain the end time and close the span after media resolves.
  Preserve [legacy trace I/O attributes](packages/dsh-langfuse/README.md#trace-overview-compatibility)
  on independently owned roots exported to Langfuse. Let session checkpoints complete
  while [native OTLP exports](packages/dsh-telemetry/README.md#observations-and-request-context)
  are pending. Run `pnpm test:sdk` for Langfuse SDK changes and
  `pnpm test:otlp` for native OTLP changes. Run both for changes to shared tracing code
  or the `dsh-telemetry` Langfuse adapter.

## Tests and CI

- **Unit tests.** Colocate Vitest tests in `src/**/*.test.ts`, include them in no-emit
  typechecking, and exclude them from build output. Test pure logic directly.
  Drive plugin wiring with a real `@deepseek-ai/cordis` Context and mock external clients
  with `vi.mock`. Cover startup, flush, and fiber disposal as applicable. Assert hook
  failures are swallowed and logged at no-throw seams. Await events or use fake timers,
  and register cleanup before assertions. Show regressions fail before the fix and pass after it.
- **Integration.** Put tests needing a real dsh runtime, LLM, or database in
  [.github/scripts/integration/](.github/scripts/integration/) and follow
  [matrix discovery](.github/scripts/integration-matrix.mjs) for scenario and provider names.
  Pin the dsh CLI under test. Keep backend-only jobs secret-free. In the
  [integration workflow](.github/workflows/integration.yml), require protected
  `fork-integration` approval before secret-backed fork runs execute PR code. Disable
  persisted checkout credentials and scope secrets to the steps and scenarios that need them.
  Run the [workflow guard tests](.github/scripts/integration-workflow.test.mjs) when changing this boundary.
- **Automated review.** In the [review workflow](.github/workflows/dsh-review.yml), run trusted
  base-branch tooling and use PR-head files only as review data. Run dsh as `nobody` with
  a scrubbed environment, keep secrets in the runner-owned loopback proxy, and grant
  only directory traversal on private ancestors.
- **Workflow checks.** Run CI's pinned `actionlint` with `shellcheck` on `PATH`.
  Use `$RUNNER_TEMP` in `run:` steps or the script default. The `runner` context is
  unavailable in job-level `env:`. For any [`pull_request_target` workflow](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target),
  PR runs use the workflow already on the base repository's default branch. Report
  local and PR checks separately from runs of the updated workflow after merge.
- **Release.** Follow the [publish workflow](.github/workflows/npm-publish.yml) for uniform
  versions. Verify every expected package version and dist-tag in npm before reporting publication.

## Preview changes

- **Assets.** Use the accepted `preview.png` files as references. Export 1672 × 941 PNGs.
  Ship package previews at the package root via `package.json#files`. When a package name,
  tagline, or scope changes, update its preview, package README, and affected entries
  in the root package table and [preview gallery](README.md#plugin-previews).
- **Package.** Put the exact name and tagline on the left, a beaver in the middle, and a
  sparse view of the plugin's data flow on the right. Connect the flow to a core showing
  only a white whale symbol. Use rounded matte 3D forms, short plush fur, diffuse fabric,
  restrained highlights, a navy underwater gradient, a matte floor, and cyan fill.
  Vary character, pose, outfit, action, and instrument family where applicable. Use
  package-specific accents and the Langfuse violet-to-cyan treatment as the observability
  reference. Limit lettering to the name, tagline, and essential protocol labels.
  Leave out Pi marks and unrelated logos. Check text, character distinctness, and
  legibility at README thumbnail size.
- **Root.** Refresh the root preview only when the repository name, tagline, or shared style
  changes. Put the project name and tagline on the left and an extensible, character-free
  network on the right. Use a white whale core, cyan-to-violet paths, and generic sockets
  at varied depths.
  Keep package names, mascots, instruments, package-specific cards, and a fixed package count out.
