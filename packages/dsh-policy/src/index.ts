/**
 * dsh-policy — declarative tool-call policy for DeepSeek Harness.
 *
 * Gemini CLI-style policy rules expressed as plain plugin config (no code,
 * no rule files): each rule matches a tool call by tool name, optional
 * `argsPattern` (regex over the JSON-stringified arguments) and optional
 * `commandPrefix`/`commandRegex` (per-segment over shell commands), and
 * resolves to `allow` / `deny` / `ask` at a priority.
 *
 * The decision rides the `tools/pre-execute` gate
 * (@deepseek-ai/dsh-tools): `allow` runs the call, `deny` materializes the
 * message as a tool error the model can read, and `ask` is resolved by dsh
 * itself through the approval seam (ctx.approval, fail-closed to deny when
 * no answerer is composed). A call no rule matches is delegated onward via
 * `next()` — the plugin only ever speaks for the calls its rules cover.
 *
 * Gate shape verified against @deepseek-ai/dsh-tools@0.1.6-alpha.2
 * (lib/types/index.d.ts: tools/pre-execute + PreToolDecision).
 *
 * @module dsh-policy
 */

import type { Context } from '@deepseek-ai/cordis';
// Augmentation-only import: pulls the dsh-tools Events declaration (the
// tools/pre-execute waterfall) into the compilation so the listener is
// contextually typed.
import type {} from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { compileRules, describeRule, evaluate, type PolicyRuleConfig } from './rule.js';

export const name = 'dsh-policy';

// One waterfall listener only needs the event to exist; no hard service
// dependency is declared so the plugin still loads in minimal compositions
// (it simply never gates anything). Add 'tools' to `inject` if you prefer
// fail-fast wiring.
export const inject = [] as string[];

/** A match field takes one pattern or an any-of list (Gemini's `field = [...]` form). */
const stringOrList = Schema.union([Schema.string(), Schema.array(Schema.string())]);

export interface PolicyPluginConfig {
  enabled: boolean;
  commandKeys?: string[];
  rules: PolicyRuleConfig[];
}

// Explicit annotation: the nested array/union inference otherwise references
// cosmokit types that consumers do not have installed (TS2742).
export const Config: Schema<PolicyPluginConfig> = Schema.object({
  enabled: Schema.boolean().default(false).description('master switch'),
  commandKeys: Schema.array(Schema.string())
    .default(['command'])
    .description('argument keys holding a shell command string (dsh bash/pwsh use `command`)'),
  rules: Schema.array(
    Schema.object({
      tool: stringOrList.required().description('tool name(s), or "*" for every tool'),
      decision: Schema.union(['allow', 'deny', 'ask'] as const)
        .required()
        .description('allow runs, deny blocks with `message`, ask goes through user approval'),
      priority: Schema.number().default(0),
      message: Schema.string().description(
        'deny reason / ask explanation, surfaced to the model and the answerer',
      ),
      argsPattern: Schema.union([stringOrList, Schema.dict(stringOrList)]).description(
        'regex(es) matched against the JSON-stringified arguments (any-of) — or a map of argument name → regex(es) matched against that argument value',
      ),
      commandPrefix: stringOrList.description(
        'anchored word-boundary prefix match on each shell command segment (any-of)',
      ),
      commandRegex: stringOrList.description(
        'regex(es) anchored at each shell command segment start (any-of)',
      ),
    }),
  ).default([]),
});

export function apply(ctx: Context, config: PolicyPluginConfig): void {
  if (!config.enabled || config.rules.length === 0) return;
  // Invalid regexes are config errors — compileRules throws here, at load.
  const rules = compileRules(config.rules);
  // Tests apply() directly (no schema defaults), so the fallback stays.
  const commandKeys = config.commandKeys ?? ['command'];

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const hit = evaluate(rules, exec.name, exec.arguments, commandKeys);
      if (!hit) return next();
      switch (hit.decision) {
        case 'allow':
          return { kind: 'allow' };
        case 'deny':
          return {
            kind: 'deny',
            reason: hit.rule.message ?? `denied by policy: ${describeRule(hit.rule)}`,
          };
        case 'ask':
          return { kind: 'ask', reason: hit.rule.message };
      }
    } catch (error) {
      // A policy gate must never break the agent loop: a broken evaluation
      // delegates to the rest of the chain (dsh's own gates keep their say).
      console.error('[dsh-policy] evaluation failed:', error);
      return next();
    }
  });
}
