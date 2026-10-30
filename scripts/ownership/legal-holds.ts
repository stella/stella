import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legal-holds",
  capability: "Legal-hold placement, release, and deletion refusal",
  owner: [
    "apps/api/src/lib/legal-holds/",
    "apps/api/src/db/schema/legal-holds.ts",
  ],
  summary:
    "The legal-hold owner resolves matter, item, file, contact, account and organization protection in the caller's transaction. Placement, release and deletion share the organization lock before active holds are read under shared row locks.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
