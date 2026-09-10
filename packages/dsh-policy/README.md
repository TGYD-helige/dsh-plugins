# @amaster.ai/dsh-policy

![dsh-policy preview](preview.png)

Declarative tool-call policy for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness): config-driven `allow` / `deny` / `ask` rules on dsh's `tools/pre-execute` gate — the semantics of Gemini CLI's TOML policy files, expressed as plain plugin config (Schemastery-validated YAML, no code, no rule files).

## Install

```sh
dsh plugin --profile my-agent add @amaster.ai/dsh-policy
```

## Configuration

The plugin is **disabled by default**. Rules live in the profile's `cordis.patch.yml` like every other dsh plugin config (edits hot-reload with the config layer):

```yaml
- name: '@amaster.ai/dsh-policy'
  config:
    enabled: true
    rules:
      - tool: '*'                      # every tool
        decision: allow
        priority: 20
      - tool: bash                     # dsh's shell tool (pwsh works the same)
        decision: deny
        commandPrefix: npm
        priority: 200
        message: 'npm is not allowed. Use bun install / bun add / bun test instead.'
      - tool: bash
        decision: deny
        commandPrefix: bun run
        priority: 200
      - tool: bash                     # …but one specific subcommand is fine
        decision: allow
        commandPrefix: bun run lint
        priority: 300                  # higher priority overrides the broader deny
      - tool: bash                     # grep as a pipe filter stays allowed
        decision: allow
        commandPrefix: grep
        priority: 300
      - tool: write_file
        decision: deny
        argsPattern: '\.md"'
        priority: 200
      - tool: write_file               # …except the project contract file
        decision: allow
        argsPattern: 'PRODUCT\.md'
        priority: 300
      - tool: write_file
        decision: ask                  # resolved via ctx.approval (human/answerer chain)
        argsPattern: '"file_path":"[^"]*/etc/'
        message: 'writes to a system path'
```

### Rule fields

| Field | Required | Meaning |
| --- | --- | --- |
| `tool` | yes | Tool name or list of names; `*` matches every tool |
| `decision` | yes | `allow` runs the call, `deny` blocks it (the `message` reaches the model as the tool error), `ask` defers to dsh's approval seam |
| `priority` | no (0) | Higher priority wins among rules competing for the same command segment; ties break fail-closed (deny > ask > allow) |
| `message` | no | Deny reason / ask explanation (a generated default names the matched rule) |
| `argsPattern` | no | Regex (or list, any-of) matched against the JSON-stringified arguments |
| `commandPrefix` | no | Anchored prefix match (or list, any-of) on each shell command segment, at a word boundary (`npm` matches `npm install`, never `npmx`) |
| `commandRegex` | no | Regex (or list, any-of) anchored at each shell command segment's start — Gemini-compatible; use `.*` to match mid-segment |

Plugin-level fields: `enabled` (master switch) and `commandKeys` (argument keys holding a shell command string — default `['command']`, covering dsh's `bash`/`pwsh` tools).

### Matching semantics

- **Every condition on a rule must hold** for the rule to match (AND). A rule with no conditions beyond `tool` matches every call of that tool.
- **Shell commands are checked segment by segment.** Compound commands (`a && b | c`, newlines, background `&`) are split, quote-aware, and `$( )` / backtick substitutions are extracted as their own segments — `cd /tmp && npm install` and `echo "$(npm install)"` both hit the `npm` rule.
- **Priority resolves competition within one segment**; across segments the aggregation is conservative: any segment's `deny` denies the whole call, then any `ask` escalates, and `allow` requires every segment decided allow. A broad deny is still overridable by a specific allow because both compete on the same segment (`bun run lint` at 300 vs `bun run` at 200).
- **No rule matches → the call passes through** to the rest of the `tools/pre-execute` chain (`next()`), so dsh's own gates and other plugins keep their say. Invalid regexes are config errors and fail the plugin load; a runtime evaluation failure is logged with the `[dsh-policy]` prefix and delegates onward — the gate never breaks the agent loop.

### The `ask` decision

`ask` is resolved by dsh itself: through the composed answerers of `@deepseek-ai/dsh-user-approval` (a UI prompt, an auto-answerer, …), failing closed to deny when no approval service is composed, and short-circuiting to reject under a session's `approval/policy: never`. The model-facing deny reason is the rule's `message` only when no approval service exists at all; a `rejected`/`cancelled`/`unavailable` outcome carries dsh-tools' own reason wording (verified against `dsh-tools@0.1.5-rc.1`). Gemini's `modes` (`default`/`autoEdit`/`yolo`/`plan`) have no dsh counterpart — dsh models that axis as the per-session approval policy (see `dsh-permission-presets` for the user-facing selector), and dsh profiles/`cordis.patch.yml` already scope config per deployment, so the plugin carries no mode axis of its own.

## Gemini CLI policy mapping

| Gemini TOML | dsh-policy config |
| --- | --- |
| `toolName = "*" / "name" / ["a", "b"]` | `tool: '*' / name / [a, b]` |
| `decision = "allow" / "deny" / "ask_user"` | `decision: allow / deny / ask` |
| `priority = 300` | `priority: 300` (same direction) |
| `denyMessage` | `message` |
| `argsPattern` (regex on the serialized args) | `argsPattern` (JSON.stringify key order, not Gemini's sorted-key form — patterns that span multiple keys may need adjusting) |
| `commandPrefix` / `commandRegex` (single or list) | same names, matched per command segment; `commandRegex` anchors at the segment start, like Gemini's at the command start |
| `modes = [...]` | no counterpart — use separate dsh profile patch rows |
| `allowRedirection` | not supported (dsh has no per-call redirection gate) |

## Security

A policy plugin is advisory gating, not containment: deny rules keep a well-behaved agent off dangerous commands, but the agent process still runs with host privileges. Pair with dsh's sandbox stack (`dsh-sandbox` + a confining executor) for OS-level enforcement, and note that dsh ships no authentication or authorization of its own.

## Compatibility

| @amaster.ai/dsh-policy | dsh | cordis |
| --- | --- | --- |
| 0.1.x | `0.1.5-rc.1` | `^4.0.1` |

Peer dependency: `@deepseek-ai/dsh-tools` (the `tools/pre-execute` gate). The approval seam (`@deepseek-ai/dsh-user-approval`) is optional and only involved in `ask` decisions.

## License

MIT
