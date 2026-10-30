import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "transaction-timeout-owner",
  rules: ["confine-aggregate-lock/confine-aggregate-lock"],
  type: "changed-lines",
  expiresAt: "2026-11-06T20:29:13.000Z",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "confine-aggregate-lock/confine-aggregate-lock",
    ".",
  ],
} as const satisfies GuardRollout;
