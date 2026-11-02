import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-provision-citations-decision-work-subtree-idx",
  revision: 455,
  type: "indexes",
  values: [
    {
      introducedBy: "20261101185403_case_law_provision_membership_index",
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_provision_citations_decision_work_subtree_idx" ON public."case_law_provision_citations" USING btree ("decision_id", "jurisdiction", "work_identifier", "anchor" COLLATE "C", "span_start")',
      definitionBody:
        'ON public.case_law_provision_citations USING btree (decision_id, jurisdiction, work_identifier, anchor COLLATE "C", span_start)',
      isUnique: false,
      name: "case_law_provision_citations_decision_work_subtree_idx",
      tableName: "case_law_provision_citations",
    },
  ],
} satisfies OnlineMigrationEntry;
