import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-sanctions-contact-marks-organization-retry-idx",
  revision: 740,
  type: "indexes",
  values: [
    {
      createSql:
        'CREATE INDEX CONCURRENTLY "sanctions_contact_marks_organization_retry_idx" ON public."sanctions_contact_marks" USING btree ("organization_id", "next_attempt_at", "scheduled_at", "contact_id")',
      definitionBody:
        "ON public.sanctions_contact_marks USING btree (organization_id, next_attempt_at, scheduled_at, contact_id)",
      introducedBy: "20261005120200_list_verification_force_rls",
      isUnique: false,
      name: "sanctions_contact_marks_organization_retry_idx",
      tableName: "sanctions_contact_marks",
    },
  ],
} satisfies OnlineMigrationEntry;
