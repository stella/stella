import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "searchable-long-select",
  rules: ["searchable-long-select/searchable-long-select"],
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
    "searchable-long-select/searchable-long-select",
    ".",
  ],
} as const satisfies GuardRollout;
