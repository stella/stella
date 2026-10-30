import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "system-extracted-content-read",
  capability: "Reading extracted document content for system work",
  owner: ["apps/api/src/lib/document-content-provenance.ts"],
  summary:
    "Organization-wide extracted-content reads are limited to background projection and deadline processing paths.",
  enforcement: {
    kind: "import",
    specifiers: ["@/api/lib/document-content-provenance"],
    names: [
      "loadCurrentExtractedContentsForSearchIndex",
      "loadCurrentDeadlineSource",
      "isCurrentDeadlineSource",
    ],
    allowed: [
      {
        path: "apps/api/src/lib/search/index-entity.ts",
        reason: "Builds the organization search projection in a system worker.",
      },
      {
        path: "apps/api/src/lib/scouts/document-deadlines.ts",
        reason: "Processes a persisted extraction run in a system scout.",
      },
      {
        path: "apps/api/src/lib/document-current-content.db.test.ts",
        reason: "Exercises system readers against PostgreSQL.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
