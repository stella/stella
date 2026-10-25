import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-quarantine-identity",
  capability:
    "The identity of a listed case-law record that states no usable publisher id",
  owner: ["apps/api/src/lib/legal-search/quarantine-identity.ts"],
  summary:
    "`quarantineIdentity` builds `<namespace>-quarantine:<sha256>` from the " +
    "stable fields an adapter names, with one namespace per adapter in " +
    "`QUARANTINE_NAMESPACE`. `ListingIdentity` has no variant for an unkeyed " +
    "record and `listingIdentityKey` panics on an unkeyable one, so every " +
    "listed record is stored, listing-only if need be (case-law AGENTS.md " +
    "rule 20). The reconciliation walk counts a quarantine identity held " +
    "without detail. Adapters that minted their own quarantine digests " +
    "before this module keep them for the rows they already store.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
