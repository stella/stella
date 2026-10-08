import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "text-folding",
  capability: "Diacritic and ASCII folding for search and slugs",
  owner: ["packages/text-normalize/"],
  summary:
    "Folding decides which strings compare equal, so search, highlighting, " +
    "and slugs have to agree on it. Build slug helpers on the folds exported " +
    "here rather than on a local regex.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
