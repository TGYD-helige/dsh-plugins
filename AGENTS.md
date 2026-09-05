# dsh-plugins — Agent Guidelines

## Project Overview

Monorepo of generic [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugins (`packages/dsh-*`). Each package is a dsh **bundle**: a Cordis plugin (`export name/inject/Config/apply`) plus a `cordis.patch.yml`, installable via `dsh plugin add`. No dsh core patches — everything rides documented seams (services, typed events, waterfalls).

- `dsh-a2a` — A2A protocol (JSON-RPC + SSE) server driving `ctx.agents`
- `dsh-storage` — mirrors `session/event` into MySQL/PostgreSQL/SQLite/SQL Server (`prisma/schema.{mysql,postgresql,sqlite,sqlserver}.prisma`: `ai_messages` / `ai_chat_histories`, same tables as the source project; **Prisma 7** — clients are pre-generated per provider at build time (`pnpm generate`, output `src/generated/`, compiled into `lib/generated`; consumers never generate) and driven through the matching driver adapter (`@prisma/adapter-{mariadb,pg,libsql,mssql}`, optional peers); SQL Server has no Prisma `Json` type — text columns, serialized automatically when `provider: sqlserver`). A2A task state (Redis/GCS TaskStores) lives in `dsh-a2a`, NOT here — task metadata ≠ conversation history.
- `dsh-langfuse` — Langfuse observability: one generation per LLM call (`llm/stream`, plus a nested `llm-request` span with the verbatim loop-built request), one span per tool call (`tools/execute`), one trace per turn (`session/event`), and subagent child sessions nested under the parent's tree (`session/created` header link + `subagent/start`/`subagent/end`). Langfuse JS SDK v5 (observations-first OTEL model: the trace IS its root span, **ended** at `turn/end` — un-ended spans never export; `session.id` + `langfuse.trace.name` stamped per observation via handle-tree propagation, and trace IO also rides the deprecated `langfuse.trace.*` keys on the root span — older Langfuse servers derive the trace row from exactly those). Lazy dynamic `import()` of `@langfuse/tracing` + `@langfuse/otel` + `@opentelemetry/sdk-trace-node` on an isolated tracer provider (never the global one) — `apply()` returns the init promise so fiber readiness covers it.

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

- **Peer deps**: `@deepseek-ai/*` packages and heavy clients (`@langfuse/tracing` + `@langfuse/otel`, `@prisma/client`, `ioredis`, `@google-cloud/storage`) go in `peerDependencies` — never bundle the harness or optional backends.
- **Optional backends**: load via dynamic `import()` inside `init()`, so unused backends cost nothing.
- **No-throw seams**: plugin hooks (waterfalls, event listeners) catch and `console.error` with a `[dsh-*]` prefix; never let observability/storage errors escape into the agent loop.
- **Config**: Schemastery `Config` schema per plugin, everything disabled by default; secrets use `.role('secret')`.
- **Lifecycle**: this cordis fork has **no `ready`/`dispose` events** — startup/cleanup goes in `ctx.effect()` (runs at plugin load; the returned disposer runs on fiber unload). Session durability checkpoints ride the awaited `session/flush(session)` event; the session taps are `session/event(session, event)` / `session/disposed(session)` (verified against `@deepseek-ai/dsh-session@0.1.2-rc.1`).
- **Events**: dsh event/payload shapes are pre-release — mark assumptions with `TODO(verify)` + the dsh doc path, instead of guessing silently.
- **Security**: dsh has no authn/authz. `dsh-a2a` binds loopback by default; say so in docs, don't "fix" it in the plugin.

---

## Unit Test Convention

Runner: **vitest** (per-package devDep, `"test": "vitest run"`; root `pnpm test` fans out with `pnpm -r run test`).

- **Location**: colocate `src/**/*.test.ts` next to the module under test.
- **tsconfig split**: `tsconfig.json` typechecks everything (tests included, `--noEmit`); `tsconfig.build.json` emits and excludes `*.test.ts` — `lib/` must never contain test files.
- **Pure logic** (projectors, mappers): direct input/output tests, no harness.
- **Plugin wiring**: drive a real `Context` from `@deepseek-ai/cordis` (event dispatch, `ctx.effect`, fiber unload) and `vi.mock` the backend module — capture instances via `vi.hoisted`. Lifecycle assertions: init at load, cleanup via `ctx.fiber.dispose()`, drains at `session/flush`.
- **External clients** (`@prisma/client`, `@langfuse/*`, redis, ...): `vi.mock` the module — unit tests never touch a real database or network.
- **No-throw seams**: assert backend/hook errors are swallowed with the `[dsh-*]` `console.error` prefix (spy on `console.error`).
- **Unit ≠ E2E**: anything needing the real dsh runtime, an LLM, or a real database belongs in `.github/scripts/integration/`, not here.

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

Releases: `.github/workflows/npm-publish.yml` (manual `workflow_dispatch`, main branch only) resolves the next uniform version from npm's published set (`x.y.z-beta.N` on the beta channel, patch increments on latest), rewrites package versions in the workflow workspace only (never committed), runs typecheck/build/test/lint, publishes with `pnpm publish -r --filter`, tags `v<version>`, and creates a GitHub release with auto-generated notes. Requires the `NPM_TOKEN` secret; a fresh uniform stable release seeds from the committed package version, while the first beta must pass an explicit `release_version`.

E2E: a package joins `.github/workflows/integration.yml` by shipping `.github/scripts/integration/<package>.mjs` (real dsh headless profile + one LLM query; matrix auto-detected by `.github/scripts/integration-matrix.mjs`), and may split its scenario into several legs sharing one tarball as `<package>.<scenario>.mjs`. A sibling `<package>.providers` file (one provider per line) adds backend-only legs — real service database + `db push` + backend writes/reads, no dsh boot, no LLM, no secrets. Stage B needs the `DSH_INTEGRATION_BASE_URL` / `DSH_INTEGRATION_API_KEY` secrets; fork PRs get the secrets-free stages only (`pull_request` exposes no secrets to forks). All workflows run on GitHub-hosted runners (public repo, unlimited minutes). Secrets enter only the Stage B step's env and are blanked where a leg doesn't need them (`!matrix.provider && secrets.X || ''` for provider legs, `matrix.package == '<pkg>' && secrets.X || ''` for package-scoped secrets like dsh-langfuse's `LANGFUSE_*` — GitHub treats `''` as falsy, so the `x && '' || y` form leaks).

PR automation (GitHub-hosted, `pull_request_target`; PR content is untrusted data): `.github/workflows/labeler.yml` syncs rule labels (`area/*`, `type/*`, `size:*`, `platform/*`) on every PR and proposes P0–P3 for same-repo PRs via the integration gateway; `.github/workflows/dsh-review.yml` posts a two-axis (Standards/Spec) DSH review on non-draft PRs — only P0/P1 findings are reported, and every reported finding fails the job. The review agent reads the PR-head checkout with read-only fs tools (no bash/write/web), but dsh gates only *writes* (verified rc.7 → 0.1.2-rc.1) — reads are unjailed — so containment is at the OS level: dsh runs as `nobody` with a scrubbed env, and a loopback proxy (`review-gateway-proxy.mjs`, runner user) injects the gateway key, keeping every secret unreadable from the model process. PR code is never installed, built, or executed. `pull_request_target` workflows only trigger once the workflow file exists on the default branch — they start working after the PR that adds them merges (and worse: a PR that *edits* a `pull_request_target` workflow still runs the BASE branch's version, so the new version is only exercised by the first PR opened after the merge — test such edits expecting exactly that). The `nobody` containment needs directory TRAVERSAL down to the checkout and DSH_HOME: `chmod o+x` the ancestor chain (`/home/runner`, `…/work`, the workspace parents) — o+x is search-only, no listing, so the boundary is unchanged.

Workflow-file rules (learned the hard way — the E2E silently never triggered on the first PR):

- **Lint workflow files like code.** The `lint` job runs pinned `actionlint` on `.github/workflows/*.yml`. GitHub evaluates expressions only at run time, and a bad context/expression fails the whole workflow with zero job logs — YAML that parses fine is not enough. actionlint's shellcheck rule runs only when a `shellcheck` binary is on `PATH`: GitHub's ubuntu runners ship one, a bare macOS checkout does not — a local actionlint pass is not proof (this cost us a red lint job once). Lint locally with shellcheck next to actionlint.
- **The `runner` context is not available in job-level `env:`** (only `github`, `inputs`, `matrix`, `needs`, `secrets`, `strategy`, `vars`). Use `$RUNNER_TEMP` inside `run:` steps, or let scripts default to it — never `${{ runner.temp }}` in `env:` blocks.
