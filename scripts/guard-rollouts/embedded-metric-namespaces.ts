import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "embedded-metric-namespaces",
  type: "changed-lines",
  expiresAt: "2026-11-06T00:00:00.000Z",
  check: [
    "bun",
    "--cwd=packages/scripts",
    "run",
    "test",
    "src/embedded-metric-namespaces.test.ts",
  ],
} as const satisfies GuardRollout;
