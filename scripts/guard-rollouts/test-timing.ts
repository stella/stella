import type { GuardRollout } from "../guard-rollout-policy";

export default {
  id: "test-timing",
  rules: ["test-timing/no-literal-wait-timeout"],
  type: "changed-lines",
  expiresAt: "2026-11-05T00:00:00.000Z",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "test-timing/no-literal-wait-timeout",
    ".",
  ],
} as const satisfies GuardRollout;
