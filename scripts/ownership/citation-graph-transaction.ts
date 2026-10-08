import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "citation-graph-transaction",
  capability: "Acquiring the citation graph transaction lock",
  owner: ["apps/api/src/handlers/case-law/citation-graph-transaction.ts"],
  summary:
    "The graph owner acquires its advisory lock before domain row locks and passes a branded transaction to graph writers. The conditional owner declines busy walks before reading their cursor.",
  enforcement: {
    kind: "literal-pattern",
    pattern: "citation_resolution_walk",
    allowed: [
      {
        path: "scripts/ownership/citation-graph-transaction.ts",
        reason: "Declares the confined lock key.",
      },
      {
        path: "apps/api/src/handlers/case-law/citation-graph-transaction.test.ts",
        reason: "Checks graph admission and failed acquisition.",
      },
      {
        path: "apps/api/src/handlers/case-law/ingestion/citation-graph-lock-order.postgres.test.ts",
        reason: "Exercises graph lock ordering and the rejecting mutation.",
      },
      {
        path: ".oxlint-plugins/__tests__/confine-owner.test.ts",
        reason:
          "Exercises rejected literal and SQL fixtures through the lint rule.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
