import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-raw-text-truncation",
  rules: ["no-raw-text-truncation/no-raw-text-truncation"],
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
    "no-raw-text-truncation/no-raw-text-truncation",
    "apps/web/src",
    "apps/desktop/src",
  ],
} as const satisfies GuardRollout;
