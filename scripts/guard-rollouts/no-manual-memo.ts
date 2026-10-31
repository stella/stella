import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-manual-memo",
  rules: ["no-manual-memo/no-manual-memo"],
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
    "no-manual-memo/no-manual-memo",
    "apps/web/src",
  ],
} as const satisfies GuardRollout;
