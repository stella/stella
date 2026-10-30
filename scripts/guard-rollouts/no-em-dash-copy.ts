import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-em-dash-copy",
  rules: ["no-em-dash-copy/no-em-dash-copy"],
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
    "no-em-dash-copy/no-em-dash-copy",
    ".",
  ],
} as const satisfies GuardRollout;
