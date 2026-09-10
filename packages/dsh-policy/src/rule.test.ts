import { describe, expect, it } from 'vitest';
import { compileRules, describeRule, evaluate, type PolicyRuleConfig } from './rule.js';

const KEYS = ['command'];
const run = (rules: PolicyRuleConfig[], tool: string, args: unknown) =>
  evaluate(compileRules(rules), tool, args, KEYS);

const bash = (command: string) => ({ command });

describe('compileRules', () => {
  it('throws on an invalid regex at compile time (config error, not runtime)', () => {
    expect(() => compileRules([{ tool: 'bash', decision: 'deny', commandRegex: '([' }])).toThrow(
      /invalid regex in rule #0/,
    );
    expect(() => compileRules([{ tool: 'bash', decision: 'deny', argsPattern: '*' }])).toThrow(
      /invalid regex in rule #0/,
    );
  });
});

describe('evaluate', () => {
  it('matches the tool name, with "*" as wildcard', () => {
    const rules: PolicyRuleConfig[] = [{ tool: 'bash', decision: 'deny' }];
    expect(run(rules, 'bash', bash('ls'))?.decision).toBe('deny');
    expect(run(rules, 'write_file', { path: 'a' })).toBeUndefined();
    expect(run([{ tool: '*', decision: 'allow' }], 'write_file', { path: 'a' })?.decision).toBe(
      'allow',
    );
  });

  it('accepts an array of tool names (any-of)', () => {
    const rules: PolicyRuleConfig[] = [{ tool: ['write_file', 'replace'], decision: 'deny' }];
    expect(run(rules, 'write_file', { path: 'a' })?.decision).toBe('deny');
    expect(run(rules, 'replace', { path: 'a' })?.decision).toBe('deny');
    expect(run(rules, 'read_file', { path: 'a' })).toBeUndefined();
  });

  it('matches argsPattern against the JSON-stringified arguments', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: 'write_file', decision: 'deny', argsPattern: '\\.md"' },
      { tool: 'write_file', decision: 'allow', argsPattern: 'PRODUCT\\.md', priority: 300 },
    ];
    expect(run(rules, 'write_file', { file_path: '/x/README.md' })?.decision).toBe('deny');
    expect(run(rules, 'write_file', { file_path: '/x/PRODUCT.md' })?.decision).toBe('allow');
    expect(run(rules, 'write_file', { file_path: '/x/a.ts' })).toBeUndefined();
  });

  it('matches commandPrefix per segment with a word boundary', () => {
    const rules: PolicyRuleConfig[] = [{ tool: 'bash', decision: 'deny', commandPrefix: 'npm' }];
    expect(run(rules, 'bash', bash('npm install'))?.decision).toBe('deny');
    expect(run(rules, 'bash', bash('npmx install'))).toBeUndefined();
    expect(run(rules, 'bash', bash('git grep npm'))).toBeUndefined();
  });

  it('accepts an array of command prefixes (any-of)', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: 'bash', decision: 'deny', commandPrefix: ['rm -rf', 'rm -fr', 'shred'] },
    ];
    expect(run(rules, 'bash', bash('rm -rf /tmp/x'))?.decision).toBe('deny');
    expect(run(rules, 'bash', bash('shred secret'))?.decision).toBe('deny');
    expect(run(rules, 'bash', bash('rm ./relative'))).toBeUndefined();
  });

  it('anchors commandRegex at the segment start (Gemini-compatible)', () => {
    const rules: PolicyRuleConfig[] = [{ tool: 'bash', decision: 'deny', commandRegex: 'npm\\b' }];
    expect(run(rules, 'bash', bash('npm install'))?.decision).toBe('deny');
    // A mid-segment mention is not the segment's command — no match.
    expect(run(rules, 'bash', bash('echo npm'))).toBeUndefined();
  });

  it('matches commandRegex per segment', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: 'bash', decision: 'deny', commandRegex: 'bun\\s+pm\\s+(?!view\\b)' },
    ];
    expect(run(rules, 'bash', bash('bun pm install'))?.decision).toBe('deny');
    expect(run(rules, 'bash', bash('bun pm view react'))).toBeUndefined();
  });

  it('resolves same-segment competition by priority', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: 'bash', decision: 'deny', commandPrefix: 'bun run', priority: 200 },
      { tool: 'bash', decision: 'allow', commandPrefix: 'bun run lint', priority: 300 },
    ];
    expect(run(rules, 'bash', bash('bun run lint'))?.decision).toBe('allow');
    expect(run(rules, 'bash', bash('bun run build'))?.decision).toBe('deny');
  });

  it('breaks priority ties fail-closed (deny > ask > allow)', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: 'bash', decision: 'allow', commandPrefix: 'npm' },
      { tool: 'bash', decision: 'deny', commandPrefix: 'npm' },
    ];
    expect(run(rules, 'bash', bash('npm i'))?.decision).toBe('deny');
  });

  it('denies a compound command when any segment denies, regardless of priority', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: 'bash', decision: 'deny', commandPrefix: 'npm', priority: 200 },
      { tool: 'bash', decision: 'allow', commandPrefix: 'bun run lint', priority: 300 },
      { tool: '*', decision: 'allow', priority: 20 },
    ];
    expect(run(rules, 'bash', bash('bun run lint && npm i'))?.decision).toBe('deny');
    expect(run(rules, 'bash', bash('echo "$(npm i)"'))?.decision).toBe('deny');
  });

  it('allows a compound command only when every segment decided allow', () => {
    const allowLint: PolicyRuleConfig[] = [
      { tool: 'bash', decision: 'allow', commandPrefix: 'bun run lint', priority: 300 },
    ];
    // `echo hi` matches no rule → the plugin has no opinion on the compound.
    expect(run(allowLint, 'bash', bash('bun run lint && echo hi'))).toBeUndefined();
    const withAllowAll = [...allowLint, { tool: '*', decision: 'allow', priority: 20 } as const];
    expect(run(withAllowAll, 'bash', bash('bun run lint && echo hi'))?.decision).toBe('allow');
  });

  it('prefers deny over an undecided sibling segment', () => {
    const rules: PolicyRuleConfig[] = [{ tool: 'bash', decision: 'deny', commandPrefix: 'npm' }];
    expect(run(rules, 'bash', bash('npm i && mysteriouscmd'))?.decision).toBe('deny');
  });

  it('returns ask when the winning rule asks', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: 'write_file', decision: 'ask', argsPattern: '/etc/', message: 'system path' },
    ];
    const hit = run(rules, 'write_file', { file_path: '/etc/hosts' });
    expect(hit?.decision).toBe('ask');
    expect(hit?.rule.message).toBe('system path');
  });

  it('never matches command conditions on a command-less tool', () => {
    const rules: PolicyRuleConfig[] = [
      { tool: '*', decision: 'deny', commandPrefix: 'npm' },
      { tool: '*', decision: 'allow', priority: 20 },
    ];
    expect(run(rules, 'write_file', { file_path: '/x/npm.md' })?.decision).toBe('allow');
  });

  it('treats an empty command as no opinion (delegates)', () => {
    const rules: PolicyRuleConfig[] = [{ tool: 'bash', decision: 'deny', commandPrefix: 'npm' }];
    expect(run(rules, 'bash', bash('   '))).toBeUndefined();
    expect(run(rules, 'bash', {})).toBeUndefined();
  });

  it('honors a custom commandKeys list', () => {
    const rules = compileRules([{ tool: 'sh', decision: 'deny', commandPrefix: 'npm' }]);
    expect(evaluate(rules, 'sh', { script: 'npm i' }, ['command'])).toBeUndefined();
    expect(evaluate(rules, 'sh', { script: 'npm i' }, ['script'])?.decision).toBe('deny');
  });

  it('returns undefined when nothing matches', () => {
    expect(
      run([{ tool: 'bash', decision: 'deny', commandPrefix: 'npm' }], 'bash', bash('ls')),
    ).toBeUndefined();
  });
});

describe('describeRule', () => {
  it('renders the rule identity for default deny reasons', () => {
    const [rule] = compileRules([
      { tool: 'bash', decision: 'deny', commandPrefix: 'npm', priority: 200 },
    ]);
    expect(describeRule(rule)).toBe('tool "bash", commandPrefix "npm" (priority 200)');
  });

  it('renders array fields', () => {
    const [rule] = compileRules([
      { tool: ['write_file', 'replace'], decision: 'deny', commandPrefix: ['rm', 'shred'] },
    ]);
    expect(describeRule(rule)).toBe(
      'tool "write_file" | "replace", commandPrefix "rm" | "shred" (priority 0)',
    );
  });
});
