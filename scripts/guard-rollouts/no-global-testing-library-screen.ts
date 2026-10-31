import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-global-testing-library-screen",
  rules: ["bun-test-hygiene/no-global-testing-library-screen"],
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
    "bun-test-hygiene/no-global-testing-library-screen",
    "packages",
  ],
} as const satisfies GuardRollout;
