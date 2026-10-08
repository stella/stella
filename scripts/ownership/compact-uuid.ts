import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "compact-uuid",
  capability: "Compacting a uuid into a URL segment and reading it back",
  owner: ["packages/uuid-codec/"],
  summary:
    "A public-law address falls back to the row id when the corpus holds no " +
    "slug for the row yet, and the case-law and statute readers mint those " +
    "segments independently: a second encoding would hand out links the " +
    "other reader resolves to nothing. The output is published in URLs, so " +
    "it is the contract — 22 unpadded base64url characters over the uuid's " +
    "16 bytes — held by property tests over every 16-byte id rather than " +
    "over the uuid versions in use today. Invalid input is a typed failure, " +
    "so a reader decides for itself whether an unreadable segment is a 404 " +
    "or a value to carry through.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
