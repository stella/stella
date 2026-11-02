import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-provision-citations-work-citing-idx",
  revision: 170,
  type: "indexes",
  // A provision's subtree of citing rows as one byte-ordered anchor range.
  // The trailing date, decision and span let the cited-by page group a
  // subtree per decision, with its earliest mention's offset, from the index
  // alone.
  values: [
    {
      introducedBy: { type: "code", owner: "src/db/online-migrations.ts" },
      createSql: `CREATE INDEX CONCURRENTLY "case_law_provision_citations_work_citing_idx" ON public."case_law_provision_citations" USING btree ("jurisdiction", "work_identifier", "anchor" COLLATE "C", "decision_date", "decision_id", "span_start")`,
      definitionBody:
        'ON public.case_law_provision_citations USING btree (jurisdiction, work_identifier, anchor COLLATE "C", decision_date, decision_id, span_start)',
      isUnique: false,
      name: "case_law_provision_citations_work_citing_idx",
      tableName: "case_law_provision_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
