import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-legal-list-generation-runs-stella-active-idx",
  revision: 1429,
  type: "indexes",
  values: [
    {
      introducedBy: "20261109190000_list_fact_extraction_runs",
      createSql: `CREATE INDEX CONCURRENTLY "legal_list_generation_runs_stella_active_idx" ON public."legal_list_generation_runs" USING btree ("created_at", "id") WHERE "producer" = 'stella' AND "status" IN ('queued', 'running')`,
      definitionBody:
        "ON public.legal_list_generation_runs USING btree (created_at, id) WHERE ((producer = 'stella'::text) AND (status = ANY (ARRAY['queued'::text, 'running'::text])))",
      isUnique: false,
      name: "legal_list_generation_runs_stella_active_idx",
      tableName: "legal_list_generation_runs",
    },
  ],
} satisfies OnlineMigrationEntry;
