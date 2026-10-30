import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-global-fetch-replacement",
  type: "changed-lines",
  expiresAt: "2026-11-06T09:57:36.943Z",
  rules: ["no-global-fetch-replacement/no-global-fetch-replacement"],
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "no-global-fetch-replacement/no-global-fetch-replacement",
    "apps/api/src",
  ],
} as const satisfies GuardRollout;
