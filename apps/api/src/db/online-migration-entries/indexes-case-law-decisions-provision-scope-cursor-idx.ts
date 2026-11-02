import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-case-law-decisions-provision-scope-cursor-idx",
  revision: 450,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "case_law_decisions_provision_scope_cursor_idx" ON public."case_law_decisions" USING btree ("country", "language", "id")',
      definitionBody:
        "ON public.case_law_decisions USING btree (country, language, id)",
      introducedBy: "20260926170000_case_law_provision_backfill",
      isUnique: false,
      name: "case_law_decisions_provision_scope_cursor_idx",
      tableName: "case_law_decisions",
    },
  ],
} satisfies OnlineMigrationEntry;
