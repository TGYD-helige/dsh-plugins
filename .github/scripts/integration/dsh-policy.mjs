#!/usr/bin/env node

/**
 * dsh-policy base leg: with the plugin enabled, an uncovered command still
 * runs (pass-through default — the marker content lives only on disk, so it
 * can only reach the answer through an executed `cat`), while a denied
 * command is blocked and the model quotes the rule's `message` verbatim
 * (it can only know that string from the gate's materialized tool error).
 * See lib/policy-shared.mjs for the machinery and env contract.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPolicyScenario } from './lib/policy-shared.mjs';

const DENY_MESSAGE = 'npm is not allowed by dsh-policy E2E';
const MARKER_CONTENT = `ci-policy-marker-${Date.now()}`;

await runPolicyScenario({
  tag: 'base',
  name: 'pass-through default + deny',
  rulesYaml: `      - tool: '*'
        decision: allow
        priority: 20
      - tool: bash
        decision: deny
        commandPrefix: npm
        priority: 200
        message: '${DENY_MESSAGE}'`,
  prompt: `请依次用 bash 工具执行两条命令：1) cat ci-policy-marker.txt 2) npm --version。请原样引用每条命令的输出或拒绝原因。`,
  expectPresent: [MARKER_CONTENT, DENY_MESSAGE],
  prepare: (workDir) => writeFileSync(join(workDir, 'ci-policy-marker.txt'), `${MARKER_CONTENT}\n`),
});
