import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-canonical-money-form-parse",
  rules: ["no-canonical-money-form-parse/no-canonical-money-form-parse"],
  type: "changed-lines",
  expiresAt: "2026-11-06T00:00:00.000Z",
  check: ["bun", "--bun", "oxlint", "-c", "oxlint.config.ts", "apps/web"],
} as const satisfies GuardRollout;
