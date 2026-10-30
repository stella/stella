import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-bare-case-law-source-ingestion-lease",
  rules: [
    "no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease",
  ],
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
    "no-bare-case-law-source-ingestion-lease/no-bare-case-law-source-ingestion-lease",
    ".",
  ],
} as const satisfies GuardRollout;
