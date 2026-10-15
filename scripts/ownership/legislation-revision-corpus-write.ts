import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legislation-revision-corpus-write",
  capability: "Writing a legislation revision's corpus payload",
  owner: ["apps/api/src/handlers/legislation/revision.ts"],
  summary:
    "The revision owner writes the normalized payload that its metadata describes. " +
    "Ingestion supplies a complete revision; callers cannot independently replace its corpus body.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/legal-search/corpus-storage"],
    names: ["writeCorpusDocument"],
    allowed: [
      {
        path: "apps/api/src/lib/legal-search/corpus-pack-batch.ts",
        reason:
          "The shared corpus maintenance writer republishes stored payloads across both document families.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
