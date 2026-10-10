import type { OwnershipEntry } from "../ownership-types.ts";
import { SHA256_OWNERS } from "../sha256-owners.ts";

export default {
  id: "sha256",
  capability: "Hashing content with SHA-256 across runtimes",
  owner: Object.keys(SHA256_OWNERS),
  summary:
    "Private runtime helpers and a published-package local owner preserve bytes, update order and digest encodings. no-raw-sha256 confines primitives to registered owners; the enumerating migration ledger only shrinks.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
