# dsh-plugins — Agent Guidelines

## Project Overview

Monorepo of generic [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugins (`packages/dsh-*`). Each package is a dsh **bundle**: a Cordis plugin (`export name/inject/Config/apply`) plus a `cordis.patch.yml`, installable via `dsh plugin add`. No dsh core patches — everything rides documented seams (services, typed events, waterfalls).

- `dsh-a2a` — A2A protocol (JSON-RPC + SSE) server driving `ctx.agents`
- `dsh-storage` — mirrors `session/event` into MySQL/PostgreSQL (`prisma/schema.prisma`: `ai_messages` / `ai_chat_histories`, same tables as the source project). A2A task state (Redis/GCS TaskStores) lives in `dsh-a2a`, NOT here — task metadata ≠ conversation history.
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
- **Events**: dsh event/payload shapes are pre-release — mark assumptions with `TODO(verify)` + the dsh doc path, instead of guessing silently.
- **Security**: dsh has no authn/authz. `dsh-a2a` binds loopback by default; say so in docs, don't "fix" it in the plugin.

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
```
