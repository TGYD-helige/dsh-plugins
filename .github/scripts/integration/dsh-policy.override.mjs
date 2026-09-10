#!/usr/bin/env node

/**
 * dsh-policy override leg: broad deny + narrow allow — `git` is denied at
 * priority 200 while `git status` is allowed at 300. The model must report
 * git status output ("On branch …" — only reachable by really running it)
 * alongside the rule's deny message for `git log` (only reachable through
 * the gate). See lib/policy-shared.mjs for the machinery and env contract.
 */

import { run } from './lib/ci-shared.mjs';
import { runPolicyScenario } from './lib/policy-shared.mjs';

const DENY_MESSAGE = 'git is denied except status by dsh-policy E2E';

await runPolicyScenario({
  tag: 'override',
  name: 'broad deny + narrow allow override',
  rulesYaml: `      - tool: bash
        decision: deny
        commandPrefix: git
        priority: 200
        message: '${DENY_MESSAGE}'
      - tool: bash
        decision: allow
        commandPrefix: git status
        priority: 300`,
  prompt:
    '请依次用 bash 工具执行两条命令：1) git status 2) git log --oneline -1。请原样引用每条命令的输出或拒绝原因。',
  expectPresent: ['On branch', DENY_MESSAGE],
  prepare: (workDir) => run('git', ['init', '-q'], { cwd: workDir }),
});
