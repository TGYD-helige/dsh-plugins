# dsh-plugins — Agent Guidelines

## Project Overview

Monorepo of generic [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugins (`packages/dsh-*`). Each package is a dsh **bundle**: a Cordis plugin (`export name/inject/Config/apply`) plus a `cordis.patch.yml`, installable via `dsh plugin add`. No dsh core patches — everything rides documented seams (services, typed events, waterfalls).

- `dsh-a2a` — A2A protocol (JSON-RPC + SSE) server driving `ctx.agents`
- `dsh-storage` — mirrors `session/event` into MySQL/PostgreSQL/SQLite/SQL Server (`prisma/schema.{mysql,postgresql,sqlite,sqlserver}.prisma`: `ai_messages` / `ai_chat_histories`, same tables as the source project; **Prisma 7** — clients are pre-generated per provider at build time (`pnpm generate`, output `src/generated/`, compiled into `lib/generated`; consumers never generate) and driven through the matching driver adapter (`@prisma/adapter-{mariadb,pg,libsql,mssql}`, optional peers); SQL Server has no Prisma `Json` type — text columns, serialized automatically when `provider: sqlserver`). A2A task state (Redis/GCS TaskStores) lives in `dsh-a2a`, NOT here — task metadata ≠ conversation history.
- `dsh-langfuse` — Langfuse via `llm/stream` + `tools/execute` waterfalls

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

- **Peer deps**: `@deepseek-ai/*` packages and heavy clients (`langfuse`, `@prisma/client`, `ioredis`, `@google-cloud/storage`) go in `peerDependencies` — never bundle the harness or optional backends.
- **Optional backends**: load via dynamic `import()` inside `init()`, so unused backends cost nothing.
- **No-throw seams**: plugin hooks (waterfalls, event listeners) catch and `console.error` with a `[dsh-*]` prefix; never let observability/storage errors escape into the agent loop.
- **Config**: Schemastery `Config` schema per plugin, everything disabled by default; secrets use `.role('secret')`.
- **Lifecycle**: this cordis fork has **no `ready`/`dispose` events** — startup/cleanup goes in `ctx.effect()` (runs at plugin load; the returned disposer runs on fiber unload). Session durability checkpoints ride the awaited `session/flush(session)` event; the session taps are `session/event(session, event)` / `session/disposed(session)` (verified against `@deepseek-ai/dsh-session@0.1.0-rc.7`).
- **Events**: dsh event/payload shapes are pre-release — mark assumptions with `TODO(verify)` + the dsh doc path, instead of guessing silently.
- **Security**: dsh has no authn/authz. `dsh-a2a` binds loopback by default; say so in docs, don't "fix" it in the plugin.

---

## Unit Test Convention

Runner: **vitest** (per-package devDep, `"test": "vitest run"`; root `pnpm test` fans out with `pnpm -r run test`).

- **Location**: colocate `src/**/*.test.ts` next to the module under test.
- **tsconfig split**: `tsconfig.json` typechecks everything (tests included, `--noEmit`); `tsconfig.build.json` emits and excludes `*.test.ts` — `lib/` must never contain test files.
- **Pure logic** (projectors, mappers): direct input/output tests, no harness.
- **Plugin wiring**: drive a real `Context` from `@deepseek-ai/cordis` (event dispatch, `ctx.effect`, fiber unload) and `vi.mock` the backend module — capture instances via `vi.hoisted`. Lifecycle assertions: init at load, cleanup via `ctx.fiber.dispose()`, drains at `session/flush`.
- **External clients** (`@prisma/client`, `langfuse`, redis, ...): `vi.mock` the module — unit tests never touch a real database or network.
- **No-throw seams**: assert backend/hook errors are swallowed with the `[dsh-*]` `console.error` prefix (spy on `console.error`).
- **Unit ≠ E2E**: anything needing the real dsh runtime, an LLM, or a real database belongs in `.github/scripts/integration/`, not here.

---

## Preview Images

Each plugin package ships a package-root `preview.png` (e.g. `packages/dsh-a2a/preview.png`) for plugin listings and the package README.

- Size: `1672 x 941` PNG, consistent layout across packages: left-side plugin name + tagline, right-side domain cards/icons, and a central whale mascot (nod to DeepSeek's whale)
- Do not reuse the same whale image across packages; each plugin gets a distinct pose, outfit, expression, or instrument
- Include a musical instrument when possible; Chinese and Western instruments both welcome, and the instrument should help differentiate the plugin
- The tagline and right-side visuals must reflect the plugin's actual domain (protocol/storage/observability), not generic decoration
- One shared visual system across the three packages (same palette/typography); each package distinguished by its own accent color and domain motif, not by a different style
- When a plugin's name, tagline, or scope changes, regenerate its `preview.png` together with the root README table and package README

## Build & Test

```bash
pnpm install
pnpm build        # tsc per package
pnpm typecheck
pnpm test         # vitest (packages with a test script)
pnpm lint         # biome check .
```

E2E: a package joins `.github/workflows/integration.yml` by shipping `.github/scripts/integration/<package>.mjs` (real dsh headless profile + one LLM query; matrix auto-detected by `.github/scripts/integration-matrix.mjs`). A sibling `<package>.providers` file (one provider per line) adds backend-only legs — real service database + `db push` + backend writes/reads, no dsh boot, no LLM, no secrets. Stage B needs the `DSH_INTEGRATION_BASE_URL` / `DSH_INTEGRATION_API_KEY` secrets; fork PRs get the secrets-free stages only (`pull_request` exposes no secrets to forks). All workflows run on GitHub-hosted runners (public repo, unlimited minutes).

PR automation (GitHub-hosted, `pull_request_target`; PR content flows in as untrusted data, only trusted base code is checked out): `.github/workflows/labeler.yml` syncs rule labels (`area/*`, `type/*`, `size:*`, `platform/*`) on every PR and proposes P0–P3 for same-repo PRs via the integration gateway; `.github/workflows/dsh-review.yml` posts a two-axis (Standards/Spec) DSH review on non-draft PRs — P0/P1 findings fail the job. `pull_request_target` workflows only trigger once the workflow file exists on the default branch — they start working after the PR that adds them merges.

Workflow-file rules (learned the hard way — the E2E silently never triggered on the first PR):

- **Lint workflow files like code.** The `lint` job runs pinned `actionlint` on `.github/workflows/*.yml`. GitHub evaluates expressions only at run time, and a bad context/expression fails the whole workflow with zero job logs — YAML that parses fine is not enough.
- **The `runner` context is not available in job-level `env:`** (only `github`, `inputs`, `matrix`, `needs`, `secrets`, `strategy`, `vars`). Use `$RUNNER_TEMP` inside `run:` steps, or let scripts default to it — never `${{ runner.temp }}` in `env:` blocks.
