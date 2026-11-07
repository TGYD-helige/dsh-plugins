# dsh-plugins — Agent Guidelines

## Project Overview

Monorepo of generic [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugins (`packages/dsh-*`). Each package is a dsh **bundle**: a Cordis plugin (`export name/inject/Config/apply`) plus a `cordis.patch.yml`, installable via `dsh plugin add`. No dsh core patches — everything rides documented seams (services, typed events, waterfalls).

**Scope boundary:** Implement reusable dsh or protocol capabilities that make sense across consuming applications. Keep one application's identity headers, database fields, and business workflows in that application. Before adding a plugin option or compatibility path for an application request, establish a concrete use case independent of that application.

Use the [root README](README.md) to find the plugin and its documented dsh extension points. Follow the package README for its configuration and compatibility matrix.

Task stores in `dsh-a2a` own A2A task state. `dsh-storage` mirrors conversation history. Keep protocol state and conversation history in their respective packages. Generate Prisma clients at package build time so consumers can use the published clients directly. SQL Server stores JSON as serialized text.

Langfuse uses an isolated tracer provider. End the root span at turn end so it exports, and preserve the legacy trace I/O attributes consumed by older Langfuse servers.

dsh is developer preview: **pin versions, keep README's compat matrix current**, and verify every `TODO(verify)` marker against the pinned dsh source before removing it.

---

## Required Agent Skills

### ponytail — minimal-code discipline

> [ponytail](kimi-code://skill/ponytail)

Every change follows the ladder — stop at the first rung that holds:

```
1. Does this need to exist?   → no: skip it (YAGNI)
2. Already in this codebase?  → reuse it (check sibling packages first)
3. Stdlib does it?            → use it
4. Native platform feature?   → use it
5. Installed dependency?      → use it — no new deps for one-call problems
6. One line?                  → one line
7. Only then: the minimum that works
```

The ladder runs *after* understanding the problem, never instead of it. Never lazy about: no-throw guarantees (observability/mirroring must never break the agent loop), credential handling, cancellation propagation.

### mattpocock/skills — engineering workflow

> https://github.com/mattpocock/skills

Use for process work: `to-spec`/`to-tickets` before non-trivial implementations, `tdd` for behavior changes, `diagnosing-bugs` (no fix without reproduced root cause), `code-review`, `research`, `resolving-merge-conflicts` as named.

---

## Conventions

- **Peer deps**: declare the dsh packages whose services, events, or types the plugin consumes as peers. Keep the minimum supported dsh version until the plugin needs a newer API. Include each supported prerelease tuple in the peer range for npm compatibility. Pin the tested dsh versions in devDependencies, including type-only event imports. Declare heavy backend clients as peers and mark optional backends as optional peers.
- **Optional backends**: load via dynamic `import()` inside `init()`, so unused backends cost nothing.
- **No-throw seams**: plugin hooks (waterfalls, event listeners) catch and `console.error` with a `[dsh-*]` prefix; never let observability/storage errors escape into the agent loop.
- **Documentation**: Add only user-facing usage documentation. Keep research notes, implementation plans, review logs, generated-image prompts, and other agent-internal records out of the repository.
- **Config**: Schemastery `Config` schema per plugin, everything disabled by default; secrets use `.role('secret')`.
- **Lifecycle**: use `ctx.effect()` for startup and return a disposer for fiber unload. Observe settled session events through `session/event(session, event)` and drain pending writes at the awaited `session/flush(session)` checkpoint. Use `session/disposed(session)` for session cleanup and `agent/assistant-stream` for live assistant deltas.
- **Events**: dsh event/payload shapes are pre-release — mark assumptions with `TODO(verify)` + the dsh doc path, instead of guessing silently.
- **Security**: dsh has no authn/authz. `dsh-a2a` binds loopback by default; say so in docs, don't "fix" it in the plugin.

---

## Change and Review Workflow

- Read the affected package README and implementation. Update documented contracts and examples when behavior changes.
- Reproduce bugs on the reported transport, backend, and configuration when possible. Use a minimal, sanitized fixture for payload-specific failures. Check other callers and backends for the same defect, including paths that read existing records.
- On read or parse failure, preserve stored data and fail closed at policy gates.
- When telemetry fields change, inspect the serialized export, test promised redaction with dummy credentials, and document what leaves the process.
- On per-event and per-chunk hooks, account for repeated work as payloads grow. Preserve streaming and cancellation.
- Report which revision and checks you verified, outstanding failures, and integrations still untested. Rerun affected checks after fixes.

---

## Unit Test Convention

Runner: **vitest** (per-package devDep, `"test": "vitest run"`; root `pnpm test` also runs the integration workflow guard tests).

- **Location**: colocate `src/**/*.test.ts` next to the module under test.
- **tsconfig split**: `tsconfig.json` typechecks everything (tests included, `--noEmit`); `tsconfig.build.json` emits and excludes `*.test.ts` — `lib/` must never contain test files.
- **Pure logic** (projectors, mappers): direct input/output tests, no harness.
- **Plugin wiring**: drive a real `Context` from `@deepseek-ai/cordis` (event dispatch, `ctx.effect`, fiber unload) and `vi.mock` the backend module — capture instances via `vi.hoisted`. Lifecycle assertions: init at load, cleanup via `ctx.fiber.dispose()`, drains at `session/flush`.
- **External clients** (`@prisma/client`, `@langfuse/*`, redis, ...): `vi.mock` the module — unit tests never touch a real database or network.
- **No-throw seams**: assert backend/hook errors are swallowed with the `[dsh-*]` `console.error` prefix (spy on `console.error`).
- **Unit ≠ E2E**: anything needing the real dsh runtime, an LLM, or a real database belongs in `.github/scripts/integration/`, not here.
- Regression tests reproduce the observable failure before the fix and pass afterward.
- Await the event under test or use fake timers for clock behavior. Register cleanup so resources are released even when an assertion fails.

---

## Preview Images

All preview assets are `1672 x 941` PNGs. The repository ships an evergreen root `preview.png`; each package ships its own package-root `preview.png` for plugin listings and its README, and includes it in `package.json#files`.

### Package previews

- Use one shared layout: plugin name + tagline on the left, a beaver character in the center, and a compact domain system on the right. Keep the hierarchy readable at README-thumbnail size.
- Match the accepted Pi-style beaver system in the existing previews: polished cartoon 3D, matte short-plush fur rendered in broad shapes, rounded face and paws, balanced expressive eyes, adult proportions, diffuse cloth, and dry surfaces. Keep highlights restrained; the result should feel soft rather than glossy or photoreal.
- Give every plugin a genuinely distinct character identity, pose, outfit, and action — not one body template with recolored hair. Use a musical instrument when it fits; vary standing/seated poses and instrument families across packages.
- Use a medium-deep navy underwater-tech gradient, matte floor, soft cyan fill, and enough ambient light to read the character and clothing. Accent colors distinguish packages; the violet-to-cyan `dsh-langfuse` gradient is the reference for observability visuals.
- Integrate a bold white whale symbol into the functional system core and connect it to the plugin's real data flow. The core carries the symbol only; keep `deepseek` / `Harness` words out of it.
- Make the right-side motifs specific and sparse: protocol transports/endpoints for A2A, mirrored database forms for storage, and traces/spans/metrics for Langfuse. Prefer a few differentiated motifs over repeated cards or robots.
- Keep in-image copy to the exact plugin name, tagline, and essential protocol labels. Keep Pi / `π` marks and unrelated logos out of every preview.

Use the current accepted package previews as primary style references when generating another package. A package preview is complete only when its text is exact, its character differs from every sibling, its domain flow is legible, and the PNG is `1672 x 941`.

### Root preview

- Keep root `preview.png` evergreen and character-free. Use the project name + tagline on the left and a generic, expandable plugin network on the right: one white-whale core, cyan-to-violet data paths, and abstract module sockets at varied depths.
- Represent extensibility rather than the current package inventory. Do not encode a fixed plugin count, package names, mascots, instruments, or package-specific cards; adding a plugin must not require regenerating the root image.
- Regenerate the root preview only when the repository name, tagline, or shared visual system changes. When a package name, tagline, or scope changes, regenerate that package's preview and update its package README plus the root README table.

## Build & Test

```bash
pnpm install
pnpm build        # tsc per package
pnpm typecheck
pnpm test         # vitest (packages with a test script)
pnpm lint         # biome check .
```

Use `pnpm test:sdk` for changes to Langfuse SDK integration. [Release workflow](.github/workflows/npm-publish.yml) sets uniform package versions in its own workspace. Confirm each expected package version and dist-tag in npm before reporting a release as published.

**Integration scenarios.** Add `.github/scripts/integration/<package>.mjs` or `<package>.<scenario>.mjs` for a dsh runtime scenario. Use `<package>.providers` for backend-only legs such as Redis or SQL databases. See [matrix discovery](.github/scripts/integration-matrix.mjs) and the [integration workflow](.github/workflows/integration.yml) for job wiring.

**Integration credentials.** Keep backend legs secret-free. Gate secret-backed fork runs on reviewer approval through the protected `fork-integration` environment before executing PR code. Keep persisted checkout credentials disabled and pass gateway or Langfuse secrets only to the steps that need them. Run the [workflow guard tests](.github/scripts/integration-workflow.test.mjs) when changing this boundary.

**Automated PR review.** The [review workflow](.github/workflows/dsh-review.yml) executes trusted base-branch tooling and treats PR-head files as untrusted input. Preserve OS isolation: run dsh as `nobody` with a scrubbed environment, keep secrets in the runner-owned loopback proxy, and grant only directory traversal on private ancestor directories. A PR run exercises the base version of a `pull_request_target` workflow. When editing one, distinguish local checks from a run of the merged workflow.

Workflow-file rules (learned the hard way — the E2E silently never triggered on the first PR):

- **Lint workflow files like code.** The `lint` job runs pinned `actionlint` on `.github/workflows/*.yml`. GitHub evaluates expressions only at run time, and a bad context/expression fails the whole workflow with zero job logs — YAML that parses fine is not enough. actionlint's shellcheck rule runs only when a `shellcheck` binary is on `PATH`: GitHub's ubuntu runners ship one, a bare macOS checkout does not — a local actionlint pass is not proof (this cost us a red lint job once). Lint locally with shellcheck next to actionlint.
- **The `runner` context is not available in job-level `env:`** (only `github`, `inputs`, `matrix`, `needs`, `secrets`, `strategy`, `vars`). Use `$RUNNER_TEMP` inside `run:` steps, or let scripts default to it — never `${{ runner.temp }}` in `env:` blocks.
