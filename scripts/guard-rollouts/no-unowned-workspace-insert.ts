import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-unowned-workspace-insert",
  rules: ["no-unowned-workspace-insert/no-unowned-workspace-insert"],
  type: "changed-lines",
  expiresAt: "2026-11-07T00:00:00.000Z",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "no-unowned-workspace-insert/no-unowned-workspace-insert",
    ".",
  ],
} as const satisfies GuardRollout;
