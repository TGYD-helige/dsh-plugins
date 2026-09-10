/**
 * The policy rule model and matching engine (pure — no cordis imports).
 *
 * Semantics, mirroring Gemini CLI's policy files:
 *
 * - A rule matches a tool call when the tool name matches (a listed name or
 *   `*`) AND every present condition group holds: `argsPattern` against the
 *   JSON-stringified arguments, `commandPrefix`/`commandRegex` against each
 *   shell command segment. Array fields are any-of within the group.
 * - `commandRegex` is anchored at the segment start (Gemini anchors it at the
 *   command start) — use `.*` to match mid-segment.
 * - Shell commands are checked segment by segment (see shell.ts): a compound
 *   command cannot launder a denied command behind an allowed one.
 * - Priority resolves rules competing for the SAME segment; ties break
 *   fail-closed (deny > ask > allow). Across segments deny wins outright,
 *   then ask; allow only when EVERY segment decided allow.
 * - No matching rule at all → `undefined` → the plugin delegates to the rest
 *   of the `tools/pre-execute` chain (dsh's own gates keep their say).
 */

import { matchesPrefix, splitSegments } from './shell.js';

export type PolicyDecisionKind = 'allow' | 'deny' | 'ask';

/** One configured rule (the raw Config shape). */
export interface PolicyRuleConfig {
  /** Tool name(s), or `*` for every tool. */
  tool: string | string[];
  decision: PolicyDecisionKind;
  /** Higher wins among rules competing for the same segment; default 0. */
  priority?: number;
  /** Deny reason / ask explanation, surfaced to the model and the answerer. */
  message?: string;
  /**
   * Regex(es) matched against the JSON-stringified arguments (any-of) — or a
   * map of argument name → regex(es) matched against that argument's value
   * (stringified when not a string; AND across keys, any-of within a list).
   */
  argsPattern?: string | string[] | Record<string, string | string[]>;
  /** Anchored, word-boundary prefix match on each shell command segment (any-of). */
  commandPrefix?: string | string[];
  /** Regex(es) anchored at each shell command segment's start (any-of). */
  commandRegex?: string | string[];
}

/** One compiled args condition: a whole-JSON regex set, or one argument key's regex set. */
interface ArgsCondition {
  key?: string;
  res: RegExp[];
}

export interface CompiledRule {
  tools: string[];
  decision: PolicyDecisionKind;
  priority: number;
  message?: string;
  argsConds?: ArgsCondition[];
  commandPrefixes?: string[];
  commandRes?: RegExp[];
}

export interface RuleHit {
  decision: PolicyDecisionKind;
  rule: CompiledRule;
}

/** Fail-closed tie-break within one priority tier. */
const SEVERITY: Record<PolicyDecisionKind, number> = { allow: 0, ask: 1, deny: 2 };

const prefer = (a: CompiledRule, b: CompiledRule): CompiledRule => {
  if (a.priority !== b.priority) return a.priority > b.priority ? a : b;
  return SEVERITY[a.decision] >= SEVERITY[b.decision] ? a : b;
};

const asArray = (value: string | string[] | undefined): string[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

/** Anchor at the (already trimmed) segment start, Gemini-style. */
const anchored = (pattern: string): RegExp => new RegExp(`^(?:${pattern})`);

/** Compile the argsPattern field: string/list → whole-JSON condition; object → per-key conditions. */
function compileArgsConditions(
  pattern: PolicyRuleConfig['argsPattern'],
): ArgsCondition[] | undefined {
  if (pattern === undefined) return undefined;
  const compile = (value: string | string[]) =>
    (Array.isArray(value) ? value : [value]).map((p) => new RegExp(p));
  if (typeof pattern === 'string' || Array.isArray(pattern)) return [{ res: compile(pattern) }];
  return Object.entries(pattern).map(([key, value]) => ({ key, res: compile(value) }));
}

/** Compile config rules for evaluation. Invalid regexes are config errors: they throw here, at plugin load. */
export function compileRules(configs: PolicyRuleConfig[]): CompiledRule[] {
  return configs.map((rule, index) => {
    const tools = asArray(rule.tool) ?? [];
    try {
      return {
        tools,
        decision: rule.decision,
        priority: rule.priority ?? 0,
        message: rule.message,
        argsConds: compileArgsConditions(rule.argsPattern),
        commandPrefixes: asArray(rule.commandPrefix),
        commandRes: asArray(rule.commandRegex)?.map(anchored),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[dsh-policy] invalid regex in rule #${index} (tool "${tools.join(', ')}"): ${reason}`,
      );
    }
  });
}

/** Human-readable rule identity for the default deny reason. */
export function describeRule(rule: CompiledRule): string {
  const quoted = (values: string[]) => values.map((v) => `"${v}"`).join(' | ');
  const parts = [`tool ${quoted(rule.tools)}`];
  if (rule.commandPrefixes) parts.push(`commandPrefix ${quoted(rule.commandPrefixes)}`);
  if (rule.commandRes) parts.push(`commandRegex ${rule.commandRes.join(' | ')}`);
  if (rule.argsConds) {
    parts.push(
      `argsPattern ${rule.argsConds
        .map((cond) => `${cond.key === undefined ? '' : `${cond.key}=`}${cond.res.join(' | ')}`)
        .join(', ')}`,
    );
  }
  return `${parts.join(', ')} (priority ${rule.priority})`;
}

/** The first string-valued argument among `keys` — the shell command, for tools that take one. */
function extractCommand(args: unknown, keys: string[]): string | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

const anyMatch = <T>(values: T[] | undefined, test: (value: T) => boolean): boolean =>
  values === undefined || values.some(test);

/** Every args condition holds: whole-JSON sets test the serialized args; keyed sets test that argument's (stringified) value. */
function argsMatch(rule: CompiledRule, args: unknown, argsJson: string): boolean {
  if (rule.argsConds === undefined) return true;
  return rule.argsConds.every((cond) => {
    if (cond.key === undefined) return cond.res.some((re) => re.test(argsJson));
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
    const value = (args as Record<string, unknown>)[cond.key];
    if (value === undefined) return false;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return cond.res.some((re) => re.test(text));
  });
}

function matchesSegment(rule: CompiledRule, segment: string | undefined): boolean {
  const hasCommandCondition = rule.commandPrefixes !== undefined || rule.commandRes !== undefined;
  // No command string on this call: command conditions cannot be satisfied.
  if (segment === undefined) return !hasCommandCondition;
  return (
    anyMatch(rule.commandPrefixes, (prefix) => matchesPrefix(segment, prefix)) &&
    anyMatch(rule.commandRes, (re) => re.test(segment))
  );
}

export function evaluate(
  rules: CompiledRule[],
  toolName: string,
  args: unknown,
  commandKeys: string[],
): RuleHit | undefined {
  const candidates = rules.filter(
    (rule) => rule.tools.includes('*') || rule.tools.includes(toolName),
  );
  if (candidates.length === 0) return undefined;
  const argsJson = JSON.stringify(args ?? null);
  const command = extractCommand(args, commandKeys);
  // A call without a shell command is one virtual whole-call segment — only
  // rules without command conditions can match it.
  const segments: Array<string | undefined> =
    command === undefined ? [undefined] : splitSegments(command);

  let undecided = false;
  const best: Partial<Record<PolicyDecisionKind, CompiledRule>> = {};
  for (const segment of segments) {
    let winner: CompiledRule | undefined;
    for (const rule of candidates) {
      if (!argsMatch(rule, args, argsJson)) continue;
      if (!matchesSegment(rule, segment)) continue;
      winner = winner === undefined ? rule : prefer(winner, rule);
    }
    if (winner === undefined) undecided = true;
    else {
      const held = best[winner.decision];
      best[winner.decision] = held === undefined ? winner : prefer(held, winner);
    }
  }
  // deny anywhere settles the call, then ask anywhere; allow must be unanimous.
  if (best.deny) return { decision: 'deny', rule: best.deny };
  if (best.ask) return { decision: 'ask', rule: best.ask };
  if (!undecided && best.allow) return { decision: 'allow', rule: best.allow };
  return undefined;
}
