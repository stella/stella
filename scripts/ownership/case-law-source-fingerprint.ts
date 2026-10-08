import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-source-fingerprint",
  capability:
    "The change-detection hash of a case-law decision's stored source",
  owner: ["apps/api/src/handlers/case-law/ingestion/source-fingerprint.ts"],
  summary:
    "`sourceFingerprint` is the only constructor of `SourceFingerprint`, " +
    "derived from the stored envelope and every object stored beside it, so " +
    "`rawHash` changes whenever a stored byte does. The " +
    "`raw-hash-from-source-fingerprint` rule rejects a hand-written `rawHash` " +
    "in adapters, and `scripts/source-fingerprint-baseline.ts` enumerates " +
    "every registered source, every exempt file and every external-id writer " +
    "against a shrink-only baseline.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
