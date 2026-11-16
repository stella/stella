import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "case-law-projectability-write",
  capability: "Writing a decision's projectability or projected content hash",
  owner: ["apps/api/src/lib/legal-search/corpus-projectability-write.ts"],
  summary:
    "A decision's `corpus_mirror_status` decides whether it is projectable and its `content_hash` what it projects, so a write of either that does not project in its own transaction leaves a settled row with no desired state in any generation (its routes still read seeded) or a stale one. The owner writes them and projects the decision into every active generation in the same transaction, taking the source share lock before the row. Writers whose payload is built elsewhere (the ingestion row writer, the settle transaction, withdrawal, replay) are outside this syntax check; the test databases' default-on seeding guard fails any of them that commits a projectable row without states.",
  enforcement: {
    kind: "table-column-write",
    specifiers: ["@/api/db/schema", "@/api/db/schema/case-law"],
    table: "caseLawDecisions",
    columns: ["corpusMirrorStatus", "contentHash"],
    allowed: [
      {
        path: "apps/api/src/handlers/case-law/erasure.ts",
        reason:
          "Erasure settles the scrubbed decision and projects it with the source lock it took before the rows, in the same transaction.",
      },
      {
        path: "apps/api/src/lib/scheduler/tasks/case-law-redaction-tombstone-backfill.ts",
        reason:
          "The redaction tombstone settles and redacts decisions under the owner's source locks taken before the rows, and projects them through the owner in the same transaction.",
      },
    ],
  },
} as const satisfies OwnershipEntry;
