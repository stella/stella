import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-raw-context-menu",
  rules: ["no-raw-context-menu/no-raw-context-menu"],
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
    "no-raw-context-menu/no-raw-context-menu",
    "apps/web/src",
    "apps/desktop/src",
  ],
} as const satisfies GuardRollout;
