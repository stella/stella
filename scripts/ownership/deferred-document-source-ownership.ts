import type { OwnershipEntry } from "../ownership-types.ts";

export default {
    id: "deferred-document-source-ownership",
    capability: "Owning deferred document writes",
    owner: ["apps/api/src/lib/legal-search/sk-document-backfill.ts"],
    summary:
      "Deferred document operations acquire source ownership before remote and database effects. Raw write functions stay within the writer module.",
    enforcement: {
      kind: "import",
      specifiers: ["@/api/lib/legal-search/deferred-document-source-ownership"],
      allowed: [],
    },
  } as const satisfies OwnershipEntry;
