import type { GuardRollout } from "../guard-rollout-policy.ts";

export default {
  id: "no-parser-inline-flatten",
  rules: ["no-parser-inline-flatten/no-parser-inline-flatten"],
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
    "no-parser-inline-flatten/no-parser-inline-flatten",
    "apps/api/src/handlers/case-law/ingestion/parsers",
    "apps/api/src/lib/legal-search/parsers",
  ],
} as const satisfies GuardRollout;
