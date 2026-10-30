import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-raw-property-assert",
  rules: ["no-raw-property-assert/no-raw-property-assert"],
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
    "no-raw-property-assert/no-raw-property-assert",
    ".",
  ],
} as const satisfies GuardRollout;
