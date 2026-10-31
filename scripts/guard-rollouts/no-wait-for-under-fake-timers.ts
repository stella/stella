import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-wait-for-under-fake-timers",
  rules: ["bun-test-hygiene/no-wait-for-under-fake-timers"],
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
    "bun-test-hygiene/no-wait-for-under-fake-timers",
    "apps",
    "packages",
  ],
} as const satisfies GuardRollout;
