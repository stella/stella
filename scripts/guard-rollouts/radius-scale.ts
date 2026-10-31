import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "radius-scale",
  rules: ["radius-scale/radius-scale"],
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
    "radius-scale/radius-scale",
    "apps/web/src",
    "packages/ui/src",
    "packages/workspace-ui/src",
  ],
} as const satisfies GuardRollout;
