import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "function-dependent-index-reindex",
  capability:
    "Rebuilding every index whose expression or predicate depends on a replaced IMMUTABLE function",
  owner: ["apps/api/src/db/function-dependent-index-reindex.ts"],
  summary:
    "The online repair derives dependent indexes from the PostgreSQL catalog, rebuilds them concurrently through the table gate, and checkpoints each completed index in the maintenance owner. A replacement revision identifies each replay-safe workset.",
  enforcement: {
    kind: "custom-rule",
    rule: "apps/api/src/db/function-dependent-index-reindex.postgres.test.ts",
    reason:
      "The catalog-backed guard requires a registered repair for each new indexed immutable function replacement.",
  },
} as const satisfies OwnershipEntry;
