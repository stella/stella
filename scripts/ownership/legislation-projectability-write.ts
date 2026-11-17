import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "legislation-projectability-write",
  capability:
    "Writing a legislation document's projectability (its content hash)",
  owner: ["apps/api/src/lib/legal-search/corpus-projectability-write.ts"],
  summary:
    "A legislation document's `content_hash` decides whether it is projectable, so a write of it that does not project in its own transaction leaves a document with no desired state in any generation while its routes read seeded. The owner writes it and projects the document into every active generation in the same transaction, taking the source share lock before the row. Writers whose payload is built elsewhere (the revision writer) are outside this syntax check; the test databases' default-on seeding guard fails any of them that commits a projectable row without states.",
  enforcement: {
    kind: "table-column-write",
    specifiers: ["@/api/db/schema", "@/api/db/schema/legislation"],
    table: "legislationDocuments",
    columns: ["contentHash"],
    allowed: [
      {
        path: "apps/api/src/handlers/legislation/ingestion.ts",
        reason:
          "Ingestion's settle and retry-reset transactions write the content hash under the source lock taken first and project the document in the same transaction.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
