import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  group: "root-connection",
  id: "case-law-analysis-store",
  capability: "Storing a generated case-law decision analysis",
  owner: ["apps/api/src/lib/case-law/analysis-store.ts"],
  summary:
    "An analysis is global corpus state written from a background task that " +
    "outlives its request. The store's claim/save/clear operations are the " +
    "only way the generation handlers reach the row, and a deployment reading " +
    "a shared corpus never writes there.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/case-law/analysis-store"],
    allowed: [
      {
        path: "apps/api/src/handlers/case-law/analysis/generate.ts",
        reason: "Generates and stores a decision's analysis.",
      },
      {
        path: "apps/api/src/handlers/case-law/analysis/significance-run.ts",
        reason: "Stores the significance pass over an analysis.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
