import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legislation-revision-row-write",
  capability: "Persisting a legislation revision's body and version metadata",
  owner: ["apps/api/src/handlers/legislation/ingestion.ts"],
  summary:
    "The ingestion owner publishes revision values together. " +
    "`no-direct-legislation-revision-write` rejects separate row mutations; " +
    "withdrawal, expression-ID backfill and projection-epoch owners may update " +
    "only their exact unrelated columns through explicit object literals.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
