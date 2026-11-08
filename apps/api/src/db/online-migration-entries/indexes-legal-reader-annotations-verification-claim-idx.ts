import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-legal-reader-annotations-verification-claim-idx",
  revision: 90,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      // Serves the matter key's cascade and the claim cleanup trigger; both
      // still work, by a scan, until it exists.
      createSql:
        'CREATE INDEX CONCURRENTLY "legal_reader_annotations_verification_claim_idx" ON public."legal_reader_annotations" (workspace_id, verification_claim_id) WHERE workspace_id IS NOT NULL',
      definitionBody:
        "ON public.legal_reader_annotations USING btree (workspace_id, verification_claim_id) WHERE (workspace_id IS NOT NULL)",
      isUnique: false,
      name: "legal_reader_annotations_verification_claim_idx",
      tableName: "legal_reader_annotations",
    },
  ],
} satisfies OnlineMigrationEntry;
