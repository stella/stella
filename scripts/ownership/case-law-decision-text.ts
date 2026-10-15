import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-decision-text",
  capability:
    "Representing publisher-authored decision text at ingestion and public read boundaries",
  owner: [
    "packages/api-contract/src/case-law-text-field.ts",
    "apps/api/src/lib/case-law/decision-headnote.ts",
    "apps/api/src/lib/case-law/decision-headnote-schema.ts",
    "apps/api/src/lib/case-law/decision-text.ts",
    "apps/api/src/lib/case-law/decision-text-sql.ts",
  ],
  summary:
    "The shared discriminated values make text presence and row-preview truncation explicit to API consumers. " +
    "The API owner classifies source values, converts them to storage metadata, " +
    "and reconstructs bounded public values; the adapter lint keeps protected keys behind that boundary.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
