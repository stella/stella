import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "action-commit-pins",
  type: "full",
  check: ["bun", "scripts/check-action-commit-pins.ts"],
} as const satisfies GuardRollout;
