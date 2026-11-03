import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-provision-citations-eli-citing-idx",
  revision: 180,
  type: "indexes",
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql: `CREATE INDEX CONCURRENTLY "case_law_provision_citations_eli_citing_idx" ON public."case_law_provision_citations" USING btree ("jurisdiction", "work_eli", "anchor" COLLATE "C", "decision_date", "decision_id", "span_start") WHERE "work_eli" IS NOT NULL`,
      definitionBody:
        'ON public.case_law_provision_citations USING btree (jurisdiction, work_eli, anchor COLLATE "C", decision_date, decision_id, span_start) WHERE (work_eli IS NOT NULL)',
      isUnique: false,
      name: "case_law_provision_citations_eli_citing_idx",
      tableName: "case_law_provision_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
