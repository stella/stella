import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-sanctions-contact-marks-retry-idx",
  revision: 730,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "sanctions_contact_marks_retry_idx" ON public."sanctions_contact_marks" USING btree ("next_attempt_at", "scheduled_at", "organization_id", "contact_id")',
      definitionBody:
        "ON public.sanctions_contact_marks USING btree (next_attempt_at, scheduled_at, organization_id, contact_id)",
      introducedBy: "20261005120200_list_verification_force_rls",
      isUnique: false,
      name: "sanctions_contact_marks_retry_idx",
      tableName: "sanctions_contact_marks",
    },
  ],
} satisfies OnlineMigrationEntry;
