import type { OnlineMigrationEntry } from "../online-migration-entry";

export default {
  id: "indexes-session-originconsentid-idx",
  revision: 200,
  type: "indexes",
  values: [
    {
      introducedBy: "20261022233100_mcp_web_handoff_session_index",
      createSql:
        'CREATE INDEX CONCURRENTLY "session_originConsentId_idx" ON public."session" USING btree ("origin_consent_id")',
      definitionBody: "ON public.session USING btree (origin_consent_id)",
      isUnique: false,
      name: "session_originConsentId_idx",
      tableName: "session",
    },
  ],
} satisfies OnlineMigrationEntry;
