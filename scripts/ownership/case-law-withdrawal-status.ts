import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-withdrawal-status",
  capability: "Projecting tenant-held decision copies at read time",
  owner: ["apps/api/src/lib/case-law/withdrawn-copies.ts"],
  summary:
    "One batched public-corpus read resolves withdrawal status for copy projections. " +
    "The status view exposes decision ids, status and withdrawal timestamps only.",
  enforcement: {
    kind: "custom-rule",
    rule: "public-case-law-db-boundary",
    reason:
      "Schema imports and SQL reads of the withdrawal view are confined to the copy projection owner.",
  },
} as const satisfies OwnershipEntry;
