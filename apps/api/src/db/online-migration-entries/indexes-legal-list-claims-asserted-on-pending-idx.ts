import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-legal-list-claims-asserted-on-pending-idx",
  revision: 1451,
  type: "indexes",
  values: [
    {
      introducedBy: "20261112134328_legal_list_claim_asserted_dates",
      createSql: `CREATE INDEX CONCURRENTLY "legal_list_claims_asserted_on_pending_idx" ON public."legal_list_claims" USING btree ("id") WHERE "asserted_on_source" = 'pending'`,
      definitionBody:
        "ON public.legal_list_claims USING btree (id) WHERE (asserted_on_source = 'pending'::text)",
      isUnique: false,
      name: "legal_list_claims_asserted_on_pending_idx",
      tableName: "legal_list_claims",
    },
  ],
} satisfies OnlineMigrationEntry;
