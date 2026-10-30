import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "central-test-timeout",
  type: "full",
  check: ["bun", "scripts/check-oxlint-test-timeouts.ts"],
} as const satisfies GuardRollout;
