import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-real-timers-in-tests",
  rules: ["no-real-timers-in-tests/no-real-timers-in-tests"],
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
    "no-real-timers-in-tests/no-real-timers-in-tests",
    ".",
  ],
} as const satisfies GuardRollout;
