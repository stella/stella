import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "inspector-header-title",
  rules: ["inspector-header-title/inspector-header-title"],
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
    "inspector-header-title/inspector-header-title",
    ".",
  ],
} as const satisfies GuardRollout;
