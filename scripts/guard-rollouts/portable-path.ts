import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "portable-path",
  rules: ["no-raw-path-relative/no-raw-path-relative"],
  type: "full",
  check: [
    "bun",
    "--bun",
    "oxlint",
    "-c",
    "oxlint.config.ts",
    "--allow",
    "all",
    "--deny",
    "no-raw-path-relative/no-raw-path-relative",
    ".",
  ],
} as const satisfies GuardRollout;
