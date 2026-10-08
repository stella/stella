import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-adapter-manifest",
  capability: "Case-law source declarations",
  owner: [
    "apps/api/src/lib/legal-search/adapter-manifest.ts",
    "apps/api/src/lib/case-law/ecli-court-codes.ts",
  ],
  summary:
    "One total map binds every adapter key to its source name, jurisdiction, " +
    "known ECLI court codes, declared text sentinels, and date range. " +
    "Each jurisdiction selection also carries its declared docket grammar. " +
    "Adapters read the declaration, and the runner " +
    "reads the resulting total registry, so adding a source requires one " +
    "complete entry.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
