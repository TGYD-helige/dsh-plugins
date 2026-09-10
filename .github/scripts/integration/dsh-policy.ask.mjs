#!/usr/bin/env node

/**
 * dsh-policy ask leg: an `ask` rule with no approval service composed (the
 * headless profile ships none) fails closed — dsh-tools denies the call with
 * the ask decision's reason, so the model quotes the rule's `message`
 * verbatim. Verified against dsh-tools@0.1.2-rc.1 lib/index.js serviceAsk
 * (missing approval service → deny with `ask.reason`). See
 * lib/policy-shared.mjs for the machinery and env contract.
 */

import { runPolicyScenario } from './lib/policy-shared.mjs';

const ASK_MESSAGE = 'npm requires approval per dsh-policy E2E';

await runPolicyScenario({
  tag: 'ask',
  name: 'ask fails closed without an approval service',
  rulesYaml: `      - tool: '*'
        decision: allow
        priority: 20
      - tool: bash
        decision: ask
        commandPrefix: npm
        priority: 200
        message: '${ASK_MESSAGE}'`,
  prompt: '请用 bash 工具执行 npm --version。如果命令被拒绝，请原样引用拒绝原因。',
  expectPresent: [ASK_MESSAGE],
});
