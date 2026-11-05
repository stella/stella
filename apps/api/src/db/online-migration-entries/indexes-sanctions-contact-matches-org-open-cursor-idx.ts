import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-sanctions-contact-matches-org-open-cursor-idx",
  revision: 220,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "sanctions_contact_matches_org_open_cursor_idx" ON public."sanctions_contact_matches" USING btree ("organization_id", "state", "disposition", "contact_id", "source_id", "source_entry_id")',
      definitionBody:
        "ON public.sanctions_contact_matches USING btree (organization_id, state, disposition, contact_id, source_id, source_entry_id)",
      introducedBy: "20261003123000_sanctions_monitoring_review_index",
      isUnique: false,
      name: "sanctions_contact_matches_org_open_cursor_idx",
      tableName: "sanctions_contact_matches",
    },
  ],
} satisfies OnlineMigrationEntry;
