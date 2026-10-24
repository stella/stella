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
    "every registered source, every exempt file and external-id change " +
    "writers against a shrink-only baseline. Exact reviewed owner protocols " +
    "also prove durable manual receipts, insert-only creation and immutable " +
    "file-version identities; owner or helper edits revoke those credits. " +
    "A fingerprint version bump changes the " +
    "fingerprint over the same stored bytes; changing the stored bytes makes " +
    "the next observation rewrite the row instead, with a parser version " +
    "bump only when parser output changes.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
