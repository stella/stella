import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "tracked-symlinks",
  type: "full",
  check: ["bun", "scripts/check-tracked-symlinks.ts"],
} as const satisfies GuardRollout;
