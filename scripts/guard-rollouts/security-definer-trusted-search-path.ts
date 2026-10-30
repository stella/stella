import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "security-definer-trusted-search-path",
  type: "changed-lines",
  expiresAt: "2026-11-06T00:00:00.000Z",
  check: ["bun", "scripts/check-migration-safety.ts"],
} as const satisfies GuardRollout;
