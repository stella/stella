import { sql } from "drizzle-orm";

import { DATA_EXPORT_MAX_FAILURES } from "@/api/db/schema";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

export type DataExportScenario = {
  type: "data-exports";
  rows: number;
  cohort: "quiet" | "transitions" | "queued";
};

const USER_ID = "01990000-00c0-7000-8000-000000000001";

/** One active export per organization, with dense cutoff ties and real state indexes. */
export const seedDataExportScenario = async (
  database: GatedTestDb,
  { rows, cohort }: DataExportScenario,
) => {
  await database.execute(sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
    VALUES (${USER_ID}, 'Export measurement', 'export-measurement@example.test', true, now(), now())
    ON CONFLICT (id) DO NOTHING`);
  await database.execute(sql`INSERT INTO organization (id, name, slug, created_at)
    SELECT md5('export-org-' || i)::uuid, 'Export measurement', 'export-measurement-' || i, now()
    FROM generate_series(1, ${rows}::integer) AS i ON CONFLICT (id) DO NOTHING`);
  await database.execute(sql`TRUNCATE organization_data_exports, audit_logs`);
  await database.execute(sql`INSERT INTO organization_data_exports
    (id, organization_id, requested_by, version_scope, status, attempt, failures,
      created_at, heartbeat_at, expires_at)
    SELECT md5('export-' || i)::uuid, md5('export-org-' || i)::uuid,
      CASE WHEN ${cohort} = 'transitions' AND i % 3 = 2 THEN NULL ELSE ${USER_ID} END,
      'all',
      CASE WHEN ${cohort} = 'queued' THEN 'queued'
        WHEN i % 3 = 0 THEN 'ready' WHEN i % 3 = 1 THEN 'running' ELSE 'queued' END,
      1, CASE WHEN i % 2 = 0 THEN ${DATA_EXPORT_MAX_FAILURES - 1} ELSE 0 END,
      CASE WHEN ${cohort} = 'quiet' THEN '2026-01-10T12:00:00Z'::timestamptz ELSE '2026-01-01T12:00:00Z'::timestamptz END,
      CASE WHEN ${cohort} = 'quiet' THEN '2026-01-10T12:00:00Z'::timestamptz ELSE '2026-01-01T12:00:00Z'::timestamptz END,
      CASE WHEN ${cohort} = 'quiet' THEN '2026-02-01T12:00:00Z'::timestamptz ELSE '2026-01-01T12:00:00Z'::timestamptz END
    FROM generate_series(1, ${rows}::integer) AS i`);
  await database.execute(sql`VACUUM (ANALYZE) organization_data_exports`);
};
