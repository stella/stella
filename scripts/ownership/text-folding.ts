import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "text-folding",
  capability: "Unicode normalization, diacritic and ASCII folding",
  owner: ["packages/text-normalize/"],
  summary:
    "Normalization and folding decide which strings compare equal, so search, " +
    "highlighting, storage keys, and slugs have to agree on them. Use the " +
    "Unicode normalization and fold helpers exported here.",
  enforcement: {
    kind: "custom-rule",
    rule: "no-direct-unicode-normalize/no-direct-unicode-normalize",
    reason:
      "The guard must distinguish String.normalize from node:path normalize " +
      "and recognize equivalent Unicode mark-removal regular expressions.",
  },
} as const satisfies OwnershipEntry;
