import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-ambient-time-in-tests",
  rules: ["no-ambient-time-in-tests/no-ambient-time-in-tests"],
  type: "changed-lines",
  expiresAt: "2026-11-06T00:00:00.000Z",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "no-ambient-time-in-tests/no-ambient-time-in-tests",
    ".",
  ],
} as const satisfies GuardRollout;
