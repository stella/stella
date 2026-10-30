import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-style-substring-match",
  rules: ["no-style-substring-match/no-style-substring-match"],
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
    "no-style-substring-match/no-style-substring-match",
    ".",
  ],
} as const satisfies GuardRollout;
