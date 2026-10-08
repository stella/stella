import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "corpus-candidate-rehydration",
  capability: "Classifying eligible canonical search candidates",
  owner: [
    "apps/api/src/handlers/case-law/decisions/search.ts",
    "apps/api/src/lib/legal-search/corpus-index-provider.ts",
    "apps/api/src/lib/legal-search/corpus-rehydration-disposition.ts",
    "apps/api/src/handlers/legislation/search.ts",
  ],
  summary:
    "SQL gates content before it leaves the canonical read. " +
    "`partitionCorpusRehydration` returns eligible rows separately from id-only " +
    "dispositions, accumulated by the request through `recordCorpusRehydrationDispositions`.",
  enforcement: {
    kind: "import",
    specifiers: [
      "@/api/handlers/case-law/decisions/search",
      "@/api/lib/legal-search/corpus-index-provider",
      "@/api/handlers/legislation/search",
    ],
    names: [
      "candidateDecisionRowsStatement",
      "pageDecisionRowsStatement",
      "rehydrateCorpusIndexProviderCandidatesStatement",
      "legislationCandidateRowsStatement",
    ],
    allowed: [
      {
        path: "apps/api/src/mcp/generated/capability-dispatch/legislation.search.ts",
        reason:
          "Lazy-loads the handler endpoint; does not invoke its canonical-read statement exports.",
      },
      {
        path: "apps/api/src/tests/query-plans/registry.ts",
        reason:
          "Measures production canonical-read statements under the public reader role.",
      },
      {
        path: "apps/api/src/handlers/legislation/search-hydration.db.test.ts",
        reason:
          "Verifies the legislation read boundary and indexed statement plan.",
      },
      {
        path: "apps/api/src/handlers/case-law/decisions/search-hydration.db.test.ts",
        reason: "Verifies candidate eligibility with the public reader role.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
