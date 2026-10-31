import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legal-holds",
  capability: "Legal-hold placement, release, and deletion refusal",
  owner: [
    "apps/api/src/lib/legal-holds/",
    "apps/api/src/db/schema/legal-holds.ts",
  ],
  summary:
    "The legal-hold owner resolves matter, item, file, contact, account and organization protection in the caller's transaction. Placement, release and deletion share the organization lock before active holds are read under shared row locks. A hold reaches a client only through its owner projection: organization owners and administrators and the member who placed it read its reason; every other member sees the hold without it.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
