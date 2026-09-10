#!/usr/bin/env node

/**
 * dsh-policy ask leg: an `ask` rule defers to dsh's approval seam — here the
 * headless profile's approval policy is `never` (DSH_PERMISSION_MODE
 * danger-full-access), so the ask resolves `rejected` and the call is denied.
 * The asserted signal is dsh-tools' rejection wording rather than the rule's
 * `message`: the `rejected` outcome maps to a fixed reason and only the
 * no-approval-service-at-all path surfaces `ask.reason` (verified against
 * dsh-tools@0.1.2-rc.1 lib/index.js serviceAsk). Since this leg's only
 * non-allow rule is the ask on npm, the rejection string can only come from
 * the policy gate. See lib/policy-shared.mjs for the machinery and env
 * contract.
 */

import { runPolicyScenario } from './lib/policy-shared.mjs';

await runPolicyScenario({
  tag: 'ask',
  name: 'ask defers to the approval seam (policy never → rejected)',
  rulesYaml: `      - tool: '*'
        decision: allow
        priority: 20
      - tool: bash
        decision: ask
        commandPrefix: npm
        priority: 200
        message: 'npm requires approval per dsh-policy E2E'`,
  prompt: '请用 bash 工具执行 npm --version。如果命令被拒绝，请原样引用拒绝原因。',
  expectPresent: ['the user rejected tool "bash"'],
});
