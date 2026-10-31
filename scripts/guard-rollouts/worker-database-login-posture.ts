import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "worker-database-login-posture",
  rules: [
    "require-worker-database-login-posture/require-worker-database-login-posture",
  ],
  type: "full",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "require-worker-database-login-posture/require-worker-database-login-posture",
    "apps/api/src",
  ],
} as const satisfies GuardRollout;
