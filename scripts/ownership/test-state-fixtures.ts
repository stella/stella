import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "test-state-fixtures",
  capability:
    "Test writes to process environment and validated configuration objects",
  owner: ["packages/test-state/"],
  summary:
    "`createTestState` records the first write of each environment or " +
    "configuration key and restores it after the test, suite or file that " +
    "made it, and refuses concurrent runs. App, package and repository " +
    "script tests share this one fixture.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-direct-test-state/no-direct-test-state",
    reason:
      "Direct `process.env` and validated `env` writes in test files are rejected; existing sites hold shrink-only counts in scripts/test-state-baseline.json.",
  },
} as const satisfies OwnershipEntry;
