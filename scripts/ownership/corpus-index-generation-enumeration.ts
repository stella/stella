import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "corpus-index-generation-enumeration",
  capability:
    "Enumerating the search-index generations a release compiled manifests for",
  owner: [
    "apps/api/src/lib/legal-search/corpus-index-manifest.ts",
    "apps/api/src/lib/legal-search/corpus-index-projected-generations.ts",
  ],
  summary:
    "The registry decides which generations a canonical writer projects, not the manifests one release was built with. `readProjectedCorpusIndexGenerationsTx` reads the set from the registry and refuses the write with the retryable `CorpusIndexGenerationUnknownError` when a building, serving or retiring generation has no manifest in the running process; `registeredCorpusIndexGenerationsQuery` names where a projection state can exist. A writer that filtered the registry by the compiled manifests would project a subset and leave the generation it does not know stale.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/legal-search/corpus-index-manifest"],
    names: ["CORPUS_INDEX_MANIFESTS"],
    allowed: [],
  },
} as const satisfies OwnershipEntry;
