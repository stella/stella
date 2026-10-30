import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "raw-transaction-deadlines",
  type: "full",
  check: ["bun", "scripts/ratchet.ts", "--check"],
} as const satisfies GuardRollout;
