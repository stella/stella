import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "collation",
  capability: "Locale-aware sorting of human-readable text",
  owner: ["packages/collation/"],
  summary:
    "Constructing an `Intl.Collator` per comparison is a documented hot-path " +
    "cost, so the package caches one per locale behind a bounded LRU; " +
    "`require-cached-collator` routes every `localeCompare` through it.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
