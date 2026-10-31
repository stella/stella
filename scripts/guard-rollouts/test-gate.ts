import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "test-gate",
  type: "changed-lines",
  expiresAt: "2026-11-05T00:00:00.000Z",
  check: ["bun", "scripts/test-gate.ts"],
} as const satisfies GuardRollout;
