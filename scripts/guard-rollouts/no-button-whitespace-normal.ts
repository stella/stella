import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-button-whitespace-normal",
  rules: ["no-button-whitespace-normal/no-button-whitespace-normal"],
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
    "no-button-whitespace-normal/no-button-whitespace-normal",
    "apps",
    "packages",
  ],
} as const satisfies GuardRollout;
