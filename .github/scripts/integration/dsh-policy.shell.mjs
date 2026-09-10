#!/usr/bin/env node

/**
 * dsh-policy shell leg: the gate in front of the REAL bash tool and executor
 * in a real dsh boot. Ground truth is the filesystem, not the model's answer:
 * the allowed `touch` must create its file, the denied `touch` must leave no
 * file at all (the command never reached the shell). The deny message in the
 * answer ties the block to the policy rule. See lib/policy-shared.mjs for the
 * machinery and env contract.
 */

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runPolicyScenario } from './lib/policy-shared.mjs';

const DENY_MESSAGE = 'touch ci-blocked is denied by dsh-policy E2E';

await runPolicyScenario({
  tag: 'shell',
  name: 'real bash tool: allowed side effect lands, denied command never runs',
  rulesYaml: `      - tool: '*'
        decision: allow
        priority: 20
      - tool: bash
        decision: deny
        # The prefix is word-boundary anchored, so it must name the full
        # filename — 'touch ci-blocked' would NOT match 'touch ci-blocked.txt'
        # ('.' is not a boundary).
        commandPrefix: touch ci-blocked.txt
        priority: 200
        message: '${DENY_MESSAGE}'`,
  prompt:
    '请依次用 bash 工具执行两条命令：1) touch ci-allowed.txt 2) touch ci-blocked.txt。请原样引用每条命令的输出或拒绝原因。',
  expectPresent: [DENY_MESSAGE],
  // Per-attempt cleanup: a previous attempt's side effects must never leak
  // into the next attempt's assertions.
  prepare: (workDir) => {
    rmSync(join(workDir, 'ci-allowed.txt'), { force: true });
    rmSync(join(workDir, 'ci-blocked.txt'), { force: true });
  },
  verify: (workDir) => {
    const problems = [];
    if (!existsSync(join(workDir, 'ci-allowed.txt'))) {
      problems.push('ci-allowed.txt missing — the allowed command did not run');
    }
    if (existsSync(join(workDir, 'ci-blocked.txt'))) {
      problems.push('ci-blocked.txt exists — the denied command RAN');
    }
    return problems;
  },
});
